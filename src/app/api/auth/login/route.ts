// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { bootstrap, createSessionToken, login } from '@/lib/services/bootstrap-service'
import { SESSION_COOKIE } from '@/lib/api-auth'
import { isMissingSchemaError, isPrismaClientNotGenerated, ensureDbSchema } from '@/lib/db-setup'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function ok(username: string, isHttps: boolean) {
  const token = createSessionToken(username)
  const res = NextResponse.json({ ok: true, username })
  // Secure only when actually served over HTTPS (preview/gateway is HTTPS;
  // direct http://localhost access must still receive the cookie).
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
  return res
}

function isHttpsReq(req: NextRequest): boolean {
  return (
    req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https' ||
    new URL(req.url).protocol === 'https:'
  )
}

export async function POST(req: NextRequest) {
  let username = ''
  let password = ''
  try {
    await bootstrap()
    const body = await req.json().catch(() => ({ username: '', password: '' }))
    username = String(body.username || '')
    password = String(body.password || '')
    const okr = await login(username, password)
    if (!okr) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }
    return ok(username, isHttpsReq(req))
  } catch (e) {
    console.error('[auth/login] error:', e)
    // ---- self-heal: a fresh clone often just lacks the DB schema ----
    if (isMissingSchemaError(e) || isPrismaClientNotGenerated(e)) {
      try {
        await ensureDbSchema()
        const okr = await login(username, password)
        if (okr) return ok(username, isHttpsReq(req))
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
      } catch (e2) {
        console.error('[auth/login] self-heal retry failed:', e2)
      }
    }
    // ---- actionable message instead of a bare 503 ----
    const msg = e instanceof Error ? e.message : String(e)
    let error = 'Login temporarily unavailable — try again'
    if (isPrismaClientNotGenerated(e)) {
      error = 'Database client not generated — run: npm run setup (or ./start.sh)'
    } else if (/DATABASE_URL|Can't reach database|ENOENT/i.test(msg)) {
      error = 'Database not configured — copy .env.example to .env, then run: npm run setup (or ./start.sh)'
    } else if (isMissingSchemaError(e)) {
      error = 'Database schema missing — run: npm run setup (or ./start.sh)'
    }
    return NextResponse.json({ error }, { status: 503 })
  }
}
