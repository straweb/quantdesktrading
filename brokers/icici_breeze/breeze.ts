// @ts-nocheck
// ============================================================
// ICICI Direct Breeze REST client — byte-compatible with the
// official breeze_connect 1.0.69 checksum scheme (verified against
// the straweb/hedging broker/icici/api/breeze_client.py port).
//
// Why this exists: the adapter previously used plain headers
// (Authorization/X-SessionToken/api-key) + query-string params and
// read a `Result` envelope — Breeze answers `{Status, Success,
// Error}`, requires X-Checksum/X-Timestamp/X-AppKey headers, and
// wants the params as the (JSON) request body even on GET. Every
// call therefore came back unusable → "no LTP", funds ₹0.
//
// Header scheme (exactly breeze_connect 1.0.69):
//   X-Checksum: token <sha256(timestamp + body + api_secret)>
//   X-Timestamp: <utcnow isoformat[:19]>.000Z
//   X-AppKey: <api key>
//   X-SessionToken: <base64("user_id:session_key")>
// All methods (GET/POST/PUT/DELETE) carry `body` as the request
// body (requests.request(data=body) in the SDK). Empty-string /
// null params are dropped (Breeze throws on empty strings).
//
// Runtime-safe for BOTH the Next.js server and the Bun feed
// service: only node:https + node:crypto, no Next imports.
// ============================================================

import https from 'node:https'
import { createHash } from 'node:crypto'
// ---- keep-alive connection pool (shared with every broker REST path) ----
// see brokers/http-agent.ts — warm sockets instead of a TLS handshake per call
import { httpsKeepAliveAgent } from '../http-agent'

export interface BreezeCreds {
  apiKey?: string
  apiSecret?: string
  /** raw session key (decoded from customerdetails session_token) */
  sessionToken?: string
  /** Breeze user id — preferred (X-SessionToken = base64("uid:key")) */
  userId?: string
  apiSession?: string
}

export interface BreezeRes<T> {
  httpStatus: number
  /** normalized Breeze Status field (200 ok / 5xx error / 0 transport) */
  status: number
  data: T | null
  success: unknown | null
  error?: string
  raw?: string
  ms: number
}

export const BREEZE_API_URL = 'https://api.icicidirect.com/breezeapi/api/v1/'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_5_8) AppleWebKit/534.50.2 (KHTML, like Gecko) Version/5.0.6 Safari/533.22.3'

// ---- rate pacer: Breeze throttles aggressively (HTTP 429/503) ----
const MIN_REQUEST_INTERVAL_MS = 280
let lastCallTs = 0
let chain: Promise<unknown> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** serialize all Breeze calls and keep >=280ms between request starts */
export function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCallTs + MIN_REQUEST_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCallTs = Date.now()
    return fn()
  })
  chain = run.catch(() => undefined)
  return run as Promise<T>
}

// ---- request body (compact JSON, empty params dropped, all values stringified) ----
export function buildBreezeBody(params: Record<string, unknown> | null | undefined): string {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue
    const s = String(v)
    if (s === '') continue
    clean[k] = s
  }
  return JSON.stringify(clean)
}

// ---- session token header (base64 user:key, legacy base64(session)) ----
export function breezeSessionTokenB64(creds: BreezeCreds | null | undefined): string {
  const st = creds?.sessionToken ?? ''
  if (!st) return ''
  if (creds?.userId) return Buffer.from(`${creds.userId}:${st}`, 'ascii').toString('base64')
  return Buffer.from(st, 'ascii').toString('base64')
}

// ---- checksum headers (exact SDK scheme) ----
export function breezeChecksumHeaders(creds: BreezeCreds, body: string): Record<string, string> {
  const ts = `${new Date().toISOString().slice(0, 19)}.000Z`
  const checksum = createHash('sha256').update(`${ts}${body}${creds.apiSecret ?? ''}`).digest('hex')
  return {
    'Content-Type': 'application/json',
    'X-Checksum': `token ${checksum}`,
    'X-Timestamp': ts,
    'X-AppKey': creds.apiKey ?? '',
    'X-SessionToken': breezeSessionTokenB64(creds),
    'User-Agent': UA,
  }
}

// Breeze reports empty books as Status 500 with these messages instead of
// an empty Success list — normal states (fresh account, no trades today).
const EMPTY_RESULT_MESSAGES = [
  'no data found', 'no orders found', 'no positions available', 'no holdings available',
  'no trades available', 'no gtts found', 'no records found', 'data not available',
]

/**
 * True when Breeze rejected the CREDENTIALS (not the request):
 *   · HTTP 401, or the Breeze envelope Error is "Unauthorized User"
 *     (expired/dead session — e.g. a new day without a fresh session)
 *   · "Invalid User Details" (session/appkey mismatch — same remedy)
 * Callers use this to force a credential reload and tell the user to
 * re-create the session instead of retrying blindly.
 */
export function isAuthError(r: { httpStatus?: number; status?: number; error?: string | null } | null | undefined): boolean {
  if (!r) return false
  if (r.httpStatus === 401) return true
  const e = String(r.error ?? '').toLowerCase()
  return e.includes('unauthorized user') || e.includes('invalid user details') || e.includes('session expired') || e.includes('session token')
}

function isEmptyResult(j: { Status?: unknown; Success?: unknown; Error?: unknown } | null): boolean {
  if (!j || j.Success != null) return false
  const err = String(j.Error ?? '').toLowerCase()
  return EMPTY_RESULT_MESSAGES.some(m => err.includes(m))
}

/** raw https request that sends `body` on ANY method (SDK sends data= on GET too) */
function rawSend(method: string, url: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ httpStatus: number; raw: string; error?: string; ms: number }> {
  return new Promise(resolve => {
    let u: URL
    try { u = new URL(url) } catch { return resolve({ httpStatus: 0, raw: '', error: 'bad url', ms: 0 }) }
    const started = Date.now()
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
        agent: httpsKeepAliveAgent(), // keep-alive — no TLS handshake per request
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c as Buffer))
        res.on('end', () => resolve({ httpStatus: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }))
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', e => resolve({ httpStatus: 0, raw: '', error: e.message, ms: Date.now() - started }))
    if (body) req.write(body)
    req.end()
  })
}

export interface BreezeCallOpts {
  timeoutMs?: number
  /** structured call-site logging (mirrors live-api tags) */
  log?: (line: string, level?: 'INFO' | 'WARN') => void
}

/**
 * One checksum-signed Breeze REST call with pacing + throttling retries.
 * Never throws — inspect .status / .error (hedging breeze_request parity).
 */
export async function breezeRequest<T = Record<string, unknown>>(
  creds: BreezeCreds,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  endpoint: string,
  params: Record<string, unknown> | null | undefined,
  opts: BreezeCallOpts = {},
): Promise<BreezeRes<T>> {
  const url = endpoint.startsWith('http') ? endpoint : BREEZE_API_URL + endpoint.replace(/^\//, '')
  const body = buildBreezeBody(params)
  const headers = breezeChecksumHeaders(creds, body)
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxAttempts = 3
  let lastErr = ''
  let lastRaw = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await paced(() => rawSend(method, url, body, headers, timeoutMs))
    if (r.error) {
      lastErr = r.error
      opts.log?.(`GET ${url} → ${r.error} (${r.ms}ms)`, 'WARN')
      if (attempt < maxAttempts) { await sleep(400 * attempt); continue }
      break
    }
    lastRaw = r.raw
    const throttled = [429, 502, 503, 504].includes(r.httpStatus)
    let j: Record<string, unknown> | null = null
    try { j = JSON.parse(r.raw) as Record<string, unknown> } catch { /* non-JSON body */ }

    if (throttled || !j) {
      lastErr = j ? `HTTP ${r.httpStatus}` : `non-JSON response (HTTP ${r.httpStatus})`
      opts.log?.(`${method} ${url} → ${lastErr} (${r.ms}ms) — ${lastRaw.slice(0, 160)}`, 'WARN')
      if (attempt < maxAttempts) { await sleep(700 * attempt); continue }
      break
    }

    if (isEmptyResult(j)) {
      opts.log?.(`${method} ${url} → 200 empty (${r.ms}ms)`)
      return { httpStatus: r.httpStatus, status: 200, data: { Status: 200, Success: [], Error: null } as T, success: [], ms: r.ms }
    }

    const status = Number(j.Status ?? r.httpStatus) || r.httpStatus
    const ok = status === 200 && r.httpStatus === 200
    const line = `${method} ${url} → ${r.httpStatus} (${r.ms}ms)${ok ? '' : ` — ${lastRaw.slice(0, 200)}`}`
    opts.log?.(line, ok ? 'INFO' : 'WARN')
    return {
      httpStatus: r.httpStatus,
      status,
      data: j as T,
      success: j.Success ?? null,
      error: ok ? undefined : String(j.Error ?? lastErr ?? `HTTP ${r.httpStatus}`),
      raw: r.raw.slice(0, 2000),
      ms: r.ms,
    }
  }

  opts.log?.(`${method} ${url} FAILED — ${lastErr}`, 'WARN')
  return { httpStatus: 0, status: 0, data: null, success: null, error: lastErr || 'request failed', raw: lastRaw.slice(0, 2000), ms: 0 }
}

// ------------------------------------------------------------
// Instrument helpers
// ------------------------------------------------------------

/** YYYY-MM-DD (our SymbolMaster storage) → Breeze ISO expiry */
export function breezeIsoExpiry(expiry: string | null | undefined): string | undefined {
  if (!expiry) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry)
  return m ? `${m[1]}-${m[2]}-${m[3]}T06:00:00.000Z` : undefined
}

export interface BreezeInstrument {
  /** underlying / stock code (our master symbol) */
  symbol: string
  exchange: string
  instrumentType: string
  expiry?: string | null
  strike?: number | string | null
  optionType?: string | null
}

/** quote/order params per instrument class (hedging _quote_instrument parity) */
export function breezeInstrumentParams(m: BreezeInstrument): Record<string, string> {
  const exchMap: Record<string, string> = { NSE: 'nse', BSE: 'bse', NFO: 'nfo', BFO: 'bfo', MCX: 'mcx', CDS: 'cds' }
  const p: Record<string, string> = {
    stock_code: m.symbol,
    exchange_code: exchMap[m.exchange?.toUpperCase()] ?? (m.exchange ?? 'nse').toLowerCase(),
  }
  if (m.instrumentType === 'FUT') {
    p.product_type = 'futures'
    const exp = breezeIsoExpiry(m.expiry)
    if (exp) p.expiry_date = exp
  } else if (m.instrumentType === 'CE' || m.instrumentType === 'PE') {
    p.product_type = 'options'
    const exp = breezeIsoExpiry(m.expiry)
    if (exp) p.expiry_date = exp
    p.right = m.instrumentType === 'CE' ? 'call' : 'put'
    if (m.strike != null && m.strike !== '') p.strike_price = String(Math.round(Number(m.strike)))
  } else if (m.instrumentType !== 'INDEX') {
    p.product_type = 'cash'
  }
  return p
}

// quote field aliases — Breeze payload keys vary per doc version
function pickNum(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = Number(row[k])
    if (Number.isFinite(v) && v !== 0) return v
  }
  return undefined
}

export interface BreezeQuote {
  ltp: number
  bid?: number
  ask?: number
  open?: number
  high?: number
  low?: number
  prevClose?: number
  volume?: number
}

/** parse one Breeze quote row (Success list/dict → normalized L1) */
export function parseBreezeQuoteRow(row: Record<string, unknown>): BreezeQuote {
  return {
    ltp: pickNum(row, ['ltp', 'last', 'last_price', 'last_trade_price']) ?? 0,
    bid: pickNum(row, ['best_bid_price', 'bPrice', 'bid', 'buy_price']),
    ask: pickNum(row, ['best_offer_price', 'sPrice', 'ask', 'sell_price']),
    open: pickNum(row, ['open', 'OpenPrice']),
    high: pickNum(row, ['high', 'HighPrice']),
    low: pickNum(row, ['low', 'LowPrice']),
    prevClose: pickNum(row, ['previous_close', 'prev_close', 'close', 'ClosePrice']),
    volume: pickNum(row, ['total_quantity_traded', 'volume', 'ttq']),
  }
}

/** Success can be a list or a dict — take the first row */
export function firstSuccess(response: { success?: unknown } | null): Record<string, unknown> | null {
  const s = response?.success
  if (Array.isArray(s)) return (s[0] as Record<string, unknown>) ?? null
  if (s && typeof s === 'object') return s as Record<string, unknown>
  return null
}

export function successList(response: { success?: unknown } | null): Record<string, unknown>[] {
  const s = response?.success
  if (Array.isArray(s)) return s as Record<string, unknown>[]
  if (s && typeof s === 'object') return [s as Record<string, unknown>]
  return []
}
