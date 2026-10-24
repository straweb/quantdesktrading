// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  const s = await db.strategy.findUnique({ where: { id } })
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ id: s.id, name: s.name, filename: s.pythonCode ? `${s.id.slice(0, 8)}_${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.py` : null, code: s.pythonCode })
}
