// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { generatePythonCode, exportStrategyFile } from '@/lib/services/strategy-engine'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const strategies = await db.strategy.findMany({
    include: { logs: { orderBy: { ts: 'desc' }, take: 8 } },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ strategies })
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const b = await req.json().catch(() => null)
  if (!b?.name || !b?.symbol || !b?.entryTime || !b?.exitTime) {
    return NextResponse.json({ error: 'name, symbol, entryTime, exitTime required' }, { status: 400 })
  }
  const s = await db.strategy.create({
    data: {
      name: String(b.name),
      enabled: Boolean(b.enabled ?? false),
      exchange: String(b.exchange || 'NSE'),
      symbol: String(b.symbol).toUpperCase(),
      direction: b.direction === 'SHORT' ? 'SHORT' : 'LONG',
      productType: ['MIS', 'CNC', 'NRML'].includes(b.productType) ? b.productType : 'MIS',
      orderType: ['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(b.orderType) ? b.orderType : 'MARKET',
      limitPrice: b.limitPrice ? Number(b.limitPrice) : null,
      qtyMode: b.qtyMode === 'FIXED' ? 'FIXED' : 'CAPITAL',
      fixedQty: Math.max(1, Number(b.fixedQty ?? 1)),
      capitalAmount: b.capitalAmount ? Number(b.capitalAmount) : null,
      capitalMode: String(b.capitalMode || 'INITIAL_PLUS_PNL'),
      entryTime: String(b.entryTime),
      entryWindowMin: Math.max(1, Number(b.entryWindowMin ?? 10)),
      exitTime: String(b.exitTime),
      repeatDays: String(b.repeatDays || '1,2,3,4,5'),
      stopLossPct: b.stopLossPct ? Number(b.stopLossPct) : null,
      targetPct: b.targetPct ? Number(b.targetPct) : null,
      trailingSlPct: b.trailingSlPct ? Number(b.trailingSlPct) : null,
      accountId: b.accountId || null,
    },
  })
  const code = generatePythonCode(s)
  await db.strategy.update({ where: { id: s.id }, data: { pythonCode: code } })
  exportStrategyFile(s)
  return NextResponse.json({ ok: true, strategy: { ...s, pythonCode: undefined } })
}
