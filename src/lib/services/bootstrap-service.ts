// @ts-nocheck
import { db } from '../db'
import { hashPassword, verifyPassword, hmacToken } from '../crypto'
import { syncMasterContracts } from './symbol-service'
import { ensureStrategyScheduler } from './strategy-engine'
import { isMissingSchemaError, ensureDbSchema } from '../db-setup'

// ============================================================
// Bootstrap: admin user, demo broker accounts (all 4 brokers),
// capital sizing configs, copy trading defaults, master contracts.
// Runs once at server start (instrumentation.ts) and lazily from
// every API route as a fallback.
// ============================================================

const g = globalThis as unknown as { __bootstrapped: boolean; __schemaHealed: boolean }
let bootPromise: Promise<void> | null = null

export function bootstrap(): Promise<void> {
  // strategy scheduler must always be running (1s tick)
  ensureStrategyScheduler()
  if (g.__bootstrapped) return Promise.resolve()
  // single-flight — concurrent API routes share one bootstrap run
  if (!bootPromise) {
    bootPromise = bootstrapInner()
      .then(() => { g.__bootstrapped = true })
      .catch(async e => {
        bootPromise = null
        // fresh clone self-heal: tables missing → push the schema once, retry
        if (!g.__schemaHealed && isMissingSchemaError(e)) {
          g.__schemaHealed = true
          console.warn('[bootstrap] database schema missing — running prisma db push (self-heal)…')
          await ensureDbSchema()
          return bootstrap()
        }
        throw e
      })
  }
  return bootPromise
}

async function bootstrapInner() {

  // 1. admin
  const admin = await db.adminUser.findFirst()
  if (!admin) {
    await db.adminUser.create({
      data: { username: 'admin', passwordHash: hashPassword('admin123') },
    })
    console.log('[bootstrap] admin user created (admin / admin123)')
  }

  // 2. copy trade config
  const ct = await db.copyTradeConfig.findFirst()
  if (!ct) {
    await db.copyTradeConfig.create({ data: { enabled: true, capitalSharePct: 100, slippagePct: 0.05 } })
  }

  // 3. demo broker accounts across all 4 brokers
  const count = await db.brokerAccount.count()
  if (count === 0) {
    const demo = [
      { label: 'SIM Master (Feed + Orders)', brokerType: 'SIMFEED', clientId: 'SIM001', isLiveDataSource: true, isOrderEnabled: true, isCopyMaster: true, sortOrder: 0, capital: 1000000, mode: 'INITIAL_PLUS_PNL' },
      { label: 'SIM Trader 2 — House Concept', brokerType: 'SIMFEED', clientId: 'SIM002', isOrderEnabled: true, sortOrder: 1, capital: 500000, mode: 'PROFIT_ONLY' },
      { label: 'SIM Trader 3 — Loss Reducing', brokerType: 'SIMFEED', clientId: 'SIM003', isOrderEnabled: true, sortOrder: 2, capital: 200000, mode: 'INITIAL_WITH_LOSS_REDUCTION' },
      { label: 'Dhan Sandbox', brokerType: 'DHAN', clientId: 'DHAN001', isOrderEnabled: false, sortOrder: 3, capital: 300000, mode: 'INITIAL_PLUS_PNL' },
      { label: 'Shoonya Sandbox', brokerType: 'SHOONYA', clientId: 'FA12345', isOrderEnabled: false, sortOrder: 4, capital: 300000, mode: 'INITIAL_PLUS_PNL' },
      { label: 'ICICI Breeze Sandbox', brokerType: 'ICICI_BREEZE', clientId: 'ICICI001', isOrderEnabled: false, sortOrder: 5, capital: 500000, mode: 'INITIAL_PLUS_PNL' },
    ]
    for (const d of demo) {
      const acc = await db.brokerAccount.create({
        data: {
          label: d.label, brokerType: d.brokerType, clientId: d.clientId,
          isActive: true, status: 'ACTIVE',
          isLiveDataSource: d.isLiveDataSource ?? false,
          isOrderEnabled: d.isOrderEnabled ?? false,
          isCopyMaster: d.isCopyMaster ?? false,
          sortOrder: d.sortOrder,
        },
      })
      await db.capitalConfig.create({
        data: { accountId: acc.id, initialCapital: d.capital, mode: d.mode },
      })
    }
    console.log(`[bootstrap] ${demo.length} demo broker accounts created`)
  }

  // 4. master contracts if empty
  const symbols = await db.symbolMaster.count()
  if (symbols === 0) {
    try {
      const r = await syncMasterContracts('SEED')
      console.log(`[bootstrap] master contracts synced: ${r.symbolCount} symbols, ${r.mappedCount} mappings`)
    } catch (e) {
      g.__bootstrapped = false // retry on next call
      bootPromise = null
      console.error('[bootstrap] master sync failed:', e)
    }
  }
}

// ---------- session helpers ----------
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7 // 7 days

export function createSessionToken(username: string): string {
  const exp = Date.now() + SESSION_TTL
  const payload = `${username}:${exp}`
  return `${Buffer.from(payload).toString('base64url')}.${hmacToken(payload)}`
}

export function verifySessionToken(token: string | undefined | null): string | null {
  if (!token) return null
  const [b64, sig] = token.split('.')
  if (!b64 || !sig) return null
  const payload = Buffer.from(b64, 'base64url').toString()
  if (hmacToken(payload) !== sig) return null
  const [username, expStr] = payload.split(':')
  if (Number(expStr) < Date.now()) return null
  return username
}

export async function login(username: string, password: string): Promise<boolean> {
  await bootstrap()
  const admin = await db.adminUser.findUnique({ where: { username } })
  if (!admin) return false
  return verifyPassword(password, admin.passwordHash)
}
