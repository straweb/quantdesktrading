// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getTrades } from '@brokers/database'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const accounts = await db.brokerAccount.findMany({ orderBy: { sortOrder: 'asc' } })
  const rows = []
  for (const a of accounts) {
    for (const t of getTrades(a.brokerType, a.id, 100)) {
      rows.push({ ...t, accountId: a.id, accountLabel: a.label, brokerType: a.brokerType })
    }
  }
  rows.sort((x, y) => (x.ts < y.ts ? 1 : -1))
  const totals = {
    charges: round2(rows.reduce((s, t) => s + t.chargesTotal, 0)),
    realized: round2(rows.reduce((s, t) => s + (t.realizedPnl ?? 0), 0)),
  }
  return NextResponse.json({ trades: rows.slice(0, 300), totals })
}

function round2(n: number) { return Math.round(n * 100) / 100 }
