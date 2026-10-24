import { NextRequest, NextResponse } from 'next/server'
import { verifySessionToken } from './services/bootstrap-service'

export const SESSION_COOKIE = 'zterm_session'

export function currentUser(req: NextRequest): string | null {
  return verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)
}

export function requireAuth(req: NextRequest): NextResponse | null {
  const user = currentUser(req)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized — login as admin' }, { status: 401 })
  }
  return null
}
