// @ts-nocheck
import { db } from '../db'
import { encryptJson } from '../crypto'
import { getAdapter } from '../../../brokers/index'
import {
  authComplete, isAutoRenewable, renewSession,
  type AuthCompleteResult,
} from '../../../brokers/auth'
import type { LegContext, SymbolMapInfo } from '../../../brokers/index'
import { logBroker } from '../../../brokers/database'

// ============================================================
// BROKER SESSION PERSISTENCE + AUTO-RESTORE
//
// Sessions are stored ENCRYPTED in the master DB (BrokerAccount
// .credentialsEnc) the moment they are created — nothing lives only
// in the browser, so a page refresh or a backend restart never asks
// the user to re-connect: every read path (feed engine, funds sync,
// adapters) re-loads the token straight from the DB.
//
// This service adds the remaining pieces:
//   · VALIDATION — lightweight broker probe (funds API) per account,
//     throttled (min 5 min per account) so the UI can show
//     CONNECTED vs EXPIRED honestly instead of guessing.
//   · AUTO-RENEW — brokers whose login can be replayed without user
//     input (Shoonya QuickAuth credentials are stored encrypted) get
//     their daily session re-created automatically at expiry/reject.
//   · EXPIRY METADATA — sessionCreatedAt/sessionExpiresAt are stamped
//     into the credential bag at creation time (see stampSessionMeta)
//     and surfaced via /api/broker-sessions.
//   · BOOT RESTORE — ensureSessionRestore() runs at instrumentation
//     time and every 60s, so the terminal comes back up connected.
// ============================================================

const g = globalThis as unknown as {
  __sessionRestore?: {
    timer?: ReturnType<typeof setInterval>
    /** in-flight restore pass — concurrent callers share the same promise */
    inFlight: Promise<SessionStatus[]> | null
    /** accountId → last validation attempt ts (throttle) */
    lastValidated: Map<string, number>
    /** accountId → live status snapshot */
    status: Map<string, SessionStatus>
  }
}

export interface SessionStatus {
  accountId: string
  brokerType: string
  label: string
  hasSession: boolean
  /** last validation outcome: true = broker accepted the token */
  connected: boolean | null // null = not validated yet
  validatedAt: number | null
  expiresAt: string | null
  autoRenew: boolean
  renewing: boolean
  lastAction: string | null
  error: string | null
}

function sr(): NonNullable<typeof g.__sessionRestore> {
  if (!g.__sessionRestore) {
    g.__sessionRestore = { inFlight: null, lastValidated: new Map(), status: new Map() }
  }
  return g.__sessionRestore
}

const VALIDATE_MIN_INTERVAL_MS = 5 * 60_000
const LIVE_BROKERS = ['ICICI_BREEZE', 'DHAN', 'SHOONYA']

function credsHasSession(creds: Record<string, string> | null | undefined): boolean {
  return !!(creds?.sessionToken || creds?.accessToken || creds?.sessionId)
}

/** stamp creation/expiry metadata into the credential bag (encrypted at rest) */
export function stampSessionMeta(
  creds: Record<string, string>,
  opts: { sessionKind?: string; sessionExpiresAt?: string },
): Record<string, string> {
  return {
    ...creds,
    sessionCreatedAt: new Date().toISOString(),
    sessionKind: opts.sessionKind ?? creds.sessionKind ?? 'daily',
    sessionExpiresAt: opts.sessionExpiresAt ?? creds.sessionExpiresAt ?? '',
  }
}

function statusFromAccount(
  a: { id: string; brokerType: string; label: string },
  creds: Record<string, string> | null,
  prev: SessionStatus | undefined,
): SessionStatus {
  const has = credsHasSession(creds)
  return {
    accountId: a.id,
    brokerType: a.brokerType,
    label: a.label,
    hasSession: has,
    connected: has ? (prev?.connected ?? null) : false,
    validatedAt: has ? (prev?.validatedAt ?? null) : null,
    expiresAt: creds?.sessionExpiresAt || null,
    autoRenew: isAutoRenewable(a.brokerType, creds),
    renewing: false,
    lastAction: prev?.lastAction ?? null,
    error: null,
  }
}

/** minimal LegContext — funds APIs only read credentials */
function probeCtx(accountId: string, label: string, brokerType: string, creds: Record<string, string>): LegContext {
  return {
    accountId,
    accountLabel: label,
    brokerType: brokerType as never,
    credentials: creds,
    order: { side: 'BUY', qty: 0, orderType: 'MARKET', productType: 'MIS', masterOrderId: '', source: 'SESSION_RESTORE' },
    symbolMap: { masterSymbol: '', exchange: '', instrumentType: '', lotSize: 1, brokerSymbol: '' } as SymbolMapInfo,
    ltp: 0,
  }
}

/** persist fresh session credentials + metadata to the master DB */
async function saveSession(accountId: string, creds: Record<string, string>, r: AuthCompleteResult): Promise<void> {
  const merged = stampSessionMeta(creds, { sessionKind: r.sessionKind, sessionExpiresAt: r.sessionExpiresAt })
  await db.brokerAccount.update({
    where: { id: accountId },
    data: { credentialsEnc: encryptJson(merged) },
  })
}

/**
 * Auto-renew: re-run the broker's own login flow from STORED credentials
 * (Shoonya QuickAuth today) and persist the fresh token. Returns null when
 * the broker is not auto-renewable.
 */
async function tryAutoRenew(
  a: { id: string; brokerType: string; label: string },
  creds: Record<string, string>,
): Promise<boolean> {
  if (!isAutoRenewable(a.brokerType, creds)) return false
  const st0 = sr().status.get(a.id)
  if (st0) st0.renewing = true
  logBroker(a.brokerType, a.id, 'session restore — auto-renew started (stored QuickAuth credentials)')
  try {
    const r = await renewSession(a.brokerType, a.id, creds)
    if (r?.ok && r.credentials) {
      await saveSession(a.id, r.credentials, r)
      const st1 = sr().status.get(a.id)
      if (st1) {
        st1.hasSession = true
        st1.expiresAt = r.sessionExpiresAt ?? null
        st1.connected = true
        st1.validatedAt = Date.now()
        st1.lastAction = 'auto-renewed'
        st1.error = null
        st1.renewing = false
      }
      sr().lastValidated.set(a.id, Date.now())
      logBroker(a.brokerType, a.id, `session restore — auto-renew OK (${r.message})`)
      return true
    }
    const st2 = sr().status.get(a.id)
    if (st2) { st2.renewing = false; st2.error = r?.message ?? 'auto-renew failed'; st2.lastAction = 'auto-renew failed' }
    logBroker(a.brokerType, a.id, `session restore — auto-renew FAILED — ${r?.message ?? 'no result'}`, 'WARN')
    return false
  } catch (e) {
    const st3 = sr().status.get(a.id)
    if (st3) { st3.renewing = false; st3.error = e instanceof Error ? e.message : String(e) }
    logBroker(a.brokerType, a.id, `session restore — auto-renew error — ${e instanceof Error ? e.message : String(e)}`, 'WARN')
    return false
  }
}

/**
 * Probe one account's session with the broker's lightest read API
 * (funds). Throttled to once per VALIDATE_MIN_INTERVAL_MS unless forced.
 */
export async function validateSession(accountId: string, force = false): Promise<SessionStatus | null> {
  const s = sr()
  const last = s.lastValidated.get(accountId) ?? 0
  if (!force && Date.now() - last < VALIDATE_MIN_INTERVAL_MS) return s.status.get(accountId) ?? null
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return null
  if (!LIVE_BROKERS.includes(acc.brokerType)) return s.status.get(accountId) ?? null
  const { decryptJson } = await import('../crypto')
  const creds = decryptJson<Record<string, string>>(acc.credentialsEnc)
  let st0 = s.status.get(accountId)
  if (!st0 || st0.brokerType !== acc.brokerType) {
    st0 = statusFromAccount(acc, creds, st0)
    s.status.set(accountId, st0)
  }
  if (!creds || !credsHasSession(creds)) {
    // expired/no token — try auto-renew first (Shoonya QuickAuth)
    if (creds) await tryAutoRenew(acc, creds)
    s.lastValidated.set(accountId, Date.now())
    return s.status.get(accountId) ?? null
  }
  const adapter = getAdapter(acc.brokerType as never)
  if (!adapter?.getFunds) { s.lastValidated.set(accountId, Date.now()); return st0 }
  try {
    const funds = await Promise.race([
      adapter.getFunds(probeCtx(acc.id, acc.label, acc.brokerType, creds)),
      new Promise<{ error: string }>(r => setTimeout(() => r({ error: 'validation timeout' }), 8000)),
    ])
    if (funds?.error && /unauthorized|invalid user|session|auth|token|jkey/i.test(funds.error)) {
      // token REJECTED — expire the status; auto-renew if the broker allows it
      st0.connected = false
      st0.error = funds.error
      st0.validatedAt = Date.now()
      st0.lastAction = 'broker rejected the session'
      logBroker(acc.brokerType, acc.id, `session validation FAILED — ${funds.error}`, 'WARN')
      if (creds) await tryAutoRenew(acc, creds)
    } else if (funds?.error) {
      // broker-side/transport error — do NOT mark the session dead
      st0.connected = st0.connected ?? null
      st0.error = `validation probe: ${funds.error}`
      st0.validatedAt = Date.now()
    } else {
      st0.connected = true
      st0.validatedAt = Date.now()
      st0.error = null
      st0.lastAction = 'validated with the broker'
    }
  } catch (e) {
    st0.error = `validation probe: ${e instanceof Error ? e.message : String(e)}`
    st0.validatedAt = Date.now()
  }
  s.lastValidated.set(accountId, Date.now())
  return st0
}

/** one restore pass over every active live account (concurrent callers share the pass) */
export function restoreSessionsOnce(force = false): Promise<SessionStatus[]> {
  const s = sr()
  if (s.inFlight && !force) return s.inFlight
  s.inFlight = runRestorePass(force).finally(() => { s.inFlight = null })
  return s.inFlight
}

async function runRestorePass(force: boolean): Promise<SessionStatus[]> {
  const s = sr()
  try {
    const accounts = await db.brokerAccount.findMany({
      where: { isActive: true, status: 'ACTIVE', brokerType: { in: LIVE_BROKERS } },
      select: { id: true, brokerType: true, label: true },
      orderBy: { sortOrder: 'asc' },
    })
    const { decryptJson } = await import('../crypto')
    for (const a of accounts) {
      const creds = decryptJson<Record<string, string>>(
        (await db.brokerAccount.findUnique({ where: { id: a.id }, select: { credentialsEnc: true } }))?.credentialsEnc ?? null,
      )
      const prev = s.status.get(a.id)
      const st0 = statusFromAccount(a, creds, prev)
      s.status.set(a.id, st0)
      // expired by metadata (daily tokens) → drop connected until revalidated
      if (creds && creds.sessionExpiresAt && new Date(creds.sessionExpiresAt).getTime() < Date.now() - 3600_000) {
        st0.connected = false
        st0.lastAction = 'session past its expiry — renewing/awaiting re-creation'
        // auto-renewable brokers re-login here without any user action
        await tryAutoRenew(a, creds)
      }
      await validateSession(a.id, force)
    }
    return [...s.status.values()]
  } catch (e) {
    console.error('[session-restore] pass failed:', e)
    return [...s.status.values()]
  }
}

/** boot-time + periodic restore loop (called from instrumentation) */
export function ensureSessionRestore(): void {
  const s = sr()
  if (s.timer) return
  console.log('[session-restore] started (60s broker-session keepalive loop)')
  s.timer = setInterval(() => { void restoreSessionsOnce() }, 60_000)
  void restoreSessionsOnce()
}

/** current status map for /api/broker-sessions */
export function sessionStatuses(): SessionStatus[] {
  return [...sr().status.values()]
}
