// @ts-nocheck
import { db } from '../db'
import { getOpenOrders, updateOrder, getPositions } from '../../../brokers/database'
import { fetchQuotes } from '../../../brokers/feed-client'
import { placeMasterOrder } from './order-router'
import type { BrokerAccount } from '@prisma/client'

// ============================================================
// Resting-order monitor.
// Sandbox brokers rest LIMIT / SL / SL-M orders as OPEN; this
// loop watches the sim feed LTP and executes them when their
// level is crossed — so Entry (limit), Target (limit) and
// StopLoss (SL-M) placed from the strike panel actually fire.
//
// Markers:
//  · orders tagged strategyId='reduce' are exits — they are
//    capped at the held qty and cancelled if the position is
//    already flat / on the wrong side.
//  · re-execution goes through placeMasterOrder(source SYSTEM)
//    so settlement, charges and audit stay single-sourced.
// ============================================================

const MONITOR_TAG = 'reduce'

let started = false
let running = false

export function ensureOrderMonitor() {
  if (started) return
  started = true
  setInterval(() => { void monitorOnce() }, 1000)
}

interface MonOrder {
  id: string
  strategyId?: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  orderType: string
  productType: string
  limitPrice?: number
  triggerPrice?: number
}

/** Has this resting order's trigger condition been met at `ltp`? */
function triggered(o: MonOrder, ltp: number): boolean {
  if (o.orderType === 'LIMIT') {
    if (!o.limitPrice) return false
    return o.side === 'BUY' ? ltp <= o.limitPrice : ltp >= o.limitPrice
  }
  if (o.orderType === 'SL-M' || o.orderType === 'SL') {
    if (!o.triggerPrice) return false
    return o.side === 'BUY' ? ltp >= o.triggerPrice : ltp <= o.triggerPrice
  }
  return false
}

async function monitorOnce() {
  if (running) return
  running = true
  try {
    const accounts = (await db.brokerAccount.findMany({
      where: { isActive: true, status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
    })) as BrokerAccount[]
    if (accounts.length === 0) return

    // collect resting orders per account
    const perAcc: { acc: BrokerAccount; orders: MonOrder[] }[] = []
    for (const acc of accounts) {
      const orders = getOpenOrders(acc.brokerType, acc.id).filter(o => o.orderType !== 'MARKET') as MonOrder[]
      if (orders.length > 0) perAcc.push({ acc, orders })
    }
    if (perAcc.length === 0) return

    const syms = [...new Set(perAcc.flatMap(a => a.orders.map(o => o.symbol)))]
    const quotes = await fetchQuotes(syms)

    for (const { acc, orders } of perAcc) {
      for (const o of orders) {
        const q = quotes[o.symbol]

        // exits ('reduce' tag): if the position they attach to is already
        // flat / on the wrong side, cancel them immediately — no need to
        // wait for the trigger level to be crossed.
        if (o.strategyId === MONITOR_TAG) {
          const pos = getPositions(acc.brokerType, acc.id).find(
            p => p.symbol === o.symbol && p.exchange === o.exchange && p.productType === o.productType,
          )
          const heldLots = pos
            ? (o.side === 'SELL'
                ? (pos.netQty > 0 ? Math.floor(pos.netQty / (pos.lotSize || 1)) : 0)
                : (pos.netQty < 0 ? Math.floor(-pos.netQty / (pos.lotSize || 1)) : 0))
            : 0
          if (heldLots <= 0) {
            updateOrder(acc.brokerType, acc.id, o.id, { status: 'CANCELLED', message: 'Auto-cancelled — position closed' })
            continue
          }
        }

        if (!q || !triggered(o, q.ltp)) continue

        // exits: cap the fired qty at what is actually held
        let qty = o.qty
        if (o.strategyId === MONITOR_TAG) {
          const pos = getPositions(acc.brokerType, acc.id).find(
            p => p.symbol === o.symbol && p.exchange === o.exchange && p.productType === o.productType,
          )
          const heldLots = pos
            ? (o.side === 'SELL'
                ? (pos.netQty > 0 ? Math.floor(pos.netQty / (pos.lotSize || 1)) : 0)
                : (pos.netQty < 0 ? Math.floor(-pos.netQty / (pos.lotSize || 1)) : 0))
            : 0
          if (heldLots <= 0) {
            updateOrder(acc.brokerType, acc.id, o.id, { status: 'CANCELLED', message: 'Auto-cancelled — no position to close' })
            continue
          }
          qty = Math.min(qty, heldLots)
        }

        // retire the resting order first (idempotent across ticks)
        updateOrder(acc.brokerType, acc.id, o.id, { status: 'CANCELLED', message: `Triggered @ ${q.ltp} — executing` })

        try {
          await placeMasterOrder({
            symbol: o.symbol,
            exchange: o.exchange,
            side: o.side,
            qty,
            // SL-M fires at market; LIMIT / SL fill at their limit price
            orderType: o.orderType === 'SL-M' ? 'MARKET' : 'LIMIT',
            productType: o.productType as never,
            limitPrice: o.orderType === 'SL-M' ? undefined : o.limitPrice,
            source: 'SYSTEM',
            legAccounts: [acc.id],
          })
        } catch (e) {
          console.error(`[order-monitor] re-execute ${o.symbol} ${acc.label}:`, e)
        }
      }
    }
  } catch (e) {
    console.error('[order-monitor]', e)
  } finally {
    running = false
  }
}
