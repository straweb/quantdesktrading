// @ts-nocheck
import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { newId } from '../../../brokers/registry'
import { fetchQuotes } from '../../../brokers/feed-client'
import { placeMasterOrder } from './order-router'
import { logBroker } from '../../../brokers/database'

// ============================================================
// GTT — Good-Till-Triggered orders (broker-agnostic).
// Works for EVERY account type (sim feed + Dhan + Shoonya +
// ICICI Breeze) because execution goes through the same order
// router the terminal uses. When LTP crosses the trigger the
// rule places its order (LIMIT at triggerPrice, or MARKET) and
// disarms itself (unless repeatDaily). Storage: db/gtt.json.
// Engine: 1s scheduler (started from instrumentation.ts).
// ============================================================

export type GttTrigger = 'ABOVE' | 'BELOW'

export interface GttRule {
  id: string
  name: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number // lots for FUT/OPT, units for EQ
  trigger: GttTrigger
  triggerPrice: number
  orderType: 'LIMIT' | 'MARKET'
  productType: 'MIS' | 'CNC' | 'NRML'
  repeatDaily: boolean
  armed: boolean
  lastTriggeredAt?: string
  lastStatus?: string
  lastMessage?: string
  createdAt: string
}

const GTT_FILE = path.join(process.cwd(), 'db', 'gtt.json')

async function readRules(): Promise<GttRule[]> {
  try {
    const raw = await readFile(GTT_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { rules?: GttRule[] }
    return Array.isArray(parsed.rules) ? parsed.rules : []
  } catch {
    return []
  }
}

async function writeRules(rules: GttRule[]) {
  await mkdir(path.dirname(GTT_FILE), { recursive: true })
  await writeFile(GTT_FILE, JSON.stringify({ rules, updatedAt: new Date().toISOString() }, null, 2))
}

export async function listGtt(): Promise<GttRule[]> {
  return readRules()
}

export async function createGtt(input: Partial<GttRule>): Promise<GttRule> {
  const rules = await readRules()
  const rule: GttRule = {
    id: newId('GTT-'),
    name: String(input.name || `${input.side} ${input.symbol} @ ${input.triggerPrice}`).slice(0, 80),
    symbol: String(input.symbol || ''),
    exchange: String(input.exchange || 'NSE'),
    side: input.side === 'SELL' ? 'SELL' : 'BUY',
    qty: Math.max(1, Math.round(Number(input.qty ?? 1))),
    trigger: input.trigger === 'BELOW' ? 'BELOW' : 'ABOVE',
    triggerPrice: Number(input.triggerPrice ?? 0),
    orderType: input.orderType === 'MARKET' ? 'MARKET' : 'LIMIT',
    productType: input.productType === 'CNC' ? 'CNC' : input.productType === 'NRML' ? 'NRML' : 'MIS',
    repeatDaily: input.repeatDaily !== false,
    armed: input.armed !== false,
    createdAt: new Date().toISOString(),
  }
  if (!rule.symbol || !(rule.triggerPrice > 0)) throw new Error('symbol and triggerPrice are required')
  rules.push(rule)
  await writeRules(rules)
  return rule
}

export async function updateGtt(id: string, patch: Partial<GttRule>): Promise<GttRule | null> {
  const rules = await readRules()
  const idx = rules.findIndex(r => r.id === id)
  if (idx === -1) return null
  rules[idx] = { ...rules[idx], ...patch, id: rules[idx].id }
  await writeRules(rules)
  return rules[idx]
}

export async function deleteGtt(id: string): Promise<boolean> {
  const rules = await readRules()
  const next = rules.filter(r => r.id !== id)
  if (next.length === rules.length) return false
  await writeRules(next)
  return true
}

// ---- engine ----

const gGtt = globalThis as unknown as {
  __gttTimer?: ReturnType<typeof setInterval>
  __gttPrev?: Map<string, number> // ruleId -> last LTP (edge detection)
}

async function engineOnce() {
  const rules = await readRules()
  const active = rules.filter(r => r.armed && r.symbol && r.triggerPrice > 0)
  if (active.length === 0) return
  const quotes = await fetchQuotes([...new Set(active.map(r => r.symbol))])
  const prevMap = gGtt.__gttPrev ?? (gGtt.__gttPrev = new Map())
  for (const rule of active) {
    const q = quotes[rule.symbol]
    if (!q) continue
    const prev = prevMap.get(rule.id)
    prevMap.set(rule.id, q.ltp)
    if (prev == null) continue // first observation — arm only
    const hit =
      rule.trigger === 'ABOVE'
        ? prev < rule.triggerPrice && q.ltp >= rule.triggerPrice
        : prev > rule.triggerPrice && q.ltp <= rule.triggerPrice
    if (!hit) continue
    try {
      const res = await placeMasterOrder({
        symbol: rule.symbol,
        exchange: rule.exchange,
        side: rule.side,
        qty: rule.qty,
        orderType: rule.orderType === 'MARKET' ? 'MARKET' : 'LIMIT',
        productType: rule.productType,
        source: 'SYSTEM',
        limitPrice: rule.orderType === 'LIMIT' ? rule.triggerPrice : undefined,
        strategyId: `gtt:${rule.id}`,
      })
      const fills = res.legs.filter(l => l.status === 'FILLED').length
      await updateGtt(rule.id, {
        armed: rule.repeatDaily, // stay armed daily, else disarm after firing
        lastTriggeredAt: new Date().toISOString(),
        lastStatus: res.status,
        lastMessage: `${rule.side} ${rule.qty} ${rule.symbol} @ ${rule.triggerPrice} — ${fills}/${res.legs.length} fills`,
      })
      logBroker('SIMFEED', 'gtt', `GTT "${rule.name}" triggered: ${res.status} (${fills}/${res.legs.length} fills)`, 'INFO')
    } catch (e) {
      await updateGtt(rule.id, {
        lastTriggeredAt: new Date().toISOString(),
        lastStatus: 'FAILED',
        lastMessage: e instanceof Error ? e.message.slice(0, 140) : 'trigger failed',
      })
      logBroker('SIMFEED', 'gtt', `GTT "${rule.name}" trigger failed: ${e instanceof Error ? e.message : e}`, 'WARN')
    }
  }
}

export function ensureGttEngine() {
  if (gGtt.__gttTimer) return
  gGtt.__gttTimer = setInterval(() => { void engineOnce() }, 1000)
  console.log('[gtt] engine started (1s trigger monitor)')
}
