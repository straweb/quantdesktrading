// @ts-nocheck
import type { BrokerAdapter, LegContext, OrderLegResult, SymbolMapInfo } from '../registry'
import { registerAdapter, newId } from '../registry'
import { applyFill, rejectOrder } from '../execution'
import { getOpenOrders, updateOrder, insertOrder, logBroker } from '../database'

// ============================================================
// SIMFEED broker — in-sandbox simulated broker matched against
// the market-feed mini-service LTP. Market orders fill instantly
// with slippage; limit orders rest until LTP crosses.
// ============================================================

const SLIPPAGE_PCT = 0.02

function fillPriceFor(ctx: LegContext): number | null {
  const ltp = ctx.ltp
  if (ctx.order.orderType === 'MARKET') {
    const slip = ltp * SLIPPAGE_PCT / 100
    return ctx.order.side === 'BUY' ? ltp + slip : ltp - slip
  }
  if (ctx.order.orderType === 'LIMIT' && ctx.order.limitPrice) {
    if (ctx.order.side === 'BUY' && ltp <= ctx.order.limitPrice) return ctx.order.limitPrice
    if (ctx.order.side === 'SELL' && ltp >= ctx.order.limitPrice) return ctx.order.limitPrice
    return null // rests
  }
  return null
}

const simfeedAdapter: BrokerAdapter = {
  brokerType: 'SIMFEED',
  isLiveCapable: () => true, // fully self-contained simulation

  mapSymbol(master) {
    // sim uses canonical symbols directly
    let brokerSymbol = master.symbol
    if (master.instrumentType === 'FUT') {
      const exp = master.expiry?.replaceAll('-', '').slice(2) ?? ''
      brokerSymbol = `${master.symbol}${exp}FUT`
    } else if (master.instrumentType === 'CE' || master.instrumentType === 'PE') {
      const exp = master.expiry?.replaceAll('-', '').slice(2) ?? ''
      brokerSymbol = `${master.symbol}${exp}${master.strike}${master.optionType}`
    }
    return { brokerSymbol, brokerToken: master.symbol }
  },

  modeLabel: () => 'Simulated (Sim Feed LTP)',

  async placeOrder(ctx: LegContext): Promise<OrderLegResult> {
    const price = fillPriceFor(ctx)
    if (price !== null) {
      const fill = applyFill(ctx, price)
      return {
        accountId: ctx.accountId,
        accountLabel: ctx.accountLabel,
        brokerType: ctx.brokerType,
        brokerOrderId: fill.brokerOrderId,
        status: 'FILLED',
        qty: ctx.order.qty,
        price: fill.fillPrice,
        message: `Sim fill @ ${fill.fillPrice}`,
      }
    }
    // resting limit order
    const now = new Date().toISOString()
    const id = newId('SIM-')
    insertOrder('SIMFEED', ctx.accountId, {
      id,
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
      status: 'OPEN',
      message: 'Resting limit order',
      createdAt: now, updatedAt: now,
    })
    logBroker('SIMFEED', ctx.accountId, `OPEN ${ctx.order.side} ${ctx.order.qty}x ${ctx.symbolMap.masterSymbol} lim=${ctx.order.limitPrice}`)
    return {
      accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: ctx.brokerType,
      brokerOrderId: id, status: 'OPEN', qty: ctx.order.qty, message: 'Limit order resting',
    }
  },

  async cancelOrder(_ctx, brokerOrderId) {
    // cancel any resting order matching id across the account DB
    const open = getOpenOrders('SIMFEED', _ctx.accountId)
    const target = open.find(o => o.id === brokerOrderId)
    if (!target) return { ok: false, message: 'Order not open / not found' }
    updateOrder('SIMFEED', _ctx.accountId, brokerOrderId, { status: 'CANCELLED', message: 'Cancelled by user' })
    return { ok: true }
  },
}

registerAdapter(simfeedAdapter)
export default simfeedAdapter
