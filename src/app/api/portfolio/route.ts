// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getAdapter, type LegContext, type SymbolMapInfo } from '../../../../brokers/index'
import { decryptJson } from '@/lib/crypto'
import { getPositions } from '@brokers/database'
import { fetchQuotes } from '@brokers/feed-client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ============================================================
// GET /api/portfolio — portfolio holdings across accounts.
// Live brokers: their real Holdings API (Dhan /v2/holdings,
// Shoonya /Holdings, Breeze /portfolio/holdings). Sandbox
// accounts: empty (the sim has no demat) — positions come from
// /api/positions. Rows carry a live mark when the symbol is in
// the feed universe so the dashboard can show current value.
// ============================================================

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth

  const accounts = await db.brokerAccount.findMany({ orderBy: { sortOrder: 'asc' } })
  const rows: {
    accountId: string
    accountLabel: string
    brokerType: string
    live: boolean
    holdings: { symbol: string; qty: number; avgPrice: number; ltp: number; pnl: number; value: number }[]
    message?: string
  }[] = []

  for (const acc of accounts) {
    const adapter = getAdapter(acc.brokerType as never)
    const creds = decryptJson(acc.credentialsEnc)
    if (!adapter?.getHoldings || !creds) {
      rows.push({
        accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, live: false,
        holdings: [],
        message: adapter?.getHoldings ? 'sandbox account (no live credentials)' : 'no holdings API for this broker',
      })
      continue
    }
    const ctx: LegContext = {
      accountId: acc.id,
      accountLabel: acc.label,
      brokerType: acc.brokerType as never,
      credentials: creds,
      order: { side: 'BUY', qty: 0, orderType: 'MARKET', productType: 'MIS', masterOrderId: '', source: 'API' },
      symbolMap: { masterSymbol: '', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, brokerSymbol: '' } as SymbolMapInfo,
      ltp: 0,
    }
    try {
      const holdings = await adapter.getHoldings(ctx)
      const symbols = holdings.map(h => h.symbol).filter(Boolean)
      const quotes = symbols.length ? await fetchQuotes(symbols) : {}
      rows.push({
        accountId: acc.id,
        accountLabel: acc.label,
        brokerType: acc.brokerType,
        live: true,
        holdings: holdings.map(h => {
          const ltp = quotes[h.symbol]?.ltp ?? h.ltp ?? 0
          return {
            symbol: h.symbol,
            qty: h.qty,
            avgPrice: h.avgPrice,
            ltp,
            pnl: h.pnl ?? (ltp - h.avgPrice) * h.qty,
            value: ltp * h.qty,
          }
        }),
      })
    } catch (e) {
      rows.push({
        accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, live: true,
        holdings: [],
        message: e instanceof Error ? e.message : 'holdings API unreachable',
      })
    }
  }

  // open-position inventory per account (margin/exposure view)
  const positions = accounts.flatMap(a =>
    getPositions(a.brokerType, a.id)
      .filter(p => p.netQty !== 0)
      .map(p => ({ accountId: a.id, accountLabel: a.label, symbol: p.symbol, netQty: p.netQty, avgPrice: p.avgPrice, ltp: p.ltp, lotSize: p.lotSize })),
  )

  return NextResponse.json({ portfolio: rows, positions, ts: new Date().toISOString() })
}
