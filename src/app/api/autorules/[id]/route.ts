// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { updateRule, deleteRule } from '@/lib/services/auto-rules-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const rule = await updateRule(id, body)
  if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
  return NextResponse.json({ ok: true, rule })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  const ok = await deleteRule(id)
  if (!ok) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
