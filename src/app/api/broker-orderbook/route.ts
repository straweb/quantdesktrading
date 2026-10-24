// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getAdapter, type LegContext, type SymbolMapInfo } from '../../../../brokers/index'
import { decryptJson } from '@/lib/crypto'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ============================================================
// Live broker order book — direct pass-through to the account's
// real broker API (Dhan v2 / Shoonya Noren / ICICI Breeze).
// GET /api/broker-orderbook?accountId=...
// Returns normalized rows + whether the account is in live mode.
// ============================================================

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const accountId = req.nextUrl.searchParams.get('accountId')
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })

  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const adapter = getAdapter(acc.brokerType as never)
  if (!adapter?.getOrderBook) {
    return NextResponse.json({ orders: [], live: false, message: 'This broker adapter has no live order book API' })
  }
  const creds = decryptJson(acc.credentialsEnc)
  if (!creds) {
    return NextResponse.json({ orders: [], live: false, message: 'Sandbox account (no live credentials)' })
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
    const orders = await adapter.getOrderBook(ctx)
    return NextResponse.json({ orders, live: true, mode: adapter.modeLabel(creds) })
  } catch (e) {
    return NextResponse.json({ orders: [], live: true, message: e instanceof Error ? e.message : 'broker API unreachable' }, { status: 502 })
  }
}
