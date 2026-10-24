// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { fetchQuotes } from '@brokers/feed-client'

// REST proxy to the market feed mini-service (browser reaches it same-origin)
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase()
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  const quotes = await fetchQuotes([symbol])
  const q = quotes[symbol]
  if (!q) return NextResponse.json({ error: 'unknown symbol' }, { status: 404 })
  return NextResponse.json({ ltp: q.ltp, prevClose: q.prevClose, symbol })
}

export const dynamic = 'force-dynamic'
