// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getPositions } from '@brokers/database'
import { fetchQuotes } from '@brokers/feed-client'
import { round2 } from '@/lib/charges'

// Aggregated positions across every broker account DB with live LTP marks
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const accounts = await db.brokerAccount.findMany({ orderBy: { sortOrder: 'asc' } })

  const raw: (ReturnType<typeof getPositions>[number] & { accountId: string; accountLabel: string; brokerType: string })[] = []
  for (const a of accounts) {
    for (const p of getPositions(a.brokerType, a.id)) {
      raw.push({ ...p, accountId: a.id, accountLabel: a.label, brokerType: a.brokerType })
    }
  }
  const symbols = [...new Set(raw.map(p => p.symbol))]
  const quotes = await fetchQuotes(symbols)

  const positions = raw.map(p => {
    const ltp = quotes[p.symbol]?.ltp ?? p.ltp
    const unrealized = round2((ltp - p.avgPrice) * p.netQty)
    return { ...p, ltp, unrealizedPnl: unrealized }
  })

  // per-symbol aggregate across accounts
  const bySymbol = new Map<string, { symbol: string; exchange: string; netQty: number; avgPrice: number; ltp: number; unrealizedPnl: number; accounts: number }>()
  for (const p of positions.filter(p => p.netQty !== 0)) {
    const agg = bySymbol.get(p.symbol) ?? { symbol: p.symbol, exchange: p.exchange, netQty: 0, avgPrice: 0, ltp: p.ltp, unrealizedPnl: 0, accounts: 0 }
    agg.netQty += p.netQty
    agg.avgPrice = agg.avgPrice === 0 ? p.avgPrice : (agg.avgPrice + p.avgPrice) / 2
    agg.unrealizedPnl = round2(agg.unrealizedPnl + p.unrealizedPnl)
    agg.accounts++
    bySymbol.set(p.symbol, agg)
  }

  const totals = {
    unrealizedPnl: round2(positions.reduce((s, p) => s + p.unrealizedPnl, 0)),
    realizedPnl: round2(positions.reduce((s, p) => s + p.realizedPnl, 0)),
    openPositions: positions.filter(p => p.netQty !== 0).length,
  }

  return NextResponse.json({ positions, bySymbol: [...bySymbol.values()], totals })
}
