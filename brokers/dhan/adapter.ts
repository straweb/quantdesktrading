// @ts-nocheck
import type {
  BrokerAdapter, LegContext, OrderLegResult,
  BrokerBookRow, BrokerTradeRow, BrokerPositionRow, BrokerFundsRow, BrokerQuoteRow, ModifyPatch,
} from '../registry'
import { registerAdapter } from '../registry'
import { applyFill, rejectOrder } from '../execution'
import { logBroker } from '../database'
import { liveFetch, num, normalizeStatus } from '../live-api'
import { isSimDisabled } from '../sim-mode'

// ============================================================
// Dhan broker plugin — Dhan API v2 (REST). Full live surface:
//   POST   /orders                 place
//   PUT    /orders/{id}            modify
//   DELETE /orders/{id}            cancel
//   GET    /orders                 order book
//   GET    /orders/{id}            order detail / status
//   GET    /trades                 trade book
//   GET    /positions              position book
//   GET    /fundlimit              funds / margin
//   POST   /marketfeed/quote       L1 quote
// Auth header: access-token. Docs: https://dhanhq.co/docs/v2/
// Sandbox mode: if credentials absent or API unreachable, the leg
// executes against the sandbox engine (sim LTP) and is flagged.
// ============================================================

const BASE = 'https://api.dhan.co/v2'

function headers(creds: Record<string, string> | null): Record<string, string> {
  return {
    'access-token': creds?.accessToken ?? '',
    // v2 recommends client-id alongside the token (from the OAuth consent flow)
    ...(creds?.clientId ? { 'client-id': creds.clientId } : {}),
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
}

function mapTransactionType(side: 'BUY' | 'SELL') { return side } // Dhan uses BUY/SELL
function mapProduct(p: 'MIS' | 'CNC' | 'NRML') { return p === 'CNC' ? 'CNC' : p === 'MIS' ? 'INTRADAY' : 'MARGIN' }
function mapOrderType(t: string) { return t === 'MARKET' ? 'MARKET' : t === 'LIMIT' ? 'LIMIT' : t === 'SL' ? 'STOP_LOSS' : 'STOP_LOSS_MARKET' }
function mapSegment(exchange: string, instrumentType?: string): string {
  // Dhan exchange segments (scrip master SEM_SEGMENT mapping — hedging parity):
  // indices live in IDX_I, NSE eq in NSE_EQ, derivatives in NSE_FNO/BSE_FNO
  if (instrumentType === 'INDEX') return 'IDX_I'
  switch (exchange) {
    case 'NFO': return 'NSE_FNO'
    case 'BFO': return 'BSE_FNO'
    case 'BSE': return 'BSE_EQ'
    case 'MCX': return 'MCX_COMM'
    case 'CDS': return 'NSE_CURRENCY'
    default: return 'NSE_EQ'
  }
}

/** tagged live fetch — every outbound Dhan call logs [DHAN][tag] with status + latency */
function lf<T>(ctx: LegContext, tag: string, url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  return liveFetch<T>(url, { ...init, callTag: { broker: 'DHAN', accountId: ctx.accountId, tag } })
}

function livePayload(ctx: LegContext) {
  const units = ctx.order.qty * ctx.symbolMap.lotSize
  return {
    dhanClientId: ctx.credentials?.clientId ?? '',
    transactionType: mapTransactionType(ctx.order.side),
    exchangeSegment: mapSegment(ctx.symbolMap.exchange, ctx.symbolMap.instrumentType),
    productType: mapProduct(ctx.order.productType),
    orderType: mapOrderType(ctx.order.orderType),
    validity: 'DAY',
    securityId: ctx.symbolMap.brokerToken,
    quantity: units,
    price: ctx.order.limitPrice ? Number(ctx.order.limitPrice.toFixed(2)) : 0,
    triggerPrice: ctx.order.triggerPrice ? Number(ctx.order.triggerPrice.toFixed(2)) : 0,
    disclosed_quantity: 0,
    afterMarketOrder: false,
    tag: (ctx.order.source + (ctx.order.strategyId ? ':' + ctx.order.strategyId : '')).slice(0, 20),
  }
}

/** Dhan order-book row -> normalized row. */
function toBookRow(o: Record<string, unknown>): BrokerBookRow {
  return {
    brokerOrderId: String(o.orderId ?? ''),
    symbol: String(o.tradingSymbol ?? o.securityId ?? ''),
    side: String(o.transactionType ?? ''),
    qty: num(o.quantity) ?? 0,
    filledQty: num(o.filledQty) ?? num(o.filled_qty) ?? (normalizeStatus(o.orderStatus as string) === 'FILLED' ? num(o.quantity) ?? 0 : 0),
    status: normalizeStatus(o.orderStatus as string),
    rawStatus: String(o.orderStatus ?? ''),
    avgPrice: num(o.averageTradedPrice) ?? num(o.price) ?? undefined,
    orderType: String(o.orderType ?? ''),
    ts: String(o.orderTimestamp ?? o.exchangeTime ?? ''),
  }
}

const dhanAdapter: BrokerAdapter = {
  brokerType: 'DHAN',
  isLiveCapable: () => true,

  mapSymbol(master) {
    // Dhan uses numeric securityIds; deterministic sandbox tokens, real tokens
    // come from the daily master contract CSV in live deployments.
    let hash = 0
    const key = `${master.symbol}|${master.instrumentType}|${master.expiry ?? ''}|${master.strike ?? ''}`
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 1
    const token = String(10000 + (hash % 89999))
    let brokerSymbol = master.symbol
    if (master.instrumentType === 'FUT') brokerSymbol = `${master.symbol}-${master.expiry}-FUT`
    else if (master.instrumentType === 'CE' || master.instrumentType === 'PE') brokerSymbol = `${master.symbol}-${master.strike}-${master.optionType}-${master.expiry}`
    return { brokerSymbol, brokerToken: token }
  },

  modeLabel(creds) {
    return creds?.accessToken ? 'Live (Dhan API v2)' : 'Sandbox (no access token)'
  },

  sessionKind() { return 'daily' }, // Dhan access tokens expire daily (24h)

  async placeOrder(ctx: LegContext): Promise<OrderLegResult> {
    const units = ctx.order.qty * ctx.symbolMap.lotSize
    if (ctx.credentials?.accessToken) {
      try {
        const res = await lf<{ orderId?: string; remarks?: string; errorMessage?: string; errorCode?: string }>(ctx, 'place-order', `${BASE}/orders`, {
          method: 'POST',
          headers: headers(ctx.credentials),
          body: JSON.stringify(livePayload(ctx)),
        })
        if (res.ok && res.data?.orderId) {
          logBroker('DHAN', ctx.accountId, `LIVE order ${res.data.orderId} ${ctx.order.side} ${units} ${ctx.symbolMap.brokerSymbol}`)
          return {
            accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'DHAN',
            brokerOrderId: res.data.orderId, status: 'OPEN', qty: ctx.order.qty, message: 'Live order accepted by Dhan',
          }
        }
        logBroker('DHAN', ctx.accountId, `API error: ${res.data?.errorMessage ?? res.error ?? res.status}`, 'WARN')
        // fall through to sandbox
      } catch {
        logBroker('DHAN', ctx.accountId, 'API unreachable — sandbox fallback', 'WARN')
      }
    }
    // sandbox execution — HARD-DISABLED in Live-Only mode (admin checkbox)
    if (isSimDisabled()) {
      rejectOrder(ctx, 'REJECTED (Live-Only mode — sandbox fills disabled)')
      logBroker('DHAN', ctx.accountId, 'order REJECTED — Live-Only mode disables sandbox fills (create the broker session)', 'ERROR')
      return {
        accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'DHAN',
        brokerOrderId: '', status: 'REJECTED', qty: ctx.order.qty,
        message: 'Live-Only mode: broker session/API required — sandbox fills disabled',
      }
    }
    if (!ctx.credentials?.accessToken) {
      rejectOrder(ctx, 'Sandbox fill (no live credentials)') // audit trail only
    }
    const slip = ctx.ltp * 0.0003
    const price = ctx.order.side === 'BUY' ? ctx.ltp + slip : ctx.ltp - slip
    const fill = applyFill(ctx, price)
    return {
      accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'DHAN',
      brokerOrderId: fill.brokerOrderId, status: 'FILLED', qty: ctx.order.qty,
      price: fill.fillPrice, message: 'SANDBOX fill (Dhan unreachable/no token)', sandbox: true,
    }
  },

  async modifyOrder(ctx, brokerOrderId, patch: ModifyPatch) {
    if (!ctx.credentials?.accessToken) return { ok: false, message: 'no live credentials' }
    const payload = { ...livePayload(ctx), orderId: brokerOrderId }
    if (patch.qty != null) payload.quantity = patch.qty * ctx.symbolMap.lotSize
    if (patch.limitPrice != null) payload.price = Number(patch.limitPrice.toFixed(2))
    if (patch.triggerPrice != null) payload.triggerPrice = Number(patch.triggerPrice.toFixed(2))
    if (patch.orderType) payload.orderType = mapOrderType(patch.orderType)
    const res = await lf<{ orderId?: string; errorMessage?: string }>(ctx, 'modify-order', `${BASE}/orders/${brokerOrderId}`, {
      method: 'PUT', headers: headers(ctx.credentials), body: JSON.stringify(payload),
    })
    const ok = res.ok && !!res.data?.orderId
    logBroker('DHAN', ctx.accountId, `LIVE modify ${brokerOrderId}: ${ok ? 'ok' : res.data?.errorMessage ?? res.error}`, ok ? 'INFO' : 'WARN')
    return { ok, message: ok ? 'Live order modified' : res.data?.errorMessage ?? res.error }
  },

  async cancelOrder(ctx, brokerOrderId) {
    if (ctx.credentials?.accessToken) {
      const res = await lf<unknown>(ctx, 'cancel-order', `${BASE}/orders/${brokerOrderId}`, {
        method: 'DELETE', headers: headers(ctx.credentials), timeoutMs: 3000,
      })
      if (res.ok) return { ok: true, message: 'Live order cancelled' }
    }
    return { ok: true, message: 'Sandbox cancel attempted' }
  },

  async getOrderBook(ctx) {
    if (!ctx.credentials?.accessToken) return []
    const res = await lf<Record<string, unknown>[]>(ctx, 'order-book', `${BASE}/orders`, { headers: headers(ctx.credentials) })
    if (!res.ok || !Array.isArray(res.data)) return []
    return res.data.map(toBookRow)
  },

  async getOrderStatus(ctx, brokerOrderId) {
    if (!ctx.credentials?.accessToken) return null
    const res = await lf<Record<string, unknown>>(ctx, 'order-status', `${BASE}/orders/${brokerOrderId}`, { headers: headers(ctx.credentials) })
    if (!res.ok || !res.data?.orderId) return null
    return toBookRow(res.data)
  },

  async getTradeBook(ctx) {
    if (!ctx.credentials?.accessToken) return []
    const res = await lf<Record<string, unknown>[]>(ctx, 'trade-book', `${BASE}/trades`, { headers: headers(ctx.credentials) })
    if (!res.ok || !Array.isArray(res.data)) return []
    return res.data.map(t => ({
      tradeId: String(t.exchangeTradeId ?? t.tradeId ?? ''),
      orderId: String(t.orderId ?? ''),
      symbol: String(t.tradingSymbol ?? ''),
      side: String(t.transactionType ?? t.trantype ?? ''),
      qty: num(t.tradeQuantity ?? t.quantity) ?? 0,
      price: num(t.tradedPrice ?? t.price) ?? 0,
      ts: String(t.tradedTime ?? ''),
    }))
  },

  async getPositionsLive(ctx) {
    if (!ctx.credentials?.accessToken) return []
    const res = await lf<Record<string, unknown>[]>(ctx, 'positions', `${BASE}/positions`, { headers: headers(ctx.credentials) })
    if (!res.ok || !Array.isArray(res.data)) return []
    return res.data
      .filter(p => String(p.positionType ?? 'CLOSED') !== 'CLOSED' || num(p.netQty) !== 0)
      .map(p => ({
        symbol: String(p.tradingSymbol ?? p.securityId ?? ''),
        netQty: num(p.netQty) ?? 0,
        avgPrice: num(p.avgCostPrice ?? p.costPrice) ?? 0,
        pnl: (num(p.realizedProfit) ?? 0) + (num(p.unrealizedProfit) ?? 0),
        productType: String(p.productId ?? ''),
      }))
  },

  async getFunds(ctx) {
    if (!ctx.credentials?.accessToken) return { cash: 0 }
    const res = await lf<Record<string, unknown>>(ctx, 'funds', `${BASE}/fundlimit`, { headers: headers(ctx.credentials) })
    if (!res.ok || !res.data) return { cash: 0 }
    // NOTE: Dhan v2 spells the field "availabelBalance" (their typo) — handle both
    const cash = num(res.data.availabelBalance) ?? num(res.data.availableBalance) ?? num(res.data.withdrawableBalance) ?? 0
    return { cash, available: num(res.data.withdrawableBalance) ?? cash, utilized: num(res.data.utilizedAmount) ?? 0 }
  },

  async getHoldings(ctx) {
    if (!ctx.credentials?.accessToken) return []
    const res = await lf<{ data?: Record<string, unknown>[] }>(ctx, 'holdings', `${BASE}/holdings`, { headers: headers(ctx.credentials), timeoutMs: 6000 })
    if (!res.ok || !Array.isArray(res.data?.data)) return []
    return res.data!.data.map(h => ({
      symbol: String(h.tradingSymbol ?? h.displayName ?? h.securityId ?? ''),
      isin: h.isin ? String(h.isin) : undefined,
      qty: num(h.totalQty) ?? num(h.quantity) ?? 0,
      avgPrice: num(h.averagePrice) ?? num(h.avgPrice) ?? 0,
      ltp: num(h.lastPrice) ?? num(h.convertedAvgPrice) ?? undefined,
      pnl: num(h.unrealizedProfit) ?? undefined,
      product: String(h.productType ?? 'CNC'),
    }))
  },

  async marginCalc(ctx, params) {
    if (!ctx.credentials?.accessToken) return null
    const funds = await this.getFunds!(ctx)
    const res = await lf<Record<string, unknown>>(ctx, 'margin-calc', `${BASE}/margincalculator`, {
      method: 'POST', headers: headers(ctx.credentials), timeoutMs: 5000,
      body: JSON.stringify({
        dhanClientId: ctx.credentials.clientId ?? '',
        exchangeSegment: mapSegment(ctx.symbolMap.exchange, ctx.symbolMap.instrumentType),
        transactionType: params.side,
        quantity: params.qty,
        productType: params.productType === 'MIS' ? 'INTRADAY' : 'CNC',
        securityId: ctx.symbolMap.brokerToken ?? '',
        price: params.price,
        triggerPrice: 0,
      }),
    })
    if (!res.ok || !res.data) return { required: 0, available: funds.cash, detail: 'margin API unreachable — using funds snapshot' }
    const d = res.data as Record<string, unknown>
    const varMargin = num(d.varMargin) ?? 0
    const span = num(d.spanMargin) ?? 0
    const exposure = num(d.exposureMargin) ?? 0
    const leverage = num(d.leverage) ?? num(d.marginFractionDenominator) ?? undefined
    return { required: varMargin + span + exposure, available: funds.cash, span, exposure, leverage }
  },

  async getQuote(ctx, token) {
    if (!ctx.credentials?.accessToken) return { symbol: token, ltp: 0 }
    const segment = mapSegment(ctx.symbolMap.exchange, ctx.symbolMap.instrumentType)
    const res = await lf<{ data?: Record<string, Record<string, unknown>> }>(ctx, 'quote', `${BASE}/marketfeed/quote`, {
      method: 'POST', headers: headers(ctx.credentials), timeoutMs: 3000,
      body: JSON.stringify({ [segment]: [token] }),
    })
    const q = res.data?.data?.[segment]
    if (!q) return { symbol: token, ltp: 0 }
    const ohlc = (q.ohlc ?? {}) as Record<string, unknown>
    const depth = (q.depth ?? {}) as { buy?: Record<string, unknown>[]; sell?: Record<string, unknown>[] }
    return {
      symbol: token,
      ltp: num(q.last_price) ?? 0,
      bid: num(depth.buy?.[0]?.price),
      ask: num(depth.sell?.[0]?.price),
      open: num(ohlc.open), high: num(ohlc.high), low: num(ohlc.low), prevClose: num(ohlc.close),
      volume: num(q.volume),
    }
  },
}

registerAdapter(dhanAdapter)
export default dhanAdapter
