// @ts-nocheck
import { db } from '../db'
import { leverageFor, round2 } from '../charges'
import { getCash } from '@brokers/database'
import type { CapitalMode } from '../types'

// ============================================================
// Capital sizing service — the "house concept".
//
// PROFIT_ONLY                 : first trade deploys full initial capital;
//                               afterwards only accumulated NET profit is deployable.
// INITIAL_PLUS_PNL            : deployable = initial + realized PnL (compounding).
// INITIAL_WITH_LOSS_REDUCTION : deployable = initial, reduced by every loss
//                               incl. brokerage/charges/tax; profits do not add.
// All modes respect margin currently locked in open positions (deployed).
//
// CAPITAL SOURCE (round-8): the initial capital itself can be
//   · FIXED               — a fixed rupee amount (initialCapital), or
//   · AVAILABLE_CASH_PCT  — capitalPct % of the account's LIVE available
//                           cash (broker funds), recomputed on every read
//                           so sizing always tracks the real balance.
// ============================================================

export type CapitalBase = 'FIXED' | 'AVAILABLE_CASH_PCT'

export interface CapitalState {
  mode: CapitalMode
  initialCapital: number
  /** resolved initial capital (base applied) — what sizing actually uses */
  effectiveInitial: number
  /** the account's live available cash (broker funds) when known */
  availableCash: number | null
  capitalBase: CapitalBase
  capitalPct: number
  realizedPnl: number
  chargesPaid: number
  deployed: number
  firstTradeDone: boolean
}

export async function getCapitalState(accountId: string): Promise<CapitalState | null> {
  const c = await db.capitalConfig.findUnique({ where: { accountId } })
  if (!c) return null
  const capitalBase = (c.capitalBase as CapitalBase) ?? 'FIXED'
  const capitalPct = c.capitalPct ?? 100
  // always resolve the live available cash (UI shows it + % preview)
  let availableCash: number | null = null
  try {
    const acc = await db.brokerAccount.findUnique({ where: { id: accountId }, select: { brokerType: true } })
    if (acc) availableCash = getCash(acc.brokerType, accountId)
  } catch { availableCash = null }
  const effectiveInitial = capitalBase === 'AVAILABLE_CASH_PCT' && availableCash != null
    ? round2(Math.max(0, availableCash * (capitalPct / 100)))
    : c.initialCapital
  return {
    mode: c.mode as CapitalMode,
    initialCapital: c.initialCapital,
    effectiveInitial,
    availableCash,
    capitalBase,
    capitalPct,
    realizedPnl: c.realizedPnl,
    chargesPaid: c.chargesPaid,
    deployed: c.deployed,
    firstTradeDone: c.firstTradeDone,
  }
}

export function computeUsableCapital(s: CapitalState): number {
  const initial = s.effectiveInitial ?? s.initialCapital
  // % of available cash: the cash balance IS the live pot (PnL already
  // inside it) — usable = share of cash − margin deployed. The house
  // sizing modes apply to the FIXED rupee base only.
  if (s.capitalBase === 'AVAILABLE_CASH_PCT' && s.availableCash != null) {
    return round2(Math.max(0, initial - s.deployed))
  }
  let base: number
  switch (s.mode) {
    case 'PROFIT_ONLY':
      base = s.firstTradeDone ? s.realizedPnl : initial
      break
    case 'INITIAL_PLUS_PNL':
      base = initial + s.realizedPnl
      break
    case 'INITIAL_WITH_LOSS_REDUCTION':
      base = initial + Math.min(0, s.realizedPnl)
      break
  }
  return round2(Math.max(0, base - s.deployed))
}

export function explainCapital(s: CapitalState): string {
  const usable = computeUsableCapital(s)
  const initial = s.effectiveInitial ?? s.initialCapital
  if (s.capitalBase === 'AVAILABLE_CASH_PCT') {
    return `${s.capitalPct}% of available cash ₹${round2(s.availableCash ?? 0)} = ₹${round2(initial)} − deployed ₹${round2(s.deployed)} (tracks the live balance; sizing mode bypassed)`
  }
  const baseTxt = `Initial ₹${round2(initial)}`
  switch (s.mode) {
    case 'PROFIT_ONLY':
      return s.firstTradeDone
        ? `First trade done — deployable = net profit pool ₹${round2(s.realizedPnl)} (− deployed ₹${round2(s.deployed)})`
        : `First trade pending — full ${baseTxt} deployable`
    case 'INITIAL_PLUS_PNL':
      return `${baseTxt} + PnL ₹${round2(s.realizedPnl)} − deployed ₹${round2(s.deployed)}`
    case 'INITIAL_WITH_LOSS_REDUCTION':
      return `${baseTxt} reduced by losses/charges ₹${round2(Math.max(0, -s.realizedPnl))} − deployed ₹${round2(s.deployed)}`
  }
  return `Usable ₹${usable}`
}

/**
 * Size position units for an account given its usable capital.
 * Returns units (0 if insufficient for one lot/unit).
 */
export function sizeUnitsForCapital(params: {
  usable: number
  price: number
  instrumentType: string
  productType: string
  lotSize: number
  sharePct?: number // % of usable to deploy (copy trading)
  absoluteAmount?: number // override: absolute rupee allocation
  roundToLot?: boolean
}): number {
  // HOUSE RULE: an account can NEVER deploy more than its usable capital,
  // even when an absolute allocation (strategy capitalAmount) is requested.
  const desired = params.absoluteAmount ?? params.usable * ((params.sharePct ?? 100) / 100)
  const alloc = Math.min(desired, params.usable)
  if (alloc <= 0 || params.price <= 0) return 0
  const lev = leverageFor(params.instrumentType, params.productType)
  const notional = alloc * lev
  const rawUnits = notional / params.price
  const lots = rawUnits / params.lotSize
  const lotsFloored = Math.floor(lots)
  const units = params.roundToLot === false ? Math.floor(rawUnits) : lotsFloored * params.lotSize
  return Math.max(0, units)
}

/** Margin that will be locked for these units */
export function marginForUnits(units: number, price: number, instrumentType: string, productType: string): number {
  return round2((units * price) / leverageFor(instrumentType, productType))
}

// ---------- settlement hooks (called by execution engine / router) ----------

export async function onTradeSettled(params: {
  accountId: string
  realizedNetPnl: number // gross pnl - charges for closing trades, or -charges for opens
  charges: number
  marginDelta: number // + locked more margin, - released
}) {
  const c = await db.capitalConfig.findUnique({ where: { accountId: params.accountId } })
  if (!c) return
  await db.capitalConfig.update({
    where: { accountId: params.accountId },
    data: {
      realizedPnl: round2(c.realizedPnl + params.realizedNetPnl),
      chargesPaid: round2(c.chargesPaid + params.charges),
      deployed: Math.max(0, round2(c.deployed + params.marginDelta)),
      firstTradeDone: true,
      updatedAt: new Date(),
    },
  })
}

export async function resetCapital(accountId: string, initialCapital: number, mode: CapitalMode) {
  await db.capitalConfig.update({
    where: { accountId },
    data: {
      initialCapital: round2(initialCapital),
      mode,
      realizedPnl: 0,
      chargesPaid: 0,
      deployed: 0,
      firstTradeDone: false,
      updatedAt: new Date(),
    },
  })
}
