// @ts-nocheck
import { db } from '../db'
import { getAdapter, type LegContext, type SymbolMapInfo } from '../../../brokers/index'
import { setCash, logBroker } from '../../../brokers/database'
import { decryptJson } from '../crypto'
import { round2 } from '../charges'
import { cached } from './fast-cache'

// ============================================================
// Live funds sync — pulls each live broker account's REAL available
// cash (broker funds API) into the local funds mirror so capital
// sizing (% of available cash) and the UI always reflect the actual
// balance. Round-10: "Initial Capital for live brokers pulls from
// funds" — the % base is the broker's own number, not a seeded one.
//
//  · ensureFundsSync() — 45s loop over active live accounts
//  · syncAccountFunds(id) — one-shot pull (used by /api/funds/sync,
//    the admin/fund chips, and right after a session is created)
// Every call is tagged ([BROKER][funds]) and mirrored to broker_logs.
//
// SPEED (round-14): repeated funds pulls (chips, sizing, diagnostics)
// share ONE broker round-trip per 15s window; explicit user pulls
// (POST /api/funds with force) bypass the cache.
// ============================================================

const g = globalThis as unknown as { __fundsSyncTimer?: ReturnType<typeof setInterval>; __fundsSyncBusy?: boolean }
const FUNDS_TTL_MS = 15_000

export function ensureFundsSync(): void {
  if (g.__fundsSyncTimer) return
  g.__fundsSyncTimer = setInterval(() => { void syncAll() }, 45_000)
  console.log('[funds-sync] started (45s live funds loop)')
}

/** Minimal execution context — funds APIs only read credentials. */
function ctxFor(accountId: string, label: string, brokerType: string, creds: Record<string, string> | null): LegContext {
  return {
    accountId,
    accountLabel: label,
    brokerType: brokerType as never,
    credentials: creds,
    order: { side: 'BUY', qty: 0, orderType: 'MARKET', productType: 'MIS', masterOrderId: '', source: 'SYSTEM' },
    symbolMap: { masterSymbol: '', exchange: '', instrumentType: '', lotSize: 1, brokerSymbol: '' } as SymbolMapInfo,
    ltp: 0,
  }
}

export async function syncAccountFunds(accountId: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean; cash?: number; message: string }> {
  if (!opts.force) {
    return cached(`funds:${accountId}`, FUNDS_TTL_MS, () => pullAccountFunds(accountId))
  }
  return pullAccountFunds(accountId)
}

async function pullAccountFunds(accountId: string): Promise<{ ok: boolean; cash?: number; message: string }> {
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return { ok: false, message: 'account not found' }
  const adapter = getAdapter(acc.brokerType as never)
  if (!adapter?.getFunds) return { ok: false, message: `${acc.brokerType} has no funds API (sim account)` }
  const creds = decryptJson(acc.credentialsEnc)
  if (!creds) return { ok: false, message: 'no broker credentials — sandbox account' }
  const hasSession = !!(creds.sessionToken || creds.accessToken || creds.sessionId)
  if (!hasSession) return { ok: false, message: 'broker session missing — create it in Admin → Session first' }
  try {
    const funds = await adapter.getFunds(ctxFor(acc.id, acc.label, acc.brokerType, creds))
    if (funds?.error) {
      // broker answered with an error (bad endpoint / expired session / empty book)
      logBroker(acc.brokerType, acc.id, `funds sync FAILED — ${funds.error}`, 'WARN')
      return { ok: false, message: funds.error }
    }
    if (!funds || !Number.isFinite(funds.cash)) {
      return { ok: false, message: 'funds call returned no cash (check Broker Diagnostics)' }
    }
    setCash(acc.brokerType, acc.id, round2(funds.cash))
    logBroker(acc.brokerType, acc.id, `funds sync — available ₹${round2(funds.cash)}`)
    return { ok: true, cash: round2(funds.cash), message: `Available cash ₹${round2(funds.cash).toLocaleString('en-IN')}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logBroker(acc.brokerType, acc.id, `funds sync FAILED — ${msg}`, 'WARN')
    return { ok: false, message: msg }
  }
}

async function syncAll(): Promise<void> {
  if (g.__fundsSyncBusy) return
  g.__fundsSyncBusy = true
  try {
    const accounts = await db.brokerAccount.findMany({
      where: { isActive: true, status: 'ACTIVE' },
      select: { id: true },
      orderBy: { sortOrder: 'asc' },
    })
    for (const a of accounts) {
      // syncAccountFunds validates live-ness itself and is a no-op for sims
      await syncAccountFunds(a.id)
    }
  } catch (e) {
    console.error('[funds-sync] loop error:', e)
  } finally {
    g.__fundsSyncBusy = false
  }
}
