// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { updateGtt, deleteGtt } from '@/lib/services/gtt-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// PATCH /api/gtt/[id] — arm/disarm · DELETE — remove
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  try {
    const body = await req.json()
    const rule = await updateGtt(id, body)
    if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
    return NextResponse.json({ ok: true, rule })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Update failed' }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  const ok = await deleteGtt(id)
  if (!ok) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
