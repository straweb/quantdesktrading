// @ts-nocheck
import { db } from '../db'
import { getAdapter, type LegContext, type SymbolMapInfo } from '../../../brokers/index'
import { getOpenOrders, updateOrder, getPositions, logBroker } from '../../../brokers/database'
import { applyFill } from '../../../brokers/execution'
import { fetchQuotes } from '../../../brokers/feed-client'
import { marginForUnits, onTradeSettled } from './capital-service'
import { round2 } from '../charges'

// ============================================================
// Live order reconciliation.
// Sandbox legs settle instantly (applyFill), but orders accepted by
// REAL broker APIs (Dhan v2 / Shoonya Noren / ICICI Breeze) rest as
// OPEN until the broker fills them. This loop polls each live
// account's broker order book every 5s and reconciles:
//   · broker FILLED  -> applyFill at the broker's avg price
//                       (charges/positions/funds/audit single-sourced)
//   · broker CANCELLED/REJECTED -> local order closed out
// Accounts without live credentials are skipped entirely.
// ============================================================

// globalThis state — hot-reload-safe singleton + wedged-tick recovery
const gSync = globalThis as unknown as {
  __liveSyncTimer?: ReturnType<typeof setInterval>
  __liveSyncBusyAt?: number
}

export function ensureLiveOrderSync() {
  if (gSync.__liveSyncTimer) return
  gSync.__liveSyncTimer = setInterval(() => { void syncOnce() }, 5000)
  console.log('[live-order-sync] started (5s reconciliation loop)')
}

async function syncOnce() {
  const busyAt = gSync.__liveSyncBusyAt ?? 0
  if (busyAt && Date.now() - busyAt < 60_000) return
  gSync.__liveSyncBusyAt = Date.now()
  try {
    const accounts = await db.brokerAccount.findMany({
      where: { isActive: true, status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
    })
    if (accounts.length === 0) return

    const { decryptJson } = await import('../crypto')

    for (const acc of accounts) {
      const adapter = getAdapter(acc.brokerType as never)
      if (!adapter?.getOrderBook) continue
      const creds = decryptJson(acc.credentialsEnc)
      if (!creds) continue // sandbox-only account — nothing to reconcile

      const open = getOpenOrders(acc.brokerType, acc.id)
      if (open.length === 0) continue

      const ctx: LegContext = {
        accountId: acc.id,
        accountLabel: acc.label,
        brokerType: acc.brokerType as never,
        credentials: creds,
        order: {
          side: 'BUY', qty: 0, orderType: 'MARKET', productType: 'MIS', masterOrderId: '', source: 'SYSTEM',
        },
        symbolMap: { masterSymbol: '', exchange: '', instrumentType: '', lotSize: 1, brokerSymbol: '' } as SymbolMapInfo,
        ltp: 0,
      }

      let book: Awaited<ReturnType<NonNullable<typeof adapter.getOrderBook>>>
      try {
        book = await adapter.getOrderBook(ctx)
      } catch (e) {
        logBroker(acc.brokerType, acc.id, `order book poll failed: ${e instanceof Error ? e.message : String(e)}`, 'WARN')
        continue
      }
      if (!book || book.length === 0) continue
      const byId = new Map(book.map(r => [r.brokerOrderId, r] as const))

      for (const o of open) {
        if (!o.masterOrderId) continue
        const row = byId.get(o.id)
        if (!row) continue

        if (row.status === 'FILLED') {
          // resolve master instrument for correct charges/position keys
          const master = await db.symbolMaster.findFirst({ where: { symbol: o.symbol, exchange: o.exchange } })
          const lotSize = master?.lotSize ?? 1
          const ltpQ = await fetchQuotes([o.symbol])
          const ltp = ltpQ[o.symbol]?.ltp ?? row.avgPrice ?? o.avgPrice ?? 0
          const legStrategyId = (o as { strategyId?: string }).strategyId ?? undefined

          const fillCtx: LegContext = {
            ...ctx,
            order: {
              side: o.side as 'BUY' | 'SELL',
              qty: o.qty,
              orderType: o.orderType as never,
              productType: o.productType as never,
              limitPrice: o.limitPrice,
              triggerPrice: o.triggerPrice,
              masterOrderId: o.masterOrderId,
              strategyId: legStrategyId,
              source: 'SYSTEM',
            },
            symbolMap: {
              masterSymbol: o.symbol,
              exchange: o.exchange,
              instrumentType: master?.instrumentType ?? 'EQ',
              lotSize,
              brokerSymbol: o.symbol,
            } as SymbolMapInfo,
            ltp,
          }

          // margin delta bookkeeping (mirrors order-router)
          const posBefore = getPositions(acc.brokerType, acc.id).find(
            p => p.symbol === o.symbol && p.exchange === o.exchange && p.productType === o.productType,
          )
          const marginBefore = posBefore && posBefore.avgPrice > 0
            ? marginForUnits(Math.abs(posBefore.netQty), posBefore.avgPrice, fillCtx.symbolMap.instrumentType, o.productType as never)
            : 0

          const fill = applyFill(fillCtx, row.avgPrice ?? ltp)
          const posAfter = getPositions(acc.brokerType, acc.id).find(
            p => p.symbol === o.symbol && p.exchange === o.exchange && p.productType === o.productType,
          )
          const marginAfter = posAfter && posAfter.avgPrice > 0
            ? marginForUnits(Math.abs(posAfter.netQty), posAfter.avgPrice, fillCtx.symbolMap.instrumentType, o.productType as never)
            : 0

          updateOrder(acc.brokerType, acc.id, o.id, {
            status: 'FILLED',
            filledQty: o.qty,
            avgPrice: fill.fillPrice,
            message: `Live fill reconciled (broker ${row.rawStatus ?? 'complete'})`,
          })
          await onTradeSettled({
            accountId: acc.id,
            realizedNetPnl: fill.realizedPnl,
            charges: fill.charges,
            marginDelta: round2(marginAfter - marginBefore),
          })
          logBroker(acc.brokerType, acc.id, `LIVE FILL reconciled ${o.symbol} ${o.qty}x @ ${fill.fillPrice}`)
        } else if (row.status === 'CANCELLED' || row.status === 'REJECTED') {
          updateOrder(acc.brokerType, acc.id, o.id, {
            status: row.status,
            message: `Broker closed the order (${row.rawStatus ?? row.status})`,
          })
          logBroker(acc.brokerType, acc.id, `LIVE ${row.status} reconciled: ${o.symbol} ${o.id}`)
        }
      }
    }
  } catch (e) {
    console.error('[live-order-sync]', e)
  } finally {
    gSync.__liveSyncBusyAt = 0
  }
}
