/**
 * Orquestração da emissão: idempotente por comanda, sem POST duplicado e sem sucesso falso.
 *
 * Fluxo (mesma máquina de estados do Tchê Vendas, server/nfceService.ts):
 *   1. A comanda é carregada do banco pelo servidor; o corpo da requisição só traz o order_id.
 *      Valores, pagamentos e token nunca vêm do cliente.
 *   2. Documento já autorizado/cancelado → devolve o que está gravado (nenhuma chamada à Focus).
 *   3. Documento em processamento/contingência → só consulta (GET) a mesma referência.
 *   4. Sem documento (ou rejeitado) → valida e monta o payload, reserva o documento em
 *      "processing" ANTES do POST (a reserva é atômica: duas abas não emitem duas vezes) e transmite.
 *   5. Falha de rede/timeout → continua "processing" e a resposta diz para consultar; nunca
 *      "contingência" ou "sucesso" inventados.
 */
import {
  REFERENCE_KNOWN_CODES,
  canTransition,
  classifyTransmission,
  isValidQrCodeUrl,
  normalizeProviderStatus,
  type FocusClient,
  type FocusEnvironment,
  type FocusNfceResponse,
  type NfceDocumentStatus,
} from './focus.ts';
import { NfceValidationError, buildNfcePayload, canonicalJson, fiscalIssuedAt, nfceReference, type NfceSource } from './payload.ts';

export interface NfceDocumentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  reference: string;
  environment: FocusEnvironment;
  status: NfceDocumentStatus;
  payload_hash: string | null;
  access_key: string | null;
  protocol: string | null;
  number: number | null;
  series: string | null;
  qrcode_url: string | null;
  danfe_path: string | null;
  xml_path: string | null;
  sefaz_status: string | null;
  sefaz_message: string | null;
  offline_contingency: boolean;
  transmissions: number;
}

export type NewNfceDocument = Pick<NfceDocumentRow, 'tenant_id' | 'order_id' | 'reference' | 'environment' | 'payload_hash'> & {
  payload: unknown;
};

export type ProviderFields = Pick<
  NfceDocumentRow,
  | 'status'
  | 'access_key'
  | 'protocol'
  | 'number'
  | 'series'
  | 'qrcode_url'
  | 'danfe_path'
  | 'xml_path'
  | 'sefaz_status'
  | 'sefaz_message'
  | 'offline_contingency'
>;

export interface NfceRepository {
  /** Comanda + itens + produtos + pagamentos + emitente, sempre filtrados pelo tenant. */
  loadSource(tenantId: string, orderId: string): Promise<NfceSource | null>;
  getDocument(tenantId: string, orderId: string): Promise<NfceDocumentRow | null>;
  /** INSERT em status processing; null se já existe documento da comanda (UNIQUE order_id). */
  insertProcessing(doc: NewNfceDocument): Promise<NfceDocumentRow | null>;
  /** UPDATE ... SET status='processing' WHERE id=? AND status='rejected'; null se outra requisição venceu. */
  claimRejected(id: string, payloadHash: string, payload: unknown): Promise<NfceDocumentRow | null>;
  /**
   * UPDATE condicionado ao status E à tentativa (transmissions) lidos; null se mudou no meio.
   * Sem a tentativa, um GET atrasado da tentativa anterior gravaria "rejected" sobre um reenvio em curso.
   */
  saveProviderResult(id: string, expectedStatus: NfceDocumentStatus, expectedTransmissions: number, fields: ProviderFields): Promise<NfceDocumentRow | null>;
  /** Espelha o estado na comanda (orders.nfce_status / nfce_key) para as telas atuais. */
  setOrderNfce(tenantId: string, orderId: string, status: string, accessKey: string | null): Promise<void>;
}

export interface EmitDeps {
  repo: NfceRepository;
  environment: FocusEnvironment;
  /** Cria o cliente com o token do emitente. */
  focus(token: string): FocusClient;
  sha256Hex(text: string): Promise<string>;
  now?: () => Date;
}

export interface EmitResponse {
  httpStatus: number;
  body: {
    status: NfceDocumentStatus | 'invalid' | 'not_found' | 'conflict';
    /** true somente com protocolo de autorização da SEFAZ. */
    authorized: boolean;
    /** Emitida em contingência offline e ainda não efetivada na SEFAZ. */
    contingency: boolean;
    reference: string | null;
    environment: FocusEnvironment;
    access_key: string | null;
    protocol: string | null;
    number: number | null;
    series: string | null;
    qrcode_url: string | null;
    danfe_path: string | null;
    message: string | null;
  };
}

const ORDER_STATUS: Record<NfceDocumentStatus, string> = {
  processing: 'PROCESSANDO',
  authorized: 'AUTORIZADA',
  rejected: 'REJEITADA',
  contingency: 'CONTINGENCIA',
  cancelled: 'CANCELADA',
};

const HTTP_BY_STATUS: Record<NfceDocumentStatus, number> = {
  authorized: 200,
  cancelled: 200,
  contingency: 200,
  processing: 202,
  rejected: 422,
};

function respond(doc: NfceDocumentRow, message?: string | null): EmitResponse {
  return {
    httpStatus: HTTP_BY_STATUS[doc.status],
    body: {
      status: doc.status,
      authorized: doc.status === 'authorized',
      contingency: doc.status === 'contingency',
      reference: doc.reference,
      environment: doc.environment,
      access_key: doc.access_key,
      protocol: doc.status === 'authorized' || doc.status === 'cancelled' ? doc.protocol : null,
      number: doc.number,
      series: doc.series,
      qrcode_url: doc.qrcode_url,
      danfe_path: doc.danfe_path,
      message: message ?? doc.sefaz_message,
    },
  };
}

function failure(httpStatus: number, status: 'invalid' | 'not_found' | 'conflict', environment: FocusEnvironment, message: string, reference: string | null = null): EmitResponse {
  return {
    httpStatus,
    body: {
      status,
      authorized: false,
      contingency: false,
      reference,
      environment,
      access_key: null,
      protocol: null,
      number: null,
      series: null,
      qrcode_url: null,
      danfe_path: null,
      message,
    },
  };
}

function providerFields(doc: NfceDocumentRow, next: NfceDocumentStatus, response: FocusNfceResponse): ProviderFields {
  const accessKey = response.accessKey?.replace(/^NFe/i, '') ?? doc.access_key;
  // QR Code só se for a URL assinada da SEFAZ para ESTA chave; url_danfe nunca é QR Code.
  const qr = response.qrCodeUrl && isValidQrCodeUrl(response.qrCodeUrl, accessKey) ? response.qrCodeUrl : doc.qrcode_url;
  return {
    status: next,
    access_key: accessKey,
    protocol: response.protocol ?? doc.protocol,
    number: response.number ?? doc.number,
    series: response.series ?? doc.series,
    qrcode_url: qr,
    danfe_path: response.danfePath ?? doc.danfe_path,
    xml_path: response.xmlPath ?? doc.xml_path,
    sefaz_status: response.statusSefaz ?? doc.sefaz_status,
    sefaz_message: response.message ?? doc.sefaz_message,
    offline_contingency: response.offlineContingency ?? doc.offline_contingency,
  };
}

/**
 * Espelho em orders.nfce_status é auxiliar: a fonte da verdade é nfce_documents. Uma falha
 * aqui não pode impedir o POST depois da reserva (o documento ficaria em processing com a
 * referência nunca enviada) nem transformar uma autorização gravada em erro 500.
 */
async function mirrorOnOrder(deps: EmitDeps, tenantId: string, orderId: string, status: string, accessKey: string | null): Promise<void> {
  try {
    await deps.repo.setOrderNfce(tenantId, orderId, status, accessKey);
  } catch (error) {
    console.error('[emit-nfce] falha ao espelhar status na comanda', error instanceof Error ? error.message : error);
  }
}

async function apply(deps: EmitDeps, doc: NfceDocumentRow, response: FocusNfceResponse): Promise<EmitResponse> {
  const next = normalizeProviderStatus(response.status, doc.status, response);
  if (!canTransition(doc.status, next)) {
    // Retorno obsoleto não regride status mais confiável (ex.: authorized → rejected).
    return respond(doc, `Retorno da Focus ignorado: transição ${doc.status} → ${next} não permitida.`);
  }
  let fields = providerFields(doc, next, response);
  if (next === 'authorized' && (!fields.protocol || !fields.access_key)) {
    // "autorizado" sem protocolo/chave não é prova de autorização: fica em processamento.
    fields = { ...fields, status: 'processing', sefaz_message: 'Focus respondeu autorizado sem protocolo ou chave. Consulte novamente.' };
  }
  const saved = await deps.repo.saveProviderResult(doc.id, doc.status, doc.transmissions, fields);
  if (!saved) {
    const current = await deps.repo.getDocument(doc.tenant_id, doc.order_id);
    return current ? respond(current, 'O estado da NFC-e mudou durante a operação; este é o estado atual.') : failure(409, 'conflict', deps.environment, 'Documento NFC-e não encontrado após a operação.');
  }
  await mirrorOnOrder(deps, saved.tenant_id, saved.order_id, ORDER_STATUS[saved.status], saved.status === 'authorized' || saved.status === 'contingency' ? saved.access_key : null);
  return respond(saved);
}

/** Só GET: usado para documento em processamento ou contingência. */
async function reconcile(deps: EmitDeps, doc: NfceDocumentRow, token: string): Promise<EmitResponse> {
  const result = await deps.focus(token).query(doc.reference);
  if (!result.ok) {
    const note = result.httpStatus === 404
      ? 'A Focus ainda não reconhece esta referência. A NFC-e continua em processamento; não reemita sem conferir no painel da Focus.'
      : `Consulta inconclusiva (HTTP ${result.httpStatus || 'sem resposta'}). A NFC-e continua em ${doc.status === 'contingency' ? 'contingência' : 'processamento'}.`;
    return respond(doc, note);
  }
  return apply(deps, doc, result.response);
}

async function transmit(deps: EmitDeps, doc: NfceDocumentRow, token: string, payload: unknown): Promise<EmitResponse> {
  const client = deps.focus(token);
  const result = await client.transmit(doc.reference, payload);
  if (!result.ok && result.errorCode && REFERENCE_KNOWN_CODES.has(result.errorCode)) {
    // A Focus já conhece a referência: consulta, nunca reenvia.
    const known = await client.query(doc.reference);
    const status = known.ok ? normalizeProviderStatus(known.response.status, 'processing', known.response) : null;
    if (known.ok && status && ['authorized', 'processing', 'contingency'].includes(status)) return apply(deps, doc, known.response);
    return apply(deps, doc, {
      ...result.response,
      status: 'processing',
      message: `A Focus já conhecia a referência e a consulta retornou "${known.response.status ?? 'sem status'}". Mantida em processamento para conferência; não reenvie.`,
    });
  }
  return apply(deps, doc, classifyTransmission(result));
}

export async function emitNfce(deps: EmitDeps, input: { tenantId: string; orderId: string }): Promise<EmitResponse> {
  const env = deps.environment;
  const source = await deps.repo.loadSource(input.tenantId, input.orderId);
  if (!source) return failure(404, 'not_found', env, 'Comanda não encontrada para este estabelecimento.');
  const token = source.tenant.focus_nfe_token?.trim() ?? '';
  if (!token) return failure(422, 'invalid', env, 'Token Focus NFe do estabelecimento não configurado.');

  let reference: string;
  try {
    reference = nfceReference(source.order.id);
  } catch (error) {
    return failure(422, 'invalid', env, (error as Error).message);
  }

  let doc = await deps.repo.getDocument(input.tenantId, input.orderId);
  if (doc && doc.environment !== env) {
    return failure(409, 'conflict', env, `Esta comanda já tem NFC-e em ${doc.environment}; o servidor está em ${env}. Nada foi transmitido.`, doc.reference);
  }
  if (doc && (doc.status === 'authorized' || doc.status === 'cancelled')) return respond(doc);
  if (doc && (doc.status === 'processing' || doc.status === 'contingency')) return reconcile(deps, doc, token);

  let payload;
  try {
    payload = buildNfcePayload(source, fiscalIssuedAt(deps.now?.() ?? new Date()));
  } catch (error) {
    if (error instanceof NfceValidationError) return failure(422, 'invalid', env, error.message, reference);
    throw error;
  }
  const payloadHash = await deps.sha256Hex(canonicalJson(payload));

  if (doc) {
    // Rejeitada: a Focus aceita reenviar a mesma referência com o payload corrigido.
    const claimed = await deps.repo.claimRejected(doc.id, payloadHash, payload);
    if (!claimed) {
      const current = await deps.repo.getDocument(input.tenantId, input.orderId);
      return current ? respond(current, 'Outra solicitação já está emitindo esta NFC-e.') : failure(409, 'conflict', env, 'Documento NFC-e em disputa.');
    }
    doc = claimed;
  } else {
    const inserted = await deps.repo.insertProcessing({ tenant_id: input.tenantId, order_id: input.orderId, reference, environment: env, payload_hash: payloadHash, payload });
    if (!inserted) {
      const current = await deps.repo.getDocument(input.tenantId, input.orderId);
      return current ? respond(current, 'Outra solicitação já está emitindo esta NFC-e.') : failure(409, 'conflict', env, 'Documento NFC-e em disputa.');
    }
    doc = inserted;
  }
  await mirrorOnOrder(deps, doc.tenant_id, doc.order_id, ORDER_STATUS.processing, null);
  return transmit(deps, doc, token, payload);
}
