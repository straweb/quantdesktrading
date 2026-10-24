// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { placeMasterOrder } from '@/lib/services/order-router'
import { db } from '@/lib/db'
import type { OrderSide, OrderTypeKind, ProductType } from '@/lib/types'
import { getOrders } from '@brokers/database'

// Aggregated order book across all broker account DBs
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const accounts = await db.brokerAccount.findMany({ orderBy: { sortOrder: 'asc' } })
  const rows = []
  for (const a of accounts) {
    for (const o of getOrders(a.brokerType, a.id, 100)) {
      rows.push({ ...o, accountId: a.id, accountLabel: a.label, brokerType: a.brokerType })
    }
  }
  rows.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
  return NextResponse.json({ orders: rows.slice(0, 300) })
}

// Place a master order -> fan out to all enabled accounts (copy trading)
export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => null)
  if (!body?.symbol || !body?.side) {
    return NextResponse.json({ error: 'symbol and side are required' }, { status: 400 })
  }
  const ct = await db.copyTradeConfig.findFirst()
  if (ct?.killSwitch) {
    return NextResponse.json({ error: 'KILL SWITCH active — all order routing blocked. Disable in Admin → Copy Trading.' }, { status: 423 })
  }
  const result = await placeMasterOrder({
    symbol: String(body.symbol),
    exchange: String(body.exchange || 'NSE'),
    side: String(body.side) as OrderSide,
    qty: Math.max(0, Number(body.qty ?? 0)),
    orderType: (body.orderType || 'MARKET') as OrderTypeKind,
    productType: (body.productType || 'MIS') as ProductType,
    limitPrice: body.limitPrice ? Number(body.limitPrice) : undefined,
    triggerPrice: body.triggerPrice ? Number(body.triggerPrice) : undefined,
    source: (body.source || 'MANUAL') as never,
    strategyId: body.strategyId,
    tag: body.tag,
    reduceOnly: Boolean(body.reduceOnly),
    capitalPct: body.capitalPct != null ? Math.max(0.01, Math.min(100, Number(body.capitalPct))) : undefined,
  })
  return NextResponse.json(result, { status: result.status === 'FAILED' ? 422 : 200 })
}
