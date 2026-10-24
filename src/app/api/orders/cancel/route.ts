// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { getAdapter } from '@brokers/index'
import { getOrders, updateOrder } from '@brokers/database'
import { decryptJson } from '@/lib/crypto'

export const dynamic = 'force-dynamic'

// POST /api/orders/cancel { accountId, orderId }
// Cancel a single broker leg (used by the order row Cancel button).
export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => null)
  const accountId = String(body?.accountId ?? '')
  const orderId = String(body?.orderId ?? '')
  if (!accountId || !orderId) {
    return NextResponse.json({ error: 'accountId and orderId are required' }, { status: 400 })
  }
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return NextResponse.json({ error: 'account not found' }, { status: 404 })
  const order = getOrders(acc.brokerType, acc.id, 200).find(o => o.id === orderId)
  if (!order) return NextResponse.json({ error: 'order not found' }, { status: 404 })
  if (order.status !== 'OPEN' && order.status !== 'PENDING') {
    return NextResponse.json({ error: `order is ${order.status} — nothing to cancel` }, { status: 422 })
  }
  const adapter = getAdapter(acc.brokerType as never)
  if (!adapter) return NextResponse.json({ error: 'no adapter' }, { status: 500 })
  try {
    const r = await adapter.cancelOrder(
      {
        accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType as never, credentials: decryptJson(acc.credentialsEnc),
        order: { side: order.side, qty: order.qty, orderType: order.orderType, productType: order.productType, masterOrderId: order.masterOrderId ?? '', source: 'MANUAL' },
        symbolMap: { masterSymbol: order.symbol, exchange: order.exchange, instrumentType: 'EQ', lotSize: 1, brokerSymbol: order.symbol },
        ltp: 0,
      },
      orderId,
    )
    if (r.ok) {
      updateOrder(acc.brokerType, acc.id, orderId, { status: 'CANCELLED', message: 'Cancelled from terminal' })
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: r.message ?? 'cancel rejected' }, { status: 422 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'cancel failed' }, { status: 500 })
  }
}
