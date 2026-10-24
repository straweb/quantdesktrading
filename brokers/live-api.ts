// @ts-nocheck
// ============================================================
// Shared live REST plumbing for broker adapters.
// Uniform JSON fetch with timeout + normalized error handling so
// every adapter's live code paths stay small and consistent.
//
// CALL-SITE LOGGING (round-10): every outbound broker call can be
// tagged with { broker, accountId, tag } — the helper then logs
//   [BROKER][tag] METHOD url → status (Xms)
// with a response/error snippet to the console AND to the
// account's per-broker broker_logs table, so a failing integration
// can be debugged from Admin → Broker Diagnostics.
// ============================================================

export interface LiveRes<T> {
  ok: boolean
  status: number
  data: T | null
  error?: string
  /** ms spent on the call (0 on transport failure) */
  ms?: number
}

export interface CallTag {
  broker: string
  accountId?: string
  /** logical call-site name, e.g. auth / funds / quote / orderbook */
  tag: string
}

/** truncate + single-line a body for log lines */
function snippet(v: unknown, max = 220): string {
  if (v == null) return ''
  let s = typeof v === 'string' ? v : ''
  if (!s) {
    try { s = JSON.stringify(v) } catch { s = String(v) }
  }
  return s.replace(/\s+/g, ' ').slice(0, max)
}

/** strip query strings / secrets from URLs before logging */
function safeUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}${u.search ? `?${u.searchParams.get('api_key') || u.searchParams.get('client_id') ? '…(creds-in-query)' : u.search}` : ''}`
  } catch {
    return url
  }
}

async function writeBrokerLog(broker: string, accountId: string | undefined, level: string, message: string): Promise<void> {
  if (!accountId) return
  try {
    // dynamic import: adapters also run in contexts without the broker DB
    // (feed service) — never let logging break a live call
    const { logBroker } = await import('./database')
    logBroker(broker, accountId, message, level)
  } catch { /* logging must never throw */ }
}

export async function liveFetch<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; callTag?: CallTag } = {},
): Promise<LiveRes<T>> {
  const { timeoutMs = 4000, callTag, ...rest } = init
  const started = Date.now()
  const method = (rest.method ?? 'GET').toUpperCase()
  let res: Response | null = null
  let out: LiveRes<T>
  try {
    res = await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    let data: T | null = null
    try { data = (await res.json()) as T } catch { /* empty body */ }
    out = { ok: res.ok, status: res.status, data, ms: Date.now() - started }
  } catch (e) {
    out = { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started }
  }

  // ---- call-site logging (console + per-account broker_logs) ----
  if (callTag) {
    const line = `${method} ${safeUrl(url)} → ${out.status}${out.ms != null ? ` (${out.ms}ms)` : ''}`
    if (out.ok) {
      console.log(`[${callTag.broker}][${callTag.tag}] ${line}`)
    } else {
      const detail = out.error ? ` — ${out.error}` : out.data ? ` — ${snippet(out.data)}` : ''
      console.warn(`[${callTag.broker}][${callTag.tag}] ${line}${detail}`)
      await writeBrokerLog(callTag.broker, callTag.accountId, 'WARN', `${callTag.tag}: ${line}${detail}`)
    }
  }
  return out
}

export function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Map a broker-native status string to the terminal's normalized status. */
export function normalizeStatus(raw: string | undefined | null): string {
  const s = (raw ?? '').toUpperCase()
  if (/TRADED|COMPLETE|EXECUT|FILLED/.test(s)) return 'FILLED'
  if (/REJECT/.test(s)) return 'REJECTED'
  if (/CANCEL/.test(s)) return 'CANCELLED'
  if (/EXPIRED/.test(s)) return 'CANCELLED'
  if (/PART|PENDING|OPEN|PLACED|NEW|TRIGGER/.test(s)) return 'OPEN'
  return s || 'OPEN'
}

// ------------------------------------------------------------
// Auth-error detection + fresh-token retry (aligned with the
// straweb/hedging websocket_proxy pattern: is_auth_error →
// get_fresh_auth_token → retry the original call once).
// ------------------------------------------------------------
export function isAuthError(status: number, body: unknown): boolean {
  if (status === 401 || status === 403) return true
  const msg = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  return /session\s*(expired|invalid|token)|invalid\s*(token|session)|auth.*fail|please.*login|jKey|token.*expire/i.test(msg)
}

/** Retry `fn` once with fresh credentials when the first attempt fails on auth. */
export async function withAuthRetry<T>(
  fn: (fresh: boolean) => Promise<T>,
  detect: (r: T) => boolean,
): Promise<T> {
  const first = await fn(false)
  if (!detect(first)) return first
  return fn(true) // second attempt — caller re-reads the session token inside
}
