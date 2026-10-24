// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cached } from '@/lib/services/fast-cache'

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'

// REST proxy: full quote + market depth, enriched with the master-contract
// lot size so depth quantity can be rendered in LOTS when the instrument
// has one (F&O) and in raw shares otherwise.
// SPEED: 600ms micro-cache + inflight dedupe — a symbol open fires 2-4
// concurrent requests (chart/depth/watchlist); they now share ONE
// feed round-trip instead of hammering it, while never serving data
// older than a UI interaction.
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol') ?? ''
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  try {
    const data = await cached(`q:${symbol}`, 600, async () => {
      const res = await fetch(`${FEED_URL}/quote?symbol=${encodeURIComponent(symbol)}`, {
        signal: AbortSignal.timeout(3000),
        cache: 'no-store',
      })
      return { json: await res.json(), status: res.status }
    })
    let lotSize = 1
    let instrumentType: string | null = null
    try {
      const m = await db.symbolMaster.findFirst({ where: { symbol }, select: { lotSize: true, instrumentType: true } })
      if (m) { lotSize = m.lotSize || 1; instrumentType = m.instrumentType }
    } catch { /* fall back to raw qty */ }
    return NextResponse.json({ ...data.json, lotSize, instrumentType }, { status: data.status })
  } catch (e) {
    return NextResponse.json({ error: `feed unavailable: ${e instanceof Error ? e.message : ''}` }, { status: 502 })
  }
}

export const dynamic = 'force-dynamic'
