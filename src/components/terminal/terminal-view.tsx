'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useQuery } from '@tanstack/react-query'
import { ListTree, FileBox, Plus, X, Crosshair, Layers, Bot, CalendarClock } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CanvasChart } from './chart/canvas-chart'
import { Watchlist, DepthStack } from './panels/watchlist'
import { OrderPad } from './panels/order-pad'
import { BottomPanel } from './panels/bottom-panel'
import { StrikesPanel, StrikeActions, NextStrikes } from './panels/strikes-panel'
import { AutoPanel } from './panels/auto-panel'
import { WorkspacePanes } from './panels/option-panes'
import { useTerminal, wsLayout, addDepthPanelTo, type WsLayout } from './lib/store'
import { api } from './lib/client-api'
import { useChartCore, useChartMarkers, commitChartLevel } from './lib/use-chart-markers'
import { toast } from 'sonner'
import { TIMEFRAMES } from '@/lib/types'
import type { Timeframe } from '@/lib/types'

export function TerminalView() {
  const workspaces = useTerminal(s => s.workspaces)
  const activeWs = useTerminal(s => s.activeWs)
  const ws = workspaces.find(w => w.id === activeWs) ?? workspaces[0]
  const patchWs = useTerminal(s => s.patchWs)
  const setLimitPrice = useTerminal(s => s.setLimitPrice)
  const setOrderType = useTerminal(s => s.setOrderType)
  const bottomCollapsed = useTerminal(s => s.bottomCollapsed)
  const centerRef = useRef<HTMLDivElement>(null)
  // collapsed bottom dock = MIN height (the slim session bar ≈ 34px regardless
  // of window size) — percent sizes derived from the live container height
  const [centerH, setCenterH] = useState(900)
  useEffect(() => {
    const el = centerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setCenterH(Math.max(320, el.clientHeight)))
    ro.observe(el)
    setCenterH(Math.max(320, el.clientHeight))
    return () => ro.disconnect()
  }, [])
  const collapsedPct = useMemo(() => Math.min(8, Math.max(2, (36 / centerH) * 100)), [centerH])

  // positions for the spot-chart L/S markers — websocket sync hub
  const core = useChartCore()

  // F&O underlyings -> enable the spot+ATM CE/PE mini charts strip
  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const layout = ws ? wsLayout(ws) : 'single'
  const isFnOUnderlying = useMemo(
    () => !!ws && (undData?.underlyings ?? []).some(u => u.underlying === ws.symbol),
    [ws, undData],
  )

  // entry markers (positions @ price + PnL/%) + draggable SL/target levels
  const spotMarkers = useChartMarkers(ws?.symbol ?? '', core)
  const onMarkerDrop = (kind: 'sl' | 'target', price: number) => {
    if (ws) void commitChartLevel(ws.symbol, kind, price, core)
  }
  const onMarkerRemove = (kind: 'sl' | 'target') => {
    if (ws) {
      useTerminal.getState().setChartLevel(ws.symbol, kind, null)
      toast.info(`${kind === 'sl' ? 'SL' : 'Target'} level removed`)
    }
  }

  if (!ws) return null

  return (
    <div className="flex h-full flex-col">
      {/* workspace tabs + chart toolbar */}
      <div className="flex items-center gap-1 px-2 pt-1 border-b border-border bg-card/30">
        <WorkspaceTabs />
        <div className="flex-1" />
        <div className="flex items-center gap-1 text-[10px]">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              onClick={() => patchWs(ws.id, { tf: tf as Timeframe })}
              className={`px-1.5 py-0.5 rounded ${ws.tf === tf ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >{tf}</button>
          ))}
          <span className="w-px h-4 bg-border mx-1" />
          <button
            onClick={() => patchWs(ws.id, { showVolume: !ws.showVolume })}
            title="Default volume state for NEW charts of this workspace (each chart has its own controls)"
            className={`px-1.5 py-0.5 rounded ${ws.showVolume ? 'bg-accent text-foreground' : 'bg-secondary text-muted-foreground'}`}
          >Vol</button>
          <span className="w-px h-4 bg-border mx-0.5" />
          {([
            ['single', '1', 'Single chart pane'],
            ['spot-atm', 'S+2', 'Spot top · ATM CE / PE panes below'],
            ['grid4', '2×2', 'Spot + CE + PE + scratch pane'],
          ] as [WsLayout, string, string][]).map(([l, label, tip]) => (
            <button
              key={l}
              onClick={() => patchWs(ws.id, { layout: l, showOptionMinis: l !== 'single' })}
              title={tip}
              className={`px-1.5 py-0.5 rounded text-[10px] tabular ${layout === l ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >{label}</button>
          ))}
          <span className="w-px h-4 bg-border mx-0.5" />
          <span
            className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground text-[9px]"
            title="Each chart has its own controls on the LEFT under the legend: type, indicators, ghost (any tf), scales and draw tools — hover an icon to open its menu"
          >
            per-chart (left bar): type · indicators · ghost · scales · tools
          </span>
          <span className="w-px h-4 bg-border mx-0.5" />
          <button
            onClick={() => {
              const { patch, error } = addDepthPanelTo(ws, ws.symbol)
              if (error) { toast.info(error); return }
              patchWs(ws.id, patch)
              toast.success(`Depth panel added — ${ws.symbol}`)
            }}
            title="Add this chart's market depth to the left depth stack"
            className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <Layers className="h-3 w-3" /> depth
          </button>
          <span
            className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground flex items-center gap-1"
            title="Wheel: time zoom · Wheel on price axis / Shift+wheel: price zoom · Drag: free pan (all directions, 50 bars future space) · Drag price axis: squeeze/stretch · Double-click / ▶LIVE: reset to live · Hover: synced crosshair across all charts"
          >
            <Crosshair className="h-3 w-3" /> zoom/pan
          </span>
        </div>
      </div>

      {/* main grid */}
      <div className="flex-1 min-h-0" ref={centerRef}>
        <PanelGroup direction="horizontal">
          {/* left: watchlist + depth panel stack */}
          <Panel defaultSize={17} minSize={12} maxSize={28}>
            <div className="h-full flex flex-col border-r border-border">
              <div className="flex-1 min-h-0"><Watchlist /></div>
              <DepthStack ws={ws} />
            </div>
          </Panel>
          <Handle />
          {/* center: multi-pane charts (spot + CE/PE per layout) + bottom */}
          <Panel defaultSize={65} minSize={30}>
            <PanelGroup direction="vertical">
              <Panel defaultSize={isFnOUnderlying ? 56 : 68} minSize={25}>
                <div className="h-full min-h-0">
                  <WorkspacePanes
                    ws={ws}
                    spot={
                      <CanvasChart
                        symbol={ws.symbol}
                        tf={ws.tf}
                        chartType={ws.chartType}
                        showVolume={ws.showVolume}
                        showSMA20={ws.showSMA20}
                        showSMA50={ws.showSMA50}
                        showEMA={ws.showEMA}
                        showVWAP={ws.showVWAP}
                        showBOLL={ws.showBOLL}
                        showRSI={ws.showRSI}
                        showMACD={ws.showMACD}
                        showADX={ws.showADX}
                        showGhost={ws.showGhost}
                        ghostStyle={ws.ghostStyle}
                        ghostTf={ws.ghostTf}
                        scales={ws.scales}
                        markers={spotMarkers}
                        onMarkerDrop={onMarkerDrop}
                        onMarkerRemove={onMarkerRemove}
                        onPriceClick={p => { setLimitPrice(p); setOrderType('LIMIT') }}
                        settingsKey={`${ws.id}:spot`}
                        height="h-full"
                      />
                    }
                  />
                </div>
              </Panel>
              <Handle vertical />
              {bottomCollapsed ? (
                <Panel key="bottom-mini" defaultSize={collapsedPct} minSize={Math.max(1.6, collapsedPct - 0.4)} maxSize={collapsedPct + 6}>
                  <BottomPanel />
                </Panel>
              ) : (
                <Panel key="bottom-full" defaultSize={isFnOUnderlying ? 44 : 32} minSize={12}>
                  <BottomPanel />
                </Panel>
              )}
            </PanelGroup>
          </Panel>
          <Handle />
          {/* right: strikes panel / order pad + quick buttons (compact) */}
          <Panel defaultSize={18} minSize={13} maxSize={34}>
            <RightDock ws={ws} />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  )
}

function WorkspaceTabs() {
  const workspaces = useTerminal(s => s.workspaces)
  const activeWs = useTerminal(s => s.activeWs)
  const setActiveWs = useTerminal(s => s.setActiveWs)
  const addWs = useTerminal(s => s.addWs)
  const removeWs = useTerminal(s => s.removeWs)

  return (
    <div className="flex items-center gap-1">
      {workspaces.map(w => (
        <div
          key={w.id}
          onClick={() => setActiveWs(w.id)}
          className={`group flex items-center gap-1 px-2.5 py-1 rounded-t text-[11px] cursor-pointer border-b-2 transition-colors ${
            activeWs === w.id ? 'border-primary text-foreground bg-card/60' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <span>{w.name}</span>
          <span className="text-[9px] text-muted-foreground">{w.symbol}</span>
          {workspaces.length > 1 && (
            <X
              className="h-3 w-3 opacity-0 group-hover:opacity-60 hover:!opacity-100"
              onClick={e => { e.stopPropagation(); removeWs(w.id) }}
            />
          )}
        </div>
      ))}
      <button onClick={addWs} className="p-1 rounded text-muted-foreground hover:text-foreground" title="New workspace">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function Handle({ vertical = false }: { vertical?: boolean }) {
  return (
    <PanelResizeHandle className={vertical ? 'h-px bg-border hover:bg-primary/50 transition-colors' : 'w-px bg-border hover:bg-primary/50 transition-colors'} />
  )
}

// Right dock — content on top, TAB BAR AT THE BOTTOM:
//   [Added Strikes | Next Strikes | Auto Bot | Order Pad]
// The quick-deploy bar (PnL + Deploy/Cancel/Swap/Exit) sits ABOVE the tab
// bar and is rendered for EVERY tab, so the deploy buttons stay in the same
// place and consistent no matter which tab is selected.
type RightTab = 'strikes' | 'next' | 'auto' | 'order'
function RightDock({ ws }: { ws: NonNullable<ReturnType<typeof useTerminal.getState>['workspaces'][number]> }) {
  const [tab, setTab] = useState<RightTab>('strikes')

  return (
    <div className="h-full flex flex-col border-l border-border">
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'strikes' ? <StrikesPanel ws={ws} />
          : tab === 'next' ? <NextStrikes ws={ws} />
          : tab === 'auto' ? <div className="h-full overflow-y-auto"><AutoPanel ws={ws} /></div>
          : <div className="h-full overflow-y-auto"><OrderPad /></div>}
      </div>
      {/* persistent quick-deploy bar — same place on every tab */}
      <StrikeActions ws={ws} />
      {/* tab bar — BOTTOM */}
      <div className="flex items-center gap-1 px-1.5 py-1 border-t border-border bg-card/30 shrink-0">
        <button
          onClick={() => setTab('strikes')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${tab === 'strikes' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
          title="Your added strikes desk (CE + PE split, quick-add at the bottom)"
        >
          <ListTree className="h-3 w-3" /> Added
        </button>
        <button
          onClick={() => setTab('next')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${tab === 'next' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
          title="Next-expiry strikes browser — add far-month strikes to the desk"
        >
          <CalendarClock className="h-3 w-3" /> Next
        </button>
        <button
          onClick={() => setTab('auto')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${tab === 'auto' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          <Bot className="h-3 w-3" /> Auto Bot
        </button>
        <button
          onClick={() => setTab('order')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${tab === 'order' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          <FileBox className="h-3 w-3" /> Order Pad
        </button>
      </div>
    </div>
  )
}
