// @ts-nocheck
// ============================================================
// DHAN live feed adapter — batched marketfeed/quote per segment.
// Registered into the feed registry (OpenAlgo-style routing) and
// polled by the generic live-broker-feed engine every cycle.
// Bun-safe: fetch + no Next imports.
// ============================================================
import { registerFeedAdapter, type FeedPollCtx } from '../feed-registry'

const DHAN_QUOTE_URL = 'https://api.dhan.co/v2/marketfeed/quote'

async function fetchDhan(ctx: FeedPollCtx): Promise<void> {
  const { creds, targets, status, applyQuote, noteAuthFailure, pushLog } = ctx
  const segments: Record<string, string[]> = {}
  for (const t of targets) {
    // Dhan segments (scrip-master parity): indices IDX_I, NSE eq NSE_EQ,
    // derivatives NSE_FNO/BSE_FNO, MCX MCX_COMM, currency NSE_CURRENCY
    const seg = t.instrumentType === 'INDEX' ? 'IDX_I'
      : t.exchange === 'NFO' ? 'NSE_FNO'
      : t.exchange === 'BFO' ? 'BSE_FNO'
      : t.exchange === 'BSE' ? 'BSE_EQ'
      : t.exchange === 'MCX' ? 'MCX_COMM'
      : t.exchange === 'CDS' ? 'NSE_CURRENCY'
      : 'NSE_EQ'
    const token = t.brokerToken || t.brokerSymbol
    if (!token) continue
    ;(segments[seg] ??= []).push(token)
  }
  if (Object.keys(segments).length === 0) return
  const started = Date.now()
  const res = await fetch(DHAN_QUOTE_URL, {
    method: 'POST',
    headers: {
      'access-token': creds.accessToken ?? '',
      ...(creds.clientId ? { 'client-id': creds.clientId } : {}),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(segments),
    signal: AbortSignal.timeout(4000),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null) as { data?: Record<string, Record<string, Record<string, unknown>>>; errorMessage?: string } | null
  if (!res.ok) {
    status.errors++
    const msg = `Dhan quote HTTP ${res.status}${body?.errorMessage ? ` — ${body.errorMessage}` : ''}`
    if (res.status === 401 || res.status === 403 || /auth|token|access/i.test(body?.errorMessage ?? '')) {
      noteAuthFailure('Dhan', body?.errorMessage ?? `HTTP ${res.status}`)
    } else {
      status.lastError = msg
      status.errorTs = Date.now()
      pushLog(`dhan quote ${res.status} (${Date.now() - started}ms) — ${msg}`, 'WARN')
    }
    return
  }
  let n = 0
  for (const [, segData] of Object.entries(body?.data ?? {})) {
    for (const [token, q] of Object.entries(segData ?? {})) {
      const t = targets.find(t => (t.brokerToken || t.brokerSymbol) === token)
      if (!t) continue
      const ohlc = (q.ohlc ?? {}) as Record<string, unknown>
      const depth = (q.depth ?? {}) as { buy?: Record<string, unknown>[]; sell?: Record<string, unknown>[] }
      const num = (v: unknown): number | undefined => (Number.isFinite(Number(v)) ? Number(v) : undefined)
      if (applyQuote(t.masterSymbol, {
        ltp: num(q.last_price),
        bid: num(depth.buy?.[0]?.price),
        ask: num(depth.sell?.[0]?.price),
        open: num(ohlc.open), high: num(ohlc.high), low: num(ohlc.low), prevClose: num(ohlc.close),
        volume: num(q.volume),
      }, t)) n++
    }
  }
  status.polls++
  status.symbols = n
  if (n === 0) {
    status.lastError = 'Dhan quote responded but no symbol matched the mapping'
    status.errorTs = Date.now()
  }
}

registerFeedAdapter({ brokerType: 'DHAN', poll: fetchDhan })
