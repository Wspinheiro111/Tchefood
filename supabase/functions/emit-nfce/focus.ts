/**
 * Cliente Focus NFe para NFC-e, portado do Tchê Vendas (server/focusNfce.ts).
 *
 * Princípio: só "autorizado" (e, em contingência offline, só depois de efetivada na SEFAZ)
 * é nota autorizada. Falha de rede, timeout, 408/409/429 ou erro desconhecido NÃO é
 * contingência nem sucesso: é resultado indeterminado, e o próximo passo é consultar a
 * mesma referência por GET, nunca reenviar às cegas.
 */

export type FocusEnvironment = 'homologacao' | 'producao';

const BASE_URL: Record<FocusEnvironment, string> = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
};

/** Só "producao" escrito exatamente assim liga a produção; qualquer outro valor é homologação. */
export function focusEnvironment(value: string | undefined | null): FocusEnvironment {
  return value === 'producao' ? 'producao' : 'homologacao';
}

export interface FocusNfceResponse {
  status: string | null;
  statusSefaz: string | null;
  message: string | null;
  protocol: string | null;
  accessKey: string | null;
  number: number | null;
  series: string | null;
  xmlPath: string | null;
  danfePath: string | null;
  qrCodeUrl: string | null;
  /** Focus emitiu em contingência offline (tpEmis 9) porque a SEFAZ não respondeu. */
  offlineContingency: boolean | null;
  /** A nota em contingência já foi transmitida e aceita pela SEFAZ. */
  offlineContingencyEffective: boolean | null;
}

export interface FocusResult {
  httpStatus: number; // 0 = sem resposta (rede/timeout)
  ok: boolean;
  errorCode: string | null;
  response: FocusNfceResponse;
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

function str(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

export function sanitizeFocusResponse(value: unknown): FocusNfceResponse {
  const r = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const number = Number(r.numero);
  return {
    status: str(r.status, 40),
    statusSefaz: str(r.status_sefaz, 12),
    message: str(r.mensagem_sefaz ?? r.mensagem ?? r.message, 1000),
    protocol: str(r.protocolo, 80),
    accessKey: str(r.chave_nfe ?? r.chave_nfce, 60),
    number: Number.isInteger(number) && number > 0 ? number : null,
    series: str(r.serie, 3),
    xmlPath: str(r.caminho_xml_nota_fiscal, 512),
    danfePath: str(r.caminho_danfe, 512),
    // QR Code de consulta assinado; url_danfe NÃO é o QR Code.
    qrCodeUrl: str(r.qrcode_url ?? r.url_qrcode, 2048),
    offlineContingency: typeof r.contingencia_offline === 'boolean' ? r.contingencia_offline : null,
    offlineContingencyEffective: typeof r.contingencia_offline_efetivada === 'boolean' ? r.contingencia_offline_efetivada : null,
  };
}

const EMPTY: FocusNfceResponse = sanitizeFocusResponse({});

function indeterminate(message: string): FocusResult {
  return { httpStatus: 0, ok: false, errorCode: null, response: { ...EMPTY, status: 'processing', message } };
}

async function parse(response: { status: number; ok: boolean; text(): Promise<string> }): Promise<FocusResult> {
  const text = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = { mensagem: text.slice(0, 500) };
  }
  const code = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).codigo : null;
  return {
    httpStatus: response.status,
    ok: response.ok,
    errorCode: typeof code === 'string' && /^[a-z_]{1,60}$/.test(code) ? code : null,
    response: sanitizeFocusResponse(raw),
  };
}

function authorization(token: string): string {
  if (!token.trim()) throw new Error('Token Focus NFe não configurado para o emitente.');
  return `Basic ${btoa(`${token}:`)}`;
}

function validReference(reference: string): void {
  if (!/^[A-Za-z0-9]{1,120}$/.test(reference)) throw new Error('Referência Focus NFC-e inválida.');
}

export interface FocusClientOptions {
  environment: FocusEnvironment;
  token: string;
  fetch: FetchLike;
  timeoutMs?: number;
}

export function createFocusClient(options: FocusClientOptions) {
  const base = `${BASE_URL[options.environment]}/v2/nfce`;
  const timeout = options.timeoutMs ?? 30_000;
  const auth = authorization(options.token);
  return {
    environment: options.environment,
    /** POST da nota. Falha de comunicação vira "processing" indeterminado, nunca sucesso. */
    async transmit(reference: string, payload: unknown): Promise<FocusResult> {
      validReference(reference);
      try {
        const response = await options.fetch(`${base}?ref=${encodeURIComponent(reference)}&completa=1`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeout),
        });
        return await parse(response);
      } catch {
        return indeterminate('Resultado indeterminado após falha de comunicação com a Focus. Consulte a mesma referência antes de qualquer nova tentativa.');
      }
    },
    /** GET da mesma referência; nada é transmitido. */
    async query(reference: string): Promise<FocusResult> {
      validReference(reference);
      try {
        const response = await options.fetch(`${base}/${encodeURIComponent(reference)}?completa=1`, {
          method: 'GET',
          headers: { Authorization: auth, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeout),
        });
        return await parse(response);
      } catch {
        return indeterminate('Consulta à Focus sem resposta. A NFC-e continua em processamento.');
      }
    },
  };
}

export type FocusClient = ReturnType<typeof createFocusClient>;

export type NfceDocumentStatus = 'processing' | 'authorized' | 'rejected' | 'contingency' | 'cancelled';

/**
 * Status da Focus → status do documento. Em contingência offline a Focus devolve
 * "autorizado" antes de a SEFAZ aceitar: só vira autorizada quando efetivada, e uma nota
 * já em contingência só sai dela com contingencia_offline_efetivada=true explícito.
 */
export function normalizeProviderStatus(
  status: string | null,
  current: NfceDocumentStatus,
  flags: Pick<FocusNfceResponse, 'offlineContingency' | 'offlineContingencyEffective'>,
): NfceDocumentStatus {
  const s = (status ?? '').trim().toLowerCase();
  if (s === 'autorizado') {
    if (current === 'contingency') return flags.offlineContingencyEffective === true ? 'authorized' : 'contingency';
    return flags.offlineContingency === true && flags.offlineContingencyEffective !== true ? 'contingency' : 'authorized';
  }
  if (s === 'cancelado') return 'cancelled';
  if (s === 'processando_autorizacao' || s === 'processing') return 'processing';
  if (s === 'erro_autorizacao' || s === 'denegado') return 'rejected';
  return current;
}

const ALLOWED: Record<NfceDocumentStatus, NfceDocumentStatus[]> = {
  processing: ['authorized', 'rejected', 'contingency'],
  rejected: ['processing', 'authorized', 'contingency'],
  contingency: ['processing', 'authorized', 'rejected'],
  authorized: ['cancelled'],
  cancelled: [],
};

export function canTransition(current: NfceDocumentStatus, next: NfceDocumentStatus): boolean {
  return current === next || ALLOWED[current].includes(next);
}

// Códigos que garantem que a Focus não registrou a referência: a nota pode ser corrigida e reenviada.
const DEFINITIVE_REFUSAL_CODES = new Set([
  'requisicao_invalida',
  'forma_emissao_nao_informada',
  'permissao_negada',
  'formato_invalido',
  'erro_validacao_schema',
  'erro_validacao',
  'ambiente_nao_configurado',
  'empresa_nao_configurada',
]);
/** A Focus já conhece a referência: consultar por GET, nunca reenviar. */
export const REFERENCE_KNOWN_CODES = new Set(['pending_operation', 'already_processed']);
const INCONCLUSIVE_HTTP = new Set([408, 409, 429]);

/**
 * Resposta sem status da nota (erro de API): só é rejeição definitiva com 401 ou 4xx com
 * código conhecido de recusa. O resto fica em processamento para conferência.
 */
export function classifyTransmission(result: FocusResult): FocusNfceResponse {
  if (result.ok || result.response.status) return result.response;
  if (result.httpStatus === 0 || INCONCLUSIVE_HTTP.has(result.httpStatus)) return { ...result.response, status: 'processing' };
  const definitive =
    result.httpStatus === 401 ||
    (result.httpStatus >= 400 && result.httpStatus < 500 && result.errorCode !== null && DEFINITIVE_REFUSAL_CODES.has(result.errorCode));
  if (!definitive) {
    return {
      ...result.response,
      status: 'processing',
      message: `Resposta inconclusiva da Focus (HTTP ${result.httpStatus}${result.errorCode ? `, ${result.errorCode}` : ''}). Consulte a referência antes de reenviar.`,
    };
  }
  return {
    ...result.response,
    status: 'erro_autorizacao',
    message: `Focus recusou o envio (HTTP ${result.httpStatus}${result.errorCode ? `, ${result.errorCode}` : ''}): ${result.response.message ?? 'sem mensagem.'}`.slice(0, 1000),
  };
}

/**
 * Só aceita como QR Code impresso uma URL de SEFAZ (.gov.br) cujo parâmetro p começa pela
 * chave desta nota (mesma regra de src/lib/nfce.ts isValidNfceQrCodeContent).
 */
export function isValidQrCodeUrl(content: string | null, accessKey: string | null): boolean {
  if (!content || content.length > 1000 || /[\s<>"']/.test(content)) return false;
  const key = (accessKey ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^NFE/, '');
  if (!/^\d{6}[0-9A-Z]{12}\d{26}$/.test(key)) return false;
  let url: URL;
  try {
    url = new URL(content);
  } catch {
    return false;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return false;
  if (!/(^|\.)gov\.br$/i.test(url.hostname)) return false;
  const p = url.searchParams.get('p');
  return Boolean(p) && p!.split('|')[0] === key;
}
