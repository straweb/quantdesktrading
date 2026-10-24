// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { listGtt, createGtt } from '@/lib/services/gtt-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/gtt — list GTT rules · POST — create one
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  return NextResponse.json({ rules: await listGtt() })
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    const body = await req.json()
    const rule = await createGtt(body)
    return NextResponse.json({ ok: true, rule })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Create failed' }, { status: 400 })
  }
}
