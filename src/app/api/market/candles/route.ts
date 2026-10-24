// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { cached } from '@/lib/services/fast-cache'

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'

// REST proxy: candle history from the feed service.
// SPEED: 2s micro-cache per (symbol, tf, limit) — chart pans/refreshes and
// multiple panels asking for the same series share one feed round-trip;
// 2s keeps intrabar updates effectively realtime (the 250ms socket stream
// live-updates the last bar anyway).
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol') ?? ''
  const tf = url.searchParams.get('tf') ?? '5m'
  const limit = url.searchParams.get('limit') ?? '500'
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  try {
    const data = await cached(`c:${symbol}|${tf}|${limit}`, 2000, async () => {
      const res = await fetch(`${FEED_URL}/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&limit=${encodeURIComponent(limit)}`, {
        signal: AbortSignal.timeout(4000),
        cache: 'no-store',
      })
      return { json: await res.json(), status: res.status }
    })
    return NextResponse.json(data.json, { status: data.status })
  } catch (e) {
    return NextResponse.json({ error: `feed service unavailable: ${e instanceof Error ? e.message : ''}` }, { status: 502 })
  }
}

export const dynamic = 'force-dynamic'
