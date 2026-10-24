'use client'

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { KeyRound, RefreshCw, Trash2, Download, Radio, ShieldAlert, ShieldCheck, X, Pencil, Stethoscope, FlaskConical, Dices, Play, Pause, Square, Calculator, RotateCcw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, fmtInr, fmtDateTime } from '../lib/client-api'
import type { BrokerTestResp, BulkApplyResp, AccountRow, CopyTradeCfg, FnoSimResp, SyncInfoResp, ChargesResp, ChargeSchedule, ChargeSegment } from '../lib/client-api'
import { useSyncChannel, type SyncCore, type SyncAdmin } from '../lib/sync'
import { useTerminal } from '../lib/store'
import { BROKER_API_NAME, BROKER_META, CAPITAL_MODES } from '@/lib/types'
import type { BrokerType, CapitalMode } from '@/lib/types'

export function AdminView() {
  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 max-w-6xl mx-auto">
      <SourceExport />
      <TradingMode />
      <AccountsManager />
      <BrokerDiagnostics />
      <div className="grid lg:grid-cols-2 gap-4">
        <CopyTradeManager />
        <MasterContracts />
      </div>
      <TickRecorder />
      <ReplayManager />
      <FnoSimManager />
      <AuditTrail />
    </div>
  )
}

// ---------------- Trading mode (Live-Only switch) ----------------
// Round-27: THREE global trading modes (replaces the Round-12 LIVE-ONLY
// checkbox which is now the LIVE setting):
//   LIVE       — real trading: real broker sessions, real fills. No sim,
//                no sandbox — the sim engine is stopped and sandbox
//                accounts detach; charts show real data or nothing.
//   SANDBOX    — paper trading on a LIVE broker account's data: fills are
//                local (the real broker API is never touched), P&L + charges
//                are computed per the selected account's schedule.
//   SIMULATION — session simulator: the sim feed account + local fills for
//                offline testing (weekends/holidays/strategy dev).
const TRADING_MODES: { id: 'live' | 'sandbox' | 'simulation'; label: string; desc: string; cls: string }[] = [
  { id: 'live', label: 'LIVE', desc: 'Real orders via broker sessions — no sim/sandbox anywhere.', cls: 'border-[#e05252]/60 bg-[#e05252]/10 text-[#ff8a80]' },
  { id: 'sandbox', label: 'SANDBOX', desc: 'Paper fills on the selected live broker account\'s data — broker API untouched.', cls: 'border-[#e0a63f]/60 bg-[#e0a63f]/10 text-[#e0a63f]' },
  { id: 'simulation', label: 'SIMULATION', desc: 'Sim feed account + local fills — offline testing (closed days / strategy dev).', cls: 'border-[#4dd0e1]/50 bg-[#4dd0e1]/10 text-[#4dd0e1]' },
]

function TradingMode() {
  const qc = useQueryClient()
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data } = useQuery({ queryKey: ['feed-source'], queryFn: () => api.feedSource() })
  const mode = (adm?.feedSource?.tradingMode ?? (data as { tradingMode?: string } | undefined)?.tradingMode ?? 'simulation') as 'live' | 'sandbox' | 'simulation'
  const [busy, setBusy] = useState(false)
  const setMode = async (next: 'live' | 'sandbox' | 'simulation') => {
    if (next === mode) return
    setBusy(true)
    try {
      await api.setTradingMode(next)
      await qc.invalidateQueries({ queryKey: ['feed-source'] })
      toast.success(next === 'live'
        ? 'LIVE mode — real broker orders, sim feed stopped, sandbox detached'
        : next === 'sandbox'
          ? 'SANDBOX mode — paper fills on live broker data (broker API untouched)'
          : 'SIMULATION mode — sim feed + local fills for testing')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Switch failed')
    } finally { setBusy(false) }
  }
  const current = TRADING_MODES.find(m => m.id === mode) ?? TRADING_MODES[2]
  return (
    <div className={`rounded-lg border bg-card px-4 py-3 flex flex-wrap items-center gap-3 ${current.cls.split(' ')[0]}`}>
      <div className="min-w-[260px] flex-1">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          {mode === 'live' ? <ShieldAlert className="h-4 w-4 text-[#e05252]" /> : <ShieldCheck className="h-4 w-4 text-[#4dd0e1]" />}
          Trading mode — {current.label}
        </h3>
        <p className="text-[11px] text-muted-foreground">{current.desc}</p>
      </div>
      <div className="flex items-center rounded-lg border border-border overflow-hidden" role="group" aria-label="Trading mode">
        {TRADING_MODES.map(m => (
          <button key={m.id} type="button" disabled={busy}
            onClick={() => setMode(m.id)}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${m.id === mode ? m.cls : 'text-muted-foreground hover:bg-muted/40'} ${m.id !== 'live' ? 'border-l border-border' : ''}`}>
            {m.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------- Source export ----------------
// The platform "Download workspace" fails when the workspace is huge
// ("Failed to archive workspace files" — node_modules + .next + tick DBs).
// This streams a zip of the SOURCE ONLY from the app itself.
function SourceExport() {
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/workspace/export')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') ?? ''
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'quantdesk-source.zip'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`Source code downloaded — ${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Export failed') }
    setBusy(false)
  }
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-wrap items-center gap-3">
      <div className="min-w-[240px] flex-1">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Download className="h-4 w-4 text-[#4dd0e1]" />Download latest source code</h3>
        <p className="text-[11px] text-muted-foreground">
          Streams a ZIP of the full project source (no node_modules / .next / runtime DBs) — use this when the
          platform workspace download fails. CLI alternative: <code className="text-[10px] bg-secondary px-1 rounded">bash scripts/export-source.sh</code>
        </p>
      </div>
      <Button size="sm" className="text-xs h-8" disabled={busy} onClick={download}>
        <Download className={`h-3.5 w-3.5 ${busy ? 'animate-pulse' : ''}`} />
        {busy ? 'Packing…' : 'Download source'}
      </Button>
    </div>
  )
}

// ---------------- Broker diagnostics ----------------
// The debugging surface: run a 4-step live test (credentials → mode →
// funds → quote) against any account and watch its raw broker_logs
// (every outbound call is tagged and mirrored there).
function BrokerDiagnostics() {
  const qc = useQueryClient()
  // logs stream via the sync:admin websocket (2s push) — REST fallback only
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data } = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts() })
  const accounts = (data?.accounts ?? []).filter(a => a.brokerType !== 'SIMFEED')
  const [sel, setSel] = useState<string>('')
  const accountId = sel || accounts[0]?.id || ''
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<BrokerTestResp | null>(null)
  const { data: logs, refetch } = useQuery({
    queryKey: ['broker-logs', accountId],
    queryFn: () => api.brokerLogs(accountId),
    enabled: !!accountId && !adm,
    refetchInterval: 5000,
  })
  const liveLogs = adm
    ? (adm.brokerLogs ?? []).filter(l => l.accountId === accountId).map((l, i) => ({ ...l, id: i }))
    : (logs?.logs ?? [])

  const runTest = async () => {
    if (!accountId) return
    setTesting(true)
    try {
      const r = await api.brokerTest(accountId)
      setTest(r)
      r.ok ? toast.success(r.hint) : toast.error(r.hint)
      qc.invalidateQueries({ queryKey: ['broker-logs', accountId] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Test failed') }
    setTesting(false)
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-[220px]">
          <h3 className="text-sm font-semibold flex items-center gap-1.5"><Stethoscope className="h-4 w-4 text-[#4dd0e1]" />Broker Diagnostics</h3>
          <p className="text-[11px] text-muted-foreground">Why is live data / auth failing? Test the exact calls + read the per-call logs.</p>
        </div>
        <Select value={accountId} onValueChange={v => { setSel(v); setTest(null) }}>
          <SelectTrigger className="h-8 w-[220px] text-xs"><SelectValue placeholder="account" /></SelectTrigger>
          <SelectContent>
            {accounts.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.label} · {a.brokerType}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" className="text-xs h-8" disabled={!accountId || testing} onClick={runTest}>
          {testing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Stethoscope className="h-3.5 w-3.5" />}
          Test connection
        </Button>
        <Button size="sm" variant="secondary" className="text-xs h-8" disabled={!accountId} onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh logs
        </Button>
      </div>
      {test && (
        <div className="px-4 py-2 space-y-1 border-b border-border">
          {test.steps.map(s => (
            <div key={s.step} className="flex items-start gap-2 text-[10px]">
              <span className={`px-1 rounded font-bold ${s.ok ? 'bg-[#00c896]/15 text-[#00c896]' : 'bg-[#ff4d5e]/15 text-[#ff4d5e]'}`}>{s.ok ? 'OK' : 'FAIL'}</span>
              <span className="font-bold w-20 shrink-0">{s.step}</span>
              <span className="tabular text-muted-foreground w-14 shrink-0">{s.ms}ms</span>
              <span className="text-muted-foreground min-w-0 flex-1">{s.detail}</span>
            </div>
          ))}
          <div className="text-[9px] text-muted-foreground pt-1">{test.hint}</div>
        </div>
      )}
      <div className="max-h-56 overflow-y-auto divide-y divide-border/50">
        {liveLogs.map(l => (
          <div key={l.id} className="px-4 py-1 flex items-start gap-2 text-[10px] tabular">
            <span className="text-muted-foreground shrink-0">{l.ts.slice(11, 19)}</span>
            <span className={`shrink-0 font-bold ${l.level === 'ERROR' ? 'text-[#ff4d5e]' : l.level === 'WARN' ? 'text-[#e0a63f]' : 'text-muted-foreground'}`}>{l.level}</span>
            <span className="min-w-0 flex-1 break-all">{l.message}</span>
          </div>
        ))}
        {liveLogs.length === 0 && (
          <div className="px-4 py-4 text-center text-[11px] text-muted-foreground">
            No broker calls logged yet for this account — create a session or run the test.
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------- Paper-trading replay ----------------
// Start a RECORDED tick session as a live paper session — a random archive
// or a specific date-time range, at 1x-20x. While the replay runs, the feed
// service drives NIFTY/SENSEX (and any other recorded symbols) from the
// recorded ticks, so the terminal + paper accounts trade a "live" market.
function ReplayManager() {
  const qc = useQueryClient()
  // recorder + replay state ride the sync:admin websocket (2s) — REST fallback
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data: recRest } = useQuery({ queryKey: ['tick-recorder'], queryFn: () => api.tickRecorder(), enabled: !adm, refetchInterval: 10_000 })
  const { data: stRest } = useQuery({ queryKey: ['replay-status'], queryFn: () => api.replayStatus(), enabled: !adm, refetchInterval: 1500 })
  const rec = adm?.tickRecorder ?? recRest
  const st = adm?.replay ?? stRest
  const [file, setFile] = useState<string>('')
  const [random, setRandom] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)

  const sessions = rec?.sessions ?? []
  const active = st?.active

  const control = async (mode: 'start' | 'stop') => {
    setBusy(true)
    try {
      const fromTs = from ? new Date(from).getTime() : null
      const toTs = to ? new Date(to).getTime() : null
      const r = await api.replayControl({ mode, file: file || null, random: random && !file, fromTs, toTs, speed })
      if ((r as { ok?: boolean }).ok === false && 'error' in r) throw new Error((r as { error?: string }).error)
      toast.success(mode === 'start' ? `Replay started — ${r.file} (${r.total} ticks @ ${r.speed}x)` : 'Replay stopped')
      await qc.invalidateQueries({ queryKey: ['replay-status'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Replay control failed')
    }
    setBusy(false)
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Radio className={`h-4 w-4 ${active ? 'text-[#00c896]' : 'text-muted-foreground'}`} />
        <div className="font-bold text-sm">Paper Trading Replay</div>
        {active && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-up text-[#00c896] font-bold animate-pulse">PLAYING {st?.speed}x</span>
        )}
        <div className="flex-1" />
        {active && (
          <span className="text-[10px] text-muted-foreground tabular">
            {st?.played}/{st?.total} ticks · {st?.progressPct}% · {(st?.symbols ?? []).join(', ')}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Load a recorded tick session and play it as a live session — paper accounts trade the replayed market.
        Pick a specific archive or let the system choose a random one, optionally bounded by a date-time range.
      </p>
      <div className="grid md:grid-cols-2 gap-3">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={random && !file} onChange={e => { setRandom(e.target.checked); if (e.target.checked) setFile('') }} className="accent-[#3b82f6] h-3 w-3" />
            Random recorded session
          </label>
          <Select value={file || 'none'} onValueChange={v => { setFile(v === 'none' ? '' : v); setRandom(v === 'none') }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick a recorded session…" /></SelectTrigger>
            <SelectContent className="text-xs max-h-56">
              <SelectItem value="none">— pick a session —</SelectItem>
              {sessions.map(s => (
                <SelectItem key={s.file} value={s.file}>{s.file} · {(s.bytes / 1024).toFixed(0)} KB</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground shrink-0">Speed</span>
            <Select value={String(speed)} onValueChange={v => setSpeed(Number(v))}>
              <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="text-xs">
                {[0.5, 1, 2, 5, 10, 20].map(s => <SelectItem key={s} value={String(s)}>{s}x</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">optional date-time range (IST)</div>
          <div className="flex items-center gap-1.5">
            <Input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} className="h-8 text-xs" />
            <span className="text-muted-foreground">–</span>
            <Input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-8 text-xs flex-1" disabled={busy || !!active} onClick={() => control('start')}>
              Start replay
            </Button>
            <Button size="sm" variant="secondary" className="h-8 text-xs" disabled={busy || !active} onClick={() => control('stop')}>
              Stop
            </Button>
          </div>
        </div>
      </div>
      {active && st?.file && (
        <div className="text-[10px] text-muted-foreground">playing <b>{st.file}</b> since {st.startedAt ? fmtDateTime(st.startedAt) : '—'}</div>
      )}
    </div>
  )
}

// ---------------- Session Simulator ----------------
// A full trading-day simulator for STOCKS (equity) and INDICES alike:
// the engine pulls each underlying's session day + previous days from a
// connected live broker (or builds DETERMINISTIC synthetic 1m data from the
// sim feed when none is connected), generates CE/PE premiums
// (Black-Scholes · custom expiry + user volatility → greeks) and streams
// everything as ticks — the whole terminal trades the session like a live
// day. MULTI-UNDERLYING: the user adds a LIST of stocks/indices and every
// one runs its own parallel session.
// MANUAL START: Start only PREPARES (loads history, you get a break to
// set up) — a Play/Pause button beside the FEED badge (and per session
// here) starts the day when YOU are ready. Pause freezes the clock.
// Sandbox-only by design (unlike paper-trading replay, which replays
// RECORDED ticks; this generates the option market).
function FnoSimManager() {
  const qc = useQueryClient()
  const setView = useTerminal(s => s.setView)
  const setSymbol = useTerminal(s => s.setSymbol)
  const { data } = useQuery({
    queryKey: ['fnosim'],
    queryFn: () => api.fnosim(),
    refetchInterval: (q) => ((q.state.data as FnoSimResp | undefined)?.status.active ? 1500 : 8000),
  })
  const { data: undData } = useQuery({ queryKey: ['optionUnderlyings'], queryFn: () => api.optionUnderlyings(), staleTime: 5 * 60_000 })
  const unds = undData?.underlyings ?? []

  const st = data?.status
  const live = st?.live ?? []
  const active = !!st?.active
  const anyReady = live.some(s => s.active && !s.playing)
  const [undList, setUndList] = useState<string[]>([])
  const [addUnd, setAddUnd] = useState('')
  const [sessionDate, setSessionDate] = useState('')
  const [expiryDt, setExpiryDt] = useState('')
  const [ivPct, setIvPct] = useState(25)
  const [speed, setSpeed] = useState(5)
  const [band, setBand] = useState(10)
  const [prevDays, setPrevDays] = useState(5)
  const [busy, setBusy] = useState(false)

  const today = new Date().toISOString().slice(0, 10)

  const addToList = (u: string) => {
    const s = (u || '').toUpperCase().trim()
    if (!s) return
    if (undList.includes(s)) { toast.info(`${s} already in the list`); return }
    setUndList(l => [...l, s])
    setAddUnd('')
  }

  const start = async (override?: { underlyings: string[]; session_date: string }) => {
    const list = override?.underlyings ?? undList
    const date = override?.session_date ?? sessionDate
    if (list.length === 0) { toast.error('add at least one stock or index to the list'); return }
    if (!date) { toast.error('pick a session date first'); return }
    setBusy(true)
    try {
      const r = await api.fnosimStart({
        underlyings: list, sessionDate: date,
        expiryDt: expiryDt || null,
        ivPct, speed, band, prevDays,
      })
      const started = r.status.live?.filter(s => s.active).length ?? 0
      const failed = r.status.errors ?? []
      if (failed.length) toast.warning(`${failed.length} session(s) failed — ${failed[0]}`, { duration: 8000 })
      toast.success(`Session prepared — ${started} underlying(s): ${r.status.underlyings?.filter(u => r.status.live?.find(s => s.underlying === u && s.active)).join(', ')} · ${r.status.historyDays ?? 0} days of history loaded. Take your time — press PLAY (beside the FEED badge) to start the day.`, { duration: 10000 })
      setSymbol(r.status.spotSymbol || `NSE:${list[0]}`)
      setView('terminal')
      await qc.invalidateQueries({ queryKey: ['fnosim'] })
      await qc.invalidateQueries({ queryKey: ['optionUnderlyings'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Session prepare failed', { duration: 8000 })
    }
    setBusy(false)
  }

  const randomStart = async () => {
    setBusy(true)
    try {
      const r = await api.fnosimRandom()
      toast.info(`Random pick — ${r.pick.underlying} · ${r.pick.session_date}`)
      setSessionDate(r.pick.session_date)
      setBusy(false)
      await start({ underlyings: [r.pick.underlying], session_date: r.pick.session_date })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Random pick failed')
      setBusy(false)
    }
  }

  const stop = async (underlying?: string) => {
    setBusy(true)
    try {
      await api.fnosimStop(underlying)
      toast.success(underlying ? `Session stopped — ${underlying}` : 'All sessions stopped')
      await qc.invalidateQueries({ queryKey: ['fnosim'] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Stop failed') }
    setBusy(false)
  }

  const playPause = async (underlying: string | undefined, playing: boolean) => {
    try {
      const r = underlying ? (playing ? await api.fnosimPause(underlying) : await api.fnosimPlay(underlying))
                          : (playing ? await api.fnosimPause() : await api.fnosimPlay())
      const ph = r.status.live?.map(s => s.phase).join(', ') ?? r.status.phase
      toast.success(playing ? `Session paused @ ${r.status.cursor ?? '—'} (${ph})` : `Session PLAYING — the day is running (${ph})`)
      await qc.invalidateQueries({ queryKey: ['fnosim'] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Play/pause failed') }
  }

  const patch = async (body: { ivPct?: number; speed?: number }) => {
    try {
      await api.fnosimPatch(body)
      await qc.invalidateQueries({ queryKey: ['fnosim'] })
      toast.success('Session settings updated live (all sessions)')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Patch failed') }
  }

  const stats = st?.stats
  const StatCell = ({ label, value }: { label: string; value: string }) => (
    <div className="rounded bg-secondary/50 px-2 py-1">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-[11px] tabular font-bold">{value}</div>
    </div>
  )

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <FlaskConical className={`h-4 w-4 ${active ? 'text-[#00c896]' : 'text-muted-foreground'}`} />
        <div className="font-bold text-sm">Session Simulator</div>
        {active && (st?.playing
          ? <span className="text-[9px] px-1.5 py-0.5 rounded bg-up text-[#00c896] font-bold animate-pulse">RUNNING · {live.filter(s => s.active).length} session(s)</span>
          : <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#f5a623]/20 text-[#f5a623] font-bold">READY — press PLAY · {live.filter(s => s.active).length} session(s)</span>)}
        {st?.completed && !active && <span className="text-[9px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">COMPLETED</span>}
        <div className="flex-1" />
        {active && (
          <span className="text-[10px] text-muted-foreground tabular">
            {st?.cursor?.slice(11) ?? '—'} IST · {st?.ticksSent?.toLocaleString('en-IN')} ticks
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        A full trading-day simulator for <b>normal stocks (equity) and indices</b> alike — add a <b>list of
        stocks/indices</b> and pick a session day. Start only <b>prepares</b>: history (previous days + session
        stats) is pulled and shown, then take your break — press <b>PLAY</b> (beside the FEED badge in the
        terminal, or per session below) when you&apos;re ready to start the day. <b>Pause</b> freezes the clock
        anytime. Real broker 1m OHLCV when a live broker is connected, deterministic sim data otherwise;
        set a <b>custom expiry date+time</b> (empty = today) and a volatility rate — CE/PE strikes populate
        from Black-Scholes <b>greeks</b>, and every 1m candle opens/closes exactly at the real open/close.
        Trade the stock itself (equity) or its F&amp;O options — orders execute like paper trading.
        <span className="text-[10px]"> Sandbox-only — switch LIVE-ONLY off to run sessions.</span>
      </p>

      {/* live sessions — one strip per underlying */}
      {live.length > 0 && (
        <div className="space-y-1.5">
          {live.map(s => (
            <div key={s.underlying} className={`rounded border px-3 py-2 space-y-2 ${s.active ? 'border-[#00c896]/30 bg-[#00c896]/5' : 'border-border bg-secondary/20'}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span className="font-bold">{s.underlying}</span>
                {s.active && s.playing && <span className="text-[8px] px-1 rounded bg-up text-[#00c896] font-bold">LIVE</span>}
                {s.active && !s.playing && <span className="text-[8px] px-1 rounded bg-[#f5a623]/20 text-[#f5a623] font-bold">{s.progressPct > 0 ? 'PAUSED' : 'READY'}</span>}
                {!s.active && s.completed && <span className="text-[8px] px-1 rounded bg-secondary text-muted-foreground">DONE</span>}
                {!s.active && s.error && <span className="text-[8px] px-1 rounded bg-down text-[#ff4d5e] font-bold">FAILED</span>}
                <span className="text-muted-foreground">{s.sessionDate}</span>
                <span>expiry <b>{s.expiry}</b>{s.expiryDt ? <span className="text-muted-foreground"> ({s.expiryDt} IST)</span> : null}</span>
                <span>step {s.step}</span>
                <span>lot {s.lotSize}</span>
                <span>{s.strikeCount} strikes (±{s.band})</span>
                <span className="text-muted-foreground">via {s.source}</span>
                <div className="flex-1" />
                <span className="tabular">{s.cursor?.slice(11) ?? '—'} · {s.progressPct}%</span>
                {s.active && (
                  <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[9px] text-[#00c896] hover:text-[#00c896]"
                    onClick={() => playPause(s.underlying ?? undefined, !!s.playing)}
                    title={s.playing ? `Pause ${s.underlying} — freeze the replay clock` : `PLAY ${s.underlying} — start the day from ${s.cursor?.slice(11) ?? '09:15 open'}`}>
                    {s.playing ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
                    {s.playing ? 'pause' : 'play'}
                  </Button>
                )}
                {s.active && (
                  <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[9px] text-muted-foreground hover:text-[#ff4d5e]"
                    onClick={() => stop(s.underlying ?? undefined)} title={`Stop only ${s.underlying}`}>
                    <Square className="h-2.5 w-2.5" /> stop
                  </Button>
                )}
              </div>
              {s.error && <div className="text-[10px] text-destructive">{s.error}</div>}
              <div className="h-1 rounded bg-secondary overflow-hidden">
                <div className="h-full bg-[#00c896] transition-all" style={{ width: `${s.progressPct}%` }} />
              </div>
              {s.active && s.stats && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
                  <StatCell label="Prev Day H/L" value={`${fmtNum(s.stats.prevDayHigh)} / ${fmtNum(s.stats.prevDayLow)}`} />
                  <StatCell label="Week H/L" value={`${fmtNum(s.stats.weekHigh)} / ${fmtNum(s.stats.weekLow)}`} />
                  <StatCell label="Month H/L" value={`${fmtNum(s.stats.monthHigh)} / ${fmtNum(s.stats.monthLow)}`} />
                  <StatCell label="6M H/L" value={`${fmtNum(s.stats.sixMonthHigh)} / ${fmtNum(s.stats.sixMonthLow)}`} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {st?.error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{st.error}</div>
      )}

      {/* controls */}
      <div className="grid md:grid-cols-3 gap-3">
        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">underlyings (add stocks / indices)</div>
          <div className="flex items-center gap-1.5">
            <Select value={addUnd || 'none'} onValueChange={v => setAddUnd(v === 'none' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs flex-1"><SelectValue placeholder="F&O underlying…" /></SelectTrigger>
              <SelectContent className="text-xs max-h-56">
                <SelectItem value="none">— pick from F&O universe —</SelectItem>
                {unds.map(u => (
                  <SelectItem key={u.underlying} value={u.underlying}>
                    {u.underlying} · {u.instrumentType} · lot {u.lotSize}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="secondary" className="h-8 text-xs shrink-0" disabled={!addUnd} onClick={() => addToList(addUnd)}>
              + Add
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              value={addUnd}
              onChange={e => setAddUnd(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && addToList(addUnd)}
              placeholder="or type a symbol e.g. RELIANCE…"
              className="h-8 text-xs flex-1"
            />
          </div>
          {/* chip list */}
          <div className="flex flex-wrap gap-1 min-h-[26px]">
            {undList.length === 0 && <span className="text-[10px] text-muted-foreground">no underlyings added yet — every one runs its own session</span>}
            {undList.map(u => (
              <span key={u} className="flex items-center gap-1 rounded bg-primary/20 text-[10px] font-bold pl-1.5 pr-0.5 py-0.5">
                {u}
                <button onClick={() => setUndList(l => l.filter(x => x !== u))} className="p-0.5 rounded hover:bg-destructive/30" title={`Remove ${u}`}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Input type="date" max={today} value={sessionDate} onChange={e => setSessionDate(e.target.value)} className="h-8 text-xs flex-1" title="Historical trading day to replay (real 1m OHLCV)" />
            <Button size="sm" variant="secondary" className="h-8 text-xs shrink-0" disabled={busy || active}
              onClick={randomStart} title="Random F&O stock + random session date — starts that one session">
              <Dices className="h-3.5 w-3.5" /> Random
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              type="datetime-local"
              value={expiryDt}
              onChange={e => setExpiryDt(e.target.value)}
              className="h-8 text-xs flex-1 tabular"
              title="Custom expiry date + time (IST) — empty = TODAY 15:30. Drives Black-Scholes greeks and the strike ladder."
            />
            {expiryDt && (
              <Button size="sm" variant="ghost" className="h-8 text-xs shrink-0" onClick={() => setExpiryDt('')} title="Clear — expiry falls back to today">clear</Button>
            )}
          </div>
          <div className="text-[9px] text-muted-foreground">
            expiry {expiryDt ? expiryDt.replace('T', ' ') : 'today (current date) 15:30 IST'} · greeks populate CE/PE strikes from this + volatility
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">geek settings</div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground shrink-0 w-20">Volatility</span>
            <input type="range" min={5} max={120} step={1} value={ivPct}
              onChange={e => setIvPct(Number(e.target.value))}
              disabled={active} className="flex-1 accent-[#3b82f6] h-1" />
            <Input type="number" min={5} max={120} value={ivPct}
              onChange={e => setIvPct(Math.max(5, Math.min(120, Number(e.target.value) || 25)))}
              disabled={active} className="h-8 w-16 text-xs tabular" />
            <span className="text-muted-foreground">%</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground shrink-0 w-20">Speed</span>
            <Select value={String(speed)} onValueChange={v => { setSpeed(Number(v)); if (active) patch({ speed: Number(v) }) }}>
              <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="text-xs">
                <SelectItem value="1">1× — realtime</SelectItem>
                <SelectItem value="2">2× — slow</SelectItem>
                <SelectItem value="5">5× — normal</SelectItem>
                <SelectItem value="15">15× — fast</SelectItem>
                <SelectItem value="30">30× — turbo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground shrink-0 w-20">Strikes</span>
            <Select value={String(band)} onValueChange={v => setBand(Number(v))} disabled={active}>
              <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="text-xs">
                {[5, 10, 15, 20].map(b => <SelectItem key={b} value={String(b)}>ATM ±{b}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground shrink-0 w-20">History</span>
            <Select value={String(prevDays)} onValueChange={v => setPrevDays(Number(v))} disabled={active}>
              <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="text-xs">
                <SelectItem value="5">5 days (week)</SelectItem>
                <SelectItem value="21">1 month</SelectItem>
                <SelectItem value="63">3 months</SelectItem>
                <SelectItem value="126">6 months</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2 flex flex-col">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">session control</div>
          <Button size="sm" className="h-8 text-xs" disabled={busy || active} onClick={() => start()}>
            <FlaskConical className="h-3.5 w-3.5" /> Prepare {undList.length > 1 ? `${undList.length} sessions` : 'session'}
          </Button>
          {active && (
            <Button size="sm" variant={anyReady ? 'default' : 'outline'} className={`h-8 text-xs ${anyReady ? '' : ''}`}
              onClick={() => playPause(undefined, !anyReady)}
              title={anyReady ? 'Start the day — all prepared sessions begin streaming' : 'Pause all sessions — freeze the replay clock'}>
              {anyReady ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {anyReady ? 'Play — start the day' : 'Pause all'}
            </Button>
          )}
          <Button size="sm" className="h-8 text-xs" disabled={busy || active} onClick={randomStart}>
            <Dices className="h-3.5 w-3.5" /> Random session
          </Button>
          <Button size="sm" variant="secondary" className="h-8 text-xs" disabled={busy || !active} onClick={() => stop()}>
            <Square className="h-3.5 w-3.5" /> Stop all
          </Button>
          {active && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => patch({ ivPct })}>
              Apply live IV {ivPct}%
            </Button>
          )}
          <p className="text-[10px] text-muted-foreground mt-auto">
            Preparing loads the history and the CE/PE contracts but does NOT start the day — press Play (here or beside
            the FEED badge in the terminal) when you&apos;re ready. Open the underlying in the Terminal view for spot +
            CE/PE panes, strikes desk, chain (with greeks) and paper orders. Every session persists in the history below.
          </p>
        </div>
      </div>

      {/* recent sessions */}
      {(data?.sessions?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">recent sessions</div>
          <div className="rounded border overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-[10px] tabular">
              <thead className="bg-secondary/50 text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left px-2 py-1">Underlying</th>
                  <th className="text-left px-2 py-1">Session date</th>
                  <th className="text-left px-2 py-1">Expiry</th>
                  <th className="text-right px-2 py-1">IV</th>
                  <th className="text-right px-2 py-1">Speed</th>
                  <th className="text-left px-2 py-1">Status</th>
                  <th className="text-left px-2 py-1">Source</th>
                </tr>
              </thead>
              <tbody>
                {data!.sessions.map(s => (
                  <tr key={s.id} className="border-t border-border/60">
                    <td className="px-2 py-1 font-bold">{s.underlying}</td>
                    <td className="px-2 py-1">{s.sessionDate}</td>
                    <td className="px-2 py-1">{s.expiry}</td>
                    <td className="px-2 py-1 text-right">{s.ivPct}%</td>
                    <td className="px-2 py-1 text-right">{s.speed}×</td>
                    <td className="px-2 py-1">{s.status}</td>
                    <td className="px-2 py-1 text-muted-foreground">{s.source ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n)) return '—'
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

// ---------------- Tick recorder (session live-feed backup) ----------------
// Every tick of the configured symbols (default NIFTY + SENSEX) is written
// to a per-session SQLite DB by the market-feed service. These archives
// power the future paper-trading / replay engine.
function TickRecorder() {
  const qc = useQueryClient()
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data: rest } = useQuery({ queryKey: ['tick-recorder'], queryFn: () => api.tickRecorder(), enabled: !adm, refetchInterval: 5000 })
  const data = adm?.tickRecorder ?? rest
  const [sym, setSym] = useState('')
  if (!data) return null

  const save = async (body: { enabled?: boolean; symbols?: string[] }) => {
    try {
      await api.setTickRecorder(body)
      await qc.invalidateQueries({ queryKey: ['tick-recorder'] })
      toast.success('Tick recorder updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const addSym = () => {
    const s = sym.trim().toUpperCase()
    if (!s) return
    if (data.symbols.includes(s)) { toast.info('Symbol already recorded'); return }
    setSym('')
    void save({ symbols: [...data.symbols, s] })
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-primary" />
        <div className="font-bold text-sm">Tick Data Recorder</div>
        <span className="text-[10px] text-muted-foreground">session live-feed backup — every tick stored per session for paper trading</span>
        <div className="flex-1" />
        <span className={`text-[10px] font-bold ${data.enabled ? 'text-[#00c896]' : 'text-muted-foreground'}`}>{data.enabled ? 'RECORDING' : 'OFF'}</span>
        <Switch checked={data.enabled} onCheckedChange={v => save({ enabled: v })} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {data.symbols.map(s => (
          <span key={s} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] tabular">
            {s}
            <button
              onClick={() => save({ symbols: data.symbols.filter(x => x !== s) })}
              className="text-muted-foreground hover:text-[#ff4d5e]"
              title={`Stop recording ${s}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <div className="flex items-center gap-1">
          <Input
            value={sym}
            onChange={e => setSym(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && addSym()}
            placeholder="add symbol…"
            className="h-6 w-28 text-[10px] bg-secondary/60"
          />
          <Button size="sm" variant="secondary" className="h-6 px-2 text-[10px]" onClick={addSym}>Add</Button>
        </div>
      </div>

      {data.session && (
        <div className="text-[10px] text-muted-foreground tabular">
          current session: <b className="text-foreground">{data.session.file.split('/').pop()}</b> · {data.session.rows.toLocaleString('en-IN')} ticks · started {fmtDateTime(data.session.startedAt)}
        </div>
      )}

      {data.sessions.length > 0 && (
        <div className="rounded border border-border/60 max-h-40 overflow-y-auto">
          <table className="w-full text-[10px] tabular">
            <thead className="text-muted-foreground sticky top-0 bg-card">
              <tr>
                <th className="text-left font-medium px-2 py-1">Session DB</th>
                <th className="text-left font-medium px-2 py-1">Size</th>
                <th className="text-left font-medium px-2 py-1">Last write</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map(s => (
                <tr key={s.file} className={`border-t border-border/40 ${data.session?.file.endsWith(s.file.split('/').pop() ?? '##') ? 'bg-primary/10' : ''}`}>
                  <td className="px-2 py-1">{s.file.replace('db/ticks/', '')}</td>
                  <td className="px-2 py-1">{(s.bytes / 1024).toFixed(0)} KB</td>
                  <td className="px-2 py-1 text-muted-foreground">{fmtDateTime(s.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-[9px] text-muted-foreground leading-snug">
        A new SQLite DB is created per feed session (and rolls over at the IST day boundary). Replay API: <code>/api/tickrecorder</code> — the stored ticks will feed the paper-trading engine.
      </div>
    </div>
  )
}

// ---------------- Broker accounts ----------------
// OAuth-style session model (aligned with straweb/hedging broker flows):
//  · ICICI Breeze — API key (+secret) → login redirect ?apisession= →
//    customerdetails exchange → session_key
//  · Dhan — app_id/app_secret → generate-consent → consentApp-login →
//    consumeApp-consent (tokenId) → accessToken (or paste a direct JWT)
//  · Shoonya — api_key/client_id + secret → prism login ?code= →
//    GenAcsTok (sha256 checksum) → susertoken (or QuickAuth uid+pwd+PAN)
function AccountsManager() {
  const qc = useQueryClient()
  const core = useSyncChannel<SyncCore>('sync:core')
  const { data: rest } = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts(), enabled: !core, refetchInterval: 5000 })
  const data = core ? { accounts: core.accounts as unknown as AccountRow[] } : rest
  // Round-27: full broker catalog (4 native + 37 openalgo plugins)
  const { data: catalog } = useQuery({ queryKey: ['brokers'], queryFn: () => api.brokers(), staleTime: 3600_000 })
  const [dlgOpen, setDlgOpen] = useState(false)
  const [form, setForm] = useState<{
    label: string; brokerType: BrokerType; clientId: string; initialCapital: string; mode: CapitalMode
    apiKey: string; secret: string; extra: string; oaCreds: Record<string, string>
  }>({
    label: '', brokerType: 'SIMFEED', clientId: '', initialCapital: '500000', mode: 'INITIAL_PLUS_PNL', apiKey: '', secret: '', extra: '', oaCreds: {},
  })

  const accounts = data?.accounts ?? []
  const isOa = form.brokerType.startsWith('oa-')
  const oaSpec = isOa ? catalog?.brokers.find(b => b.broker === form.brokerType) : undefined

  const isLive = form.brokerType !== 'SIMFEED'

  const create = async () => {
    try {
      const credentials: Record<string, string> = {}
      if (isOa) {
        for (const [k, v] of Object.entries(form.oaCreds)) {
          if (v?.trim()) credentials[k] = v.trim()
        }
      } else {
        for (const [k, v] of Object.entries(oauthFieldsFor(form.brokerType, form))) {
          if (v?.trim()) credentials[k] = v.trim()
        }
      }
      // live brokers: blank initial capital = 100% of the REAL broker
      // available cash (pulled from the funds API) — the round-10 default
      const capBlank = !form.initialCapital.trim()
      // canonical backend contract: broker is the registry name (sim/breeze/
      // dhan/shoonya/oa-<plugin>); capitalMode is the sizing mode; `mode` is
      // live|sandbox. Sending brokerType/initialCapital aliases also works
      // (backend accepts both) — this shape is the source of truth.
      await api.createAccount({
        broker: (BROKER_API_NAME as Record<string, string>)[form.brokerType] ?? form.brokerType,
        label: form.label,
        mode: isLive ? 'live' : 'sandbox',
        clientId: form.clientId || undefined,
        ...(isLive && capBlank
          ? { capitalBase: 'AVAILABLE_CASH_PCT', capitalPct: 100 }
          : { initialCapital: Number(form.initialCapital) || undefined }),
        capitalMode: form.mode,
        credentials: Object.keys(credentials).length ? credentials : undefined,
      })
      toast.success(`Account "${form.label}" added${isLive && capBlank ? ' — capital = 100% of broker available cash (funds sync every 45s)' : ''}`)
      setDlgOpen(false)
      setForm({ ...form, label: '', clientId: '', apiKey: '', secret: '', extra: '', oaCreds: {}, initialCapital: isLive ? '' : '500000' })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }

  const patch = async (id: string, body: Record<string, unknown>) => {
    await api.patchAccount(id, body).catch(e => toast.error(e.message))
    qc.invalidateQueries({ queryKey: ['accounts'] })
  }

  const remove = async (id: string, label: string) => {
    await api.deleteAccount(id).catch(e => toast.error(e.message))
    toast.success(`Removed ${label}`)
    qc.invalidateQueries({ queryKey: ['accounts'] })
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h3 className="text-sm font-semibold">Broker Accounts</h3>
          <p className="text-[11px] text-muted-foreground">Add N accounts of any broker · mark ONE as live data source · enable the set that receives orders</p>
        </div>
        <div className="flex items-center gap-2">
          <BulkAccountsDialog accounts={accounts} />
          <Dialog open={dlgOpen} onOpenChange={setDlgOpen}>
            <DialogTrigger asChild><Button size="sm" className="text-xs">+ Add Account</Button></DialogTrigger>
          <DialogContent className="bg-popover max-w-[calc(100vw-2rem)] sm:max-w-lg">
            <DialogHeader><DialogTitle>Add Broker Account</DialogTitle></DialogHeader>
            <div className="space-y-3 text-xs min-w-0 max-w-full">
              <Field label="Label">
                <Input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="e.g. Dhan Prop Desk 2" className="h-8" />
              </Field>
              <Field label="Broker">
                <Select value={form.brokerType} onValueChange={v => setForm({ ...form, brokerType: v as BrokerType, oaCreds: {} })}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-[50vh]">
                    {(Object.keys(BROKER_META) as BrokerType[]).map(b => (
                      <SelectItem key={b} value={b}>{BROKER_META[b].name} — {BROKER_META[b].doc}</SelectItem>
                    ))}
                    {(catalog?.brokers ?? []).filter(b => b.kind === 'openalgo').length > 0 && (
                      <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-muted-foreground">OpenAlgo plugins — 37 brokers</div>
                    )}
                    {(catalog?.brokers ?? []).filter(b => b.kind === 'openalgo').map(b => (
                      <SelectItem key={b.broker} value={b.broker}>{b.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {isOa && (
                <div className="text-[10px] text-muted-foreground">OpenAlgo plugin adapter — full auth/feed/orders/history/master-sync via the vendored openalgo broker implementation. Create the session with the Session button after adding.</div>
              )}
              {!isOa && (<Field label="Client ID" hint={clientIdHint(form.brokerType)}>
                <Input value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} className="h-8" placeholder={clientIdSample(form.brokerType)} />
              </Field>)}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Initial Capital ₹" hint={isLive ? 'Leave BLANK for live brokers — capital becomes 100% of the REAL available cash pulled from the funds API (changeable anytime).' : 'Fixed rupee starting capital for sizing.'}>
                  <Input type="number" value={form.initialCapital} onChange={e => setForm({ ...form, initialCapital: e.target.value })} className="h-8 tabular" placeholder={isLive ? 'blank = 100% of broker cash' : '500000'} />
                </Field>
                <Field label="Capital Sizing Mode">
                  <Select value={form.mode} onValueChange={v => setForm({ ...form, mode: v as CapitalMode })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(CAPITAL_MODES) as CapitalMode[]).map(m => <SelectItem key={m} value={m}>{CAPITAL_MODES[m].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {isOa ? (
                (oaSpec?.fields ?? []).map(f => (
                  <Field key={f.key} label={f.label} hint={f.hint || 'Encrypted at rest (AES-256-GCM).'}>
                    <Input type={f.secret ? 'password' : 'text'} value={form.oaCreds[f.key] ?? ''}
                      onChange={e => setForm({ ...form, oaCreds: { ...form.oaCreds, [f.key]: e.target.value } })}
                      className="h-8" />
                  </Field>
                ))
              ) : (
                <>
              <Field label={credFieldLabel(form.brokerType)} hint={`${credFieldSample(form.brokerType)} · Encrypted at rest (AES-256-GCM). OAuth session tokens are created per-day via the Session button after adding.`}>
                <Input value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} className="h-8" placeholder={credFieldSample(form.brokerType)} />
              </Field>
              {form.brokerType !== 'SIMFEED' && (
                <Field label={secretFieldLabel(form.brokerType)} hint={secretFieldSample(form.brokerType)}>
                  <Input type="password" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} className="h-8" placeholder={secretFieldSample(form.brokerType)} />
                </Field>
              )}
              {extraFieldLabel(form.brokerType) && (
                <Field label={extraFieldLabel(form.brokerType)!} hint={extraFieldSample(form.brokerType)}>
                  <Input value={form.extra} onChange={e => setForm({ ...form, extra: e.target.value })} className="h-8" placeholder={extraFieldSample(form.brokerType)} />
                </Field>
              )}
                </>
              )}
              <Button className="h-8 text-xs" onClick={create} disabled={!form.label}>Add Account</Button>
            </div>
          </DialogContent>
        </Dialog>
        </div>
      </div>
      <div className="divide-y divide-border">
        {accounts.map(a => (
          <div key={a.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-[210px]">
              <div className="text-xs font-medium flex items-center gap-1.5">
                {a.label}
                {a.isLiveDataSource && <span className="text-[8px] px-1 py-0.5 rounded bg-[#4dd0e1]/15 text-[#4dd0e1] flex items-center gap-0.5"><Radio className="h-2.5 w-2.5" />DATA</span>}
                {a.isCopyMaster && <span className="text-[8px] px-1 py-0.5 rounded bg-[#f5a623]/15 text-[#f5a623]">MASTER</span>}
              </div>
              <div className="text-[10px] text-muted-foreground">{BROKER_META[a.brokerType as BrokerType]?.name ?? (a.brokerType.startsWith('OA-') ? `${a.brokerType.slice(3)} (openalgo)` : a.brokerType)} · {a.clientId ?? '—'}</div>
            </div>
            <CapCell label="Usable" value={a.usableCapital} />
            <CapCell label="Initial" value={a.initialCapital} />
            <CapCell label="PnL gross" value={a.realizedPnl} pnl />
            <CapCell label="PnL net" value={a.netPnl ?? (a.realizedPnl - a.chargesPaid)} pnl />
            <CapCell label="Pocket @LTP" value={a.pocket ?? ((a.netPnl ?? (a.realizedPnl - a.chargesPaid)) + (a.openNet ?? 0))} pnl />
            <CapCell label="Charges" value={a.chargesPaid} muted />
            <CapCell label="Deployed" value={a.deployed} muted />
            <div className="flex items-center gap-3">
              <Flag
                on={a.isLiveDataSource}
                label="Data"
                onChange={v => patch(a.id, { isLiveDataSource: v })}
              />
              <Flag
                on={a.isOrderEnabled}
                label="Orders"
                onChange={v => patch(a.id, { isOrderEnabled: v })}
              />
              <Flag
                on={a.isCopyMaster}
                label="Master"
                onChange={v => patch(a.id, { isCopyMaster: v })}
              />
            </div>
            <div className="flex items-center gap-1 ml-auto">
              <ModeSelect id={a.id} current={a.mode} />
              <ChargesDialog accountId={a.id} label={a.label} brokerType={a.brokerType} />
              {a.brokerType !== 'SIMFEED' && <EditAccountDialog accountId={a.id} brokerType={a.brokerType} />}
              {a.brokerType !== 'SIMFEED' && <SessionDialog accountId={a.id} label={a.label} brokerType={a.brokerType} />}
              <Button variant="ghost" size="sm" className="h-7 px-1.5" title="Delete"
                onClick={() => remove(a.id, a.label)}>
                <Trash2 className="h-3.5 w-3.5 text-[#ff4d5e]" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Map the add-account form to the broker's OAuth credential schema
 *  (app credentials — session tokens are created via the Session dialog). */
function oauthFieldsFor(b: BrokerType, form: { apiKey: string; secret: string; extra: string; clientId: string }): Record<string, string> {
  switch (b) {
    case 'ICICI_BREEZE':
      return { apiKey: form.apiKey, apiSecret: form.secret }
    case 'DHAN':
      return { appId: form.apiKey, appSecret: form.secret, clientId: form.extra || form.clientId }
    case 'SHOONYA':
      return { userId: form.extra || form.clientId, apiKey: form.apiKey, apiSecret: form.secret }
    default:
      return { apiKey: form.apiKey, secret: form.secret }
  }
}
function credFieldLabel(b: BrokerType) {
  return b === 'DHAN' ? 'Partner ID (optional)' : b === 'SHOONYA' ? 'API key (app client_id)' : b === 'ICICI_BREEZE' ? 'API key (Breeze AppKey)' : 'API Key'
}
function secretFieldLabel(b: BrokerType) {
  return b === 'DHAN' ? 'Partner Secret (optional)' : b === 'SHOONYA' ? 'API Secret' : b === 'ICICI_BREEZE' ? 'API Secret' : 'Secret'
}
function extraFieldLabel(b: BrokerType): string | null {
  return b === 'DHAN' ? 'Dhan Client ID' : b === 'SHOONYA' ? 'User ID (login id)' : null
}

// ---- sample-code hints: every input shows a realistic example ----
function clientIdHint(b: BrokerType): string {
  if (b === 'DHAN') return 'Your Dhan trading client id — used for orders + funds. Example: 1100123456'
  if (b === 'SHOONYA') return 'Optional here — the User ID field below is what Shoonya auth needs.'
  if (b === 'ICICI_BREEZE') return 'Optional label — Breeze auth uses the API key + secret only.'
  return 'Any label id for your own reference.'
}
function clientIdSample(b: BrokerType): string {
  if (b === 'DHAN') return 'e.g. 1100123456'
  if (b === 'SHOONYA') return 'e.g. FA12345 (or leave blank)'
  return 'e.g. desk-01'
}
function credFieldSample(b: BrokerType): string {
  if (b === 'DHAN') return 'Optional — partner apps only, e.g. 2ab1c3d4-56e7-89fa-b0c1-d2e3f4a5b6c7 (enables the consent flow)'
  if (b === 'SHOONYA') return 'App client_id from Prism → Apps, e.g. 68f3a1b9c2d4e5f6a7b8c9d0e1f2a3b4'
  if (b === 'ICICI_BREEZE') return 'Breeze AppKey from ICICI Direct API portal, e.g. Naa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'
  return 'optional for sim accounts'
}
function secretFieldSample(b: BrokerType): string {
  if (b === 'DHAN') return 'Optional — partner secret, e.g. ey9x8w7v6u5t4s3r2q1p0o9n8m7l6k5j. No partner app? Use PIN:TOTP in the Session dialog instead'
  if (b === 'SHOONYA') return 'App secret from Prism, e.g. 9d8c7b6a5f4e3d2c1b0a998877665544'
  if (b === 'ICICI_BREEZE') return 'REQUIRED — customerdetails checksum input, e.g. p9Q8r7S6t5U4v3W2x1Y0z9A8b7C6d5E4'
  return 'optional'
}
function extraFieldSample(b: BrokerType): string | undefined {
  if (b === 'DHAN') return 'e.g. 1100123456'
  if (b === 'SHOONYA') return 'e.g. FA12345'
  return undefined
}

// ---------------- Charges schedule (per account, editable) ----------------
// Brokerage + every statutory tax line for THIS account.  Defaults come from
// today's market values flavoured per broker; the user edits any number and
// saves — every fill / margin / P&L then uses the edited schedule.  A live
// example round-trip (75-qty option buy @100 / sell @110) shows exactly how
// much lands in pocket after brokerage + STT + txn + GST + SEBI + stamp.
const CHARGE_SEGMENTS: [string, string][] = [
  ['EQ_INTRADAY', 'Equity intraday'],
  ['EQ_DELIVERY', 'Equity delivery'],
  ['FUT', 'Futures'],
  ['OPT', 'Options'],
]
const CHARGE_FIELDS: [keyof ChargeSegment, string, string][] = [
  ['brokerageFlat', 'Brokerage ₹/order', 'flat rupees per executed order'],
  ['brokeragePct', 'Brokerage %', 'fraction of turnover, e.g. 0.0003 = 0.03% (0 = flat only)'],
  ['sttBuy', 'STT buy %', 'securities transaction tax on buy value'],
  ['sttSell', 'STT sell %', 'securities transaction tax on sell value'],
  ['txn', 'Txn/Exchange %', 'exchange transaction charges'],
  ['sebi', 'SEBI %', 'SEBI turnover fee'],
  ['stampBuy', 'Stamp buy %', 'stamp duty on buy side'],
  ['gstPct', 'GST %', 'GST on brokerage + txn + SEBI'],
]

function ChargesDialog({ accountId, label, brokerType }: { accountId: string; label: string; brokerType: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sched, setSched] = useState<ChargeSchedule | null>(null)
  const { data, refetch } = useQuery({
    queryKey: ['charges', accountId],
    queryFn: () => api.chargesGet(accountId),
    enabled: open,
  })

  const merge = (resp: ChargesResp | undefined) => {
    if (resp) setSched(JSON.parse(JSON.stringify(resp.schedule)) as ChargeSchedule)
  }
  // load the effective schedule into editable state whenever the dialog opens
  useEffect(() => {
    if (open && sched === null && data) merge(data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, data])

  const setField = (seg: string, key: keyof ChargeSegment, v: string) => {
    if (!sched) return
    const num = parseFloat(v)
    const next = { ...sched, [seg]: { ...sched[seg], [key]: isNaN(num) ? 0 : num } }
    setSched(next as ChargeSchedule)
  }

  const save = async () => {
    if (!sched) return
    setBusy(true)
    try {
      await api.chargesPut(accountId, sched)
      toast.success(`Charges saved for ${label} — every fill now books these rates`)
      await refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'save failed') }
    setBusy(false)
  }

  const reset = async () => {
    setBusy(true)
    try {
      await api.chargesReset(accountId)
      toast.success('Reset to today\'s default market values')
      setSched(null)
      await refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'reset failed') }
    setBusy(false)
  }

  const ex = data?.example
  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) setSched(null) }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-1.5" title="Brokerage, taxes & charges for this account — view + edit"
          onClick={() => { setSched(null) }}>
          <Calculator className="h-3.5 w-3.5 text-[#f5a623]" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto bg-card">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Calculator className="h-4 w-4 text-[#f5a623]" />
            Charges — {label} <span className="text-[10px] font-normal text-muted-foreground">({BROKER_META[brokerType as BrokerType]?.name ?? brokerType})</span>
            {data?.customized && <span className="text-[9px] px-1 py-0.5 rounded bg-[#f5a623]/15 text-[#f5a623]">CUSTOMIZED</span>}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Defaults are <b>today&apos;s market values</b> for this broker (statutory taxes identical for all brokers; brokerage differs).
          Edit any number — every fill, the margin calculator and the P&amp;L math instantly use YOUR rates, so net profit after
          brokerage + STT + all taxes is always the REAL amount.
        </p>
        {data?.source && (
          <div className="text-[10px] text-muted-foreground rounded border border-border/60 bg-secondary/30 px-2 py-1.5 leading-relaxed">
            <b className="text-foreground">{data.source.name}</b> — rates referenced from this broker&apos;s own pricing,
            <b className="text-foreground"> as of {data.source.asOf}</b>. {data.source.note}
            {data.source.links.length > 0 && (
              <span className="block mt-0.5">
                Verify / update:{' '}
                {data.source.links.map((l, i) => (
                  <span key={l}>
                    {i > 0 && ' · '}
                    <a href={l} target="_blank" rel="noreferrer" className="text-[#4dd0e1] underline break-all">{l}</a>
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
        {!sched && <div className="text-[10px] text-muted-foreground py-3">loading schedule…</div>}
        {sched && (
          <div className="space-y-2">
            {CHARGE_SEGMENTS.map(([seg, segLabel]) => (
              <div key={seg} className="rounded border border-border/60">
                <div className="px-2 py-1 text-[10px] font-bold bg-secondary/50">{segLabel}</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-2">
                  {CHARGE_FIELDS.map(([key, fieldLabel, hint]) => (
                    <label key={key} className="block" title={hint}>
                      <span className="block text-[8px] text-muted-foreground uppercase tracking-wide">{fieldLabel}</span>
                      <Input
                        type="number" step="any" min="0"
                        value={String(sched[seg]?.[key] ?? 0)}
                        onChange={e => setField(seg, key, e.target.value)}
                        className="h-6 text-[10px] tabular bg-secondary/60"
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {/* live example — the whole point: what you KEEP after charges */}
            {ex && (
              <div className="rounded border border-[#f5a623]/40 bg-[#f5a623]/5 p-2 space-y-1">
                <div className="text-[10px] font-bold text-[#f5a623]">LIVE EXAMPLE — buy 75 qty option @ ₹100, sell @ ₹110</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-[9px] tabular">
                  <div><span className="text-muted-foreground">brokerage buy+sell</span><div className="font-bold">{fmtInr(ex.buy.brokerage + ex.sell.brokerage)}</div></div>
                  <div><span className="text-muted-foreground">STT (sell)</span><div className="font-bold">{fmtInr(ex.sell.stt)}</div></div>
                  <div><span className="text-muted-foreground">txn charges</span><div className="font-bold">{fmtInr(ex.buy.transaction + ex.sell.transaction)}</div></div>
                  <div><span className="text-muted-foreground">GST</span><div className="font-bold">{fmtInr(ex.buy.gst + ex.sell.gst)}</div></div>
                  <div><span className="text-muted-foreground">SEBI</span><div className="font-bold">{fmtInr(ex.buy.sebi + ex.sell.sebi)}</div></div>
                  <div><span className="text-muted-foreground">stamp (buy)</span><div className="font-bold">{fmtInr(ex.buy.stamp)}</div></div>
                  <div><span className="text-muted-foreground">gross P&L</span><div className="font-bold">{fmtInr(ex.grossPnl)}</div></div>
                  <div><span className="text-muted-foreground">total charges</span><div className="font-bold text-[#ff4d5e]">−{fmtInr(ex.totalCharges)}</div></div>
                  <div><span className="text-muted-foreground">breakeven exit</span><div className="font-bold tabular">₹{ex.breakeven}</div></div>
                  <div className="col-span-2"><span className="text-muted-foreground">NET in pocket after ALL charges</span><div className={`font-bold text-xs ${ex.netPnl >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{fmtInr(ex.netPnl)}</div></div>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" className="h-7 text-xs" onClick={save} disabled={busy || !sched}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Save charges
              </Button>
              <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={reset} disabled={busy}>
                <RotateCcw className="h-3 w-3" /> Reset to defaults
              </Button>
              <span className="text-[9px] text-muted-foreground ml-auto">saved per account · affects fills, margin calc & P&L immediately</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------- Bulk accounts via JSON (Round-24, expanded Round-25) -----
// An ALTERNATIVE to the add/edit UI: the textarea is prefilled with the FULL
// current accounts (GET /accounts/export — raw credentials + live session
// tokens + capital config + flags).  Edit in place and Apply:
//  · row WITH id        → modify (any field incl. credentials/session merge)
//  · row WITHOUT id     → add (the pasted copy fully recreates the account,
//                         session included — no Session dialog needed)
//  · "_delete": true    → delete that row
//  · "delete missing"   → also delete every account absent from the JSON
// The textarea SCROLLS INTERNALLY (max-height) so any number of accounts fits
// the screen, and Copy puts the whole JSON on the clipboard for backup/sharing.
function BulkAccountsDialog({ accounts }: { accounts: AccountRow[] }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleteMissing, setDeleteMissing] = useState(false)
  const [result, setResult] = useState<BulkApplyResp | null>(null)

  const fallbackPrefill = () => {
    const rows = accounts.map(a => {
      const extra = a as AccountRow & { modeLabel2?: string | null; credentials?: Record<string, string> }
      return {
        id: a.id,
        label: a.label,
        broker: BROKER_API_NAME[a.brokerType as BrokerType] ?? String(a.brokerType ?? '').toLowerCase(),
        mode: extra.modeLabel2 ?? 'live',
        credentials: extra.credentials ?? {},
        initialCapital: a.initialCapitalFixed ?? null,
        capitalPct: a.capitalPct ?? 100,
        capitalMode: a.mode,
      }
    })
    setText(JSON.stringify(rows, null, 2))
    setResult(null)
  }

  // FULL export — raw credentials + session tokens (GET /accounts/export)
  const prefill = async () => {
    try {
      const r = await api.accountsExport()
      setText(JSON.stringify(r.accounts, null, 2))
      setResult(null)
    } catch {
      fallbackPrefill()
    }
  }

  const apply = async () => {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch (e) { toast.error(`Invalid JSON — ${(e as Error).message}`); return }
    if (!Array.isArray(parsed)) { toast.error('Top level must be a JSON array [ … ]'); return }
    setBusy(true)
    try {
      const r = await api.accountsBulk(parsed, deleteMissing)
      setResult(r)
      if (r.ok) toast.success(`Applied — ${r.counts.created} added · ${r.counts.modified} modified · ${r.counts.deleted} deleted`)
      else toast.error(`${r.counts.errors} row(s) failed — check the details below`)
      qc.invalidateQueries({ queryKey: ['accounts'] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Bulk apply failed') }
    setBusy(false)
  }

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (o) void prefill() }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="text-xs" title="Add / modify / delete many accounts at once from JSON — full data incl. credentials & sessions">
          Bulk JSON
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-popover max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Bulk accounts — JSON</DialogTitle></DialogHeader>
        <div className="space-y-2.5 text-xs min-w-0">
          <div className="text-[10px] text-muted-foreground leading-snug">
            Prefilled with <b>ALL current account data</b> — credentials, session tokens, capital config, flags — straight
            from the export. Edit and Apply: row with <code>id</code> → <b>modify</b> · without <code>id</code> → <b>add</b>
            {' '}({'—'} a pasted copy fully recreates the account, session included) · <code>&quot;_delete&quot;: true</code> →
            <b> delete</b> · <code>initialCapital: null</code> → % of broker available cash · <code>capitalMode</code>:
            PROFIT_ONLY | INITIAL_PLUS_PNL | INITIAL_WITH_LOSS_REDUCTION | LIVE_BALANCE · <code>broker</code>:
            sim | breeze | dhan | shoonya. Copy the JSON to back up or clone an account.
          </div>
          <Textarea value={text} onChange={e => setText(e.target.value)}
            className="font-mono text-[10.5px] leading-snug h-[42vh] min-h-[200px] max-h-[55vh] resize-y overflow-y-auto bg-[#0b0e14] w-full min-w-0 block"
            spellCheck={false} />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" className="h-8 text-xs" onClick={apply} disabled={busy || !text.trim()}>
              {busy ? 'Applying…' : 'Apply changes'}
            </Button>
            <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={() => void prefill()} disabled={busy}>
              Reset to current
            </Button>
            <Button size="sm" variant="secondary" className="h-8 text-xs" disabled={!text.trim()}
              onClick={() => { void navigator.clipboard?.writeText(text); toast.info('Account JSON copied to clipboard') }}>
              Copy JSON
            </Button>
            <label className="flex items-center gap-1.5 text-[10px] text-[#ff7a7a] cursor-pointer select-none">
              <Switch checked={deleteMissing} onCheckedChange={setDeleteMissing} className="scale-[0.8]" />
              Delete accounts MISSING from this JSON
            </label>
          </div>
          {result && (
            <div className="rounded border border-border p-2 space-y-1 max-h-40 overflow-y-auto">
              <div className="text-[10px] text-muted-foreground">
                +{result.counts.created} added · {result.counts.modified} modified · {result.counts.deleted} deleted · {result.counts.errors} failed
              </div>
              {result.detail.map((d, i) => (
                <div key={i} className="text-[10px] flex items-center gap-1.5">
                  <span className={d.ok ? 'term-up' : 'term-down'}>{d.ok ? '✓' : '✗'}</span>
                  <span className="text-muted-foreground">row {d.row ?? '—'}</span>
                  <span className="break-words">{d.action ?? ''}{d.label ? ` — ${d.label}` : ''}{d.error ? ` — ${d.error}` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- Edit account (credentials + ids) ----------------
// Round-10: modify user id / client id / api key / secret at any time —
// masked placeholders show what is stored; only filled fields change
// (PATCH credentialsMerge), so secrets never need retyping.
function EditAccountDialog({ accountId, brokerType }: { accountId: string; brokerType: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('')
  const [clientId, setClientId] = useState('')
  const [vals, setVals] = useState<Record<string, string>>({})
  const { data: st } = useQuery({
    queryKey: ['broker-auth', accountId],
    queryFn: () => api.brokerAuthStatus(accountId),
    enabled: open,
  })

  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = {}
      if (label.trim()) body.label = label.trim()
      if (clientId.trim()) body.clientId = clientId.trim()
      const merge: Record<string, string> = {}
      for (const [k, v] of Object.entries(vals)) if (v.trim()) merge[k] = v.trim()
      if (Object.keys(merge).length) body.credentialsMerge = merge
      if (!Object.keys(body).length) { toast.info('Nothing changed'); setBusy(false); return }
      await api.patchAccount(accountId, body)
      toast.success('Account updated')
      setVals({})
      setLabel(''); setClientId('')
      setOpen(false)
      qc.invalidateQueries({ queryKey: ['accounts'] })
      qc.invalidateQueries({ queryKey: ['broker-auth', accountId] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    setBusy(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-1.5" title="Edit account details (user id / client id / api key / secret)">
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-popover max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader><DialogTitle>Edit account — {st?.label ?? ''}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-xs min-w-0 max-w-full">
          <div className="text-[10px] text-muted-foreground">
            Stored values show masked. Leave a field EMPTY to keep the current value — secrets never need retyping.
          </div>
          <Field label="Label">
            <Input value={label} onChange={e => setLabel(e.target.value)} className="h-8" placeholder={st?.label ?? 'account label'} />
          </Field>
          {st?.credFields.map(f => (
            <Field key={f.key} label={f.label} hint={`${f.sample} · stored: ${f.masked ?? '—'}`}>
              <Input
                value={vals[f.key] ?? ''}
                onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value }))}
                className="h-8"
                type={/secret/i.test(f.key) ? 'password' : 'text'}
                placeholder={f.masked ? `${f.masked} (unchanged)` : f.sample}
              />
            </Field>
          ))}
          {st && !st.credFields.length && (
            <div className="text-[10px] text-muted-foreground">Sim account — no broker credentials to edit.</div>
          )}
          <div className="text-[10px] text-muted-foreground">
            After changing credentials, recreate the day session via the Session button, then press “Test connection” in Broker Diagnostics.
          </div>
          <Button className="h-8 text-xs" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- Broker session (OAuth) dialog ----------------
// Per-broker day-session creation: open the login URL → paste the
// redirect code/token → the server exchanges it for session tokens.
function SessionDialog({ accountId, label, brokerType }: { accountId: string; label: string; brokerType: string }) {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [consentUrl, setConsentUrl] = useState<string | null>(null)
  const [credVals, setCredVals] = useState<Record<string, string>>({})
  const [savingCreds, setSavingCreds] = useState(false)
  const qc = useQueryClient()
  const { data: st } = useQuery({
    queryKey: ['broker-auth', accountId],
    queryFn: () => api.brokerAuthStatus(accountId),
    enabled: open,
    refetchInterval: 15_000,
  })
  const isDhan = brokerType === 'DHAN'
  const isShoonya = brokerType === 'SHOONYA'
  const isIcici = brokerType === 'ICICI_BREEZE'
  // credentials not saved yet on this account — show the inline save form so
  // the paste-never-works dead end ("Save the App Key first") cannot happen
  const missingFields = (st?.credFields ?? []).filter(f => st?.fieldsNeeded.includes(f.key))

  const saveCreds = async () => {
    const merge: Record<string, string> = {}
    for (const [k, v] of Object.entries(credVals)) if (v.trim()) merge[k] = v.trim()
    if (!Object.keys(merge).length) { toast.info('Type the missing values first'); return }
    setSavingCreds(true)
    try {
      await api.patchAccount(accountId, { credentialsMerge: merge })
      toast.success('Credentials saved — the login URL + paste flow below now work')
      setCredVals({})
      qc.invalidateQueries({ queryKey: ['broker-auth', accountId] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') }
    setSavingCreds(false)
  }

  const run = async (fn: () => Promise<{ ok: boolean; loginUrl?: string; message: string }>) => {
    setBusy(true)
    try {
      const r = await fn()
      if (r.loginUrl) setConsentUrl(r.loginUrl)
      r.ok ? toast.success(r.message) : toast.error(r.message)
      if (r.ok) { setCode(''); qc.invalidateQueries({ queryKey: ['broker-auth', accountId] }) }
    } catch (e) { toast.error(e instanceof Error ? e.message : 'failed') }
    setBusy(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-1.5 gap-1" title={`Create the ${brokerType} API session`}>
          <KeyRound className={`h-3.5 w-3.5 ${st?.hasSession ? 'text-[#00c896]' : 'text-muted-foreground'}`} />
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-popover max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader><DialogTitle>Broker session — {label}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-xs min-w-0 max-w-full">
          {st && (
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className={`px-1.5 py-0.5 rounded ${st.hasSession ? 'bg-up text-[#00c896]' : 'bg-secondary text-muted-foreground'}`}>
                {st.hasSession ? `session ${st.sessionMasked}` : 'no session'}
              </span>
              <span className="text-muted-foreground">{st.mode}</span>
              <span className="text-muted-foreground">· session kind: {st.sessionKind}</span>
            </div>
          )}
          <ol className="list-decimal list-inside space-y-0.5 text-[10px] text-muted-foreground">
            {(st?.instructions ?? []).map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {missingFields.length > 0 && (
            <div className="rounded border border-[#f5a623]/40 bg-[#f5a623]/5 p-2 space-y-1.5">
              <div className="text-[10px] text-[#f5a623] font-medium">
                Missing credentials — save them here first (or use the pencil edit):
              </div>
              {missingFields.map(f => (
                <div key={f.key} className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground w-[150px] shrink-0" title={f.sample}>{f.label}</span>
                  <Input
                    value={credVals[f.key] ?? ''}
                    onChange={e => setCredVals(v => ({ ...v, [f.key]: e.target.value }))}
                    className="h-7 text-[11px]"
                    type={/secret/i.test(f.key) ? 'password' : 'text'}
                    placeholder={f.sample}
                  />
                </div>
              ))}
              <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={savingCreds} onClick={saveCreds}>
                {savingCreds ? 'Saving…' : 'Save credentials'}
              </Button>
            </div>
          )}
          {st?.loginUrl && (
            <div className="flex items-center gap-1.5 min-w-0">
              <a href={st.loginUrl} target="_blank" rel="noreferrer" className="text-[10px] underline text-[#4dd0e1] truncate flex-1 min-w-0 break-all" title={st.loginUrl}>
                {st.loginUrl}
              </a>
              <Button size="sm" variant="secondary" className="h-6 text-[10px] shrink-0" onClick={() => { void navigator.clipboard?.writeText(st.loginUrl!); toast.info('Login URL copied') }}>copy</Button>
            </div>
          )}
          {consentUrl && (
            <div className="flex items-center gap-1.5 min-w-0">
              <a href={consentUrl} target="_blank" rel="noreferrer" className="text-[10px] underline text-[#ffb86b] truncate flex-1 min-w-0 break-all" title={consentUrl}>
                {consentUrl}
              </a>
              <Button size="sm" variant="secondary" className="h-6 text-[10px] shrink-0" onClick={() => { void navigator.clipboard?.writeText(consentUrl); toast.info('Consent login URL copied') }}>copy</Button>
            </div>
          )}
          {isDhan && (
            <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy}
              onClick={() => run(() => api.brokerAuthConsent(accountId))}>
              1 · Generate consent (Dhan client id)
            </Button>
          )}
          {isDhan && st?.serverIp && (
            <div className="border-t border-border pt-2 space-y-1 text-[10px] text-muted-foreground">
              <div>
                Server IP: <b className="text-foreground">{st.serverIp}</b>
                {st.ipInfo?.registered?.length
                  ? <> · registered in Dhan: <span className="text-foreground">{st.ipInfo.registered.join(', ')}</span></>
                  : ' · nothing registered yet'}
              </div>
              {st.ipInfo && st.ipInfo.matches === false && (
                <div className="text-[#ff7a7a]">Mismatch — Dhan API calls fail from non-whitelisted IPs (SEBI static-IP rule).</div>
              )}
              {st.ipInfo?.error && <div className="text-[#ffb86b]">IP check: {st.ipInfo.error}</div>}
              <Button size="sm" variant="secondary" className="h-6 text-[10px]" disabled={busy || !st.hasSession}
                title={st.hasSession ? 'Set/modify the Dhan-registered IP to this server\u2019s public IP' : 'Create the Dhan session first — IP APIs need the access token'}
                onClick={() => run(() => api.brokerIpSync(accountId))}>
                Sync server IP to Dhan
              </Button>
            </div>
          )}
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground">
              {isIcici ? '2 · Paste the apisession from the redirect URL'
                : isDhan ? '2 · Paste PIN:TOTP, the redirect tokenId, or a direct access token'
                : isShoonya ? '2 · Paste the code from the redirect URL (or use QuickAuth below)'
                : 'Paste the session token'}
            </div>
            <div className="flex gap-1.5">
              <Input value={code} onChange={e => setCode(e.target.value.trim())} placeholder={
                isIcici ? 'e.g. 48293 — from redirect ?apisession='
                  : isDhan ? 'PIN:TOTP e.g. 123456:987654 · tokenId from redirect · or the full JWT'
                  : isShoonya ? 'e.g. a1b2c3d4… — from redirect ?code=  ·  QuickAuth: mypass:ABCD1234E(:totp)'
                  : 'code / token…'} className="h-8 text-[11px]" />
              <Button size="sm" className="h-8 text-[11px]" disabled={busy || !code}
                onClick={() => run(() => api.brokerAuthComplete(accountId, code))}>
                Create session
              </Button>
            </div>
          </div>
          {isShoonya && (
            <div className="border-t border-border pt-2 text-[10px] text-muted-foreground">
              Shoonya&apos;s <b>QuickAuth (pwd:factor2) is vendor-gated now</b> and the old NorenWClientTP gateway is
              decommissioned (HTTP 502) — the OAuth code flow above is the only consumer login. Save the account with
              API Key (client_id) + API secret, open the login URL, and paste the FRESH <code>?code=</code> from the
              redirect (single-use, expires in minutes). The docs checksum sha256(client_id+secret+code) is tried first.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      {children}
      {hint && <div className="text-[9px] text-muted-foreground/70 break-words">{hint}</div>}
    </div>
  )
}

function CapCell({ label, value, pnl, muted }: { label: string; value: number; pnl?: boolean; muted?: boolean }) {
  return (
    <div className="min-w-[86px]">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={`text-[11px] tabular ${pnl ? (value >= 0 ? 'term-up' : 'term-down') : muted ? 'text-muted-foreground' : ''}`}>{fmtInr(value)}</div>
    </div>
  )
}

function Flag({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer select-none">
      <Switch checked={on} onCheckedChange={onChange} className="scale-[0.8]" />
      <span className={`text-[10px] ${on ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
    </label>
  )
}

function ModeSelect({ id, current }: { id: string; current: string | null }) {
  const qc = useQueryClient()
  return (
    <Select value={current ?? undefined} onValueChange={v => api.patchAccount(id, { mode: v }).then(() => qc.invalidateQueries({ queryKey: ['accounts'] }))}>
      <SelectTrigger className="h-7 w-[150px] text-[10px]"><SelectValue placeholder="sizing mode" /></SelectTrigger>
      <SelectContent>
        {(Object.keys(CAPITAL_MODES) as CapitalMode[]).map(m => (
          <SelectItem key={m} value={m} className="text-[11px]">
            <span title={CAPITAL_MODES[m].detail}>{CAPITAL_MODES[m].label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------- Copy trading ----------------
function CopyTradeManager() {
  const qc = useQueryClient()
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data: ctRest } = useQuery({ queryKey: ['copytrade-admin'], queryFn: () => api.copyTrade(), enabled: !adm, refetchInterval: 5000 })
  const { data: acc } = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts() })
  const ct = adm?.copyTrade ? { config: adm.copyTrade as unknown as CopyTradeCfg } : ctRest
  const cfg = ct?.config
  const accounts = acc?.accounts ?? []

  const patch = async (body: Record<string, unknown>) => {
    await api.patchCopyTrade(body).catch(e => toast.error(e.message))
    qc.invalidateQueries({ queryKey: ['copytrade-admin'] })
    qc.invalidateQueries({ queryKey: ['copytrade-quick'] })
  }

  if (!cfg) return null
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Copy Trading Engine</h3>
          <p className="text-[11px] text-muted-foreground">Orders placed from the terminal fan out to every order-enabled account, sized by each account&apos;s capital rules.</p>
        </div>
        <Switch checked={cfg.enabled} onCheckedChange={v => patch({ enabled: v })} />
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <Field label="Mirror source (master account)">
          <Select value={cfg.masterAccountId ?? ''} onValueChange={v => patch({ masterAccountId: v })}>
            <SelectTrigger className="h-8"><SelectValue placeholder="Any manual order" /></SelectTrigger>
            <SelectContent>
              {accounts.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={`Capital share per signal — ${cfg.capitalSharePct}%`}>
          <input
            type="range" min={5} max={100} step={5} value={cfg.capitalSharePct}
            onChange={e => patch({ capitalSharePct: Number(e.target.value) })}
            className="w-full accent-[#f5a623]"
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className={`text-xs h-8 ${cfg.killSwitch ? 'bg-[#ff4d5e] hover:bg-[#f03d4e] text-black' : ''}`}
          onClick={() => patch({ killSwitch: !cfg.killSwitch })}
        >
          {cfg.killSwitch ? <><ShieldAlert className="h-3.5 w-3.5 mr-1" /> Kill Switch ACTIVE</> : <><ShieldCheck className="h-3.5 w-3.5 mr-1" /> Arm Kill Switch</>}
        </Button>
        <span className="text-[10px] text-muted-foreground">Kill switch blocks all order routing instantly.</span>
      </div>
    </div>
  )
}

// ---------------- Master contracts ----------------
// "Sync Now" syncs EVERY active/connected broker ACCOUNT (per-account
// adapters keep their live sessions) and records per-account history.
// Default syncs: when a broker account CONNECTS and at DAY START (new
// symbols list daily) — both handled by the backend engines loop.
function MasterContracts() {
  const qc = useQueryClient()
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  // REST carries the rich payload (brokers + history); the sync:admin copy is
  // only a fallback while the socket is down
  const { data: rest } = useQuery({ queryKey: ['sync-info'], queryFn: () => api.syncInfo(), refetchInterval: 15000 })
  const data = rest ?? (adm?.syncInfo as unknown as SyncInfoResp | undefined)
  const [busy, setBusy] = useState(false)
  const [busyOne, setBusyOne] = useState<string | null>(null)

  const sync = async () => {
    setBusy(true)
    try {
      const r = await api.syncSymbols()
      const accs = r.accounts ?? r.detail?.length ?? 0
      toast.success(`Master contracts synced — ${r.symbolCount.toLocaleString('en-IN')} symbols, ${r.mappedCount.toLocaleString('en-IN')} broker mappings across ${accs} account(s)`)
      qc.invalidateQueries({ queryKey: ['sync-info'] })
      qc.invalidateQueries({ queryKey: ['symbols'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed')
    } finally { setBusy(false) }
  }

  // on-demand per-broker sync — user can re-sync ANY single broker anytime
  const syncOne = async (b: { broker: string; accountId?: number | null; accountLabel?: string | null }) => {
    if (!b.accountId) { toast.error(`No account configured for ${b.broker} — add one first`); return }
    setBusyOne(b.broker)
    try {
      const r = await api.syncAccount(b.accountId)
      if (r.error) toast.error(`${b.broker} sync failed — ${r.error}`)
      else toast.success(`${b.broker} synced — ${Number(r.symbols ?? 0).toLocaleString('en-IN')} symbols, ${Number(r.mappings ?? 0).toLocaleString('en-IN')} mappings`)
      qc.invalidateQueries({ queryKey: ['sync-info'] })
      qc.invalidateQueries({ queryKey: ['symbols'] })
      qc.invalidateQueries({ queryKey: ['fnoUniverse'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${b.broker} sync failed`)
    } finally { setBusyOne(null) }
  }

  const stale = data?.lastSync ? Date.now() - new Date(data.lastSync).getTime() > 20 * 3600_000 : true
  const brokers = data?.brokers ?? []
  const history = (data?.history ?? []).slice(0, 12)
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Master Contracts (Symbols)</h3>
          <p className="text-[11px] text-muted-foreground">Downloads the REAL broker master files (Dhan scrip-master CSV + Noren symbols) — every tradable NSE/NFO/BFO/MCX/CDS contract with exact tokens per broker. No generated demo symbols.</p>
        </div>
        <Button size="sm" className="text-xs h-8" disabled={busy} onClick={sync} title="Syncs every active/connected broker account (parallel) and rebuilds the symbol universe">
          {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {busy ? 'Syncing all accounts…' : 'Sync Now (all active)'}
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Symbols" value={String(data?.counts.symbols ?? '—')} />
        <Stat label="Broker Mappings" value={String(data?.counts.mappings ?? '—')} />
        <Stat label="Last Sync" value={data?.lastSync ? fmtDateTime(data.lastSync) : 'never'} warn={stale} />
      </div>

      {/* broker-wise status */}
      {brokers.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">per-broker sync status</div>
          <div className="grid sm:grid-cols-2 gap-1.5">
            {brokers.map(b => (
              <div key={b.broker} className="rounded bg-secondary/40 px-2 py-1.5 flex items-center gap-2 text-[10px]">
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${b.connected ? 'bg-[#00c896]' : 'bg-muted-foreground/40'}`} title={b.connected ? 'account connected' : 'not connected'} />
                <span className="font-bold uppercase">{b.broker}</span>
                <span className="text-muted-foreground truncate">{b.accountLabel ?? '—'}</span>
                <span className="tabular ml-auto">{b.symbols.toLocaleString('en-IN')} sym</span>
                <span className="tabular text-muted-foreground">{b.lastSync ? fmtDateTime(b.lastSync) : 'never'}</span>
                {b.lastTrigger && <span className="px-1 rounded bg-secondary text-[8px] uppercase">{b.lastTrigger}</span>}
                {b.lastStatus === 'failed' && (
                  <span className="text-[#ff4d5e] font-bold" title={b.lastError ?? 'sync failed'}>failed</span>
                )}
                {/* per-broker on-demand sync */}
                <button
                  onClick={() => syncOne(b)}
                  disabled={busyOne === b.broker}
                  className="ml-1 shrink-0 rounded p-1 bg-secondary/80 hover:bg-accent disabled:opacity-50"
                  title={`Re-sync ${b.broker} master contracts now${b.accountId ? '' : ' (no account configured)'}`}
                >
                  {busyOne === b.broker
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <RefreshCw className="h-3 w-3" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* sync history */}
      {history.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">sync history (when · trigger · counts)</div>
          <div className="rounded border overflow-x-auto max-h-44 overflow-y-auto">
            <table className="w-full text-[10px] tabular">
              <thead className="bg-secondary/50 text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left px-2 py-1">When</th>
                  <th className="text-left px-2 py-1">Broker</th>
                  <th className="text-left px-2 py-1">Account</th>
                  <th className="text-left px-2 py-1">Trigger</th>
                  <th className="text-right px-2 py-1">Symbols</th>
                  <th className="text-right px-2 py-1">Mappings</th>
                  <th className="text-right px-2 py-1">Took</th>
                  <th className="text-left px-2 py-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id} className="border-t border-border/60">
                    <td className="px-2 py-1">{fmtDateTime(h.ts)}</td>
                    <td className="px-2 py-1 font-bold uppercase">{h.broker}</td>
                    <td className="px-2 py-1 text-muted-foreground">{h.label ?? '—'}</td>
                    <td className="px-2 py-1"><span className="px-1 rounded bg-secondary text-[9px] uppercase">{h.trigger}</span></td>
                    <td className="px-2 py-1 text-right">{h.symbols.toLocaleString('en-IN')}</td>
                    <td className="px-2 py-1 text-right">{h.mappings.toLocaleString('en-IN')}</td>
                    <td className="px-2 py-1 text-right">{h.durationS != null ? `${h.durationS.toFixed(1)}s` : '—'}</td>
                    <td className={`px-2 py-1 ${h.status === 'ok' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`} title={h.error ?? undefined}>
                      {h.status}{h.error ? ' — click row' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground">
        Auto-sync runs when a broker account <b>connects</b> and at <b>day start</b> (after 08:00 IST, once per account per day) — new symbols are listed every day.
        If a master source is unreachable the sync FAILS (no fake symbols are generated) and the failure shows in the history above.
      </div>
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded bg-secondary/50 px-2 py-1.5">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={`text-[11px] tabular ${warn ? 'text-[#f5a623]' : ''}`}>{value}</div>
    </div>
  )
}

// ---------------- Audit trail ----------------
interface AuditRow { id: string; ts: string; source: string; action: string; masterSymbol: string; side: string; qty: number; status: string; message: string | null; legsJson: string | null }
function AuditTrail() {
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data: rest } = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(), enabled: !adm, refetchInterval: 4000 })
  const rows: AuditRow[] = (adm?.audit as unknown as AuditRow[] | undefined) ?? rest?.audits ?? []
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">Order Audit Trail</h3>
        <p className="text-[11px] text-muted-foreground">Every master order and its per-account fan-out legs.</p>
      </div>
      <div className="divide-y divide-border max-h-64 overflow-y-auto">
        {rows.map(r => {
          const legs = safeLegs(r.legsJson)
          return (
            <div key={r.id} className="px-4 py-2 text-[11px]">
              <button className="w-full flex items-center gap-3 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <span className="text-muted-foreground tabular">{fmtDateTime(r.ts)}</span>
                <span className="px-1 rounded bg-secondary text-[9px]">{r.source}</span>
                <span className="font-medium">{r.masterSymbol}</span>
                <span className={r.side === 'BUY' ? 'term-up' : r.side === 'SELL' ? 'term-down' : ''}>{r.side}</span>
                <span className="tabular">{r.qty || '—'}</span>
                <span className={`px-1 rounded text-[9px] ${r.status === 'SUCCESS' ? 'bg-[#00c896]/15 text-[#00c896]' : r.status === 'PARTIAL' ? 'bg-[#f5a623]/15 text-[#f5a623]' : 'bg-[#ff4d5e]/15 text-[#ff4d5e]'}`}>{r.status}</span>
                <span className="text-muted-foreground ml-auto">{legs.length} legs {open === r.id ? '▾' : '▸'}</span>
              </button>
              {open === r.id && (
                <div className="mt-1.5 ml-4 space-y-0.5 text-[10px]">
                  {legs.map((l, i) => (
                    <div key={i} className="flex gap-2">
                      <span className={l.status === 'FILLED' ? 'term-up' : l.status === 'SKIPPED' ? 'text-[#f5a623]' : 'term-down'}>{l.status}</span>
                      <span className="text-muted-foreground">{l.accountLabel}</span>
                      <span className="tabular">{l.qty ? `${l.qty} @ ${l.price ?? '-'}` : l.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {rows.length === 0 && <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">No orders routed yet</div>}
      </div>
    </div>
  )
}

function safeLegs(json: string | null): { accountLabel: string; status: string; qty: number; price?: number; message?: string }[] {
  try { return JSON.parse(json || '[]') } catch { return [] }
}
