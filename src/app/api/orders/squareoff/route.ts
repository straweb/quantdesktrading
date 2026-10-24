// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { squareOffAll } from '@/lib/services/order-router'
import { db } from '@/lib/db'

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => ({}))
  const source = body?.killSwitch ? 'KILLSWITCH' : 'SQUAREOFF'
  // optional symbol filter: close only matching positions (strikes panel
  // row exit / PE swap). Empty/absent = square off everything.
  const symbols: string[] | undefined = Array.isArray(body?.symbols) && body.symbols.length > 0
    ? body.symbols.map((s: unknown) => String(s).toUpperCase())
    : undefined
  const results = await squareOffAll(source as 'SQUAREOFF' | 'KILLSWITCH', { symbols })
  const filled = results.reduce((s, r) => s + r.legs.filter(l => l.status === 'FILLED').length, 0)
  return NextResponse.json({ ok: true, orders: results.length, filledLegs: filled, results })
}
