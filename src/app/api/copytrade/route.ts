// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  let cfg = await db.copyTradeConfig.findFirst()
  if (!cfg) cfg = await db.copyTradeConfig.create({ data: {} })
  return NextResponse.json({ config: cfg })
}

export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => ({}))
  let cfg = await db.copyTradeConfig.findFirst()
  if (!cfg) cfg = await db.copyTradeConfig.create({ data: {} })
  const updated = await db.copyTradeConfig.update({
    where: { id: cfg.id },
    data: {
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
      ...(body.masterAccountId !== undefined ? { masterAccountId: body.masterAccountId || null } : {}),
      ...(body.capitalSharePct !== undefined ? { capitalSharePct: Math.min(200, Math.max(1, Number(body.capitalSharePct))) } : {}),
      ...(body.slippagePct !== undefined ? { slippagePct: Math.max(0, Number(body.slippagePct)) } : {}),
      ...(body.roundToLot !== undefined ? { roundToLot: Boolean(body.roundToLot) } : {}),
      ...(body.skipFailedLegs !== undefined ? { skipFailedLegs: Boolean(body.skipFailedLegs) } : {}),
      ...(body.killSwitch !== undefined ? { killSwitch: Boolean(body.killSwitch) } : {}),
      updatedAt: new Date(),
    },
  })
  return NextResponse.json({ config: updated })
}
