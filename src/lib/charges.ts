import { ChargesBreakdown } from './types'

// ============================================================
// Indian broking charges engine (NSE equity / futures / options)
// Configured close to current NSE schedules; used by every broker
// leg so PnL + capital sizing reflect real costs.
// ============================================================

type Segment = 'EQ_INTRADAY' | 'EQ_DELIVERY' | 'FUT' | 'OPT'

function segmentFor(instrumentType: string, productType: string): Segment {
  if (instrumentType === 'FUT') return 'FUT'
  if (instrumentType === 'CE' || instrumentType === 'PE') return 'OPT'
  return productType === 'CNC' ? 'EQ_DELIVERY' : 'EQ_INTRADAY'
}

interface Rate {
  brokerageFlat: number // flat per order cap (discount broker)
  brokeragePct: number // pct of turnover per order
  sttSell: number // STT/CTT on sell turnover
  sttBuy: number // STT on buy turnover (delivery / options buy)
  txn: number // exchange transaction charge on turnover
  sebi: number // SEBI turnover fee
  stampBuy: number // stamp duty on buy turnover
}

const RATES: Record<Segment, Rate> = {
  EQ_INTRADAY: { brokerageFlat: 20, brokeragePct: 0.0003, sttSell: 0.00025, sttBuy: 0, txn: 0.0000297, sebi: 0.000001, stampBuy: 0.00003 },
  EQ_DELIVERY: { brokerageFlat: 20, brokeragePct: 0, sttSell: 0.001, sttBuy: 0.001, txn: 0.0000297, sebi: 0.000001, stampBuy: 0.00015 },
  FUT: { brokerageFlat: 20, brokeragePct: 0.0003, sttSell: 0.0002, sttBuy: 0, txn: 0.0000173, sebi: 0.000001, stampBuy: 0.00002 },
  OPT: { brokerageFlat: 20, brokeragePct: 0, sttSell: 0.001, sttBuy: 0, txn: 0.0003503, sebi: 0.000001, stampBuy: 0.00003 },
}

export function calcCharges(params: {
  instrumentType: string
  productType: string
  side: 'BUY' | 'SELL'
  value: number // price * qty (premium for options)
  isExitLeg?: boolean
}): ChargesBreakdown {
  const seg = segmentFor(params.instrumentType, params.productType)
  const r = RATES[seg]
  const v = Math.max(0, params.value)

  // pct-of-turnover brokerage capped at the flat rate; flat-only segments
  // (delivery / options) have pct 0 → always the flat fee.
  // (was `params.brokeragePct` — always undefined, making brokerage flat
  //  ₹20 for every segment and overcharging small intraday/futures legs)
  const brokerage = r.brokeragePct > 0 ? Math.min(r.brokerageFlat, v * r.brokeragePct) : r.brokerageFlat
  const stt = (params.side === 'SELL' ? r.sttSell : 0) * v + (params.side === 'BUY' ? r.sttBuy : 0) * v
  const transaction = r.txn * v
  const sebi = r.sebi * v
  const stamp = params.side === 'BUY' ? r.stampBuy * v : 0
  const gst = 0.18 * (brokerage + transaction + sebi)

  const total = brokerage + stt + transaction + sebi + stamp + gst
  return {
    brokerage: round2(brokerage),
    stt: round2(stt),
    transaction: round2(transaction),
    gst: round2(gst),
    sebi: round2(sebi),
    stamp: round2(stamp),
    total: round2(total),
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// MIS leverage used for margin estimation of futures/equity intraday
export function leverageFor(instrumentType: string, productType: string): number {
  if (instrumentType === 'CE' || instrumentType === 'PE') return 1 // premium is full value
  if (instrumentType === 'FUT') return 5
  return productType === 'CNC' ? 1 : 5
}
