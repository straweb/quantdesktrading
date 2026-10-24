// @ts-nocheck
import type {
  BrokerAdapter, LegContext, OrderLegResult,
  BrokerBookRow, BrokerTradeRow, BrokerPositionRow, BrokerFundsRow, ModifyPatch,
} from '../registry'
import { registerAdapter } from '../registry'
import { applyFill, rejectOrder } from '../execution'
import { logBroker } from '../database'
import { num, normalizeStatus } from '../live-api'
import { isSimDisabled } from '../sim-mode'
import {
  breezeRequest, breezeInstrumentParams, parseBreezeQuoteRow, firstSuccess, successList, isAuthError,
  type BreezeCreds, type BreezeRes,
} from './breeze'

// ============================================================
// ICICI Direct Breeze broker plugin — Breeze REST API v1.
//
// EVERY call goes through breezeRequest (checksum headers + params
// as request body + `{Status, Success, Error}` envelope), matching
// breeze_connect 1.0.69 / the straweb-hedging port exactly:
//   GET  funds                → funds snapshot
//   GET  quotes               → L1 quote
//   POST order                → place (Success.order_id)
//   PUT  order                → modify
//   DELETE order              → cancel
//   GET  order                → order book (exchange + date window)
//   GET  trades               → trade book
//   GET  portfoliopositions   → positions
//   GET  portfolioholdings    → demat
//   GET  customer/margins     → margin estimate (action params)
// Sandbox mode only when no session (or Live-Only mode disables it).
// ============================================================

function creds2breeze(c: Record<string, string> | null | undefined): BreezeCreds {
  return {
    apiKey: c?.apiKey,
    apiSecret: c?.apiSecret,
    sessionToken: c?.sessionToken,
    userId: c?.userId,
    apiSession: c?.apiSession,
  }
}

/** tagged logging so Admin → Broker Diagnostics shows every Breeze call */
function loggerFor(ctx: LegContext, tag: string) {
  return (line: string, level: 'INFO' | 'WARN' = 'INFO') => {
    logBroker('ICICI_BREEZE', ctx.accountId, `${tag}: ${line}`, level)
  }
}

const EXCH_UP: Record<string, string> = { NSE: 'NSE', BSE: 'BSE', NFO: 'NFO', BFO: 'BFO', MCX: 'MCX', CDS: 'CDS' }

function exchangeUpper(ex: string): string {
  return EXCH_UP[(ex ?? '').toUpperCase()] ?? (ex || 'NSE').toUpperCase()
}

/** order payload exactly like hedging transform_data (empty values dropped by buildBreezeBody) */
function liveOrderPayload(ctx: LegContext): Record<string, unknown> {
  const m = (ctx.symbolMap.brokerToken ?? '').split('|')
  const units = ctx.order.qty * ctx.symbolMap.lotSize
  const exch = exchangeUpper(ctx.symbolMap.exchange)
  const isDeriv = exch === 'NFO' || exch === 'BFO' || exch === 'MCX'
  const isOpt = ctx.symbolMap.instrumentType === 'CE' || ctx.symbolMap.instrumentType === 'PE'
  const orderType = ctx.order.orderType === 'MARKET' ? 'market' : ctx.order.orderType === 'LIMIT' ? 'limit' : 'stoploss'
  const body: Record<string, unknown> = {
    stock_code: m[0] || ctx.symbolMap.masterSymbol,
    exchange_code: exch,
    product: isDeriv ? (isOpt ? 'options' : 'futures') : ctx.order.productType === 'CNC' ? 'cash' : 'margin',
    action: ctx.order.side.toLowerCase(),
    order_type: orderType,
    quantity: String(units),
    price: ctx.order.limitPrice ? ctx.order.limitPrice.toFixed(2) : '0',
    validity: 'day',
    user_remark: (ctx.order.source + (ctx.order.strategyId ? ':' + ctx.order.strategyId : '')).slice(0, 20),
  }
  if ((ctx.order.orderType === 'SL' || ctx.order.orderType === 'SL-M') && ctx.order.triggerPrice) {
    body.stoploss = ctx.order.triggerPrice.toFixed(2)
  }
  if (isDeriv) {
    const exp = m[1]
    if (exp) body.expiry_date = exp.startsWith('T') ? exp : `${exp}T06:00:00.000Z`
    if (isOpt) {
      body.right = ctx.symbolMap.instrumentType === 'CE' ? 'call' : 'put'
      if (m[2]) body.strike_price = String(Math.round(Number(m[2])))
    }
  }
  return body
}

function toBookRow(o: Record<string, unknown>): BrokerBookRow {
  const raw = String(o.status ?? '')
  return {
    brokerOrderId: String(o.order_id ?? ''),
    symbol: String(o.stock_code ?? ''),
    side: String(o.action ?? '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
    qty: num(o.quantity) ?? 0,
    filledQty: normalizeStatus(raw) === 'FILLED' ? num(o.quantity) ?? 0 : num(o.filled_quantity) ?? undefined,
    status: normalizeStatus(raw),
    rawStatus: raw,
    avgPrice: num(o.average_price) ?? num(o.price) ?? undefined,
    orderType: String(o.order_type ?? ''),
    ts: String(o.order_date ?? ''),
  }
}

const breezeAdapter: BrokerAdapter = {
  brokerType: 'ICICI_BREEZE',
  isLiveCapable: () => true,

  mapSymbol(master) {
    // brokerToken = STOCK|expiry(YYYY-MM-DD)|strike|CE/PE — breezeInstrumentParams
    // expands it per call (ISO expiry, call/put, strike rounding).
    // STOCK must be the Breeze stock_code = the UNDERLYING (NIFTY, RELIANCE),
    // NOT the option/future ticker — master.symbol for real NSE masters is
    // e.g. "NIFTY2026102725500CE" which Breeze does not accept as stock_code.
    const exp = (master.expiry ?? '').slice(0, 10)
    const stock = (master.underlying?.trim() || master.symbol).toUpperCase()
    let brokerSymbol = master.symbol
    if (master.instrumentType === 'FUT') brokerSymbol = `${stock}-FUT`
    else if (master.instrumentType === 'CE' || master.instrumentType === 'PE')
      brokerSymbol = `${stock}-${master.strike}-${master.optionType}`
    return { brokerSymbol, brokerToken: `${stock}|${exp ?? ''}|${master.strike ?? ''}|${master.optionType ?? ''}` }
  },

  modeLabel(creds) {
    return creds?.sessionToken ? 'Live (Breeze API)' : 'Sandbox (no session token)'
  },

  sessionKind() { return 'daily' }, // Breeze sessions are refreshed daily (TOTP flow)

  async placeOrder(ctx: LegContext): Promise<OrderLegResult> {
    const units = ctx.order.qty * ctx.symbolMap.lotSize
    if (ctx.credentials?.sessionToken && ctx.credentials?.apiKey) {
      const res = await breezeRequest<{ Status?: number; Success?: { order_id?: string }; Error?: string }>(
        creds2breeze(ctx.credentials), 'POST', 'order', liveOrderPayload(ctx),
        { timeoutMs: 10_000, log: loggerFor(ctx, 'place-order') },
      )
      const orderId = res.data?.Success?.order_id
      if (res.status === 200 && orderId) {
        logBroker('ICICI_BREEZE', ctx.accountId, `LIVE order ${orderId} ${ctx.order.side} ${units} ${ctx.symbolMap.brokerSymbol}`)
        return {
          accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'ICICI_BREEZE',
          brokerOrderId: orderId, status: 'OPEN', qty: ctx.order.qty, message: 'Live order accepted by Breeze',
        }
      }
      logBroker('ICICI_BREEZE', ctx.accountId, `place order failed: ${res.error ?? res.raw?.slice(0, 120) ?? res.status}`, 'WARN')
    }
    if (isSimDisabled()) {
      // Live-Only mode (admin) — never fall back to simulated fills
      rejectOrder(ctx, 'REJECTED (Live-Only mode — sandbox fills disabled)')
      logBroker('ICICI_BREEZE', ctx.accountId, 'order REJECTED — Live-Only mode disables sandbox fills (create the broker session)', 'ERROR')
      return {
        accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'ICICI_BREEZE',
        brokerOrderId: '', status: 'REJECTED', qty: ctx.order.qty,
        message: 'Live-Only mode: broker session/API required — sandbox fills disabled',
      }
    }
    if (!ctx.credentials?.sessionToken) {
      rejectOrder(ctx, 'Sandbox fill (no live credentials)')
    }
    const slip = ctx.ltp * 0.0003
    const price = ctx.order.side === 'BUY' ? ctx.ltp + slip : ctx.ltp - slip
    const fill = applyFill(ctx, price)
    return {
      accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'ICICI_BREEZE',
      brokerOrderId: fill.brokerOrderId, status: 'FILLED', qty: ctx.order.qty,
      price: fill.fillPrice, message: 'SANDBOX fill (Breeze unreachable/no token)', sandbox: true,
    }
  },

  async modifyOrder(ctx, brokerOrderId, patch: ModifyPatch) {
    if (!ctx.credentials?.sessionToken) return { ok: false, message: 'no live credentials' }
    const m = (ctx.symbolMap.brokerToken ?? '').split('|')
    const body: Record<string, unknown> = {
      order_id: brokerOrderId,
      exchange_code: exchangeUpper(ctx.symbolMap.exchange),
      stock_code: m[0] || ctx.symbolMap.masterSymbol,
      action: ctx.order.side.toLowerCase(),
      product: ctx.symbolMap.instrumentType === 'CE' || ctx.symbolMap.instrumentType === 'PE' ? 'options' : ctx.symbolMap.instrumentType === 'FUT' ? 'futures' : ctx.order.productType === 'CNC' ? 'cash' : 'margin',
      order_type: patch.orderType ? (patch.orderType === 'MARKET' ? 'market' : patch.orderType === 'LIMIT' ? 'limit' : 'stoploss') : (ctx.order.orderType === 'MARKET' ? 'market' : ctx.order.orderType === 'LIMIT' ? 'limit' : 'stoploss'),
      quantity: String((patch.qty ?? ctx.order.qty) * ctx.symbolMap.lotSize),
      price: patch.limitPrice != null ? patch.limitPrice.toFixed(2) : ctx.order.limitPrice ? ctx.order.limitPrice.toFixed(2) : '0',
      validity: 'day',
    }
    if (patch.triggerPrice != null) body.stoploss = patch.triggerPrice.toFixed(2)
    const res = await breezeRequest<{ Status?: number; Error?: string }>(
      creds2breeze(ctx.credentials), 'PUT', 'order', body,
      { timeoutMs: 8000, log: loggerFor(ctx, 'modify-order') },
    )
    const ok = res.status === 200
    logBroker('ICICI_BREEZE', ctx.accountId, `LIVE modify ${brokerOrderId}: ${ok ? 'ok' : res.error ?? 'failed'}`, ok ? 'INFO' : 'WARN')
    return { ok, message: ok ? 'Live order modified' : res.error ?? 'modify failed' }
  },

  async cancelOrder(ctx, brokerOrderId) {
    if (ctx.credentials?.sessionToken) {
      const res = await breezeRequest<{ Status?: number; Error?: string }>(
        creds2breeze(ctx.credentials), 'DELETE', 'order',
        { order_id: brokerOrderId, exchange_code: exchangeUpper(ctx.symbolMap.exchange) },
        { timeoutMs: 6000, log: loggerFor(ctx, 'cancel-order') },
      )
      if (res.status === 200) return { ok: true, message: 'Live order cancelled' }
      return { ok: false, message: res.error ?? 'cancel failed' }
    }
    if (isSimDisabled()) return { ok: false, message: 'Live-Only mode: no live order to cancel' }
    return { ok: true, message: 'Sandbox cancel attempted' }
  },

  async getOrderBook(ctx) {
    if (!ctx.credentials?.sessionToken) return []
    // Breeze books are paginated per exchange + date window
    const today = new Date()
    const iso = (d: Date) => `${d.toISOString().slice(0, 10)}T06:00:00.000Z`
    const rows: Record<string, unknown>[] = []
    for (const exch of ['nse', 'nfo']) {
      const res = await breezeRequest<Record<string, unknown>>(
        creds2breeze(ctx.credentials), 'GET', 'order',
        { exchange_code: exch, from_date: iso(today), to_date: iso(today) },
        { timeoutMs: 8000, log: loggerFor(ctx, 'order-book') },
      )
      rows.push(...successList(res))
    }
    return rows.map(toBookRow)
  },

  async getOrderStatus(ctx, brokerOrderId) {
    if (!ctx.credentials?.sessionToken) return null
    const res = await breezeRequest<Record<string, unknown>>(
      creds2breeze(ctx.credentials), 'GET', 'order',
      { order_id: brokerOrderId, exchange_code: exchangeUpper(ctx.symbolMap.exchange) },
      { timeoutMs: 6000, log: loggerFor(ctx, 'order-status') },
    )
    const row = firstSuccess(res)
    return row ? toBookRow(row) : null
  },

  async getTradeBook(ctx) {
    if (!ctx.credentials?.sessionToken) return []
    const today = new Date()
    const iso = (d: Date) => `${d.toISOString().slice(0, 10)}T06:00:00.000Z`
    const rows: Record<string, unknown>[] = []
    for (const exch of ['nse', 'nfo']) {
      const res = await breezeRequest<Record<string, unknown>>(
        creds2breeze(ctx.credentials), 'GET', 'trades',
        { exchange_code: exch, from_date: iso(today), to_date: iso(today) },
        { timeoutMs: 8000, log: loggerFor(ctx, 'trade-book') },
      )
      rows.push(...successList(res))
    }
    return rows.map(t => ({
      tradeId: String(t.trade_id ?? t.exchange_trade_id ?? ''),
      orderId: String(t.order_id ?? ''),
      symbol: String(t.stock_code ?? ''),
      side: String(t.action ?? '').toUpperCase(),
      qty: num(t.quantity) ?? 0,
      price: num(t.price) ?? 0,
      ts: String(t.trade_date ?? ''),
    }))
  },

  async getPositionsLive(ctx) {
    if (!ctx.credentials?.sessionToken) return []
    const res = await breezeRequest<Record<string, unknown>>(
      creds2breeze(ctx.credentials), 'GET', 'portfoliopositions', {},
      { timeoutMs: 8000, log: loggerFor(ctx, 'positions') },
    )
    const rows = successList(res)
    return rows
      .filter(p => num(p.quantity) !== 0)
      .map(p => ({
        symbol: String(p.stock_code ?? ''),
        netQty: num(p.quantity) ?? 0,
        avgPrice: num(p.average_price ?? p.avg_price) ?? 0,
        ltp: num(p.ltp) ?? undefined,
        pnl: num(p.mark_to_market ?? p.mtm) ?? undefined,
        productType: String(p.product_type ?? ''),
      }))
  },

  async getFunds(ctx): Promise<BrokerFundsRow> {
    if (!ctx.credentials?.sessionToken) return { cash: 0 }
    // GET funds — Success: {total_bank_balance, allocated_equity, allocated_commodity,
    // allocated_fno, block_by_trade_balance, unallocated_balance} (hedging funds.py parity)
    const res = await breezeRequest<Record<string, unknown>>(
      creds2breeze(ctx.credentials), 'GET', 'funds', {},
      { timeoutMs: 10_000, log: loggerFor(ctx, 'funds') },
    )
    if (isAuthError(res)) {
      // "Unauthorized User" / "Invalid User Details" — the session is dead
      // (Breeze sessions expire daily). Say exactly what to do, never ₹0.
      logBroker('ICICI_BREEZE', ctx.accountId, `funds rejected — session expired/invalid (${res.error ?? 'unauthorized'}); re-create the session in Admin → Session`, 'ERROR')
      return { cash: 0, error: `ICICI session expired/invalid (broker said: ${res.error ?? 'Unauthorized User'}) — re-create the session in Admin → Session` }
    }
    const s = firstSuccess(res)
    if (!s) return { cash: 0, error: res.error ?? `funds API returned no data (HTTP ${res.httpStatus})` }
    const f = (k: string): number => {
      const v = Number(String(s[k] ?? '').replace(/,/g, ''))
      return Number.isFinite(v) ? v : 0
    }
    const allocatedEquity = f('allocated_equity')
    const unallocated = f('unallocated_balance')
    const bank = f('total_bank_balance')
    const blocked = f('block_by_trade_balance')
    const cash = Math.max(0, allocatedEquity + unallocated + bank - blocked)
    const utilized = f('allocated_fno') + f('allocated_commodity') + blocked
    if (res.status !== 200) return { cash: 0, error: res.error ?? `funds API status ${res.status}` }
    return { cash, utilized }
  },

  async getHoldings(ctx) {
    if (!ctx.credentials?.sessionToken) return []
    const res = await breezeRequest<Record<string, unknown>>(
      creds2breeze(ctx.credentials), 'GET', 'portfolioholdings', { exchange_code: 'nse' },
      { timeoutMs: 10_000, log: loggerFor(ctx, 'holdings') },
    )
    const rows = successList(res)
    return rows.map(h => ({
      symbol: String(h.stock_code ?? ''),
      isin: h.isin ? String(h.isin) : undefined,
      qty: num(h.quantity) ?? num(h.holding_quantity) ?? 0,
      avgPrice: num(h.average_price) ?? num(h.buy_avg_price) ?? 0,
      ltp: num(h.ltp) ?? num(h.last_price) ?? undefined,
      pnl: num(h.pnl) ?? undefined,
      product: String(h.product ?? 'cash'),
    }))
  },

  async marginCalc(ctx, params) {
    if (!ctx.credentials?.sessionToken) return null
    const m = (ctx.symbolMap.brokerToken ?? '').split('|')
    const res = await breezeRequest<Record<string, unknown>>(
      creds2breeze(ctx.credentials), 'GET', 'customer/margins',
      {
        action: params.side.toLowerCase(),
        exchange_code: exchangeUpper(ctx.symbolMap.exchange),
        product: ctx.symbolMap.instrumentType === 'CE' || ctx.symbolMap.instrumentType === 'PE' ? 'options' : ctx.symbolMap.instrumentType === 'FUT' ? 'futures' : params.productType === 'CNC' ? 'cash' : 'margin',
        quantity: String(params.qty * ctx.symbolMap.lotSize),
        price: String(params.price),
        stock_code: m[0] || ctx.symbolMap.masterSymbol,
      },
      { timeoutMs: 8000, log: loggerFor(ctx, 'margin-calc') },
    )
    const r = firstSuccess(res)
    if (!res.status || res.status !== 200 || !r) return { required: 0, detail: res.error ?? 'margin API unavailable' }
    return {
      required: num(r.margin_required) ?? num(r.total_margin) ?? 0,
      available: num(r.margin_available) ?? num(r.net_available_cash) ?? undefined,
      span: num(r.span_margin) ?? undefined,
      exposure: num(r.exposure_margin) ?? undefined,
      brokerage: num(r.brokerage) ?? undefined,
      detail: String(r.remarks ?? ''),
    }
  },

  async getQuote(ctx, token) {
    if (!ctx.credentials?.sessionToken) return { symbol: token, ltp: 0 }
    // token = UNDERLYING|expiry(YYYY-MM-DD)|strike|CE-PE (see mapSymbol)
    const [stock, expiry, strike, right] = token.split('|')
    const res = await breezeRequest<Record<string, unknown>>(
      creds2breeze(ctx.credentials!), 'GET', 'quotes',
      breezeInstrumentParams({
        symbol: stock || ctx.symbolMap.masterSymbol,
        exchange: ctx.symbolMap.exchange,
        instrumentType: ctx.symbolMap.instrumentType,
        expiry: expiry || null,
        strike: strike || null,
        optionType: right || ctx.symbolMap.instrumentType,
      }),
      { timeoutMs: 6000, log: loggerFor(ctx, 'quote') },
    ) as BreezeRes<Record<string, unknown>>
    if (isAuthError(res)) {
      logBroker('ICICI_BREEZE', ctx.accountId, `quote rejected — session expired/invalid (${res.error ?? 'unauthorized'})`, 'WARN')
      return { symbol: token, ltp: 0, error: `session expired — re-create it in Admin → Session` }
    }
    const row = firstSuccess(res)
    if (!row) return { symbol: token, ltp: 0 }
    const q = parseBreezeQuoteRow(row)
    return { symbol: token, ...q }
  },
}

registerAdapter(breezeAdapter)
export default breezeAdapter
