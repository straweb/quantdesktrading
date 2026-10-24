// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const audits = await db.orderAudit.findMany({
    include: { account: { select: { label: true } } },
    orderBy: { ts: 'desc' },
    take: 100,
  })
  return NextResponse.json({ audits })
}
