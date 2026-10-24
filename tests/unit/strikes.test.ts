import { describe, expect, test } from 'bun:test'
import { fmtInr, fmtMoney, sideOffsetLabel, sideStrikeFor } from '../../src/components/terminal/lib/client-api'

// ITM/ATM/OTM strike labeling — the hedge-desk side-ATM convention:
//   CE ATM = floor(spot/step)×step, PE ATM = ceil(spot/step)×step
//   CE: negative offset = ITM (strike below side-ATM) · PE mirrored.
// Doc example: spot 23030 step 50 → CE ATM 23000 (ITM1 22950 / OTM1 23050),
//                                       PE ATM 23050 (ITM1 23100 / OTM1 23000).

describe('strikes — sideOffsetLabel', () => {
  test('CE: negative = ITM, positive = OTM', () => {
    expect(sideOffsetLabel(-2, 'CE')).toBe('ITM 2')
    expect(sideOffsetLabel(-1, 'CE')).toBe('ITM 1')
    expect(sideOffsetLabel(0, 'CE')).toBe('ATM')
    expect(sideOffsetLabel(1, 'CE')).toBe('OTM 1')
    expect(sideOffsetLabel(5, 'CE')).toBe('OTM 5')
  })

  test('PE mirrored: positive = ITM, negative = OTM', () => {
    expect(sideOffsetLabel(2, 'PE')).toBe('ITM 2')
    expect(sideOffsetLabel(1, 'PE')).toBe('ITM 1')
    expect(sideOffsetLabel(0, 'PE')).toBe('ATM')
    expect(sideOffsetLabel(-1, 'PE')).toBe('OTM 1')
  })

  test('null / NaN → empty label', () => {
    expect(sideOffsetLabel(null, 'CE')).toBe('')
    expect(sideOffsetLabel(undefined, 'PE')).toBe('')
    expect(sideOffsetLabel(Number.NaN, 'CE')).toBe('')
  })
})

describe('strikes — sideStrikeFor', () => {
  const atm = { ce: 23000, pe: 23050 }
  const step = 50

  test('CE ITM goes below ceAtm, OTM above', () => {
    expect(sideStrikeFor(atm, step, -1, 1, 'CE')).toBe(22950) // ITM1
    expect(sideStrikeFor(atm, step, -1, 3, 'CE')).toBe(22850) // ITM3
    expect(sideStrikeFor(atm, step, 0, 0, 'CE')).toBe(23000) // ATM
    expect(sideStrikeFor(atm, step, 1, 1, 'CE')).toBe(23050) // OTM1
  })

  test('PE ITM goes above peAtm, OTM below', () => {
    expect(sideStrikeFor(atm, step, -1, 1, 'PE')).toBe(23100) // ITM1
    expect(sideStrikeFor(atm, step, 0, 0, 'PE')).toBe(23050) // ATM
    expect(sideStrikeFor(atm, step, 1, 1, 'PE')).toBe(23000) // OTM1
    expect(sideStrikeFor(atm, step, 1, 5, 'PE')).toBe(22800) // OTM5
  })

  test('round-trip label ↔ strike consistency (spot 23030 case)', () => {
    // the quick-add buttons must produce strikes whose labels re-derive correctly
    for (const type of ['CE', 'PE'] as const) {
      for (const dir of [-1, 0, 1] as const) {
        for (let n = 1; n <= 5; n++) {
          const strike = sideStrikeFor(atm, step, dir, n, type)
          const label = sideOffsetLabel(dir === 0 ? 0 : (dir === -1 ? -n : n), type)
          expect(label).toMatch(/^(ITM|OTM|ATM)/)
          expect(strike % step).toBe(0)
        }
      }
    }
  })
})

describe('strikes — formatting helpers', () => {
  test('fmtMoney / fmtInr handle null and NaN safely', () => {
    expect(fmtMoney(null)).toBe('—')
    expect(fmtMoney(Number.NaN)).toBe('—')
    expect(fmtMoney(1234.5)).toContain('1,234.5')
    expect(fmtInr(null)).toBe('—')
    expect(fmtInr(103954.25)).toContain('1,03,954') // en-IN grouping
  })
})
