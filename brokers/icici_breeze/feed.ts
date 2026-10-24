// @ts-nocheck
// ============================================================
// ICICI DIRECT BREEZE live feed adapter — SDK-parity checksum
// quotes (GET with body params), round-robin batches under the
// Breeze ~3.5 req/s pacer. Registered into the feed registry
// (OpenAlgo-style routing); polled by the generic engine.
// Bun-safe: breeze.ts (node:https) + no Next imports.
// ============================================================
import { registerFeedAdapter, type FeedPollCtx } from '../feed-registry'
import { breezeRequest, breezeInstrumentParams, parseBreezeQuoteRow, firstSuccess, isAuthError, type BreezeCreds } from './breeze'

let iciciRr = 0

async function fetchIcici(ctx: FeedPollCtx): Promise<void> {
  const { creds, targets, status, applyQuote, noteAuthFailure, pushLog } = ctx
  let n = 0
  let lastErr: string | null = null
  // Breeze rate limit ~3.5 req/s — round-robin batches of 3 symbols/cycle
  // (the full set covers over a few seconds), oldest-first rotation
  const BATCH = 3
  const rr = iciciRr % Math.max(1, targets.length)
  iciciRr = (iciciRr + 1) % Math.max(1, targets.length)
  const batch = targets.length <= BATCH ? targets : targets.slice(rr, rr + BATCH).concat(rr + BATCH > targets.length ? targets.slice(0, (rr + BATCH) % targets.length) : [])
  const bc: BreezeCreds = { apiKey: creds.apiKey, apiSecret: creds.apiSecret, sessionToken: creds.sessionToken, userId: creds.userId }
  const log = (line: string, level: 'INFO' | 'WARN' = 'INFO') => {
    if (level === 'WARN') pushLog(`breeze ${line}`, 'WARN')
  }
  for (const t of batch) {
    // brokerToken = "SYM|YYYY-MM-DD|strike|CE/PE" (breeze adapter mapSymbol)
    const [stock, expiry, strike, right] = (t.brokerToken || '').split('|')
    try {
      const res = await breezeRequest<Record<string, unknown>>(
        bc, 'GET', 'quotes',
        breezeInstrumentParams({
          symbol: stock || t.brokerSymbol,
          exchange: t.exchange,
          instrumentType: t.instrumentType,
          expiry: expiry || null,
          strike: strike || null,
          optionType: right || t.instrumentType,
        }),
        { timeoutMs: 5000, log },
      )
      const row = firstSuccess(res)
      if (res.status !== 200 || !row) {
        status.errors++
        // dead/expired session ("Unauthorized User" / "Invalid User Details" /
        // HTTP 401) — force a credential reload + back off, never hammer Breeze
        if (isAuthError(res)) {
          noteAuthFailure('ICICI Breeze', res.error ?? `HTTP ${res.httpStatus}`)
          lastErr = null // noteAuthFailure owns the status message — don't clobber it below
        } else {
          lastErr = `quotes ${res.httpStatus || res.status} ${res.error ?? ''}`.trim()
        }
        continue
      }
      const q = parseBreezeQuoteRow(row)
      if (applyQuote(t.masterSymbol, {
        ltp: q.ltp, bid: q.bid, ask: q.ask,
        open: q.open, high: q.high, low: q.low, prevClose: q.prevClose,
        volume: q.volume,
      }, t)) n++
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      status.errors++
    }
  }
  status.polls++
  status.symbols = n
  if (lastErr) { status.lastError = lastErr; status.errorTs = Date.now() }
  if (n === 0 && !lastErr) {
    status.lastError = 'Breeze responded but no quote applied (mapping/session?)'
    status.errorTs = Date.now()
  }
}

registerFeedAdapter({ brokerType: 'ICICI_BREEZE', poll: fetchIcici })
