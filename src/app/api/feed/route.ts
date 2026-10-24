// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { decryptJson } from '@/lib/crypto'

// ============================================================
// Active feed source API + global Live-Only switch.
// GET  -> { source, simDisabled, sources: [sim + every account] }
// POST { source?, simDisabled? }
//   · source — switch the radio (sim or a broker account id)
//   · simDisabled — admin "Live-Only" checkbox: stops the sim
//     random-walk AND refuses sandbox fills (adapters reject).
// Live-Only enforcement (round 13): a session-less (sandbox) account is
// NEVER allowed as the data source — POST refuses it, and enabling
// Live-Only while a sandbox account is selected auto-steers the source
// to the first account that actually has a broker session.
// The selected id + flag persist in the shared JSON file (the feed
// engine owns the same keys), mirrored onto BrokerAccount.
// ============================================================

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
const FEED_SRC_FILE = path.join(process.cwd(), 'db', 'feed-source.json')

interface FeedSrcFile { source?: string; simDisabled?: boolean; updatedAt?: string }

/** session present in the encrypted credentials? (live vs sandbox account) */
function hasSessionIn(credsEnc: string | null | undefined): boolean {
  const c = decryptJson<{ sessionToken?: string; accessToken?: string; sessionId?: string }>(credsEnc ?? null)
  return !!(c?.sessionToken || c?.accessToken || c?.sessionId)
}

async function readSourceFile(): Promise<FeedSrcFile> {
  try {
    return JSON.parse(await readFile(FEED_SRC_FILE, 'utf8')) as FeedSrcFile
  } catch {
    return {}
  }
}

/** read-modify-write so source + simDisabled never clobber each other */
async function writeSourceFile(patch: { source?: string; simDisabled?: boolean }) {
  try {
    const prev = await readSourceFile()
    await mkdir(path.dirname(FEED_SRC_FILE), { recursive: true })
    await writeFile(FEED_SRC_FILE, JSON.stringify({
      ...prev,
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.simDisabled !== undefined ? { simDisabled: patch.simDisabled } : {}),
      updatedAt: new Date().toISOString(),
    }, null, 2))
  } catch { /* mini-service remains the source of truth */ }
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    let source = 'sim'
    let simDisabled = false
    try {
      const r = await fetch(`${FEED_URL}/feed-source`, { signal: AbortSignal.timeout(1200), cache: 'no-store' })
      if (r.ok) {
        const j = (await r.json()) as { source?: string; simDisabled?: boolean }
        source = j.source ?? 'sim'
        simDisabled = j.simDisabled === true
      }
    } catch {
      const f = await readSourceFile()
      source = f.source ?? 'sim'
      simDisabled = f.simDisabled === true
    }
    const accounts = await db.brokerAccount.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { id: true, label: true, brokerType: true, isActive: true, credentialsEnc: true },
    })
    return NextResponse.json({
      source,
      simDisabled,
      sources: [
        { id: 'sim', label: 'Sim Feed (built-in)', brokerType: null, isActive: true, hasSession: false },
        // every account is listed (disconnected ones too) so the dropdown
        // can reconnect them — POST still refuses inactive sources and
        // session-less (sandbox) sources while Live-Only is on
        ...accounts.map(a => ({ id: a.id, label: a.label, brokerType: a.brokerType as string, isActive: a.isActive, hasSession: hasSessionIn(a.credentialsEnc) })),
      ],
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'feed source unavailable' }, { status: 503 })
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    const body = (await req.json()) as { source?: string; simDisabled?: boolean }
    const { source, simDisabled } = body
    if (source === undefined && typeof simDisabled !== 'boolean') {
      return NextResponse.json({ error: 'source or simDisabled required' }, { status: 400 })
    }

    // resolve the effective Live-Only flag (request value wins; else current)
    let liveOnly = typeof simDisabled === 'boolean' ? simDisabled : false
    if (simDisabled === undefined) {
      try {
        const r = await fetch(`${FEED_URL}/feed-source`, { signal: AbortSignal.timeout(1000), cache: 'no-store' })
        if (r.ok) liveOnly = ((await r.json()) as { simDisabled?: boolean }).simDisabled === true
      } catch {
        liveOnly = (await readSourceFile()).simDisabled === true
      }
    }

    // the source this request leaves active (request value, else current)
    let effectiveSource = source
    if (effectiveSource === undefined) {
      try {
        const r = await fetch(`${FEED_URL}/feed-source`, { signal: AbortSignal.timeout(1000), cache: 'no-store' })
        effectiveSource = ((await r.json()) as { source?: string }).source ?? 'sim'
      } catch {
        effectiveSource = (await readSourceFile()).source ?? 'sim'
      }
    }

    // LIVE-ONLY STEERING: the active source must be an account with a real
    // broker session. A sandbox account (no session — the round-13 bug where
    // "LIVE ONLY" kept polling a dead ICICI sandbox) is refused or replaced.
    let steeredTo: string | null = null
    if (liveOnly && effectiveSource && effectiveSource !== 'sim') {
      const acc = await db.brokerAccount.findUnique({
        where: { id: effectiveSource },
        select: { id: true, isActive: true, brokerType: true, credentialsEnc: true },
      })
      if (!acc || !acc.isActive) {
        return NextResponse.json({ error: 'Unknown or inactive account' }, { status: 400 })
      }
      if (!hasSessionIn(acc.credentialsEnc)) {
        // auto-steer to the first ACTIVE account WITH a session (same broker
        // type preferred — the user intent was "this broker, live account")
        const candidates = await db.brokerAccount.findMany({
          where: { isActive: true, status: 'ACTIVE' },
          select: { id: true, brokerType: true, credentialsEnc: true },
          orderBy: { sortOrder: 'asc' },
        })
        const pick =
          candidates.find(c => c.brokerType === acc.brokerType && hasSessionIn(c.credentialsEnc)) ??
          candidates.find(c => hasSessionIn(c.credentialsEnc))
        if (pick) {
          steeredTo = pick.id
          effectiveSource = pick.id
        } else {
          return NextResponse.json({
            error: `Live-Only mode: "${acc.brokerType}" account has no broker session and no other account has one — create a session in Admin → Session first`,
          }, { status: 400 })
        }
      }
    }
    // explicit source request under Live-Only: session-less accounts refused
    if (liveOnly && source && source !== 'sim' && source !== steeredTo) {
      const acc = await db.brokerAccount.findUnique({
        where: { id: source },
        select: { isActive: true, credentialsEnc: true },
      })
      if (!acc || !acc.isActive) return NextResponse.json({ error: 'Unknown or inactive account' }, { status: 400 })
      if (!hasSessionIn(acc.credentialsEnc)) {
        return NextResponse.json({
          error: 'Live-Only mode: this account has no broker session (sandbox) — create one in Admin → Session, or turn Live-Only off',
        }, { status: 400 })
      }
    }

    if (steeredTo || source) {
      const finalSource = steeredTo ?? source
      if (finalSource) {
        // mirror the radio state onto accounts (exactly one live data source)
        await db.brokerAccount.updateMany({ data: { isLiveDataSource: false } })
        if (finalSource !== 'sim') {
          await db.brokerAccount.update({ where: { id: finalSource }, data: { isLiveDataSource: true } })
        }
      }
    }

    // forward to the feed engine (it also purges sim data on source change);
    // fall back to the shared file if the service is down
    const forward: Record<string, unknown> = {}
    if (typeof simDisabled === 'boolean') forward.simDisabled = simDisabled
    if (steeredTo || source !== undefined) forward.source = steeredTo ?? source
    let ok = false
    try {
      const r = await fetch(`${FEED_URL}/feed-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forward),
        signal: AbortSignal.timeout(1200),
        cache: 'no-store',
      })
      ok = r.ok
    } catch { ok = false }
    if (!ok) await writeSourceFile(forward as { source?: string; simDisabled?: boolean })
    return NextResponse.json({
      ok: true,
      ...(forward.source !== undefined ? { source: forward.source } : {}),
      ...(typeof simDisabled === 'boolean' ? { simDisabled } : {}),
      ...(steeredTo ? { steeredTo, message: 'Live-Only: the previous source had no broker session — switched to a live account' } : {}),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Switch failed' }, { status: 503 })
  }
}
