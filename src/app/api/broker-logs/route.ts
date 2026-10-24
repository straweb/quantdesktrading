// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getBrokerLogs } from '@brokers/database'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const url = new URL(req.url)
  const accountId = url.searchParams.get('accountId')
  if (!accountId) return NextResponse.json({ logs: [] })
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return NextResponse.json({ logs: [] })
  const logs = getBrokerLogs(acc.brokerType, acc.id, 150)
  return NextResponse.json({ logs })
}
