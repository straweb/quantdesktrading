// @ts-nocheck
import { db } from '../db'
import { adapters } from '../../../brokers/index'
import { BROKER_TYPES } from '../types'
import type { BrokerType } from '../types'
import { fetchQuotes } from '../../../brokers/feed-client'
import { optionPremium, strikeStepFor, publishUniverseToFeed, istToday } from './symbol-service'

// ============================================================
// Option chain service — F&O indices + stocks.
// - Resolves spot LTP -> ATM strike (per-underlying strike step)
// - Serves per-strike CE/PE quotes (LTP + day high/low) for the
//   strikes panel
// - Dynamically creates contracts for user-added strikes that
//   are not in the master contract file (incl. broker mappings
//   + feed universe publication), OpenAlgo-style.
// ============================================================

export interface OptionUnderlying {
  underlying: string
  name: string
  lotSize: number
  expiries: string[]
  instrumentType: string // INDEX | EQ
}

export async function listOptionUnderlyings(): Promise<OptionUnderlying[]> {
  const rows = await db.symbolMaster.findMany({
    where: { instrumentType: { in: ['CE', 'PE'] } },
    select: { underlying: true, lotSize: true, expiry: true, name: true },
  })
  const map = new Map<string, { lotSize: number; expiries: Set<string>; name: string }>()
  for (const r of rows) {
    if (!r.underlying) continue
    const e = map.get(r.underlying) ?? { lotSize: r.lotSize, expiries: new Set<string>(), name: r.underlying }
    if (r.expiry) e.expiries.add(r.expiry)
    e.lotSize = r.lotSize
    map.set(r.underlying, e)
  }
  // enrich with base instrument info (name + INDEX/EQ tag)
  const bases = await db.symbolMaster.findMany({
    where: { instrumentType: { in: ['INDEX', 'EQ'] } },
    select: { symbol: true, name: true, instrumentType: true },
  })
  const baseMap = new Map(bases.map(b => [b.symbol, b]))
  const out: OptionUnderlying[] = []
  for (const [underlying, e] of map) {
    const b = baseMap.get(underlying)
    out.push({
      underlying,
      name: b?.name ?? e.name,
      lotSize: e.lotSize,
      expiries: [...e.expiries].sort(),
      instrumentType: b?.instrumentType ?? 'EQ',
    })
  }
  return out.sort((a, b) => (a.instrumentType === b.instrumentType ? a.underlying.localeCompare(b.underlying) : a.instrumentType === 'INDEX' ? -1 : 1))
}

export interface ChainMeta {
  underlying: string
  exchange: string // spot exchange (NSE)
  spot: number
  prevClose: number
  atm: number // nearest round strike
  ceAtm: number // CE-side ATM = floor(spot/step)*step  (e.g. spot 23020 -> 23000)
  peAtm: number // PE-side ATM = ceil(spot/step)*step   (e.g. spot 23020 -> 23050)
  step: number
  lotSize: number
  expiry: string
  expiries: string[]
  strikesAvailable: number[]
}

export async function getChainMeta(underlying: string, expiry?: string | null): Promise<ChainMeta | null> {
  const optRows = await db.symbolMaster.findMany({
    where: { underlying, instrumentType: { in: ['CE', 'PE'] } },
    select: { expiry: true, strike: true, lotSize: true, exchange: true },
  })
  if (optRows.length === 0) return null

  const expiries = [...new Set(optRows.map(r => r.expiry).filter((e): e is string => !!e))].sort()
  // default expiry = the FIRST expiry that has not passed yet — old master
  // rows accumulate across daily syncs, and expiries[0] can be a stale
  // (already expired) weekly whose symbols no longer exist in the feed.
  // "today" is IST (the exchange calendar the expiries belong to).
  const today = istToday()
  const activeExpiry = expiry && expiries.includes(expiry)
    ? expiry
    : (expiries.find(e => e >= today) ?? expiries[expiries.length - 1])
  const inExpiry = optRows.filter(r => r.expiry === activeExpiry)
  const strikes = [...new Set(inExpiry.map(r => r.strike).filter((s): s is number => s != null))].sort((a, b) => a - b)
  if (strikes.length === 0) return null

  // strike step = min positive gap (robust for synthetic/dynamic chains)
  let step = Infinity
  for (let i = 1; i < strikes.length; i++) {
    const d = strikes[i] - strikes[i - 1]
    if (d > 0 && d < step) step = d
  }
  if (!isFinite(step) || step <= 0) step = strikeStepFor(strikes[0])

  const spotQ = await fetchQuotes([underlying])
  const spot = spotQ[underlying]?.ltp ?? strikes[Math.floor(strikes.length / 2)]
  const prevClose = spotQ[underlying]?.prevClose ?? spot
  const atm = Math.round(spot / step) * step
  // Hedge-desk convention: the two strikes bracketing spot —
  // CE buys the lower (floor), PE buys the higher (ceil).
  const ceAtm = Math.floor(spot / step) * step
  const peAtm = Math.ceil(spot / step) * step

  return {
    underlying,
    exchange: 'NSE',
    spot,
    prevClose,
    atm,
    ceAtm,
    peAtm,
    step,
    lotSize: inExpiry[0]?.lotSize ?? 1,
    expiry: activeExpiry,
    expiries,
    strikesAvailable: strikes,
  }
}

export interface OptionQuoteCell {
  symbol: string
  exists: boolean
  ltp: number
  prevClose: number
  high: number
  low: number
  changePct: number
}

export interface ChainStrikeRow {
  strike: number
  offset: number // in steps vs nearest ATM (0 = ATM)
  offsetCe: number // in steps vs CE-side ATM (floor convention)
  offsetPe: number // in steps vs PE-side ATM (ceil convention)
  ce: OptionQuoteCell
  pe: OptionQuoteCell
}

function emptyCell(symbol: string): OptionQuoteCell {
  return { symbol, exists: false, ltp: 0, prevClose: 0, high: 0, low: 0, changePct: 0 }
}

export async function getChainQuotes(
  underlying: string,
  expiry: string,
  strikes: number[],
  atm: number,
  step: number,
  ceAtm?: number,
  peAtm?: number,
): Promise<ChainStrikeRow[]> {
  if (strikes.length === 0) return []
  const contracts = await db.symbolMaster.findMany({
    where: { underlying, expiry, instrumentType: { in: ['CE', 'PE'] }, strike: { in: strikes } },
  })
  const byKey = new Map<string, string>() // `${strike}:${type}` -> master symbol
  for (const c of contracts) {
    if (c.strike == null || !c.optionType) continue
    byKey.set(`${c.strike}:${c.optionType}`, c.symbol)
  }
  const allSymbols = [...byKey.values()]
  const quotes = allSymbols.length ? await fetchQuotes(allSymbols) : {}

  const seen = new Set<string>()
  const uniqueStrikes: number[] = []
  for (const s of strikes) {
    const k = String(s)
    if (seen.has(k)) continue
    seen.add(k)
    uniqueStrikes.push(s)
  }
  uniqueStrikes.sort((a, b) => a - b)

  return uniqueStrikes.map(strike => {
    const ceSym = byKey.get(`${strike}:CE`) ?? `${underlying}-${strike}-CE`
    const peSym = byKey.get(`${strike}:PE`) ?? `${underlying}-${strike}-PE`
    const mk = (sym: string, type: 'CE' | 'PE'): OptionQuoteCell => {
      const q = quotes[sym]
      if (!q) return emptyCell(sym)
      const chg = q.prevClose ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : 0
      return {
        symbol: sym,
        exists: true,
        ltp: q.ltp,
        prevClose: q.prevClose,
        high: q.high,
        low: q.low,
        changePct: Math.round(chg * 100) / 100,
      }
    }
    const refCe = ceAtm ?? atm
    const refPe = peAtm ?? atm
    return {
      strike,
      offset: step > 0 ? Math.round((strike - atm) / step) : 0,
      offsetCe: step > 0 ? Math.round((strike - refCe) / step) : 0,
      offsetPe: step > 0 ? Math.round((strike - refPe) / step) : 0,
      ce: mk(ceSym, 'CE'),
      pe: mk(peSym, 'PE'),
    }
  })
}

// ------------------------------------------------------------
// Dynamic contract creation: user adds a strike not present in
// the master file (e.g. deep OTM). Creates CE+PE SymbolMaster
// rows, all broker mappings, publishes to the feed universe.
// ------------------------------------------------------------
export async function ensureOptionContracts(underlying: string, strike: number, expiry?: string | null): Promise<{ created: number; symbols: string[] }> {
  // resolve underlying base (spot ref price + lot)
  const base = await db.symbolMaster.findFirst({
    where: { symbol: underlying, instrumentType: { in: ['INDEX', 'EQ'] } },
  })
  const anyOpt = await db.symbolMaster.findFirst({
    where: { underlying, instrumentType: { in: ['CE', 'PE'] }, ...(expiry ? { expiry } : {}) },
    orderBy: { expiry: 'asc' },
  })
  if (!base && !anyOpt) return { created: 0, symbols: [] }

  // ref price for premium estimates: prefer the underlying's CURRENT feed
  // LTP (real tick in live mode, sim price in sim mode) — the real synced
  // masters carry no basePrice, and the old 1000 fallback mispriced ensured
  // contracts (₹1000 NIFTY premium → absurd margin sizing)
  let refPrice = base?.basePrice ?? anyOpt?.basePrice ?? 1000
  try {
    const spotQ = (await fetchQuotes([underlying]))[underlying]
    if (spotQ?.ltp && spotQ.ltp > 0) refPrice = spotQ.ltp
  } catch { /* keep the master/base fallback */ }
  const lotSize = anyOpt?.lotSize ?? base?.lotSize ?? 1
  // default to the earliest LIVE expiry (stale weekly rows accumulate in the
  // master table — never create contracts for an expired series)
  const today = istToday()
  const firstLive = await db.symbolMaster.findFirst({
    where: { underlying, instrumentType: { in: ['CE', 'PE'] }, expiry: { gte: today } },
    orderBy: { expiry: 'asc' },
  })
  const activeExpiry = expiry ?? firstLive?.expiry ?? anyOpt?.expiry
  if (!activeExpiry) return { created: 0, symbols: [] }

  const days = Math.max(0, Math.round((new Date(activeExpiry).getTime() - Date.now()) / 86400000))
  const version = new Date().toISOString().slice(0, 10)
  const created: string[] = []
  // every ensured contract goes to the feed universe — REAL synced masters
  // carry no basePrice and no feed state, so the chain/sizing would fall back
  // to the ₹1000 placeholder. loadUniverse skips existing states → idempotent.
  const publishList: { symbol: string; basePrice: number; lotSize: number; instrumentType: string }[] = []

  for (const t of ['CE', 'PE'] as const) {
    const symbol = `${underlying}${activeExpiry.replaceAll('-', '')}${strike}${t}`
    const premium = optionPremium(refPrice, strike, t, days)
    const existing = await db.symbolMaster.findUnique({
      where: { symbol_exchange: { symbol, exchange: 'NFO' } },
    })
    if (existing) {
      created.push(symbol)
      // existing REAL master — seed the feed state with the premium estimated
      // from the current spot (real rows have basePrice null)
      publishList.push({ symbol, basePrice: existing.basePrice ?? premium, lotSize: existing.lotSize || lotSize, instrumentType: t })
      continue
    }
    const row = await db.symbolMaster.create({
      data: {
        symbol,
        name: `${underlying} ${strike} ${t} ${activeExpiry}`,
        exchange: 'NFO', instrumentType: t, expiry: activeExpiry, strike,
        optionType: t, lotSize, tickSize: 0.05, underlying,
        basePrice: premium, version,
      },
    })
    created.push(row.symbol)
    publishList.push({ symbol: row.symbol, basePrice: premium, lotSize, instrumentType: t })

    for (const bt of BROKER_TYPES as BrokerType[]) {
      const adapter = adapters[bt]
      if (!adapter) continue
      const gen = adapter.mapSymbol({
        symbol: row.symbol, exchange: 'NFO', instrumentType: t,
        expiry: activeExpiry, strike, optionType: t,
      })
      await db.symbolMapping.upsert({
        where: { masterId_brokerType: { masterId: row.id, brokerType: bt } },
        create: { masterId: row.id, brokerType: bt, brokerSymbol: gen.brokerSymbol, brokerToken: gen.brokerToken },
        update: { brokerSymbol: gen.brokerSymbol, brokerToken: gen.brokerToken },
      })
    }
  }

  if (publishList.length > 0) {
    await publishUniverseToFeed(publishList)
  }
  return { created: created.length, symbols: created }
}
