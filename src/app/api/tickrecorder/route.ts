// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
export const dynamic = 'force-dynamic'

// Tick-recorder control (session live-feed backup):
// GET  -> { enabled, symbols, session, sessions[] }
// POST -> { enabled?, symbols? } — persisted by the feed service to db/ticks/tick-recorder.json
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    const [cfgRes, sesRes] = await Promise.all([
      fetch(`${FEED_URL}/tick-config`, { signal: AbortSignal.timeout(3000), cache: 'no-store' }),
      fetch(`${FEED_URL}/tick-sessions`, { signal: AbortSignal.timeout(3000), cache: 'no-store' }),
    ])
    const cfg = await cfgRes.json()
    const ses = await sesRes.json()
    return NextResponse.json({ ...cfg, sessions: ses.sessions ?? [], current: ses.current ?? null })
  } catch (e) {
    return NextResponse.json({ error: `feed unavailable: ${e instanceof Error ? e.message : ''}` }, { status: 502 })
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => null)
  try {
    const res = await fetch(`${FEED_URL}/tick-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (e) {
    return NextResponse.json({ error: `feed unavailable: ${e instanceof Error ? e.message : ''}` }, { status: 502 })
  }
}
