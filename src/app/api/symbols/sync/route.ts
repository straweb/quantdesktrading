// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { syncMasterContracts } from '@/lib/services/symbol-service'
import { db } from '@/lib/db'

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    const result = await syncMasterContracts('DAILY_SYNC')
    const last = await db.syncLog.findFirst({ orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ ok: true, ...result, log: last })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const logs = await db.syncLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 })
  const setting = await db.systemSetting.findUnique({ where: { key: 'lastMasterSync' } })
  const counts = {
    symbols: await db.symbolMaster.count(),
    mappings: await db.symbolMapping.count(),
  }
  return NextResponse.json({ lastSync: setting?.value ?? null, logs, counts })
}
