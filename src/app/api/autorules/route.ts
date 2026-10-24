// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { listRules, createRule } from '@/lib/services/auto-rules-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const rules = await listRules()
  return NextResponse.json({ rules })
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => null)
  if (!body?.underlying) return NextResponse.json({ error: 'underlying is required' }, { status: 400 })
  if (body.kind === 'INDEX' && !Number.isFinite(Number(body.level))) {
    return NextResponse.json({ error: 'index level is required for INDEX rules' }, { status: 400 })
  }
  if (body.kind === 'INDEX_RANGE' && (!Number.isFinite(Number(body.lo)) || !Number.isFinite(Number(body.hi)))) {
    return NextResponse.json({ error: 'range low and high are required for INDEX_RANGE rules' }, { status: 400 })
  }
  if (body.kind === 'TIME' && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(String(body.time ?? ''))) {
    return NextResponse.json({ error: 'time HH:MM or HH:MM:SS is required for TIME rules' }, { status: 400 })
  }
  const rule = await createRule(body)
  return NextResponse.json({ ok: true, rule })
}
