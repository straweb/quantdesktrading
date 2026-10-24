// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { cancelAllOrders } from '@/lib/services/order-router'

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => ({}))
  // optional symbol filter (strikes panel "Cancel CE" etc.)
  const symbols: string[] | undefined = Array.isArray(body?.symbols) && body.symbols.length > 0
    ? body.symbols.map((s: unknown) => String(s).toUpperCase())
    : undefined
  const cancelled = await cancelAllOrders(symbols)
  return NextResponse.json({ ok: true, cancelled })
}
