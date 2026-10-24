'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDownUp, Pencil, Plus, Power, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { api, fmtMoney, sideOffsetLabel, sideStrikeFor } from '../lib/client-api'
import type { ChainStrikeRow, OptionQuoteCell } from '../lib/client-api'
import { DepthAddButton } from './option-panes'
import {
  useTerminal, defaultStrikes, pinStrikePanes,
  type StrikesCfg, type StrikeRowCfg, type WorkspaceCfg, type AllocMode,
} from '../lib/store'
import { useSyncChannel, useSyncData, mergeChain, type SyncCore, type SyncChainResp } from '../lib/sync'
import type { AccountRow } from '../lib/client-api'

// ============================================================
// F&O Strikes panel (right dock tab) — compact build.
// - Quick-add: ITM 5..1 · ATM · OTM 1..5 buttons (hedge-desk
//   convention: CE ATM = floor(spot), PE ATM = ceil(spot) —
//   CE ITM counts DOWN from spot, PE ITM counts UP). Buttons
//   live-track the spot via the 1s sync:chain meta.
// - Rows show LIVE ITM/OTM/ATM labels that re-relative as spot
//   moves (a strike added as ATM displays ITM 2 after a 2-step
//   up-move).
// - Per-strike allocation: % slider (side auto-normalizes to 100%)
//   or fixed ₹ value — workspace allocMode toggle.
// - Line 2: per-lot cost (ltp × lot), planned ₹ + lots, PnL,
//   B/S/exit/edit actions.
// - Sort (strike/LTP/chg/PnL) + filters (all/enabled/in-position).
// - Quick deploy: Deploy CE/PE · Cancel CE/PE · Swap CE↔PE · Exit All.
// ============================================================

/** Re-scale one side's enabled rows so they always sum to 100%.
 *  PCT mode only — FIXED (₹) allocations are absolute, never normalized. */
export function normalizeSide(rows: StrikeRowCfg[], type: 'CE' | 'PE'): StrikeRowCfg[] {
  const side = rows.filter(r => r.type === type && r.enabled)
  if (side.length === 0) return rows
  const list = side.map(r => ({ ...r }))
  const n = list.length
  // zero/unset allocs enter with an equal-share weight, then everything
  // is proportionally scaled so the side sums to exactly 100
  for (const r of list) if (!(r.allocPct > 0)) r.allocPct = 100 / n
  const total = list.reduce((s, r) => s + r.allocPct, 0)
  for (const r of list) r.allocPct = Math.round((r.allocPct / total) * 1000) / 10
  // dump rounding drift on the largest allocation
  const drift = Math.round((100 - list.reduce((s, r) => s + r.allocPct, 0)) * 10) / 10
  if (drift !== 0) {
    const big = list.reduce((a, b) => (b.allocPct > a.allocPct ? b : a))
    big.allocPct = Math.round(Math.max(0, big.allocPct + drift) * 10) / 10
  }
  const fixed = new Map(list.map(r => [r.id, r] as const))
  return rows.map(r => fixed.get(r.id) ?? r)
}

export function StrikesPanel({ ws }: { ws: WorkspaceCfg }) {
  const patchWs = useTerminal(s => s.patchWs)
  const st: StrikesCfg = useMemo(() => ws.strikes ?? defaultStrikes(), [ws])

  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const underlyings = undData?.underlyings ?? []

  // accounts: representative usable capital (first order-enabled) + PnL labels
  // (via sync:core websocket — REST fallback while the socket is down)
  const coreAcc = useSyncChannel<SyncCore>('sync:core')
  const { data: accRest } = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts(), enabled: !coreAcc, refetchInterval: 4000 })
  const accounts = (coreAcc?.accounts as unknown as AccountRow[] | undefined) ?? accRest?.accounts ?? []
  const repUsable = useMemo(() => {
    const on = accounts.filter(a => a.isOrderEnabled)
    return (on[0] ?? accounts[0])?.usableCapital ?? 0
  }, [accounts])

  // auto-bind the workspace's F&O symbol on first open
  useEffect(() => {
    if (!st.underlying && underlyings.some(u => u.underlying === ws.symbol)) {
      patchWs(ws.id, { strikes: { ...st, underlying: ws.symbol } })
    }
  }, [st.underlying, underlyings, ws.symbol, ws.id, patchWs]) // eslint-disable-line react-hooks/exhaustive-deps

  const underlying = st.underlying
  const strikesParam = useMemo(() => [...new Set(st.rows.map(r => r.strike))].sort((a, b) => a - b), [st.rows])

  const { data: chainRest, refetch: refetchChain } = useQuery({
    queryKey: ['optionChain', underlying, st.expiry, strikesParam.join(',')],
    queryFn: () => api.optionChain(underlying!, st.expiry, strikesParam),
    enabled: !!underlying,
    refetchInterval: 8000, // backup only — realtime quotes arrive via sync:chain (1s)
  })
  const chainSync = useSyncData<SyncChainResp>(
    'sync:chain',
    d => !!d && (d as { meta?: { underlying?: string } }).meta?.underlying === underlying,
    underlying ? { chains: [{ underlying, expiry: st.expiry ?? null }] } : undefined,
  )
  const chainData = mergeChain(chainSync, chainRest)
  const meta = chainData?.meta ?? null
  const rowByStrike = useMemo(() => {
    const m = new Map<number, ChainStrikeRow>()
    for (const r of chainData?.rows ?? []) m.set(r.strike, r)
    return m
  }, [chainData])

  const addStrike = async (strike: number, type: 'CE' | 'PE') => {
    if (!underlying) { toast.error('Pick an F&O underlying first'); return }
    const id = `${strike}:${type}`
    // read fresh store state (consecutive/parallel adds must not clobber each other)
    const before = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st
    if (before.rows.some(r => r.id === id)) { toast.info(`${strike} ${type} already in list`); return }
    try {
      const r = await api.ensureStrike(underlying, strike, st.expiry)
      if (r.created > 0) toast.success(`Contracts ready — ${r.symbols.join(', ')}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create contracts')
      return
    }
    // re-read AFTER the await so an interleaved add is not overwritten
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? before
    if (cur.rows.some(r => r.id === id)) { return }
    const rows = normalizeSide([...cur.rows, { id, strike, type, enabled: true, allocPct: 0 }], type)
    patchWs(ws.id, { strikes: { ...cur, rows } })
    setTimeout(() => refetchChain(), 150)
  }

  // auto-load the side-ATM pair the first time an F&O workspace binds
  // (watchlist / search → open workspace lands with ATM CE + PE ready)
  const autoLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!underlying || !meta || st.rows.length > 0) return
    const key = `${ws.id}:${underlying}:${meta.expiry}`
    if (autoLoadedRef.current === key) return
    autoLoadedRef.current = key
    void (async () => {
      await addStrike(meta.ceAtm, 'CE')
      await addStrike(meta.peAtm, 'PE')
    })()
  }, [underlying, meta, st.rows.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // positions via the sync hub (fallback REST) — aggregated per symbol
  const core = useSyncChannel<SyncCore>('sync:core')
  const { data: posData } = useQuery({ queryKey: ['positions'], queryFn: () => api.positions(), enabled: !core, refetchInterval: 2000 })
  const posBySymbol = useMemo(() => {
    const m = new Map<string, { netQty: number; avgPrice: number; unrealizedPnl: number; realizedPnl: number }>()
    const put = (sym: string, netQty: number, avgPrice: number, unreal: number, realized: number) => {
      const cur = m.get(sym)
      if (!cur) { m.set(sym, { netQty, avgPrice, unrealizedPnl: unreal, realizedPnl: realized }); return }
      const totQty = Math.abs(cur.netQty) + Math.abs(netQty)
      cur.avgPrice = totQty > 0 ? (cur.avgPrice * Math.abs(cur.netQty) + avgPrice * Math.abs(netQty)) / totQty : avgPrice
      cur.netQty += netQty
      cur.unrealizedPnl += unreal
      cur.realizedPnl += realized
    }
    if (core) {
      for (const p of core.positions) put(p.symbol, p.netQty, p.avgPrice, p.unrealizedPnl, p.realizedPnl)
    } else {
      for (const p of posData?.bySymbol ?? []) {
        put(p.symbol, p.netQty, p.avgPrice, p.unrealizedPnl, (p as unknown as { realizedPnl?: number }).realizedPnl ?? 0)
      }
    }
    return m
  }, [core, posData])

  // ---- side PnL (per CE / PE side, from this workspace's enabled strikes) ----
  const sidePnl = (type: 'CE' | 'PE') => {
    let u = 0
    for (const row of st.rows.filter(r => r.type === type && r.enabled)) {
      const cell = cellFor(row)
      const pos = cell ? posBySymbol.get(cell.symbol) : undefined
      if (pos) u += pos.unrealizedPnl
    }
    return u
  }

  const [specific, setSpecific] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  // sort + filter (applied to both sides)
  const [sortBy, setSortBy] = useState<'strike' | 'ltp' | 'chg' | 'pnl'>('strike')
  const [sortAsc, setSortAsc] = useState(true)
  const [rowFilter, setRowFilter] = useState<'all' | 'enabled' | 'position'>('all')
  // CE/PE SPLIT is user-resizable: ceShare = fraction of the desk height the
  // CE pane owns (0.15–0.85), persisted per browser so the layout sticks.
  // The CE pane's flex is owned EXCLUSIVELY by this logic: useLayoutEffect
  // applies it on mount / commit, and the drag updates it IMPERATIVELY via
  // rAF (no re-render per move, no React style prop that could fight the
  // drag when tick data re-renders the panel). The fraction is committed to
  // state once on release. The divider's CENTER (not its top edge) tracks
  // the cursor, so the grab point never jumps — same feel as the panel
  // resizers.
  const [ceShare, setCeShare] = useState(() => {
    try { return Math.min(0.85, Math.max(0.15, Number(window.localStorage.getItem('qd_ce_share')) || 0.5)) }
    catch { return 0.5 }
  })
  const deskRef = useRef<HTMLDivElement | null>(null)   // CE + divider + PE wrapper
  const cePaneRef = useRef<HTMLDivElement | null>(null) // the CE pane (flex driven here)
  const dragState = useRef({ active: false, raf: 0, frac: 0.5 })
  useEffect(() => {
    try { window.localStorage.setItem('qd_ce_share', String(ceShare)) } catch { /* ignore */ }
  }, [ceShare])
  const applySplitFrac = (frac: number) => {
    const f = Math.min(0.85, Math.max(0.15, frac))
    if (cePaneRef.current) cePaneRef.current.style.flex = `0 0 ${(f * 100).toFixed(3)}%`
  }
  // Callback ref: strikes rows hydrate async, so the CE pane can mount AFTER
  // this component — a callback ref re-applies the saved fraction on EVERY
  // mount (a plain useLayoutEffect would miss the remount and leave the pane
  // at auto height until the next drag).
  const setCePane = (el: HTMLDivElement | null) => {
    cePaneRef.current = el
    if (el) applySplitFrac(dragState.current.active ? dragState.current.frac : ceShare)
  }
  const dragSplit = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragState.current.active = true
    dragState.current.frac = ceShare
  }
  const moveSplit = (e: React.PointerEvent) => {
    if (!dragState.current.active || !deskRef.current) return
    e.preventDefault()
    const box = deskRef.current.getBoundingClientRect()
    // offset by half the 8px divider so its CENTER — not its top edge —
    // sits exactly under the cursor (no jump on grab)
    const frac = (e.clientY - box.top - 4) / Math.max(1, box.height)
    dragState.current.frac = Math.min(0.85, Math.max(0.15, frac))
    if (!dragState.current.raf) {
      dragState.current.raf = requestAnimationFrame(() => {
        dragState.current.raf = 0
        applySplitFrac(dragState.current.frac)
      })
    }
  }
  const endSplit = (e: React.PointerEvent) => {
    if (!dragState.current.active) return
    dragState.current.active = false
    if (dragState.current.raf) { cancelAnimationFrame(dragState.current.raf); dragState.current.raf = 0 }
    applySplitFrac(dragState.current.frac)
    setCeShare(dragState.current.frac)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }

  const setStrikes = (next: Partial<StrikesCfg>) => patchWs(ws.id, { strikes: { ...st, ...next } })
  const allocMode: AllocMode = ws.allocMode ?? 'PCT'

  /** Replace rows + re-normalize the affected side (PCT mode only). Callers build rows from the
   *  LATEST persisted state (rapid consecutive toggles must not clobber each
   *  other's change); this re-reads the cfg for the remaining fields. */
  const commitRows = (nextRows: StrikeRowCfg[], type: 'CE' | 'PE') => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st
    patchWs(ws.id, { strikes: { ...cur, rows: allocMode === 'PCT' ? normalizeSide(nextRows, type) : nextRows } })
  }

  /** ITM / ATM / OTM quick-add — side-specific strikes (CE ITM counts down
   *  from the floor ATM, PE ITM counts up from the ceil ATM) + the pair add
   *  for ATM. Uses the LIVE chain meta so buttons always track spot. */
  const addLabeled = async (dir: -1 | 0 | 1, n: number) => {
    if (!meta) { toast.error('Chain not loaded yet'); return }
    const atm = { ce: meta.ceAtm, pe: meta.peAtm }
    if (dir === 0) {
      await addStrike(atm.ce, 'CE')
      await addStrike(atm.pe, 'PE')
      return
    }
    await addStrike(sideStrikeFor(atm, meta.step, dir, n, 'CE'), 'CE')
    await addStrike(sideStrikeFor(atm, meta.step, dir, n, 'PE'), 'PE')
  }

  const addSpecific = async () => {
    const raw = Number(specific)
    if (!underlying || !Number.isFinite(raw) || raw <= 0) { toast.error('Enter a valid strike'); return }
    const step = meta?.step ?? 50
    const snapped = Math.round(raw / step) * step
    if (snapped !== raw) toast.info(`Snapped ${raw} → ${snapped} (step ${step})`)
    setSpecific('')
    await addStrike(snapped, 'CE')
    await addStrike(snapped, 'PE')
  }

  const toggleRow = (row: StrikeRowCfg) => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st
    const rows = cur.rows.map(r => (r.id === row.id ? { ...r, enabled: !r.enabled } : r))
    commitRows(rows, row.type)
  }

  const setAlloc = (row: StrikeRowCfg, v: number) => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st
    let rows: StrikeRowCfg[]
    if (allocMode === 'FIXED') {
      const amt = Math.max(0, Number.isFinite(v) ? v : 0)
      rows = cur.rows.map(r => (r.id === row.id ? { ...r, allocAmt: amt } : r))
    } else {
      const clamped = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0))
      rows = cur.rows.map(r => (r.id === row.id ? { ...r, allocPct: clamped } : r))
    }
    commitRows(rows, row.type)
  }

  const removeRow = (row: StrikeRowCfg) => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st
    const rows = cur.rows.filter(r => r.id !== row.id)
    commitRows(rows, row.type)
    setExpanded(null)
  }

  const pinToPane = (row: StrikeRowCfg) => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id) ?? ws
    patchWs(ws.id, pinStrikePanes(cur, row.strike, row.type))
    useTerminal.getState().setActiveStrike({ strike: row.strike, type: row.type, wsId: ws.id })
  }

  // --- order helpers ---
  const cellFor = (row: StrikeRowCfg): OptionQuoteCell | null => {
    const c = rowByStrike.get(row.strike)
    if (!c) return null
    return row.type === 'CE' ? c.ce : c.pe
  }

  /** Sizing params for one strike row in the current alloc mode. */
  const sizingFor = (row: StrikeRowCfg): Record<string, unknown> =>
    allocMode === 'FIXED'
      ? { tag: `abs:${Math.max(0, row.allocAmt ?? 0)}` } // router: absolute ₹ per account
      : { capitalPct: row.allocPct }

  // (Deploy / Cancel / Swap / Exit-All moved to the persistent StrikeActions
  //  bar — rendered below the panel content for EVERY right-dock tab so the
  //  quick-deploy buttons stay consistent wherever the user is.)

  /** B = plain market BUY of THIS strike; S = plain market SELL of THIS strike.
   *  Sizing = the row's alloc (PCT % of usable capital, or fixed ₹) per account. */
  const rowOrder = async (row: StrikeRowCfg, side: 'BUY' | 'SELL') => {
    const cell = cellFor(row)
    if (!cell?.exists) { toast.error('Quote unavailable'); return }
    try {
      const res = await api.placeOrder({
        symbol: cell.symbol, exchange: 'NFO', side, qty: 0,
        orderType: 'MARKET', productType: 'MIS', source: 'MANUAL',
        ...sizingFor(row),
      })
      res.status === 'FAILED'
        ? toast.error(`${side} failed — ${res.message}`)
        : toast.success(`${side} ${row.strike} ${row.type} @ MKT — ${res.legs.filter(l => l.status === 'FILLED').length}/${res.legs.length} accounts`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Order failed') }
  }

  const rowExit = async (row: StrikeRowCfg) => {
    const cell = cellFor(row)
    if (!cell?.exists) { toast.error('Quote unavailable'); return }
    const pos = posBySymbol.get(cell.symbol)
    if (!pos || pos.netQty === 0) { toast.info('No open position'); return }
    try {
      const so = await api.squareOffAll(false, [cell.symbol])
      so.orders > 0 ? toast.success(`Exit ${row.strike} ${row.type} — ${so.filledLegs} legs`) : toast.info('Nothing to exit')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Exit failed') }
  }

  // --- price-order helpers (entry / target / stoploss at a specific price) ---

  /** LIMIT entry at a specific price — auto-sized by the row's alloc % per account. */
  const placeEntry = async (row: StrikeRowCfg, side: 'BUY' | 'SELL', price: number) => {
    const cell = cellFor(row)
    if (!cell?.exists) { toast.error('Quote unavailable'); return }
    if (!Number.isFinite(price) || price <= 0) { toast.error('Enter a valid price'); return }
    try {
      const res = await api.placeOrder({
        symbol: cell.symbol, exchange: 'NFO', side, qty: 0,
        orderType: 'LIMIT', productType: 'MIS', source: 'MANUAL',
        capitalPct: row.allocPct, limitPrice: price,
      })
      const f = res.legs.filter(l => l.status === 'FILLED').length
      const r = res.legs.filter(l => l.status === 'OPEN').length
      if (f + r === 0) toast.error(`Entry failed — ${res.message}`)
      else toast.success(`${side} ${row.strike} ${row.type} LIMIT @ ${fmtMoney(price)} — ${f} filled${r ? ` · ${r} resting` : ''}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Order failed') }
  }

  /** Target — reduce-only LIMIT at the price (books the open position there). */
  const placeTarget = async (row: StrikeRowCfg, price: number) => {
    const cell = cellFor(row)
    if (!cell?.exists) { toast.error('Quote unavailable'); return }
    if (!Number.isFinite(price) || price <= 0) { toast.error('Enter a valid price'); return }
    const pos = posBySymbol.get(cell.symbol)
    if (!pos || pos.netQty === 0) { toast.info('No open position to set a target on'); return }
    const side = pos.netQty > 0 ? 'SELL' : 'BUY'
    const lots = Math.abs(pos.netQty) / (meta?.lotSize || 1)
    try {
      const res = await api.placeOrder({
        symbol: cell.symbol, exchange: 'NFO', side, qty: lots,
        orderType: 'LIMIT', productType: 'MIS', source: 'MANUAL',
        limitPrice: price, reduceOnly: true, strategyId: 'reduce',
      })
      const f = res.legs.filter(l => l.status === 'FILLED').length
      const r = res.legs.filter(l => l.status === 'OPEN').length
      if (f + r === 0) toast.error(`Target failed — ${res.message}`)
      else toast.success(`Target: ${side} ${lots} lot(s) LIMIT @ ${fmtMoney(price)} — resting until hit`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Order failed') }
  }

  /** StopLoss — reduce-only SL-M triggered at the price. */
  const placeStop = async (row: StrikeRowCfg, price: number) => {
    const cell = cellFor(row)
    if (!cell?.exists) { toast.error('Quote unavailable'); return }
    if (!Number.isFinite(price) || price <= 0) { toast.error('Enter a valid price'); return }
    const pos = posBySymbol.get(cell.symbol)
    if (!pos || pos.netQty === 0) { toast.info('No open position to protect'); return }
    const side = pos.netQty > 0 ? 'SELL' : 'BUY'
    const lots = Math.abs(pos.netQty) / (meta?.lotSize || 1)
    try {
      const res = await api.placeOrder({
        symbol: cell.symbol, exchange: 'NFO', side, qty: lots,
        orderType: 'SL-M', productType: 'MIS', source: 'MANUAL',
        triggerPrice: price, reduceOnly: true, strategyId: 'reduce',
      })
      const f = res.legs.filter(l => l.status === 'FILLED').length
      const r = res.legs.filter(l => l.status === 'OPEN').length
      if (f + r === 0) toast.error(`SL failed — ${res.message}`)
      else toast.success(`SL: ${side} ${lots} lot(s) SL-M trigger @ ${fmtMoney(price)} — armed`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Order failed') }
  }

  // ---- sort + filter machinery (applies to both sides) ----
  const activeStrike = useTerminal(s => s.activeStrike)
  const sortRows = (rows: StrikeRowCfg[]) => {
    const filt = rows.filter(r =>
      rowFilter === 'all' ? true
      : rowFilter === 'enabled' ? r.enabled
      : (() => { const c = cellFor(r); return c?.exists ? (posBySymbol.get(c.symbol)?.netQty ?? 0) !== 0 : false })(),
    )
    const val = (r: StrikeRowCfg): number => {
      const c = cellFor(r)
      const p = c?.exists ? posBySymbol.get(c.symbol) : undefined
      switch (sortBy) {
        case 'ltp': return c?.ltp ?? 0
        case 'chg': return c?.changePct ?? 0
        case 'pnl': return p ? p.unrealizedPnl + (p.realizedPnl ?? 0) : Number.NEGATIVE_INFINITY
        default: return r.strike
      }
    }
    return [...filt].sort((a, b) => (sortAsc ? val(a) - val(b) : val(b) - val(a)))
  }
  // (react compiler auto-memoizes these — manual useMemo with partial deps
  //  made the compiler skip optimizing the whole component)
  const ceRows = sortRows(st.rows.filter(r => r.type === 'CE'))
  const peRows = sortRows(st.rows.filter(r => r.type === 'PE'))
  const sideSum = (type: 'CE' | 'PE') => {
    const on = st.rows.filter(r => r.type === type && r.enabled)
    if (allocMode === 'FIXED') return on.reduce((s, r) => s + (r.allocAmt ?? 0), 0)
    return Math.round(on.reduce((s, r) => s + r.allocPct, 0) * 10) / 10
  }

  const offsetFor = (row: StrikeRowCfg): number | null => {
    const chainRow = rowByStrike.get(row.strike)
    if (!chainRow) return null
    return row.type === 'CE' ? chainRow.offsetCe : chainRow.offsetPe
  }

  const renderRow = (row: StrikeRowCfg) => {
    const cell = cellFor(row)
    const offset = offsetFor(row)
    const pos = cell?.exists ? posBySymbol.get(cell.symbol) : undefined
    const lots = pos ? Math.abs(pos.netQty) / (meta?.lotSize || 1) : 0
    const pinned = (row.type === 'CE' ? ws.panes?.find(p => p.key === 'ce') : ws.panes?.find(p => p.key === 'pe'))?.strike === row.strike
    const isActive = activeStrike?.wsId === ws.id && activeStrike.strike === row.strike && activeStrike.type === row.type
    // planned sizing: rupee amount + the lots it will place (at the live premium)
    const lotSize = meta?.lotSize || 1
    const ltpSafe = cell?.exists && cell.ltp > 0 ? cell.ltp : 0
    const planAmt = allocMode === 'FIXED' ? (row.allocAmt ?? 0) : (row.allocPct / 100) * repUsable
    const planLots = ltpSafe > 0 ? Math.floor(planAmt / (ltpSafe * lotSize)) : 0
    const perLot = ltpSafe * lotSize
    const strikePnl = pos ? pos.unrealizedPnl + (pos.realizedPnl ?? 0) : null
    const chgPts = cell?.exists && cell.prevClose ? cell.ltp - cell.prevClose : 0
    const label = sideOffsetLabel(offset, row.type)
    return (
      <div key={row.id} className={expanded === row.id ? 'bg-accent/40' : ''}>
        {/* line 1 — enable · strike+LIVE ITM/OTM label · alloc slider (max width) · LTP/chg/H-L */}
        <div className="flex items-center gap-1 px-1.5 pt-1 pb-0.5">
          <button
            onClick={() => toggleRow(row)}
            title={row.enabled ? 'Enabled for deploy — click to disable' : 'Disabled — click to enable'}
            className={`h-3.5 w-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
              row.enabled ? 'bg-primary border-primary' : 'border-muted-foreground/40'
            }`}
          >
            {row.enabled && <Power className="h-2.5 w-2.5 text-primary-foreground" />}
          </button>
          <button
            onClick={() => pinToPane(row)}
            title={`Load ${row.strike} ${row.type} into the ${row.type} chart pane${isActive ? ' (now on the chart)' : ''}`}
            className={`w-[64px] shrink-0 text-left leading-tight hover:bg-accent/70 rounded px-0.5 -mx-0.5 ${
              isActive ? 'ring-1 ring-[#e0a63f] bg-[#e0a63f]/10' : pinned ? 'ring-1 ring-primary/60' : ''
            }`}
          >
            <span className="block tabular font-semibold text-[11px]">{row.strike}</span>
            <span className={`block text-[8px] font-bold ${row.type === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>
              {row.type} · {label}
            </span>
          </button>
          <AllocCell value={allocMode === 'FIXED' ? (row.allocAmt ?? 0) : row.allocPct} mode={allocMode} enabled={row.enabled} onCommit={v => setAlloc(row, v)} />
          <div className="flex-1 min-w-0 text-right pr-1">
            <div className={`tabular ${cell && cell.ltp >= cell.prevClose ? 'term-up' : 'term-down'}`}>
              {cell?.exists ? fmtMoney(cell.ltp) : '—'}
            </div>
            <div className="tabular text-[9px] whitespace-nowrap">
              <span className={chgPts >= 0 ? 'term-up' : 'term-down'}>{cell?.exists ? `${chgPts >= 0 ? '+' : ''}${fmtMoney(chgPts, 1)} (${cell.changePct >= 0 ? '+' : ''}${cell.changePct.toFixed(1)}%)` : '—'}</span>
              <span className="text-muted-foreground"> · {cell?.exists ? `${fmtMoney(cell.high, 0)}/${fmtMoney(cell.low, 0)}` : 'H/L'}</span>
            </div>
          </div>
          {lots > 0 && (
            <span className={`text-[8px] px-1 rounded ${pos && pos.netQty > 0 ? 'bg-up text-[#00c896]' : 'bg-down text-[#ff4d5e]'}`} title={`${lots} lots @ ${fmtMoney(pos!.avgPrice)}`}>
              {pos && pos.netQty > 0 ? 'L' : 'S'}{lots}
            </span>
          )}
        </div>
        {/* line 2 — amount / lots / per-lot cost + PnL + B/S/X/edit (next line as requested) */}
        <div className="flex items-center justify-between px-1.5 pb-1 pl-6 text-[8px] tabular gap-1">
          <span className="text-muted-foreground truncate" title={allocMode === 'FIXED' ? 'Fixed rupee allocation per account' : `% x representative usable (${fmtMoney(repUsable, 0)}) · per-lot = ltp x lot`}>
            ≈ {fmtMoney(planAmt, 0)} · {planLots} lot{planLots === 1 ? '' : 's'}{perLot > 0 ? ` · ${fmtMoney(perLot, 0)}/lot` : ''}
          </span>
          {strikePnl != null && lots > 0 && (
            <span className={`${strikePnl >= 0 ? 'term-up font-semibold' : 'term-down font-semibold'} shrink-0`} title={`unrealized ${fmtMoney(pos!.unrealizedPnl)} + realized ${fmtMoney(pos!.realizedPnl ?? 0)}`}>
              {strikePnl >= 0 ? '+' : ''}{fmtMoney(strikePnl, 0)}
            </span>
          )}
          <div className="flex gap-0.5 shrink-0 items-center">
            {cell?.exists && <DepthAddButton ws={ws} symbol={cell.symbol} />}
            <button onClick={() => rowOrder(row, 'BUY')} title={`Market BUY ${row.strike} ${row.type} (${allocMode === 'FIXED' ? `₹${row.allocAmt ?? 0}` : `${row.allocPct}%`} per account)`} className="px-1 py-0.5 rounded bg-up text-[#00c896] hover:brightness-125 text-[9px] font-bold">B</button>
            <button onClick={() => rowOrder(row, 'SELL')} title={`Market SELL ${row.strike} ${row.type} (${allocMode === 'FIXED' ? `₹${row.allocAmt ?? 0}` : `${row.allocPct}%`} per account)`} className="px-1 py-0.5 rounded bg-down text-[#ff4d5e] hover:brightness-125 text-[9px] font-bold">S</button>
            <button onClick={() => rowExit(row)} title="Exit this strike's position" className="px-1 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground text-[9px] font-bold">X</button>
            <button
              onClick={() => setExpanded(expanded === row.id ? null : row.id)}
              className={`p-0.5 rounded ${expanded === row.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              title="Edit open position / orders at price"
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
          </div>
        </div>

        {expanded === row.id && (
          <StrikeRowEditor
            row={row}
            cell={cell}
            lots={lots}
            pos={pos ?? null}
            lotSize={lotSize}
            onApply={async (deltaLots) => {
              const cell2 = cellFor(row)
              if (!cell2?.exists) return
              if (deltaLots > 0) {
                const res = await api.placeOrder({
                  symbol: cell2.symbol, exchange: 'NFO', side: 'BUY', qty: deltaLots,
                  orderType: 'MARKET', productType: 'MIS', source: 'MANUAL',
                })
                res.status === 'FAILED' ? toast.error(`Add failed — ${res.message}`) : toast.success(`+${deltaLots} lot(s)/leg — ${res.legs.filter(l => l.status === 'FILLED').length} legs`)
              } else if (deltaLots < 0) {
                await api.placeOrder({
                  symbol: cell2.symbol, exchange: 'NFO', side: 'SELL', qty: Math.abs(deltaLots),
                  orderType: 'MARKET', productType: 'MIS', source: 'MANUAL', reduceOnly: true,
                })
                toast.success(`${deltaLots} lot(s)/leg exited`)
              }
            }}
            onExit={async () => {
              const cell2 = cellFor(row)
              if (!cell2) return
              const so = await api.squareOffAll(false, [cell2.symbol])
              toast.success(`Exited — ${so.filledLegs} legs`)
            }}
            onEntry={(side, price) => placeEntry(row, side, price)}
            onTarget={price => placeTarget(row, price)}
            onStop={price => placeStop(row, price)}
            onRemove={() => removeRow(row)}
          />
        )}
      </div>
    )
  }

  const sideHeader = (type: 'CE' | 'PE') => {
    const sum = sideSum(type)
    const n = st.rows.filter(r => r.type === type && r.enabled).length
    const tint = type === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'
    const sPnl = sidePnl(type)
    return (
      <div className="flex items-center gap-1.5 px-1.5 py-0.5 bg-secondary/40 border-b border-border/60 sticky top-0 z-10">
        <span className={`text-[9px] font-bold ${tint}`}>{type}</span>
        <span className="text-[8px] text-muted-foreground">
          {type === 'CE' && meta ? `ATM ${meta.ceAtm}` : meta ? `ATM ${meta.peAtm}` : ''}
        </span>
        <div className="flex-1" />
        {sPnl !== 0 && (
          <span className={`text-[8px] tabular font-semibold ${sPnl >= 0 ? 'term-up' : 'term-down'}`} title={`Open ${type} positions PnL (this side's enabled strikes)`}>
            {sPnl >= 0 ? '+' : ''}{fmtMoney(sPnl, 0)}
          </span>
        )}
        {allocMode === 'FIXED' ? (
          <span className="text-[8px] tabular px-1 rounded bg-secondary/70 text-foreground" title="Enabled strikes fixed ₹ allocation (per account)">
            Σ ₹{sum.toLocaleString('en-IN')}
          </span>
        ) : (
          <span className={`text-[8px] tabular px-1 rounded ${sum === 100 ? 'bg-up/60 text-[#00c896]' : 'bg-amber-500/15 text-amber-400'}`} title="Enabled strikes alloc sum (auto-normalized to 100%)">
            Σ {sum}%
          </span>
        )}
        <span className="text-[8px] text-muted-foreground">{n} on</span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-[11px]">
      {/* underlying + expiry selectors (live context stays on top) */}
      <div className="p-1.5 space-y-1 border-b border-border shrink-0">
        <div className="flex gap-1">
          <select
            value={underlying ?? ''}
            onChange={e => setStrikes({ underlying: e.target.value || null })}
            className="h-6 flex-1 min-w-0 rounded bg-secondary/60 px-1 text-[10px] outline-none"
          >
            <option value="">F&O underlying…</option>
            {underlyings.map(u => (
              <option key={u.underlying} value={u.underlying}>{u.underlying} · L{u.lotSize}</option>
            ))}
          </select>
          <select
            value={st.expiry ?? ''}
            onChange={e => setStrikes({ expiry: e.target.value || null })}
            disabled={!meta}
            className="h-6 w-[92px] rounded bg-secondary/60 px-1 text-[9px] outline-none"
          >
            <option value="">Nearest</option>
            {(meta?.expiries ?? []).map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div className="flex items-center justify-between tabular text-[9px]">
          <span className="text-muted-foreground">
            Spot <b className={meta && meta.spot >= meta.prevClose ? 'term-up' : 'term-down'}>{meta ? fmtMoney(meta.spot) : '—'}</b>
          </span>
          <span className="text-muted-foreground">
            C<b className="text-[#00c896]">{meta?.ceAtm ?? '—'}</b> P<b className="text-[#ff4d5e]">{meta?.peAtm ?? '—'}</b>
          </span>
          <span className="text-muted-foreground">s{meta?.step ?? '—'} L{meta?.lotSize ?? '—'}</span>
        </div>
      </div>

      {/* strike rows — CE and PE SPLIT panes: heights follow the draggable
          divider (deskRef box = CE + divider + PE ONLY — the sort/filter
          header sits outside above, so the drag fraction maps 1:1 onto the
          desk and the divider center lands exactly under the cursor), both
          sides always visible, INDIVIDUAL scrolls */}
      {st.rows.length === 0 ? (
          <div className="p-3 text-center text-[10px] text-muted-foreground leading-relaxed">
            Tap <b>ITM/ATM/OTM</b> buttons below to add<br />CE+PE strikes, or enter a specific strike.<br />
            <span className="text-[9px]">Click a strike to load it into the chart pane.</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1 px-1.5 py-0.5 border-b border-border/40 text-[8px] text-muted-foreground shrink-0 bg-card/90">
              <ArrowDownUp className="h-2.5 w-2.5 shrink-0" />
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as typeof sortBy)}
                className="h-4 rounded bg-secondary/60 px-0.5 text-[8px] outline-none"
                title="Sort strikes"
              >
                <option value="strike">strike</option>
                <option value="ltp">LTP</option>
                <option value="chg">chg%</option>
                <option value="pnl">PnL</option>
              </select>
              <button
                onClick={() => setSortAsc(a => !a)}
                className="px-1 rounded bg-secondary/60 hover:text-foreground"
                title={sortAsc ? 'Ascending — click for descending' : 'Descending — click for ascending'}
              >{sortAsc ? '↑' : '↓'}</button>
              <span className="w-px h-3 bg-border" />
              {([['all', 'all'], ['enabled', 'on'], ['position', 'pos']] as [typeof rowFilter, string][]).map(([f, l]) => (
                <button
                  key={f}
                  onClick={() => setRowFilter(f)}
                  className={`px-1 py-0.5 rounded ${rowFilter === f ? 'bg-primary/25 text-foreground' : 'hover:text-foreground'}`}
                  title={f === 'all' ? 'Show all rows' : f === 'enabled' ? 'Only deploy-enabled rows' : 'Only rows with an open position'}
                >{l}</button>
              ))}
              <div className="flex-1" />
              <span>{ceRows.length + peRows.length}/{st.rows.length} rows</span>
            </div>
            {/* SPLIT DESK — CE + divider + PE only (header above is outside) */}
            <div ref={deskRef} className="flex-1 min-h-0 flex flex-col">
            {/* CE pane — height follows the user's draggable split (flex is
                applied imperatively — see applySplitFrac — never via a React
                style prop, so live ticks re-rendering this panel cannot snap
                the pane back mid-drag) */}
            <div
              ref={setCePane}
              className="flex min-h-0 flex-col border-b border-border/60"
            >
              <div className="flex-1 min-h-0 overflow-y-auto">
                {ceRows.length > 0 ? (
                  <>{sideHeader('CE')}{ceRows.map(renderRow)}</>
                ) : (
                  <div className="p-2 text-center text-[9px] text-muted-foreground">no CE strikes — add from the buttons below</div>
                )}
              </div>
            </div>
            {/* RESIZABLE DIVIDER — drag up/down to give CE or PE more room
                (divider follows the cursor 1:1; smooth via rAF) */}
            <div
              onPointerDown={dragSplit}
              onPointerMove={moveSplit}
              onPointerUp={endSplit}
              onPointerCancel={endSplit}
              className="relative h-2 shrink-0 cursor-row-resize select-none touch-none"
              title="Drag to resize CE / PE panes"
            >
              <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-border group-hover:bg-primary/60" />
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-[3px] rounded-full bg-muted-foreground/60" />
            </div>
            {/* PE pane — takes the rest */}
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex-1 min-h-0 overflow-y-auto">
                {peRows.length > 0 ? (
                  <>{sideHeader('PE')}{peRows.map(renderRow)}</>
                ) : (
                  <div className="p-2 text-center text-[9px] text-muted-foreground">no PE strikes — add from the buttons below</div>
                )}
              </div>
            </div>
            </div>
          </>
        )}

      {/* ITM / ATM / OTM quick-add — BOTTOM of the desk (strikes rows above) */}
      <div className="border-t border-border p-1.5 space-y-1 bg-card/40 shrink-0">
        {meta && (
          <div className="space-y-1">
            {([[-1, 'ITM'], [1, 'OTM']] as [-1 | 1, string][]).map(([dir, lbl]) => (
              <div key={lbl} className="flex items-center gap-0.5">
                <span
                  className={`w-7 shrink-0 text-[8px] font-bold uppercase ${dir === -1 ? 'text-[#4dd0e1]' : 'text-[#e0a63f]'}`}
                  title={dir === -1 ? 'In the money — CE below spot / PE above spot' : 'Out of the money — CE above spot / PE below spot'}
                >{lbl}</span>
                {[1, 2, 3, 4, 5].map(n => {
                  const ce = sideStrikeFor({ ce: meta.ceAtm, pe: meta.peAtm }, meta.step, dir, n, 'CE')
                  const pe = sideStrikeFor({ ce: meta.ceAtm, pe: meta.peAtm }, meta.step, dir, n, 'PE')
                  const added = st.rows.some(r => r.id === `${ce}:CE`) && st.rows.some(r => r.id === `${pe}:PE`)
                  return (
                    <button
                      key={n}
                      onClick={() => addLabeled(dir, n)}
                      title={`${lbl} ${n} → CE ${ce} · PE ${pe}`}
                      className={`flex-1 px-0 py-0.5 rounded text-[9px] tabular transition-colors ${
                        added ? 'bg-primary/25 text-foreground' : 'bg-secondary/70 text-muted-foreground hover:text-foreground hover:bg-accent'
                      }`}
                    >{n}</button>
                  )
                })}
              </div>
            ))}
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => addLabeled(0, 0)}
                title={`Add ATM pair — CE ${meta.ceAtm} + PE ${meta.peAtm}`}
                className="flex-1 px-0 py-0.5 rounded text-[9px] font-bold bg-primary/25 text-foreground hover:bg-primary/40 transition-colors"
              >ATM</button>
              <span className="text-[8px] text-muted-foreground shrink-0 px-0.5 tabular">
                C{meta.ceAtm} · P{meta.peAtm}
              </span>
            </div>
            <div className="flex gap-1">
              <Input
                value={specific}
                onChange={e => setSpecific(e.target.value.replace(/[^0-9.]/g, ''))}
                onKeyDown={e => e.key === 'Enter' && addSpecific()}
                placeholder="Specific strike…"
                className="h-6 flex-1 min-w-0 text-[10px] bg-secondary/60"
              />
              <Button size="sm" variant="secondary" className="h-6 px-1.5 text-[10px]" onClick={addSpecific} disabled={!specific}>
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Per-strike allocation cell — % (with inline slider) or fixed ₹.
// Local edit state, commits on blur/Enter/release (re-normalizing
// on every keystroke would fight the typist).
// ------------------------------------------------------------
function AllocCell({ value, mode, enabled, onCommit }: {
  value: number
  mode: AllocMode
  enabled: boolean
  onCommit: (v: number) => void
}) {
  const [txt, setTxt] = useState(mode === 'FIXED' ? String(Math.round(value)) : String(value))
  const [focus, setFocus] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync slider -> text when not focused
  useEffect(() => { if (!focus) setTxt(mode === 'FIXED' ? String(Math.round(value)) : String(Math.round(value * 10) / 10)) }, [value, focus, mode])

  if (mode === 'FIXED') {
    return (
      <input
        value={txt}
        disabled={!enabled}
        onChange={e => setTxt(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={() => setFocus(true)}
        onBlur={() => { setFocus(false); onCommit(Number(txt)) }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        title="Fixed ₹ allocation per account for this strike"
        className="h-4.5 w-11 shrink-0 rounded bg-secondary/60 text-center text-[9px] tabular outline-none focus:ring-1 ring-primary/60 disabled:opacity-40"
      />
    )
  }
  return (
    <span className="flex items-center gap-1 flex-1 min-w-0 max-w-[150px] shrink" title="Alloc % of usable capital — drag the slider or type; side auto-normalizes to 100%">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.max(0, Math.min(100, Number(txt) || 0))}
        disabled={!enabled}
        onChange={e => setTxt(e.target.value)}
        onMouseUp={e => onCommit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={e => onCommit(Number((e.target as HTMLInputElement).value))}
        className="h-1 flex-1 min-w-8 accent-[#3b82f6] cursor-pointer disabled:opacity-40"
      />
      <input
        value={txt}
        disabled={!enabled}
        onChange={e => setTxt(e.target.value.replace(/[^0-9.]/g, ''))}
        onFocus={() => setFocus(true)}
        onBlur={() => { setFocus(false); onCommit(Number(txt)) }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="h-4.5 w-9 shrink-0 rounded bg-secondary/60 text-center text-[9px] tabular outline-none focus:ring-1 ring-primary/60 disabled:opacity-40"
      />
    </span>
  )
}

// ------------------------------------------------------------
// Inline "edit open position" editor + price-order desk:
// Entry (limit at price) · Target (reduce-only limit) ·
// StopLoss (reduce-only SL-M trigger)
// ------------------------------------------------------------
function StrikeRowEditor({ row, cell, lots, pos, lotSize, onApply, onExit, onEntry, onTarget, onStop, onRemove }: {
  row: StrikeRowCfg
  cell: OptionQuoteCell | null
  lots: number
  pos: { netQty: number; avgPrice: number; unrealizedPnl: number } | null
  lotSize: number
  onApply: (deltaLots: number) => Promise<void>
  onExit: () => Promise<void>
  onEntry: (side: 'BUY' | 'SELL', price: number) => Promise<void>
  onTarget: (price: number) => Promise<void>
  onStop: (price: number) => Promise<void>
  onRemove: () => void
}) {
  const [delta, setDelta] = useState('')
  const [entry, setEntry] = useState('')
  const [target, setTarget] = useState('')
  const [stop, setStop] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setDelta(''), [lots])

  const flat = !pos || pos.netQty === 0
  const num = (s: string) => (s === '' ? NaN : Number(s))
  const ok = (s: string) => Number.isFinite(num(s)) && num(s) > 0

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }

  return (
    <div className="px-2 pb-2 pt-1 space-y-1.5 border-t border-border/40 bg-secondary/20">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">Position — {cell?.symbol ?? row.type}</span>
        <span className="tabular">
          {pos ? (
            <>
              {pos.netQty > 0 ? 'LONG' : 'SHORT'} {lots} lot(s) @ {fmtMoney(pos.avgPrice)} ·{' '}
              <b className={pos.unrealizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtMoney(pos.unrealizedPnl)}</b>
            </>
          ) : 'flat'}
        </span>
      </div>

      {/* price orders: entry / target / stoploss */}
      <div className="space-y-1 rounded bg-card/60 p-1.5">
        <div className="text-[8px] font-semibold uppercase tracking-wide text-muted-foreground">orders at price</div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="w-10 shrink-0 text-muted-foreground">Entry</span>
          <Input
            value={entry}
            onChange={e => setEntry(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="limit ₹"
            className="h-6 flex-1 min-w-0 text-[10px] tabular bg-secondary/60"
          />
          <button
            disabled={busy || !ok(entry)}
            onClick={() => run(async () => { await onEntry('BUY', num(entry)); setEntry('') })}
            title={`BUY LIMIT ${row.strike} ${row.type} at this price (${row.allocPct}% per account)`}
            className="px-1.5 h-6 rounded bg-up text-[#00c896] hover:brightness-125 text-[9px] font-bold disabled:opacity-40"
          >B@</button>
          <button
            disabled={busy || !ok(entry)}
            onClick={() => run(async () => { await onEntry('SELL', num(entry)); setEntry('') })}
            title={`SELL LIMIT ${row.strike} ${row.type} at this price (${row.allocPct}% per account)`}
            className="px-1.5 h-6 rounded bg-down text-[#ff4d5e] hover:brightness-125 text-[9px] font-bold disabled:opacity-40"
          >S@</button>
        </div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="w-10 shrink-0 text-muted-foreground">Target</span>
          <Input
            value={target}
            onChange={e => setTarget(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder={pos && pos.netQty > 0 ? 'book long ₹' : 'book short ₹'}
            className="h-6 flex-1 min-w-0 text-[10px] tabular bg-secondary/60"
          />
          <button
            disabled={busy || flat || !ok(target)}
            onClick={() => run(async () => { await onTarget(num(target)); setTarget('') })}
            title={`Reduce-only LIMIT at this price — closes the open position when LTP reaches it`}
            className="px-1.5 h-6 rounded bg-secondary text-foreground hover:bg-accent text-[9px] font-bold disabled:opacity-40"
          >Place</button>
        </div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="w-10 shrink-0 text-muted-foreground">StopLoss</span>
          <Input
            value={stop}
            onChange={e => setStop(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="trigger ₹"
            className="h-6 flex-1 min-w-0 text-[10px] tabular bg-secondary/60"
          />
          <button
            disabled={busy || flat || !ok(stop)}
            onClick={() => run(async () => { await onStop(num(stop)); setStop('') })}
            title={`Reduce-only SL-M — market-exits the open position when LTP triggers at this price`}
            className="px-1.5 h-6 rounded bg-secondary text-foreground hover:bg-accent text-[9px] font-bold disabled:opacity-40"
          >Arm</button>
        </div>
        <div className="text-[8px] text-muted-foreground leading-snug">
          Entry rests as LIMIT until hit · Target/SL attach to the current position ({lots} lot(s) · lot {lotSize}) and auto-cancel if it closes
        </div>
      </div>

      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-muted-foreground">Δ Lots /leg</span>
        <Input
          value={delta}
          onChange={e => setDelta(e.target.value.replace(/[^0-9-]/g, ''))}
          placeholder="+2 / -1"
          className="h-6 w-16 text-[10px] bg-secondary/60"
        />
        <Button
          size="sm" variant="secondary" className="h-6 px-2 text-[10px]" disabled={busy || !delta || delta === '-' || delta === '+0'}
          onClick={async () => { setBusy(true); await onApply(Number(delta)); setBusy(false) }}
        >Apply</Button>
        <span className="text-[9px] text-muted-foreground">+ buys, − exits (per enabled account) · now {lots} lot(s) agg</span>
        <div className="flex-1" />
        <Button
          size="sm" variant="secondary" className="h-6 px-2 text-[10px] text-[#ff4d5e]" disabled={busy || !pos}
          onClick={async () => { setBusy(true); await onExit(); setBusy(false) }}
        >Exit full</Button>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-[#ff4d5e]" onClick={onRemove}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-[9px] text-muted-foreground">alloc {row.allocPct}% · lot {lotSize} · orders fan out to all enabled accounts</span>
      </div>
    </div>
  )
}

// ============================================================
// StrikeActions — the QUICK-DEPLOY bar (PnL strip + alloc mode +
// Deploy/Cancel/Swap/Exit-All). Rendered by the right dock BELOW
// the content for EVERY tab (Added Strikes / Next Strikes /
// Auto Bot / Order Pad) so the deploy buttons live in the SAME
// place and stay consistent no matter which tab is selected.
// ============================================================
export function StrikeActions({ ws }: { ws: WorkspaceCfg }) {
  const patchWs = useTerminal(s => s.patchWs)
  const st: StrikesCfg = useMemo(() => ws.strikes ?? defaultStrikes(), [ws])
  const underlying = st.underlying
  const allocMode: AllocMode = ws.allocMode ?? 'PCT'
  const [busy, setBusy] = useState(false)

  // accounts: representative usable capital (alloc context)
  const coreAcc = useSyncChannel<SyncCore>('sync:core')
  const core = coreAcc
  const accounts = (coreAcc?.accounts as unknown as AccountRow[] | undefined) ?? []
  const repUsable = useMemo(() => {
    const on = accounts.filter(a => a.isOrderEnabled)
    return (on[0] ?? accounts[0])?.usableCapital ?? 0
  }, [accounts])

  // live chain (same channel the strikes panel uses) — quotes for the rows
  const chainSync = useSyncData<SyncChainResp>(
    'sync:chain',
    d => !!d && (d as { meta?: { underlying?: string } }).meta?.underlying === underlying,
    underlying ? { chains: [{ underlying, expiry: st.expiry ?? null }] } : undefined,
  )
  const rowByStrike = useMemo(() => {
    const m = new Map<number, ChainStrikeRow>()
    for (const r of chainSync?.rows ?? []) m.set(r.strike, r)
    return m
  }, [chainSync])
  const meta = chainSync?.meta ?? null

  const rowsFor = (type: 'CE' | 'PE') => st.rows.filter(r => r.type === type && r.enabled)
  const cellFor = (row: StrikeRowCfg): OptionQuoteCell | null => {
    const c = rowByStrike.get(row.strike)
    if (!c) return null
    return row.type === 'CE' ? c.ce : c.pe
  }
  const sideSum = (type: 'CE' | 'PE') => {
    const on = st.rows.filter(r => r.type === type && r.enabled)
    if (allocMode === 'FIXED') return on.reduce((s, r) => s + (r.allocAmt ?? 0), 0)
    return Math.round(on.reduce((s, r) => s + r.allocPct, 0) * 10) / 10
  }
  const sizingFor = (row: StrikeRowCfg): Record<string, unknown> =>
    allocMode === 'FIXED'
      ? { tag: `abs:${Math.max(0, row.allocAmt ?? 0)}` }
      : { capitalPct: row.allocPct }

  // ---- PnL rollup (unrealized + realized, per account) ----
  const posBySymbol = useMemo(() => {
    const m = new Map<string, { netQty: number; unrealizedPnl: number; realizedPnl: number }>()
    for (const p of core?.positions ?? []) {
      const cur = m.get(p.symbol)
      if (!cur) { m.set(p.symbol, { netQty: p.netQty, unrealizedPnl: p.unrealizedPnl, realizedPnl: p.realizedPnl }); continue }
      cur.netQty += p.netQty
      cur.unrealizedPnl += p.unrealizedPnl
      cur.realizedPnl += p.realizedPnl
    }
    return m
  }, [core])
  const pnl = useMemo(() => {
    let totalU = 0, totalR = 0, totalNetX = 0
    const byAccount = new Map<string, { label: string; u: number; r: number }>()
    for (const p of core?.positions ?? []) {
      totalU += p.unrealizedPnl
      totalR += p.realizedPnl
      totalNetX += (p as unknown as { netIfExit?: number }).netIfExit ?? p.unrealizedPnl
      const a = byAccount.get(p.accountId) ?? { label: p.accountLabel, u: 0, r: 0 }
      a.u += p.unrealizedPnl
      a.r += p.realizedPnl
      byAccount.set(p.accountId, a)
    }
    return { totalU, totalR, totalNetX, byAccount }
  }, [core])
  // NET IN POCKET: server-computed (realized − charges + Σ netIfExit) when the
  // sync payload carries it; local approximation as fallback
  const pocketNow = core?.session?.pocket ?? (pnl.totalNetX + pnl.totalR)

  /** Deploy every enabled strike of one side (fresh quotes, never stale). */
  const deployRows = async (type: 'CE' | 'PE', rows: StrikeRowCfg[]) => {
    let strikesOk = 0, strikesFail = 0, fills = 0, skipped = 0
    const allStrikes = [...new Set(rows.map(r => r.strike))]
    const cd = allStrikes.length ? await api.optionChain(underlying!, st.expiry, allStrikes) : null
    const fresh = new Map<number, ChainStrikeRow>((cd?.rows ?? []).map(r => [r.strike, r]))
    for (const row of rows) {
      const c = fresh.get(row.strike)
      const cell = c ? (row.type === 'CE' ? c.ce : c.pe) : cellFor(row)
      const alloc = allocMode === 'FIXED' ? (row.allocAmt ?? 0) : row.allocPct
      if (!cell?.exists || !(alloc > 0)) { strikesFail++; continue }
      try {
        const res = await api.placeOrder({
          symbol: cell.symbol, exchange: 'NFO', side: 'BUY', qty: 0,
          orderType: 'MARKET', productType: 'MIS', source: 'MANUAL',
          ...sizingFor(row),
        })
        const f = res.legs.filter(l => l.status === 'FILLED').length
        fills += f
        skipped += res.legs.length - f
        f > 0 ? strikesOk++ : strikesFail++
      } catch { strikesFail++ }
    }
    return { strikesOk, strikesFail, fills, skipped, total: rows.length }
  }

  const deploy = async (type: 'CE' | 'PE') => {
    const rows = rowsFor(type)
    if (rows.length === 0) { toast.error(`No enabled ${type} strikes`); return }
    setBusy(true)
    const r = await deployRows(type, rows)
    setBusy(false)
    r.strikesOk > 0
      ? toast.success(`Deploy ${type}: ${r.strikesOk}/${rows.length} enabled strikes · ${r.fills} account fills${r.skipped ? ` · ${r.skipped} legs skipped` : ''}`)
      : toast.error(`Deploy ${type} failed — no fills (${r.strikesFail} strikes skipped)`)
  }

  const cancelType = async (type: 'CE' | 'PE') => {
    const syms = rowsFor(type).map(r => cellFor(r)?.symbol).filter((s): s is string => !!s)
    if (syms.length === 0) { toast.error(`No enabled ${type} strikes`); return }
    try {
      const r = await api.cancelAll(syms)
      r.cancelled > 0 ? toast.success(`Cancelled ${r.cancelled} pending ${type} orders`) : toast.info(`No pending ${type} orders`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Cancel failed') }
  }

  /** SWAP: close side `from`, then deploy the opposite side (auto-adds the
   *  target side's ATM if nothing is listed). */
  const swapSide = async (from: 'CE' | 'PE') => {
    const to = from === 'CE' ? 'PE' : 'CE'
    const fromSyms = rowsFor(from).map(r => cellFor(r)?.symbol).filter((s): s is string => !!s)
    setBusy(true)
    try {
      let closedLegs = 0
      if (fromSyms.length > 0) {
        const so = await api.squareOffAll(false, fromSyms)
        closedLegs = so.filledLegs
      }
      let toRows = rowsFor(to)
      if (toRows.length === 0 && meta) {
        await ensureStrikeAdd(ws, to === 'CE' ? meta.ceAtm : meta.peAtm, to)
        await new Promise(r => setTimeout(r, 500))
        const ws2 = useTerminal.getState().workspaces.find(w => w.id === ws.id)
        toRows = (ws2?.strikes?.rows ?? []).filter(r => r.type === to && r.enabled)
      }
      const r = await deployRows(to, toRows)
      r.strikesOk > 0
        ? toast.success(`Swap ${from}→${to}: ${from} flat (${closedLegs} legs) · ${r.strikesOk}/${toRows.length} ${to} strikes · ${r.fills} fills${r.skipped ? ` · ${r.skipped} skipped` : ''}`)
        : toast.error(`Swap ${from}→${to} — ${from} flat but no ${to} fills`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Swap ${from}→${to} failed`)
    } finally { setBusy(false) }
  }

  const exitAll = async () => {
    setBusy(true)
    try {
      const so = await api.squareOffAll(false)
      so.orders > 0
        ? toast.success(`Exit All — ${so.orders} orders · ${so.filledLegs} legs closed`)
        : toast.info('No open positions')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Exit All failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="border-t border-border p-1.5 space-y-1 bg-card/60 shrink-0">
      {/* session PnL strip — open / booked / net / POCKET (net after ALL charges if everything exited at LTP now) */}
      <div className="rounded bg-secondary/30 px-1.5 py-1 space-y-0.5" title="Open = unrealized at LTP · Booked = realized · Net = open + booked · Pocket = NET after ALL charges if every open position exited at LTP now">
        <div className="flex items-center justify-between text-[9px] tabular">
          <span className="text-muted-foreground">Open <b className={pnl.totalU >= 0 ? 'term-up' : 'term-down'}>{fmtMoney(pnl.totalU, 0)}</b></span>
          <span className="text-muted-foreground">Booked <b className={pnl.totalR >= 0 ? 'term-up' : 'term-down'}>{fmtMoney(pnl.totalR, 0)}</b></span>
          <span className="text-muted-foreground">Net <b className={pnl.totalU + pnl.totalR >= 0 ? 'term-up' : 'term-down'}>{fmtMoney(pnl.totalU + pnl.totalR, 0)}</b></span>
          <span className="text-muted-foreground" title="NET in pocket after ALL charges — exit every open position at LTP now (uses the account's brokerage/tax schedule)">Pocket <b className={pocketNow >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'}>{fmtMoney(pocketNow, 0)}</b></span>
          <span className="text-muted-foreground" title="Representative usable capital for % sizing">cap {fmtMoney(repUsable, 0)}</span>
        </div>
        {pnl.byAccount.size > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[8px] tabular">
            {[...pnl.byAccount.values()].map(a => {
              const net = a.u + a.r
              return (
                <span key={a.label} className="text-muted-foreground">
                  {a.label} <b className={net >= 0 ? 'term-up' : 'term-down'}>{net >= 0 ? '+' : ''}{fmtMoney(net, 0)}</b>
                </span>
              )
            })}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-[8px] text-muted-foreground px-0.5">
        <span>enabled strikes deploy at their alloc</span>
        <span>
          {allocMode === 'FIXED' ? (
            <><b className="text-[#00c896]">CE ₹{sideSum('CE').toLocaleString('en-IN')}</b> · <b className="text-[#ff4d5e]">PE ₹{sideSum('PE').toLocaleString('en-IN')}</b></>
          ) : (
            <><b className="text-[#00c896]">CE Σ{sideSum('CE')}%</b> · <b className="text-[#ff4d5e]">PE Σ{sideSum('PE')}%</b></>
          )}
        </span>
        <div className="flex rounded overflow-hidden border border-border">
          {(['PCT', 'FIXED'] as AllocMode[]).map(m => (
            <button
              key={m}
              onClick={() => patchWs(ws.id, { allocMode: m })}
              title={m === 'PCT' ? '% of each account\'s usable capital (auto-normalized)' : 'Fixed ₹ per strike per account'}
              className={`px-1.5 py-0.5 text-[8px] font-bold ${allocMode === m ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >{m === 'PCT' ? '%' : '₹'}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button size="sm" className="h-7 text-[10px] bg-up text-[#00c896] hover:bg-[#00c896] hover:text-black" disabled={busy || !underlying} onClick={() => deploy('CE')}>
          Deploy CE
        </Button>
        <Button size="sm" className="h-7 text-[10px] bg-down text-[#ff4d5e] hover:bg-[#ff4d5e] hover:text-black" disabled={busy || !underlying} onClick={() => deploy('PE')}>
          Deploy PE
        </Button>
        <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy || !underlying} onClick={() => cancelType('CE')}>
          Cancel CE
        </Button>
        <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy || !underlying} onClick={() => cancelType('PE')}>
          Cancel PE
        </Button>
        <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy || !underlying} onClick={() => swapSide('CE')} title="Close all CE positions, then deploy PE on the enabled PE strikes">
          Swap CE→PE
        </Button>
        <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy || !underlying} onClick={() => swapSide('PE')} title="Close all PE positions, then deploy CE on the enabled CE strikes">
          Swap PE→CE
        </Button>
        <Button size="sm" variant="destructive" className="h-7 text-[10px] col-span-2" disabled={busy} onClick={exitAll} title="Square off every open position across all symbols and accounts">
          Exit All
        </Button>
      </div>
    </div>
  )
}

// ============================================================
// Shared add-strike helper — ensure contracts exist, then append
// the row (side-normalized).  Used by the strikes desk AND the
// Next-expiry browser tab.
// ============================================================
export async function ensureStrikeAdd(ws: WorkspaceCfg, strike: number, type: 'CE' | 'PE', expiryOverride?: string | null) {
  const st0 = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? ws.strikes ?? defaultStrikes()
  const underlying = st0.underlying
  if (!underlying) { toast.error('Pick an F&O underlying first'); return false }
  const id = `${strike}:${type}`
  if (st0.rows.some(r => r.id === id)) { toast.info(`${strike} ${type} already in list`); return false }
  try {
    const r = await api.ensureStrike(underlying, strike, expiryOverride ?? st0.expiry)
    if (r.created > 0) toast.success(`Contracts ready — ${r.symbols.join(', ')}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to create contracts')
    return false
  }
  const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st0
  if (cur.rows.some(r => r.id === id)) return false
  const rows = normalizeSide([...cur.rows, { id, strike, type, enabled: true, allocPct: 0 }], type)
  useTerminal.getState().patchWs(ws.id, { strikes: { ...cur, rows } })
  return true
}

// ============================================================
// NextStrikes — NEXT-expiry strike browser tab.  Shows the ATM±8
// chain of the NEXT expiry with live CE/PE LTPs (and delta when an
// FNO session provides greeks); "+CE / +PE" adds that strike to the
// added-strikes desk and switches the desk to this expiry so quotes
// resolve.
// ============================================================
export function NextStrikes({ ws }: { ws: WorkspaceCfg }) {
  const patchWs = useTerminal(s => s.patchWs)
  const st: StrikesCfg = useMemo(() => ws.strikes ?? defaultStrikes(), [ws])
  const underlying = st.underlying
  const [adding, setAdding] = useState<string | null>(null)

  const { data: restChain } = useQuery({
    queryKey: ['optionChainNext', underlying, st.expiry],
    queryFn: () => api.optionChain(underlying!, null, []),
    enabled: !!underlying,
    refetchInterval: 4000,
    retry: false,
  })
  const expiries = restChain?.meta.expiries ?? []
  const curIdx = st.expiry ? expiries.indexOf(st.expiry) : 0
  const nextExpiry = expiries.length > 1
    ? expiries[Math.min(expiries.length - 1, (curIdx < 0 ? 0 : curIdx) + 1)]
    : null
  const { data: nextChain } = useQuery({
    queryKey: ['optionChainNextRows', underlying, nextExpiry],
    queryFn: () => api.optionChain(underlying!, nextExpiry, []),
    enabled: !!underlying && !!nextExpiry,
    refetchInterval: 4000,
    retry: false,
  })

  const switchToNext = () => {
    if (!nextExpiry) return
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st
    patchWs(ws.id, { strikes: { ...cur, expiry: nextExpiry } })
    toast.info(`Strikes desk switched to expiry ${nextExpiry}`)
  }

  const add = async (strike: number, type: 'CE' | 'PE') => {
    if (!nextExpiry) return
    setAdding(`${strike}:${type}`)
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st
    if (cur.expiry !== nextExpiry) {
      patchWs(ws.id, { strikes: { ...cur, expiry: nextExpiry } })
    }
    await ensureStrikeAdd(ws, strike, type, nextExpiry)
    setAdding(null)
  }

  if (!underlying) {
    return (
      <div className="p-3 text-center text-[10px] text-muted-foreground">
        Pick an F&O underlying in the Added Strikes tab first.
      </div>
    )
  }
  const rows = (nextChain?.rows ?? []).filter(r => Math.abs(r.offset) <= 8)
  const meta = nextChain?.meta
  return (
    <div className="h-full flex flex-col text-[11px]">
      <div className="px-1.5 py-1 border-b border-border shrink-0 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold">{underlying} · next expiry</span>
          {nextExpiry && (
            <button onClick={switchToNext} title="Load this expiry into the strikes desk selector"
              className="px-1.5 py-0.5 rounded bg-primary/25 text-[9px] font-bold hover:bg-primary/40">
              use {nextExpiry}
            </button>
          )}
        </div>
        <div className="flex items-center justify-between text-[9px] text-muted-foreground tabular">
          <span>{nextExpiry ? `exp ${nextExpiry}` : 'no next expiry in the master'}</span>
          <span>spot <b className={meta && meta.spot >= meta.prevClose ? 'term-up' : 'term-down'}>{meta ? fmtMoney(meta.spot) : '—'}</b></span>
          <span>C{meta?.ceAtm ?? '—'} · P{meta?.peAtm ?? '—'}</span>
        </div>
        <div className="text-[9px] text-muted-foreground">
          +CE / +PE adds the strike to the added desk and switches it to this expiry.
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!nextExpiry && (
          <div className="p-3 text-center text-[10px] text-muted-foreground">This underlying has a single expiry — nothing to browse.</div>
        )}
        {nextExpiry && rows.length === 0 && (
          <div className="p-3 text-center text-[10px] text-muted-foreground">loading next-expiry chain…</div>
        )}
        {rows.map(r => {
          const addedCe = st.rows.some(x => x.id === `${r.strike}:CE`)
          const addedPe = st.rows.some(x => x.id === `${r.strike}:PE`)
          return (
            <div key={r.strike} className="flex items-center gap-1 px-1.5 py-1 border-b border-border/40 text-[10px] tabular">
              <span className="w-[54px] shrink-0 font-semibold">{r.strike}</span>
              <span className={`text-[8px] w-8 shrink-0 ${r.offset === 0 ? 'text-foreground font-bold' : 'text-muted-foreground'}`}>
                {r.offset === 0 ? 'ATM' : r.offset > 0 ? `+${r.offset}` : `${r.offset}`}
              </span>
              <span className="flex-1 text-right">
                <span className={`${r.ce.exists ? (r.ce.ltp >= r.ce.prevClose ? 'term-up' : 'term-down') : 'text-muted-foreground'}`}>
                  {r.ce.exists ? fmtMoney(r.ce.ltp) : '—'}
                </span>
                {r.ce.greeks && <span className="text-[8px] text-muted-foreground"> Δ{r.ce.greeks.delta.toFixed(2)}</span>}
              </span>
              <button
                onClick={() => add(r.strike, 'CE')}
                disabled={adding === `${r.strike}:CE` || addedCe}
                className={`px-1 py-0.5 rounded text-[8px] font-bold ${addedCe ? 'bg-primary/25 text-foreground' : 'bg-up text-[#00c896] hover:brightness-125'}`}
                title={`Add ${r.strike} CE (${nextExpiry})`}
              >{addedCe ? '✓' : '+CE'}</button>
              <span className="flex-1 text-right">
                <span className={`${r.pe.exists ? (r.pe.ltp >= r.pe.prevClose ? 'term-up' : 'term-down') : 'text-muted-foreground'}`}>
                  {r.pe.exists ? fmtMoney(r.pe.ltp) : '—'}
                </span>
                {r.pe.greeks && <span className="text-[8px] text-muted-foreground"> Δ{r.pe.greeks.delta.toFixed(2)}</span>}
              </span>
              <button
                onClick={() => add(r.strike, 'PE')}
                disabled={adding === `${r.strike}:PE` || addedPe}
                className={`px-1 py-0.5 rounded text-[8px] font-bold ${addedPe ? 'bg-primary/25 text-foreground' : 'bg-down text-[#ff4d5e] hover:brightness-125'}`}
                title={`Add ${r.strike} PE (${nextExpiry})`}
              >{addedPe ? '✓' : '+PE'}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
