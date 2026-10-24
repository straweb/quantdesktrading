// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { generatePythonCode, exportStrategyFile } from '@/lib/services/strategy-engine'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  const b = await req.json().catch(() => ({}))
  const s = await db.strategy.findUnique({ where: { id } })
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  const fields = ['name', 'exchange', 'symbol', 'direction', 'productType', 'orderType', 'qtyMode', 'capitalMode', 'entryTime', 'exitTime', 'repeatDays'] as const
  for (const f of fields) if (b[f] !== undefined) data[f] = String(b[f])
  const numFields = ['fixedQty', 'entryWindowMin', 'limitPrice', 'capitalAmount', 'stopLossPct', 'targetPct', 'trailingSlPct'] as const
  for (const f of numFields) if (b[f] !== undefined) data[f] = b[f] === null || b[f] === '' ? null : Number(b[f])
  if (b.enabled !== undefined) {
    data.enabled = Boolean(b.enabled)
    if (b.enabled && (s.status === 'STOPPED' || s.status === 'ERROR')) data.status = 'IDLE'
  }
  if (b.resetStatus) data.status = 'IDLE'

  const updated = await db.strategy.update({ where: { id }, data })
  const code = generatePythonCode(updated)
  await db.strategy.update({ where: { id }, data: { pythonCode: code } })
  exportStrategyFile(updated)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  await db.strategy.delete({ where: { id } }).catch(() => null)
  return NextResponse.json({ ok: true })
}
