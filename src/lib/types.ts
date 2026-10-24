// Shared domain types for the multi-broker trading terminal

export type BrokerType = 'SIMFEED' | 'DHAN' | 'SHOONYA' | 'ICICI_BREEZE'

export const BROKER_TYPES: BrokerType[] = ['SIMFEED', 'DHAN', 'SHOONYA', 'ICICI_BREEZE']

export const BROKER_META: Record<BrokerType, { name: string; apiName: string; doc: string }> = {
  SIMFEED: { name: 'Sim Feed', apiName: 'simfeed', doc: 'Built-in simulated broker & feed' },
  DHAN: { name: 'Dhan', apiName: 'dhan', doc: 'Dhan API v2 (REST + WebSocket feed)' },
  SHOONYA: { name: 'Shoonya (Finvasia)', apiName: 'shoonya', doc: 'Noren/Shoonya REST + WebSocket' },
  ICICI_BREEZE: { name: 'ICICI Direct Breeze', apiName: 'icici_breeze', doc: 'ICICI Direct Breeze API' },
}

/** UI BrokerType -> backend broker-registry name (backend/brokers/registry.py). */
export const BROKER_API_NAME: Record<BrokerType, string> = {
  SIMFEED: 'sim',
  DHAN: 'dhan',
  SHOONYA: 'shoonya',
  ICICI_BREEZE: 'breeze',
}

export type CapitalMode =
  | 'PROFIT_ONLY' // house: 1st trade full initial, then only profits
  | 'INITIAL_PLUS_PNL' // initial + realized pnl (compounding)
  | 'INITIAL_WITH_LOSS_REDUCTION' // only initial; losses incl. charges reduce it

export const CAPITAL_MODES: Record<CapitalMode, { label: string; detail: string }> = {
  PROFIT_ONLY: {
    label: 'House — Profit Only',
    detail: 'First trade uses full initial capital. Later trades can only use accumulated profit. Losses eat the profit pool.',
  },
  INITIAL_PLUS_PNL: {
    label: 'Initial + PnL',
    detail: 'Deployable capital = initial capital + realized PnL (compounding on gains and losses).',
  },
  INITIAL_WITH_LOSS_REDUCTION: {
    label: 'Initial (loss reducing)',
    detail: 'Only initial capital is deployable. Every loss incl. brokerage/charges/tax permanently reduces it. Profits do not increase it.',
  },
}

export type OrderSide = 'BUY' | 'SELL'
export type OrderTypeKind = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
export type ProductType = 'MIS' | 'CNC' | 'NRML'
export type OrderSource = 'MANUAL' | 'STRATEGY' | 'API' | 'SQUAREOFF' | 'KILLSWITCH' | 'SYSTEM' | 'PYTHON'

export interface PlaceOrderRequest {
  symbol: string // canonical master symbol
  exchange: string
  side: OrderSide
  qty: number // lots for FUT/OPT, units for EQ
  orderType: OrderTypeKind
  productType: ProductType
  limitPrice?: number
  triggerPrice?: number
  source: OrderSource
  strategyId?: string
  tag?: string
  // internal: per-leg override (copy trading)
  legAccounts?: string[]
  // reduceOnly: closing an existing position — bypasses capital sizing checks
  reduceOnly?: boolean
  // deploy % of each account's usable capital (strikes panel quick deploy);
  // qty>0 takes precedence
  capitalPct?: number
}

export interface OrderLegResult {
  accountId: string
  accountLabel: string
  brokerType: BrokerType
  brokerOrderId: string | null
  status: 'FILLED' | 'OPEN' | 'REJECTED' | 'SKIPPED'
  qty: number
  price?: number
  message?: string
  sandbox?: boolean
}

export interface MasterOrderResult {
  masterOrderId: string
  symbol: string
  exchange: string
  side: OrderSide
  lots: number
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  legs: OrderLegResult[]
  avgFillPrice?: number
  message?: string
}

export interface BrokerOrderRecord {
  id: string
  masterOrderId?: string
  symbol: string
  exchange: string
  side: OrderSide
  qty: number
  filledQty: number
  orderType: OrderTypeKind
  productType: ProductType
  limitPrice?: number
  triggerPrice?: number
  status: string // FILLED | OPEN | CANCELLED | REJECTED
  avgPrice?: number
  message?: string
  createdAt: string
  updatedAt: string
}

export interface BrokerTradeRecord {
  id: string
  orderId: string
  symbol: string
  exchange: string
  side: OrderSide
  qty: number
  price: number
  value: number
  chargesTotal: number
  charges: ChargesBreakdown
  realizedPnl?: number
  ts: string
}

export interface ChargesBreakdown {
  brokerage: number
  stt: number
  transaction: number
  gst: number
  sebi: number
  stamp: number
  total: number
}

export interface PositionRecord {
  symbol: string
  exchange: string
  productType: ProductType
  netQty: number // +ve long, -ve short
  buyQty: number
  sellQty: number
  avgPrice: number
  realizedPnl: number
  ltp: number
  unrealizedPnl: number
  /** NET in pocket if exited at current LTP (after all exit charges) */
  netIfExit?: number
  /** estimated exit-leg charges at LTP (account's own schedule) */
  exitCharges?: number
  lotSize: number
  updatedAt: string
}

export interface AccountSnapshot {
  id: string
  label: string
  brokerType: BrokerType
  status: string
  isActive: boolean
  isLiveDataSource: boolean
  isOrderEnabled: boolean
  isCopyMaster: boolean
  /** broker session present (LIVE) vs sandbox — drives FEED chip badges + Live-Only rules */
  hasSession?: boolean
  usableCapital: number
  initialCapital: number
  /** capital source: FIXED rupee amount or % of the account's available cash */
  capitalBase?: 'FIXED' | 'AVAILABLE_CASH_PCT'
  capitalPct?: number
  /** live available cash from the broker funds (null when unknown) */
  availableCash?: number | null
  /** the stored fixed rupee amount (before the % base resolves) */
  initialCapitalFixed?: number
  realizedPnl: number
  chargesPaid: number
  /** realized minus charges — what actually lands in pocket */
  netPnl?: number
  /** Σ net-if-exited-at-LTP over open positions (after exit charges) */
  openNet?: number
  /** NET IN POCKET now = netPnl + openNet (exit everything at LTP) */
  pocket?: number
  deployed: number
  mode: CapitalMode
  firstTradeDone: boolean
  openPositions: number
  openOrders: number
}

export interface Tick {
  symbol: string
  ltp: number
  prevClose: number
  open: number
  high: number
  low: number
  vol: number
  bid?: number
  ask?: number
  ts: number
}

export interface Candle {
  t: number // epoch ms (bar open time)
  o: number
  h: number
  l: number
  c: number
  v: number
}

export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '1d'] as const
export type Timeframe = (typeof TIMEFRAMES)[number]

export const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
}
