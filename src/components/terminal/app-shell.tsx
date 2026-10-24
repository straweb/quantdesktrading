'use client'

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, SquareTerminal, Settings2, Bot, LogOut, CircleDot, Trophy, LayoutDashboard, Link2, Unlink, Radio, Pencil, RefreshCw, Wallet, Play, Pause } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { api } from './lib/client-api'
import type { FnoSimResp } from './lib/client-api'
import type { AccountRow } from './lib/client-api'
import { useTerminal, type AppView } from './lib/store'
import { onFeedStatus, ensureSocket } from './lib/socket'
import { useSyncChannel, type SyncCore, type SyncAdmin } from './lib/sync'
import { TerminalView } from './terminal-view'
import { AdminView } from './admin/admin-view'
import { StrategyView } from './strategy/strategy-view'
import { DashboardView } from './dashboard/dashboard-view'
import { CAPITAL_MODES } from '@/lib/types'
import type { CapitalMode } from '@/lib/types'

const MODE_SHORT: Record<CapitalMode, string> = {
  PROFIT_ONLY: 'Profit only',
  INITIAL_PLUS_PNL: 'Initial + PnL',
  INITIAL_WITH_LOSS_REDUCTION: 'Initial − losses',
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`
  if (abs >= 1000) return `₹${(n / 1000).toFixed(1)}k`
  return `₹${Math.round(n)}`
}

/** Slider max for the fixed-₹ capital editor — ~125% of the account's
 *  available cash (or ₹10L when cash is unknown), rounded to a clean step. */
function fixedSliderMax(cash: number | null | undefined): number {
  const base = Math.max(100_000, Math.ceil(((cash ?? 0) * 1.25) / 50_000) * 50_000)
  return Math.max(base, 1_000_000)
}

/** Round a rupee slider position to a clean step value. */
function snapStep(v: number, step = 5_000): number {
  return Math.round(v / step) * step
}

// broker icon glyph + tint — replaces the full account label on the chip
// (saves horizontal space; the label lives in the tooltip + popover)
const BROKER_ICON: Record<string, { glyph: string; cls: string }> = {
  SIMFEED: { glyph: '⚡', cls: 'bg-slate-500/25 text-slate-300' },
  DHAN: { glyph: 'D', cls: 'bg-[#3b82f6]/25 text-[#60a5fa]' },
  SHOONYA: { glyph: 'S', cls: 'bg-[#8b5cf6]/25 text-[#a78bfa]' },
  ICICI_BREEZE: { glyph: 'iB', cls: 'bg-[#f97316]/25 text-[#fb923c]' },
}
function brokerIcon(brokerType: string) {
  return BROKER_ICON[brokerType] ?? { glyph: brokerType.slice(0, 1) ?? '?', cls: 'bg-secondary text-muted-foreground' }
}

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 1000 } },
})

export function TradingTerminalApp() {
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  )
}

function Shell() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  const [feedUp, setFeedUp] = useState(true)
  const [now, setNow] = useState('')
  const setView = useTerminal(s => s.setView)
  const view = useTerminal(s => s.view)

  useEffect(() => {
    // rehydrate persisted workspaces AFTER first render — prevents the
    // React hydration mismatch ("attributes of the server rendered HTML
    // didn't match the client properties") caused by localStorage state
    // diverging from server-rendered defaults.
    void useTerminal.persist.rehydrate()
    // debug/E2E hook (harmless in prod)
    ;(window as unknown as { __qdStore?: typeof useTerminal }).__qdStore = useTerminal
    api.me().then(r => setUser(r.user)).catch(() => setUser(null))
    ensureSocket()
    return onFeedStatus(setFeedUp)
  }, [])

  useEffect(() => {
    const iv = setInterval(() => setNow(new Date().toLocaleTimeString('en-IN', { hour12: false })), 1000)
    return () => clearInterval(iv)
  }, [])

  if (user === undefined) {
    return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Loading terminal…</div>
  }
  if (!user) return <LoginGate onLogin={() => api.me().then(r => setUser(r.user))} />

  return (
    <div className="h-full flex flex-col">
      {/* top bar */}
      <header className="flex items-center gap-3 px-3 h-10 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-primary" />
          <span className="text-sm font-bold tracking-tight">QuantDesk</span>
          <span className="text-[9px] text-muted-foreground mt-0.5">multi-broker terminal</span>
        </div>

        <nav className="flex items-center gap-1 ml-4">
          {([
            ['terminal', 'Terminal', SquareTerminal],
            ['dashboard', 'Dashboard', LayoutDashboard],
            ['strategy', 'Strategy Builder', Bot],
            ['admin', 'Admin', Settings2],
          ] as [AppView, string, typeof SquareTerminal][]).map(([v, label, Icon]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] transition-colors ${
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              <Icon className="h-3 w-3" /> {label}
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        {/* per-account capital chips — quick enable + capital sizing */}
        <CapitalChips />
        <SessionStatsChip />

        <div className="flex items-center gap-2 text-[10px]">
          <SessionPlayChip />
          <FeedChip up={feedUp} />
          <span className="tabular text-muted-foreground">{now} IST</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => api.logout().then(() => setUser(null))}>
            <LogOut className="h-3 w-3" /> admin
          </Button>
        </div>
      </header>

      {/* body */}
      <main className="flex-1 min-h-0">
        {view === 'terminal' && <TerminalView />}
        {view === 'admin' && <AdminView />}
        {view === 'strategy' && <StrategyView />}
        {view === 'dashboard' && <DashboardView />}
      </main>
    </div>
  )
}

// ------------------------------------------------------------
// Capital chips (top-right): one chip per broker account.
// Click a chip to enable/disable order routing and edit the
// account's capital sizing (initial capital + house mode).
// ------------------------------------------------------------
function CapitalChips() {
  // realtime: sync:core pushes accounts every 1s (fallback: REST when the
  // feed socket has never delivered a payload)
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.accounts(),
    enabled: !sync,
    refetchInterval: 3000,
  })
  const accounts: AccountRow[] = sync?.accounts
    ? (sync.accounts as unknown as AccountRow[])
    : (data?.accounts ?? [])
  if (accounts.length === 0) return null
  return (
    <div className="flex items-center gap-1 max-w-[44vw] overflow-x-auto py-0.5">
      {accounts.map(a => <CapitalChip key={a.id} acc={a} />)}
    </div>
  )
}

function CapitalChip({ acc }: { acc: AccountRow }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [capital, setCapital] = useState(String(acc.initialCapitalFixed ?? acc.initialCapital))
  const [pct, setPct] = useState(String(acc.capitalPct ?? 100))
  const [base, setBase] = useState<'FIXED' | 'AVAILABLE_CASH_PCT'>(acc.capitalBase ?? 'FIXED')
  const [mode, setMode] = useState<CapitalMode>(acc.mode ?? 'INITIAL_PLUS_PNL')
  const [busy, setBusy] = useState(false)

  // (re)seed the editor fields each time the popover opens — avoids the
  // setState-in-effect cascade lint rule
  const openEditor = (next: boolean) => {
    setOpen(next)
    if (next) {
      setCapital(String(acc.initialCapitalFixed ?? acc.initialCapital))
      setPct(String(acc.capitalPct ?? 100))
      setBase(acc.capitalBase ?? 'FIXED')
      setMode(acc.mode ?? 'INITIAL_PLUS_PNL')
    }
  }

  const toggleEnabled = async (next: boolean) => {
    try {
      await api.patchAccount(acc.id, { isOrderEnabled: next })
      await qc.invalidateQueries({ queryKey: ['accounts'] })
      toast.success(`${acc.label} order routing ${next ? 'enabled' : 'disabled'}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const cash = acc.availableCash ?? null
  const pctPreview = base === 'AVAILABLE_CASH_PCT' && cash != null ? Math.max(0, cash * ((Number(pct) || 0) / 100)) : null

  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { mode, capitalBase: base }
      if (base === 'AVAILABLE_CASH_PCT') {
        body.capitalPct = Math.min(100, Math.max(0, Number(pct) || 0))
      } else {
        body.initialCapital = Number(capital) || 0
      }
      await api.patchAccount(acc.id, body)
      await qc.invalidateQueries({ queryKey: ['accounts'] })
      await qc.invalidateQueries({ queryKey: ['funds'] })
      const desc = base === 'AVAILABLE_CASH_PCT'
        ? `${body.capitalPct}% of available cash${cash != null ? ` (₹${fmtCompact(pctPreview ?? 0)})` : ''}`
        : fmtCompact(Number(capital) || 0)
      toast.success(`${acc.label} capital updated — ${desc} · ${MODE_SHORT[mode]}`)
      setOpen(false)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    setBusy(false)
  }

  return (
    <Popover open={open} onOpenChange={openEditor}>
      <PopoverTrigger asChild>
        <button
          className={`flex items-center gap-1 h-6 pl-1 pr-1.5 rounded-full border transition-colors ${
            acc.isOrderEnabled
              ? 'border-[#00c896]/40 bg-up text-foreground hover:bg-up/70'
              : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground'
          }`}
          title={`${acc.label} (${acc.brokerType}) — usable ${fmtCompact(acc.usableCapital)} · ${acc.capitalBase === 'AVAILABLE_CASH_PCT' ? `${acc.capitalPct}% of available cash` : 'fixed ₹ capital'} · click to manage capital sizing`}
        >
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${acc.isOrderEnabled ? 'bg-[#00c896]' : 'bg-muted-foreground/50'}`} />
          <span className={`h-4 w-4 rounded text-[8px] font-bold grid place-items-center shrink-0 ${brokerIcon(acc.brokerType).cls}`}>
            {brokerIcon(acc.brokerType).glyph}
          </span>
          <span className="tabular font-bold text-[9px]">{fmtCompact(acc.usableCapital)}</span>
          {acc.capitalBase === 'AVAILABLE_CASH_PCT' && (
            <span className="text-[8px] font-bold text-[#e0a63f] tabular">{acc.capitalPct}%</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3 space-y-2.5 text-[11px]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-bold text-xs truncate">{acc.label}</div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{acc.brokerType}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[9px] text-muted-foreground">usable</div>
            <div className="tabular font-bold text-[#00c896]">{fmtCompact(acc.usableCapital)}</div>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Order routing</span>
          <Switch checked={acc.isOrderEnabled} onCheckedChange={toggleEnabled} />
        </div>
        <div className="space-y-1">
          <div className="text-[9px] text-muted-foreground">Capital source</div>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => { setBase('FIXED'); setCapital(String((acc.initialCapitalFixed ?? acc.initialCapital) || 500000)) }}
              className={`px-2 py-1 rounded text-[10px] font-semibold border ${base === 'FIXED' ? 'bg-primary/20 border-primary/50 text-foreground' : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground'}`}
            >Fixed ₹</button>
            <button
              onClick={() => { setBase('AVAILABLE_CASH_PCT'); setPct(String(acc.capitalPct ?? 100)) }}
              className={`px-2 py-1 rounded text-[10px] font-semibold border ${base === 'AVAILABLE_CASH_PCT' ? 'bg-primary/20 border-primary/50 text-foreground' : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground'}`}
            >% of cash</button>
          </div>
        </div>
        {base === 'FIXED' ? (
          <div className="space-y-1">
            <div className="text-[9px] text-muted-foreground">Capital size (₹)</div>
            <div className="flex items-center gap-2">
              <Slider
                value={[Math.min(fixedSliderMax(cash), Number(capital) || 0)]}
                min={0}
                max={fixedSliderMax(cash)}
                step={5_000}
                onValueChange={v => setCapital(String(snapStep(v[0])))}
                className="flex-1 [&_[data-slot=slider-thumb]]:h-3 [&_[data-slot=slider-thumb]]:w-3"
              />
              <Input
                value={capital}
                onChange={e => setCapital(e.target.value.replace(/[^0-9.]/g, ''))}
                className="h-7 text-[11px] tabular w-24"
              />
            </div>
            <div className="text-[8px] text-muted-foreground">slider steps ₹5k · type any amount in the box</div>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
              <span>Share of available cash</span>
              {cash != null && <span className="tabular">cash {fmtCompact(cash)}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Slider
                value={[Math.min(100, Number(pct) || 0)]}
                min={1}
                max={100}
                step={1}
                onValueChange={v => setPct(String(v[0]))}
                className="flex-1 [&_[data-slot=slider-thumb]]:h-3 [&_[data-slot=slider-thumb]]:w-3"
              />
              <Input
                value={pct}
                onChange={e => setPct(e.target.value.replace(/[^0-9.]/g, ''))}
                className="h-7 text-[11px] tabular w-16"
              />
              <span className="text-muted-foreground">%</span>
            </div>
            {pctPreview != null && (
              <div className="tabular font-bold text-[#00c896] text-[10px]">= {fmtCompact(pctPreview)}</div>
            )}
            <div className="text-[8px] text-muted-foreground leading-snug">Recomputed live from the account&apos;s available cash on every sizing call — tracks the real balance (sizing mode is bypassed; PnL is already inside the cash).</div>
          </div>
        )}
        {base === 'AVAILABLE_CASH_PCT' && (
          <div className="text-[8px] text-[#e0a63f] leading-snug bg-[#e0a63f]/10 rounded px-1.5 py-1">
            Live brokers: the cash base comes from the broker funds API (auto-refreshed every 45s) — press <b>Pull funds</b> to fetch it right now.
          </div>
        )}
        <div className="space-y-1">
          <div className="text-[9px] text-muted-foreground">Sizing mode</div>
          <Select value={mode} onValueChange={v => setMode(v as CapitalMode)}>
            <SelectTrigger className="h-7 text-[11px] w-full">
              <SelectValue>{MODE_SHORT[mode]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CAPITAL_MODES) as CapitalMode[]).map(m => (
                <SelectItem key={m} value={m} textValue={MODE_SHORT[m]} title={CAPITAL_MODES[m].detail}>
                  {MODE_SHORT[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="text-[8px] text-muted-foreground leading-snug">{CAPITAL_MODES[mode].detail}</div>
        </div>
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[9px] text-muted-foreground">
            realized <b className={acc.realizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(acc.realizedPnl)}</b>
          </span>
          <div className="flex items-center gap-1">
            {acc.brokerType !== 'SIMFEED' && (
              <Button
                size="sm" variant="secondary"
                className="h-7 px-2 text-[10px] gap-1"
                disabled={busy}
                title="Pull the REAL broker available cash now (funds API) — the % base uses this number"
                onClick={async () => {
                  setBusy(true)
                  try {
                    const r = await api.syncFunds(acc.id)
                    if (r.ok) toast.success(`${acc.label} funds pulled — ${r.message ?? fmtCompact(r.cash ?? 0)}`)
                    else toast.error(r.message ?? 'Funds pull failed')
                    await qc.invalidateQueries({ queryKey: ['accounts'] })
                  } catch (e) { toast.error(e instanceof Error ? e.message : 'Funds pull failed') }
                  setBusy(false)
                }}
              >
                <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} /> Pull funds
              </Button>
            )}
            <Button size="sm" className="h-7 px-3 text-[10px]" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Apply'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ------------------------------------------------------------
// Session stats chip — win rate + points captured this session,
// with a per-account breakdown popover.
// ------------------------------------------------------------
interface SessionStats {
  winRate: number | null
  pts: number
  realized: number
  unrealized: number
  net: number
  pocket?: number
  closes: number
  wins: number
  trades: number
  charges: number
  perAccount: { accountId: string; label: string; brokerType: string; trades: number; closes: number; wins: number; pts: number; realized: number; unrealized: number; charges: number; pocket?: number }[]
  topSymbols: { symbol: string; pts: number }[]
}

function SessionStatsChip() {
  // realtime: sync:core carries the same session payload computed in the
  // feed service (win rate / pts / per-account) — REST fallback if absent
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data: rest } = useQuery({
    queryKey: ['session-stats'],
    queryFn: () => api.sessionStats(),
    enabled: !sync,
    refetchInterval: 6000,
  })
  const data = sync?.session ?? rest
  if (!data) return null
  const wr = data.winRate
  const pos = data.pts >= 0
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1 px-1.5 py-1 rounded border border-border bg-card text-[10px] hover:bg-secondary/60 transition-colors"
          title="Session performance — win rate + net points captured (click for per-account breakdown)"
        >
          <Trophy className={`h-3 w-3 ${pos ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`} />
          <span className="tabular font-bold">{wr != null ? `${wr.toFixed(0)}%` : '—'}</span>
          <span className="text-muted-foreground">WR</span>
          <span className="w-px h-3 bg-border" />
          <span className={`tabular font-bold ${pos ? 'term-up' : 'term-down'}`}>
            {pos ? '+' : ''}{data.pts.toFixed(1)} pts
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 text-[11px] space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground">current session</span>
          <span className="text-[9px] text-muted-foreground">{data.trades} trades · {data.closes} closed</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded bg-secondary/50 p-1.5">
            <div className="text-[8px] text-muted-foreground">WIN RATE</div>
            <div className="tabular font-bold text-sm">{wr != null ? `${wr.toFixed(1)}%` : '—'}</div>
            <div className="text-[8px] text-muted-foreground">{data.wins}W / {data.closes - data.wins}L</div>
          </div>
          <div className="rounded bg-secondary/50 p-1.5">
            <div className="text-[8px] text-muted-foreground">NET POINTS</div>
            <div className={`tabular font-bold text-sm ${data.pts >= 0 ? 'term-up' : 'term-down'}`}>{data.pts >= 0 ? '+' : ''}{data.pts.toFixed(1)}</div>
            <div className={`text-[8px] tabular ${data.net >= 0 ? 'term-up' : 'term-down'}`}>net {fmtCompact(data.net)}</div>
          </div>
        </div>
        <div className="flex gap-3 text-[9px] text-muted-foreground tabular">
          <span>realized <b className={data.realized >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(data.realized)}</b></span>
          <span>unrealized <b className={data.unrealized >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(data.unrealized)}</b></span>
          <span>charges {fmtCompact(data.charges)}</span>
          <span title="NET in pocket after ALL charges — exit every open position at LTP now (brokerage + STT + txn + GST + SEBI + stamp)">
            pocket <b className={(data.pocket ?? data.net) >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'}>{fmtCompact(data.pocket ?? data.net)}</b>
          </span>
        </div>
        {data.perAccount.length > 0 && (
          <div className="border-t border-border/60 pt-1.5 space-y-0.5">
            <div className="text-[8px] uppercase tracking-wide text-muted-foreground">per account (pocket = NET after all charges if exited at LTP)</div>
            {data.perAccount.map(a => {
              const net = a.pocket ?? (a.realized + a.unrealized)
              return (
                <div key={a.accountId} className="flex items-center justify-between text-[10px]">
                  <span className="flex items-center gap-1 min-w-0">
                    <span className={`h-3 w-3 rounded text-[7px] font-bold grid place-items-center shrink-0 ${brokerIcon(a.brokerType).cls}`}>{brokerIcon(a.brokerType).glyph}</span>
                    <span className="truncate text-muted-foreground">{a.label}</span>
                  </span>
                  <span className="tabular shrink-0">
                    <span className="text-muted-foreground mr-1.5">{a.closes ? `${((a.wins / a.closes) * 100).toFixed(0)}%` : '—'}</span>
                    <b className={net >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(net)}</b>
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {data.topSymbols.length > 0 && (
          <div className="border-t border-border/60 pt-1.5">
            <div className="text-[8px] uppercase tracking-wide text-muted-foreground mb-0.5">pts by symbol</div>
            <div className="flex flex-wrap gap-1">
              {data.topSymbols.map(s => (
                <span key={s.symbol} className={`px-1 py-0.5 rounded text-[9px] tabular ${s.pts >= 0 ? 'bg-up text-[#00c896]' : 'bg-down text-[#ff4d5e]'}`}>
                  {s.symbol} {s.pts >= 0 ? '+' : ''}{s.pts.toFixed(1)}
                </span>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ------------------------------------------------------------
// Session Simulator play/pause chip — appears beside the FEED
// badge whenever a simulator session is prepared/running (manual
// start: prepare gives the user a break; Play starts the day,
// Pause freezes the replay clock mid-session).
// ------------------------------------------------------------
function SessionPlayChip() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const { data } = useQuery({
    queryKey: ['fnosim'],
    queryFn: () => api.fnosim(),
    refetchInterval: (q) => ((q.state.data as FnoSimResp | undefined)?.status.active ? 2000 : 12000),
  })
  useEffect(() => {
    // instant chip updates on session ready/playing/paused/completed pushes
    let off: (() => void) | undefined
    try {
      const s = ensureSocket()
      const h = () => qc.invalidateQueries({ queryKey: ['fnosim'] })
      s.on('fnosim', h)
      off = () => { try { s.off('fnosim', h) } catch { /* ignore */ } }
    } catch { /* socket not ready — polling covers it */ }
    return off
  }, [qc])
  const st = data?.status
  if (!st?.active) return null
  const playing = !!st.playing
  const toggle = async () => {
    setBusy(true)
    try {
      await (playing ? api.fnosimPause() : api.fnosimPlay())
      await qc.invalidateQueries({ queryKey: ['fnosim'] })
    } catch { /* keep the chip honest — the poll refreshes state */ }
    setBusy(false)
  }
  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={playing
        ? `Session Simulator RUNNING — ${st.underlying} · ${st.cursor?.slice(11) ?? ''} IST · ${st.progressPct}% — click to PAUSE the day`
        : `Session Simulator READY — ${st.underlying} · history loaded (${st.historyDays ?? 0} days) — click to PLAY and start the day`}
      className={`flex items-center gap-1 px-1.5 py-1 rounded border text-[10px] transition-colors ${
        playing
          ? 'border-[#00c896]/50 bg-[#00c896]/10 text-[#00c896] hover:bg-[#00c896]/20'
          : 'border-[#f5a623]/50 bg-[#f5a623]/10 text-[#f5a623] hover:bg-[#f5a623]/20'
      } ${busy ? 'opacity-60' : ''}`}
    >
      {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      <span className="font-bold">{playing ? 'SIM DAY' : 'READY'}</span>
      <span className="tabular">{st.progressPct > 0 ? `${st.progressPct}%` : (st.cursor?.slice(11) ?? '0%')}</span>
    </button>
  )
}

// ------------------------------------------------------------
// Feed status chip — click to see / switch the market-data
// source. Radio semantics: exactly ONE feed source is active
// (Sim built-in or one broker account's feed adapter).
// Round-8: each account row carries ICON BUTTONS for
// connect / disconnect (account active state) and live feed
// enable / disable (set as the active source or fall back to
// sim), plus the account's live PnL and capital.
// Round-10: per-row LIVE-FEED health (ticking / last tick age /
// last error from the feed service), a capital quick editor
// (% of cash / fixed ₹, editable anytime — even while connected)
// and a one-click "pull real funds" action.
// ------------------------------------------------------------
function FeedChip({ up }: { up: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [capEdit, setCapEdit] = useState<string | null>(null)
  const [capBase, setCapBase] = useState<'FIXED' | 'AVAILABLE_CASH_PCT'>('AVAILABLE_CASH_PCT')
  const [capVal, setCapVal] = useState('25')
  // admin plane over the websocket (2s push) — replaces the feed-source +
  // feed-status REST polls; REST stays as the fallback when the socket is down
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data } = useQuery({ queryKey: ['feed-source'], queryFn: () => api.feedSource(), enabled: !adm, refetchInterval: 8000 })
  // live broker feed engine health (ticking? last error?)
  const { data: feedSt } = useQuery({ queryKey: ['feed-status'], queryFn: () => api.feedStatus(), enabled: !adm, refetchInterval: 5000, retry: false })
  const feedStatus = adm?.feed ?? feedSt
  // realtime PnL / capital / connection state straight from sync:core
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data: restAccs } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.accounts(),
    enabled: !sync,
    refetchInterval: 5000,
  })
  const accounts: AccountRow[] = sync?.accounts
    ? (sync.accounts as unknown as AccountRow[])
    : (restAccs?.accounts ?? [])
  const source = adm?.feedSource.source ?? data?.source ?? 'sim'
  const simDisabled = adm?.feedSource.simDisabled ?? data?.simDisabled ?? false
  const sources = adm?.feedSource.sources ?? data?.sources ?? []
  const bumpDataEpoch = useTerminal(s => s.bumpDataEpoch)
  const current = sources.find(s => s.id === source)
  const accById = new Map(accounts.map(a => [a.id, a]))
  const tickAge = feedStatus?.lastTickTs ? Math.max(0, Math.round((Date.now() - feedStatus.lastTickTs) / 1000)) : null

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['feed-source'] }),
      qc.invalidateQueries({ queryKey: ['accounts'] }),
      qc.invalidateQueries({ queryKey: ['feed-status'] }),
    ])
  }

  const pick = async (id: string) => {
    if (id === source || busy) return
    // Live-Only mode: sandbox accounts (no broker session) can never be the
    // data source — block at the UI level (the API refuses them too)
    if (simDisabled && id !== 'sim') {
      const row = sources.find(s => s.id === id)
      const sessioned = accById.get(id)?.hasSession ?? row?.hasSession ?? false
      if (!sessioned) {
        toast.error(`${row?.label ?? 'This account'} has no broker session (sandbox) — Live-Only mode requires a live account. Create the session in Admin → Session.`)
        return
      }
    }
    setBusy(true)
    try {
      await api.setFeedSource(id)
      await refresh()
      // purge every client-side market-data holder (candles, ghost, ticks,
      // depth books) — sim data must never linger under a real-broker source
      bumpDataEpoch()
      const label = sources.find(s => s.id === id)?.label ?? id
      toast.success(`Market data source → ${label}${id === 'sim' ? '' : ' (sim data cleared)'}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Switch failed')
    } finally { setBusy(false) }
  }

  const toggleAccount = async (id: string, next: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await api.patchAccount(id, { isActive: next })
      await refresh()
      const a = accById.get(id)
      toast.success(`${a?.label ?? 'Account'} ${next ? 'connected' : 'disconnected'}${!next && source === id ? ' — feed fell back to Sim' : ''}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally { setBusy(false) }
  }

  const toggleFeed = async (id: string) => {
    // if this account already feeds the terminal -> disable (back to sim);
    // otherwise enable it as the active source
    await pick(source === id ? 'sim' : id)
  }

  const pullFunds = async (id: string) => {
    setBusy(true)
    try {
      const r = await api.syncFunds(id)
      if (r.ok) toast.success(`Funds pulled — ${r.message ?? fmtCompact(r.cash ?? 0)}`)
      else toast.error(r.message ?? 'Funds pull failed — check Admin → Broker Diagnostics')
      await refresh()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Funds pull failed') }
    setBusy(false)
  }

  const saveCap = async (id: string) => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { capitalBase: capBase }
      if (capBase === 'AVAILABLE_CASH_PCT') body.capitalPct = Math.min(100, Math.max(1, Number(capVal) || 25))
      else body.initialCapital = Number(capVal) || 0
      await api.patchAccount(id, body)
      await refresh()
      toast.success(`Capital updated — ${capBase === 'AVAILABLE_CASH_PCT' ? `${body.capitalPct}% of available cash` : fmtCompact(Number(capVal) || 0)}`)
      setCapEdit(null)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    setBusy(false)
  }

  const openCapEdit = (acc: AccountRow) => {
    setCapEdit(acc.id)
    setCapBase(acc.capitalBase ?? 'AVAILABLE_CASH_PCT')
    setCapVal(String(acc.capitalBase === 'AVAILABLE_CASH_PCT' ? (acc.capitalPct ?? 100) : (acc.initialCapitalFixed ?? acc.initialCapital)))
  }

  // live-feed health for the ACTIVE broker source
  const liveHealthy = !!feedStatus?.sourceIsLive && !!feedStatus?.fresh
  const liveErr = feedStatus?.sourceIsLive ? feedStatus?.lastError : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`flex items-center gap-1 px-1.5 py-1 rounded border transition-colors ${
            up ? 'border-[#00c896]/30 bg-up/40 text-[#00c896] hover:bg-up/60' : 'border-[#ff4d5e]/30 bg-down/40 text-[#ff4d5e] hover:bg-down/60'
          }`}
          title={`Market data source — click to view / switch${source !== 'sim' ? ` · live feed ${liveHealthy ? 'ticking' : `STALLED${liveErr ? `: ${liveErr}` : ''}`}` : ''}`}
        >
          <CircleDot className={`h-3 w-3 ${up ? 'pulse-dot' : ''}`} />
          <span className="font-bold">FEED {up ? 'LIVE' : 'DOWN'}</span>
          {source !== 'sim' && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${liveHealthy ? 'bg-[#00c896] pulse-dot' : 'bg-[#e0a63f]'}`}
              title={liveHealthy ? `live broker data ticking (${feedStatus?.symbols} symbols · last ${tickAge}s ago)` : `live data stalled${liveErr ? ` — ${liveErr}` : ' — waiting for ticks'}`}
            />
          )}
          <span className="max-w-[110px] truncate text-foreground/80">{current?.label ?? 'Sim Feed'}</span>
          {simDisabled && <span className="px-1 rounded bg-[#e0a63f]/20 text-[#e0a63f] text-[8px] font-bold" title="Live-Only mode (admin) — sim feed disabled">LIVE-ONLY</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-2 text-[11px] space-y-1">
        <div className="px-1 pb-1 text-[9px] text-muted-foreground leading-snug">
          Market data source — one feed active at a time. Live rows show real feed health; click <b>cap</b> to change % / fixed capital anytime, even while connected.
        </div>
        {feedStatus?.sourceIsLive && (
          <div className={`mx-1 rounded px-2 py-1.5 text-[9px] leading-snug border ${
            liveHealthy ? 'border-[#00c896]/30 bg-up/30 text-[#00c896]' : 'border-[#e0a63f]/40 bg-[#e0a63f]/10 text-[#e0a63f]'
          }`}>
            {liveHealthy
              ? <>Live broker feed ticking — {feedStatus.symbols} symbols · last tick {tickAge}s ago · {feedStatus.polls} polls</>
              : <>Live feed NOT flowing{feedStatus.lastError ? ` — ${feedStatus.lastError}` : ''}{!feedStatus.sessionPresent ? ' · no session — create it in Admin → Session' : ''} · details in Admin → Broker Diagnostics</>}
          </div>
        )}
        {sources.map(s => {
          const acc = s.id === 'sim' ? null : accById.get(s.id)
          const isSrc = s.id === source
          return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => pick(s.id)}
              onKeyDown={e => { if (e.key === 'Enter') pick(s.id) }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors cursor-pointer ${
                isSrc ? 'bg-primary/20 border border-primary/50' : 'hover:bg-secondary border border-transparent'
              } ${acc && !acc.isActive ? 'opacity-60' : ''}`}
            >
              <span className={`h-2.5 w-2.5 rounded-full border shrink-0 flex items-center justify-center ${
                isSrc ? 'border-primary' : 'border-muted-foreground/40'
              }`}>
                {isSrc && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </span>
              <span className={`h-4 w-4 rounded text-[8px] font-bold grid place-items-center shrink-0 ${s.id === 'sim' ? 'bg-slate-500/25 text-slate-300' : brokerIcon(s.brokerType ?? '').cls}`}>
                {s.id === 'sim' ? '⚡' : brokerIcon(s.brokerType ?? '').glyph}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-medium">{s.label}</span>
                  {acc && <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${acc.isActive ? 'bg-[#00c896]' : 'bg-[#ff4d5e]'}`} title={acc.isActive ? 'connected' : 'disconnected'} />}
                </span>
                {acc ? (
                  <span className="flex items-center gap-2 text-[8px] tabular mt-0.5">
                    <span className="uppercase tracking-wide text-muted-foreground">{s.brokerType}</span>
                    {/* LIVE vs SANDBOX — session presence (round 13: the Live-Only
                        mode must never silently sit on a sandbox account) */}
                    <span
                      className={`px-1 rounded font-bold ${
                        acc.hasSession
                          ? 'bg-[#00c896]/15 text-[#00c896]'
                          : 'bg-[#e0a63f]/15 text-[#e0a63f]'
                      }`}
                      title={acc.hasSession ? 'broker session present — live account' : 'no broker session — sandbox account (Live-Only mode cannot use it)'}
                    >
                      {acc.hasSession ? 'LIVE' : 'SANDBOX'}
                    </span>
                    {!acc.hasSession && simDisabled && (
                      <span className="text-[#e0a63f]" title="Live-Only mode — create the session in Admin → Session to use this account">session required</span>
                    )}
                    <span className={acc.realizedPnl >= 0 ? 'term-up' : 'term-down'}>
                      PnL {acc.realizedPnl >= 0 ? '+' : ''}{fmtCompact(acc.realizedPnl)}
                    </span>
                    {/* capital quick editor — click to change %/fixed, editable even while connected */}
                    <button
                      onClick={e => { e.stopPropagation(); openCapEdit(acc) }}
                      className="flex items-center gap-1 text-muted-foreground hover:text-foreground underline decoration-dotted"
                      title="Edit capital — % of available cash or fixed ₹ (works while connected)"
                    >
                      cap <b className="text-foreground">{fmtCompact(acc.usableCapital)}</b>
                      {acc.capitalBase === 'AVAILABLE_CASH_PCT' && <span className="text-[#e0a63f] font-bold">{acc.capitalPct}%</span>}
                      <Pencil className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ) : (
                  <span className="block text-[8px] text-muted-foreground uppercase tracking-wide">built-in synthetic feed</span>
                )}
              </span>
              {acc && (
                <span className="flex items-center gap-0.5 shrink-0">
                  {/* pull REAL broker funds into the % base */}
                  <button
                    onClick={e => { e.stopPropagation(); pullFunds(acc.id) }}
                    disabled={busy}
                    title="Pull available cash from the broker funds API now"
                    className="p-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  >
                    <Wallet className="h-3 w-3" />
                  </button>
                  {/* connect / disconnect the account itself */}
                  <button
                    onClick={e => { e.stopPropagation(); toggleAccount(acc.id, !acc.isActive) }}
                    disabled={busy}
                    title={acc.isActive ? 'Disconnect account' : 'Connect account'}
                    className={`p-1 rounded border transition-colors ${
                      acc.isActive
                        ? 'border-[#00c896]/40 text-[#00c896] hover:bg-[#00c896]/20'
                        : 'border-[#ff4d5e]/40 text-[#ff4d5e] hover:bg-[#ff4d5e]/20'
                    }`}
                  >
                    {acc.isActive ? <Link2 className="h-3 w-3" /> : <Unlink className="h-3 w-3" />}
                  </button>
                  {/* live feed enable / disable for this account */}
                  <button
                    onClick={e => { e.stopPropagation(); toggleFeed(acc.id) }}
                    disabled={busy || (simDisabled && !isSrc && !(acc.hasSession ?? sources.find(x => x.id === acc.id)?.hasSession))}
                    title={
                      isSrc ? 'Disable this account feed (back to Sim)'
                      : simDisabled && !(acc.hasSession ?? sources.find(x => x.id === acc.id)?.hasSession)
                        ? 'Blocked — Live-Only mode: this sandbox account has no broker session'
                        : 'Enable this account as the live feed'
                    }
                    className={`p-1 rounded border transition-colors ${
                      isSrc
                        ? 'border-primary/60 text-primary bg-primary/15'
                        : busy || (simDisabled && !isSrc && !(acc.hasSession ?? sources.find(x => x.id === acc.id)?.hasSession))
                          ? 'border-border/50 text-muted-foreground/40 cursor-not-allowed'
                          : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
                    }`}
                  >
                    <Radio className={`h-3 w-3 ${isSrc ? 'pulse-dot' : ''}`} />
                  </button>
                </span>
              )}
              {s.id === 'sim' && isSrc && <span className="text-[8px] font-bold text-primary shrink-0">ACTIVE</span>}
            </div>
          )
        })}
        {/* inline capital editor for the selected row */}
        {capEdit && accById.get(capEdit) && (() => {
          const acc = accById.get(capEdit)!
          const cash = acc.availableCash ?? null
          const preview = capBase === 'AVAILABLE_CASH_PCT' && cash != null ? Math.max(0, cash * ((Number(capVal) || 0) / 100)) : null
          return (
            <div className="mx-1 mt-1 rounded border border-primary/40 bg-primary/5 p-2 space-y-1.5" onClick={e => e.stopPropagation()}>
              <div className="text-[10px] font-bold">Capital — {acc.label}</div>
              <div className="grid grid-cols-2 gap-1">
                <button
                  onClick={() => { setCapBase('AVAILABLE_CASH_PCT'); setCapVal(String(acc.capitalPct ?? 100)) }}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border ${capBase === 'AVAILABLE_CASH_PCT' ? 'bg-primary/20 border-primary/50' : 'bg-secondary/50 border-border text-muted-foreground'}`}
                >% of cash</button>
                <button
                  onClick={() => { setCapBase('FIXED'); setCapVal(String((acc.initialCapitalFixed ?? acc.initialCapital) || 500000)) }}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border ${capBase === 'FIXED' ? 'bg-primary/20 border-primary/50' : 'bg-secondary/50 border-border text-muted-foreground'}`}
                >Fixed ₹</button>
              </div>
              {capBase === 'AVAILABLE_CASH_PCT' ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Slider
                      value={[Math.min(100, Number(capVal) || 0)]}
                      min={1}
                      max={100}
                      step={1}
                      onValueChange={v => setCapVal(String(v[0]))}
                      className="flex-1 [&_[data-slot=slider-thumb]]:h-3 [&_[data-slot=slider-thumb]]:w-3"
                      title={`${capVal}% of available cash`}
                    />
                    <Input
                      value={capVal}
                      onChange={e => setCapVal(e.target.value.replace(/[^0-9.]/g, ''))}
                      className="h-7 text-[11px] tabular w-16"
                      placeholder="25"
                    />
                    <span className="text-muted-foreground text-[10px]">%</span>
                  </div>
                  {preview != null && (
                    <div className="tabular text-[10px] font-bold text-[#00c896]">= {fmtCompact(preview)} deployable</div>
                  )}
                  {cash != null && (
                    <div className="text-[8px] text-muted-foreground">broker cash {fmtCompact(cash)} — auto-refreshed from the funds API every 45s</div>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Slider
                      value={[Math.min(fixedSliderMax(cash), Number(capVal) || 0)]}
                      min={0}
                      max={fixedSliderMax(cash)}
                      step={5_000}
                      onValueChange={v => setCapVal(String(snapStep(v[0])))}
                      className="flex-1 [&_[data-slot=slider-thumb]]:h-3 [&_[data-slot=slider-thumb]]:w-3"
                      title={`₹${Number(capVal) || 0} fixed capital`}
                    />
                    <Input
                      value={capVal}
                      onChange={e => setCapVal(e.target.value.replace(/[^0-9.]/g, ''))}
                      className="h-7 text-[11px] tabular w-24"
                      placeholder="500000"
                    />
                    <span className="text-muted-foreground text-[10px]">₹</span>
                  </div>
                  <div className="text-[8px] text-muted-foreground">slider steps ₹5k (max {fmtCompact(fixedSliderMax(cash))}) · type any amount in the box</div>
                </div>
              )}
              <div className="flex items-center justify-between pt-0.5">
                <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setCapEdit(null)}>cancel</button>
                <Button size="sm" className="h-6 px-2.5 text-[10px]" disabled={busy} onClick={() => saveCap(acc.id)}>Save</Button>
              </div>
            </div>
          )
        })()}
        <div className="px-1 pt-1 text-[8px] text-muted-foreground leading-snug">
          Live broker feeds poll the broker quote APIs every second (Dhan batched / Shoonya Noren / Breeze) and skip the sim random-walk for fed symbols. Disconnecting the feeding account falls back to Sim ticks automatically.
        </div>
      </PopoverContent>
    </Popover>
  )
}

function LoginGate({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin123')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      await api.login(username, password)
      onLogin()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed')
    } finally { setBusy(false) }
  }

  return (
    <div className="h-full flex items-center justify-center bg-[#0b0e11]">
      <div className="w-80 rounded-lg border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <div>
            <div className="text-sm font-bold">QuantDesk Terminal</div>
            <div className="text-[10px] text-muted-foreground">Sim Feed · Dhan · Shoonya · ICICI Breeze</div>
          </div>
        </div>
        <div className="space-y-2">
          <Input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" className="h-9 text-xs" />
          <Input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" className="h-9 text-xs"
            onKeyDown={e => e.key === 'Enter' && submit()}
          />
          {err && <div className="text-[10px] text-[#ff4d5e]">{err}</div>}
          <Button className="w-full h-9 text-xs" onClick={submit} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in as admin'}
          </Button>
          <div className="text-[9px] text-muted-foreground text-center">default credentials: admin / admin123</div>
        </div>
      </div>
    </div>
  )
}
