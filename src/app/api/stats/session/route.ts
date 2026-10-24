// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { getTrades, getPositions } from '@brokers/database'
import { fetchQuotes } from '@brokers/feed-client'
import { round2 } from '@/lib/charges'

export const dynamic = 'force-dynamic'

// GET /api/stats/session — current-session performance:
//  · winRate    % of closing trades with positive realized PnL
//  · pts        net points captured = Σ (realizedPnl / qty) over closes
//  · realized / unrealized ₹ totals, per-account breakdown
// Session = trades since the IST day start (04:30 UTC).
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth

  const istDayStart = new Date(Date.now() + 5.5 * 3600_000)
  istDayStart.setUTCHours(0, 0, 0, 0)
  const sessionStart = istDayStart.getTime() - 5.5 * 3600_000

  const accounts = await db.brokerAccount.findMany({ orderBy: { sortOrder: 'asc' } })

  interface AccStat {
    accountId: string
    label: string
    brokerType: string
    trades: number
    closes: number
    wins: number
    pts: number
    realized: number
    unrealized: number
    charges: number
  }
  const perAccount: AccStat[] = []
  let closes = 0, wins = 0, pts = 0, realized = 0, charges = 0
  const symbolPts = new Map<string, number>()

  for (const a of accounts) {
    const trades = getTrades(a.brokerType, a.id, 400).filter(t => new Date(t.ts).getTime() >= sessionStart)
    let aCloses = 0, aWins = 0, aPts = 0, aReal = 0, aChg = 0
    for (const t of trades) {
      aChg += t.chargesTotal
      if (t.realizedPnl === undefined || t.realizedPnl === null) continue
      aCloses++
      aReal += t.realizedPnl
      if (t.realizedPnl > 0) aWins++
      const unitPts = t.qty > 0 ? t.realizedPnl / t.qty : 0
      aPts += unitPts
      symbolPts.set(t.symbol, (symbolPts.get(t.symbol) ?? 0) + unitPts)
    }
    const pos = getPositions(a.brokerType, a.id)
    const aUnreal = pos.reduce((s, p) => s + p.unrealizedPnl, 0)
    closes += aCloses; wins += aWins; pts += aPts; realized += aReal; charges += aChg
    perAccount.push({
      accountId: a.id, label: a.label, brokerType: a.brokerType,
      trades: trades.length, closes: aCloses, wins: aWins,
      pts: round2(aPts), realized: round2(aReal), unrealized: round2(aUnreal), charges: round2(aChg),
    })
  }

  // live unrealized marks
  const symbols = [...new Set(accounts.flatMap(a => getPositions(a.brokerType, a.id).map(p => p.symbol)))]
  const quotes = await fetchQuotes(symbols)
  let unrealized = 0
  for (const a of accounts) {
    for (const p of getPositions(a.brokerType, a.id)) {
      const ltp = quotes[p.symbol]?.ltp ?? p.ltp
      unrealized += (ltp - p.avgPrice) * p.netQty
    }
  }

  return NextResponse.json({
    sessionStart: new Date(sessionStart).toISOString(),
    winRate: closes > 0 ? round2((wins / closes) * 100) : null,
    pts: round2(pts),
    realized: round2(realized),
    unrealized: round2(unrealized),
    net: round2(realized + unrealized),
    closes, wins, trades: perAccount.reduce((s, a) => s + a.trades, 0),
    charges: round2(charges),
    perAccount,
    topSymbols: [...symbolPts.entries()]
      .map(([symbol, p]) => ({ symbol, pts: round2(p) }))
      .sort((x, y) => Math.abs(y.pts) - Math.abs(x.pts))
      .slice(0, 6),
  })
}
