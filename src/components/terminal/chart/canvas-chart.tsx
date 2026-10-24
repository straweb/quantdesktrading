'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { Candle, Tick } from '@/lib/types'
import { TF_MS } from '@/lib/types'
import { api } from '../lib/client-api'
import { useTerminal } from '../lib/store'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'
import {
  CandlestickChart, LineChart, AreaChart, Sigma, Ghost, Ruler, Trash2, MousePointer2,
  Slash, AlignJustify, Shapes, TrendingUp, Type, Waves,
  Pin, Tag, Table, MessageSquare, MessagesSquare, MessageSquareText, Pencil,
  MoveVertical, MoveUpRight, ArrowUpRight, ArrowRight, Minus, AlignEndHorizontal,
  Hourglass, Sun, Square, Circle, CalendarClock, Percent, Hash, ArrowDownUp,
  MoveHorizontal, Crosshair, Clock, CalendarRange, Scissors, BarChartHorizontal,
  BarChart3, Flag, Triangle, Diamond, Activity, TrendingDown, SquareDashed,
  PenLine, ListOrdered,
} from 'lucide-react'

// ============================================================
// From-scratch canvas candlestick chart — no charting library.
// Candles / line / area + volume histogram + indicator panels.
//   · wheel on plot / time axis  -> time zoom (bars)
//   · wheel on price axis / +Shift -> price-scale-only zoom
//   · drag plot                   -> free pan (left/right/top/bottom)
//   · drag price axis             -> squeeze/stretch price scale
//   · drag time axis              -> pan time
//   · double-click / ▶LIVE button -> reset view to live edge
//   · live view always shows ≥3 future slots beyond the last bar
//
// GHOST CANDLES v4 (scalping-tool #ghostCtl, generalized):
//   THE RULE: the LIVE FEED timeframe ALWAYS renders SOLID; the GHOST
//   timeframe ALWAYS renders HOLLOW — no matter which tf is bigger.
//   · ghost TF  > chart TF : ghost shells (hollow) wrap AROUND the
//                            solid live candles (outside view)
//   · ghost TF  < chart TF : ghost candles (hollow) render INSIDE
//                            the solid live candles (inside view)
//   Ghost tf is freely selectable (1m/3m/5m/15m/1h) — the math
//   auto-calcs BOTH directions. Hovering highlights the hovered
//   shell + the exact ghost bar under the cursor; the legend shows
//   the live row + the ghost-tf OHLCV row.
//
// TOP TOOLBAR (single row, under the OHLCV / ghost legend rows):
//   grouped icon+text buttons — Cursor · Type · Ind · Ghost · Scale ·
//   Breaks · Lines · Fib · Shapes · Measure · Position · Annotate ·
//   Pattern · Clear. MOUSE OVER an icon shows its INFO NOTE; CLICK
//   opens the group flyout (items commit on click).
//
// POSITION MARKERS: entry lines from open positions (@ price +
// PnL/%) + draggable SL / target / stop lines (drag vertically to
// set the level; drop calls onMarkerDrop so the parent can arm
// real resting CLOSE-POSITION orders — target→close LIMIT,
// SL→stop-sell/stop-buy SL-M).
//
// #tools — per-chart drawing layer (anchored to time+price), full
//   TradingView-style set:
//   LINES      trend · ray · h-ray · h-line · v-line · arrow · pencil(free)
//   FIB        retracement · extension · trend-based fib time zones ·
//              fib fan
//   SHAPES     rectangle · ellipse · circle
//   MEASURE    price range · price+date range · forecast (projected Δ)
//   POSITION   long box · short box · volume profile · buy/sell imbalance
//   ANNOTATION text · price note · pin · comment (leader+bubble) ·
//              callout (arrow+bubble) · stats table
//   PATTERNS   multi-point pattern (dbl-top/H&S/triangle/ABCD/… — click
//              vertices, double-click to finish)
//   BREAKS     session breaks (09:15/15:30 + shading) · hour breaks ·
//              prev-day range (PDH/PDL + break markers) — per-chart toggles
//   Click-click or drag to draw, click to select, drag to move/edit,
//   Del removes, Esc cancels.
//
// Per-chart independence: chart type, indicator set, ghost, scales,
// breaks and drawings are stored PER CHART (settingsKey) —
// opening charts does not force the same config everywhere.
// ============================================================

export interface ChartMarker {
  price: number
  label: string
  color: string
  /** entry = open-position avg price (read-only) · sl/target = draggable levels */
  kind?: 'entry' | 'sl' | 'target'
  /** second line rendered inside the tag (pnl, %, lots…) */
  sub?: string
  /** unique id — required for draggable kinds */
  id?: string
}

/** Blank bars the user can pan into beyond the live edge. */
export const FUTURE_BARS = 50
/** Future slots visible when the view is pinned to the live edge. */
const LIVE_FUTURE_BARS = 3

/** Axis scales: topmost enabled = right axis, others = left column. */
export interface ScalesCfg { price: boolean; pct: boolean; inv: boolean; pts: boolean }

export type ChartType = 'candles' | 'line' | 'area'

export interface IndicatorCfg {
  vol: boolean
  sma20: boolean
  sma50: boolean
  ema: boolean
  vwap: boolean
  boll: boolean
  rsi: boolean
  macd: boolean
  adx: boolean
}

export interface ChartSettings {
  chartType: ChartType
  ind: IndicatorCfg
  ghost: boolean
  ghostStyle: 'hollow' | 'fade'
  ghostTf: string // ghost timeframe (1m/3m/5m/15m/1h) — live=solid / ghost=hollow in BOTH directions
  scales: ScalesCfg
  /** vertical break overlays (per chart) */
  breaks: { session: boolean; hour: boolean; range: boolean }
}

/** IST wall-clock parts for a UTC ms timestamp (market 09:15–15:30 IST). */
function istParts(t: number) {
  const d = new Date(t + 5.5 * 3600_000)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }
}
const SESSION_OPEN_MIN = 9 * 60 + 15 // 09:15 IST
const SESSION_CLOSE_MIN = 15 * 60 + 30 // 15:30 IST
/** UTC ms timestamp for "IST day D at minutes-since-midnight". */
function istMs(t: number, minOfDay: number): number {
  const d = new Date(t + 5.5 * 3600_000)
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return dayStart - 5.5 * 3600_000 + minOfDay * 60_000
}
/** Shortest fib levels for the extension tool (beyond 100%). */
const FIB_EXT = [0, 0.382, 0.618, 1, 1.272, 1.618, 2.0, 2.618]
const PATTERN_NAMES = ['Double Top', 'Double Bottom', 'Head & Shoulders', 'Inv H&S', 'Triangle', 'Wedge', 'ABCD', 'Flag', 'Channel', 'Custom']
/** visible LIST icons for the pattern picker (round-9: list, not dropdown) */
const PATTERN_ICONS: Record<string, React.ReactNode> = {
  'Double Top': <TrendingDown className="h-3 w-3" />,
  'Double Bottom': <TrendingUp className="h-3 w-3" />,
  'Head & Shoulders': <Activity className="h-3 w-3" />,
  'Inv H&S': <Activity className="h-3 w-3" />,
  'Triangle': <Triangle className="h-3 w-3" />,
  'Wedge': <Diamond className="h-3 w-3" />,
  'ABCD': <PenLine className="h-3 w-3" />,
  'Flag': <Flag className="h-3 w-3" />,
  'Channel': <SquareDashed className="h-3 w-3" />,
  'Custom': <Waves className="h-3 w-3" />,
}

// ---------------- draw tools ----------------

export type DrawTool =
  // lines
  | 'trend' | 'ray' | 'hray' | 'hline' | 'vline' | 'arrow' | 'free'
  // fib suite
  | 'fib' | 'fibext' | 'fibtz' | 'fan'
  // shapes
  | 'rect' | 'ellipse' | 'circle'
  // measure / forecast
  | 'pricerange' | 'pricedate' | 'forecast'
  // position / data
  | 'long' | 'short' | 'vprofile' | 'vbs'
  // annotation (text-bearing)
  | 'text' | 'pricenote' | 'pin' | 'comment' | 'callout' | 'table'
  // multi-point
  | 'pattern'

interface DrawPt { t: number; p: number } // anchored to TIME + price (survives reloads/pan)

interface Drawing {
  id: string
  type: DrawTool
  pts: DrawPt[]
  dir?: 1 | -1 // position box direction
  pS?: number // position stop-loss price
  pT?: number // position target price
  text?: string // annotation content (text / note / comment / callout / pin / table)
  variant?: string // pattern name (double-top, hns, triangle…)
}

// Position-tool defaults (round-9): SL 10% · target 1.5× risk (RR 1:1.5).
// Both levels stay draggable afterwards, and the box right edge resizes.
const POS_SL_PCT = 0.10
const POS_RR = 1.5
const posDefaultSL = (pE: number, dir: 1 | -1) => pE * (1 - dir * POS_SL_PCT)
const posDefaultTGT = (pE: number, dir: 1 | -1) => pE * (1 + dir * POS_SL_PCT * POS_RR)

function distSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / l2
  t = clamp(t, 0, 1)
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

const TOOL_META: { id: DrawTool | 'cursor'; label: string; hint: string; group: string }[] = [
  // lines
  { id: 'trend', label: 'Trend line', hint: 'click start, click end', group: 'Lines' },
  { id: 'ray', label: 'Ray', hint: 'click origin, click direction', group: 'Lines' },
  { id: 'hray', label: 'Horizontal ray', hint: 'click — extends right', group: 'Lines' },
  { id: 'hline', label: 'Horizontal line', hint: 'click to place', group: 'Lines' },
  { id: 'vline', label: 'Vertical line', hint: 'click to place', group: 'Lines' },
  { id: 'arrow', label: 'Arrow', hint: 'click tail, click head', group: 'Lines' },
  { id: 'free', label: 'Pencil (free hand)', hint: 'drag to draw', group: 'Lines' },
  // fib
  { id: 'fib', label: 'Fib retracement', hint: 'click swing high & low', group: 'Fib' },
  { id: 'fibext', label: 'Fib extension', hint: 'click swing, targets beyond 100%', group: 'Fib' },
  { id: 'fibtz', label: 'Fib time zones', hint: 'click start & end — vertical fib bars', group: 'Fib' },
  { id: 'fan', label: 'Fib fan', hint: 'click origin & end — fan rays', group: 'Fib' },
  // shapes
  { id: 'rect', label: 'Rectangle', hint: 'click two corners', group: 'Shapes' },
  { id: 'ellipse', label: 'Ellipse', hint: 'click two corners — oval bounding box', group: 'Shapes' },
  { id: 'circle', label: 'Circle', hint: 'click center, click radius edge — perfect circle', group: 'Shapes' },
  // measure
  { id: 'pricerange', label: 'Price range', hint: 'click start, click end — Δ pts/%', group: 'Measure' },
  { id: 'pricedate', label: 'Price + date range', hint: 'Δ price, %, bars & duration', group: 'Measure' },
  { id: 'forecast', label: 'Forecast', hint: 'click start & end — projected Δ box', group: 'Measure' },
  // position / data
  { id: 'long', label: 'Long position', hint: 'click entry — SL 10% · TGT 1:1.5 — drag lines/edges to reshape', group: 'Position' },
  { id: 'short', label: 'Short position', hint: 'click entry — SL 10% · TGT 1:1.5 — drag lines/edges to reshape', group: 'Position' },
  { id: 'vprofile', label: 'Volume profile', hint: 'click range start & end — POC/VAH/VAL', group: 'Position' },
  { id: 'vbs', label: 'Buy/Sell imbalance', hint: 'click range start & end — net buy vs sell', group: 'Position' },
  // annotation
  { id: 'text', label: 'Text box', hint: 'click to place, type', group: 'Annotate' },
  { id: 'pricenote', label: 'Price note', hint: 'price bubble + text', group: 'Annotate' },
  { id: 'pin', label: 'Pin / flag', hint: 'click to pin a mark', group: 'Annotate' },
  { id: 'comment', label: 'Comment', hint: 'click anchor, click bubble spot', group: 'Annotate' },
  { id: 'callout', label: 'Callout (arrow)', hint: 'click anchor, click bubble spot', group: 'Annotate' },
  { id: 'table', label: 'Table', hint: 'click to place — lines become rows', group: 'Annotate' },
  // patterns
  { id: 'pattern', label: 'Pattern (multi-point)', hint: 'pick from the list, click vertices, dbl-click ends', group: 'Pattern' },
]
/** per-tool icon for the flyout lists (round-9: every sub-menu item has an icon) */
const TOOL_ICONS: Record<string, React.ReactNode> = {
  trend: <TrendingUp className="h-3.5 w-3.5" />,
  ray: <ArrowUpRight className="h-3.5 w-3.5" />,
  hray: <ArrowRight className="h-3.5 w-3.5" />,
  hline: <Minus className="h-3.5 w-3.5" />,
  vline: <MoveVertical className="h-3.5 w-3.5" />,
  arrow: <ArrowUpRight className="h-3.5 w-3.5" />,
  free: <Pencil className="h-3.5 w-3.5" />,
  fib: <AlignJustify className="h-3.5 w-3.5" />,
  fibext: <AlignEndHorizontal className="h-3.5 w-3.5" />,
  fibtz: <Hourglass className="h-3.5 w-3.5" />,
  fan: <Sun className="h-3.5 w-3.5" />,
  rect: <Square className="h-3.5 w-3.5" />,
  ellipse: <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="12" rx="9" ry="6" /></svg>,
  circle: <Circle className="h-3.5 w-3.5" />,
  pricerange: <Ruler className="h-3.5 w-3.5" />,
  pricedate: <CalendarClock className="h-3.5 w-3.5" />,
  forecast: <MoveUpRight className="h-3.5 w-3.5" />,
  long: <TrendingUp className="h-3.5 w-3.5" />,
  short: <TrendingDown className="h-3.5 w-3.5" />,
  vprofile: <BarChartHorizontal className="h-3.5 w-3.5" />,
  vbs: <BarChart3 className="h-3.5 w-3.5" />,
  text: <Type className="h-3.5 w-3.5" />,
  pricenote: <Tag className="h-3.5 w-3.5" />,
  pin: <Pin className="h-3.5 w-3.5" />,
  comment: <MessageSquare className="h-3.5 w-3.5" />,
  callout: <MessagesSquare className="h-3.5 w-3.5" />,
  table: <Table className="h-3.5 w-3.5" />,
  pattern: <Waves className="h-3.5 w-3.5" />,
}
const TWO_PT_TOOLS = new Set<DrawTool>(['trend', 'ray', 'hray', 'arrow', 'rect', 'ellipse', 'circle', 'fib', 'fibext', 'fibtz', 'fan', 'pricerange', 'pricedate', 'forecast', 'vprofile', 'vbs'])
const TEXT_TOOLS = new Set<DrawTool>(['text', 'pricenote', 'pin', 'comment', 'callout', 'table'])
const TOOL_GROUP_ORDER = ['Lines', 'Fib', 'Shapes', 'Measure', 'Position', 'Annotate', 'Pattern']
/** single-row toolbar icon per draw-tool group */
const TOOL_GROUP_ICONS: Record<string, React.ReactNode> = {
  Lines: <Slash className="h-3 w-3" />,
  Fib: <AlignJustify className="h-3 w-3" />,
  Shapes: <Shapes className="h-3 w-3" />,
  Measure: <Ruler className="h-3 w-3" />,
  Position: <TrendingUp className="h-3 w-3" />,
  Annotate: <Type className="h-3 w-3" />,
  Pattern: <Waves className="h-3 w-3" />,
}

const FIBL = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const UP = '#00c896'
const DOWN = '#ff4d5e'
const GRID = 'rgba(255,255,255,0.045)'
const AXIS_TXT = '#8b949e'
const CROSS = 'rgba(255,255,255,0.25)'
const DCOL = { def: '#5fb0d8', fib: '#e0a63f', pos: '#e0a63f' }
const AMBER_TOOLS = new Set<DrawTool>(['fib', 'fibext', 'fibtz', 'fan', 'pricerange', 'pricedate', 'forecast', 'long', 'short', 'vprofile', 'vbs', 'text', 'pricenote', 'pin', 'comment', 'callout', 'table', 'pattern'])

// ----------------------------------------------------------
// ToolMenu — per-chart toolbar control: ICON + common text
// label. Interaction contract (round-8):
//   · MOUSE OVER  -> INFO NOTE (styled tooltip: what it does)
//   · CLICK       -> opens/closes the flyout (always works —
//                    hover never opens the flyout any more)
//   · item clicks commit instantly; the flyout STAYS open
//     (multi-toggle indicators) until an outside click / Esc
//   · only one flyout open at a time (bus event)
// The flyout + tooltip render into document.body as FIXED-
// position portals so chart panes (overflow:hidden) can never
// clip them; the flyout flips upward near the viewport bottom.
// ----------------------------------------------------------
const TB_OPEN_EVENT = 'qd-tb-open'

function ToolMenu({ icon, label, info, active, tint, width = 'w-48', children }: {
  icon: React.ReactNode
  label: string
  info: string
  active?: boolean
  tint?: string
  width?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [tip, setTip] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return null
    const estH = Math.min(430, window.innerHeight * 0.66)
    let top = r.bottom + 6
    if (top + estH > window.innerHeight - 8) top = Math.max(8, r.top - estH - 8)
    const left = Math.min(r.right - 40, window.innerWidth - 336)
    return { left: Math.max(4, left), top }
  }, [])

  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current)
    if (tipTimer.current) clearTimeout(tipTimer.current)
  }
  const onEnter = () => {
    clearTimers()
    tipTimer.current = setTimeout(() => {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) {
        setTipPos({
          left: Math.max(4, Math.min(r.left, window.innerWidth - 300)),
          top: r.bottom + 6 > window.innerHeight - 60 ? Math.max(4, r.top - 40) : r.bottom + 6,
        })
        setTip(true)
      }
    }, 260)
  }
  const onLeave = () => {
    clearTimers()
    setTip(false)
  }
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    clearTimers()
    setTip(false)
    if (!open) {
      setPos(place())
      window.dispatchEvent(new CustomEvent(TB_OPEN_EVENT, { detail: label }))
    }
    setOpen(o => !o)
  }
  // only one open flyout across every chart pane
  useEffect(() => {
    const fn = (ev: Event) => { if ((ev as CustomEvent).detail !== label) setOpen(false) }
    window.addEventListener(TB_OPEN_EVENT, fn)
    return () => window.removeEventListener(TB_OPEN_EVENT, fn)
  }, [label])
  // outside mousedown / Esc closes
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      const fly = document.getElementById('qd-tb-flyout')
      if (fly?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey) }
  }, [open])
  useEffect(() => () => clearTimers(), [])

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        title={info}
        aria-label={label}
        className={`relative flex items-center justify-center h-[22px] w-[26px] rounded border shrink-0 transition-colors ${
          open
            ? 'bg-primary/25 border-primary/50 text-foreground'
            : active
              ? `bg-secondary border-border ${tint ?? 'text-foreground'}`
              : `bg-card/85 border-border ${tint ?? 'text-muted-foreground'} hover:text-foreground hover:bg-secondary`
        }`}
      >
        {icon}
        {active && !open && <span className="absolute -top-[3px] -right-[3px] h-[5px] w-[5px] rounded-full bg-[#e0a63f]" />}
      </button>
      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            id="qd-tb-flyout"
            style={{ position: 'fixed', left: pos.left, top: pos.top }}
            className={`${width} rounded-md border border-border bg-popover text-popover-foreground p-1 shadow-xl z-[80] text-[10px]`}
          >
            {children}
          </div>,
          document.body,
        )}
      {!open && tip && tipPos && typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{ position: 'fixed', left: tipPos.left, top: tipPos.top }}
            className="max-w-[290px] rounded-md border border-[#e0a63f]/50 bg-[#1a1f26] text-[#e6e9ec] px-2 py-1 shadow-xl z-[81] text-[10px] leading-snug pointer-events-none"
          >
            <span className="font-bold text-[#e0a63f]">{label}</span> — <span className="text-muted-foreground">{info}</span>
          </div>,
          document.body,
        )}
    </>
  )
}

/** thin vertical divider between toolbar groups */
function TbSep() {
  return <span className="w-px self-stretch my-0.5 bg-border/70 shrink-0" />
}

// ---------------- indicator math ----------------

function sma(data: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    sum += data[i].c
    if (i >= period) sum -= data[i - period].c
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}

function ema(data: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  const k = 2 / (period + 1)
  let prev = 0
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { out.push(null); prev += data[i].c; continue }
    if (i === period - 1) { prev = (prev + data[i].c) / period; out.push(prev); continue }
    prev = data[i].c * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

/** Session VWAP — resets each calendar day (IST) like real intraday VWAP. */
function vwap(data: Candle[]): (number | null)[] {
  const out: (number | null)[] = []
  let day = '', cumPV = 0, cumV = 0
  for (const c of data) {
    const d = new Date(c.t + 5.5 * 3600_000).toISOString().slice(0, 10) // IST day bucket
    if (d !== day) { day = d; cumPV = 0; cumV = 0 }
    const tp = (c.h + c.l + c.c) / 3
    cumPV += tp * (c.v || 1)
    cumV += c.v || 1
    out.push(cumV > 0 ? cumPV / cumV : null)
  }
  return out
}

function bollinger(data: Candle[], period = 20, mult = 2) {
  const mid = sma(data, period)
  const up: (number | null)[] = []
  const lo: (number | null)[] = []
  for (let i = 0; i < data.length; i++) {
    if (mid[i] == null) { up.push(null); lo.push(null); continue }
    let s = 0
    for (let j = i - period + 1; j <= i; j++) s += (data[j].c - mid[i]!) ** 2
    const sd = Math.sqrt(s / period)
    up.push(mid[i]! + mult * sd)
    lo.push(mid[i]! - mult * sd)
  }
  return { mid, up, lo }
}

function rsi(data: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = []
  let avgG = 0, avgL = 0
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { out.push(null); continue }
    const ch = data[i].c - data[i - 1].c
    const g = Math.max(0, ch), l = Math.max(0, -ch)
    if (i <= period) {
      avgG += g / period; avgL += l / period
      out.push(i === period ? toRsi(avgG, avgL) : null)
      continue
    }
    avgG = (avgG * (period - 1) + g) / period
    avgL = (avgL * (period - 1) + l) / period
    out.push(toRsi(avgG, avgL))
  }
  return out
}
function toRsi(g: number, l: number): number | null {
  if (l === 0) return 100
  const rs = g / l
  return 100 - 100 / (1 + rs)
}

function macd(data: Candle[], fast = 12, slow = 26, sig = 9) {
  const ef = ema(data, fast)
  const es = ema(data, slow)
  const line = data.map((_, i) => (ef[i] != null && es[i] != null ? ef[i]! - es[i]! : null))
  // signal = EMA9 of the macd line (skip nulls at head)
  const signal: (number | null)[] = []
  const k = 2 / (sig + 1)
  let prev = 0
  let seeded = false
  for (let i = 0; i < data.length; i++) {
    if (line[i] == null) { signal.push(null); continue }
    if (!seeded) { prev = line[i]!; seeded = true; signal.push(prev); continue }
    prev = line[i]! * k + prev * (1 - k)
    signal.push(prev)
  }
  const hist = data.map((_, i) => (line[i] != null && signal[i] != null ? line[i]! - signal[i]! : null))
  return { line, signal, hist }
}

/** ADX(14) with +DI / -DI (Wilder smoothing). */
function adx(data: Candle[], period = 14) {
  const n = data.length
  const pdi: (number | null)[] = [], mdi: (number | null)[] = [], adxArr: (number | null)[] = []
  if (n === 0) return { adx: adxArr, pdi, mdi }
  const plusDM = new Array<number>(n).fill(0), minusDM = new Array<number>(n).fill(0), tr = new Array<number>(n).fill(0)
  for (let i = 1; i < n; i++) {
    const up = data[i].h - data[i - 1].h
    const dn = data[i - 1].l - data[i].l
    plusDM[i] = up > dn && up > 0 ? up : 0
    minusDM[i] = dn > up && dn > 0 ? dn : 0
    tr[i] = Math.max(data[i].h - data[i].l, Math.abs(data[i].h - data[i - 1].c), Math.abs(data[i].l - data[i - 1].c))
  }
  let atr = 0, pdm = 0, mdm = 0, adxPrev: number | null = null
  let sp = 0, sm = 0, st = 0
  for (let i = 0; i < n; i++) {
    if (i < period) {
      sp += plusDM[i]; sm += minusDM[i]; st += tr[i]
      pdi.push(null); mdi.push(null); adxArr.push(null)
      if (i === period - 1) {
        atr = st; pdm = sp; mdm = sm
        const P = atr ? (pdm / atr) * 100 : 0, M = atr ? (mdm / atr) * 100 : 0
        pdi[i] = P; mdi[i] = M
        adxPrev = P + M ? (Math.abs(P - M) / (P + M)) * 100 : 0
      }
      continue
    }
    atr = atr - atr / period + tr[i]
    pdm = pdm - pdm / period + plusDM[i]
    mdm = mdm - mdm / period + minusDM[i]
    const P = atr ? (pdm / atr) * 100 : 0, M = atr ? (mdm / atr) * 100 : 0
    pdi.push(P); mdi.push(M)
    const dx = P + M ? (Math.abs(P - M) / (P + M)) * 100 : 0
    adxPrev = adxPrev == null ? dx : (adxPrev * (period - 1) + dx) / period
    adxArr.push(i >= period * 2 - 1 ? adxPrev : null)
  }
  return { adx: adxArr, pdi, mdi }
}

/** Aggregate base candles up to a higher timeframe bucket (ghost shells). */
function aggregateCandles(base: Candle[], ms: number): Candle[] {
  const out: Candle[] = []
  let cur: Candle | null = null
  for (const b of base) {
    const bs = Math.floor(b.t / ms) * ms
    if (!cur || cur.t !== bs) {
      if (cur) out.push(cur)
      cur = { t: bs, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
    } else {
      cur.h = Math.max(cur.h, b.h)
      cur.l = Math.min(cur.l, b.l)
      cur.c = b.c
      cur.v += b.v
    }
  }
  if (cur) out.push(cur)
  return out
}

// ---------------- crosshair sync bus ----------------
// Every chart publishes its hovered candle time; charts running the
// same interval draw a synced crosshair + legend values at that time.

export interface CrossSyncMsg { src: number; tf: string; t: number | null; price: number | null }
const crossBusListeners = new Set<(m: CrossSyncMsg) => void>()
let CHART_SEQ = 0

function emitCross(m: CrossSyncMsg) {
  for (const fn of crossBusListeners) fn(m)
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min
  if (span <= 0) return [min]
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max; v += step) out.push(v)
  return out
}

function fmtAxisTime(t: number, tf: string, withSecs = false): string {
  const d = new Date(t)
  if (tf === '1d') return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', ...(withSecs ? { second: '2-digit' as const } : {}), hour12: false,
  })
}

function fmtVol(v: number): string {
  if (v >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`
  if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(Math.round(v))
}

// ---- scale labels (percent / points vs baseline) ----
function labelPct(v: number): string {
  const s = v >= 0 ? '+' : '-', a = Math.abs(v)
  return s + (a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2)) + '%'
}
function labelPts(v: number): string {
  const s = v >= 0 ? '+' : '-', a = Math.abs(v)
  return s + (a >= 1000 ? a.toFixed(0) : a >= 100 ? a.toFixed(1) : a.toFixed(2))
}

// baseline pick-mode bus (toolbar "Set base" button arms ALL charts;
// the next chart click consumes it)
const BASE_PICK_EVENT = 'qd-chart-set-base'
const BASE_SET_EVENT = 'qd-chart-base-set'

function lowerBoundTime(arr: Candle[], t: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid }
  return lo
}

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)) }

interface DragState {
  zone: 'plot' | 'price' | 'time' | 'base'
  startX: number
  startY: number
  startOffset: number
  startPriceOff: number
  startPriceZoom: number
  pxPerPx: number
  moved: number
}

// ---- per-chart settings + drawings persistence ----

const settingsKeyFor = (k?: string) => `zterm-chart:${k ?? 'default'}`
const drawingsKeyFor = (k?: string) => `zterm-chart-drawings:${k ?? 'default'}`

function loadSettings(key: string | undefined, fallback: ChartSettings): ChartSettings {
  if (typeof window === 'undefined' || !key) return fallback
  try {
    const raw = window.localStorage.getItem(settingsKeyFor(key))
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<ChartSettings>
    return {
      chartType: parsed.chartType ?? fallback.chartType,
      ind: { ...fallback.ind, ...(parsed.ind ?? {}) },
      ghost: parsed.ghost ?? fallback.ghost,
      ghostStyle: parsed.ghostStyle ?? fallback.ghostStyle,
      ghostTf: parsed.ghostTf ?? fallback.ghostTf,
      scales: { ...fallback.scales, ...(parsed.scales ?? {}) },
      breaks: { ...(fallback.breaks ?? { session: false, hour: false, range: false }), ...(parsed.breaks ?? {}) },
    }
  } catch { return fallback }
}

function loadDrawings(key: string | undefined): Drawing[] {
  if (typeof window === 'undefined' || !key) return []
  try {
    const raw = window.localStorage.getItem(drawingsKeyFor(key))
    const arr = raw ? (JSON.parse(raw) as Drawing[]) : []
    return Array.isArray(arr) ? arr.slice(0, 120) : []
  } catch { return [] }
}

interface Props {
  symbol: string
  tf: string
  chartType: ChartType
  showVolume: boolean
  showSMA20: boolean
  showSMA50: boolean
  showEMA?: boolean
  showVWAP?: boolean
  showBOLL?: boolean
  showRSI?: boolean
  showMACD?: boolean
  showADX?: boolean
  // ghost overlay (#ghostCtl): inner candles of ghostTf inside shells —
  // auto-calc works BOTH directions (ghostTf lower OR higher than tf)
  showGhost?: boolean
  ghostStyle?: 'hollow' | 'fade'
  ghostTf?: string
  scales?: ScalesCfg
  markers?: ChartMarker[]
  onPriceClick?: (price: number) => void
  /** A draggable marker (sl/target) was dropped at a new price. */
  onMarkerDrop?: (kind: 'sl' | 'target', price: number) => void
  /** Remove a draggable marker (double-click its handle). */
  onMarkerRemove?: (kind: 'sl' | 'target') => void
  /** EXIT button on the entry marker line was clicked (close the position). */
  onExitPosition?: () => void
  height: string
  mini?: boolean // compact mode: no crosshair, thin axes, no controls
  /** Per-chart identity — settings + drawings persist under this key so
   *  every chart keeps its OWN indicators / type / ghost / tools. */
  settingsKey?: string
  /** Render the per-chart control bar (type / indicators / ghost / scales / tools). */
  controls?: boolean
}

// ---------------- component ----------------

export function CanvasChart({
  symbol, tf, chartType, showVolume, showSMA20, showSMA50,
  showEMA = false, showVWAP = false, showBOLL = false, showRSI = false, showMACD = false, showADX = false,
  showGhost = false, ghostStyle = 'hollow', ghostTf, scales,
  markers = [], onPriceClick, onMarkerDrop, onMarkerRemove, onExitPosition, height, mini = false, settingsKey, controls,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [barCount, setBarCount] = useState(mini ? 60 : 120)
  const [dirty, setDirty] = useState(false) // false = view pinned to live edge
  const offsetRef = useRef(0) // bars panned; NEGATIVE = into future space
  const priceZoomRef = useRef(1)
  const priceOffRef = useRef(0)
  const [, forceRender] = useState(0)
  const crossRef = useRef<{ x: number; y: number; inPlot: boolean } | null>(null)
  const syncCrossRef = useRef<{ slot: number; price: number | null } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
  const winRef = useRef({ w: 0, h: 0, plotW: 0, priceH: 0, axisH: mini ? 12 : 20, pMin: 0, pMax: 1 })
  const lastRangeRef = useRef({ pMin: 0, pMax: 1 }) // survives full-future views
  const lastVolRef = useRef<Record<string, number>>({})
  const chartId = useRef(++CHART_SEQ)

  // ---- per-chart settings (chart type / indicators / ghost / scales) ----
  const [settings, setSettings] = useState<ChartSettings>(() => ({
    chartType,
    ind: { vol: showVolume, sma20: showSMA20, sma50: showSMA50, ema: showEMA, vwap: showVWAP, boll: showBOLL, rsi: showRSI, macd: showMACD, adx: showADX },
    ghost: showGhost,
    ghostStyle,
    ghostTf: ghostTf ?? '1m',
    scales: scales ?? { price: true, pct: false, inv: false, pts: false },
    breaks: { session: false, hour: false, range: false },
  }))
  useEffect(() => {
    const defaults: ChartSettings = {
      chartType,
      ind: { vol: showVolume, sma20: showSMA20, sma50: showSMA50, ema: showEMA, vwap: showVWAP, boll: showBOLL, rsi: showRSI, macd: showMACD, adx: showADX },
      ghost: showGhost,
      ghostStyle,
      ghostTf: ghostTf ?? '1m',
      scales: scales ?? { price: true, pct: false, inv: false, pts: false },
      breaks: { session: false, hour: false, range: false },
    }
    setSettings(loadSettings(settingsKey, defaults))
    setDrawings(loadDrawings(settingsKey))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey])

  const patchSettings = useCallback((p: Partial<ChartSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...p }
      try { window.localStorage.setItem(settingsKeyFor(settingsKey), JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }, [settingsKey])

  // ---- per-chart drawings (#tools) ----
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [tool, setTool] = useState<DrawTool | 'cursor'>('cursor')
  const toolRef = useRef<DrawTool | 'cursor'>('cursor')
  const setToolBoth = (t: DrawTool | 'cursor') => { toolRef.current = t; setTool(t) }
  const selIdRef = useRef<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const pendingRef = useRef<Drawing | null>(null)
  // draw-drag modes: move · pt (endpoint) · ps (stop line) · tg (target line) · w (box right edge)
  const dragDrawRef = useRef<{ d: Drawing; mode: 'move' | 'pt' | 'ps' | 'tg' | 'w'; pi?: number; startMouse: { x: number; y: number }; orig: Drawing } | null>(null)

  // text-entry overlay for annotation tools (text / note / comment / callout / pin / table)
  const [textEdit, setTextEdit] = useState<{ id: string; x: number; y: number; value: string; multiline: boolean } | null>(null)
  const textEditOpenedAt = useRef(0)
  const textInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  const setSel = (id: string | null) => { selIdRef.current = id; setSelId(id) }
  const patternVariantRef = useRef<string>('Double Top')
  const freeActiveRef = useRef(false)

  const commitDrawings = useCallback((next: Drawing[]) => {
    setDrawings(next)
    try { window.localStorage.setItem(drawingsKeyFor(settingsKey), JSON.stringify(next.slice(-120))) } catch { /* private mode */ }
  }, [settingsKey])

  const newDrawing = useCallback((d: Omit<Drawing, 'id'>) => {
    const full: Drawing = { ...d, id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}` }
    commitDrawings([...drawingsRef.current, full].slice(-120))
    return full
  }, [commitDrawings])

  // drawings mirror for RAF loop + stable access in handlers
  const drawingsRef = useRef<Drawing[]>(drawings)
  useEffect(() => { drawingsRef.current = drawings }, [drawings])

  // ---- ghost inner data (fetched when ghostTf is LOWER than tf; when the
  // ghost tf is HIGHER the shells are auto-calc aggregated from base data) ----
  const [ghost, setGhost] = useState<Candle[]>([])
  const ghostTfMs = TF_MS[(settings.ghostTf ?? '1m') as keyof typeof TF_MS] ?? 60_000
  const tfMsVal = TF_MS[tf as keyof typeof TF_MS] ?? 60_000
  // shells for the ghost-tf-higher direction (derived locally = "auto calc math")
  const ghostShells = useMemo(
    () => (tfMsVal > 0 && ghostTfMs > tfMsVal ? aggregateCandles(candles, ghostTfMs) : []),
    [candles, ghostTfMs, tfMsVal],
  )

  // ---- scales baseline (null = day open ref) + pick mode ----
  const baseRef = useRef<number | null>(null)
  const pickRef = useRef(false)
  const [baseArmed, setBaseArmed] = useState(false)
  // last-drawn baseline geometry (for the grab zone) — updated every frame
  const drawMetaRef = useRef({ yBase: -1, baseline: 0 })
  // live drag of a level marker (sl/target): { id, kind, price }
  const markerDragRef = useRef<{ id: string; kind: 'sl' | 'target'; price: number } | null>(null)
  // last-drawn EXIT button rect on the entry marker line (canvas hit-test)
  const exitBtnRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  // ---- baseline pick-mode bus (armed from the toolbar SCALES popover) ----
  useEffect(() => {
    const arm = () => { pickRef.current = true; setBaseArmed(true) }
    const disarm = () => { pickRef.current = false; setBaseArmed(false) }
    window.addEventListener(BASE_PICK_EVENT, arm)
    window.addEventListener(BASE_SET_EVENT, disarm)
    return () => {
      window.removeEventListener(BASE_PICK_EVENT, arm)
      window.removeEventListener(BASE_SET_EVENT, disarm)
    }
  }, [])

  // ---- crosshair sync (same tf only — charts are interval-locked) ----
  useEffect(() => {
    const fn = (m: CrossSyncMsg) => {
      if (m.src === chartId.current || m.tf !== tf) { return }
      if (m.t == null) { syncCrossRef.current = null; return }
      syncCrossRef.current = { slot: m.t, price: m.price } // slot stores t; resolved in draw
      forceRender(n => n + 1)
    }
    crossBusListeners.add(fn)
    return () => { crossBusListeners.delete(fn) }
  }, [tf])

  // ---- data loading ----
  const loadSeqRef = useRef(0)
  const loadedSymRef = useRef<string | null>(null)
  const load = useCallback(async () => {
    if (!symbol) return
    const seq = ++loadSeqRef.current
    try {
      const r = await api.candles(symbol, tf as never, 1000)
      if (seq !== loadSeqRef.current) return
      if (r.candles?.length) {
        setCandles(r.candles)
        loadedSymRef.current = symbol
        lastVolRef.current = { [symbol]: r.candles[r.candles.length - 1]?.v ?? 0 }
      } else if (loadedSymRef.current !== symbol) {
        setCandles([]) // new symbol has no data yet — drop the previous series
      }
      setErr(null)
    } catch {
      // 404 = the feed engine has no data for this symbol (live source not
      // flowing yet) — keep the chart empty instead of surfacing an error
      if (seq !== loadSeqRef.current) return
      if (loadedSymRef.current !== symbol) setCandles([])
      setErr(null)
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [symbol, tf])

  const dataEpoch = useTerminal(s => s.dataEpoch)
  useEffect(() => {
    setLoading(true)
    offsetRef.current = 0
    priceZoomRef.current = 1
    priceOffRef.current = 0
    setDirty(false)
    // SOFT symbol switch: keep the previous series on screen until the new
    // symbol's candles arrive — a followed-ATM shift no longer blanks the
    // pane into a "loading candles…" flash.  Stale data is REPLACED, never
    // cleared first (cleared only if the new symbol returns nothing).
    load()
    subscribeTicks([symbol])
    const iv = setInterval(load, 30_000)
    return () => {
      unsubscribeTicks([symbol])
      clearInterval(iv)
    }
  }, [symbol, tf, load, dataEpoch])

  // ---- ghost source data (inner candles + hover inner legend) ----
  useEffect(() => {
    const gMs = TF_MS[(settings.ghostTf ?? '1m') as keyof typeof TF_MS] ?? 60_000
    const tMs = TF_MS[tf as keyof typeof TF_MS] ?? 60_000
    if (gMs >= tMs) { setGhost([]); return } // higher-ghost: shells derive from base
    let dead = false
    const pull = async () => {
      try {
        const need = Math.min(3000, Math.max(420, barCount * (tMs / gMs) + 80))
        const r = await api.candles(symbol, settings.ghostTf as never, need)
        if (!dead) setGhost(r.candles ?? [])
      } catch { /* ghost is best-effort */ }
    }
    pull()
    const iv = setInterval(pull, 30_000)
    return () => { dead = true; clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tf, settings.ghostTf])

  // ---- live ticks merge into the last candle (+ ghost tail) ----
  useEffect(() => {
    return onTicks(map => {
      const t: Tick | undefined = map[symbol]
      if (!t) return
      setCandles(prev => {
        if (prev.length === 0) return prev
        const arr = prev.slice()
        const last = { ...arr[arr.length - 1] }
        const bucket = Math.floor(t.ts / TF_MS[tf as keyof typeof TF_MS]) * TF_MS[tf as keyof typeof TF_MS]
        const dayVolDelta = Math.max(0, t.vol - (lastVolRef.current[symbol] ?? t.vol))
        lastVolRef.current[symbol] = t.vol
        if (bucket > last.t) {
          arr.push({ t: bucket, o: t.ltp, h: t.ltp, l: t.ltp, c: t.ltp, v: dayVolDelta })
          if (arr.length > 1600) arr.splice(0, 200)
        } else {
          last.c = t.ltp
          last.h = Math.max(last.h, t.ltp)
          last.l = Math.min(last.l, t.ltp)
          last.v += dayVolDelta
          arr[arr.length - 1] = last
        }
        return arr
      })
      if (ghostTfMs < tfMsVal) {
        setGhost(prevG => {
          if (prevG.length === 0) return prevG
          const gArr = prevG.slice()
          const gl = { ...gArr[gArr.length - 1] }
          const gb = Math.floor(t.ts / ghostTfMs) * ghostTfMs
          if (gb > gl.t) {
            gArr.push({ t: gb, o: t.ltp, h: t.ltp, l: t.ltp, c: t.ltp, v: 0 })
            if (gArr.length > 2600) gArr.splice(0, 200)
          } else {
            gl.c = t.ltp
            gl.h = Math.max(gl.h, t.ltp)
            gl.l = Math.min(gl.l, t.ltp)
            gArr[gArr.length - 1] = gl
          }
          return gArr
        })
      }
    })
  }, [symbol, tf])

  // ---- geometry shared with the pointer handlers (drawings hit-testing) ----
  const geoRef = useRef({
    w: 0, h: 0, plotW: 0, priceH: 0, colW: 0, cw: 1, tfMs: 60_000,
    pMin: 0, pMax: 1, t0: 0, slotStart: 0, dataLen: 0, lastT: 0, axisW: 58, axisH: 20,
  })

  // ---- render loop ----
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    let raf = 0

    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (sizeRef.current.w !== w || sizeRef.current.h !== h || canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
        sizeRef.current = { w, h }
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.font = '10px ui-monospace, monospace'

      const data = candles
      if (data.length < 2) {
        ctx.fillStyle = AXIS_TXT
        ctx.textAlign = 'center'
        ctx.fillText(loading ? 'loading candles…' : err || 'no data', w / 2, h / 2)
        return
      }

      const ind = settings.ind
      const chartKind = settings.chartType
      const axisW = mini ? 46 : 58
      const axisH = mini ? 12 : 20
      const plotW = w - axisW
      const availH = h - axisH
      const volH = ind.vol ? Math.round(availH * (mini ? 0.14 : 0.16)) : 0
      const subSlot = Math.round(availH * 0.16)
      const rsiH = !mini && ind.rsi ? subSlot : 0
      const macdH = !mini && ind.macd ? subSlot : 0
      const adxH = !mini && ind.adx ? subSlot : 0
      const priceH = availH - (ind.vol ? volH + 5 : 0) - rsiH - macdH - adxH

      // visible window — offset may be NEGATIVE (future space).
      // Live (pinned) view always reserves ≥3 future slots beyond the last bar.
      const liveFuture = dirty ? 0 : LIVE_FUTURE_BARS
      const end = data.length - Math.round(offsetRef.current) + liveFuture
      const start = Math.min(end - barCount, data.length - 2)
      const slots = end - start
      if (slots < 2) { offsetRef.current = 0; return }
      const vis: (Candle | null)[] = new Array(slots)
      for (let i = 0; i < slots; i++) vis[i] = data[start + i] ?? null
      const lastC0 = data[data.length - 1]
      const lastT = data[data.length - 1].t
      const tfMs = TF_MS[tf as keyof typeof TF_MS] ?? 60_000
      const timeOfSlot = (i: number) => {
        const di = start + i
        return di < data.length ? data[di].t : lastT + (di - (data.length - 1)) * tfMs
      }
      const t0Slot = timeOfSlot(0)
      const xOfTime = (t: number) => ((t - t0Slot) / tfMs) * (plotW / slots) + plotW / slots / 2

      // day-change reference (session open) — the default scales baseline
      const dayKey = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10)
      const todayKey = dayKey(lastT)
      let dayRef = lastC0.o
      for (let i = data.length - 1; i >= 0; i--) {
        if (dayKey(data[i].t) !== todayKey) break
        dayRef = data[i].o
      }
      const baseline = baseRef.current ?? dayRef
      const pctOf = (p: number) => (baseline ? ((p - baseline) / baseline) * 100 : 0)

      // price range over real candles + overlays + ghost inner bars
      let pMin = Infinity, pMax = -Infinity
      for (const c of vis) { if (!c) continue; if (c.l < pMin) pMin = c.l; if (c.h > pMax) pMax = c.h }
      if (ghost.length > 0 && tfMs > 60_000 && settings.ghost && ghostTfMs < tfMs) {
        const tA = timeOfSlot(0), tB = timeOfSlot(slots - 1) + tfMs
        const g0 = lowerBoundTime(ghost, tA), g1 = lowerBoundTime(ghost, tB)
        for (let gi2 = g0; gi2 < g1; gi2++) { const g = ghost[gi2]; if (g.l < pMin) pMin = g.l; if (g.h > pMax) pMax = g.h }
      }
      const s20 = ind.sma20 ? sma(data, 20) : null
      const s50 = ind.sma50 ? sma(data, 50) : null
      const e9 = ind.ema ? ema(data, 9) : null
      const e21 = ind.ema ? ema(data, 21) : null
      const vw = ind.vwap ? vwap(data) : null
      const bb = ind.boll ? bollinger(data) : null
      const includeSeries = (arr: (number | null)[] | null | undefined, up?: (number | null)[] | null, lo?: (number | null)[] | null) => {
        if (arr) for (let i = start; i < end; i++) { const v = arr[i]; if (v != null) { if (v < pMin) pMin = v; if (v > pMax) pMax = v } }
        if (up) for (let i = start; i < end; i++) { const v = up[i]; if (v != null) { if (v < pMin) pMin = v; if (v > pMax) pMax = v } }
        if (lo) for (let i = start; i < end; i++) { const v = lo[i]; if (v != null) { if (v < pMin) pMin = v; if (v > pMax) pMax = v } }
      }
      includeSeries(s20); includeSeries(s50); includeSeries(e9); includeSeries(e21); includeSeries(vw)
      if (bb) includeSeries(bb.mid, bb.up, bb.lo)
      for (const m of markers) { if (m.price < pMin) pMin = m.price; if (m.price > pMax) pMax = m.price }
      if (!isFinite(pMin) || !isFinite(pMax)) { pMin = lastRangeRef.current.pMin; pMax = lastRangeRef.current.pMax }
      const pad = (pMax - pMin) * 0.08 || pMax * 0.001 || 1
      pMin -= pad; pMax += pad
      lastRangeRef.current = { pMin, pMax }

      const zoom = priceZoomRef.current
      const center = (pMin + pMax) / 2
      const half = ((pMax - pMin) / 2) * zoom
      pMin = center - half + priceOffRef.current
      pMax = center + half + priceOffRef.current

      winRef.current = { w, h, plotW, priceH, axisH, pMin, pMax }

      const cw = plotW / slots
      const bodyW = Math.max(1, Math.min(14, cw * 0.68))
      const xOf = (i: number) => i * cw + cw / 2
      const yOf = (p: number) => ((pMax - p) / (pMax - pMin)) * priceH

      // ---- scales config: topmost enabled = right axis, others = left column ----
      const scalesCfg = settings.scales ?? { price: true, pct: false, inv: false, pts: false }
      const enabledScales = (['price', 'pct', 'inv', 'pts'] as const).filter(k => scalesCfg[k])
      const primary = enabledScales[0] ?? 'price'
      const secondaries = enabledScales.slice(1)
      const scaleLabel = (p: number) =>
        primary === 'pct' ? labelPct(pctOf(p))
        : primary === 'inv' ? labelPct(-pctOf(p))
        : primary === 'pts' ? labelPts(p - baseline)
        : (p >= 1000 ? p.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : p.toFixed(2))

      // ---- shared geometry for the pointer handlers ----
      geoRef.current = { w, h, plotW, priceH, colW: 0, cw, tfMs, pMin, pMax, t0: t0Slot, slotStart: start, dataLen: data.length, lastT, axisW, axisH }

      // grid + price axis (labels follow the primary scale)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const tickList = niceTicks(pMin, pMax, Math.max(mini ? 2 : 3, Math.floor(priceH / (mini ? 90 : 55))))
      for (const p of tickList) {
        const y = yOf(p)
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
        ctx.fillStyle = AXIS_TXT
        ctx.fillText(scaleLabel(p), plotW + 6, y)
      }

      // ---- left measurement column (secondary scales, sample-tool style) ----
      const colW = secondaries.length > 0 && !mini ? 10 + Math.max(34, secondaries.length * 40) : 0
      geoRef.current.colW = colW
      if (colW > 0) {
        ctx.fillStyle = 'rgba(11,14,17,0.66)'
        ctx.fillRect(0, 0, colW, priceH)
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'
        ctx.beginPath(); ctx.moveTo(colW, 0); ctx.lineTo(colW, priceH); ctx.stroke()
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        const yBase = yOf(baseline)
        for (const p of tickList) {
          const y = yOf(p)
          if (y < 8 || y > priceH - 8) continue
          let ly = y - (secondaries.length - 1) * 6
          for (const s of secondaries) {
            const v = s === 'pct' ? labelPct(pctOf(p)) : s === 'inv' ? labelPct(-pctOf(p)) : labelPts(p - baseline)
            ctx.fillStyle = s === 'pct' ? 'rgba(224,166,63,0.85)' : s === 'inv' ? 'rgba(224,106,159,0.85)' : 'rgba(77,208,225,0.85)'
            ctx.fillText(v, 3, ly)
            ly += 12
          }
        }
        // baseline marker in the column
        if (yBase >= 0 && yBase <= priceH) {
          ctx.fillStyle = 'rgba(224,166,63,0.95)'
          ctx.fillRect(0, yBase - 7, colW, 14)
          ctx.fillStyle = '#0b0e11'
          ctx.font = 'bold 9px ui-monospace, monospace'
          ctx.fillText('BASE', 3, yBase)
          ctx.font = '10px ui-monospace, monospace'
        }
      }

      // time axis (labels incl. future space)
      if (!mini) {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const labelEvery = Math.max(1, Math.ceil(slots / Math.max(2, Math.floor(plotW / 90))))
        for (let i = 0; i < slots; i += labelEvery) {
          const x = xOf(i)
          ctx.strokeStyle = GRID
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - axisH); ctx.stroke()
          ctx.fillStyle = AXIS_TXT
          ctx.fillText(fmtAxisTime(timeOfSlot(i), tf), x, h - axisH + 4)
        }
        // future-space divider
        const fi = data.length - start
        if (fi > 0 && fi < slots) {
          const fx = xOf(fi) - cw / 2
          ctx.strokeStyle = 'rgba(139,148,158,0.28)'
          ctx.setLineDash([2, 4])
          ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, h - axisH); ctx.stroke()
          ctx.setLineDash([])
        }
      }

      // ---- mouse geometry (hovered slot + hovered inner bar) ----
      const mouse = crossRef.current
      const inPlot = !!mouse && mouse.inPlot !== false && mouse.x >= 0 && mouse.x <= plotW && mouse.y >= 0 && mouse.y <= priceH
      const hoverSlot = inPlot ? clamp(Math.floor(mouse!.x / cw), 0, slots - 1) : -1
      const mouseT = inPlot ? t0Slot + (mouse!.x - cw / 2) / cw * tfMs : 0
      // hovered INNER bar: ghost series (ghost lower) or base data (ghost higher)
      let gi = -1
      const ghostOn = settings.ghost
      const ghostLower = ghostOn && ghostTfMs < tfMs && ghost.length > 0
      const ghostHigher = ghostOn && ghostTfMs > tfMs && ghostShells.length > 0
      const ghostEff = ghostLower || ghostHigher
      if (inPlot && ghostLower && ghost.length > 0) {
        const i = lowerBoundTime(ghost, Math.max(mouseT, ghost[0].t))
        gi = i < ghost.length && ghost[i].t <= mouseT ? i : Math.max(0, i - 1)
        if (mouseT >= ghost[ghost.length - 1].t) gi = ghost.length - 1
      } else if (inPlot && ghostHigher) {
        const i = lowerBoundTime(candles, Math.max(mouseT, candles[0].t))
        gi = i < candles.length && candles[i].t <= mouseT ? i : Math.max(0, i - 1)
        if (mouseT >= candles[candles.length - 1].t) gi = candles.length - 1
      } else if (inPlot && !ghostOn && ghost.length > 0 && tfMs > 60_000) {
        // ghost OFF but the 1m series is available — keep the hovered inner bar
        // for the amber column + legend row 2
        const i = lowerBoundTime(ghost, Math.max(mouseT, ghost[0].t))
        gi = i < ghost.length && ghost[i].t <= mouseT ? i : Math.max(0, i - 1)
        if (mouseT >= ghost[ghost.length - 1].t) gi = ghost.length - 1
      }
      // hovered SHELL (ghost higher): the shell containing mouseT
      let hoverShellT = -1
      if (inPlot && ghostHigher) {
        const si = lowerBoundTime(ghostShells, mouseT)
        const sh = ghostShells[si > 0 && ghostShells[si]?.t > mouseT ? si - 1 : si]
        if (sh) hoverShellT = sh.t
      }

      // volume histogram (base slots) — drawn under the candles
      const volBot = priceH + 5 + volH
      if (ind.vol && volH > 0) {
        let vMax = 0
        for (const c of vis) if (c && c.v > vMax) vMax = c.v
        vis.forEach((c, i) => {
          if (!c || c.v <= 0) return
          const vh = (c.v / vMax) * volH
          ctx.fillStyle = c.c >= c.o ? 'rgba(0,200,150,0.35)' : 'rgba(255,77,94,0.35)'
          ctx.fillRect(xOf(i) - bodyW / 2, volBot - vh, bodyW, vh)
        })
        ctx.fillStyle = 'rgba(139,148,158,0.8)'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(`Vol ${fmtVol(vMax)}`, 4, volBot - volH + 1)
      }

      // RSI panel
      const rsiArr = !mini && ind.rsi ? rsi(data) : null
      if (rsiArr && rsiH > 0) {
        const top = priceH + (ind.vol ? 5 + volH + 2 : 2)
        const yR = (v: number) => top + ((100 - v) / 100) * rsiH
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(plotW, top); ctx.stroke()
        for (const g of [30, 70]) {
          ctx.strokeStyle = 'rgba(255,255,255,0.07)'
          ctx.setLineDash([2, 3])
          ctx.beginPath(); ctx.moveTo(0, yR(g)); ctx.lineTo(plotW, yR(g)); ctx.stroke()
          ctx.setLineDash([])
        }
        ctx.strokeStyle = '#f5a623'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        let st = false
        for (let i = start; i < end; i++) {
          const v = rsiArr[i]; if (v == null) { st = false; continue }
          const x = xOf(i - start), y = yR(v)
          if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.lineWidth = 1
        ctx.fillStyle = '#f5a623'
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'
        ctx.fillText('RSI14', 4, top + 1)
      }

      // MACD panel
      const macdArr = !mini && ind.macd ? macd(data) : null
      if (macdArr && macdH > 0) {
        const top = priceH + (ind.vol ? 5 + volH + 2 : 2) + (rsiH ? rsiH + 2 : 0)
        let mMin = Infinity, mMax = -Infinity
        for (let i = start; i < end; i++) {
          for (const arr of [macdArr.line, macdArr.signal, macdArr.hist]) {
            const v = arr[i]; if (v == null) continue
            if (v < mMin) mMin = v; if (v > mMax) mMax = v
          }
        }
        if (!isFinite(mMin)) { mMin = -1; mMax = 1 }
        const mAbs = Math.max(Math.abs(mMin), Math.abs(mMax)) || 1
        const yM = (v: number) => top + ((mAbs - v) / (2 * mAbs)) * macdH
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(plotW, top); ctx.stroke()
        ctx.strokeStyle = 'rgba(255,255,255,0.09)'
        ctx.beginPath(); ctx.moveTo(0, yM(0)); ctx.lineTo(plotW, yM(0)); ctx.stroke()
        vis.forEach((c, i) => {
          if (!c) return
          const v = macdArr.hist[start + i]; if (v == null) return
          const y0 = yM(0), y1 = yM(v)
          ctx.fillStyle = v >= 0 ? 'rgba(0,200,150,0.4)' : 'rgba(255,77,94,0.4)'
          ctx.fillRect(xOf(i) - bodyW / 2, Math.min(y0, y1), bodyW, Math.max(1, Math.abs(y1 - y0)))
        })
        const drawLine = (arr: (number | null)[], color: string) => {
          ctx.strokeStyle = color
          ctx.lineWidth = 1.2
          ctx.beginPath()
          let st = false
          for (let i = start; i < end; i++) {
            const v = arr[i]; if (v == null) { st = false; continue }
            const x = xOf(i - start), y = yM(v)
            if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
          }
          ctx.stroke()
          ctx.lineWidth = 1
        }
        drawLine(macdArr.line, '#4dd0e1')
        drawLine(macdArr.signal, '#f5a623')
        ctx.fillStyle = '#4dd0e1'
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'
        ctx.fillText('MACD 12·26·9', 4, top + 1)
      }

      // ADX panel (ADX + +DI / -DI)
      const adxArr = !mini && ind.adx ? adx(data) : null
      if (adxArr && adxH > 0) {
        const top = priceH + (ind.vol ? 5 + volH + 2 : 2) + (rsiH ? rsiH + 2 : 0) + (macdH ? macdH + 2 : 0)
        const yA = (v: number) => top + ((100 - v) / 100) * adxH
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(plotW, top); ctx.stroke()
        for (const g of [20, 40]) {
          ctx.strokeStyle = 'rgba(255,255,255,0.07)'
          ctx.setLineDash([2, 3])
          ctx.beginPath(); ctx.moveTo(0, yA(g)); ctx.lineTo(plotW, yA(g)); ctx.stroke()
          ctx.setLineDash([])
        }
        const drawLineA = (arr: (number | null)[], color: string, lw = 1.2, dash: number[] = []) => {
          ctx.strokeStyle = color
          ctx.lineWidth = lw
          ctx.setLineDash(dash)
          ctx.beginPath()
          let st = false
          for (let i = start; i < end; i++) {
            const v = arr[i]; if (v == null) { st = false; continue }
            const x = xOf(i - start), y = yA(v)
            if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
          }
          ctx.stroke()
          ctx.setLineDash([])
          ctx.lineWidth = 1
        }
        drawLineA(adxArr.pdi, 'rgba(0,200,150,0.75)', 1, [3, 2])
        drawLineA(adxArr.mdi, 'rgba(255,77,94,0.75)', 1, [3, 2])
        drawLineA(adxArr.adx, '#a78bfa', 1.6)
        ctx.fillStyle = '#a78bfa'
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'
        ctx.fillText('ADX 14', 4, top + 1)
      }

      // ================= GHOST CANDLES (#ghostCtl — ANY timeframe) =================
      // ghostLower  (ghostTf < tf): inner bars fetched at ghostTf · shells = base
      // ghostHigher (ghostTf > tf): shells auto-aggregated from base · inner = base
      // Outer shells render HOLLOW (outline + faint fill); inner candles SOLID.
      const innerPerSlot = ghostLower ? tfMs / ghostTfMs : ghostHigher ? ghostTfMs / tfMs : 1
      // carve gate: inner-bar pitch (px) must fit bar + outline + solid gap
      const carveOk = ghostLower && cw > 0 && (cw / innerPerSlot) > 6
      let innerW = 0
      if (ghostEff && hoverSlot >= 0 && ghostLower) {
        const t0h = timeOfSlot(hoverSlot), t1h = t0h + tfMs
        const k = Math.max(1, lowerBoundTime(ghost, t1h) - lowerBoundTime(ghost, t0h))
        innerW = (cw / k) * 0.66
      } else if (ghostEff) {
        innerW = (cw / innerPerSlot) * 0.66
      }
      const la = clamp((innerW - 1.3) / 2.2, 0, 1)
      const gw = Math.max(1.2, Math.min(14, innerW))

      // hollow ghost candle painter (ghost = ALWAYS hollow: outline + faint fill)
      const drawHollow = (c: Candle, x: number, wBody: number, a: number, lw = 1.3) => {
        if (a <= 0.015) return
        const up = c.c >= c.o
        const col = up ? UP : DOWN
        const yH = yOf(c.h), yL = yOf(c.l)
        const yO = yOf(c.o), yC = yOf(c.c)
        const top = Math.min(yO, yC), bot = Math.max(yO, yC)
        const bx = x - wBody / 2
        ctx.strokeStyle = col
        ctx.globalAlpha = a
        ctx.lineWidth = lw
        if (top - yH > 0.3) { ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, top + 0.5); ctx.stroke() }
        if (yL - bot > 0.3) { ctx.beginPath(); ctx.moveTo(x, bot - 0.5); ctx.lineTo(x, yL); ctx.stroke() }
        ctx.globalAlpha = a * 0.14 // faint fill = hollow interior
        ctx.fillStyle = col
        ctx.fillRect(bx, top, wBody, Math.max(1, bot - top))
        ctx.globalAlpha = a
        ctx.strokeRect(bx, top, wBody, Math.max(1, bot - top))
        ctx.globalAlpha = 1
        ctx.lineWidth = 1
      }
      // solid candle painter (the LIVE FEED = ALWAYS solid)
      const drawSolid = (c: Candle, x: number, wBody: number, a: number, lw = 1) => {
        if (a <= 0.015) return
        const up = c.c >= c.o
        const col = up ? UP : DOWN
        const yH = yOf(c.h), yL = yOf(c.l)
        ctx.globalAlpha = a
        ctx.strokeStyle = col; ctx.fillStyle = col
        ctx.lineWidth = lw
        ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke()
        const yO = yOf(c.o), yC = yOf(c.c)
        ctx.fillRect(x - wBody / 2, Math.min(yO, yC), wBody, Math.max(1, Math.abs(yC - yO)))
        ctx.globalAlpha = 1
        ctx.lineWidth = 1
      }
      // CARVE (round-8): when the OUTER candle is SOLID (live feed) and a
      // hollow ghost bar overlaps it, erase the solid fill under the ghost
      // body first — the solid candle gets a visible HOLLOW SPACE where the
      // ghost sits, so the ghost outline reads on ANY colour combination
      // (same-colour solid + hollow outline used to disappear completely).
      // Adaptive: only carve when the ghost bar is wide enough for the
      // hollow to actually read (gw >= 4px) — with many tiny inner bars
      // (e.g. 15×1m in a 15m shell) per-bar carves would merge and wipe
      // the whole solid body, so those stay as plain overlays instead.
      const carveUnderGhost = (c: Candle, x: number, wBody: number) => {
        const yO = yOf(c.o), yC = yOf(c.c)
        const top = Math.min(yO, yC), bot = Math.max(yO, yC)
        ctx.save()
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = 'rgba(0,0,0,1)'
        ctx.fillRect(x - wBody / 2 - 1.0, top - 1.0, wBody + 2.0, Math.max(2, bot - top) + 2.0)
        ctx.restore()
      }

      if (ghostEff && la > 0.02 && ghostLower && ind.vol && volH > 0) {
        // ghost volume micro-bars inside the volume histogram (inner tf)
        let vMax1 = 0
        const tA = timeOfSlot(0), tB = timeOfSlot(slots - 1) + tfMs
        for (let g = lowerBoundTime(ghost, tA); g < lowerBoundTime(ghost, tB); g++) if (ghost[g].v > vMax1) vMax1 = ghost[g].v
        for (let i = 0; i < slots; i++) {
          const t0 = timeOfSlot(i), t1 = t0 + tfMs
          const lo = lowerBoundTime(ghost, t0), hi = lowerBoundTime(ghost, t1)
          for (let g = lo; g < hi; g++) {
            const bar = ghost[g]
            const x = xOfTime(bar.t)
            if (x < -4 || x > plotW + 4) continue
            const a = (g === gi ? 0.85 : 0.38) * la
            if (a <= 0.015) continue
            const vh = Math.max(1, (bar.v / Math.max(1, vMax1)) * volH)
            ctx.globalAlpha = a
            ctx.fillStyle = bar.c >= bar.o ? UP : DOWN
            ctx.fillRect(x - gw / 2, volBot - vh, gw, vh)
          }
        }
        ctx.globalAlpha = 1
      }

      // ================= CANDLES — v4 rule: LIVE = SOLID · GHOST = HOLLOW =================
      // ghostHigher: hollow ghost shells OUTSIDE, solid live candles inside
      // ghostLower:  solid live candles, hollow ghost candles INSIDE them
      if (chartKind === 'candles') {
        if (ghostEff) {
          if (ghostLower) {
            // 1) live feed candles — SOLID (full alpha, the real data)
            vis.forEach((c, i) => {
              if (!c) return
              drawSolid(c, xOf(i), bodyW, i === hoverSlot ? 1 : 0.95, 1)
            })
            // 2) ghost candles — HOLLOW, drawn over their parent slot (inside view)
            const gAlpha = settings.ghostStyle === 'fade' ? la : Math.max(0.55, la)
            if (la > 0.02) {
              for (let i = 0; i < slots; i++) {
                const emph = i === hoverSlot
                const t0 = timeOfSlot(i), t1 = t0 + tfMs
                const lo = lowerBoundTime(ghost, Math.max(t0, ghost[0].t)), hi = lowerBoundTime(ghost, t1)
                for (let g2 = lo; g2 < hi; g2++) {
                  const bar = ghost[g2]
                  const x = xOfTime(bar.t)
                  if (x < -6 || x > plotW + 6) continue
                  const isInner = g2 === gi
                  // carve the SOLID live candle under this ghost body so the
                  // hollow outline is always visible over the solid fill.
                  // Adaptive: carve only when the inner-bar pitch is wide
                  // enough that carves can't merge and wipe the whole solid
                  // body (bar = 0.66·pitch; carve needs pitch > ~6px).
                  if (carveOk) carveUnderGhost(bar, x, gw)
                  drawHollow(bar, x, gw, isInner ? 1 : emph ? Math.max(0.9, gAlpha) : gAlpha, isInner ? 1.7 : 1.2)
                }
              }
              ctx.globalAlpha = 1
            }
          } else {
            // ghost tf > chart tf — hollow shells (outside) + solid live candles inside
            const tA = timeOfSlot(0), tB = timeOfSlot(slots - 1) + tfMs
            const shellW = Math.max(2, Math.min(26, (ghostTfMs / tfMs) * cw * 0.68))
            for (const sh of ghostShells) {
              if (sh.t + ghostTfMs < tA || sh.t > tB) continue
              drawHollow(sh, xOfTime(sh.t), shellW, sh.t === hoverShellT ? 1 : settings.ghostStyle === 'fade' ? la : 0.85, sh.t === hoverShellT ? 2 : 1.4)
            }
            const floorA = settings.ghostStyle === 'fade' ? la : Math.max(0.55, la)
            if (la > 0.02) {
              const innerHoverT = ghost[gi]?.t ?? -1
              vis.forEach((c, i) => {
                if (!c) return
                const emph = i === hoverSlot
                const a = c.t === innerHoverT ? 1 : emph ? 0.95 : floorA
                drawSolid(c, xOf(i), Math.min(gw, bodyW), a)
              })
              ctx.globalAlpha = 1
            }
          }
        } else {
          // plain candles (or 1m chart / ghost off) — live feed = SOLID
          vis.forEach((c, i) => {
            if (!c) return
            drawSolid(c, xOf(i), bodyW, 1, 1)
          })
        }
      } else {
        // line / area series
        ctx.beginPath()
        let started = false
        vis.forEach((c, i) => {
          if (!c) return
          const x = xOf(i), y = yOf(c.c)
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = '#f5a623'
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.lineWidth = 1
        if (chartKind === 'area' && started) {
          const lastReal = Math.min(slots - 1, data.length - 1 - start)
          const grad = ctx.createLinearGradient(0, 0, 0, priceH)
          grad.addColorStop(0, 'rgba(245,166,35,0.22)')
          grad.addColorStop(1, 'rgba(245,166,35,0)')
          ctx.lineTo(xOf(lastReal), priceH)
          ctx.lineTo(xOf(Math.max(0, data.length - 1 - start < slots ? data.length - 1 - start : 0)), priceH)
          ctx.closePath()
          ctx.fillStyle = grad
          ctx.fill()
        }
      }

      // hovered slot highlight box (amber) — shell-aware (ghost higher = box the shell)
      if (!mini && hoverSlot >= 0 && (ghostEff || tfMs > 60_000) && (ghostEff ? (ghostLower ? !!vis[hoverSlot] : hoverShellT >= 0) : !!vis[hoverSlot])) {
        let bx0: number, bx1: number, byH: number, byL: number
        if (ghostEff && ghostHigher) {
          const sh = ghostShells.find(s => s.t === hoverShellT)
          if (!sh) return
          bx0 = xOfTime(hoverShellT) - (Math.min(26, (ghostTfMs / tfMs) * cw * 0.68)) / 2
          bx1 = bx0 + Math.min(26, (ghostTfMs / tfMs) * cw * 0.68)
          byH = sh.h; byL = sh.l
        } else {
          const k = vis[hoverSlot]!
          bx0 = xOf(hoverSlot) - cw / 2; bx1 = xOf(hoverSlot) + cw / 2
          byH = k.h; byL = k.l
        }
        const ins = (bx1 - bx0) * 0.17
        ctx.strokeStyle = '#e0a63f'
        ctx.lineWidth = 1.4
        ctx.globalAlpha = 0.9
        ctx.strokeRect(bx0 + ins - 5, yOf(byH) - 5, (bx1 - bx0 - 2 * ins) + 10, (yOf(byL) - yOf(byH)) + 10)
        ctx.globalAlpha = 1
        ctx.lineWidth = 1
        // ghost OFF hover: amber column + emphasized inner 1m candle
        if (!ghostEff && gi >= 0 && ghost.length > 0) {
          const ib = ghost[gi]
          if (ib.t >= t0Slot - 60_000 && ib.t <= timeOfSlot(slots - 1) + tfMs) {
            const cxm = xOfTime(ib.t)
            ctx.fillStyle = 'rgba(224,166,63,0.055)'
            ctx.fillRect(cxm - cw / (2 * Math.max(1, tfMs / 60_000)), 0, cw / Math.max(1, tfMs / 60_000), priceH)
            const yH = yOf(ib.h), yL = yOf(ib.l), yO = yOf(ib.o), yC = yOf(ib.c)
            const t2 = Math.min(yO, yC), b2 = Math.max(yO, yC)
            const wb = Math.max(3, Math.min(gw * 1.3, (cw / Math.max(1, tfMs / 60_000)) * 0.7))
            ctx.strokeStyle = '#e0a63f'
            ctx.globalAlpha = 0.95
            ctx.lineWidth = 1.5
            if (t2 - yH > 0.3) { ctx.beginPath(); ctx.moveTo(cxm, yH); ctx.lineTo(cxm, t2 + 0.5); ctx.stroke() }
            if (yL - b2 > 0.3) { ctx.beginPath(); ctx.moveTo(cxm, b2 - 0.5); ctx.lineTo(cxm, yL); ctx.stroke() }
            ctx.strokeRect(cxm - wb / 2, t2, wb, Math.max(1, b2 - t2))
            ctx.globalAlpha = 1
            ctx.lineWidth = 1
          }
        }
      }

      // overlay indicator lines
      const drawSeries = (arr: (number | null)[], color: string, dash: number[] = []) => {
        ctx.setLineDash(dash)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.1
        ctx.beginPath()
        let st = false
        for (let i = start; i < end; i++) {
          const v = arr[i]; if (v == null) { st = false; continue }
          const x = xOf(i - start), y = yOf(v)
          if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineWidth = 1
      }
      if (bb) {
        ctx.beginPath()
        let st = false
        for (let i = start; i < end; i++) {
          const v = bb.up[i]; if (v == null) { st = false; continue }
          const x = xOf(i - start), y = yOf(v)
          if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
        }
        for (let i = end - 1; i >= start; i--) {
          const v = bb.lo[i]; if (v == null) continue
          ctx.lineTo(xOf(i - start), yOf(v))
        }
        ctx.closePath()
        ctx.fillStyle = 'rgba(139,148,158,0.07)'
        ctx.fill()
        drawSeries(bb.mid, 'rgba(139,148,158,0.7)', [4, 3])
        drawSeries(bb.up, 'rgba(139,148,158,0.4)')
        drawSeries(bb.lo, 'rgba(139,148,158,0.4)')
      }
      if (s20) drawSeries(s20, 'rgba(77,208,225,0.85)')
      if (s50) drawSeries(s50, 'rgba(180,140,232,0.85)')
      if (e9) drawSeries(e9, '#ffd166')
      if (e21) drawSeries(e21, '#e06c9f')
      if (vw) drawSeries(vw, 'rgba(77,208,225,0.75)', [5, 3])

      // ================= position / level markers =================
      // entry (open position) · draggable SL / target lines.
      // A marker being dragged overrides its price from the live drag ref.
      // Round-10 semantics:
      //   · right price-scale tag shows ONLY the price VALUE
      //   · LEFT of the marker line: label @price (+ PnL ₹/% for entry)
      //   · entry line carries an EXIT button (click = close the position)
      //   · markers exist ONLY while the position is open (parent filters)
      // Left chips are laid out in TWO passes: pass 1 computes the desired
      // (line-anchored) position of every chip, pass 2 resolves collisions —
      // chips that fall inside the legend/toolbar band or overlap another
      // chip slide down to the next free slot. Deterministic, no overprint.
      exitBtnRef.current = null
      const CH = 15 // chip height
      const topGuard = 60 // legend rows + DOM toolbar row (empirical: rows can reach ~48px in short panes)
      if (typeof window !== 'undefined' && !(window as { __chipsV3?: boolean }).__chipsV3) {
        (window as { __chipsV3?: boolean }).__chipsV3 = true
        console.log('[chart] chip-layout v3 (two-pass collision resolve)')
      }
      interface ChipLayout { m: ChartMarker; y: number; cy: number; leftTxt: string; tw: number; chipW: number; hasExit: boolean; draggable: boolean }
      const chips: ChipLayout[] = []
      for (const m0 of markers) {
        const m = markerDragRef.current && markerDragRef.current.id === m0.id
          ? { ...m0, price: markerDragRef.current.price }
          : m0
        const y = yOf(m.price)
        if (y < -8 || y > priceH + 8) continue
        const leftTxt = `${m.label} @${m.price.toFixed(2)}${m.sub ? ` ${m.sub}` : ''}`
        ctx.font = 'bold 9px ui-monospace, monospace'
        const tw = ctx.measureText(leftTxt).width
        const hasExit = m.kind === 'entry' && !!onExitPosition
        chips.push({
          m, y, cy: y - CH / 2, leftTxt, tw,
          chipW: tw + (hasExit ? 46 : 10),
          hasExit, draggable: !!m.id && (m.kind === 'sl' || m.kind === 'target'),
        })
      }
      // resolve chip vertical positions (all anchor at the same left x, so a
      // vertical overlap check is sufficient)
      const taken: { y0: number; y1: number }[] = []
      for (const c of chips) {
        let cy = c.y - CH / 2
        if (cy < topGuard) cy = c.y + 3 // below the line (legend band)
        const clashes = (v: number) => taken.some(t => v < t.y1 + 1 && v + CH > t.y0 - 1)
        if (cy < topGuard || clashes(cy)) {
          cy = Math.max(topGuard, cy)
          while (clashes(cy)) cy += CH + 2
          if (cy > priceH - CH - 2) {
            // plot too short for every slot — scan upward from the bottom edge
            // for a free slot; never send the chip back into the legend band
            let fy = priceH - CH - 2
            while (fy > topGuard && clashes(fy)) fy -= CH + 2
            cy = Math.max(topGuard, fy)
          }
        }
        taken.push({ y0: cy, y1: cy + CH })
        c.cy = cy
      }
      // draw pass
      for (const c of chips) {
        const { m, y, cy, leftTxt, tw, chipW } = c
        ctx.setLineDash(m.kind === 'entry' ? [4, 3] : [6, 3])
        ctx.strokeStyle = m.color
        ctx.lineWidth = c.draggable ? 1.2 : 1
        ctx.beginPath(); ctx.moveTo(colW, y); ctx.lineTo(plotW, y); ctx.stroke()
        ctx.setLineDash([])
        ctx.lineWidth = 1
        // right axis tag — price VALUE only (no s-sell / close wording)
        ctx.fillStyle = m.color
        ctx.fillRect(plotW + 2, y - 8, axisW - 4, 16)
        ctx.fillStyle = '#0b0e11'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = 'bold 9px ui-monospace, monospace'
        ctx.fillText(m.price.toFixed(2), plotW + axisW / 2, y)
        // left chip — dark backing + colored border + label (+ EXIT)
        ctx.fillStyle = 'rgba(11,14,17,0.82)'
        ctx.fillRect(colW + 4, cy, chipW, CH)
        ctx.strokeStyle = m.color
        ctx.globalAlpha = 0.7
        ctx.strokeRect(colW + 4.5, cy + 0.5, chipW - 1, CH - 1)
        ctx.globalAlpha = 1
        ctx.fillStyle = m.color
        ctx.textAlign = 'left'
        ctx.fillText(leftTxt, colW + 9, cy + CH / 2 + 0.5)
        // EXIT button on the entry chip (click = close the position) — one
        // per chart even when several accounts hold the same symbol
        if (c.hasExit && !exitBtnRef.current) {
          const bx = colW + 4 + tw + 12
          const bw = 34, bh = 13
          const by = cy + (CH - bh) / 2
          ctx.fillStyle = '#ff4d5e'
          ctx.fillRect(bx, by, bw, bh)
          ctx.fillStyle = '#ffffff'
          ctx.font = 'bold 8px ui-monospace, monospace'
          ctx.textAlign = 'center'
          ctx.fillText('EXIT', bx + bw / 2, by + bh / 2 + 0.5)
          ctx.font = 'bold 9px ui-monospace, monospace'
          exitBtnRef.current = { x: bx, y: by, w: bw, h: bh }
        }
        ctx.font = '10px ui-monospace, monospace'
        ctx.textBaseline = 'alphabetic'
        // draggable grip at the left edge (three bars)
        if (c.draggable) {
          ctx.fillStyle = m.color
          ctx.globalAlpha = 0.9
          ctx.fillRect(2, y - 5, 9, 2)
          ctx.fillRect(2, y - 1, 9, 2)
          ctx.fillRect(2, y + 3, 9, 2)
          ctx.globalAlpha = 1
          ctx.fillStyle = m.kind === 'target' ? UP : DOWN
          ctx.font = 'bold 8px ui-monospace, monospace'
          ctx.textAlign = 'left'
          ctx.fillText(m.kind === 'target' ? 'TGT' : 'SL', 13, y + 3)
          ctx.font = '10px ui-monospace, monospace'
        }
      }

      // last price line + axis tag
      const lastC = data[data.length - 1]
      {
        const y = yOf(lastC.c)
        if (y >= 0 && y <= priceH) {
          const up = lastC.c >= lastC.o
          ctx.setLineDash([2, 3])
          ctx.strokeStyle = up ? 'rgba(0,200,150,0.55)' : 'rgba(255,77,94,0.55)'
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = up ? UP : DOWN
          ctx.fillRect(plotW + 2, y - 8, axisW - 4, 16)
          ctx.fillStyle = '#0b0e11'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(lastC.c.toFixed(2), plotW + axisW / 2, y)
        }
      }

      // scales baseline — dashed amber line, draggable / set-by-click
      if (!mini && (secondaries.includes('pct') || secondaries.includes('inv') || secondaries.includes('pts') || primary !== 'price')) {
        const yBase = yOf(baseline)
        drawMetaRef.current = { yBase, baseline }
        if (yBase >= 0 && yBase <= priceH) {
          ctx.setLineDash([5, 4])
          ctx.strokeStyle = 'rgba(224,166,63,0.75)'
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(colW, yBase); ctx.lineTo(plotW, yBase); ctx.stroke()
          ctx.setLineDash([])
          ctx.lineWidth = 1
          ctx.fillStyle = 'rgba(224,166,63,0.9)'
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
          ctx.fillText(primary === 'price' ? '0%' : '0', plotW - 4, yBase - 6)
        }
      }

      // ================= #tools — drawings render =================
      const cr = (v: number) => Math.round(v) + 0.5
      const seg = (x1: number, y1: number, x2: number, y2: number) => {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
      }

      // ================= BREAKS — session / hour / prev-day range =================
      // Per-chart vertical time breaks + range levels (settings.breaks).
      const breaksCfg = settings.breaks ?? { session: false, hour: false, range: false }
      if (!mini && (breaksCfg.session || breaksCfg.hour)) {
        const tStart = timeOfSlot(0), tEnd = timeOfSlot(slots - 1) + tfMs
        const dayStep = 86400_000
        for (let day = istMs(tStart, 0) - dayStep; day <= tEnd + dayStep; day += dayStep) {
          const openT = day + SESSION_OPEN_MIN * 60_000
          const closeT = day + SESSION_CLOSE_MIN * 60_000
          if (breaksCfg.session && closeT > tStart && openT < tEnd) {
            // faint session band + 09:15 / 15:30 divider lines
            const x0 = clamp(xOfTime(Math.max(openT, tStart)), 0, plotW)
            const x1 = clamp(xOfTime(Math.min(closeT, tEnd)), 0, plotW)
            ctx.fillStyle = 'rgba(224,166,63,0.035)'
            ctx.fillRect(x0, 0, x1 - x0, priceH)
            for (const [bt, lbl] of [[openT, '09:15'], [closeT, '15:30']] as [number, string][]) {
              if (bt < tStart || bt > tEnd) continue
              const x = cr(xOfTime(bt))
              ctx.strokeStyle = 'rgba(224,166,63,0.5)'
              ctx.setLineDash([5, 4])
              ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, priceH); ctx.stroke()
              ctx.setLineDash([])
              ctx.fillStyle = 'rgba(224,166,63,0.85)'
              ctx.textAlign = 'right'; ctx.textBaseline = 'top'
              ctx.fillText(lbl, x - 3, 2)
            }
          }
          if (breaksCfg.hour) {
            for (let m = SESSION_OPEN_MIN + 60; m < SESSION_CLOSE_MIN; m += 60) {
              const bt = day + m * 60_000
              if (bt < tStart || bt > tEnd) continue
              const x = cr(xOfTime(bt))
              ctx.strokeStyle = 'rgba(139,148,158,0.2)'
              ctx.setLineDash([2, 5])
              ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, priceH); ctx.stroke()
              ctx.setLineDash([])
              ctx.fillStyle = 'rgba(139,148,158,0.45)'
              ctx.textAlign = 'right'; ctx.textBaseline = 'top'
              ctx.fillText(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, x - 3, 2)
            }
          }
        }
      }
      if (!mini && breaksCfg.range && data.length > 2) {
        // previous trading day high/low (PDH/PDL) + today's break markers
        let pdKey: string | null = null
        let pdH = -Infinity, pdL = Infinity
        for (let i = data.length - 1; i >= 0; i--) {
          const k = dayKey(data[i].t)
          if (k === todayKey) continue
          if (!pdKey) pdKey = k
          if (k !== pdKey) break
          if (data[i].h > pdH) pdH = data[i].h
          if (data[i].l < pdL) pdL = data[i].l
        }
        if (pdH > -Infinity && pdL < Infinity) {
          for (const [lvl, lbl, col] of [[pdH, 'PDH', UP], [pdL, 'PDL', DOWN]] as [number, string, string][]) {
            const y = cr(yOf(lvl))
            if (y < 0 || y > priceH) continue
            ctx.strokeStyle = col
            ctx.globalAlpha = 0.38
            ctx.setLineDash([2, 4])
            ctx.beginPath(); ctx.moveTo(colW, y); ctx.lineTo(plotW, y); ctx.stroke()
            ctx.setLineDash([])
            ctx.globalAlpha = 1
            ctx.fillStyle = col
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
            ctx.fillText(`${lbl} ${lvl.toFixed(2)}`, colW + 4, y - 1)
            for (let i = 0; i < data.length; i++) {
              if (dayKey(data[i].t) !== todayKey) continue
              const brk = lbl === 'PDH'
                ? data[i].h > lvl && (i === 0 || data[i - 1].h <= lvl)
                : data[i].l < lvl && (i === 0 || data[i - 1].l >= lvl)
              if (!brk) continue
              const x = xOfTime(data[i].t)
              if (x < 0 || x > plotW) continue
              const yy = lbl === 'PDH' ? yOf(data[i].h) : yOf(data[i].l)
              ctx.fillStyle = col
              ctx.beginPath()
              if (lbl === 'PDH') { ctx.moveTo(x, yy - 3); ctx.lineTo(x - 4, yy - 10); ctx.lineTo(x + 4, yy - 10) }
              else { ctx.moveTo(x, yy + 3); ctx.lineTo(x - 4, yy + 10); ctx.lineTo(x + 4, yy + 10) }
              ctx.closePath(); ctx.fill()
            }
          }
        }
      }
      // computeVP — fixed-range volume profile (26 bins, POC / VAH / VAL @70%)
      const computeVP = (t0: number, t1: number) => {
        const g0 = Math.max(0, lowerBoundTime(data, t0)), g1 = Math.min(data.length - 1, lowerBoundTime(data, t1))
        if (g1 < g0) return null
        let lo = Infinity, hi = -Infinity, tv = 0
        for (let g = g0; g <= g1; g++) { const b = data[g]; if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; tv += b.v }
        if (tv <= 0 || hi <= lo) return null
        const N = 26, bins = new Array(N).fill(0), bh = (hi - lo) / N
        for (let g = g0; g <= g1; g++) {
          const b = data[g]
          const bi = clamp(Math.floor(((b.h + b.l + b.c) / 3 - lo) / bh), 0, N - 1)
          bins[bi] += b.v
        }
        let poc = 0
        for (let i = 1; i < N; i++) if (bins[i] > bins[poc]) poc = i
        let cum = bins[poc], a = poc, b2 = poc
        while (cum < tv * 0.7 && (a > 0 || b2 < N - 1)) {
          const va = a > 0 ? bins[a - 1] : -1, vb = b2 < N - 1 ? bins[b2 + 1] : -1
          if (vb >= va) { b2++; cum += bins[b2] } else { a--; cum += bins[a] }
        }
        return { lo, hi, bins, N, poc, a, b2, tv }
      }
      // computeBSV — buy/sell split per price bin (bf = (c-l)/(h-l))
      const computeBSV = (t0: number, t1: number) => {
        const g0 = Math.max(0, lowerBoundTime(data, t0)), g1 = Math.min(data.length - 1, lowerBoundTime(data, t1))
        if (g1 < g0) return null
        let lo = Infinity, hi = -Infinity, tv = 0
        for (let g = g0; g <= g1; g++) { const b = data[g]; if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; tv += b.v }
        if (tv <= 0 || hi <= lo) return null
        const N = 28, buy = new Array(N).fill(0), sell = new Array(N).fill(0), bh = (hi - lo) / N
        for (let g = g0; g <= g1; g++) {
          const b = data[g], r = b.h - b.l
          const bf = r > 0 ? (b.c - b.l) / r : 0.5
          const bi = clamp(Math.floor(((b.h + b.l + b.c) / 3 - lo) / bh), 0, N - 1)
          buy[bi] += b.v * bf
          sell[bi] += b.v * (1 - bf)
        }
        let bt = 0, st = 0
        for (let i = 0; i < N; i++) { bt += buy[i]; st += sell[i] }
        return { lo, hi, N, buy, sell, bt, st }
      }

      const renderDrawing = (d: Drawing, selected: boolean) => {
        const P = d.pts
        if (!P.length) return
        const X0 = xOfTime(P[0].t), Y0 = yOf(P[0].p)
        const X1 = P.length > 1 ? xOfTime(P[1].t) : X0
        const Y1 = P.length > 1 ? yOf(P[1].p) : Y0
        const col = selected ? '#ffffff' : AMBER_TOOLS.has(d.type) ? DCOL.fib : DCOL.def
        ctx.save()
        ctx.strokeStyle = col
        ctx.fillStyle = col
        ctx.lineWidth = selected ? 1.6 : 1.1
        ctx.font = '9px ui-monospace, monospace'
        switch (d.type) {
          case 'trend':
            seg(cr(X0), cr(Y0), cr(X1), cr(Y1))
            break
          case 'ray': {
            // extend from P0 through P1 to the plot edge
            const dx = X1 - X0, dy = Y1 - Y0
            const k = dx !== 0 ? (dx > 0 ? (plotW - X0) / dx : -X0 / dx) : 1e9
            const ke = dx !== 0 ? Math.max(0, k) : 1e9
            seg(cr(X0), cr(Y0), cr(X0 + dx * ke), cr(Y0 + dy * ke))
            break
          }
          case 'hline':
            ctx.setLineDash([2, 3])
            seg(0, cr(Y0), plotW, cr(Y0))
            ctx.setLineDash([])
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
            ctx.fillText(P[0].p.toFixed(2), 4, Y0 - 2)
            break
          case 'rect': {
            const x0 = Math.min(X0, X1), x1 = Math.max(X0, X1)
            const y0 = Math.min(Y0, Y1), y1 = Math.max(Y0, Y1)
            ctx.globalAlpha = 0.08
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
            ctx.globalAlpha = 1
            ctx.strokeRect(cr(x0), cr(y0), cr(x1) - cr(x0), cr(y1) - cr(y0))
            break
          }
          case 'fib': {
            const xa = Math.min(X0, X1), xb = Math.max(X0, X1)
            const p0 = P[0].p, p1 = P[1].p
            seg(cr(xa), cr(Y0), cr(xb), cr(Y1)) // the swing line
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
            for (const lv of FIBL) {
              const pr = p1 + (p0 - p1) * lv
              const y = cr(yOf(pr))
              ctx.globalAlpha = lv === 0 || lv === 1 ? 0.95 : 0.7
              ctx.setLineDash(lv === 0.5 ? [] : [4, 3])
              seg(xa - 4, y, xb + 4, y)
              ctx.setLineDash([])
              ctx.fillText(`${lv}  ${pr.toFixed(2)}`, xa + 4, y - 2)
            }
            ctx.globalAlpha = 1
            break
          }
          case 'vline':
            ctx.setLineDash([2, 3])
            seg(cr(X0), 0, cr(X0), priceH)
            ctx.setLineDash([])
            ctx.textAlign = 'right'; ctx.textBaseline = 'top'
            ctx.fillText(fmtAxisTime(P[0].t, tf, true), X0 - 3, 2)
            break
          case 'hray':
            seg(cr(X0), cr(Y0), plotW, cr(Y0))
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
            ctx.fillText(P[0].p.toFixed(2), 4, Y0 - 2)
            break
          case 'arrow': {
            seg(cr(X0), cr(Y0), cr(X1), cr(Y1))
            const angA = Math.atan2(Y1 - Y0, X1 - X0)
            ctx.beginPath()
            ctx.moveTo(X1, Y1)
            ctx.lineTo(X1 - 10 * Math.cos(angA - Math.PI / 7), Y1 - 10 * Math.sin(angA - Math.PI / 7))
            ctx.lineTo(X1 - 10 * Math.cos(angA + Math.PI / 7), Y1 - 10 * Math.sin(angA + Math.PI / 7))
            ctx.closePath()
            ctx.fill()
            break
          }
          case 'ellipse': {
            const x0 = Math.min(X0, X1), x1 = Math.max(X0, X1)
            const y0 = Math.min(Y0, Y1), y1 = Math.max(Y0, Y1)
            ctx.globalAlpha = 0.08
            ctx.beginPath()
            ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2)
            ctx.fill()
            ctx.globalAlpha = 1
            ctx.stroke()
            break
          }
          case 'circle': {
            // P1 = center · radius = |P2 - P1| — stays a perfect circle at
            // screen scale (radius measured in pixels, not price units)
            const r = Math.max(3, Math.hypot(X1 - X0, Y1 - Y0))
            ctx.globalAlpha = 0.08
            ctx.beginPath()
            ctx.arc(X0, Y0, r, 0, Math.PI * 2)
            ctx.fill()
            ctx.globalAlpha = 1
            ctx.stroke()
            break
          }
          case 'fibext': {
            const xa = Math.min(X0, X1), xb = Math.max(X0, X1)
            const p0 = P[0].p, p1 = P[1].p
            seg(cr(xa), cr(Y0), cr(xb), cr(Y1))
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
            for (const lv of FIB_EXT) {
              const pr = p1 + (p0 - p1) * lv
              const y = cr(yOf(pr))
              if (y < -4 || y > priceH + 4) continue
              ctx.globalAlpha = lv === 1 ? 0.95 : 0.6
              ctx.setLineDash(lv === 1 ? [] : [4, 3])
              seg(xa - 4, y, xb + 4, y)
              ctx.setLineDash([])
              ctx.fillText(`${lv}  ${pr.toFixed(2)}`, xa + 4, y - 2)
            }
            ctx.globalAlpha = 1
            break
          }
          case 'fibtz': {
            // vertical fib time-zone bars from P0, spaced by the P0→P1 span × fib seq
            const dt = P[1].t - P[0].t
            for (const f of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
              const x = cr(xOfTime(P[0].t + dt * f))
              if (x < 0 || x > plotW) continue
              ctx.strokeStyle = selected ? '#ffffff' : 'rgba(224,166,63,0.55)'
              ctx.setLineDash([3, 3])
              seg(x, 0, x, priceH)
              ctx.setLineDash([])
              ctx.fillStyle = selected ? '#ffffff' : 'rgba(224,166,63,0.8)'
              ctx.textAlign = 'left'; ctx.textBaseline = 'top'
              ctx.fillText(String(f), x + 2, 2)
            }
            seg(cr(X0), cr(Y0), cr(X1), cr(Y1))
            break
          }
          case 'fan': {
            // rays from P0 through fib-scaled projections of P1
            const dxT = P[1].t - P[0].t
            const dp = P[1].p - P[0].p
            seg(cr(X0), cr(Y0), cr(X1), cr(Y1))
            for (const lv of [0.382, 0.5, 0.618, 0.786, 1.618]) {
              const x2 = xOfTime(P[0].t + dxT)
              const y2 = yOf(P[0].p + dp * lv)
              const k = x2 !== X0 ? (plotW - X0) / (x2 - X0) : 1e9
              const ke = Math.max(1, Math.min(20, k))
              ctx.globalAlpha = 0.5
              seg(cr(X0), cr(Y0), cr(X0 + (x2 - X0) * ke), cr(Y0 + (y2 - Y0) * ke))
              ctx.globalAlpha = 1
              ctx.fillStyle = selected ? '#ffffff' : 'rgba(224,166,63,0.7)'
              ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
              ctx.fillText(String(lv), Math.min(plotW - 24, Math.max(2, x2 + 2)), y2 - 2)
            }
            break
          }
          case 'pricedate': {
            const x0 = Math.min(X0, X1), x1 = Math.max(X0, X1)
            const ya = cr(Y0), yb = cr(Y1)
            ctx.setLineDash([3, 3])
            ctx.strokeRect(cr(x0), Math.min(ya, yb), cr(x1) - cr(x0), Math.abs(yb - ya))
            ctx.setLineDash([])
            const dp2 = P[1].p - P[0].p
            const pct2 = P[0].p ? (dp2 / P[0].p) * 100 : 0
            const barsN = Math.round(Math.abs(P[1].t - P[0].t) / (geoRef.current.tfMs || 1))
            const mins = Math.round(Math.abs(P[1].t - P[0].t) / 60000)
            const dur = mins >= 1440 ? `${(mins / 1440).toFixed(1)}d` : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
            ctx.font = '600 9px ui-monospace, monospace'
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
            ctx.fillText(`${dp2 >= 0 ? '+' : ''}${dp2.toFixed(2)} (${pct2 >= 0 ? '+' : ''}${pct2.toFixed(2)}%) · ${barsN} bars · ${dur}`, (x0 + x1) / 2, Math.min(ya, yb) - 3)
            ctx.font = '9px ui-monospace, monospace'
            break
          }
          case 'forecast': {
            // projected Δ box after P1 (same price delta + same time span)
            const dpF = P[1].p - P[0].p
            const dtF = P[1].t - P[0].t
            const y1F = yOf(P[1].p)
            const py0 = yOf(P[1].p + dpF)
            const px0 = X1
            const px1 = xOfTime(P[1].t + dtF)
            ctx.fillStyle = 'rgba(91,176,216,0.1)'
            ctx.fillRect(px0, Math.min(y1F, py0), Math.max(4, px1 - px0), Math.abs(py0 - y1F))
            ctx.strokeStyle = 'rgba(91,176,216,0.55)'
            ctx.setLineDash([4, 3])
            ctx.strokeRect(cr(px0), Math.min(y1F, py0), Math.max(4, cr(px1) - cr(px0)), Math.abs(py0 - y1F))
            ctx.setLineDash([])
            const pctF = P[0].p ? (dpF / P[0].p) * 100 : 0
            ctx.fillStyle = selected ? '#ffffff' : 'rgba(91,176,216,0.95)'
            ctx.font = '600 9px ui-monospace, monospace'
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
            ctx.fillText(`fcst ${dpF >= 0 ? '+' : ''}${dpF.toFixed(2)} (${pctF >= 0 ? '+' : ''}${pctF.toFixed(2)}%)`, px0 + 2, Math.min(y1F, py0) - 3)
            ctx.font = '9px ui-monospace, monospace'
            break
          }
          case 'text': {
            const lines = (d.text || 'Text').split('\n')
            ctx.font = '10px ui-monospace, monospace'
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
            ctx.fillStyle = selected ? '#ffffff' : '#ffd166'
            lines.forEach((ln, i) => ctx.fillText(ln, X0 + 2, Y0 + i * 12 - (lines.length - 1) * 6))
            break
          }
          case 'pricenote': {
            const txt = d.text || ''
            ctx.font = 'bold 9px ui-monospace, monospace'
            const label = `${P[0].p.toFixed(2)}${txt ? ' · ' + txt : ''}`
            const w = ctx.measureText(label).width + 10
            ctx.fillStyle = selected ? '#ffffff' : '#e0a63f'
            ctx.fillRect(X0, Y0 - 9, w, 16)
            ctx.fillStyle = '#0b0e11'
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
            ctx.fillText(label, X0 + 5, Y0 - 1)
            ctx.strokeStyle = '#e0a63f'
            seg(cr(X0 + 1), cr(Y0 + 7), cr(X0 + 1), cr(Y0 + 14))
            ctx.font = '9px ui-monospace, monospace'
            break
          }
          case 'pin': {
            ctx.fillStyle = selected ? '#ffffff' : '#e06c9f'
            ctx.beginPath(); ctx.arc(X0, Y0, 3.5, 0, Math.PI * 2); ctx.fill()
            ctx.beginPath(); ctx.moveTo(X0, Y0 + 4); ctx.lineTo(X0 + 12, Y0 + 8); ctx.lineTo(X0, Y0 + 12); ctx.closePath(); ctx.fill()
            if (d.text) {
              ctx.fillStyle = '#e06c9f'
              ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
              ctx.fillText(d.text, X0 + 15, Y0 + 8)
            }
            break
          }
          case 'comment':
          case 'callout': {
            if (d.type === 'comment') {
              ctx.setLineDash([3, 3])
              seg(cr(X0), cr(Y0), cr(X1), cr(Y1))
              ctx.setLineDash([])
              ctx.beginPath(); ctx.arc(X0, Y0, 2.5, 0, Math.PI * 2); ctx.fill()
            } else {
              seg(cr(X0), cr(Y0), cr(X1), cr(Y1))
              const angC = Math.atan2(Y0 - Y1, X0 - X1)
              ctx.beginPath()
              ctx.moveTo(X0, Y0)
              ctx.lineTo(X0 + 9 * Math.cos(angC - Math.PI / 7), Y0 + 9 * Math.sin(angC - Math.PI / 7))
              ctx.lineTo(X0 + 9 * Math.cos(angC + Math.PI / 7), Y0 + 9 * Math.sin(angC + Math.PI / 7))
              ctx.closePath()
              ctx.fill()
            }
            const txt = (d.text || 'note').split('\n')
            let bw = 0
            for (const ln of txt) bw = Math.max(bw, ctx.measureText(ln).width)
            const bh = txt.length * 12 + 6
            ctx.fillStyle = selected ? 'rgba(255,255,255,0.9)' : 'rgba(42,52,65,0.92)'
            ctx.fillRect(X1, Y1 - bh, bw + 10, bh)
            ctx.strokeStyle = selected ? '#ffffff' : 'rgba(139,148,158,0.6)'
            ctx.strokeRect(cr(X1), cr(Y1 - bh), cr(bw + 10), cr(bh))
            ctx.fillStyle = selected ? '#0b0e11' : '#e6e9ec'
            ctx.textAlign = 'left'; ctx.textBaseline = 'top'
            txt.forEach((ln, i) => ctx.fillText(ln, X1 + 5, Y1 - bh + 4 + i * 12))
            break
          }
          case 'table': {
            const rows = (d.text || 'col A | col B\nrow 1 | 0').split('\n').map(r => r.split('|').map(c => c.trim()))
            const colWs: number[] = []
            for (const r of rows) r.forEach((c, i) => { colWs[i] = Math.max(colWs[i] ?? 0, ctx.measureText(c).width + 12) })
            const rh = 14
            const tw = colWs.reduce((a, b) => a + b, 0)
            const th = rows.length * rh
            ctx.fillStyle = selected ? 'rgba(255,255,255,0.14)' : 'rgba(18,22,28,0.88)'
            ctx.fillRect(X0, Y0, tw, th)
            ctx.strokeStyle = selected ? '#ffffff' : 'rgba(139,148,158,0.5)'
            ctx.strokeRect(cr(X0), cr(Y0), cr(tw), cr(th))
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
            rows.forEach((r, ri) => {
              let cx = X0
              for (let ci = 0; ci < colWs.length; ci++) {
                if (ri === 0) { ctx.fillStyle = 'rgba(224,166,63,0.95)'; ctx.fillRect(cx, Y0 + ri * rh, colWs[ci], rh) }
                ctx.strokeStyle = 'rgba(139,148,158,0.25)'
                ctx.strokeRect(cr(cx), cr(Y0 + ri * rh), cr(colWs[ci]), cr(rh))
                ctx.fillStyle = ri === 0 ? '#0b0e11' : '#d6dae0'
                ctx.fillText(r[ci] ?? '', cx + 5, Y0 + ri * rh + rh / 2 + 0.5)
                cx += colWs[ci]
              }
            })
            break
          }
          case 'pattern': {
            ctx.beginPath()
            P.forEach((pt, i) => { const x = xOfTime(pt.t), y = yOf(pt.p); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) })
            ctx.stroke()
            const name = d.variant || 'Pattern'
            const cx = P.reduce((s, p) => s + xOfTime(p.t), 0) / P.length
            const cy = P.reduce((s, p) => s + yOf(p.p), 0) / P.length
            ctx.font = '600 9px ui-monospace, monospace'
            const w = ctx.measureText(name).width + 8
            ctx.fillStyle = selected ? '#ffffff' : 'rgba(224,166,63,0.85)'
            ctx.fillRect(cx - w / 2, cy - 8, w, 14)
            ctx.fillStyle = '#0b0e11'
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
            ctx.fillText(name, cx, cy - 1)
            ctx.font = '9px ui-monospace, monospace'
            break
          }
          case 'free': {
            ctx.beginPath()
            P.forEach((pt, i) => { const x = xOfTime(pt.t), y = yOf(pt.p); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) })
            ctx.stroke()
            break
          }
          case 'pricerange': {
            const x0 = Math.min(X0, X1), x1 = Math.max(X0, X1)
            const ya = cr(Y0), yb = cr(Y1)
            ctx.setLineDash([3, 3])
            ctx.strokeRect(cr(x0), Math.min(ya, yb), cr(x1) - cr(x0), Math.abs(yb - ya))
            ctx.setLineDash([])
            const dp = P[1].p - P[0].p
            const pct = P[0].p ? (dp / P[0].p) * 100 : 0
            ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'
            ctx.fillText(`${dp >= 0 ? '+' : ''}${dp.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`, x1 - 2, (ya + yb) / 2 - 2)
            break
          }
          case 'long':
          case 'short': {
            const dir = d.dir ?? 1
            const pE = P[0].p
            const pS = d.pS ?? pE * (dir > 0 ? 0.996 : 1.004)
            const pT = d.pT ?? pE * (dir > 0 ? 1.008 : 0.992)
            const x0 = Math.min(X0, X1), x1 = Math.max(X0, X1)
            const yE = yOf(pE), yS = yOf(pS), yT = yOf(pT)
            ctx.fillStyle = 'rgba(229,72,77,0.13)'
            ctx.fillRect(x0, Math.min(yE, yS), x1 - x0, Math.abs(yS - yE))
            ctx.fillStyle = 'rgba(47,191,127,0.13)'
            ctx.fillRect(x0, Math.min(yE, yT), x1 - x0, Math.abs(yT - yE))
            const yT2 = Math.min(yE, yS, yT), yB2 = Math.max(yE, yS, yT)
            ctx.strokeStyle = 'rgba(255,255,255,0.14)'
            seg(cr(x0), cr(yT2), cr(x0), cr(yB2))
            seg(cr(x1), cr(yT2), cr(x1), cr(yB2))
            ctx.lineWidth = 1.1
            ctx.strokeStyle = DOWN; seg(x0, cr(yS), x1, cr(yS))
            ctx.strokeStyle = UP; seg(x0, cr(yT), x1, cr(yT))
            ctx.strokeStyle = '#d6dae0'; ctx.lineWidth = 1.3; seg(x0, cr(yE), x1, cr(yE))
            const rrV = (d.pS ?? 0) !== (d.pT ?? 0) && pE !== pS ? Math.abs((pT - pE) / (pE - pS)) : 0
            ctx.font = '500 9px ui-monospace, monospace'
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
            ctx.fillStyle = dir > 0 ? UP : DOWN
            ctx.fillRect(x0 + 4, yE - 14, 13, 13)
            ctx.fillStyle = '#0c0e11'
            ctx.textAlign = 'center'
            ctx.fillText(dir > 0 ? 'L' : 'S', x0 + 10.5, yE - 7.4)
            ctx.textAlign = 'left'
            ctx.fillStyle = '#d6dae0'
            ctx.fillText(`ENTRY ${pE.toFixed(2)}`, x0 + 21, yE - 7)
            ctx.fillStyle = DOWN
            ctx.fillText(`STOP ${Math.abs((pS - pE) / pE * 100).toFixed(2)}%`, x0 + 5, yS > yE ? yS + 8 : yS - 7)
            ctx.fillStyle = UP
            ctx.fillText(`TGT ${Math.abs((pT - pE) / pE * 100).toFixed(2)}%${rrV ? ` · 1:${rrV.toFixed(1)}` : ''}`, x0 + 5, yT < yE ? yT - 7 : yT + 8)
            break
          }
          case 'vprofile': {
            const t0 = Math.min(P[0].t, P[1].t), t1 = Math.max(P[0].t, P[1].t)
            const vp = computeVP(t0, t1)
            if (!vp) break
            const x0 = Math.min(X0, X1), x1 = Math.max(X0, X1)
            const maxW = Math.min(Math.max(40, (x1 - x0) * 0.55), 180)
            const mb = Math.max(...vp.bins) || 1
            const bh = (vp.hi - vp.lo) / vp.N
            for (let i = 0; i < vp.N; i++) {
              const wpx = (vp.bins[i] / mb) * maxW
              if (wpx < 0.5) continue
              const yT = yOf(vp.hi - (i + 1) * bh)
              const hh = Math.max(1, Math.abs(yOf(vp.hi - i * bh) - yT))
              ctx.fillStyle = i === vp.poc ? 'rgba(224,166,63,0.95)' : (i >= vp.a && i <= vp.b2) ? 'rgba(224,166,63,0.4)' : 'rgba(224,166,63,0.16)'
              ctx.fillRect(x0, yT, wpx, hh)
            }
            const yVAH = cr(yOf(vp.hi - vp.b2 * bh))
            const yVAL = cr(yOf(vp.hi - (vp.a + 1) * bh))
            const yPOC = cr(yOf(vp.lo + (vp.poc + 0.5) * bh))
            ctx.strokeStyle = 'rgba(224,166,63,0.75)'
            ctx.lineWidth = 1.1
            ctx.setLineDash([6, 4])
            seg(x0, yVAH, x1, yVAH); seg(x0, yVAL, x1, yVAL); seg(x0, yPOC, x1, yPOC)
            ctx.setLineDash([])
            ctx.strokeStyle = 'rgba(255,255,255,0.2)'
            ctx.setLineDash([3, 4])
            seg(cr(x0), yOf(vp.hi), cr(x0), yOf(vp.lo))
            seg(cr(x1), yOf(vp.hi), cr(x1), yOf(vp.lo))
            ctx.setLineDash([])
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
            ctx.fillStyle = 'rgba(224,166,63,0.95)'
            ctx.fillText(`VAH ${(vp.hi - vp.b2 * bh).toFixed(2)}`, x0 + 4, yVAH - 2)
            ctx.fillText(`POC ${(vp.lo + (vp.poc + 0.5) * bh).toFixed(2)}`, x0 + 4, yPOC - 2)
            ctx.textBaseline = 'top'
            ctx.fillText(`VAL ${(vp.hi - (vp.a + 1) * bh).toFixed(2)}`, x0 + 4, yVAL + 2)
            ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'
            ctx.fillText(`VP · ${fmtVol(vp.tv || 0)}`, x1 - 4, yOf(vp.hi) - 4)
            break
          }
          case 'vbs': {
            const t0 = Math.min(P[0].t, P[1].t), t1 = Math.max(P[0].t, P[1].t)
            const vp = computeBSV(t0, t1)
            if (!vp) break
            const x0 = Math.min(X0, X1), x1 = Math.max(X0, X1)
            const cx = (x0 + x1) / 2
            const bh = (vp.hi - vp.lo) / vp.N
            const yHi2 = yOf(vp.hi), yLo2 = yOf(vp.lo)
            ctx.fillStyle = 'rgba(255,255,255,0.035)'
            ctx.fillRect(x0, yHi2, x1 - x0, yLo2 - yHi2)
            ctx.strokeStyle = 'rgba(255,255,255,0.2)'
            ctx.strokeRect(cr(x0), cr(yHi2), cr(x1) - cr(x0), cr(yLo2) - cr(yHi2))
            ctx.strokeStyle = 'rgba(255,255,255,0.32)'
            seg(cr(x0), cr(yHi2), cr(x0), cr(yLo2))
            seg(cr(x1), cr(yHi2), cr(x1), cr(yLo2))
            ctx.strokeStyle = 'rgba(255,255,255,0.12)'
            ctx.setLineDash([3, 4])
            seg(cr(cx), cr(yHi2), cr(cx), cr(yLo2))
            ctx.setLineDash([])
            let mNet = 1e-9
            for (let i = 0; i < vp.N; i++) mNet = Math.max(mNet, Math.abs(vp.buy[i] - vp.sell[i]))
            const wMax = clamp((x1 - x0) * 0.5 - 8, 20, 150)
            for (let i = 0; i < vp.N; i++) {
              const net = vp.buy[i] - vp.sell[i]
              if (Math.abs(net) < mNet * 0.05) continue
              const wpx = (Math.abs(net) / mNet) * wMax
              const yT = yOf(vp.hi - (i + 1) * bh)
              const hh = Math.max(1, Math.abs(yOf(vp.hi - i * bh) - yT))
              ctx.fillStyle = net > 0 ? 'rgba(47,191,127,0.55)' : 'rgba(229,72,77,0.55)'
              ctx.fillRect(net > 0 ? cx : cx - wpx, yT, wpx, hh)
            }
            const bp2 = vp.bt + vp.st > 0 ? (vp.bt / (vp.bt + vp.st)) * 100 : 50
            ctx.font = '600 9.5px ui-monospace, monospace'
            ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'
            ctx.fillStyle = bp2 >= 50 ? UP : DOWN
            ctx.fillText(`BSV · BUY ${bp2.toFixed(0)}% / SELL ${(100 - bp2).toFixed(0)}% · ${fmtVol(vp.bt)} / ${fmtVol(vp.st)}`, x1 - 4, yHi2 - 4)
            break
          }
        }
        // selection handles (endpoint dots)
        if (selected) {
          ctx.fillStyle = '#ffffff'
          ctx.strokeStyle = '#0b0e11'
          for (const pt of P) {
            ctx.beginPath(); ctx.arc(xOfTime(pt.t), yOf(pt.p), 3.2, 0, Math.PI * 2)
            ctx.fill(); ctx.stroke()
          }
        }
        ctx.restore()
      }

      for (const d of drawingsRef.current) renderDrawing(d, d.id === selIdRef.current)
      // pending preview (2-pt tools armed, first point set · pattern adds a moving vertex)
      const pend = pendingRef.current
      if (pend) {
        const mousePt = inPlot ? { t: mouseT, p: pMax - (mouse!.y / priceH) * (pMax - pMin) } : null
        const preview: Drawing = { ...pend }
        if (pend.type === 'pattern') {
          preview.pts = mousePt ? [...pend.pts, mousePt] : pend.pts
        } else if (pend.pts.length === 1 && inPlot) {
          preview.pts = [pend.pts[0], mousePt ?? pend.pts[0]]
        }
        if (pend.type !== 'free') renderDrawing(preview, true)
        if (pend.pts.length === 1 && inPlot) {
          ctx.fillStyle = '#e0a63f'
          ctx.beginPath(); ctx.arc(xOfTime(pend.pts[0].t), yOf(pend.pts[0].p), 3, 0, Math.PI * 2); ctx.fill()
        }
      }

      // ================= legend + crosshair =================
      const drawLegend = (c: Candle, idxTime: number, livePct: number | null, inner: Candle | null, innerLabel = '') => {
        const up = c.c >= c.o
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = '#e6e9ec'
        ctx.font = 'bold 10px ui-monospace, monospace'
        ctx.fillText(symbol, 6, 4)
        let x = 6 + ctx.measureText(symbol).width + 8
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillStyle = '#8b949e'
        const tfTxt = ghostEff && ghostHigher ? `· ${settings.ghostTf} shell ·` : `· ${tf} ·`
        ctx.fillText(tfTxt, x, 4); x += ctx.measureText(tfTxt).width + 6
        ctx.fillStyle = up ? UP : DOWN
        const ltpTxt = c.c.toFixed(2)
        ctx.fillText(ltpTxt, x, 4); x += ctx.measureText(ltpTxt).width + 8
        if (livePct != null) {
          ctx.fillStyle = livePct >= 0 ? UP : DOWN
          const pctTxt = `${livePct >= 0 ? '+' : ''}${livePct.toFixed(2)}%`
          ctx.fillText(pctTxt, x, 4); x += ctx.measureText(pctTxt).width + 10
        }
        const parts: [string, number][] = [['O', c.o], ['H', c.h], ['L', c.l], ['C', c.c]]
        for (const [k, v] of parts) {
          ctx.fillStyle = '#8b949e'
          ctx.fillText(k, x, 4); x += 10
          ctx.fillStyle = up ? UP : DOWN
          const vt = v.toFixed(2)
          ctx.fillText(vt, x, 4); x += ctx.measureText(vt).width + 8
        }
        if (c.v > 0) {
          ctx.fillStyle = '#8b949e'
          const vTxt = `V ${fmtVol(c.v)}`
          ctx.fillText(vTxt, x, 4); x += ctx.measureText(vTxt).width + 8
        }
        ctx.fillStyle = '#56606b'
        ctx.fillText(fmtAxisTime(idxTime, tf), x, 4)
        if (rsiArr) {
          const i = Math.max(0, Math.min(data.length - 1, Math.round((idxTime - data[0].t) / tfMs)))
          const v = rsiArr[i]
          if (v != null) { ctx.fillStyle = v > 70 ? DOWN : v < 30 ? UP : '#f5a623'; ctx.fillText(` RSI ${v.toFixed(1)}`, x, 4) }
        }
        if (adxArr) {
          const i = Math.max(0, Math.min(data.length - 1, Math.round((idxTime - data[0].t) / tfMs)))
          const v = adxArr.adx[i]
          if (v != null) { ctx.fillStyle = v > 25 ? '#a78bfa' : '#8b949e'; ctx.fillText(` ADX ${v.toFixed(1)}`, x, 4) }
        }
        // ---- inner-tf row ("mouse over shows inner") — label = the inner timeframe ----
        if (inner) {
          const iup = inner.c >= inner.o
          let ix = 14
          ctx.fillStyle = '#e0a63f'
          const lbl = innerLabel || (ghostLower ? String(settings.ghostTf) : tf)
          ctx.fillText(lbl, ix, 17); ix += ctx.measureText(lbl).width + 6
          ctx.fillStyle = iup ? UP : DOWN
          const parts1: [string, number][] = [['O', inner.o], ['H', inner.h], ['L', inner.l], ['C', inner.c]]
          for (const [k, v] of parts1) {
            ctx.fillStyle = '#8b949e'
            ctx.fillText(k, ix, 17); ix += 10
            ctx.fillStyle = iup ? UP : DOWN
            const vt = v.toFixed(2)
            ctx.fillText(vt, ix, 17); ix += ctx.measureText(vt).width + 7
          }
          if (inner.v > 0) {
            ctx.fillStyle = '#8b949e'
            const vTxt = `V ${fmtVol(inner.v)}`
            ctx.fillText(vTxt, ix, 17); ix += ctx.measureText(vTxt).width + 7
          }
          ctx.fillStyle = '#56606b'
          ctx.fillText(fmtAxisTime(inner.t, tf, true), ix, 17)
        }
      }
      // focus candle: hovered > synced > last; inner bar follows the same time
      let focus: { c: Candle; t: number } | null = { c: lastC, t: lastT }
      let focusInner: Candle | null = null
      if (ghost.length > 0 && (ghostLower || (!ghostOn && tfMs > 60_000))) {
        focusInner = ghost[Math.min(ghost.length - 1, Math.max(0, gi >= 0 ? gi : ghost.length - 1))] ?? null
      } else if (ghostHigher && gi >= 0) {
        focusInner = candles[gi] ?? null
      }
      const drawCrossAt = (slotIdx: number, own: boolean, syncPrice: number | null) => {
        if (slotIdx < 0 || slotIdx >= slots) return
        const x = xOf(slotIdx)
        ctx.strokeStyle = CROSS
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - axisH); ctx.stroke()
        if (own && crossRef.current) {
          const y = Math.min(priceH, Math.max(0, crossRef.current.y))
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
          const price = pMax - (crossRef.current.y / priceH) * (pMax - pMin)
          ctx.fillStyle = '#2a3441'
          ctx.fillRect(plotW + 2, y - 8, axisW - 4, 16)
          ctx.fillStyle = '#e6e9ec'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(price.toFixed(2), plotW + axisW / 2, y)
        }
        if (syncPrice != null && syncPrice >= pMin && syncPrice <= pMax) {
          const sy = yOf(syncPrice)
          ctx.strokeStyle = 'rgba(255,255,255,0.16)'
          ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(plotW, sy); ctx.stroke()
          ctx.fillStyle = '#2a3441'
          ctx.fillRect(plotW + 2, sy - 8, axisW - 4, 16)
          ctx.fillStyle = '#e6e9ec'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(syncPrice.toFixed(2), plotW + axisW / 2, sy)
        }
        ctx.setLineDash([])
        const t = timeOfSlot(slotIdx)
        ctx.fillStyle = '#2a3441'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillRect(Math.min(plotW - 48, Math.max(0, x - 24)), h - axisH + 2, 48, 14)
        ctx.fillStyle = '#e6e9ec'
        ctx.fillText(fmtAxisTime(t, tf), Math.min(plotW - 24, Math.max(24, x)), h - axisH + 4)
        const c = vis[slotIdx]
        if (c) {
          focus = { c, t }
          if (ghost.length > 0 && (ghostLower || (!ghostOn && tfMs > 60_000))) {
            const i = lowerBoundTime(ghost, t)
            const j = clamp(inPlot && Math.abs(mouseT - t) < tfMs ? gi : (i > 0 ? i - 1 : 0), 0, ghost.length - 1)
            focusInner = ghost[j] ?? null
          } else if (ghostHigher) {
            const i = lowerBoundTime(candles, t)
            focusInner = candles[clamp(i > 0 && candles[i]?.t > t ? i - 1 : i, 0, candles.length - 1)] ?? null
          }
        }
      }

      // own crosshair
      if (!mini && crossRef.current && crossRef.current.x < plotW && crossRef.current.y < h - axisH && mouse?.inPlot !== false) {
        const slotIdx = clamp(Math.floor(crossRef.current.x / cw), 0, slots - 1)
        drawCrossAt(slotIdx, true, null)
      }
      // synced crosshair from another chart (same interval)
      const sc = syncCrossRef.current
      if (!mini && sc) {
        const slotIdx = Math.round((sc.slot - t0Slot) / tfMs)
        drawCrossAt(slotIdx, false, sc.price)
      }

      const fc = focus as { c: Candle; t: number } | null
      if (fc) {
        // ghost-higher: row 1 shows the SHELL containing the focus time
        let legendC = fc.c
        let legendT = fc.t
        let innerLabel = ghostLower ? String(settings.ghostTf) : tf
        if (ghostHigher) {
          const si = lowerBoundTime(ghostShells, fc.t)
          const sh = ghostShells[si > 0 && ghostShells[si]?.t > fc.t ? si - 1 : si]
          if (sh) { legendC = sh; legendT = sh.t }
          innerLabel = tf
        }
        const pct = dayRef ? ((legendC.c - dayRef) / dayRef) * 100 : null
        drawLegend(legendC, legendT, pct, focusInner, innerLabel)
      }
    }

    const loop = () => { draw(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    const ro = new ResizeObserver(() => forceRender(n => n + 1))
    ro.observe(wrap)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [candles, ghost, ghostShells, barCount, settings, drawings, markers, symbol, tf, loading, err, mini, selId, dirty])

  // ---- interactions ----
  const priceAtY = (y: number): number => {
    const win = winRef.current
    return win.pMax - (y / (win.priceH || 1)) * (win.pMax - win.pMin)
  }
  const timeAtX = (x: number): number => {
    const g = geoRef.current
    return g.t0 + ((x - g.cw / 2) / g.cw) * g.tfMs
  }
  const dataPt = (x: number, y: number): DrawPt => ({ t: timeAtX(x), p: priceAtY(y) })

  const hitDrawing = (x: number, y: number): { d: Drawing; mode: 'move' | 'pt' | 'ps' | 'tg' | 'w'; pi?: number } | null => {
    const g = geoRef.current
    if (x > g.plotW || y > g.priceH) return null
    const X = (t: number) => ((t - g.t0) / g.tfMs) * g.cw + g.cw / 2
    const Y = (p: number) => ((g.pMax - p) / (g.pMax - g.pMin)) * g.priceH
    const list = drawingsRef.current
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i]
      const P = d.pts
      if (!P.length) continue
      for (let pi = 0; pi < P.length; pi++) {
        // long/short: the RIGHT anchor is the resize grip (mode 'w') — skip it here
        if ((d.type === 'long' || d.type === 'short') && pi === 1) continue
        if (Math.hypot(x - X(P[pi].t), y - Y(P[pi].p)) < 7) return { d, mode: 'pt', pi }
      }
      const X0 = X(P[0].t), Y0 = Y(P[0].p)
      const X1 = P.length > 1 ? X(P[1].t) : X0
      const Y1 = P.length > 1 ? Y(P[1].p) : Y0
      let hit = false
      switch (d.type) {
        case 'trend':
        case 'ray':
        case 'arrow':
          hit = distSeg(x, y, X0, Y0, X1, Y1) < 5
          break
        case 'free':
        case 'pattern': {
          for (let pi2 = 1; pi2 < P.length; pi2++) {
            if (distSeg(x, y, X(P[pi2 - 1].t), Y(P[pi2 - 1].p), X(P[pi2].t), Y(P[pi2].p)) < 5) { hit = true; break }
          }
          break
        }
        case 'hline':
          hit = Math.abs(y - Y0) < 5
          break
        case 'hray':
          hit = Math.abs(y - Y0) < 5 && x >= X0 - 4
          break
        case 'vline':
          hit = Math.abs(x - X0) < 5
          break
        case 'rect':
        case 'ellipse':
        case 'pricedate':
        case 'forecast': {
          const xa = Math.min(X0, X1), xb = Math.max(X0, X1)
          const ya = Math.min(Y0, Y1), yb = Math.max(Y0, Y1)
          hit = ((Math.abs(y - ya) < 5 || Math.abs(y - yb) < 5) && x >= xa - 4 && x <= xb + 4)
            || ((Math.abs(x - xa) < 5 || Math.abs(x - xb) < 5) && y >= ya - 4 && y <= yb + 4)
          break
        }
        case 'circle': {
          // stroke hit — within 6px of the circle's rim
          const r = Math.max(3, Math.hypot(X1 - X0, Y1 - Y0))
          hit = Math.abs(Math.hypot(x - X0, y - Y0) - r) < 6
          break
        }
        case 'fib':
        case 'fibext': {
          const xa = Math.min(X0, X1), xb = Math.max(X0, X1)
          if (x < xa - 6 || x > xb + 6) break
          const p0 = P[0].p, p1 = P[1].p
          const levels = d.type === 'fib' ? FIBL : FIB_EXT
          for (const lv of levels) {
            if (Math.abs(y - Y(p1 + (p0 - p1) * lv)) < 4) { hit = true; break }
          }
          break
        }
        case 'fibtz': {
          const dt = P[1].t - P[0].t
          for (const f of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
            if (Math.abs(x - X(P[0].t + dt * f)) < 4) { hit = true; break }
          }
          break
        }
        case 'fan': {
          const p0 = P[0].p, p1 = P[1].p
          const x2 = X(P[1].t)
          for (const lv of [0.382, 0.5, 0.618, 0.786, 1.618]) {
            const y2 = Y(p0 + (p1 - p0) * lv)
            if (distSeg(x, y, X0, Y0, Math.min(x2, g.plotW + 50), y2) < 5) { hit = true; break }
          }
          if (!hit) hit = distSeg(x, y, X0, Y0, X1, Y1) < 5
          break
        }
        case 'pricerange': {
          const xa = Math.min(X0, X1), xb = Math.max(X0, X1)
          const ya = Math.min(Y0, Y1), yb = Math.max(Y0, Y1)
          hit = ((Math.abs(y - ya) < 5 || Math.abs(y - yb) < 5) && x >= xa - 4 && x <= xb + 4)
            || ((Math.abs(x - xa) < 5 || Math.abs(x - xb) < 5) && y >= ya - 4 && y <= yb + 4)
          break
        }
        case 'long':
        case 'short': {
          const dir = d.dir ?? 1
          const pE = P[0].p
          const pS = d.pS ?? posDefaultSL(pE, dir)
          const pT = d.pT ?? posDefaultTGT(pE, dir)
          const xa = Math.min(X0, X1), xb = Math.max(X0, X1)
          if (x < xa - 5 || x > xb + 6) break
          // priority: SL line · target line · right-edge resize · entry line
          if (Math.abs(y - Y(pS)) < 5) return { d, mode: 'ps' }
          if (Math.abs(y - Y(pT)) < 5) return { d, mode: 'tg' }
          if (Math.abs(x - xb) < 6) return { d, mode: 'w' }
          hit = Math.abs(y - Y(pE)) < 5
          break
        }
        case 'text':
          hit = Math.abs(y - Y0) < 14 && x >= X0 && x <= X0 + 140
          break
        case 'pricenote':
          hit = y >= Y0 - 11 && y <= Y0 + 16 && x >= X0 && x <= X0 + 130
          break
        case 'pin':
          hit = Math.hypot(x - X0, y - Y0) < 9 || (y >= Y0 && y <= Y0 + 14 && x >= X0 && x <= X0 + 14)
          break
        case 'comment':
        case 'callout': {
          hit = distSeg(x, y, X0, Y0, X1, Y1) < 5
            || (x >= X1 - 3 && x <= X1 + 140 && y >= Y1 - 30 && y <= Y1 + 4)
          break
        }
        case 'table':
          hit = x >= X0 && x <= X0 + 150 && y >= Y0 && y <= Y0 + 60
          break
        case 'vprofile':
        case 'vbs': {
          const xa = Math.min(X0, X1), xb = Math.max(X0, X1)
          hit = x >= xa - 5 && x <= xb + 5
          break
        }
      }
      if (hit) return { d, mode: 'move' }
    }
    return null
  }

  const finishPending = (secondPt: DrawPt) => {
    const pend = pendingRef.current
    pendingRef.current = null
    if (!pend) return null
    const P = [pend.pts[0], secondPt]
    if (pend.type === 'vprofile' || pend.type === 'vbs') {
      const bars = Math.abs(P[1].t - P[0].t) / (geoRef.current.tfMs || 1)
      if (bars < 3) { setToolBoth('cursor'); return null } // too narrow — cancel
    } else if (pend.type === 'fib' || pend.type === 'fibext' || pend.type === 'fibtz' || pend.type === 'fan' || pend.type === 'pricerange' || pend.type === 'pricedate' || pend.type === 'forecast') {
      if (Math.abs(P[1].p - P[0].p) < 1e-9) { setToolBoth('cursor'); return null }
    } else if (Math.abs(P[1].t - P[0].t) < 1e-6 && Math.abs(P[1].p - P[0].p) < 1e-9) {
      setToolBoth('cursor'); return null
    }
    return newDrawing({ type: pend.type, pts: P, dir: pend.dir })
  }

  /** Finish a multi-point pattern drawing (dbl-click / Enter / right-click). */
  const finishPattern = () => {
    const pend = pendingRef.current
    if (!pend || pend.type !== 'pattern') return
    pendingRef.current = null
    if (pend.pts.length >= 2) newDrawing({ type: 'pattern', pts: pend.pts, variant: patternVariantRef.current })
    setToolBoth('cursor')
  }

  /** Open the text overlay for a freshly placed annotation. */
  const openTextFor = (d: Drawing) => {
    const g = geoRef.current
    const x = g.cw / 2 + ((d.pts[0].t - g.t0) / g.tfMs) * g.cw
    const y = g.priceH * ((g.pMax - d.pts[0].p) / (g.pMax - g.pMin))
    textEditOpenedAt.current = Date.now() // blur-guard: the mount-time focus race must NOT wipe the drawing
    setTextEdit({ id: d.id, x: Math.round(x) + 4, y: Math.round(y) - 10, value: d.type === 'table' ? 'col A | col B\nrow 1 | 0' : d.text ?? '', multiline: d.type === 'table' || d.type === 'comment' || d.type === 'callout' })
  }

  const commitText = () => {
    if (!textEdit) return
    const te = textEdit
    const val = te.value.trim()
    // MOUNT-TIME BLUR GUARD — the canvas mousedown that opened this editor hands
    // focus to the canvas AFTER the input auto-focuses (browser default action);
    // that blur is not a user commit. Swallow it and re-focus the editor so the
    // annotation is never silently deleted (round-9: annotations "not working").
    if (!val && Date.now() - textEditOpenedAt.current < 300) {
      requestAnimationFrame(() => textInputRef.current?.focus())
      return
    }
    setTextEdit(null)
    if (!val) {
      // empty annotation — remove the placeholder drawing
      commitDrawings(drawingsRef.current.filter(d => d.id !== te.id))
    } else {
      commitDrawings(drawingsRef.current.map(d => (d.id === te.id ? { ...d, text: te.value } : d)))
    }
    setToolBoth('cursor')
    requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }))
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const win = winRef.current
    const f = e.deltaY > 0 ? 1.15 : 0.87
    if ((win.plotW > 0 && x >= win.plotW) || e.shiftKey) {
      priceZoomRef.current = Math.max(0.15, Math.min(10, priceZoomRef.current * f))
    } else {
      setBarCount(b => Math.max(25, Math.min(900, Math.round(b * f))))
    }
    setDirty(true)
  }

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const win = winRef.current

    // ---- EXIT button on the entry marker line — highest priority ----
    if (exitBtnRef.current && onExitPosition && x <= win.plotW && y <= win.priceH) {
      const b = exitBtnRef.current
      if (x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2) {
        onExitPosition()
        return
      }
    }

    // ---- draggable level markers (sl/target LINES) — highest priority.
    // The whole line is the handle: any x inside the plot within ±8px of the
    // level grabs it (TradingView-style line dragging). ----
    if (x < win.plotW && y <= win.priceH) {
      let best: { m: ChartMarker; d: number } | null = null
      for (const m of markers) {
        if (!m.id || (m.kind !== 'sl' && m.kind !== 'target')) continue
        const ym = ((win.pMax - m.price) / (win.pMax - win.pMin)) * win.priceH
        const d = Math.abs(y - ym)
        if (d <= 8 && (!best || d < best.d)) best = { m, d }
      }
      if (best) {
        markerDragRef.current = { id: best.m.id!, kind: best.m.kind as 'sl' | 'target', price: best.m.price }
        return
      }
    }

    // ---- draw tool armed: create/continue drawings instead of panning ----
    if (toolRef.current !== 'cursor' && x < win.plotW && y < win.priceH) {
      const t = toolRef.current as DrawTool
      const pt = dataPt(x, y)
      if (pendingRef.current && pendingRef.current.type === 'pattern') {
        // pattern: each click adds a vertex
        pendingRef.current = { ...pendingRef.current, pts: [...pendingRef.current.pts, pt] }
        forceRender(n => n + 1)
        return
      }
      if (pendingRef.current && pendingRef.current.pts.length === 1) {
        const finished = finishPending(pt)
        if (finished && (t === 'comment' || t === 'callout')) {
          e.preventDefault() // keep the auto-focused editor from losing focus to the canvas
          openTextFor(finished)
        }
        return
      }
      if (TWO_PT_TOOLS.has(t) || t === 'comment' || t === 'callout') {
        pendingRef.current = { id: 'pending', type: t, pts: [pt] }
        return
      }
      if (t === 'hline' || t === 'vline' || t === 'hray') {
        newDrawing({ type: t, pts: [pt] })
        return
      }
      if (TEXT_TOOLS.has(t)) {
        // single-click annotation — place, then open the text overlay.
        // preventDefault: the browser's default mousedown action would focus the
        // canvas AFTER the editor's autoFocus ran — that blur committed an empty
        // value and instantly deleted the annotation (annotations "not working").
        e.preventDefault()
        const d = newDrawing({ type: t, pts: [pt] })
        openTextFor(d)
        return
      }
      if (t === 'pattern') {
        pendingRef.current = { id: 'pending', type: 'pattern', pts: [pt] }
        forceRender(n => n + 1)
        return
      }
      if (t === 'free') {
        pendingRef.current = { id: 'pending', type: 'free', pts: [pt] }
        freeActiveRef.current = true
        return
      }
      if (t === 'long' || t === 'short') {
        const dir: 1 | -1 = t === 'long' ? 1 : -1
        const pE = pt.p
        // round-9 defaults: SL 10% of entry · target = 1.5× risk (RR 1:1.5) —
        // every level + the box edges stay draggable afterwards
        const pS = posDefaultSL(pE, dir)
        const pT = posDefaultTGT(pE, dir)
        const g = geoRef.current
        newDrawing({
          type: t,
          pts: [{ t: pt.t - 40 * g.tfMs, p: pE }, { t: pt.t + 40 * g.tfMs, p: pE }],
          dir,
          pS,
          pT,
        } as Drawing)
        return
      }
      return
    }

    // ---- cursor tool: drawings select first, then baseline, then pan ----
    const hit = hitDrawing(x, y)
    if (hit) {
      setSel(hit.d.id)
      dragDrawRef.current = { d: hit.d, mode: hit.mode, pi: hit.pi, startMouse: { x: e.clientX, y: e.clientY }, orig: JSON.parse(JSON.stringify(hit.d)) as Drawing }
      return
    }
    setSel(null)

    // baseline drag zone (scales % / pts enabled): grab within 5px of the line
    const sc = settings.scales
    const baselineEnabled = sc && (sc.pct || sc.inv || sc.pts) && !mini
    if (baselineEnabled && x < win.plotW && y <= win.priceH) {
      const meta = drawMetaRef.current
      if (meta.yBase >= 0 && Math.abs(y - meta.yBase) <= 5) {
        baseRef.current = meta.baseline
        dragRef.current = { zone: 'base', startX: e.clientX, startY: e.clientY, startOffset: 0, startPriceOff: 0, startPriceZoom: 1, pxPerPx: (win.pMax - win.pMin) / (win.priceH || 1), moved: 0 }
        return
      }
    }
    const zone: DragState['zone'] = x >= win.plotW ? 'price' : y >= win.h - win.axisH ? 'time' : 'plot'
    dragRef.current = {
      zone,
      startX: e.clientX,
      startY: e.clientY,
      startOffset: offsetRef.current,
      startPriceOff: priceOffRef.current,
      startPriceZoom: priceZoomRef.current,
      pxPerPx: win.priceH > 0 ? (win.pMax - win.pMin) / win.priceH : 1,
      moved: 0,
    }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const win = winRef.current
    crossRef.current = { x, y, inPlot: x < win.plotW && y < win.priceH }

    // pencil (free hand): append points while the button is down
    if (freeActiveRef.current && pendingRef.current?.type === 'free') {
      pendingRef.current = { ...pendingRef.current, pts: [...pendingRef.current.pts, dataPt(x, y)] }
      forceRender(n => n + 1)
      return
    }

    // live marker drag (mutates the ref so the RAF loop re-renders the line)
    const md = markerDragRef.current
    if (md) {
      md.price = Number((win.pMax - (Math.min(win.priceH, Math.max(0, y)) / (win.priceH || 1)) * (win.pMax - win.pMin)).toFixed(2))
      forceRender(n => n + 1)
      return
    }

    // publish to the sync bus (same-interval charts follow)
    if (win.plotW > 0 && candles.length > 1 && x < win.plotW) {
      const tfMs = TF_MS[tf as keyof typeof TF_MS] ?? 60_000
      const end = candles.length - Math.round(offsetRef.current)
      const start = Math.min(end - barCount, candles.length - 2)
      const cw = win.plotW / (end - start)
      const slotIdx = Math.floor(x / cw)
      const di = start + slotIdx
      const lastT = candles[candles.length - 1].t
      const t = di < candles.length ? candles[di].t : lastT + (di - (candles.length - 1)) * tfMs
      const price = y <= win.priceH
        ? win.pMax - (y / win.priceH) * (win.pMax - win.pMin)
        : null
      emitCross({ src: chartId.current, tf, t, price })
    }

    // live drawing edit (mutates the ref mirror so the RAF loop sees it)
    const dd = dragDrawRef.current
    if (dd) {
      const dx = e.clientX - dd.startMouse.x
      const dy = e.clientY - dd.startMouse.y
      const g = geoRef.current
      const pxPerPx = (g.pMax - g.pMin) / (g.priceH || 1)
      const next: Drawing = { ...dd.orig, pts: dd.orig.pts.map(p => ({ ...p })) }
      if (dd.mode === 'pt' && dd.pi != null) {
        next.pts[dd.pi] = dataPt(x, y)
      } else if (dd.mode === 'ps') {
        // position tool: drag the STOP line vertically
        next.pS = Number(dataPt(x, y).p.toFixed(2))
      } else if (dd.mode === 'tg') {
        // position tool: drag the TARGET line vertically
        next.pT = Number(dataPt(x, y).p.toFixed(2))
      } else if (dd.mode === 'w') {
        // position tool: drag the right edge to resize the box duration
        next.pts[1] = { t: dataPt(x, y).t, p: next.pts[1]?.p ?? next.pts[0].p }
      } else {
        const dt = (dx / (g.cw || 1)) * g.tfMs
        const dp = -dy * pxPerPx
        next.pts = next.pts.map(p => ({ t: p.t + dt, p: p.p + dp }))
        if (next.pS != null) next.pS = next.pS + dp
        if (next.pT != null) next.pT = next.pT + dp
      }
      drawingsRef.current = drawingsRef.current.map(d => (d.id === dd.d.id ? next : d))
      forceRender(n => n + 1)
      return
    }

    const d = dragRef.current
    if (!d) return
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY))
    if (d.zone === 'base') {
      const yy = Math.min(win.priceH, Math.max(0, y))
      baseRef.current = Number((win.pMax - (yy / (win.priceH || 1)) * (win.pMax - win.pMin)).toFixed(2))
      return
    }
    if (d.zone === 'price') {
      const f = Math.exp((d.startY - e.clientY) / 180)
      priceZoomRef.current = Math.max(0.15, Math.min(10, d.startPriceZoom * f))
      return
    }
    // horizontal pan — negative offset = future space
    const cwAvg = Math.max(0.5, (sizeRef.current.w - (mini ? 46 : 58)) / barCount)
    const barsMoved = Math.round((e.clientX - d.startX) / cwAvg)
    const maxOff = candles.length - 25
    offsetRef.current = Math.max(-FUTURE_BARS, Math.min(maxOff, d.startOffset + barsMoved))
    if (d.zone === 'plot') {
      priceOffRef.current = d.startPriceOff + (e.clientY - d.startY) * d.pxPerPx
    }
    setDirty(true)
  }

  const onMouseUp = (e: React.MouseEvent) => {
    // finish a marker drag — commit the new level via the parent
    if (markerDragRef.current) {
      const md = markerDragRef.current
      markerDragRef.current = null
      if (md.kind && onMarkerDrop) onMarkerDrop(md.kind, md.price)
      return
    }
    // pencil stroke ends → commit the free-hand drawing
    if (freeActiveRef.current) {
      freeActiveRef.current = false
      const pend = pendingRef.current
      pendingRef.current = null
      if (pend && pend.type === 'free' && pend.pts.length > 1) {
        commitDrawings([...drawingsRef.current, { ...pend, id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}` }].slice(-120))
      }
      return
    }
    // finish a live drawing edit
    if (dragDrawRef.current) {
      dragDrawRef.current = null
      commitDrawings(drawingsRef.current)
      return
    }
    // 2-pt tool: drag-release commits when the drag covered >24px
    const pend = pendingRef.current
    if (pend && pend.pts.length === 1 && pend.type !== 'pattern') {
      const rect = canvasRef.current!.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const g = geoRef.current
      const sx = g.cw / 2 + ((pend.pts[0].t - g.t0) / g.tfMs) * g.cw
      const sy = g.priceH * ((g.pMax - pend.pts[0].p) / (g.pMax - g.pMin))
      if (Math.hypot(x - sx, y - sy) > 24) {
        const finished = finishPending(dataPt(x, y))
        if (finished && (pend.type === 'comment' || pend.type === 'callout')) openTextFor(finished)
      }
      return // else stay pending — click-click mode
    }

    const d = dragRef.current
    dragRef.current = null
    if (!d || d.moved >= 4) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const win = winRef.current
    if (x < win.plotW && y < win.priceH && win.pMax > win.pMin) {
      const price = Number((win.pMax - (y / win.priceH) * (win.pMax - win.pMin)).toFixed(2))
      // scales baseline pick mode — consumed by the first chart clicked
      if (pickRef.current) {
        baseRef.current = price
        pickRef.current = false
        setBaseArmed(false)
        window.dispatchEvent(new Event(BASE_SET_EVENT))
        return
      }
      if (toolRef.current === 'cursor' && !pendingRef.current) onPriceClick?.(price)
    }
  }
  const onMouseLeave = () => {
    crossRef.current = null
    dragRef.current = null
    dragDrawRef.current = null
    emitCross({ src: chartId.current, tf, t: null, price: null })
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selIdRef.current) {
        commitDrawings(drawingsRef.current.filter(d => d.id !== selIdRef.current))
        setSel(null)
        e.preventDefault()
      }
    } else if (e.key === 'Enter') {
      if (pendingRef.current?.type === 'pattern') { finishPattern(); e.preventDefault() }
    } else if (e.key === 'Escape') {
      pendingRef.current = null
      setSel(null)
      setToolBoth('cursor')
    }
  }
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (pendingRef.current?.type === 'pattern') { finishPattern(); return }
    pendingRef.current = null
    setSel(null)
    setToolBoth('cursor')
  }
  const resetView = () => {
    offsetRef.current = 0
    priceZoomRef.current = 1
    priceOffRef.current = 0
    baseRef.current = null
    setBarCount(mini ? 60 : 120)
    setDirty(false)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    // pattern in progress → finish it (do NOT reset the view)
    if (pendingRef.current?.type === 'pattern') { finishPattern(); return }
    // dbl-click on a draggable grip removes the level; otherwise reset view
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const win = winRef.current
    if (x < win.plotW && y <= win.priceH) {
      for (const m of markers) {
        if (!m.id || (m.kind !== 'sl' && m.kind !== 'target')) continue
        const ym = ((win.pMax - m.price) / (win.pMax - win.pMin)) * win.priceH
        if (Math.abs(y - ym) <= 8) {
          onMarkerRemove?.(m.kind as 'sl' | 'target')
          return
        }
      }
    }
    resetView()
  }

  const showControls = (controls ?? !mini) && !mini
  const ghostDisabled = false // ghost works in BOTH directions now (any tf pair)

  return (
    <div ref={wrapRef} className={`relative w-full ${height} select-none`} data-chart-root>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="absolute inset-0 cursor-crosshair outline-none"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      />

      {/* soft-switch chip: data on screen while a new symbol's candles load —
          small badge instead of a blank "loading candles…" flash */}
      {loading && candles.length >= 2 && (
        <div className="absolute right-2 top-2 z-10 pointer-events-none rounded bg-card/85 border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6] animate-pulse" />
          loading {symbol.split(':').pop()}…
        </div>
      )}

      {/* ---- per-chart control BAR (#chartbar) — ONE ROW of grouped
           icon+text buttons under the legend rows. Mouse-over an icon
           shows its INFO NOTE; CLICK opens the group flyout (items
           commit on click, flyout stays open until outside click/Esc). ---- */}
      {showControls && (
        <div className="absolute left-1 top-[30px] z-10 flex items-stretch gap-[3px] max-w-[calc(100%-110px)] overflow-x-auto pl-1.5 pr-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-px">
          {/* cursor / select — icon only (round-9: main menu shows icons, hover shows the info note) */}
          <button
            onClick={() => { setToolBoth('cursor'); pendingRef.current = null }}
            title="Cursor / select — click a drawing to move or edit it · Del removes · Esc cancels"
            aria-label="Cursor"
            className={`flex items-center justify-center h-[22px] w-[26px] rounded border shrink-0 transition-colors ${
              tool === 'cursor' ? 'bg-primary/25 border-primary/50 text-foreground' : 'bg-card/85 border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
          >
            <MousePointer2 className="h-3 w-3" />
          </button>
          <TbSep />

          {/* chart type */}
          <ToolMenu
            label="Type"
            info="Chart type — candles / line / area (per chart)"
            active={settings.chartType !== 'candles'}
            icon={settings.chartType === 'candles' ? <CandlestickChart className="h-3 w-3" /> : settings.chartType === 'line' ? <LineChart className="h-3 w-3" /> : <AreaChart className="h-3 w-3" />}
          >
            {([['candles', 'Candles', CandlestickChart], ['line', 'Line', LineChart], ['area', 'Area', AreaChart]] as const).map(([t, lbl, Icon]) => (
              <button
                key={t}
                onClick={() => patchSettings({ chartType: t as ChartType })}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded ${settings.chartType === t ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
              >
                <Icon className="h-3.5 w-3.5" /> {lbl}
              </button>
            ))}
          </ToolMenu>

          {/* indicators (per chart) */}
          <ToolMenu
            label="Ind"
            width="w-48"
            active={Object.values(settings.ind).some(Boolean)}
            tint={Object.values(settings.ind).some(Boolean) ? 'text-[#4dd0e1]' : undefined}
            icon={<Sigma className="h-3 w-3" />}
            info="Indicators (per chart) — overlays MA20/50, EMA 9/21, VWAP, Bollinger · sub-panels RSI 14, MACD, ADX, Volume"
          >
            <div className="text-[8px] uppercase tracking-wide text-muted-foreground px-2 pt-1">overlays</div>
            {([
              ['sma20', 'MA 20', <PenLine key="i1" className="h-3 w-3 text-[#f6a04d]" />],
              ['sma50', 'MA 50', <ListOrdered key="i2" className="h-3 w-3 text-[#4dd0e1]" />],
              ['ema', 'EMA 9/21', <TrendingUp key="i3" className="h-3 w-3 text-[#a78bfa]" />],
              ['vwap', 'VWAP (session)', <Crosshair key="i4" className="h-3 w-3 text-[#e0a63f]" />],
              ['boll', 'Bollinger 20·2', <Activity key="i5" className="h-3 w-3 text-[#5fb0d8]" />],
            ] as [keyof IndicatorCfg, string, React.ReactNode][]).map(([k, lbl, ico]) => (
              <label key={k} className="flex items-center gap-2 px-2 py-1 cursor-pointer rounded hover:bg-secondary">
                <input
                  type="checkbox"
                  checked={!!settings.ind[k]}
                  onChange={ev => patchSettings({ ind: { ...settings.ind, [k]: ev.target.checked } })}
                  className="accent-[#3b82f6] h-3 w-3"
                />
                {ico}
                <span>{lbl}</span>
              </label>
            ))}
            <div className="text-[8px] uppercase tracking-wide text-muted-foreground px-2 pt-1">sub-panels</div>
            {([
              ['rsi', 'RSI 14', <Activity key="r1" className="h-3 w-3 text-[#e0a63f]" />],
              ['macd', 'MACD 12·26·9', <BarChart3 key="r2" className="h-3 w-3 text-[#4dd0e1]" />],
              ['adx', 'ADX 14 (+DI/-DI)', <TrendingUp key="r3" className="h-3 w-3 text-[#c084fc]" />],
              ['vol', 'Volume', <BarChartHorizontal key="r4" className="h-3 w-3 text-[#8b949e]" />],
            ] as [keyof IndicatorCfg, string, React.ReactNode][]).map(([k, lbl, ico]) => (
              <label key={k} className="flex items-center gap-2 px-2 py-1 cursor-pointer rounded hover:bg-secondary">
                <input
                  type="checkbox"
                  checked={!!settings.ind[k]}
                  onChange={ev => patchSettings({ ind: { ...settings.ind, [k]: ev.target.checked } })}
                  className="accent-[#3b82f6] h-3 w-3"
                />
                {ico}
                <span>{lbl}</span>
              </label>
            ))}
          </ToolMenu>

          {/* ghost candles — any timeframe, both directions */}
          <ToolMenu
            label="Ghost"
            width="w-56"
            active={settings.ghost}
            tint={settings.ghost ? 'text-[#e0a63f]' : undefined}
            icon={<Ghost className="h-3 w-3" />}
            info="Ghost candles — live feed ALWAYS SOLID · ghost ALWAYS HOLLOW · pick any tf either way (5m live + 1m ghost, or 1m live + 5m ghost). Solid candles are carved hollow where the ghost overlaps so the ghost always reads."
          >
            <button
              onClick={() => patchSettings({ ghost: !settings.ghost })}
              className={`w-full px-2 py-1 rounded font-semibold ${settings.ghost ? 'bg-[#e0a63f]/20 text-[#e0a63f]' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
            >
              {settings.ghost ? `Ghost ON — ghost tf ${settings.ghostTf}` : 'Ghost OFF — enable'}
            </button>
            <div className="px-2 pt-1 text-[8px] uppercase tracking-wide text-muted-foreground">ghost timeframe (lower or higher than the chart)</div>
            <div className="flex gap-0.5 px-1.5 pb-1">
              {(['1m', '3m', '5m', '15m', '1h'] as const).map(g => (
                <button
                  key={g}
                  onClick={() => patchSettings({ ghostTf: g, ghost: true })}
                  className={`flex-1 px-1 py-0.5 rounded text-[9px] tabular ${(settings.ghostTf ?? '1m') === g ? 'bg-primary text-primary-foreground' : 'bg-secondary/70 text-muted-foreground hover:text-foreground'}`}
                >{g}</button>
              ))}
            </div>
            <div className="px-2 text-[8px] uppercase tracking-wide text-muted-foreground">style</div>
            <div className="flex gap-0.5 px-1.5 pb-1">
              {(['hollow', 'fade'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => patchSettings({ ghostStyle: s })}
                  className={`flex-1 px-1 py-0.5 rounded text-[9px] ${(settings.ghostStyle ?? 'hollow') === s ? 'bg-primary text-primary-foreground' : 'bg-secondary/70 text-muted-foreground hover:text-foreground'}`}
                >{s === 'hollow' ? 'Hollow' : 'Fade'}</button>
              ))}
            </div>
            <div className="px-2 pb-1 text-[8px] text-muted-foreground leading-snug">
              live feed = SOLID · ghost = HOLLOW (always). ghost tf &gt; chart → hollow shells wrap the solid bars · ghost tf &lt; chart → hollow inside, solid candle carved open under each ghost bar.
            </div>
          </ToolMenu>

          {/* scales */}
          <ToolMenu
            label="Scale"
            width="w-60"
            active={!!settings.scales && Object.entries(settings.scales).filter(([k]) => k !== 'price').some(([, v]) => v)}
            icon={<Ruler className="h-3 w-3" />}
            info="Axis scales — price / % / inverted % / points + draggable baseline (topmost enabled = right axis, others = left column)"
          >
            <div className="text-[8px] uppercase tracking-wide text-muted-foreground px-2 pt-1">topmost enabled = right axis · others = left column</div>
            {([
              ['price', 'Price', <Hash key="s1" className="h-3 w-3 text-[#8b949e]" />],
              ['pct', 'Percent', <Percent key="s2" className="h-3 w-3 text-[#e0a63f]" />],
              ['inv', 'Inverted % (sellers)', <ArrowDownUp key="s3" className="h-3 w-3 text-[#e06c9f]" />],
              ['pts', 'Points', <MoveHorizontal key="s4" className="h-3 w-3 text-[#4dd0e1]" />],
            ] as [keyof ScalesCfg, string, React.ReactNode][]).map(([k, lbl, ico]) => (
              <label key={k} className="flex items-center gap-2 px-2 py-1 cursor-pointer rounded hover:bg-secondary">
                <input
                  type="checkbox"
                  checked={!!settings.scales?.[k]}
                  onChange={ev => patchSettings({ scales: { ...(settings.scales ?? { price: true, pct: false, inv: false, pts: false }), [k]: ev.target.checked } })}
                  className="accent-[#3b82f6]"
                />
                {ico}
                <span>{lbl}</span>
              </label>
            ))}
            <button
              onClick={() => window.dispatchEvent(new Event(BASE_PICK_EVENT))}
              className="w-full mt-1 mx-0 mb-1 px-2 py-1 rounded bg-[#e0a63f]/20 border border-[#e0a63f]/40 text-[#e0a63f] font-semibold hover:bg-[#e0a63f]/30 flex items-center justify-center gap-1.5"
            >
              <Crosshair className="h-3 w-3" /> Set baseline — then click this chart
            </button>
          </ToolMenu>

          {/* breaks — session / hour / prev-day range (per chart) */}
          <ToolMenu
            label="Breaks"
            width="w-56"
            active={Object.values(settings.breaks ?? {}).some(Boolean)}
            tint={Object.values(settings.breaks ?? {}).some(Boolean) ? 'text-[#e0a63f]' : undefined}
            icon={<span className="h-3 w-3 leading-none font-bold text-[10px]">⑂</span>}
            info="Breaks — session 09:15 / 15:30 lines + shading · hourly dividers · prev-day range PDH/PDL with break markers (per chart)"
          >
            {([
              ['session', 'Session breaks', '09:15 / 15:30 IST lines + band', <CalendarRange key="b1" className="h-3 w-3 text-[#e0a63f]" />],
              ['hour', 'Hour breaks', 'dashed line each IST hour in-session', <Clock key="b2" className="h-3 w-3 text-[#8b949e]" />],
              ['range', 'Range breaks', 'PDH/PDL lines + break markers', <ArrowDownUp key="b3" className="h-3 w-3 text-[#5fb0d8]" />],
            ] as [keyof ChartSettings['breaks'], string, string, React.ReactNode][]).map(([k, lbl, hint, ico]) => (
              <label key={k} className="flex items-start gap-2 px-2 py-1 cursor-pointer rounded hover:bg-secondary">
                <input
                  type="checkbox"
                  checked={!!settings.breaks?.[k]}
                  onChange={ev => patchSettings({ breaks: { ...(settings.breaks ?? { session: false, hour: false, range: false }), [k]: ev.target.checked } })}
                  className="accent-[#e0a63f] h-3 w-3 mt-0.5"
                />
                <span className="mt-[1px]">{ico}</span>
                <span>
                  <span className="block">{lbl}</span>
                  <span className="block text-[8px] text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </ToolMenu>

          <TbSep />

          {/* draw tool groups — single row of ICON-ONLY buttons; every flyout item has its own icon */}
          {TOOL_GROUP_ORDER.map(group => {
            const items = TOOL_META.filter(t => t.group === group)
            const grpActive = tool !== 'cursor' && TOOL_META.find(t => t.id === tool)?.group === group
            return (
              <ToolMenu
                key={group}
                label={group}
                width="w-72"
                active={grpActive}
                tint={grpActive ? 'text-[#5fb0d8]' : undefined}
                icon={TOOL_GROUP_ICONS[group]}
                info={`${group} tools — ${items.map(t => t.label).join(' · ')}. Click a tool, then draw on the chart. Del removes selected · Esc cancels.`}
              >
                {items.map(t => (
                  <button
                    key={t.id}
                    onClick={() => { setToolBoth(t.id as DrawTool); pendingRef.current = null }}
                    className={`w-full flex items-center gap-2 px-2 py-1 rounded ${tool === t.id ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
                  >
                    <span className={tool === t.id ? 'text-[#e0a63f]' : 'text-muted-foreground/80'}>{TOOL_ICONS[t.id]}</span>
                    <span className="flex-1 text-left">{t.label}</span>
                    <span className="text-[8px] text-muted-foreground/70 text-right max-w-[118px] leading-tight">{t.hint}</span>
                  </button>
                ))}
                {group === 'Pattern' && (
                  <div className="border-t border-border mt-1 pt-1 px-1 pb-1">
                    <div className="text-[8px] uppercase tracking-wide text-muted-foreground pb-1">pattern — pick one, then click vertices on the chart</div>
                    <div className="grid grid-cols-2 gap-0.5">
                      {PATTERN_NAMES.map(p => (
                        <button
                          key={p}
                          onClick={() => { patternVariantRef.current = p; setToolBoth('pattern'); pendingRef.current = null }}
                          className={`flex items-center gap-1.5 px-1.5 py-1 rounded text-[9px] text-left ${
                            patternVariantRef.current === p && tool === 'pattern'
                              ? 'bg-primary/25 text-foreground'
                              : patternVariantRef.current === p
                                ? 'bg-secondary text-foreground'
                                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                          }`}
                        >
                          <span className={patternVariantRef.current === p ? 'text-[#e0a63f]' : 'text-muted-foreground/70'}>{PATTERN_ICONS[p] ?? <Waves className="h-3 w-3" />}</span>
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </ToolMenu>
            )
          })}

          <TbSep />

          {/* clear all drawings — icon only, count badge when objects exist */}
          <button
            onClick={() => { commitDrawings([]); setSel(null) }}
            title={`Clear all drawings on this chart (${drawings.length} object(s) · Del removes just the selected one)`}
            aria-label="Clear drawings"
            className={`relative flex items-center justify-center h-[22px] w-[26px] rounded border shrink-0 transition-colors ${
              drawings.length > 0 ? 'bg-card/85 border-border text-muted-foreground hover:text-[#ff4d5e] hover:bg-secondary' : 'bg-card/40 border-border/50 text-muted-foreground/50'
            }`}
          >
            <Trash2 className="h-3 w-3" />
            {drawings.length > 0 && <span className="absolute -top-[3px] -right-[3px] min-w-[10px] h-[10px] px-[2px] rounded-full bg-[#e0a63f] text-black text-[7px] font-bold leading-[10px] text-center tabular">{drawings.length}</span>}
          </button>
        </div>
      )}

      {/* annotation text entry (text / note / comment / callout / pin / table) */}
      {textEdit && (
        <div className="absolute z-30" style={{ left: Math.max(2, textEdit.x), top: Math.max(2, textEdit.y) }}>
          {textEdit.multiline ? (
            <textarea
              autoFocus
              value={textEdit.value}
              onChange={ev => setTextEdit({ ...textEdit, value: ev.target.value })}
              onBlur={commitText}
              onKeyDown={ev => {
                if (ev.key === 'Escape') { setTextEdit(null); commitDrawings(drawingsRef.current.filter(d => d.id !== textEdit.id)) }
                if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commitText() }
              }}
              rows={3}
              cols={22}
              className="rounded border border-[#e0a63f]/60 bg-popover text-popover-foreground text-[10px] p-1 outline-none shadow-xl"
            />
          ) : (
            <input
              autoFocus
              value={textEdit.value}
              onChange={ev => setTextEdit({ ...textEdit, value: ev.target.value })}
              onBlur={commitText}
              onKeyDown={ev => {
                if (ev.key === 'Enter') { ev.preventDefault(); commitText() }
                if (ev.key === 'Escape') { setTextEdit(null); commitDrawings(drawingsRef.current.filter(d => d.id !== textEdit.id)) }
              }}
              placeholder={textEdit.multiline ? 'rows…' : 'type…'}
              className="rounded border border-[#e0a63f]/60 bg-popover text-popover-foreground text-[10px] px-1.5 py-0.5 outline-none shadow-xl w-36"
            />
          )}
        </div>
      )}

      {/* active draw tool hint */}
      {showControls && tool !== 'cursor' && (
        <div className="absolute left-1/2 top-1 -translate-x-1/2 px-2 py-0.5 rounded bg-[#5fb0d8]/20 border border-[#5fb0d8]/40 text-[#5fb0d8] text-[9px] font-semibold pointer-events-none whitespace-nowrap">
          {TOOL_META.find(t => t.id === tool)?.label} — {TOOL_META.find(t => t.id === tool)?.hint} · esc cancels
        </div>
      )}
      {baseArmed && (
        <div className="absolute left-1/2 top-1.5 -translate-x-1/2 px-2 py-0.5 rounded bg-[#e0a63f] text-black text-[9px] font-bold pointer-events-none">
          click the chart to set the scales baseline
        </div>
      )}
      {!dirty && !mini && (
        <div className="absolute bottom-6 right-14 text-[9px] text-muted-foreground/60 pointer-events-none flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[#00c896] pulse-dot" /> LIVE
        </div>
      )}
      {dirty && (
        <button
          onClick={resetView}
          title="Reset chart to live price action (latest bar)"
          className="absolute bottom-6 right-14 px-1.5 py-0.5 rounded bg-primary/80 text-primary-foreground text-[9px] font-bold hover:bg-primary shadow flex items-center gap-1"
        >
          <span className="text-[8px]">▶</span> LIVE
        </button>
      )}
    </div>
  )
}

