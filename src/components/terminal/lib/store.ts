'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Timeframe, OrderSide, OrderTypeKind, ProductType } from '@/lib/types'

export type AppView = 'terminal' | 'admin' | 'strategy' | 'dashboard'

export interface StrikeRowCfg {
  id: string // `${strike}:${type}`
  strike: number
  type: 'CE' | 'PE'
  enabled: boolean
  allocPct: number // % of account usable capital to deploy (PCT mode)
  allocAmt?: number // fixed ₹ allocation per account (FIXED mode)
}

export type AllocMode = 'PCT' | 'FIXED'

export interface StrikesCfg {
  underlying: string | null
  expiry: string | null // null = nearest
  rows: StrikeRowCfg[]
}

// ---- depth panel stack (left dock bottom) ----
export interface DepthPanelCfg {
  id: string
  symbol: string
  height: number // px, adjustable by dragging the panel's top edge
}

export function defaultDepthPanels(symbol: string): DepthPanelCfg[] {
  return [{ id: `dp-${symbol.toLowerCase()}`, symbol, height: 190 }]
}

const MAX_DEPTH_PANELS = 6

/** Shared depth-panel add (used by the depth stack header AND the chart-pane
 *  header depth buttons). Dedupes by symbol, caps the stack size. */
export function addDepthPanelTo(ws: WorkspaceCfg, symbol: string): { patch: Partial<WorkspaceCfg>; error?: string } {
  const cur = ws.depthPanels ?? defaultDepthPanels(ws.symbol)
  if (cur.some(p => p.symbol === symbol)) return { patch: {}, error: `${symbol} depth is already open` }
  if (cur.length >= MAX_DEPTH_PANELS) return { patch: {}, error: `Max ${MAX_DEPTH_PANELS} depth panels` }
  return { patch: { depthPanels: [...cur, { id: `dp${Date.now().toString(36)}`, symbol, height: 170 }] } }
}

// ---- multi-pane chart layouts ----
export type WsLayout = 'single' | 'spot-atm' | 'grid4'

export interface PaneCfg {
  key: 'ce' | 'pe' | 'extra'
  strike: number | null // null = follow live ATM (CE/PE panes)
  type: 'CE' | 'PE' | null // only used by the 'extra' scratch pane
}

export function wsLayout(ws: WorkspaceCfg): WsLayout {
  return ws.layout ?? (ws.showOptionMinis ? 'spot-atm' : 'single')
}

export function defaultPanes(): PaneCfg[] {
  return [
    { key: 'ce', strike: null, type: 'CE' },
    { key: 'pe', strike: null, type: 'PE' },
    { key: 'extra', strike: null, type: null },
  ]
}

export function wsPanes(ws: WorkspaceCfg): PaneCfg[] {
  const base = ws.panes ?? defaultPanes()
  // repair panes missing from older persisted workspaces
  return defaultPanes().map(d => base.find(p => p.key === d.key) ?? d)
}

/** Pin a strike into its side pane (CE row -> CE pane, PE row -> PE pane);
 *  the extra scratch pane always mirrors the most recent click. */
export function pinStrikePanes(ws: WorkspaceCfg, strike: number, type: 'CE' | 'PE'): Partial<WorkspaceCfg> {
  return {
    panes: wsPanes(ws).map(p => {
      if (p.key === type.toLowerCase()) return { ...p, strike }
      if (p.key === 'extra') return { ...p, strike, type }
      return p
    }),
  }
}

export function unpinPane(ws: WorkspaceCfg, key: PaneCfg['key']): Partial<WorkspaceCfg> {
  return { panes: wsPanes(ws).map(p => (p.key === key ? { ...p, strike: null, type: p.key === 'extra' ? null : p.type } : p)) }
}

export interface WorkspaceCfg {
  id: string
  name: string
  symbol: string
  tf: Timeframe
  chartType: 'candles' | 'line' | 'area'
  showVolume: boolean
  showSMA20: boolean
  showSMA50: boolean
  // indicator toggles (sample-tool style toolbar)
  showEMA?: boolean
  showVWAP?: boolean
  showBOLL?: boolean
  showRSI?: boolean
  showMACD?: boolean
  showADX?: boolean
  // ghost overlay (#ghostCtl): inner candles of `ghostTf` inside higher-tf
  // shells — auto-calc math works BOTH ways (ghost lower OR higher than tf)
  showGhost?: boolean
  ghostStyle?: 'hollow' | 'fade'
  ghostTf?: Timeframe // inner/shell timeframe, default 1m
  // axis scales: topmost enabled = right axis, others = left measurement
  // column; % / pts are relative to a draggable baseline
  scales?: { price: boolean; pct: boolean; inv: boolean; pts: boolean }
  // strike allocation mode: % of usable capital (auto-normalized per side)
  // or fixed ₹ per strike per account
  allocMode?: AllocMode
  showOptionMinis?: boolean // legacy (pre-layout) — kept for persisted-state migration
  layout?: WsLayout
  panes?: PaneCfg[]
  strikes?: StrikesCfg
  depthPanels?: DepthPanelCfg[]
}

export function defaultStrikes(): StrikesCfg {
  return { underlying: null, expiry: null, rows: [] }
}

/** Boolean chart display flags (toolbar toggles). */
export type WorkspaceCfgFlags = Pick<
  WorkspaceCfg,
  'showVolume' | 'showSMA20' | 'showSMA50' | 'showEMA' | 'showVWAP' | 'showBOLL' | 'showRSI' | 'showMACD'
>

interface TerminalState {
  view: AppView
  workspaces: WorkspaceCfg[]
  activeWs: string
  selectedSymbol: string
  // bumped whenever the feed SOURCE changes — every market-data holder
  // (chart candles/ghost, watchlist ticks, depth books) clears on change
  // so sim data never lingers under a real-broker source
  dataEpoch: number
  // starred watchlist (Watch tab in the left panel)
  watchSymbols: string[]
  // user-defined watchlist tabs (N tabs; each holds explicit symbols)
  wlTabs: WlTabCfg[]
  // chart levels per symbol — SL / target lines the user can DRAG on the
  // chart (persisted); real resting orders are placed on drop when a
  // position exists
  chartLevels: Record<string, { sl?: number; target?: number }>
  // strike currently loaded into a chart pane (highlight in the strikes
  // panel + watchlist)
  activeStrike: { strike: number; type: 'CE' | 'PE'; wsId: string } | null
  // order pad state (shared + synced from chart/panels)
  side: OrderSide
  orderType: OrderTypeKind
  productType: ProductType
  qty: number
  qtyMode: 'AUTO' | 'MANUAL'
  limitPrice: number | null
  bottomTab: 'orders' | 'trades' | 'positions' | 'funds' | 'logs'
  // bottom dock collapsed to a slim bar (expand button floats in its place)
  bottomCollapsed: boolean
  // actions
  setView: (v: AppView) => void
  setSymbol: (s: string) => void
  patchWs: (id: string, patch: Partial<WorkspaceCfg>) => void
  addWs: () => void
  removeWs: (id: string) => void
  setActiveWs: (id: string) => void
  setSide: (s: OrderSide) => void
  setOrderType: (t: OrderTypeKind) => void
  setProductType: (p: ProductType) => void
  setQty: (q: number) => void
  setQtyMode: (m: 'AUTO' | 'MANUAL') => void
  setLimitPrice: (p: number | null) => void
  setBottomTab: (t: 'orders' | 'trades' | 'positions' | 'funds' | 'logs') => void
  setBottomCollapsed: (c: boolean) => void
  toggleWatch: (s: string) => void
  // watchlist user tabs
  addWlTab: (name?: string) => string
  removeWlTab: (id: string) => void
  renameWlTab: (id: string, name: string) => void
  toggleWlTabSymbol: (id: string, s: string) => void
  // draggable chart levels
  setChartLevel: (symbol: string, kind: 'sl' | 'target', price: number | null) => void
  setActiveStrike: (v: { strike: number; type: 'CE' | 'PE'; wsId: string } | null) => void
  bumpDataEpoch: () => void
  /** Open (or re-activate) a per-symbol workspace; FNO ones get the
   *  spot+ATM layout and the strikes panel auto-bound to the symbol. */
  openSymbolWorkspace: (s: string, fno?: boolean) => void
}

// ---- user-defined watchlist tabs ----
export interface WlTabCfg {
  id: string
  name: string
  symbols: string[]
}

const mkWs = (id: string, name: string, symbol: string): WorkspaceCfg => ({
  id, name, symbol, tf: '5m', chartType: 'candles', showVolume: true, showSMA20: false, showSMA50: false,
  allocMode: 'PCT', showOptionMinis: true, layout: 'spot-atm', panes: defaultPanes(), strikes: defaultStrikes(),
  depthPanels: defaultDepthPanels(symbol),
  // default live view = 5m shell + 1m ghost candles (scalping-tool #ghostCtl)
  showGhost: true, ghostStyle: 'hollow', ghostTf: '1m', scales: { price: true, pct: false, inv: false, pts: false },
})

export const useTerminal = create<TerminalState>()(
  persist(
    (set, get) => ({
      view: 'terminal',
      workspaces: [mkWs('ws1', 'Workspace 1', 'NIFTY'), mkWs('ws2', 'Hedge Desk', 'BANKNIFTY')],
      activeWs: 'ws1',
      selectedSymbol: 'NIFTY',
      dataEpoch: 0,
      watchSymbols: ['NIFTY', 'SENSEX', 'BANKNIFTY'],
      wlTabs: [],
      chartLevels: {},
      activeStrike: null,
      side: 'BUY',
      orderType: 'MARKET',
      productType: 'MIS',
      qty: 1,
      qtyMode: 'AUTO',
      limitPrice: null,
      bottomTab: 'orders',
      bottomCollapsed: false,
      setView: v => set({ view: v }),
      setSymbol: s => {
        const { activeWs, workspaces } = get()
        set({
          selectedSymbol: s,
          workspaces: workspaces.map(w => (w.id === activeWs ? { ...w, symbol: s } : w)),
        })
      },
      patchWs: (id, patch) => set({ workspaces: get().workspaces.map(w => (w.id === id ? { ...w, ...patch } : w)) }),
      addWs: () => {
        const n = get().workspaces.length + 1
        const ws = mkWs(`ws${Date.now().toString(36)}`, `Workspace ${n}`, get().selectedSymbol)
        set({ workspaces: [...get().workspaces, ws], activeWs: ws.id })
      },
      removeWs: id => {
        const rest = get().workspaces.filter(w => w.id !== id)
        if (rest.length === 0) return
        set({ workspaces: rest, activeWs: get().activeWs === id ? rest[0].id : get().activeWs })
      },
      setActiveWs: id => {
        const ws = get().workspaces.find(w => w.id === id)
        if (ws) set({ activeWs: id, selectedSymbol: ws.symbol })
      },
      setSide: s => set({ side: s }),
      setOrderType: t => set({ orderType: t }),
      setProductType: p => set({ productType: p }),
      setQty: q => set({ qty: Math.max(0, q) }),
      setQtyMode: m => set({ qtyMode: m }),
      setLimitPrice: p => set({ limitPrice: p }),
      setBottomTab: t => set({ bottomTab: t }),
      setBottomCollapsed: c => set({ bottomCollapsed: c }),
      toggleWatch: s => {
        const cur = get().watchSymbols
        set({ watchSymbols: cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s] })
      },
      addWlTab: name => {
        const id = `wlt${Date.now().toString(36)}`
        const n = get().wlTabs.length + 1
        set({ wlTabs: [...get().wlTabs, { id, name: name || `List ${n}`, symbols: [] }] })
        return id
      },
      removeWlTab: id => set({ wlTabs: get().wlTabs.filter(t => t.id !== id) }),
      renameWlTab: (id, name) => set({ wlTabs: get().wlTabs.map(t => (t.id === id ? { ...t, name } : t)) }),
      toggleWlTabSymbol: (id, s) =>
        set({
          wlTabs: get().wlTabs.map(t =>
            t.id === id
              ? { ...t, symbols: t.symbols.includes(s) ? t.symbols.filter(x => x !== s) : [...t.symbols, s] }
              : t,
          ),
        }),
      setChartLevel: (symbol, kind, price) => {
        const cur = get().chartLevels
        const next = { ...(cur[symbol] ?? {}) }
        if (price == null || !Number.isFinite(price)) delete next[kind]
        else next[kind] = price
        set({ chartLevels: { ...cur, [symbol]: next } })
      },
      setActiveStrike: v => set({ activeStrike: v }),
      bumpDataEpoch: () => set({ dataEpoch: get().dataEpoch + 1 }),
      openSymbolWorkspace: (s, fno = false) => {
        const existing = get().workspaces.find(w => w.symbol === s)
        if (existing) {
          set({ activeWs: existing.id, selectedSymbol: s })
          return
        }
        const n = get().workspaces.length + 1
        const ws = mkWs(`ws${Date.now().toString(36)}`, s, s)
        ws.layout = fno ? 'spot-atm' : 'single'
        if (fno) ws.strikes = { ...defaultStrikes(), underlying: s, expiry: null, rows: [] }
        set({ workspaces: [...get().workspaces, ws], activeWs: ws.id, selectedSymbol: s })
      },
    }),
    {
      name: 'zterm-workspaces',
      partialize: s => ({ workspaces: s.workspaces, activeWs: s.activeWs, productType: s.productType, qtyMode: s.qtyMode, watchSymbols: s.watchSymbols, wlTabs: s.wlTabs, chartLevels: s.chartLevels, bottomCollapsed: s.bottomCollapsed }),
      version: 3,
      // v2: default the ghost overlay ON for every workspace (5m shell + 1m
      // ghost is the house default live view) unless the user had it on.
      // v3: ghostTf default 1m + wlTabs/chartLevels defaults.
      migrate: (state: unknown) => {
        const st = state as { workspaces?: WorkspaceCfg[]; bottomCollapsed?: boolean; wlTabs?: WlTabCfg[]; chartLevels?: Record<string, { sl?: number; target?: number }> }
        if (Array.isArray(st.workspaces)) {
          st.workspaces = st.workspaces.map(w => ({
            ...w,
            showGhost: w.showGhost ?? true,
            ghostTf: w.ghostTf ?? '1m',
          }))
        }
        if (!Array.isArray(st.wlTabs)) st.wlTabs = []
        if (typeof st.chartLevels !== 'object' || st.chartLevels === null) st.chartLevels = {}
        return st
      },
      // Avoid SSR/CSR hydration mismatch: server renders defaults, client
      // must not rehydrate synchronously before the first render.
      // We call useTerminal.persist.rehydrate() inside a useEffect after mount.
      skipHydration: true,
    },
  ),
)
