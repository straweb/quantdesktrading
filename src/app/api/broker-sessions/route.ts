// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { ensureSessionRestore, restoreSessionsOnce, sessionStatuses, validateSession } from '@/lib/services/session-restore'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ============================================================
// GET /api/broker-sessions
// Persisted broker-session status for the UI — proves sessions are
// stored in the backend (page refresh / server restart never asks to
// re-connect) and shows validity + auto-renew state per account:
//   { sessions: [{ accountId, brokerType, label, hasSession,
//      connected, validatedAt, expiresAt, autoRenew, renewing,
//      lastAction, error }] }
// ============================================================

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  ensureSessionRestore()
  const current = sessionStatuses()
  // first call after a boot has nothing yet — run one pass inline
  if (current.length === 0) {
    await restoreSessionsOnce()
    return NextResponse.json({ sessions: sessionStatuses() })
  }
  return NextResponse.json({ sessions: current })
}

// POST /api/broker-sessions { accountId? } — force-validate (one or all) now
export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => ({}))
  const accountId: string | undefined = body?.accountId
  if (!accountId) {
    await restoreSessionsOnce(true)
    return NextResponse.json({ ok: true, sessions: sessionStatuses() })
  }
  const one = await validateSession(accountId, true)
  return NextResponse.json({ ok: true, session: one })
}
