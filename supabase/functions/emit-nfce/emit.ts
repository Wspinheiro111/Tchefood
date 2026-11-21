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
  type IssuerAddress,
  parseAuthorizedXml,
  isValidAccessKey,
} from './focus.ts';
import { NfceValidationError, buildNfcePayload, canonicalJson, fiscalIssuedAt, issuerSnapshot, nfceReference, type NfceSource } from './payload.ts';

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
  /** data_emissao do payload transmitido (lido de payload->>data_emissao); a tela imprime no DANFE. */
  issued_at: string | null;
  /** Payload congelado que foi transmitido (itens, valores, pagamentos). */
  payload: unknown;
  /** Emitente gravado junto do payload na transmissão (cadastro da loja no servidor); imutável depois de autorizada. */
  issuer?: unknown;
  /** dhRecbto: data/hora da autorização na SEFAZ (ISO), lida do protocolo/XML da Focus. */
  authorized_at?: string | null;
  /** enderEmit do XML autorizado; o DANFE próprio só imprime com ele. */
  issuer_address?: IssuerAddress | null;
}

export type NewNfceDocument = Pick<NfceDocumentRow, 'tenant_id' | 'order_id' | 'reference' | 'environment' | 'payload_hash'> & {
  payload: unknown;
  issuer: unknown;
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
> & { authorized_at?: string | null; issuer_address?: IssuerAddress | null };

export interface NfceRepository {
  /** Comanda + itens + produtos + pagamentos + emitente, sempre filtrados pelo tenant. */
  loadSource(tenantId: string, orderId: string): Promise<NfceSource | null>;
  getDocument(tenantId: string, orderId: string): Promise<NfceDocumentRow | null>;
  /** INSERT em status processing; null se já existe documento da comanda (UNIQUE order_id). */
  insertProcessing(doc: NewNfceDocument): Promise<NfceDocumentRow | null>;
  /**
   * UPDATE ... SET status='processing', transmissions=expected+1 WHERE id=? AND status='rejected'
   * AND transmissions=expected; null se outra requisição venceu. Cada tentativa tem número único.
   */
  claimRejected(id: string, expectedTransmissions: number, payloadHash: string, payload: unknown, issuer: unknown): Promise<NfceDocumentRow | null>;
  /**
   * UPDATE condicionado ao status E à tentativa (transmissions) lidos; null se mudou no meio.
   * Sem a tentativa, um GET atrasado da tentativa anterior gravaria "rejected" sobre um reenvio em curso.
   */
  saveProviderResult(id: string, expectedStatus: NfceDocumentStatus, expectedTransmissions: number, fields: ProviderFields): Promise<NfceDocumentRow | null>;
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
    status: NfceDocumentStatus | 'invalid' | 'not_found' | 'conflict' | 'none';
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
    /** data_emissao enviada à SEFAZ (null antes da primeira transmissão). */
    issued_at: string | null;
    /**
     * Payload transmitido, só para nota com chave da SEFAZ (autorizada, contingência,
     * cancelada): a tela imprime o DANFE com ele, nunca com o cadastro atual do aparelho.
     */
    payload: unknown;
    /** Emitente gravado com o payload (mesma regra do payload); a tela não usa o cadastro do aparelho. */
    issuer: unknown;
    /** Endereço do emitente do XML autorizado (só autorizada/cancelada); null = não imprime pela bobina. */
    issuer_address: IssuerAddress | null;
    /** dhRecbto da SEFAZ (ISO); nunca derivado de data_emissao. */
    authorized_at: string | null;
    message: string | null;
  };
}

// orders.nfce_status / nfce_key são espelhados pelo trigger tchefood_nfce_mirror_order na mesma
// transação da gravação de nfce_documents: nunca ficam diferentes do documento.

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
      qrcode_url: isValidQrCodeUrl(doc.qrcode_url, doc.access_key, doc.environment) ? doc.qrcode_url : null,
      danfe_path: doc.danfe_path,
      issued_at: doc.issued_at,
      payload: doc.status === 'authorized' || doc.status === 'contingency' || doc.status === 'cancelled' ? doc.payload ?? null : null,
      issuer: doc.status === 'authorized' || doc.status === 'contingency' || doc.status === 'cancelled' ? doc.issuer ?? null : null,
      issuer_address: doc.status === 'authorized' || doc.status === 'contingency' || doc.status === 'cancelled' ? doc.issuer_address ?? null : null,
      authorized_at: doc.status === 'authorized' || doc.status === 'cancelled' ? doc.authorized_at ?? null : null,
      message: message ?? doc.sefaz_message,
    },
  };
}

function failure(httpStatus: number, status: 'invalid' | 'not_found' | 'conflict' | 'none', environment: FocusEnvironment, message: string, reference: string | null = null): EmitResponse {
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
      issued_at: null,
      payload: null,
      issuer: null,
      issuer_address: null,
      authorized_at: null,
      message,
    },
  };
}

function providerFields(doc: NfceDocumentRow, next: NfceDocumentStatus, response: FocusNfceResponse): ProviderFields {
  // Chave com DV errado não é gravada nem trocada pela chave de outra tentativa: a resposta que traz uma chave
  // explicitamente inválida nunca confirma autorização (ver apply). Sem chave na resposta vale a do documento.
  const rawKey = response.accessKey?.replace(/^NFe/i, '') ?? null;
  const invalidKey = rawKey !== null && !isValidAccessKey(rawKey);
  const accessKey = rawKey === null ? doc.access_key : invalidKey ? doc.access_key : rawKey;
  // QR Code só se for a URL assinada da SEFAZ para ESTA chave; url_danfe nunca é QR Code.
  const qr = response.qrCodeUrl && isValidQrCodeUrl(response.qrCodeUrl, accessKey, doc.environment)
    ? response.qrCodeUrl
    : isValidQrCodeUrl(doc.qrcode_url, accessKey, doc.environment) // QR gravado por versão anterior é revalidado pela regra atual
      ? doc.qrcode_url
      : null;
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

async function apply(deps: EmitDeps, doc: NfceDocumentRow, response: FocusNfceResponse, token?: string): Promise<EmitResponse> {
  const next = normalizeProviderStatus(response.status, doc.status, response);
  if (!canTransition(doc.status, next)) {
    // Retorno obsoleto não regride status mais confiável (ex.: authorized → rejected).
    return respond(doc, `Retorno da Focus ignorado: transição ${doc.status} → ${next} não permitida.`);
  }
  let fields = providerFields(doc, next, response);
  const rawKeyInResponse = response.accessKey?.replace(/^NFe/i, '') ?? null;
  if (next === 'cancelled' && rawKeyInResponse !== null && !isValidAccessKey(rawKeyInResponse)) {
    // Cancelamento sem chave válida não prova a identidade da nota (a chave gravada não pode ser reaproveitada como prova).
    return respond(doc, 'Consulta inconclusiva: a Focus devolveu cancelamento com chave de acesso inválida (DV); o estado gravado foi mantido.');
  }
  if ((next === 'authorized' || next === 'contingency') && rawKeyInResponse !== null && !isValidAccessKey(rawKeyInResponse)) {
    // Nota já autorizada/cancelada não volta a processing (o trigger do banco proíbe): descarta o retorno inválido sem gravar.
    if (!canTransition(doc.status, 'processing')) {
      return respond(doc, 'Consulta inconclusiva: a Focus devolveu chave de acesso inválida (DV); o registro gravado foi mantido.');
    }
    // Chave inválida na resposta: não autoriza com a chave de uma tentativa anterior; fica para reconciliar.
    fields = { ...fields, status: 'processing', sefaz_message: 'Focus respondeu autorizado com chave de acesso inválida (DV). Consulte novamente; a nota não foi confirmada.' };
  } else if (next === 'authorized' && (!fields.protocol || !fields.access_key)) {
    // "autorizado" sem protocolo/chave não é prova de autorização: fica em processamento.
    fields = { ...fields, status: 'processing', sefaz_message: 'Focus respondeu autorizado sem protocolo ou com chave ausente/inválida. Consulte novamente.' };
  }
  const printable = fields.status === 'authorized' || fields.status === 'contingency';
  const needsAuthorizedAt = fields.status === 'authorized' && !doc.authorized_at;
  if (printable && token && (needsAuthorizedAt || !doc.issuer_address)) {
    // Endereço e dhRecbto só do XML autorizado (conferido com a chave e o CNPJ); nunca do aparelho.
    const xml = await deps.focus(token).fetchXml?.(fields.xml_path ?? null);
    const parsed = parseAuthorizedXml(xml ?? null, fields.access_key, fields.protocol);
    fields = {
      ...fields,
      // Contingência ainda não tem autorização: só o endereço (a data nasce com a autorização).
      authorized_at: fields.status === 'authorized' ? doc.authorized_at ?? parsed.authorizedAt ?? response.authorizedAt : doc.authorized_at ?? null,
      issuer_address: doc.issuer_address ?? parsed.address,
    };
  } else if (printable) {
    fields = { ...fields, authorized_at: fields.status === 'authorized' ? doc.authorized_at ?? response.authorizedAt : doc.authorized_at ?? null, issuer_address: doc.issuer_address ?? null };
  }
  const saved = await deps.repo.saveProviderResult(doc.id, doc.status, doc.transmissions, fields);
  if (!saved) {
    const current = await deps.repo.getDocument(doc.tenant_id, doc.order_id);
    return current ? respond(current, 'O estado da NFC-e mudou durante a operação; este é o estado atual.') : failure(409, 'conflict', deps.environment, 'Documento NFC-e não encontrado após a operação.');
  }
  return respond(saved);
}

/** Só GET: usado para documento em processamento ou contingência. */
async function reconcile(deps: EmitDeps, doc: NfceDocumentRow, token: string): Promise<EmitResponse> {
  const result = await deps.focus(token).query(doc.reference);
  if (!result.ok) {
    if (doc.status === 'authorized') return respond(doc, `A NFC-e segue autorizada; a consulta do QR Code na Focus não respondeu (HTTP ${result.httpStatus || 'sem resposta'}).`);
    const note = result.httpStatus === 404
      ? 'A Focus ainda não reconhece esta referência. A NFC-e continua em processamento; não reemita sem conferir no painel da Focus.'
      : `Consulta inconclusiva (HTTP ${result.httpStatus || 'sem resposta'}). A NFC-e continua em ${doc.status === 'contingency' ? 'contingência' : 'processamento'}.`;
    return respond(doc, note);
  }
  return apply(deps, doc, result.response, token);
}

async function transmit(deps: EmitDeps, doc: NfceDocumentRow, token: string, payload: unknown): Promise<EmitResponse> {
  const client = deps.focus(token);
  const result = await client.transmit(doc.reference, payload);
  if (!result.ok && result.errorCode && REFERENCE_KNOWN_CODES.has(result.errorCode)) {
    // A Focus já conhece a referência: consulta, nunca reenvia.
    const known = await client.query(doc.reference);
    const status = known.ok ? normalizeProviderStatus(known.response.status, 'processing', known.response) : null;
    if (known.ok && status && ['authorized', 'processing', 'contingency'].includes(status)) return apply(deps, doc, known.response, token);
    return apply(deps, doc, {
      ...result.response,
      status: 'processing',
      message: `A Focus já conhecia a referência e a consulta retornou "${known.response.status ?? 'sem status'}". Mantida em processamento para conferência; não reenvie.`,
    }, token);
  }
  return apply(deps, doc, classifyTransmission(result), token);
}

// Sem token não há como consultar a Focus: em consulta devolve o documento gravado como está;
// fora dela, o token continua obrigatório.
function consultOnlyWithoutToken(input: { consultOnly?: boolean }, doc: NfceDocumentRow, noToken: () => EmitResponse): EmitResponse {
  return input.consultOnly ? respond(doc) : noToken();
}

/**
 * consultOnly (mode "consult"): só devolve ou consulta na Focus o documento que já existe
 * (inclusive autorizada sem QR Code). Sem documento responde status "none" e não transmite
 * nada; rejeitada é devolvida como está, sem reenvio.
 */
export async function emitNfce(deps: EmitDeps, input: { tenantId: string; orderId: string; consultOnly?: boolean }): Promise<EmitResponse> {
  const env = deps.environment;
  const source = await deps.repo.loadSource(input.tenantId, input.orderId);
  if (!source) return failure(404, 'not_found', env, 'Comanda não encontrada para este estabelecimento.');
  const token = source.tenant.focus_nfe_token?.trim() ?? '';
  const noToken = () => failure(422, 'invalid', env, 'Token Focus NFe do estabelecimento não configurado.');

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
  // O documento gravado é devolvido sem token: o token só é exigido para falar com a Focus
  // (consultar ou transmitir).
  if (doc && doc.status === 'authorized' && isValidQrCodeUrl(doc.qrcode_url, doc.access_key, doc.environment) && doc.authorized_at && doc.issuer_address) return respond(doc);
  if (doc && doc.status === 'cancelled') return respond(doc);
  // Autorizada sem o QR Code assinado: consulta a Focus (só GET) para completar o DANFE.
  if (doc && doc.status === 'authorized') return token ? reconcile(deps, doc, token) : consultOnlyWithoutToken(input, doc, noToken);
  if (doc && (doc.status === 'processing' || doc.status === 'contingency')) return token ? reconcile(deps, doc, token) : consultOnlyWithoutToken(input, doc, noToken);
  if (input.consultOnly) {
    if (doc) return respond(doc);
    return failure(404, 'none', env, 'Esta comanda não tem NFC-e no servidor. Nada foi transmitido.', reference);
  }
  if (!token) return noToken();

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
    const claimed = await deps.repo.claimRejected(doc.id, doc.transmissions, payloadHash, payload, issuerSnapshot(source.tenant));
    if (!claimed) {
      const current = await deps.repo.getDocument(input.tenantId, input.orderId);
      return current ? respond(current, 'Outra solicitação já está emitindo esta NFC-e.') : failure(409, 'conflict', env, 'Documento NFC-e em disputa.');
    }
    doc = claimed;
  } else {
    const inserted = await deps.repo.insertProcessing({ tenant_id: input.tenantId, order_id: input.orderId, reference, environment: env, payload_hash: payloadHash, payload, issuer: issuerSnapshot(source.tenant) });
    if (!inserted) {
      const current = await deps.repo.getDocument(input.tenantId, input.orderId);
      return current ? respond(current, 'Outra solicitação já está emitindo esta NFC-e.') : failure(409, 'conflict', env, 'Documento NFC-e em disputa.');
    }
    doc = inserted;
  }
  return transmit(deps, doc, token, payload);
}
