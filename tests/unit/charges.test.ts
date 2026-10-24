import { describe, expect, test } from 'bun:test'
import { calcCharges, leverageFor, round2 } from '../../src/lib/charges'

// Indian broking charges engine — NSE schedules per segment.
// All expected values hand-computed from the RATES table in charges.ts.

describe('charges engine — calcCharges', () => {
  test('EQ intraday BUY: capped brokerage, no STT, stamp on buy', () => {
    // value 100000 → brokerage min(20, 30) = 20, txn 2.97, sebi 0.1, stamp 3,
    // gst 18% × (20+2.97+0.1) = 4.1526 → total 30.2226
    const c = calcCharges({ instrumentType: 'EQ', productType: 'MIS', side: 'BUY', value: 100000 })
    expect(c.brokerage).toBe(20)
    expect(c.stt).toBe(0)
    expect(c.transaction).toBe(2.97)
    expect(c.sebi).toBe(0.1)
    expect(c.stamp).toBe(3)
    expect(c.gst).toBe(4.15)
    expect(c.total).toBe(30.22)
  })

  test('EQ intraday SELL: STT on sell turnover, no stamp', () => {
    // brokerage 20, stt 0.00025×100000 = 25, txn 2.97, sebi 0.1, gst 4.1526
    const c = calcCharges({ instrumentType: 'EQ', productType: 'MIS', side: 'SELL', value: 100000 })
    expect(c.stt).toBe(25)
    expect(c.stamp).toBe(0)
    expect(c.total).toBe(52.22)
  })

  test('EQ delivery BUY: flat brokerage + heavy STT + delivery stamp', () => {
    // brokerage 20 (pct 0), stt 0.001×100000 = 100, stamp 0.00015×100000 = 15
    const c = calcCharges({ instrumentType: 'EQ', productType: 'CNC', side: 'BUY', value: 100000 })
    expect(c.brokerage).toBe(20)
    expect(c.stt).toBe(100)
    expect(c.stamp).toBe(15)
    expect(c.total).toBe(142.22)
  })

  test('options BUY: flat brokerage, zero STT on buy, high txn charge', () => {
    // value 40000 → brokerage 20, txn 0.0003503×40000 = 14.012, sebi 0.04,
    // stamp 0.00003×40000 = 1.2, gst 0.18×34.052 = 6.12936 → total 41.38136
    const c = calcCharges({ instrumentType: 'CE', productType: 'NRML', side: 'BUY', value: 40000 })
    expect(c.brokerage).toBe(20)
    expect(c.stt).toBe(0)
    expect(c.transaction).toBe(14.01)
    expect(c.stamp).toBe(1.2)
    expect(c.gst).toBe(6.13)
    expect(c.total).toBe(41.38)
  })

  test('options SELL: STT 0.1% on premium', () => {
    const c = calcCharges({ instrumentType: 'PE', productType: 'NRML', side: 'SELL', value: 40000 })
    expect(c.stt).toBe(40)
    expect(c.stamp).toBe(0)
    expect(c.total).toBe(80.18)
  })

  test('futures BUY: pct brokerage capped at ₹20, futures txn + stamp', () => {
    // brokerage min(20, 30) = 20, txn 1.73, sebi 0.1, stamp 2, gst 0.18×21.83 = 3.9294
    const c = calcCharges({ instrumentType: 'FUT', productType: 'NRML', side: 'BUY', value: 100000 })
    expect(c.brokerage).toBe(20)
    expect(c.transaction).toBe(1.73)
    expect(c.stamp).toBe(2)
    expect(c.gst).toBe(3.93)
    expect(c.total).toBe(27.76)
  })

  test('negative/zero value is clamped to zero-cost breakdown', () => {
    const c = calcCharges({ instrumentType: 'EQ', productType: 'MIS', side: 'BUY', value: -5 })
    expect(c.total).toBe(0)
  })

  test('REGRESSION: small intraday leg pays pct brokerage, not the ₹20 flat', () => {
    // value 20000 → brokerage min(20, 6) = 6 (was flat 20 before the fix),
    // txn 0.594, sebi 0.02, stamp 0.6, gst 0.18×6.614 = 1.19052 → total 8.40452
    const c = calcCharges({ instrumentType: 'EQ', productType: 'MIS', side: 'BUY', value: 20000 })
    expect(c.brokerage).toBe(6)
    expect(c.transaction).toBe(0.59)
    expect(c.gst).toBe(1.19)
    expect(c.total).toBe(8.4)
  })
})

describe('charges engine — helpers', () => {
  test('round2', () => {
    expect(round2(30.2226)).toBe(30.22)
    expect(round2(1.005)).toBe(1.0) // binary FP: 1.005*100 = 100.49999…
    expect(round2(10)).toBe(10)
  })

  test('leverageFor: options 1, futures 5, equity CNC 1 / MIS 5', () => {
    expect(leverageFor('CE', 'NRML')).toBe(1)
    expect(leverageFor('PE', 'NRML')).toBe(1)
    expect(leverageFor('FUT', 'NRML')).toBe(5)
    expect(leverageFor('EQ', 'CNC')).toBe(1)
    expect(leverageFor('EQ', 'MIS')).toBe(5)
  })
})
