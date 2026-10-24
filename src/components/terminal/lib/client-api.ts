'use client'

import type {
  AccountSnapshot, Candle, MasterOrderResult, OrderLegResult, PositionRecord, Timeframe, Tick,
} from '@/lib/types'

// ============================================================
// Tool-plane REST client — FastAPI backend (/pyapi via Caddy,
// XTransformPort=8000).  Bearer-token auth (token persisted in
// localStorage).  ALL streaming data flows over the socket.io
// hub (:8001) — see socket.ts / sync.ts; this module is used
// only for tool interactions (login, account CRUD, orders,
// masters, settings, diagnostics).
// ============================================================

const TOKEN_KEY = 'qd_token'

export function getToken(): string {
  if (typeof window === 'undefined') return ''
  try { return window.localStorage.getItem(TOKEN_KEY) ?? '' } catch { return '' }
}
function setToken(t: string) {
  try {
    if (t) window.localStorage.setItem(TOKEN_KEY, t)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch { /* ignore */ }
}

export interface AccountRow extends AccountSnapshot {
  clientId: string | null
  modeLabel: string | null
}

/** Round-27 — /pyapi/brokers catalog entry (native + openalgo plugins) */
export interface BrokerCatalogField {
  key: string
  label: string
  secret?: boolean
  hint?: string
  sample?: string
}
export interface BrokerCatalogEntry {
  broker: string // registry name: sim | dhan | shoonya | breeze | oa-<plugin>
  label: string
  kind: 'native' | 'openalgo'
  fields: BrokerCatalogField[]
  login_url_template: string | null
  auth_params: string[]
}
export interface BrokerCatalog {
  brokers: BrokerCatalogEntry[]
}

export interface AggPosition extends PositionRecord {
  accountId: string
  accountLabel: string
  brokerType: string
  instrumentType?: string
}

export interface AggOrder {
  id: string
  masterOrderId?: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  filledQty: number
  orderType: string
  productType: string
  status: string
  avgPrice?: number
  message?: string
  createdAt: string
  updatedAt: string
  accountId: string
  accountLabel: string
  brokerType: string
}

export interface AggTrade {
  id: string
  orderId: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  value: number
  chargesTotal: number
  charges: { brokerage: number; stt: number; transaction: number; gst: number; sebi: number; stamp: number; total: number }
  realizedPnl?: number
  ts: string
  accountId: string
  accountLabel: string
  brokerType: string
}

export interface FundRow {
  accountId: string
  label: string
  brokerType: string
  cash: number
  initialCapital: number
  realizedPnl: number
  chargesPaid: number
  deployed: number
}

export interface SymbolRow {
  id: string
  symbol: string
  name: string
  exchange: string
  instrumentType: string
  expiry?: string | null
  strike?: number | null
  optionType?: string | null
  lotSize: number
  basePrice?: number | null
  mappings: { brokerType: string; brokerSymbol: string; brokerToken: string | null }[]
}

export interface StrategyRow {
  id: string
  name: string
  enabled: boolean
  status: string
  exchange: string
  symbol: string
  direction: string
  productType: string
  orderType: string
  qtyMode: string
  fixedQty: number
  capitalAmount?: number | null
  entryTime: string
  entryWindowMin: number
  exitTime: string
  repeatDays: string
  stopLossPct?: number | null
  targetPct?: number | null
  trailingSlPct?: number | null
  lastRunDate?: string | null
  entryPrice?: number | null
  realizedPnl: number
  logs: { id: string; ts: string; level: string; message: string }[]
}

export interface CopyTradeCfg {
  id: string
  enabled: boolean
  masterAccountId: string | null
  capitalSharePct: number
  slippagePct: number
  roundToLot: boolean
  skipFailedLegs: boolean
  killSwitch: boolean
}

// ---- options chain ----
export interface OptionUnderlyingRow {
  underlying: string
  name: string
  lotSize: number
  expiries: string[]
  instrumentType: string
}

export interface ChainMeta {
  underlying: string
  exchange: string
  spot: number
  prevClose: number
  atm: number
  ceAtm: number // CE-side ATM = floor(spot/step)*step
  peAtm: number // PE-side ATM = ceil(spot/step)*step
  step: number
  lotSize: number
  expiry: string
  expiries: string[]
  sessionIv?: number | null // FNO session IV (greeks below are live when set)
  strikesAvailable: number[]
}

export interface OptionGreeks {
  delta: number
  gamma: number
  theta: number
  vega: number
  iv?: number
}

export interface OptionQuoteCell {
  symbol: string
  exists: boolean
  ltp: number
  prevClose: number
  high: number
  low: number
  changePct: number
  greeks?: OptionGreeks | null
}

export interface ChainStrikeRow {
  strike: number
  offset: number
  offsetCe: number // steps vs CE-side ATM
  offsetPe: number // steps vs PE-side ATM
  ce: OptionQuoteCell
  pe: OptionQuoteCell
}

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const d = data as { error?: string; message?: string; detail?: string }
    // Gateway/proxy error pages return HTML (not JSON) — surface a readable message
    if (!d.error && !d.message && !d.detail && res.status >= 502) throw new Error(`Server unreachable (HTTP ${res.status}) — try again in a few seconds`)
    // /orders returns 422 with the master-order result — lead with its message
    const legs = (data as { legs?: { message?: string }[] }).legs
    const legMsg = legs?.find(l => l.message)?.message
    throw new Error(d.message || d.detail || d.error || (legMsg ? `order rejected — ${legMsg}` : `HTTP ${res.status}`))
  }
  return data as T
}

async function fetchJson<T>(path: string, init?: RequestInit, retries = 1): Promise<T> {
  const sep = path.includes('?') ? '&' : '?'
  const url = `/pyapi${path}${sep}XTransformPort=8000`
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await j<T>(await fetch(url, {
        cache: 'no-store',
        ...init,
        headers: {
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
          ...(init?.headers ?? {}),
        },
      }))
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : ''
      const transient = /Server unreachable|HTTP 5|Failed to fetch|NetworkError|Load failed/i.test(msg)
      if (!transient || attempt === retries) break
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw lastErr
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v))
  }
  return u.toString()
}

export const api = {
  login: (username: string, password: string) =>
    fetchJson<{ token: string; username: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }, 3).then(r => { setToken(r.token); return { ok: true } }),
  logout: () => { setToken(''); return fetchJson<{ ok: boolean }>('/auth/logout', { method: 'POST' }).catch(() => ({ ok: true })) },
  me: () =>
    fetchJson<{ username?: string; u?: string; role?: string; r?: string }>('/auth/me')
      .then(r => ({ user: r.username ?? r.u ?? null, feed: 'ok' }))
      .catch(() => ({ user: null, feed: 'ok' })),

  feedSource: () =>
    fetchJson<{ source: string; simDisabled?: boolean; tradingMode?: string; sources: { id: string; label: string; brokerType: string | null; hasSession?: boolean }[] }>('/feed'),
  feedStatus: () =>
    fetchJson<FeedStatusResp>('/feed/status'),
  setFeedSource: (source: string) =>
    fetchJson<{ ok: boolean; source: string }>('/feed', { method: 'POST', body: JSON.stringify({ source }) }),
  setSimDisabled: (simDisabled: boolean) =>
    fetchJson<{ ok: boolean; simDisabled: boolean }>('/feed', { method: 'POST', body: JSON.stringify({ simDisabled }) }),
  setTradingMode: (mode: 'live' | 'sandbox' | 'simulation') =>
    fetchJson<{ mode: string }>('/settings/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
  brokers: () =>
    fetchJson<BrokerCatalog>('/brokers'),

  accounts: () => fetchJson<{ accounts: AccountRow[] }>('/accounts'),
  createAccount: (body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean; id: string }>('/accounts', { method: 'POST', body: JSON.stringify(body) }),
  patchAccount: (id: string, body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean }>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAccount: (id: string) => fetchJson<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),
  accountsBulk: (accounts: unknown[], deleteMissing: boolean) =>
    fetchJson<BulkApplyResp>('/accounts/bulk', { method: 'POST', body: JSON.stringify({ accounts, deleteMissing }) }, 0),
  accountsExport: () =>
    fetchJson<{ accounts: ExportedAccountRow[]; exportedAt: number; note: string }>('/accounts/export', { method: 'GET' }, 0),

  copyTrade: () => fetchJson<{ config: CopyTradeCfg }>('/copytrade'),
  patchCopyTrade: (body: Record<string, unknown>) =>
    fetchJson<{ config: CopyTradeCfg }>('/copytrade', { method: 'PATCH', body: JSON.stringify(body) }),

  symbols: (q: string, type: string) =>
    fetchJson<{ symbols: SymbolRow[] }>(`/symbols?${qs({ q, type, limit: 120 })}`),
  symbolsByList: (list: string[]) =>
    fetchJson<{ symbols: SymbolRow[] }>(`/symbols?${qs({ symbols: list.join(','), limit: 200 })}`),
  syncSymbols: () => fetchJson<{ ok: boolean; symbolCount: number; mappedCount: number; accounts?: number; detail?: MasterSyncDetail[] }>('/symbols/sync', { method: 'POST' }, 0),
  syncAccount: (accountId: string | number) =>
    fetchJson<{ ok?: boolean; account?: string; broker?: string; symbols?: number; mappings?: number; error?: string }>(`/symbols/sync/${accountId}`, { method: 'POST' }, 0),
  syncInfo: () => fetchJson<SyncInfoResp>('/symbols/sync'),
  chargesGet: (accountId: string) => fetchJson<ChargesResp>(`/charges?accountId=${accountId}`),
  chargesPut: (accountId: string, schedule: ChargeSchedule) =>
    fetchJson<{ ok: boolean; schedule: ChargeSchedule; example: ChargesResp['example'] }>('/charges', { method: 'PUT', body: JSON.stringify({ accountId, schedule }) }, 0),
  chargesReset: (accountId: string) =>
    fetchJson<{ ok: boolean }>(`/charges?accountId=${accountId}`, { method: 'DELETE' }, 0),

  placeOrder: (body: Record<string, unknown>) =>
    fetchJson<MasterOrderResult>('/orders', { method: 'POST', body: JSON.stringify(body) }),
  squareOffAll: (kill = false, symbols?: string[]) =>
    fetchJson<{ ok: boolean; orders: number; filledLegs: number }>('/orders/squareoff', { method: 'POST', body: JSON.stringify({ killSwitch: kill, symbols }) }),
  cancelAll: (symbols?: string[]) =>
    fetchJson<{ ok: boolean; cancelled: number }>('/orders/cancel-all', { method: 'POST', body: JSON.stringify({ symbols }) }),
  orders: () => fetchJson<{ orders: AggOrder[] }>('/orders'),
  positions: () => fetchJson<{ positions: AggPosition[]; bySymbol: { symbol: string; netQty: number; avgPrice: number; ltp: number; unrealizedPnl: number; accounts: number }[]; totals: { unrealizedPnl: number; realizedPnl: number; openPositions: number; netIfExit?: number } }>('/positions'),
  trades: () => fetchJson<{ trades: AggTrade[]; totals: { charges: number; realized: number } }>('/trades'),
  funds: () => fetchJson<{ funds: FundRow[] }>('/funds'),
  syncFunds: (accountId?: string) =>
    fetchJson<{ ok: boolean; cash?: number; message?: string; results?: { accountId: string; label: string; ok: boolean; cash?: number; message: string }[] }>('/funds', { method: 'POST', body: JSON.stringify(accountId ? { accountId } : {}) }),
  brokerTest: (accountId: string) =>
    fetchJson<BrokerTestResp>('/broker-test', { method: 'POST', body: JSON.stringify({ accountId }) }),
  brokerLogs: (accountId: string) => fetchJson<{ logs: { id: number; ts: string; level: string; message: string }[] }>(`/broker-logs?${qs({ accountId })}`),
  audit: () => fetchJson<{ audits: { id: string; ts: string; source: string; action: string; masterSymbol: string; side: string; qty: number; status: string; message: string | null; legsJson: string | null }[] }>('/admin/audit'),

  strategies: () => fetchJson<{ strategies: StrategyRow[] }>('/strategies'),
  createStrategy: (body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean }>('/strategies', { method: 'POST', body: JSON.stringify(body) }),
  patchStrategy: (id: string, body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean }>(`/strategies/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteStrategy: (id: string) => fetchJson<{ ok: boolean }>(`/strategies/${id}`, { method: 'DELETE' }),
  strategyPython: (id: string) => fetchJson<{ code: string; filename: string | null }>(`/strategies/${id}/python`),

  candles: (symbol: string, tf: Timeframe, limit = 500) =>
    fetchJson<{ candles: Candle[] }>(`/market/candles?${qs({ symbol, tf, limit })}`),
  quote: (symbol: string) =>
    fetchJson<{ symbol: string; ltp: number; prevClose: number; bid: number; ask: number; lotSize?: number; instrumentType?: string | null; depth: { buys: { price: number; qty: number }[]; sells: { price: number; qty: number }[] } }>(`/market/quote?${qs({ symbol })}`),
  indexComponents: (symbol: string) =>
    fetchJson<IndexComponentsResp>(`/market/index?${qs({ symbol })}`),
  sessionStats: () => fetchJson<SessionStatsResp>('/stats/session'),
  tickRecorder: () => fetchJson<TickRecorderResp>('/tickrecorder'),
  setTickRecorder: (body: { enabled?: boolean; symbols?: string[] }) =>
    fetchJson<{ ok: boolean; enabled: boolean; symbols: string[] }>('/tickrecorder', { method: 'POST', body: JSON.stringify(body) }),
  cancelOrder: (accountId: string, orderId: string) =>
    fetchJson<{ ok: boolean }>('/orders/cancel', { method: 'POST', body: JSON.stringify({ accountId, orderId }) }),
  status: () => fetchJson<{ services: Record<string, string | number>; masterContracts: { count: number; lastSync: string | null }; accounts: number; enabledStrategies: number }>('/market/status'),

  // ---- FNO universe (all exchanges: NFO / BFO / BFNO / MCX / CDS) ----
  fnoUniverse: () =>
    fetchJson<FnoUniverseResp>('/market/fno'),

  // ---- paper-trading replay (admin) ----
  replayStatus: () =>
    fetchJson<ReplayStatusResp>('/replay'),
  replayControl: (body: { mode: 'start' | 'stop'; file?: string | null; random?: boolean; fromTs?: number | null; toTs?: number | null; speed?: number }) =>
    fetchJson<ReplayStatusResp>('/replay', { method: 'POST', body: JSON.stringify(body) }),

  // ---- FNO session simulator (synthetic options on REAL broker spot) ----
  fnosim: () => fetchJson<FnoSimResp>('/fnosim'),
  fnosimStart: (body: { underlyings: string[]; sessionDate: string; expiryDt?: string | null; ivPct?: number; speed?: number; band?: number; prevDays?: number }) =>
    fetchJson<{ ok: boolean; status: FnoSimStatus }>('/fnosim', { method: 'POST', body: JSON.stringify({ action: 'start', ...body }) }, 0),
  fnosimStop: (underlying?: string | null) =>
    fetchJson<{ ok: boolean; status: FnoSimStatus }>('/fnosim', { method: 'POST', body: JSON.stringify({ action: 'stop', ...(underlying ? { underlying } : {}) }) }),
  fnosimPlay: (underlying?: string | null) =>
    fetchJson<{ ok: boolean; status: FnoSimStatus }>('/fnosim', { method: 'POST', body: JSON.stringify({ action: 'play', ...(underlying ? { underlying } : {}) }) }, 0),
  fnosimPause: (underlying?: string | null) =>
    fetchJson<{ ok: boolean; status: FnoSimStatus }>('/fnosim', { method: 'POST', body: JSON.stringify({ action: 'pause', ...(underlying ? { underlying } : {}) }) }, 0),
  fnosimPatch: (body: { ivPct?: number; speed?: number; underlying?: string | null }) =>
    fetchJson<{ ok: boolean; status: FnoSimStatus }>('/fnosim', { method: 'POST', body: JSON.stringify({ action: 'patch', ...body }) }),
  fnosimRandom: () =>
    fetchJson<{ ok: boolean; pick: { underlying: string; session_date: string; expiry: string | null; name: string } }>('/fnosim', { method: 'POST', body: JSON.stringify({ action: 'random' }) }),

  // ---- python strategy runner (backend tool) ----
  runPython: (body: { id?: string; code?: string; symbol?: string; tf?: string; bars?: number; dryRun?: boolean }) =>
    fetchJson<PythonRunResp>('/strategy/run', { method: 'POST', body: JSON.stringify(body) }),

  // ---- options chain (strikes panel) ----
  optionUnderlyings: () =>
    fetchJson<{ underlyings: OptionUnderlyingRow[] }>('/options/underlyings'),
  optionChain: (underlying: string, expiry: string | null, strikes: number[]) =>
    fetchJson<{ meta: ChainMeta; rows: ChainStrikeRow[]; atmRow: ChainStrikeRow | null; atmCe: (OptionQuoteCell & { strike: number }) | null; atmPe: (OptionQuoteCell & { strike: number }) | null }>(`/options/chain?${qs({ underlying, expiry: expiry ?? '', strikes: strikes.join(',') })}`),
  ensureStrike: (underlying: string, strike: number, expiry: string | null) =>
    fetchJson<{ ok: boolean; created: number; symbols: string[] }>('/options/ensure-strike', { method: 'POST', body: JSON.stringify({ underlying, strike, expiry }) }),

  // ---- auto rules (index-based / time-based CE-PE entries) ----
  autoRules: () => fetchJson<{ rules: AutoRuleRow[] }>('/autorules'),
  createAutoRule: (body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean; rule: AutoRuleRow }>('/autorules', { method: 'POST', body: JSON.stringify(body) }),
  patchAutoRule: (id: string, body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean }>(`/autorules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAutoRule: (id: string) => fetchJson<{ ok: boolean }>(`/autorules/${id}`, { method: 'DELETE' }),

  // ---- live broker API access (order book of a real broker account) ----
  brokerOrderBook: (accountId: string) =>
    fetchJson<{ orders: BrokerBookRow[]; live: boolean; message?: string }>(`/broker-orderbook?${qs({ accountId })}`),

  // ---- portfolio / GTT / margin (dashboard) ----
  portfolio: () => fetchJson<PortfolioResp>('/portfolio'),
  gttRules: () => fetchJson<{ rules: GttRuleRow[] }>('/gtt'),
  createGtt: (body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean; rule: GttRuleRow }>('/gtt', { method: 'POST', body: JSON.stringify(body) }),
  patchGtt: (id: string, body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean; rule: GttRuleRow }>(`/gtt/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteGtt: (id: string) => fetchJson<{ ok: boolean }>(`/gtt/${id}`, { method: 'DELETE' }),

  // ---- broker session auth (OAuth-style: ICICI Breeze / Dhan / Shoonya) ----
  brokerAuthStatus: (accountId: string) =>
    fetchJson<BrokerAuthStatus>(`/broker-auth?${qs({ accountId })}`),
  brokerAuthConsent: (accountId: string) =>
    fetchJson<{ ok: boolean; loginUrl?: string; message: string }>('/broker-auth', { method: 'POST', body: JSON.stringify({ accountId, action: 'consent' }) }),
  brokerAuthComplete: (accountId: string, code: string) =>
    fetchJson<{ ok: boolean; message: string }>('/broker-auth', { method: 'POST', body: JSON.stringify({ accountId, action: 'complete', code }) }),
  brokerIpSync: (accountId: string) =>
    fetchJson<{ ok: boolean; message: string }>('/broker-auth', { method: 'POST', body: JSON.stringify({ accountId, action: 'syncIp' }) }),
  marginCalc: (body: { accountId: string; symbol: string; side: string; qty: number; price: number; productType?: string }) =>
    fetchJson<MarginResp>('/margin', { method: 'POST', body: JSON.stringify(body) }),
}

// ---- dashboard types ----

export interface PortfolioHolding {
  symbol: string
  qty: number
  avgPrice: number
  ltp: number
  pnl: number
  value: number
}

export interface PortfolioAccount {
  accountId: string
  accountLabel: string
  brokerType: string
  live: boolean
  holdings: PortfolioHolding[]
  message?: string
}

export interface PortfolioResp {
  portfolio: PortfolioAccount[]
  positions: { accountId: string; accountLabel: string; symbol: string; netQty: number; avgPrice: number; ltp: number; lotSize: number }[]
  ts: string
}

/** Bulk apply result (POST /accounts/bulk). */
export interface BulkApplyResp {
  ok: boolean
  counts: { created: number; modified: number; deleted: number; errors: number }
  detail: { row: number | null; id?: string; ok: boolean; action?: string; label?: string; error?: string }[]
}

/** Full account row from GET /accounts/export — raw credentials + live session
 * token, so the Bulk-JSON editor can copy/paste an account verbatim. */
export interface ExportedAccountRow {
  id?: string
  label: string
  broker: string
  mode: 'live' | 'sandbox'
  clientId?: string | null
  credentials: Record<string, string>
  session?: { token: string; broker: string; updatedAt: number } | null
  initialCapital: number | null
  capitalPct: number
  capitalMode: string
  isActive: boolean
  isOrderEnabled: boolean
  _delete?: boolean
}

/** Broker session-auth flow descriptor (GET /broker-auth). */
export interface BrokerAuthStatus {
  accountId: string
  label: string
  brokerType: string
  sessionKind: 'daily' | 'fixed' | 'none'
  hasSession: boolean
  sessionMasked: string | null
  userId: string | null
  liveCapable: boolean
  mode: string
  loginUrl: string | null
  instructions: string[]
  serverIp?: string | null
  ipInfo?: { registered: string[]; flags?: string[]; matches?: boolean | null; error?: string } | null
  fieldsNeeded: string[]
  credFields: { key: string; label: string; masked: string | null; sample: string }[]
}

export interface BrokerTestResp {
  ok: boolean
  accountId: string
  label: string
  brokerType: string
  steps: { step: string; ok: boolean; ms: number; detail: string }[]
  hint: string
}

export interface FeedStatusResp {
  source: string
  brokerType: string | null
  connected: boolean
  lastTickTs: number | null
  lastError: string | null
  errorTs: number | null
  symbols: number
  polls: number
  errors: number
  startedAt: number
  log: string[]
  sessionPresent: boolean
  sourceIsLive: boolean
  fresh: boolean
}

export interface GttRuleRow {
  id: string
  name: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  trigger: 'ABOVE' | 'BELOW'
  triggerPrice: number
  orderType: 'LIMIT' | 'MARKET'
  productType: string
  repeatDaily: boolean
  armed: boolean
  lastTriggeredAt?: string
  lastStatus?: string
  lastMessage?: string
  createdAt: string
}

export interface MarginResp {
  estimate?: { required: number; available?: number; span?: number; exposure?: number; leverage?: number; detail?: string } | null
  usable?: number
  live?: boolean
  error?: string
  pnl?: MarginPnl
}

export interface ChargeLine {
  segment: string
  brokerage: number
  stt: number
  transaction: number
  gst: number
  sebi: number
  stamp: number
  total: number
}

export interface ChargeSegment {
  brokerageFlat: number
  brokeragePct: number
  sttBuy: number
  sttSell: number
  txn: number
  sebi: number
  stampBuy: number
  gstPct: number
}

export type ChargeSchedule = Record<string, ChargeSegment>

export interface MarginPnl {
  instrument: string
  qtyUnits: number
  buyCharges: ChargeLine
  sellCharges: ChargeLine
  totalCharges: number
  breakeven: number
  netIfUp1pct: number
  netIfDown1pct: number
  scheduleSource: string
}

export interface ChargesResp {
  accountId: string
  broker: string
  label: string
  schedule: ChargeSchedule
  defaults: ChargeSchedule
  customized: boolean
  source?: { name: string; note: string; links: string[]; asOf: string }
  example: {
    buy: ChargeLine
    sell: ChargeLine
    buyValue: number
    sellValue: number
    grossPnl: number
    totalCharges: number
    netPnl: number
    breakeven: number
    netMovePerUnit: number
  }
}

export interface AutoRuleRow {
  id: string
  name: string
  underlying: string
  expiry: string | null
  kind: 'INDEX' | 'INDEX_RANGE' | 'TIME' | 'COMPOUND'
  level?: number
  cross?: 'ABOVE' | 'BELOW'
  lo?: number
  hi?: number
  time?: string
  entryOp?: 'LTE' | 'GTE' | 'RANGE'
  entryLo?: number
  entryHi?: number
  action: 'BUY' | 'SELL' | 'DEPLOY' | 'CANCEL'
  optType: 'CE' | 'PE'
  offset: number
  strikes?: { strike: number; type: 'CE' | 'PE'; allocPct: number }[]
  allocPct: number
  entryPrice?: number
  stopLoss?: number
  target?: number
  enabled: boolean
  repeatDaily: boolean
  lastFiredDate?: string
  lastFiredAt?: string
  lastStatus?: string
  lastMessage?: string
  fireCount: number
  createdAt: string
}

export interface IndexComponentRow {
  symbol: string
  weight: number
  ltp: number
  high: number
  low: number
  vol: number
  chgPct: number
  pts: number
}

export interface IndexComponentsResp {
  index: { symbol: string; name: string; ltp: number; prevClose: number; high: number; low: number; vol: number; chgPts: number; chgPct: number }
  constituents: IndexComponentRow[]
  totalPts: number
}

export interface SessionStatsResp {
  winRate: number | null
  pts: number
  realized: number
  unrealized: number
  unrealizedNet?: number
  net: number
  pocket?: number
  closes: number
  wins: number
  trades: number
  charges: number
  perAccount: { accountId: string; label: string; brokerType: string; trades: number; closes: number; wins: number; pts: number; realized: number; unrealized: number; charges: number; pocket?: number }[]
  topSymbols: { symbol: string; pts: number }[]
}

export interface TickRecorderResp {
  enabled: boolean
  symbols: string[]
  session: { file: string; startedAt: string; rows: number } | null
  sessions: { file: string; bytes: number; mtime: string }[]
}

export interface FnoUnderlyingRow {
  underlying: string
  name: string
  exchange: string // NFO | BFO | BFNO | MCX | CDS
  segment: string // IDX | EQ | COMM | CUR
  instrumentType: string
  lotSize: number
  latestExpiry: string | null
  contracts: number // option contracts for the latest expiry
  spot: number
  chgPct: number
}

export interface FnoUniverseResp {
  groups: { exchange: string; label: string; underlyings: FnoUnderlyingRow[] }[]
}

export interface ReplayStatusResp {
  active: boolean
  file: string | null
  random?: boolean
  speed: number
  startedAt: string | null
  total: number
  played: number
  symbols: string[]
  fromTs?: number | null
  toTs?: number | null
  progressPct: number
}

// ---- FNO session simulator ----

export interface FnoSimStats {
  prevDayHigh?: number
  prevDayLow?: number
  weekHigh?: number
  weekLow?: number
  monthHigh?: number
  monthLow?: number
  sixMonthHigh?: number
  sixMonthLow?: number
  sessionDaysLoaded?: number
}

export interface FnoSimStatus {
  active: boolean
  playing?: boolean
  phase?: 'ready' | 'running' | 'paused' | 'completed' | null
  completed: boolean
  error: string | null
  underlying: string | null
  spotSymbol: string | null
  sessionDate: string | null
  expiry: string | null
  expiryDt?: string | null
  expiryCustom?: boolean
  ivPct: number
  speed: number
  band: number
  step: number
  lotSize: number
  strikeCount: number
  source: string | null
  progressPct: number
  cursor: string | null
  ticksSent: number
  startedAt: number | null
  stats: FnoSimStats | null
  symbols: number
  // manual start: prepare → user presses Play
  minutesLoaded?: number
  historyDays?: number
  sessionOpen?: number | null
  synthetic?: boolean
  // multi-session manager fields
  count?: number
  underlyings?: string[]
  live?: FnoSimStatus[]
  errors?: string[]
}

export interface FnoSimSessionRow {
  id: string
  underlying: string
  sessionDate: string
  expiry: string
  ivPct: number
  speed: number
  status: string
  source: string | null
  createdAt: string | null
  finishedAt: string | null
}

export interface FnoSimResp {
  status: FnoSimStatus
  live?: FnoSimStatus[]
  sessions: FnoSimSessionRow[]
}

// ---- master contracts (symbols) sync — per-account history ----
export interface MasterSyncDetail {
  account?: string
  accountId?: number
  broker: string
  trigger?: string
  symbols?: number
  mappings?: number
  source?: string
  source_kind?: string
  error?: string
}

export interface MasterSyncBrokerRow {
  broker: string
  accountId?: number | null
  symbols: number
  connected: boolean
  accountLabel: string | null
  mode: string | null
  lastSync: string | null
  lastSyncKind: string | null
  lastStatus: string | null
  lastTrigger: string | null
  lastError: string | null
}

export interface MasterSyncHistoryRow {
  id: number
  accountId: number | null
  broker: string
  label: string | null
  trigger: string
  sourceKind: string | null
  sourceUrl: string | null
  symbols: number
  mappings: number
  status: string
  error: string | null
  durationS: number | null
  ts: string
}

export interface SyncInfoResp {
  lastSync: string | null
  counts: { symbols: number; mappings: number }
  brokers?: MasterSyncBrokerRow[]
  history?: MasterSyncHistoryRow[]
}

export interface PythonRunResp {
  ok: boolean
  runId: string
  logs: string[]
  signals: { ts: string; symbol: string; side: string; qty?: number; price?: number; message?: string }[]
  ordersPlaced: number
  error?: string
  ms: number
}

export interface BrokerBookRow {
  brokerOrderId: string
  symbol: string
  side: string
  qty: number
  filledQty?: number
  status: string
  avgPrice?: number
  orderType?: string
  ts?: string
}

// ---- ITM / OTM / ATM strike labeling (hedge-desk convention) ----
// Side-ATM: CE ATM = floor(spot/step)*step, PE ATM = ceil(spot/step)*step.
// Spot 23030 (step 50): CE ATM 23000 · CE ITM1 22950 · CE OTM1 23050;
//                       PE ATM 23050 · PE ITM1 23100 · PE OTM1 23000.
// offset = steps vs the SIDE's ATM (offsetCe for CE, offsetPe for PE):
//   CE: negative offset = strike below side-ATM = ITM, positive = OTM
//   PE: positive offset = strike above side-ATM = ITM, negative = OTM
export function sideOffsetLabel(offset: number | null | undefined, type: 'CE' | 'PE'): string {
  if (offset == null || !Number.isFinite(offset)) return ''
  if (offset === 0) return 'ATM'
  const itm = type === 'CE' ? offset < 0 : offset > 0
  return `${itm ? 'ITM' : 'OTM'} ${Math.abs(offset)}`
}

/** Side-specific strike for a labeled distance from ATM: dir = -1 (ITM) | 0 (ATM) | +1 (OTM). */
export function sideStrikeFor(atm: { ce: number; pe: number }, step: number, dir: -1 | 0 | 1, n: number, type: 'CE' | 'PE'): number {
  const base = type === 'CE' ? atm.ce : atm.pe
  // CE: ITM = below ceAtm, OTM = above; PE mirrored (ITM = above peAtm)
  const signed = type === 'CE' ? dir : -dir
  return base + signed * n * step
}

export function fmtMoney(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export function fmtInr(n: number | null | undefined, dp = 0): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export function fmtTime(ts: string | number | Date): string {
  return new Date(ts).toLocaleTimeString('en-IN', { hour12: false })
}

export function fmtDateTime(ts: string | number | Date): string {
  return new Date(ts).toLocaleString('en-IN', { hour12: false, dateStyle: 'short', timeStyle: 'medium' })
}
