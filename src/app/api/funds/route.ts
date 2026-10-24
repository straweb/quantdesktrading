// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getCash } from '@brokers/database'
import { syncAccountFunds } from '@/lib/services/funds-sync'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const accounts = await db.brokerAccount.findMany({ include: { capital: true }, orderBy: { sortOrder: 'asc' } })
  const funds = accounts.map(a => ({
    accountId: a.id,
    label: a.label,
    brokerType: a.brokerType,
    cash: getCash(a.brokerType, a.id),
    initialCapital: a.capital?.initialCapital ?? 0,
    realizedPnl: a.capital?.realizedPnl ?? 0,
    chargesPaid: a.capital?.chargesPaid ?? 0,
    deployed: a.capital?.deployed ?? 0,
  }))
  return NextResponse.json({ funds })
}

// POST /api/funds { accountId? } — pull REAL broker funds now.
// With accountId: one account. Without: every active live account.
// Used by the capital chip "Pull funds" button and the feed dropdown.
export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => ({}))
  const accountId: string | undefined = body?.accountId
  if (accountId) {
    // explicit user action (chip / dropdown button) — bypass the 15s cache
    const r = await syncAccountFunds(accountId, { force: body?.force !== false })
    return NextResponse.json(r, { status: r.ok ? 200 : 400 })
  }
  const accs = await db.brokerAccount.findMany({
    where: { isActive: true, status: 'ACTIVE' },
    select: { id: true, label: true },
    orderBy: { sortOrder: 'asc' },
  })
  const results: { accountId: string; label: string; ok: boolean; cash?: number; message: string }[] = []
  for (const a of accs) {
    const r = await syncAccountFunds(a.id)
    results.push({ accountId: a.id, label: a.label, ...r })
  }
  return NextResponse.json({ ok: results.some(r => r.ok), results })
}
