// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'

// ============================================================
// Live broker feed status proxy — surfaces the market-feed
// service's /feed-status (active source, ticking state, last
// error, recent log lines) for the FEED chip + diagnostics UI.
// ============================================================

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
  try {
    const res = await fetch(`${FEED_URL}/feed-status`, { signal: AbortSignal.timeout(1500), cache: 'no-store' })
    if (res.ok) return NextResponse.json(await res.json())
    return NextResponse.json({ error: `feed service ${res.status}` }, { status: 502 })
  } catch {
    return NextResponse.json({ error: 'feed service unreachable' }, { status: 503 })
  }
}
