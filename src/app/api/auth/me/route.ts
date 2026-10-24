// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@/lib/api-auth'
import { bootstrap } from '@/lib/services/bootstrap-service'
import { feedHealth } from '@brokers/feed-client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    await bootstrap()
    const user = currentUser(req)
    const feed = await feedHealth()
    return NextResponse.json({ user, feed: feed ? 'UP' : 'DOWN' })
  } catch (e) {
    console.error('[auth/me] error:', e)
    return NextResponse.json({ user: null, feed: 'DOWN' })
  }
}
