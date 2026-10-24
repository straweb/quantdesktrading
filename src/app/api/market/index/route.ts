// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { INDEX_CONSTITUENTS } from '@/lib/services/symbol-service'
import { fetchQuotes } from '@brokers/feed-client'
import { round2 } from '@/lib/charges'

export const dynamic = 'force-dynamic'

// GET /api/market/index?symbol=NIFTY
// Constituents of an index with live quotes + contribution points.
// contribution pts ≈ stock change pts × weight/100 (sim approximation).
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const symbol = new URL(req.url).searchParams.get('symbol') ?? ''
  const members = INDEX_CONSTITUENTS[symbol]
  if (!members) return NextResponse.json({ error: `no constituents for ${symbol}` }, { status: 404 })

  const [indexRows, quotes] = await Promise.all([
    db.symbolMaster.findMany({ where: { symbol: { in: [symbol, ...members.map(m => m.symbol)] } } }),
    fetchQuotes([...new Set([symbol, ...members.map(m => m.symbol)])]),
  ])
  const master = indexRows.find(r => r.symbol === symbol)
  const idxQuote = quotes[symbol]

  const constituents = members.map(m => {
    const q = quotes[m.symbol]
    const prev = q?.prevClose ?? 0
    const ltp = q?.ltp ?? 0
    const chgPts = prev ? ltp - prev : 0
    return {
      symbol: m.symbol,
      weight: m.weight,
      ltp: round2(ltp),
      high: round2(q?.high ?? 0),
      low: round2(q?.low ?? 0),
      vol: q?.vol ?? 0,
      chgPct: prev ? round2((chgPts / prev) * 100) : 0,
      pts: round2(chgPts * (m.weight / 100)),
    }
  })

  const totalPts = round2(constituents.reduce((s, c) => s + c.pts, 0))
  return NextResponse.json({
    index: {
      symbol,
      name: master?.name ?? symbol,
      ltp: round2(idxQuote?.ltp ?? 0),
      prevClose: round2(idxQuote?.prevClose ?? 0),
      high: round2(idxQuote?.high ?? 0),
      low: round2(idxQuote?.low ?? 0),
      vol: idxQuote?.vol ?? 0,
      chgPts: idxQuote?.prevClose ? round2(idxQuote.ltp - idxQuote.prevClose) : 0,
      chgPct: idxQuote?.prevClose ? round2(((idxQuote.ltp - idxQuote.prevClose) / idxQuote.prevClose) * 100) : 0,
    },
    constituents,
    totalPts, // Σ weighted contributions (members we track)
  })
}
