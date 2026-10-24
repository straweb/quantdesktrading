// @ts-nocheck
import { calcCharges, leverageFor, round2 } from '../src/lib/charges'
import type { LegContext } from './registry'
import { newId } from './registry'
import { insertOrder, insertTrade, upsertPosition, getPositions, setCash, getCash, logBroker } from './database'
import type { PositionRecord } from '../src/lib/types'

// ============================================================
// Sandbox execution engine — uniform fill/settlement bookkeeping
// used by every broker adapter when running in sandbox mode
// (sim broker, or live brokers without reachable endpoints).
// Writes into the account's own SQLite DB: orders, trades,
// positions, funds. Realized PnL is net of charges.
// ============================================================

export interface FillResult {
  brokerOrderId: string
  fillPrice: number
  charges: number
  realizedPnl: number
  closed: boolean
}

export function applyFill(ctx: LegContext, fillPrice: number): FillResult {
  const { accountId, brokerType } = ctx
  const { masterSymbol: symbol, exchange, instrumentType, lotSize } = ctx.symbolMap
  const productType = ctx.order.productType
  const units = ctx.order.qty * lotSize
  const now = new Date().toISOString()
  const brokerOrderId = newId(brokerType.slice(0, 3).toUpperCase() + '-')

  // 1. order record
  insertOrder(brokerType, accountId, {
    id: brokerOrderId,
    masterOrderId: ctx.order.masterOrderId,
    strategyId: ctx.order.strategyId,
    symbol, exchange, instrumentType,
    side: ctx.order.side,
    qty: ctx.order.qty,
    filledQty: ctx.order.qty,
    orderType: ctx.order.orderType,
    productType,
    limitPrice: ctx.order.limitPrice,
    triggerPrice: ctx.order.triggerPrice,
    status: 'FILLED',
    avgPrice: fillPrice,
    createdAt: now, updatedAt: now,
  })

  // 2. charges
  const value = fillPrice * units
  const charges = calcCharges({
    instrumentType, productType, side: ctx.order.side, value,
  })

  // 3. position math
  const positions = getPositions(brokerType, accountId)
  const key = (p: PositionRecord) => p.symbol === symbol && p.exchange === exchange && p.productType === productType
  const pos = positions.find(key)
  const sign = ctx.order.side === 'BUY' ? 1 : -1

  let netQty = pos?.netQty ?? 0
  let buyQty = pos?.buyQty ?? 0
  let sellQty = pos?.sellQty ?? 0
  let avgPrice = pos?.avgPrice ?? 0
  let realizedAcc = pos?.realizedPnl ?? 0
  let realizedThisTrade = 0

  if (sign * netQty >= 0) {
    // increasing position
    const newNet = netQty + sign * units
    avgPrice = newNet === 0 ? 0 : (avgPrice * Math.abs(netQty) + fillPrice * units) / Math.abs(newNet)
    netQty = newNet
    if (sign > 0) buyQty += units
    else sellQty += units
  } else {
    // reducing / closing
    const closeUnits = Math.min(units, Math.abs(netQty))
    realizedThisTrade = (fillPrice - avgPrice) * closeUnits * (netQty > 0 ? 1 : -1)
    realizedAcc += realizedThisTrade
    netQty += sign * units
    if (sign > 0) buyQty += units
    else sellQty += units
    if (Math.abs(netQty) < 1e-9) {
      netQty = 0
      avgPrice = 0
    } else if (sign * netQty > 0) {
      // flipped direction
      avgPrice = fillPrice
    }
  }

  const netRealized = round2(realizedThisTrade - charges.total)

  insertTrade(brokerType, accountId, {
    id: newId('T-'),
    orderId: brokerOrderId,
    symbol, exchange, instrumentType, productType,
    side: ctx.order.side,
    qty: units,
    price: fillPrice,
    value: round2(value),
    chargesTotal: charges.total,
    charges,
    realizedPnl: realizedThisTrade !== 0 ? netRealized : -charges.total,
    ts: now,
  })

  if (netQty === 0) {
    // position closed — clear but keep realized
    upsertPosition(brokerType, accountId, {
      symbol, exchange, productType,
      netQty: 0, buyQty: 0, sellQty: 0, avgPrice: 0,
      realizedPnl: round2(realizedAcc),
      ltp: fillPrice, lotSize, updatedAt: now,
    })
  } else {
    upsertPosition(brokerType, accountId, {
      symbol, exchange, instrumentType, productType,
      netQty, buyQty, sellQty,
      avgPrice: round2(avgPrice),
      realizedPnl: round2(realizedAcc),
      ltp: fillPrice, lotSize, updatedAt: now,
    })
  }

  // 4. funds ledger: cash reflects realized pnl and charges
  const cashBefore = getCash(brokerType, accountId)
  const cashAfter = round2(cashBefore + realizedThisTrade - charges.total)
  setCash(brokerType, accountId, cashAfter)

  logBroker(brokerType, accountId, `${ctx.order.side} ${ctx.order.qty}x ${symbol} @ ${fillPrice} chg=${charges.total} pnl=${round2(realizedThisTrade)}`)

  return {
    brokerOrderId,
    fillPrice: round2(fillPrice),
    charges: charges.total,
    realizedPnl: netRealized,
    closed: netQty === 0,
  }
}

export function rejectOrder(ctx: LegContext, message: string) {
  const now = new Date().toISOString()
  const brokerOrderId = newId(ctx.brokerType.slice(0, 3).toUpperCase() + '-R')
  insertOrder(ctx.brokerType, ctx.accountId, {
    id: brokerOrderId,
    masterOrderId: ctx.order.masterOrderId,
    strategyId: ctx.order.strategyId,
    symbol: ctx.symbolMap.masterSymbol,
    exchange: ctx.symbolMap.exchange,
    instrumentType: ctx.symbolMap.instrumentType,
    side: ctx.order.side,
    qty: ctx.order.qty,
    filledQty: 0,
    orderType: ctx.order.orderType,
    productType: ctx.order.productType,
    limitPrice: ctx.order.limitPrice,
    triggerPrice: ctx.order.triggerPrice,
    status: 'REJECTED',
    message,
    createdAt: now, updatedAt: now,
  })
  logBroker(ctx.brokerType, ctx.accountId, `REJECTED ${ctx.symbolMap.masterSymbol}: ${message}`, 'WARN')
  return brokerOrderId
}

export { leverageFor }
