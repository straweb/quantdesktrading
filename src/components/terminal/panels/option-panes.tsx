'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ExternalLink, Layers, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { CanvasChart } from '../chart/canvas-chart'
import { api, fmtMoney } from '../lib/client-api'
import type { OptionQuoteCell } from '../lib/client-api'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'
import type { Tick } from '@/lib/types'
import {
  useTerminal, wsLayout, wsPanes, unpinPane, defaultStrikes, addDepthPanelTo,
  type PaneCfg, type WorkspaceCfg,
} from '../lib/store'
import { useSyncData, mergeChain, type SyncChainResp } from '../lib/sync'
import { useChartCore, useChartMarkers, commitChartLevel } from '../lib/use-chart-markers'

// ============================================================
// Multi-pane chart region for F&O workspaces — fully resizable
// (drag the dividers between panes).
// - 'spot-atm': spot chart on top, ATM CE (left) + ATM PE (right)
//   panes below — default open for FNO.
// - 'grid4': 2x2 — spot, CE, PE + a scratch pane that mirrors
//   the most recent strike-row click.
// Panes follow the live side-ATM (hedge convention: CE ATM =
// floor(spot), PE ATM = ceil(spot)) until the user pins a
// strike by clicking a strike row; a pane header button unpins.
//
// ALL panes share the workspace timeframe (auto-locked) so the
// synced crosshair lines up across every open chart. Every pane
// header starts with a depth button that opens that chart's
// symbol in the bottom-left depth panel stack.
// ============================================================

/** Depth button — adds this chart's symbol to the left depth stack. */
export function DepthAddButton({ ws, symbol }: { ws: WorkspaceCfg; symbol: string }) {
  const patchWs = useTerminal(s => s.patchWs)
  const add = () => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id) ?? ws
    const { patch, error } = addDepthPanelTo(cur, symbol)
    if (error) { toast.info(error); return }
    patchWs(ws.id, patch)
    toast.success(`Depth panel added — ${symbol}`)
  }
  return (
    <button
      onClick={add}
      title={`Open ${symbol} market depth in the left depth stack`}
      className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
    >
      <Layers className="h-2.5 w-2.5" />
    </button>
  )
}

// ============================================================
// TradeButtons — BUY / [lots] / SELL between the buttons.
// Spot instruments without a direct B/S (indices) render CE / PE
// buttons that deploy the side-ATM strike instead.
// ============================================================
export function TradeButtons({ symbol, kind, lotSize }: { symbol: string; kind: 'spot' | 'CE' | 'PE'; lotSize?: number }) {
  const [lots, setLots] = useState(1)
  const [busy, setBusy] = useState(false)
  const { data: undData } = useQuery({ queryKey: ['optionUnderlyings'], queryFn: () => api.optionUnderlyings(), staleTime: 5 * 60_000 })
  const isUnderlying = kind === 'spot' && (undData?.underlyings ?? []).some(u => u.underlying === symbol)

  const marketOrder = async (side: 'BUY' | 'SELL', sym = symbol, qtyLots = lots) => {
    setBusy(true)
    try {
      const res = await api.placeOrder({ symbol: sym, exchange: 'NFO', side, qty: qtyLots, orderType: 'MARKET', productType: 'MIS', source: 'MANUAL' })
      const f = res.legs.filter(l => l.status === 'FILLED').length
      res.status === 'FAILED'
        ? toast.error(`${side} failed — ${res.message}`)
        : toast.success(`${side} ${sym} × ${qtyLots} lot(s) — ${f}/${res.legs.length} accounts`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Order failed') }
    setBusy(false)
  }

  /** Deploy one side's ATM (CE floor / PE ceil convention). */
  const deployAtm = async (type: 'CE' | 'PE') => {
    setBusy(true)
    try {
      const chain = await api.optionChain(symbol, null, [])
      const cell = type === 'CE' ? chain.atmCe : chain.atmPe
      if (!cell?.exists) { toast.error(`${type} ATM unavailable for ${symbol}`); setBusy(false); return }
      const r = await api.ensureStrike(symbol, cell.strike, chain.meta.expiry)
      void r
      await marketOrder('BUY', cell.symbol, Math.max(1, lots))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'ATM deploy failed') }
    setBusy(false)
  }

  if (kind === 'spot' && isUnderlying) {
    // index / F&O underlying — no direct B/S → CE/PE deploy ATM
    return (
      <span className="flex items-center gap-0.5 shrink-0" title="Spot has no direct B/S — buy the side-ATM option">
        <button onClick={() => deployAtm('CE')} disabled={busy} className="px-1 py-0.5 rounded bg-up text-[#00c896] hover:brightness-125 text-[9px] font-bold disabled:opacity-40">CE</button>
        <button onClick={() => deployAtm('PE')} disabled={busy} className="px-1 py-0.5 rounded bg-down text-[#ff4d5e] hover:brightness-125 text-[9px] font-bold disabled:opacity-40">PE</button>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-0.5 shrink-0">
      <button onClick={() => marketOrder('BUY')} disabled={busy} className="px-1 py-0.5 rounded bg-up text-[#00c896] hover:brightness-125 text-[9px] font-bold disabled:opacity-40">B</button>
      <input
        value={lots}
        onChange={e => setLots(Math.max(1, Math.min(999, Number(e.target.value.replace(/[^0-9]/g, '')) || 1)))}
        title={`Lot size — ${lotSize && lotSize > 1 ? `1 lot = ${lotSize} qty · ` : ''}editable between buy/sell`}
        className="h-4.5 w-6 rounded bg-secondary/70 text-center text-[9px] tabular outline-none focus:ring-1 ring-primary/60"
      />
      <button onClick={() => marketOrder('SELL')} disabled={busy} className="px-1 py-0.5 rounded bg-down text-[#ff4d5e] hover:brightness-125 text-[9px] font-bold disabled:opacity-40">S</button>
    </span>
  )
}

/** Slim header for the spot pane: [depth] SYMBOL · LTP chg% · B/S or CE/PE */
export function SpotPaneHeader({ ws }: { ws: WorkspaceCfg }) {
  const [tick, setTick] = useState<Tick | null>(null)
  const { data: quoteData } = useQuery({
    queryKey: ['quote-lot', ws.symbol],
    queryFn: () => api.quote(ws.symbol),
    refetchInterval: 15_000,
  })
  useEffect(() => {
    subscribeTicks([ws.symbol])
    const off = onTicks(map => {
      const t = map[ws.symbol]
      if (t) setTick(t)
    })
    return () => { unsubscribeTicks([ws.symbol]); off() }
  }, [ws.symbol])

  const ltp = tick?.ltp ?? 0
  const prev = tick?.prevClose ?? 0
  const chgPct = ltp && prev ? ((ltp - prev) / prev) * 100 : null
  return (
    <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] shrink-0 gap-1">
      <DepthAddButton ws={ws} symbol={ws.symbol} />
      <span className="font-bold tabular shrink-0">{ws.symbol}</span>
      <span className="text-muted-foreground shrink-0">SPOT</span>
      <button
        onClick={() => useTerminal.getState().setSymbol(ws.symbol)}
        className="text-muted-foreground hover:text-foreground truncate px-1 min-w-0"
        title="Set as active symbol (order pad + strikes panel)"
      >
        click to set active
      </button>
      <TradeButtons symbol={ws.symbol} kind="spot" lotSize={quoteData?.lotSize} />
      <div className="flex-1 min-w-0" />
      <span className={`tabular font-bold shrink-0 ${ltp && chgPct !== null && chgPct >= 0 ? 'term-up' : 'term-down'}`}>
        {ltp ? fmtMoney(ltp) : '—'}
        {chgPct !== null && (
          <span className={chgPct >= 0 ? 'term-up' : 'term-down'}> {chgPct >= 0 ? '+' : ''}{chgPct.toFixed(1)}%</span>
        )}
      </span>
    </div>
  )
}

export function OptionPane({ ws, kind }: { ws: WorkspaceCfg; kind: PaneCfg['key'] }) {
  const patchWs = useTerminal(s => s.patchWs)
  const setSymbol = useTerminal(s => s.setSymbol)
  const core = useChartCore()
  const st = ws.strikes ?? defaultStrikes()
  const pane = wsPanes(ws).find(p => p.key === kind) ?? { key: kind, strike: null, type: null }

  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const unds = undData?.underlyings ?? []
  const underlying = st.underlying && unds.some(u => u.underlying === st.underlying)
    ? st.underlying
    : unds.some(u => u.underlying === ws.symbol) ? ws.symbol : null

  const expiry = st.expiry
  const pinned = pane.strike
  const type: 'CE' | 'PE' = kind === 'pe' ? 'PE' : kind === 'ce' ? 'CE' : (pane.type ?? 'CE')

  // chain: realtime via sync:chain (1s) + REST backup merged for far strikes
  const { data: restChain } = useQuery({
    queryKey: ['optionPane', underlying, expiry, kind, pinned ?? 0],
    queryFn: () => api.optionChain(underlying!, expiry, pinned ? [pinned] : []),
    enabled: !!underlying,
    refetchInterval: 8000,
    retry: false,
  })
  const chainSync = useSyncData<SyncChainResp>(
    'sync:chain',
    d => !!d && (d as { meta?: { underlying?: string } }).meta?.underlying === underlying,
    underlying ? { chains: [{ underlying, expiry: expiry ?? null }] } : undefined,
  )
  const data = mergeChain(chainSync, restChain ?? null)
  const isLoading = !data
  const isError = !data && !!underlying && !!restChain
  const meta = data?.meta ?? null

  // ---- ATM follow with HYSTERESIS ----
  // An unpinned pane follows the live side-ATM, but it must NOT flip every
  // time spot touches a strike boundary (that symbol flip-flop re-fetches
  // candles and reads as "loading candles…" flicker).  The new ATM has to
  // HOLD for 2.5s before the pane switches; a momentary poke past a strike
  // keeps the current contract on the chart.  followRef mirrors the state so
  // the effect can distinguish first-adopt (0ms) from boundary holds (2.5s).
  const liveAtm = type === 'CE' ? (meta?.ceAtm ?? null) : (meta?.peAtm ?? null)
  const followRef = useRef<number | null>(null)
  const [follow, setFollow] = useState<number | null>(null)
  useEffect(() => {
    followRef.current = null
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the hysteresis when the pane's context changes
    setFollow(null)
  }, [underlying, expiry, kind])
  useEffect(() => {
    if (pinned || liveAtm == null) return
    if (followRef.current === liveAtm) return
    const delay = followRef.current == null ? 0 : 2500
    const t = setTimeout(() => {
      followRef.current = liveAtm
      setFollow(liveAtm)
    }, delay)
    return () => clearTimeout(t)
  }, [liveAtm, pinned])
  const effStrike = pinned ?? follow ?? undefined

  const cell: (OptionQuoteCell & { strike: number }) | null = useMemo(() => {
    if (effStrike) {
      const row = data?.rows.find(r => r.strike === effStrike)
      if (!row) return null
      return type === 'CE' ? { ...row.ce, strike: effStrike } : { ...row.pe, strike: effStrike }
    }
    if (type === 'CE') return data?.atmCe ?? null
    return data?.atmPe ?? null
  }, [data, effStrike, type])

  // position entry + draggable SL/target markers for THIS option's chart
  const chartSymbol = cell?.exists ? cell.symbol : ''
  const markers = useChartMarkers(chartSymbol, core, meta?.lotSize ?? 1)
  const onMarkerDrop = (k: 'sl' | 'target', price: number) => {
    if (chartSymbol) void commitChartLevel(chartSymbol, k, price, core)
  }
  const onMarkerRemove = (k: 'sl' | 'target') => {
    if (chartSymbol) {
      useTerminal.getState().setChartLevel(chartSymbol, k, null)
      toast.info(`${k === 'sl' ? 'SL' : 'Target'} level removed`)
    }
  }
  // EXIT button on the entry marker line — close the open position (all legs)
  const onExitPosition = () => {
    if (!chartSymbol) return
    void (async () => {
      try {
        const so = await api.squareOffAll(false, [chartSymbol])
        if (so.orders > 0) toast.success(`Exit ${chartSymbol} — ${so.filledLegs} legs closed`)
        else toast.info(`No open position on ${chartSymbol}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Exit failed')
      }
    })()
  }

  const offset = meta && cell
    ? Math.round((cell.strike - (type === 'CE' ? meta.ceAtm : meta.peAtm)) / meta.step)
    : null
  const tint = type === 'CE' ? '#00c896' : '#ff4d5e'

  // ---- scratch pane with nothing pinned: mirror the underlying spot ----
  if (kind === 'extra' && !pinned) {
    return (
      <div className="h-full flex flex-col min-w-0 min-h-0">
        <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] shrink-0 gap-1">
          <DepthAddButton ws={ws} symbol={ws.symbol} />
          <span className="font-bold text-muted-foreground">SCRATCH</span>
          <span className="text-muted-foreground truncate px-1">{ws.symbol} · click a strike row to pin it here</span>
          <div className="flex-1 min-w-0" />
        </div>
        <div className="flex-1 min-h-0">
          <CanvasChart
            symbol={ws.symbol} tf={ws.tf} chartType={ws.chartType} showVolume={ws.showVolume}
            showSMA20={ws.showSMA20} showSMA50={ws.showSMA50}
            showEMA={ws.showEMA} showVWAP={ws.showVWAP} showBOLL={ws.showBOLL}
            showRSI={ws.showRSI} showMACD={ws.showMACD} showADX={ws.showADX}
            showGhost={ws.showGhost} ghostStyle={ws.ghostStyle} ghostTf={ws.ghostTf} scales={ws.scales}
            settingsKey={`${ws.id}:extra`}
            height="h-full"
          />
        </div>
      </div>
    )
  }

  const header = (
    <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] shrink-0 gap-1">
      <DepthAddButton ws={ws} symbol={cell?.exists ? cell.symbol : ws.symbol} />
      <span className="font-bold tabular shrink-0" style={{ color: tint }}>
        {cell?.exists ? `${cell.strike} ${type}` : `${type} ·—`}
      </span>
      {offset !== null && (
        <span className="text-muted-foreground shrink-0" title="Position vs the side ATM (ITM/OTM/ATM)">
          {offset === 0 ? 'ATM' : (type === 'CE' ? (offset < 0 ? `ITM ${-offset}` : `OTM ${offset}`) : (offset > 0 ? `ITM ${offset}` : `OTM ${-offset}`))}
        </span>
      )}
      <button
        onClick={() => cell?.exists && setSymbol(cell.symbol)}
        className="text-muted-foreground hover:text-foreground truncate px-1 min-w-0"
        title={`${meta?.underlying ?? ''} · ${meta?.expiry ?? ''} · lot ${meta?.lotSize ?? '—'} — click to set as active symbol`}
      >
        {meta ? `${meta.underlying} · ${meta.expiry} · L${meta.lotSize}` : '—'}
      </button>
      <TradeButtons symbol={cell?.exists ? cell.symbol : ''} kind={type} lotSize={meta?.lotSize} />
      <span className={`tabular font-bold shrink-0 ${cell && cell.ltp >= cell.prevClose ? 'term-up' : 'term-down'}`}>
        {cell?.exists ? fmtMoney(cell.ltp) : '—'}
        {cell?.exists ? (
          <span className={cell.changePct >= 0 ? 'term-up' : 'term-down'}> {cell.changePct >= 0 ? '+' : ''}{cell.changePct.toFixed(1)}%</span>
        ) : null}
      </span>
      {pinned ? (
        <button
          onClick={() => patchWs(ws.id, unpinPane(ws, kind))}
          className="shrink-0 px-1 py-0.5 rounded bg-primary/25 text-foreground hover:bg-primary/40 flex items-center gap-0.5"
          title={`Pinned ${cell?.strike ?? pinned} — click to follow the live ATM again`}
        >
          <RotateCcw className="h-2.5 w-2.5" /> PIN
        </button>
      ) : (
        <span className="shrink-0 px-1 py-0.5 rounded bg-secondary/70 text-muted-foreground" title="Following the live side ATM">ATM</span>
      )}
      <button
        onClick={() => cell?.exists && setSymbol(cell.symbol)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title="Set as active symbol (order pad + main chart)"
      >
        <ExternalLink className="h-2.5 w-2.5" />
      </button>
    </div>
  )

  let body: React.ReactNode
  if (!underlying) {
    body = <Placeholder text="Pick an F&O underlying in the Strikes panel" />
  } else if (isLoading) {
    body = <Placeholder text={`Loading ${type} chain…`} />
  } else if (isError || !meta) {
    body = <Placeholder text={`No F&O chain for ${underlying}`} />
  } else if (!cell?.exists) {
    body = <Placeholder text={`${pinned ? `${pinned} ` : 'ATM '}${type} contract unavailable`} />
  } else {
    body = (
      <CanvasChart
        symbol={cell.symbol}
        tf={ws.tf} // interval auto-locked to the workspace — synced crosshair aligns
        chartType={ws.chartType}
        showVolume={ws.showVolume}
        showSMA20={false}
        showSMA50={false}
        showEMA={ws.showEMA}
        showVWAP={ws.showVWAP}
        showBOLL={ws.showBOLL}
        showRSI={ws.showRSI}
        showMACD={ws.showMACD}
        showADX={ws.showADX}
        showGhost={ws.showGhost} ghostStyle={ws.ghostStyle} ghostTf={ws.ghostTf} scales={ws.scales}
        markers={markers}
        onMarkerDrop={onMarkerDrop}
        onMarkerRemove={onMarkerRemove}
        onExitPosition={onExitPosition}
        settingsKey={`${ws.id}:${kind}`}
        height="h-full"
      />
    )
  }

  return (
    <div className="h-full flex flex-col min-w-0 min-h-0">
      {header}
      <div className="flex-1 min-h-0">{body}</div>
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground px-2 text-center">
      {text}
    </div>
  )
}

/** Divider between chart panes (drag to resize). */
function PaneHandle({ horizontal = false }: { horizontal?: boolean }) {
  return (
    <PanelResizeHandle
      className={horizontal ? 'w-px bg-border hover:bg-primary/60 transition-colors' : 'h-px bg-border hover:bg-primary/60 transition-colors'}
    />
  )
}

/** Full multi-pane region for a workspace (spot + option panes) — all panes resizable. */
export function WorkspacePanes({ ws, spot }: { ws: WorkspaceCfg; spot: React.ReactNode }) {
  const layout = wsLayout(ws)
  const spotWithHeader = (
    <div className="h-full flex flex-col min-w-0 min-h-0">
      <SpotPaneHeader ws={ws} />
      <div className="flex-1 min-h-0">{spot}</div>
    </div>
  )
  if (layout === 'single') return spotWithHeader
  if (layout === 'grid4') {
    return (
      <PanelGroup direction="vertical" className="h-full">
        <Panel defaultSize={50} minSize={15}>
          <PanelGroup direction="horizontal" className="h-full">
            <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0">{spotWithHeader}</div></Panel>
            <PaneHandle horizontal />
            <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="ce" /></div></Panel>
          </PanelGroup>
        </Panel>
        <PaneHandle />
        <Panel defaultSize={50} minSize={15}>
          <PanelGroup direction="horizontal" className="h-full">
            <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="pe" /></div></Panel>
            <PaneHandle horizontal />
            <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="extra" /></div></Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    )
  }
  // 'spot-atm' (default): spot on top, ATM CE left + PE right below — all resizable
  return (
    <PanelGroup direction="vertical" className="h-full">
      <Panel defaultSize={58} minSize={20}><div className="h-full min-w-0">{spotWithHeader}</div></Panel>
      <PaneHandle />
      <Panel defaultSize={42} minSize={15}>
        <PanelGroup direction="horizontal" className="h-full">
          <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="ce" /></div></Panel>
          <PaneHandle horizontal />
          <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="pe" /></div></Panel>
        </PanelGroup>
      </Panel>
    </PanelGroup>
  )
}
