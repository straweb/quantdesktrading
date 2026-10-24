import { describe, expect, test } from 'bun:test'
import { computeUsableCapital, explainCapital, marginForUnits, sizeUnitsForCapital } from '../../src/lib/services/capital-service'
import type { CapitalState } from '../../src/lib/services/capital-service'

// Capital sizing — the three "house modes" × capital source (fixed ₹ /
// % of available cash), plus the sizing math (house clamp, lot flooring).

function st(partial: Partial<CapitalState>): CapitalState {
  return {
    mode: 'INITIAL_PLUS_PNL',
    initialCapital: 500000,
    effectiveInitial: 500000,
    availableCash: null,
    capitalBase: 'FIXED',
    capitalPct: 100,
    realizedPnl: 0,
    chargesPaid: 0,
    deployed: 0,
    firstTradeDone: false,
    ...partial,
  }
}

describe('capital — computeUsableCapital (house modes, FIXED base)', () => {
  test('PROFIT_ONLY before first trade: full initial deployable', () => {
    const s = st({ mode: 'PROFIT_ONLY', firstTradeDone: false, realizedPnl: -25000 })
    expect(computeUsableCapital(s)).toBe(500000)
  })

  test('PROFIT_ONLY after first trade: only accumulated NET profit', () => {
    expect(computeUsableCapital(st({ mode: 'PROFIT_ONLY', firstTradeDone: true, realizedPnl: 12000 }))).toBe(12000)
    // losses → zero usable (never negative)
    expect(computeUsableCapital(st({ mode: 'PROFIT_ONLY', firstTradeDone: true, realizedPnl: -2200 }))).toBe(0)
  })

  test('INITIAL_PLUS_PNL compounds: initial + realized PnL', () => {
    expect(computeUsableCapital(st({ mode: 'INITIAL_PLUS_PNL', realizedPnl: 15000 }))).toBe(515000)
    expect(computeUsableCapital(st({ mode: 'INITIAL_PLUS_PNL', realizedPnl: -2200 }))).toBe(497800)
  })

  test('INITIAL_WITH_LOSS_REDUCTION: losses reduce, profits never add', () => {
    expect(computeUsableCapital(st({ mode: 'INITIAL_WITH_LOSS_REDUCTION', realizedPnl: -5200 }))).toBe(494800)
    expect(computeUsableCapital(st({ mode: 'INITIAL_WITH_LOSS_REDUCTION', realizedPnl: 9000 }))).toBe(500000)
  })

  test('deployed margin is always subtracted, floor at 0', () => {
    expect(computeUsableCapital(st({ mode: 'INITIAL_PLUS_PNL', deployed: 100000 }))).toBe(400000)
    expect(computeUsableCapital(st({ mode: 'INITIAL_PLUS_PNL', realizedPnl: -600000 }))).toBe(0)
  })

  test('% of available cash: usable = pct×cash − deployed; house modes bypassed', () => {
    // cash 415817 × 25% = 103954.25 (matches the E2E verified figure)
    const s = st({ capitalBase: 'AVAILABLE_CASH_PCT', capitalPct: 25, effectiveInitial: 103954.25, availableCash: 415817, realizedPnl: -5000, deployed: 0 })
    expect(computeUsableCapital(s)).toBe(103954.25)
    const s2 = st({ capitalBase: 'AVAILABLE_CASH_PCT', capitalPct: 100, effectiveInitial: 200000, availableCash: 200000, deployed: 50000 })
    expect(computeUsableCapital(s2)).toBe(150000)
  })
})

describe('capital — explainCapital', () => {
  test('explains each mode in plain language', () => {
    expect(explainCapital(st({ mode: 'PROFIT_ONLY', firstTradeDone: false }))).toContain('First trade pending')
    expect(explainCapital(st({ mode: 'PROFIT_ONLY', firstTradeDone: true, realizedPnl: 3000 }))).toContain('net profit pool')
    expect(explainCapital(st({ mode: 'INITIAL_PLUS_PNL', realizedPnl: 3000 }))).toContain('+ PnL')
    expect(explainCapital(st({ mode: 'INITIAL_WITH_LOSS_REDUCTION', realizedPnl: -3000 }))).toContain('reduced by losses')
    const pct = explainCapital(st({ capitalBase: 'AVAILABLE_CASH_PCT', capitalPct: 25, effectiveInitial: 1000, availableCash: 4000 }))
    expect(pct).toContain('25% of available cash')
  })
})

describe('capital — sizeUnitsForCapital', () => {
  test('floors to whole lots (options, lev 1)', () => {
    // usable 100000, premium 100, lot 75 → 1000 units raw → 13.33 lots → 975
    expect(sizeUnitsForCapital({ usable: 100000, price: 100, instrumentType: 'CE', productType: 'NRML', lotSize: 75 })).toBe(975)
  })

  test('sharePct scales the allocation', () => {
    expect(sizeUnitsForCapital({ usable: 100000, price: 100, instrumentType: 'CE', productType: 'NRML', lotSize: 75, sharePct: 50 })).toBe(450)
  })

  test('HOUSE RULE: absolute allocation can never exceed usable', () => {
    // asks for ₹500000 with usable 100000 → clamped → 975 units
    expect(sizeUnitsForCapital({ usable: 100000, price: 100, instrumentType: 'CE', productType: 'NRML', lotSize: 75, absoluteAmount: 500000 })).toBe(975)
  })

  test('absolute sizing uses the exact rupee amount (abs: tag)', () => {
    // abs ₹20000 at premium 87.75, lot 75 → 20000/87.75 = 227.9 → 3.03 lots → 225
    expect(sizeUnitsForCapital({ usable: 500000, price: 87.75, instrumentType: 'CE', productType: 'NRML', lotSize: 75, absoluteAmount: 20000 })).toBe(225)
  })

  test('MIS equity leverage 5× multiplies the notional', () => {
    // usable 100000 × 5 / 1000 = 500 units (lot 1)
    expect(sizeUnitsForCapital({ usable: 100000, price: 1000, instrumentType: 'EQ', productType: 'MIS', lotSize: 1 })).toBe(500)
  })

  test('zero usable / zero price → 0 units (never throws)', () => {
    expect(sizeUnitsForCapital({ usable: 0, price: 100, instrumentType: 'CE', productType: 'NRML', lotSize: 75 })).toBe(0)
    expect(sizeUnitsForCapital({ usable: 100000, price: 0, instrumentType: 'CE', productType: 'NRML', lotSize: 75 })).toBe(0)
  })

  test('roundToLot:false floors raw units instead of lots', () => {
    expect(sizeUnitsForCapital({ usable: 100000, price: 100, instrumentType: 'CE', productType: 'NRML', lotSize: 75, roundToLot: false })).toBe(1000)
  })
})

describe('capital — marginForUnits', () => {
  test('matches leverageFor', () => {
    expect(marginForUnits(975, 100, 'CE', 'NRML')).toBe(97500)
    expect(marginForUnits(500, 1000, 'EQ', 'MIS')).toBe(100000)
  })
})
