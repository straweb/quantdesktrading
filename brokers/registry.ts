// @ts-nocheck
import type { BrokerType, OrderLegResult, PlaceOrderRequest } from '../src/lib/types'
import { decryptJson } from '../src/lib/crypto'

// re-export for adapters importing order result shapes from this module
export type { OrderLegResult, PlaceOrderRequest }

// ============================================================
// Broker plugin registry — every broker lives in its own folder
// (OpenAlgo style) and implements BrokerAdapter. The order router
// fans a master order out to N enabled accounts across brokers.
// ============================================================

export interface SymbolMapInfo {
  masterSymbol: string
  exchange: string
  instrumentType: string // INDEX | EQ | FUT | CE | PE
  lotSize: number
  brokerSymbol: string
  brokerToken?: string
}

export interface LegContext {
  accountId: string
  accountLabel: string
  brokerType: BrokerType
  credentials: Record<string, string> | null
  order: {
    side: 'BUY' | 'SELL'
    qty: number // lots
    orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
    productType: 'MIS' | 'CNC' | 'NRML'
    limitPrice?: number
    triggerPrice?: number
    masterOrderId: string
    strategyId?: string
    source: string
  }
  symbolMap: SymbolMapInfo
  ltp: number
}

// ---- live broker API row shapes (normalized across brokers) ----

export interface BrokerBookRow {
  brokerOrderId: string
  symbol: string
  side: 'BUY' | 'SELL' | string
  qty: number
  filledQty?: number
  status: string // FILLED | OPEN | CANCELLED | REJECTED (normalized)
  rawStatus?: string // broker-native status
  avgPrice?: number
  orderType?: string
  ts?: string
}

export interface BrokerTradeRow {
  tradeId: string
  orderId?: string
  symbol: string
  side: string
  qty: number
  price: number
  ts?: string
}

export interface BrokerPositionRow {
  symbol: string
  netQty: number
  avgPrice: number
  ltp?: number
  pnl?: number
  productType?: string
}

export interface BrokerFundsRow {
  cash: number
  available?: number
  utilized?: number
  /** set when the broker funds call failed (surface in diagnostics) */
  error?: string
}

export interface BrokerQuoteRow {
  symbol: string
  ltp: number
  bid?: number
  ask?: number
  open?: number
  high?: number
  low?: number
  prevClose?: number
  volume?: number
}

export interface BrokerHoldingRow {
  symbol: string
  isin?: string
  qty: number
  avgPrice: number
  ltp?: number
  pnl?: number
  product?: string
}

export interface BrokerMarginRow {
  required: number
  available?: number
  span?: number
  exposure?: number
  brokerage?: number
  leverage?: number
  detail?: string
}

export interface ModifyPatch {
  qty?: number // lots
  limitPrice?: number
  triggerPrice?: number
  orderType?: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
}

export interface BrokerAdapter {
  brokerType: BrokerType
  /** True when the adapter can reach its real REST endpoints; false => sandbox execution */
  isLiveCapable(): boolean
  /** Resolve broker-specific symbol/token from canonical master info (called at sync time) */
  mapSymbol(master: { symbol: string; exchange: string; instrumentType: string; underlying?: string | null; expiry?: string | null; strike?: number | null; optionType?: string | null }): { brokerSymbol: string; brokerToken: string }
  placeOrder(ctx: LegContext): Promise<OrderLegResult>
  cancelOrder(ctx: LegContext, brokerOrderId: string): Promise<{ ok: boolean; message?: string }>
  /** Human readable name of the mode the adapter will operate in */
  modeLabel(creds: Record<string, string> | null): string

  // ---- full live REST API surface (optional — sandbox-only adapters omit) ----
  /** Modify a resting live order */
  modifyOrder?(ctx: LegContext, brokerOrderId: string, patch: ModifyPatch): Promise<{ ok: boolean; message?: string }>
  /** Order book — normalized rows incl. status/avgPrice for live reconciliation */
  getOrderBook?(ctx: LegContext): Promise<BrokerBookRow[]>
  /** Trade book */
  getTradeBook?(ctx: LegContext): Promise<BrokerTradeRow[]>
  /** Position book (day / net) */
  getPositionsLive?(ctx: LegContext): Promise<BrokerPositionRow[]>
  /** Funds / margin / limit snapshot */
  getFunds?(ctx: LegContext): Promise<BrokerFundsRow>
  /** L1 quote (LTP + bid/ask + OHLC) for one broker symbol */
  getQuote?(ctx: LegContext, token: string): Promise<BrokerQuoteRow>
  /** Demat / portfolio holdings */
  getHoldings?(ctx: LegContext): Promise<BrokerHoldingRow[]>
  /** Order margin requirement estimate (per one order) */
  marginCalc?(ctx: LegContext, params: { side: 'BUY' | 'SELL'; qty: number; price: number; productType: string }): Promise<BrokerMarginRow | null>
  /** Single order status lookup */
  getOrderStatus?(ctx: LegContext, brokerOrderId: string): Promise<BrokerBookRow | null>
  /** Session token expiry hints (per broker): 'fixed' | 'daily' | 'none' */
  sessionKind?(): 'daily' | 'fixed' | 'none'
}

// Simple credential helper shared by adapters
export function credsFor(encrypted: string | null | undefined): Record<string, string> | null {
  return decryptJson(encrypted)
}

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
}

export const adapters: Partial<Record<BrokerType, BrokerAdapter>> = {}

export function registerAdapter(a: BrokerAdapter) {
  adapters[a.brokerType] = a
}

export function getAdapter(brokerType: BrokerType): BrokerAdapter | undefined {
  return adapters[brokerType]
}
