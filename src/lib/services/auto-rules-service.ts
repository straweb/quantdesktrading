// @ts-nocheck
import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { newId } from '../../../brokers/registry'
import { fetchQuotes } from '../../../brokers/feed-client'
import { placeMasterOrder, cancelAllOrders } from './order-router'
import { getChainMeta, ensureOptionContracts } from './option-service'
import { logBroker } from '../../../brokers/database'

// ============================================================
// Auto-rules engine v3 — the "auto bot".
//
// COMPOUND CONDITIONS (all optional, at least one required — the
// rule fires when EVERY enabled condition is true at the same
// 250ms engine tick):
//  · time      — at HH:MM:SS IST (seconds precision). When combined
//                with other conditions the rule WAITS inside a grace
//                window (default 5 min) until they align, instead of
//                firing blind at the second.
//  · index     — spot inside [lo, hi] ("at time, if index price is
//                in range").
//  · premium   — the OPTION's own price (delta/gamma move the
//                premium even when the index barely moves):
//                entryOp LTE (≤ x) | GTE (≥ x) | RANGE (lo–hi).
//                Applied PER STRIKE for deploy/buy lists — only
//                strikes whose live premium satisfies it are traded.
//
// Legacy single-condition kinds keep working:
//  · INDEX (cross ABOVE/BELOW a level, edge-triggered)
//  · INDEX_RANGE (band entry, edge-triggered)
//  · TIME (fires within 2s of the second when no other conditions)
//
// Actions: BUY / SELL (single strike, MARKET or LIMIT) · DEPLOY
// (buy the side's strike list) · CANCEL (cancel pending side orders).
// Optional order legs (any subset): entryPrice (LIMIT), stopLoss
// (reduce-only SL-M), target (reduce-only LIMIT) — armed post-fill.
// Strike selection: rule.strikes [{strike,type,allocPct}] or side-ATM
// + offset. Storage: db/auto-rules.json. Runs server-side (250ms).
// ============================================================

export type AutoRuleKind = 'INDEX' | 'INDEX_RANGE' | 'TIME' | 'COMPOUND'
export type AutoRuleAction = 'BUY' | 'SELL' | 'DEPLOY' | 'CANCEL'
export type EntryOp = 'LTE' | 'GTE' | 'RANGE'

export interface AutoStrike { strike: number; type: 'CE' | 'PE'; allocPct: number }

export interface AutoRule {
  id: string
  name: string
  underlying: string
  expiry: string | null
  kind: AutoRuleKind
  // INDEX trigger (legacy cross)
  level?: number
  cross?: 'ABOVE' | 'BELOW'
  // index range condition (also INDEX_RANGE legacy)
  lo?: number
  hi?: number
  // TIME condition (HH:MM:SS IST)
  time?: string
  // action
  action: AutoRuleAction
  optType: 'CE' | 'PE'
  offset: number // steps from side ATM (0 = ATM) — used when strikes list empty
  strikes?: AutoStrike[] // user-selected strikes / strike set
  allocPct: number // % of each enabled account's usable capital
  // optional premium condition (the option's own price)
  entryOp?: EntryOp
  entryLo?: number
  entryHi?: number
  // grace window (seconds) — how long a time-condition rule keeps
  // waiting for the other conditions to align
  graceSec?: number
  // optional order legs (any subset)
  entryPrice?: number
  stopLoss?: number
  target?: number
  enabled: boolean
  repeatDaily: boolean
  lastFiredDate?: string
  lastFiredAt?: string
  lastStatus?: string
  lastMessage?: string
  fireCount: number
  createdAt: string
}

const RULES_FILE = path.join(process.cwd(), 'db', 'auto-rules.json')

async function readRules(): Promise<AutoRule[]> {
  try {
    const raw = await readFile(RULES_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { rules?: AutoRule[] }
    return Array.isArray(parsed.rules) ? parsed.rules : []
  } catch {
    return []
  }
}

async function writeRules(rules: AutoRule[]) {
  await mkdir(path.dirname(RULES_FILE), { recursive: true })
  await writeFile(RULES_FILE, JSON.stringify({ rules, updatedAt: new Date().toISOString() }, null, 2))
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n !== 0 ? n : undefined
}

function num0(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// ---- CRUD (used by the API routes) ----

export async function listRules(): Promise<AutoRule[]> {
  return readRules()
}

export async function createRule(input: Partial<AutoRule>): Promise<AutoRule> {
  const rules = await readRules()
  const timeStr = typeof input.time === 'string' ? input.time.trim() : ''
  const timeOk = /^\d{1,2}:\d{2}(:\d{2})?$/.test(timeStr)
    ? timeStr.split(':').map(p => p.padStart(2, '0')).join(':')
    : undefined
  const strikes: AutoStrike[] = Array.isArray(input.strikes)
    ? (input.strikes as AutoStrike[])
        .filter(s => Number.isFinite(Number(s.strike)) && (s.type === 'CE' || s.type === 'PE'))
        .slice(0, 24)
        .map(s => ({ strike: Math.round(Number(s.strike)), type: s.type, allocPct: Math.max(1, Math.min(100, Number(s.allocPct ?? input.allocPct ?? 100))) }))
    : []

  // derive the kind from which conditions are present
  const hasTime = !!timeOk
  const hasRange = num0(input.lo) != null && num0(input.hi) != null
  const hasCross = num(input.level) != null
  const hasPremium = num0(input.entryLo) != null || num0(input.entryHi) != null
  const condCount = (hasTime ? 1 : 0) + (hasRange ? 1 : 0) + (hasCross ? 1 : 0) + (hasPremium ? 1 : 0)
  const kind: AutoRuleKind =
    input.kind === 'INDEX' && input.kind !== undefined && !hasTime && !hasRange && !hasPremium
      ? 'INDEX'
      : condCount > 1 ? 'COMPOUND'
      : hasRange ? 'INDEX_RANGE'
      : hasCross ? 'INDEX'
      : 'TIME'

  const rule: AutoRule = {
    id: newId('AR-'),
    name: String(input.name || 'Untitled rule').slice(0, 80),
    underlying: String(input.underlying || ''),
    expiry: input.expiry ?? null,
    kind,
    level: num(input.level),
    cross: input.cross === 'BELOW' ? 'BELOW' : 'ABOVE',
    lo: num0(input.lo),
    hi: num0(input.hi),
    time: hasTime ? timeOk : undefined,
    action: input.action === 'SELL' ? 'SELL' : input.action === 'DEPLOY' ? 'DEPLOY' : input.action === 'CANCEL' ? 'CANCEL' : 'BUY',
    optType: input.optType === 'PE' ? 'PE' : 'CE',
    offset: Math.max(-9, Math.min(9, Math.round(Number(input.offset ?? 0)) || 0)),
    strikes,
    allocPct: Math.max(1, Math.min(100, Number(input.allocPct ?? 100))),
    entryOp: hasPremium
      ? (input.entryOp === 'LTE' || input.entryOp === 'GTE' ? input.entryOp : 'RANGE')
      : undefined,
    entryLo: num0(input.entryLo),
    entryHi: num0(input.entryHi),
    // only store an explicit grace window; compound rules default to 5 min
    // inside the engine (graceFor) — a bare time rule waits 2s
    graceSec: input.graceSec != null && Number(input.graceSec) > 0
      ? Math.max(2, Math.min(3600, Math.round(Number(input.graceSec))))
      : undefined,
    entryPrice: num(input.entryPrice),
    stopLoss: num(input.stopLoss),
    target: num(input.target),
    enabled: input.enabled !== false,
    repeatDaily: input.repeatDaily !== false,
    fireCount: 0,
    createdAt: new Date().toISOString(),
  }
  rules.push(rule)
  await writeRules(rules)
  return rule
}

export async function updateRule(id: string, patch: Partial<AutoRule>): Promise<AutoRule | null> {
  const rules = await readRules()
  const idx = rules.findIndex(r => r.id === id)
  if (idx === -1) return null
  const next = { ...rules[idx], ...patch, id: rules[idx].id }
  rules[idx] = next
  await writeRules(rules)
  return next
}

export async function deleteRule(id: string): Promise<boolean> {
  const rules = await readRules()
  const next = rules.filter(r => r.id !== id)
  if (next.length === rules.length) return false
  await writeRules(next)
  return true
}

// ---- engine ----

// Engine state lives on globalThis so Next.js dev hot-reloads can't stack
// duplicate intervals (module re-eval resets `let` state) and a single
// wedged tick can't stall the scheduler forever (timestamp busy guard).
const gEng = globalThis as unknown as {
  __autoRuleTimer?: ReturnType<typeof setInterval>
  __autoRuleBusyAt?: number
  __autoRuleBeat?: number
  __autoPrevSpot?: Map<string, number>
  __autoRulesCache?: { rules: AutoRule[]; ts: number }
  __autoFiredToday?: Map<string, string> // ruleId -> IST date (immediate dedupe)
  __autoWaiting?: Map<string, { since: number }> // ruleId -> wait start (grace window)
}

function istNow(): { date: string; secondsOfDay: number } {
  const d = new Date(Date.now() + 5.5 * 3600_000)
  const date = d.toISOString().slice(0, 10)
  const secondsOfDay = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
  return { date, secondsOfDay }
}

function timeToSeconds(t: string): number {
  const [hh = '0', mm = '0', ss = '0'] = t.split(':')
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss || 0)
}

async function loadRulesCached(): Promise<AutoRule[]> {
  const c = gEng.__autoRulesCache
  if (c && Date.now() - c.ts < 2000) return c.rules
  const rules = await readRules()
  gEng.__autoRulesCache = { rules, ts: Date.now() }
  return rules
}

function premiumOk(prem: number, rule: AutoRule): boolean {
  if (rule.entryOp === 'LTE' && rule.entryHi != null) return prem <= rule.entryHi
  if (rule.entryOp === 'GTE' && rule.entryLo != null) return prem >= rule.entryLo
  if (rule.entryOp === 'RANGE') {
    if (rule.entryLo != null && prem < rule.entryLo) return false
    if (rule.entryHi != null && prem > rule.entryHi) return false
    return rule.entryLo != null || rule.entryHi != null
  }
  return true // no premium condition
}

/** Resolve the contract symbol for a strike/type and place the order.
 *  Side/action semantics:
 *   BUY/SELL/DEPLOY -> entry order (DEPLOY is always BUY of the side list)
 *   CANCEL          -> pending orders of those symbols are cancelled.
 *  Premium condition (rule.entryOp) is applied PER STRIKE: only strikes
 *  whose live premium satisfies it are traded; if none pass, the rule
 *  stays armed (waiting) instead of burning its once-per-day guard. */
async function executeStrikes(rule: AutoRule, list: AutoStrike[]): Promise<{ ok: boolean; message: string; waiting?: boolean }> {
  if (list.length === 0) return { ok: false, message: 'no strikes to execute' }
  const meta = await getChainMeta(rule.underlying, rule.expiry)
  if (!meta) return { ok: false, message: `no option chain for ${rule.underlying}` }

  if (rule.action === 'CANCEL') {
    const symbols = list.map(s => `${rule.underlying}${meta.expiry.replaceAll('-', '')}${s.strike}${s.type}`)
    const cancelled = await cancelAllOrders(symbols)
    return { ok: cancelled > 0, message: `cancelled ${cancelled} pending order(s)` }
  }

  const side = rule.action === 'SELL' ? 'SELL' : 'BUY'

  // ---- premium condition: gate per strike on the live option price ----
  let candidates = list
  if (rule.entryOp) {
    const passing: AutoStrike[] = []
    const rejected: string[] = []
    for (const s of list) {
      try {
        await ensureOptionContracts(rule.underlying, s.strike, meta.expiry)
        const sym = `${rule.underlying}${meta.expiry.replaceAll('-', '')}${s.strike}${s.type}`
        const q = (await fetchQuotes([sym]))[sym]
        if (q && premiumOk(q.ltp, rule)) passing.push(s)
        else rejected.push(`${s.strike}${s.type}${q ? `@${q.ltp}` : ' (no quote)'}`)
      } catch {
        rejected.push(`${s.strike}${s.type} (quote error)`)
      }
    }
    if (passing.length === 0) {
      return { ok: false, waiting: true, message: `premium out of range — ${rejected.slice(0, 3).join(', ')}` }
    }
    candidates = passing
  }

  let fills = 0, legs = 0, fails = 0
  const filledSymbols: string[] = []
  for (const s of candidates) {
    try {
      await ensureOptionContracts(rule.underlying, s.strike, meta.expiry)
      const symbol = `${rule.underlying}${meta.expiry.replaceAll('-', '')}${s.strike}${s.type}`
      const res = await placeMasterOrder({
        symbol,
        exchange: 'NFO',
        side,
        qty: 0,
        orderType: rule.entryPrice ? 'LIMIT' : 'MARKET',
        productType: 'MIS',
        source: 'SYSTEM',
        capitalPct: s.allocPct ?? rule.allocPct,
        limitPrice: rule.entryPrice,
        strategyId: `auto:${rule.id}`,
      })
      const f = res.legs.filter(l => l.status === 'FILLED').length
      fills += f
      legs += res.legs.length
      if (f === 0) fails++
      else filledSymbols.push(symbol)
    } catch {
      fails++
    }
  }

  // optional risk legs on the resulting positions (per account, capped at held)
  if (filledSymbols.length > 0 && (rule.stopLoss || rule.target)) {
    await armRiskLegs(rule, filledSymbols, meta.lotSize)
  }

  return {
    ok: fills > 0,
    message: `${side} ${candidates.length} strike(s) — ${fills}/${legs} account fills${fails ? ` · ${fails} strike fails` : ''}${rule.entryPrice ? ` @ LIMIT ${rule.entryPrice}` : ' @ MKT'}`,
  }
}

/** Arm reduce-only target (LIMIT) / stopLoss (SL-M) legs on whatever the
 *  rule's entry just bought/sold — executed by the resting-order monitor. */
async function armRiskLegs(rule: AutoRule, symbols: string[], _lotSize: number) {
  for (const symbol of symbols) {
    try {
      if (rule.target) {
        const posSide = rule.action === 'SELL' ? 'BUY' : 'SELL' // close the entry side
        await placeMasterOrder({
          symbol, exchange: 'NFO', side: posSide, qty: 9999,
          orderType: 'LIMIT', productType: 'MIS', source: 'SYSTEM',
          limitPrice: rule.target, reduceOnly: true, strategyId: 'reduce',
        })
      }
      if (rule.stopLoss) {
        const posSide = rule.action === 'SELL' ? 'BUY' : 'SELL'
        await placeMasterOrder({
          symbol, exchange: 'NFO', side: posSide, qty: 9999,
          orderType: 'SL-M', productType: 'MIS', source: 'SYSTEM',
          triggerPrice: rule.stopLoss, reduceOnly: true, strategyId: 'reduce',
        })
      }
    } catch { /* risk legs best-effort */ }
  }
}

/** Build the strike list for a rule: user picks win; else side-ATM + offset. */
async function strikesFor(rule: AutoRule): Promise<AutoStrike[]> {
  const wanted = rule.action === 'DEPLOY' || rule.action === 'CANCEL'
    ? (rule.strikes ?? []).filter(s => s.type === rule.optType)
    : rule.strikes ?? []
  if (wanted.length > 0) return wanted
  const meta = await getChainMeta(rule.underlying, rule.expiry)
  if (!meta) return []
  const sideAtm = rule.optType === 'CE' ? meta.ceAtm : meta.peAtm
  return [{ strike: sideAtm + rule.offset * meta.step, type: rule.optType, allocPct: rule.allocPct }]
}

async function fireRule(rule: AutoRule): Promise<{ ok: boolean; message: string; waiting?: boolean }> {
  try {
    const list = await strikesFor(rule)
    return await executeStrikes(rule, list)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'fire failed' }
  }
}

async function markFired(rule: AutoRule, ok: boolean, message: string) {
  await updateRule(rule.id, {
    lastFiredDate: istNow().date,
    lastFiredAt: new Date().toISOString(),
    lastStatus: ok ? 'FIRED' : 'FAILED',
    lastMessage: message.slice(0, 160),
    fireCount: (rule.fireCount ?? 0) + 1,
  })
  logBroker('SIMFEED', 'auto-rules', `rule "${rule.name}" ${ok ? 'FIRED' : 'FAILED'}: ${message}`, ok ? 'INFO' : 'WARN')
}

/** Run `fireRule` with a hard timeout so one slow broker call can never wedge the loop. */
function fireWithTimeout(rule: AutoRule, ms = 20_000): Promise<{ ok: boolean; message: string; waiting?: boolean }> {
  return Promise.race([
    fireRule(rule),
    new Promise<{ ok: false; message: string }>(res => setTimeout(() => res({ ok: false, message: 'fire timed out' }), ms)),
  ])
}

/** In-memory once-per-day guard — consulted BEFORE firing so a stale rules
 *  cache (2s TTL) can't double-fire inside a seconds-precision window. */
function alreadyFiredToday(rule: AutoRule): boolean {
  if (!rule.repeatDaily) return rule.lastFiredDate != null || (gEng.__autoFiredToday?.has(rule.id) ?? false)
  const today = istNow().date
  if (gEng.__autoFiredToday?.get(rule.id) === today) return true
  return rule.lastFiredDate === today
}

function markFiredMemory(ruleId: string): void {
  if (!gEng.__autoFiredToday) gEng.__autoFiredToday = new Map()
  gEng.__autoFiredToday.set(ruleId, istNow().date)
}

function waitingSince(ruleId: string): number {
  if (!gEng.__autoWaiting) gEng.__autoWaiting = new Map()
  let w = gEng.__autoWaiting.get(ruleId)
  if (!w) { w = { since: Date.now() }; gEng.__autoWaiting.set(ruleId, w) }
  return w.since
}
function clearWaiting(ruleId: string): void {
  gEng.__autoWaiting?.delete(ruleId)
}

/** How long a rule that reached its time window keeps waiting for the
 *  remaining conditions (default: 2s when time is the ONLY condition,
 *  5 minutes when combined — configurable via graceSec). */
function graceFor(rule: AutoRule): number {
  if (rule.graceSec) return rule.graceSec
  const combo = !!(rule.lo != null && rule.hi != null) || !!rule.entryOp
  return combo ? 300 : 2
}

async function engineOnce() {
  const busyAt = gEng.__autoRuleBusyAt ?? 0
  if (busyAt && Date.now() - busyAt < 30_000) return // previous tick still inside its grace window
  gEng.__autoRuleBusyAt = Date.now()
  // heartbeat: prove the scheduler is alive (once a minute)
  if (!gEng.__autoRuleBeat || Date.now() - gEng.__autoRuleBeat > 60_000) {
    gEng.__autoRuleBeat = Date.now()
    console.log('[auto-rules] tick ok (250ms scheduler)')
  }
  try {
    const rules = await loadRulesCached()
    const { date, secondsOfDay } = istNow()
    const active = rules.filter(r => r.enabled && r.underlying)

    // spot quotes for rules with an index condition
    const needSpot = active.filter(r => r.kind === 'INDEX' || ((r.lo != null && r.hi != null) || (r.kind === 'COMPOUND' && r.level != null)))
    let spotQuotes: Record<string, { ltp: number }> = {}
    if (needSpot.length > 0) {
      const unds = [...new Set(needSpot.map(r => r.underlying))]
      spotQuotes = await fetchQuotes(unds)
    }

    for (const rule of active) {
      if (alreadyFiredToday(rule)) { clearWaiting(rule.id); continue }
      if (rule.kind === 'COMPOUND' && process.env.AUTO_DEBUG) {
        console.log(`[auto-rules][dbg] eval ${rule.name} kind=${rule.kind} time=${rule.time} lo=${rule.lo} hi=${rule.hi} entryOp=${rule.entryOp} sod=${secondsOfDay}`)
      }

      // ---------- condition evaluation (ALL set conditions must hold) ----------
      let ready = true
      let expired = false
      let reason = ''

      // TIME condition
      if (rule.time) {
        const target = timeToSeconds(rule.time)
        const grace = graceFor(rule)
        if (secondsOfDay < target) ready = false
        else if (secondsOfDay >= target + grace) { expired = true; reason = `time window expired (${rule.time} +${grace}s)` }
      }

      // INDEX cross condition (legacy INDEX kind, edge-triggered)
      if (ready && rule.kind === 'INDEX' && rule.level != null) {
        const q = spotQuotes[rule.underlying]
        if (!q) { ready = false }
        else {
          if (!gEng.__autoPrevSpot) gEng.__autoPrevSpot = new Map()
          const prev = gEng.__autoPrevSpot.get(rule.id)
          gEng.__autoPrevSpot.set(rule.id, q.ltp)
          if (prev == null) ready = false // first observation — arm only
          else {
            const crossedUp = prev < rule.level && q.ltp >= rule.level
            const crossedDown = prev > rule.level && q.ltp <= rule.level
            if (!(rule.cross === 'BELOW' ? crossedDown : crossedUp)) ready = false
          }
        }
      }

      // INDEX range condition (steady state — "index price is in range")
      if (ready && rule.lo != null && rule.hi != null && rule.kind !== 'INDEX') {
        const q = spotQuotes[rule.underlying]
        if (!q) ready = false
        else if (!(q.ltp >= rule.lo && q.ltp <= rule.hi)) {
          ready = false
          // legacy INDEX_RANGE: EDGE trigger on band entry (fire once per entry)
          if (rule.kind === 'INDEX_RANGE') {
            if (!gEng.__autoPrevSpot) gEng.__autoPrevSpot = new Map()
            const prev = gEng.__autoPrevSpot.get(rule.id)
            if (prev != null && prev >= rule.lo && prev <= rule.hi) {
              // was already inside and is still inside without a fresh entry —
              // only the ENTRY tick fires; a rule that armed mid-band stays armed
              // until it exits and re-enters (matches v2 behavior)
            }
          }
        }
        if (q && rule.kind === 'INDEX_RANGE') {
          if (!gEng.__autoPrevSpot) gEng.__autoPrevSpot = new Map()
          const prev = gEng.__autoPrevSpot.get(rule.id)
          gEng.__autoPrevSpot.set(rule.id, q.ltp)
          const inside = q.ltp >= rule.lo && q.ltp <= rule.hi
          const wasInside = prev != null && prev >= rule.lo && prev <= rule.hi
          if (!(inside && !wasInside)) ready = false // edge-triggered
        }
      }

      // legacy COMPOUND with a level (treated as steady-state above/below)
      if (ready && rule.kind === 'COMPOUND' && rule.level != null) {
        const q = spotQuotes[rule.underlying]
        if (!q) ready = false
        else if (rule.cross === 'BELOW' ? q.ltp > rule.level : q.ltp < rule.level) ready = false
      }

      if (!ready) { clearWaiting(rule.id); if (process.env.AUTO_DEBUG && rule.kind === 'COMPOUND') console.log(`[auto-rules][dbg] ${rule.name} not ready`); continue }

      if (expired) {
        markFiredMemory(rule.id)
        await markFired(rule, false, reason)
        clearWaiting(rule.id)
        continue
      }

      // ---------- fire ----------
      if (process.env.AUTO_DEBUG) console.log(`[auto-rules][dbg] FIRE ${rule.name}`)
      markFiredMemory(rule.id) // provisional — cleared if the premium gate says "waiting"
      const out = await fireWithTimeout(rule)
      if (out.waiting) {
        // premium condition not met yet — keep the rule armed inside the
        // grace window (only rules with a time condition can expire here)
        if (gEng.__autoFiredToday) gEng.__autoFiredToday.delete(rule.id)
        if (rule.time) {
          const target = timeToSeconds(rule.time)
          const grace = graceFor(rule)
          const since = waitingSince(rule.id)
          if (Date.now() - since > grace * 1000 || secondsOfDay >= target + grace) {
            markFiredMemory(rule.id)
            await markFired(rule, false, `conditions never aligned — ${out.message}`)
            clearWaiting(rule.id)
          }
        } else {
          clearWaiting(rule.id)
        }
        continue
      }
      clearWaiting(rule.id)
      await markFired(rule, out.ok, out.message)
    }
  } catch (e) {
    console.error('[auto-rules]', e)
  } finally {
    gEng.__autoRuleBusyAt = 0
  }
}

export function ensureAutoRuleEngine() {
  if (gEng.__autoRuleTimer) return
  gEng.__autoRuleTimer = setInterval(() => { void engineOnce() }, 250)
  console.log('[auto-rules] engine started (250ms scheduler — seconds precision, compound conditions)')
}
