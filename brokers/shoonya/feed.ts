// @ts-nocheck
// ============================================================
// SHOONYA (Noren) live feed adapter — GetQuote per symbol with
// burst pacing. Registered into the feed registry (OpenAlgo-style
// routing); polled by the generic live-broker-feed engine.
// Bun-safe: fetch + no Next imports.
// ============================================================
import { registerFeedAdapter, type FeedPollCtx } from '../feed-registry'

const SHOONYA_TP = 'https://api.shoonya.com/NorenWClientTP'

async function fetchShoonya(ctx: FeedPollCtx): Promise<void> {
  const { creds, targets, status, applyQuote, noteAuthFailure } = ctx
  const uid = creds.userId ?? ''
  const body = { uid, actid: uid, jKey: creds.sessionId ?? '' }
  const jdata = (b: Record<string, unknown>): string => 'jData=' + JSON.stringify(b).replace(/&/g, '\\u0026')
  let n = 0
  let lastErr: string | null = null
  let i = 0
  for (const t of targets) {
    // scrip-master sync stores brokerToken = "NSE|<tsym>"; older synthetic
    // rows keep the bare tsym in brokerSymbol
    const [exch, tsym] = (t.brokerToken || '').includes('|')
      ? (t.brokerToken || '').split('|')
      : (t.brokerSymbol || '').includes('|')
        ? (t.brokerSymbol || '').split('|')
        : [t.exchange === 'NFO' ? 'NFO' : t.exchange === 'BSE' ? 'BSE' : t.exchange === 'BFO' ? 'BFO' : t.exchange === 'MCX' ? 'MCX' : t.exchange === 'CDS' ? 'CDS' : 'NSE', t.brokerSymbol]
    if (!tsym) continue
    // Noren throttles per-second bursts — tiny sleep, round-robin subsets
    if (i > 0 && i % 6 === 0) await new Promise(r => setTimeout(r, 250))
    i++
    try {
      const res = await fetch(`${SHOONYA_TP}/GetQuote`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: jdata({ ...body, exch, tsym }),
        signal: AbortSignal.timeout(3000),
        cache: 'no-store',
      })
      const q = await res.json().catch(() => null) as Record<string, unknown> | { emsg?: string } | null
      if (!res.ok || !q || 'emsg' in q) {
        const emsg = (q as { emsg?: string })?.emsg ?? ''
        lastErr = `GetQuote ${res.status} ${emsg}`.trim()
        status.errors++
        if (/session|not authorized|invalid.*token|no session/i.test(emsg)) noteAuthFailure('Shoonya', emsg || `HTTP ${res.status}`)
        continue
      }
      const qr = q as Record<string, unknown>
      const num = (v: unknown): number | undefined => (Number.isFinite(Number(v)) ? Number(v) : undefined)
      if (applyQuote(t.masterSymbol, {
        ltp: num(qr.lp), bid: num(qr.bp1), ask: num(qr.sp1),
        open: num(qr.o), high: num(qr.h), low: num(qr.l), prevClose: num(qr.c),
        volume: num(qr.v) ?? num(qr.volume),
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
    status.lastError = 'Shoonya responded but no quote applied (mapping/session?)'
    status.errorTs = Date.now()
  }
}

registerFeedAdapter({ brokerType: 'SHOONYA', poll: fetchShoonya })
