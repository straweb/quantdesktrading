// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { ensureOptionContracts } from '@/lib/services/option-service'

// POST { underlying, strike, expiry? } — dynamically create CE+PE
// contracts for a user-added strike (master rows + broker mappings
// + feed universe publication). Idempotent.
export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => null)
  const underlying = String(body?.underlying ?? '').toUpperCase()
  const strike = Number(body?.strike)
  const expiry = body?.expiry ? String(body.expiry) : null
  if (!underlying || !Number.isFinite(strike) || strike <= 0) {
    return NextResponse.json({ error: 'underlying and strike required' }, { status: 400 })
  }
  const r = await ensureOptionContracts(underlying, strike, expiry)
  return NextResponse.json({ ok: true, ...r })
}

export const dynamic = 'force-dynamic'
