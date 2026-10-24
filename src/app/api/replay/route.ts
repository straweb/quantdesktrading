// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const FEED_REST = process.env.FEED_REST_URL || 'http://localhost:3004'

// GET /api/replay — paper-trading replay status (proxied to the feed service)
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    const r = await fetch(`${FEED_REST}/replay-status`, { signal: AbortSignal.timeout(3000), cache: 'no-store' })
    const data = await r.json()
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ active: false, error: e instanceof Error ? e.message : 'feed unreachable' }, { status: 200 })
  }
}

// POST /api/replay — start/stop a replay session
// body: { mode: 'start'|'stop', file?, random?, fromTs?, toTs?, speed? }
export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    const body = await req.json()
    const r = await fetch(`${FEED_REST}/replay-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000), // loading a large session db can take a moment
    })
    const data = await r.json()
    return NextResponse.json(data, { status: r.status })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'feed unreachable' }, { status: 502 })
  }
}
