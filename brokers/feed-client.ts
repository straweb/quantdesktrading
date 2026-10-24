// @ts-nocheck
// Server-side client for the market feed mini-service (port 3003).
// All broker adapters use this for LTP resolution.

export interface FeedQuote {
  symbol: string
  ltp: number
  prevClose: number
  open: number
  high: number
  low: number
  vol: number
  ts: number
}

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'

const g = globalThis as unknown as { __feedCache: Map<string, { q: FeedQuote; ts: number }> }
if (!g.__feedCache) g.__feedCache = new Map()

// Degraded-mode fallback prices so fills never hard-fail
export const FALLBACK_PRICES: Record<string, number> = {
  NIFTY: 24500, BANKNIFTY: 51800, FINNIFTY: 23100, MIDCPNIFTY: 12250, SENSEX: 80500,
  RELIANCE: 2870, TCS: 4150, HDFCBANK: 1740, INFY: 1870, SBIN: 830, ICICIBANK: 1265,
  AXISBANK: 1170, LT: 3620, ITC: 465, TATAMOTORS: 990, TATASTEEL: 155, WIPRO: 545,
  HCLTECH: 1790, BAJFINANCE: 7150, MARUTI: 12800, TITAN: 3480, ASIANPAINT: 2950,
  SUNPHARMA: 1780, ULTRACEMCO: 11200, ADANIENT: 3100, BHARTIARTL: 1580,
}

export async function fetchQuotes(symbols: string[]): Promise<Record<string, FeedQuote>> {
  if (symbols.length === 0) return {}
  try {
    const res = await fetch(`${FEED_URL}/ltp?symbols=${encodeURIComponent(symbols.join(','))}`, {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`feed ${res.status}`)
    const data = (await res.json()) as { quotes: Record<string, FeedQuote> }
    const now = Date.now()
    for (const [s, q] of Object.entries(data.quotes)) g.__feedCache.set(s, { q, ts: now })
    return data.quotes
  } catch {
    // degraded: serve last-known or fallback
    const out: Record<string, FeedQuote> = {}
    for (const s of symbols) {
      const cached = g.__feedCache.get(s)
      const base = cached?.q.ltp ?? FALLBACK_PRICES[s.split(/\d/)[0]] ?? FALLBACK_PRICES[s] ?? 1000
      out[s] = cached?.q ?? {
        symbol: s, ltp: base, prevClose: base, open: base, high: base, low: base, vol: 0, ts: Date.now(),
      }
    }
    return out
  }
}

export async function fetchLtp(symbol: string): Promise<number> {
  const q = await fetchQuotes([symbol])
  return q[symbol]?.ltp ?? 1000
}

export async function feedHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${FEED_URL}/health`, { signal: AbortSignal.timeout(1200), cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}
