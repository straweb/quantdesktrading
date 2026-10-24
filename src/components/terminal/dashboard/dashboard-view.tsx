'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Activity, Calculator, Layers, Trophy, Wallet, Zap, Plus, Trash2, RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, fmtInr, fmtTime } from '../lib/client-api'
import type { PortfolioResp, GttRuleRow, MarginResp } from '../lib/client-api'
import { useSyncChannel, type SyncCore, type SyncAdmin } from '../lib/sync'

// ============================================================
// Dashboard — portfolio, GTT, margin calculator and session
// metrics. Data flows through the websocket sync hub (1s) plus
// on-demand REST (portfolio / GTT / margin).
// ============================================================

function fmtCompact(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`
  if (abs >= 1000) return `₹${(n / 1000).toFixed(1)}k`
  return `₹${Math.round(n)}`
}

export function DashboardView() {
  const core = useSyncChannel<SyncCore>('sync:core')
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data: portfolio } = useQuery({ queryKey: ['portfolio'], queryFn: () => api.portfolio(), refetchInterval: 30_000 })

  const s = core?.session
  const accounts = core?.accounts ?? []
  const totalDeployed = accounts.reduce((x, a) => x + a.deployed, 0)
  const totalUsable = accounts.reduce((x, a) => x + a.usableCapital, 0)
  const openOrders = (core?.orders ?? []).filter(o => o.status === 'OPEN' || o.status === 'PENDING').length
  const totalOrders = (core?.orders ?? []).length
  const fillRate = totalOrders > 0 ? (totalOrders - openOrders) / totalOrders * 100 : null

  // realized P&L curve (cumulative over the session's trades, oldest first)
  const pnlCurve = useMemo(() => {
    const trades = [...(core?.trades ?? [])].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    let cum = 0
    const pts: { t: string; v: number }[] = []
    for (const t of trades) {
      if (t.realizedPnl == null) continue
      cum += t.realizedPnl
      pts.push({ t: t.ts, v: cum })
    }
    return pts
  }, [core])

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 space-y-3 max-w-[1500px] mx-auto">
        {/* KPI row — MASTER (admin) session metrics across all accounts */}
        <div className="grid grid-cols-3 md:grid-cols-7 gap-2">
          <Kpi icon={Activity} label="Net P&L" value={s ? fmtInr(s.net) : '—'} tone={(s?.net ?? 0) >= 0 ? 'up' : 'down'} sub={s ? `realized ${fmtCompact(s.realized)} · open ${fmtCompact(s.unrealized)}` : ''} />
          <Kpi icon={Wallet} label="Pocket @LTP" value={s ? fmtInr(s.pocket ?? s.net) : '—'} tone={(s?.pocket ?? s?.net ?? 0) >= 0 ? 'up' : 'down'} sub="NET after ALL charges if exited at LTP now" />
          <Kpi icon={Trophy} label="Win rate" value={s?.winRate != null ? `${s.winRate.toFixed(0)}%` : '—'} tone={(s?.winRate ?? 0) >= 50 ? 'up' : 'neutral'} sub={s ? `${s.wins}W / ${s.closes - s.wins}L of ${s.closes} closes` : ''} />
          <Kpi icon={Zap} label="Points" value={s ? `${s.pts >= 0 ? '+' : ''}${s.pts.toFixed(1)}` : '—'} tone={(s?.pts ?? 0) >= 0 ? 'up' : 'down'} sub={`${s?.trades ?? 0} trades`} />
          <Kpi icon={Wallet} label="Margin used" value={fmtCompact(totalDeployed)} tone="neutral" sub={`usable ${fmtCompact(totalUsable)} across ${accounts.length} accounts`} />
          <Kpi icon={Layers} label="Charges" value={s ? fmtCompact(s.charges) : '—'} tone="neutral" sub="STT · GST · brokerage · stamp" />
          <Kpi icon={Calculator} label="Fill rate" value={fillRate != null ? `${fillRate.toFixed(0)}%` : '—'} tone="neutral" sub={`${openOrders} open of ${totalOrders} orders`} />
        </div>

        {/* MASTER dashboard — live system health (feed engine, sessions, universe, safety) */}
        <SystemHealth adm={adm} />

        {/* ACCOUNT dashboards — one card per broker account, click for the
            full per-account detail (funds, positions, orders, logs, session) */}
        <AccountDashboards core={core} adm={adm} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* realized P&L curve */}
          <Card title="Realized P&L — this session">
            <PnlCurve pts={pnlCurve} />
          </Card>

          {/* per-account metrics */}
          <Card title="Accounts">
            <table className="w-full text-[10px] tabular">
              <thead className="text-[9px] uppercase tracking-wide text-muted-foreground">
                <tr><Th>Account</Th><Th>Usable</Th><Th>Deployed</Th><Th>Realized</Th><Th>Charges</Th><Th>Open</Th></tr>
              </thead>
              <tbody>
                {accounts.map(a => (
                  <tr key={a.id} className="border-b border-border/40">
                    <Td>
                      <span className="font-medium">{a.label}</span>
                      <span className="text-muted-foreground ml-1.5">{a.brokerType}</span>
                    </Td>
                    <Td className="text-[#00c896]">{fmtCompact(a.usableCapital)}</Td>
                    <Td>{fmtCompact(a.deployed)}</Td>
                    <Td className={a.realizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(a.realizedPnl)}</Td>
                    <Td className="text-muted-foreground">{fmtCompact(a.chargesPaid)}</Td>
                    <Td>{a.openPositions}p / {a.openOrders}o</Td>
                  </tr>
                ))}
                {accounts.length === 0 && <tr><Td className="text-muted-foreground" >no accounts</Td></tr>}
              </tbody>
            </table>
            {(s?.topSymbols.length ?? 0) > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {s!.topSymbols.map(sym => (
                  <span key={sym.symbol} className={`px-1 py-0.5 rounded text-[9px] tabular ${sym.pts >= 0 ? 'bg-up text-[#00c896]' : 'bg-down text-[#ff4d5e]'}`}>
                    {sym.symbol} {sym.pts >= 0 ? '+' : ''}{sym.pts.toFixed(1)}
                  </span>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <PortfolioCard portfolio={portfolio} />
          <MarginCalculator accounts={accounts.map(a => ({ id: a.id, label: a.label, brokerType: a.brokerType }))} />
        </div>

        <GttManager />
      </div>
    </div>
  )
}

// ---------------- building blocks ----------------

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: typeof Activity; label: string; value: string; sub?: string; tone: 'up' | 'down' | 'neutral' }) {
  return (
    <div className="rounded border border-border bg-card p-2.5">
      <div className="flex items-center gap-1 text-[8px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={`tabular font-bold text-base mt-0.5 ${tone === 'up' ? 'term-up' : tone === 'down' ? 'term-down' : ''}`}>{value}</div>
      {sub && <div className="text-[8px] text-muted-foreground leading-tight mt-0.5">{sub}</div>}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border bg-card p-2.5">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1.5">{title}</div>
      {children}
    </div>
  )
}
function Th({ children }: { children: React.ReactNode }) { return <th className="text-left font-medium px-1.5 py-1 whitespace-nowrap">{children}</th> }
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) { return <td className={`px-1.5 py-1 whitespace-nowrap ${className}`}>{children}</td> }

// ---------------- MASTER dashboard — system health strip ----------------
// Live admin overview from the sync:admin websocket: feed engine state,
// per-broker session presence, symbol universe, copy-trade safety switches.
function SystemHealth({ adm }: { adm: SyncAdmin | null }) {
  const feed = adm?.feed
  const meta = adm?.accountsMeta ?? []
  const tickAge = feed?.lastTickTs != null ? Math.max(0, Math.round((Date.now() - feed.lastTickTs) / 1000)) : null
  const liveErr = feed?.sourceIsLive ? feed.lastError : null
  return (
    <Card title="Master — system health">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <HealthCell
          label="Feed engine"
          main={feed == null ? '—' : feed.sourceIsLive ? (feed.fresh ? 'TICKING' : 'STALLED') : 'SIM FEED'}
          tone={feed == null ? 'neutral' : feed.sourceIsLive && !feed.fresh ? 'warn' : 'ok'}
          sub={feed == null ? 'websocket connecting…' : feed.sourceIsLive
            ? `${feed.symbols} symbols · last tick ${tickAge != null ? `${tickAge}s` : '—'} · ${feed.polls} polls${liveErr ? ` · ${liveErr}` : ''}`
            : `built-in sim · ${feed.symbols ?? 0} symbols`}
        />
        <HealthCell
          label="Broker sessions"
          main={meta.length === 0 ? '—' : `${meta.filter(m => m.hasCreds).length}/${meta.length} live`}
          tone={meta.length === 0 ? 'neutral' : meta.filter(m => m.brokerType !== 'SIMFEED' && m.isActive && !m.hasCreds).length > 0 ? 'warn' : 'ok'}
          sub={meta.map(m => `${m.label}${m.hasCreds ? '' : ' (no session)'}`).join(' · ') || 'no live broker accounts'}
        />
        <HealthCell
          label="Symbol universe"
          main={adm ? `${adm.syncInfo.counts.symbols}` : '—'}
          tone="neutral"
          sub={adm ? `${adm.syncInfo.counts.mappings} broker mappings · synced ${adm.syncInfo.lastSync ? fmtTime(adm.syncInfo.lastSync) : 'never'}` : ''}
        />
        <HealthCell
          label="Copy trade + recorder"
          main={adm ? `${adm.copyTrade?.enabled ? 'COPY ON' : 'COPY OFF'}${adm.copyTrade?.killSwitch ? ' · KILL' : ''} · REC ${adm.tickRecorder?.enabled ? 'ON' : 'OFF'}` : '—'}
          tone={adm?.copyTrade?.killSwitch ? 'warn' : 'neutral'}
          sub={adm?.copyTrade ? `share ${adm.copyTrade.capitalSharePct}% · slippage ${adm.copyTrade.slippagePct}% · ${adm.tickRecorder?.symbols.join('/') ?? ''}` : ''}
        />
      </div>
    </Card>
  )
}

function HealthCell({ label, main, sub, tone }: { label: string; main: string; sub?: string; tone: 'ok' | 'warn' | 'neutral' }) {
  return (
    <div className="rounded bg-secondary/40 p-2">
      <div className="text-[8px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`tabular font-bold text-xs mt-0.5 ${tone === 'ok' ? 'text-[#00c896]' : tone === 'warn' ? 'text-[#e0a63f]' : ''}`}>{main}</div>
      {sub && <div className="text-[8px] text-muted-foreground leading-tight mt-0.5 break-words">{sub}</div>}
    </div>
  )
}

// ---------------- ACCOUNT dashboards — cards + drill-down ----------------
// One card per broker account (realtime from sync:core + sync:admin).
// Click a card → full per-account dashboard: funds, positions, orders,
// trades, session stats and raw broker logs. No REST polling anywhere.
function AccountDashboards({ core, adm }: { core: SyncCore | null; adm: SyncAdmin | null }) {
  const [sel, setSel] = useState<string | null>(null)
  const accounts = core?.accounts ?? []
  if (!core || accounts.length === 0) {
    return <Card title="Account dashboards"><div className="text-[10px] text-muted-foreground py-2 text-center">waiting for the websocket sync hub…</div></Card>
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Account dashboards — click a card for the full per-account view</div>
        {sel && <button className="text-[10px] text-muted-foreground hover:text-foreground underline decoration-dotted" onClick={() => setSel(null)}>collapse</button>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {accounts.map(a => (
          <AccountCard key={a.id} acc={a} meta={adm?.accountsMeta.find(m => m.id === a.id)} open={sel === a.id} onOpen={() => setSel(sel === a.id ? null : a.id)} />
        ))}
      </div>
      {sel && <AccountDetail accountId={sel} core={core} adm={adm} />}
    </div>
  )
}

function AccountCard({ acc, meta, open, onOpen }: { acc: SyncCore['accounts'][number]; meta?: SyncAdmin['accountsMeta'][number]; open: boolean; onOpen: () => void }) {
  const net = acc.realizedPnl
  return (
    <button
      onClick={onOpen}
      className={`text-left rounded border p-2.5 bg-card transition-colors ${open ? 'border-primary/60 bg-primary/5' : 'border-border hover:border-primary/40'}`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${acc.isActive ? 'bg-[#00c896]' : 'bg-[#ff4d5e]'}`} title={acc.isActive ? 'connected' : 'disconnected'} />
        <span className="font-bold text-[11px] truncate">{acc.label}</span>
        <span className="text-[8px] uppercase tracking-wide text-muted-foreground shrink-0">{acc.brokerType}</span>
        {meta && !meta.hasCreds && acc.brokerType !== 'SIMFEED' && (
          <span className="ml-auto text-[7px] font-bold px-1 rounded bg-[#e0a63f]/15 text-[#e0a63f] shrink-0" title="no broker session — create it in Admin">NO SESSION</span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-1 mt-1.5 text-[9px] tabular">
        <div>
          <div className="text-[7px] uppercase text-muted-foreground">usable</div>
          <div className="font-bold text-[#00c896]">{fmtCompact(acc.usableCapital)}{acc.capitalBase === 'AVAILABLE_CASH_PCT' && <span className="text-[#e0a63f] text-[8px]"> {acc.capitalPct}%</span>}</div>
        </div>
        <div>
          <div className="text-[7px] uppercase text-muted-foreground">deployed</div>
          <div className="font-bold">{fmtCompact(acc.deployed)}</div>
        </div>
        <div>
          <div className="text-[7px] uppercase text-muted-foreground">realized</div>
          <div className={`font-bold ${net >= 0 ? 'term-up' : 'term-down'}`}>{fmtCompact(net)}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1 text-[8px] text-muted-foreground tabular">
        <span>{acc.openPositions} pos</span>
        <span>{acc.openOrders} open ord</span>
        <span className="ml-auto">{acc.capitalBase === 'AVAILABLE_CASH_PCT' ? '% of cash' : 'fixed ₹'}</span>
      </div>
    </button>
  )
}

/** Full per-account dashboard (drill-down) — everything from the two sync
 *  channels, zero polling: funds, positions, orders, session stats, logs. */
function AccountDetail({ accountId, core, adm }: { accountId: string; core: SyncCore; adm: SyncAdmin | null }) {
  const acc = core.accounts.find(a => a.id === accountId)
  const fund = core.funds.find(f => f.accountId === accountId)
  const positions = core.positions.filter(p => p.accountId === accountId)
  const orders = core.orders.filter(o => o.accountId === accountId).slice(0, 8)
  const sess = core.session.perAccount.find(p => p.accountId === accountId)
  const logs = (adm?.brokerLogs ?? []).filter(l => l.accountId === accountId).slice(0, 10)
  const meta = adm?.accountsMeta.find(m => m.id === accountId)
  if (!acc) return null
  const net = sess ? sess.realized + sess.unrealized : acc.realizedPnl
  return (
    <div className="rounded border border-primary/40 bg-card p-2.5 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-xs">{acc.label}</span>
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{acc.brokerType} · {acc.clientId ?? 'no client id'}</span>
        <span className={`px-1.5 rounded text-[8px] font-bold ${acc.isActive ? 'bg-[#00c896]/15 text-[#00c896]' : 'bg-[#ff4d5e]/15 text-[#ff4d5e]'}`}>{acc.isActive ? 'CONNECTED' : 'DISCONNECTED'}</span>
        <span className="px-1.5 rounded text-[8px] font-bold bg-secondary text-muted-foreground">{acc.isOrderEnabled ? 'ORDERS ON' : 'ORDERS OFF'}</span>
        {acc.isCopyMaster && <span className="px-1.5 rounded text-[8px] font-bold bg-[#4dd0e1]/15 text-[#4dd0e1]">COPY MASTER</span>}
        <div className="flex-1" />
        <span className="text-[9px] tabular text-muted-foreground">
          {sess ? `${sess.closes} closes · ${sess.closes ? ((sess.wins / sess.closes) * 100).toFixed(0) : '—'}% WR · ` : ''}
          net <b className={net >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(net)}</b>
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-1.5">
        <HealthCell label="Available cash" main={fmtCompact(fund?.cash ?? acc.availableCash)} tone="neutral" sub={acc.capitalBase === 'AVAILABLE_CASH_PCT' ? `${acc.capitalPct}% base → ${fmtCompact(acc.initialCapital)}` : `fixed initial ${fmtCompact(acc.initialCapital)}`} />
        <HealthCell label="Deployed" main={fmtCompact(acc.deployed)} tone="neutral" sub={`${acc.openPositions} open positions`} />
        <HealthCell label="Realized" main={fmtCompact(acc.realizedPnl)} tone={acc.realizedPnl >= 0 ? 'ok' : 'warn'} sub={`charges ${fmtCompact(acc.chargesPaid)}`} />
        <HealthCell label="Session pts" main={sess ? `${sess.pts >= 0 ? '+' : ''}${sess.pts.toFixed(1)}` : '—'} tone={(sess?.pts ?? 0) >= 0 ? 'ok' : 'warn'} sub={`${sess?.trades ?? 0} trades`} />
        <HealthCell label="Unrealized" main={fmtCompact(sess?.unrealized ?? 0)} tone={(sess?.unrealized ?? 0) >= 0 ? 'ok' : 'warn'} sub="open positions at LTP" />
        <HealthCell label="Pocket @LTP" main={fmtCompact(acc.pocket ?? (net))} tone={(acc.pocket ?? net) >= 0 ? 'ok' : 'warn'} sub="NET after ALL charges if exited now" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
        <div>
          <div className="text-[8px] uppercase tracking-wide text-muted-foreground mb-1">positions</div>
          <div className="max-h-40 overflow-y-auto">
            <table className="w-full text-[10px] tabular">
              <thead className="text-[8px] uppercase text-muted-foreground"><tr><Th>Symbol</Th><Th>Qty</Th><Th>Avg</Th><Th>LTP</Th><Th>P&L</Th><Th>Net @LTP</Th></tr></thead>
              <tbody>
                {positions.map((p, i) => (
                  <tr key={`${p.symbol}-${i}`} className="border-b border-border/30">
                    <Td className="font-medium">{p.symbol}</Td>
                    <Td className={p.netQty > 0 ? 'term-up' : p.netQty < 0 ? 'term-down' : ''}>{p.netQty}</Td>
                    <Td>{p.avgPrice.toFixed(2)}</Td>
                    <Td>{p.ltp.toFixed(2)}</Td>
                    <Td className={p.unrealizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(p.unrealizedPnl)}</Td>
                    <Td className={((p as unknown as { netIfExit?: number }).netIfExit ?? p.unrealizedPnl) >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'}>{fmtCompact((p as unknown as { netIfExit?: number }).netIfExit ?? p.unrealizedPnl)}</Td>
                  </tr>
                ))}
                {positions.length === 0 && <tr><Td className="text-muted-foreground">flat — no open positions</Td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="text-[8px] uppercase tracking-wide text-muted-foreground mb-1">recent orders</div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {orders.map(o => (
              <div key={o.id} className="flex items-center gap-1.5 text-[10px] tabular px-1 py-0.5 rounded bg-secondary/30">
                <span className={`font-bold ${o.side === 'BUY' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{o.side}</span>
                <span className="font-medium truncate max-w-[130px]">{o.symbol}</span>
                <span className="text-muted-foreground">{o.qty} {o.orderType}</span>
                <span className={`ml-auto px-1 rounded text-[8px] ${o.status === 'FILLED' ? 'bg-[#00c896]/15 text-[#00c896]' : o.status === 'OPEN' || o.status === 'PENDING' ? 'bg-[#f5a623]/15 text-[#f5a623]' : 'bg-[#ff4d5e]/15 text-[#ff4d5e]'}`}>{o.status}</span>
              </div>
            ))}
            {orders.length === 0 && <div className="text-[10px] text-muted-foreground py-1">no orders yet</div>}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[8px] uppercase tracking-wide text-muted-foreground mb-1">broker logs (latest calls)</div>
        <div className="max-h-28 overflow-y-auto divide-y divide-border/40">
          {logs.map((l, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[9px] tabular py-0.5">
              <span className="text-muted-foreground shrink-0">{l.ts.slice(11, 19)}</span>
              <span className={`shrink-0 font-bold ${l.level === 'ERROR' ? 'text-[#ff4d5e]' : l.level === 'WARN' ? 'text-[#e0a63f]' : 'text-muted-foreground'}`}>{l.level}</span>
              <span className="min-w-0 flex-1 break-all">{l.message}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="text-[9px] text-muted-foreground py-1">{meta?.hasCreds === false ? 'no broker session — create one in Admin → Session' : 'no broker calls logged yet'}</div>}
        </div>
      </div>
    </div>
  )
}

/** Tiny SVG line chart — cumulative realized P&L. */
function PnlCurve({ pts }: { pts: { t: string; v: number }[] }) {
  if (pts.length < 2) {
    return <div className="h-24 flex items-center justify-center text-[10px] text-muted-foreground">no closed trades yet this session</div>
  }
  const W = 480, H = 96, P = 4
  const vs = pts.map(p => p.v)
  const min = Math.min(0, ...vs), max = Math.max(0, ...vs)
  const span = max - min || 1
  const x = (i: number) => P + (i / (pts.length - 1)) * (W - 2 * P)
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P)
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const last = vs[vs.length - 1]
  const col = last >= 0 ? '#00c896' : '#ff4d5e'
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24">
        <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.15)" strokeDasharray="3,3" />
        <path d={d} fill="none" stroke={col} strokeWidth="1.6" />
      </svg>
      <div className={`text-[9px] tabular ${last >= 0 ? 'term-up' : 'term-down'}`}>
        cumulative {fmtInr(last)} over {pts.length} closes · last {fmtTime(pts[pts.length - 1].t)}
      </div>
    </div>
  )
}

// ---------------- portfolio ----------------

function PortfolioCard({ portfolio }: { portfolio?: PortfolioResp }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    setBusy(true)
    await qc.invalidateQueries({ queryKey: ['portfolio'] })
    setBusy(false)
  }
  const rows = (portfolio?.portfolio ?? []).flatMap(a =>
    a.holdings.map(h => ({ ...h, accountLabel: a.accountLabel, brokerType: a.brokerType, live: a.live })),
  )
  const totValue = rows.reduce((s, h) => s + h.value, 0)
  const totPnl = rows.reduce((s, h) => s + h.pnl, 0)
  return (
    <Card title="Portfolio (holdings)">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9px] text-muted-foreground tabular">
          {rows.length} holdings · value {fmtCompact(totValue)} ·{' '}
          <span className={totPnl >= 0 ? 'term-up' : 'term-down'}>P&L {fmtCompact(totPnl)}</span>
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" className="h-5 px-1.5 text-[9px]" onClick={refresh} disabled={busy}>
          <RefreshCw className={`h-2.5 w-2.5 ${busy ? 'animate-spin' : ''}`} /> refresh
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="text-[10px] text-muted-foreground py-3 text-center leading-relaxed">
          No holdings rows. Live broker accounts pull their real Holdings API;<br />
          sandbox accounts have no demat — open positions are in the terminal.
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-[10px] tabular">
            <thead className="text-[9px] uppercase tracking-wide text-muted-foreground sticky top-0 bg-card">
              <tr><Th>Account</Th><Th>Symbol</Th><Th>Qty</Th><Th>Avg ₹</Th><Th>LTP ₹</Th><Th>Value</Th><Th>P&L</Th></tr>
            </thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={`${h.accountLabel}-${h.symbol}-${i}`} className="border-b border-border/40">
                  <Td className="text-muted-foreground">{h.accountLabel}</Td>
                  <Td className="font-medium">{h.symbol}</Td>
                  <Td>{h.qty}</Td>
                  <Td>{h.avgPrice.toFixed(2)}</Td>
                  <Td>{h.ltp.toFixed(2)}</Td>
                  <Td>{fmtCompact(h.value)}</Td>
                  <Td className={h.pnl >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(h.pnl)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(portfolio?.positions.length ?? 0) > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-border/40 text-[9px] text-muted-foreground">
          open positions:{' '}
          {portfolio!.positions.map(p => (
            <span key={`${p.accountLabel}-${p.symbol}`} className="mr-2 tabular">
              {p.accountLabel.split(' ')[0]}·{p.symbol} <b className={p.netQty > 0 ? 'term-up' : 'term-down'}>{p.netQty > 0 ? '+' : ''}{p.netQty}</b>
            </span>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------------- margin calculator ----------------

function MarginCalculator({ accounts }: { accounts: { id: string; label: string; brokerType: string }[] }) {
  const [accountId, setAccountId] = useState('')
  const [symbol, setSymbol] = useState('NIFTY')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [qty, setQty] = useState('1')
  const [price, setPrice] = useState('')
  const [out, setOut] = useState<MarginResp | null>(null)
  const [busy, setBusy] = useState(false)
  const active = accountId || accounts[0]?.id || ''

  const run = async () => {
    if (!active || !symbol || !Number(qty) || !Number(price)) { toast.error('Fill account, symbol, qty and price'); return }
    setBusy(true)
    try {
      const r = await api.marginCalc({ accountId: active, symbol, side, qty: Number(qty), price: Number(price), productType: 'MIS' })
      setOut(r)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Margin calc failed') }
    setBusy(false)
  }

  return (
    <Card title="Margin calculator">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <Select value={active} onValueChange={setAccountId}>
          <SelectTrigger className="h-6 w-36 text-[10px]"><SelectValue placeholder="Account" /></SelectTrigger>
          <SelectContent>
            {accounts.map(a => <SelectItem key={a.id} value={a.id}>{a.label} · {a.brokerType}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="symbol" className="h-6 w-32 text-[10px] tabular bg-secondary/60" />
        <button onClick={() => setSide(side === 'BUY' ? 'SELL' : 'BUY')} className={`px-2 py-0.5 rounded text-[9px] font-bold ${side === 'BUY' ? 'bg-[#00c896]/20 text-[#00c896]' : 'bg-[#ff4d5e]/20 text-[#ff4d5e]'}`}>{side}</button>
        <Input value={qty} onChange={e => setQty(e.target.value.replace(/[^0-9]/g, ''))} placeholder="qty" className="h-6 w-16 text-[10px] tabular bg-secondary/60" />
        <Input value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="price ₹" className="h-6 w-24 text-[10px] tabular bg-secondary/60" />
        <Button size="sm" className="h-6 px-2 text-[10px]" onClick={run} disabled={busy}>{busy ? '…' : 'Calc'}</Button>
      </div>
      {out?.error && <div className="text-[9px] text-[#ff4d5e] mt-1.5">{out.error}</div>}
      {out?.estimate && (
        <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
          <div className="rounded bg-secondary/50 p-1.5">
            <div className="text-[8px] text-muted-foreground">REQUIRED</div>
            <div className="tabular font-bold">{fmtCompact(out.estimate.required)}</div>
            {out.estimate.span != null && <div className="text-[8px] text-muted-foreground">span {fmtCompact(out.estimate.span)} · exp {fmtCompact(out.estimate.exposure ?? 0)}</div>}
          </div>
          <div className="rounded bg-secondary/50 p-1.5">
            <div className="text-[8px] text-muted-foreground">AVAILABLE</div>
            <div className={`tabular font-bold ${((out.estimate.available ?? out.usable ?? 0) >= out.estimate.required) ? 'text-[#00c896]' : 'text-[#f5a623]'}`}>
              {fmtCompact(out.estimate.available ?? out.usable)}
            </div>
            <div className="text-[8px] text-muted-foreground">{out.live ? 'live broker API' : 'estimate'} · {out.estimate.detail ?? ''}</div>
          </div>
        </div>
      )}
      {/* P&L details — round-trip charges from the account's OWN schedule +
          breakeven + net outcome at ±1%; shows the REAL profit after
          brokerage, STT, txn, GST, SEBI and stamp */}
      {out?.pnl && (
        <div className="mt-2 rounded border border-[#f5a623]/40 bg-[#f5a623]/5 p-2 space-y-1 text-[9px]">
          <div className="flex items-center justify-between">
            <span className="font-bold text-[#f5a623] text-[10px]">P&L DETAILS — after all charges</span>
            <span className="text-muted-foreground">{out.pnl.instrument} · {out.pnl.qtyUnits} units · {out.pnl.scheduleSource === 'custom' ? 'your rates' : 'default rates'}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 tabular">
            <div>
              <div className="text-[8px] text-muted-foreground">BUY SIDE CHARGES</div>
              <div className="font-bold">{fmtCompact(out.pnl.buyCharges.total)}</div>
              <div className="text-[8px] text-muted-foreground">brk {fmtCompact(out.pnl.buyCharges.brokerage)} · stt {fmtCompact(out.pnl.buyCharges.stt)} · stamp {fmtCompact(out.pnl.buyCharges.stamp)}</div>
            </div>
            <div>
              <div className="text-[8px] text-muted-foreground">SELL SIDE CHARGES</div>
              <div className="font-bold">{fmtCompact(out.pnl.sellCharges.total)}</div>
              <div className="text-[8px] text-muted-foreground">brk {fmtCompact(out.pnl.sellCharges.brokerage)} · stt {fmtCompact(out.pnl.sellCharges.stt)}</div>
            </div>
            <div>
              <div className="text-[8px] text-muted-foreground">TOTAL ROUND-TRIP</div>
              <div className="font-bold text-[#ff4d5e]">{fmtCompact(out.pnl.totalCharges)}</div>
              <div className="text-[8px] text-muted-foreground">gst {fmtCompact(out.pnl.buyCharges.gst + out.pnl.sellCharges.gst)} · txn {fmtCompact(out.pnl.buyCharges.transaction + out.pnl.sellCharges.transaction)}</div>
            </div>
            <div>
              <div className="text-[8px] text-muted-foreground">BREAKEVEN EXIT</div>
              <div className="font-bold tabular">₹{out.pnl.breakeven}</div>
              <div className="text-[8px] text-muted-foreground">exit above this = real profit</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 pt-0.5">
            <div className="rounded bg-secondary/50 px-1.5 py-1">
              <span className="text-[8px] text-muted-foreground">NET if +1% </span>
              <span className={`font-bold tabular ${out.pnl.netIfUp1pct >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{fmtCompact(out.pnl.netIfUp1pct)}</span>
            </div>
            <div className="rounded bg-secondary/50 px-1.5 py-1">
              <span className="text-[8px] text-muted-foreground">NET if −1% </span>
              <span className={`font-bold tabular ${out.pnl.netIfDown1pct >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{fmtCompact(out.pnl.netIfDown1pct)}</span>
            </div>
          </div>
          <div className="text-[8px] text-muted-foreground">Edit the rates per account: Admin → Broker Accounts → the ₹ calculator button.</div>
        </div>
      )}
    </Card>
  )
}

// ---------------- GTT manager ----------------

function GttManager() {
  const qc = useQueryClient()
  // GTT rules ride the sync:admin websocket (2s push) — REST fallback
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data: rest } = useQuery({ queryKey: ['gtt'], queryFn: () => api.gttRules(), enabled: !adm, refetchInterval: 3000 })
  const rules = (adm?.gtt as unknown as GttRuleRow[] | undefined) ?? rest?.rules ?? []
  const [symbol, setSymbol] = useState('NIFTY')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [qty, setQty] = useState('1')
  const [trigger, setTrigger] = useState<'ABOVE' | 'BELOW'>('ABOVE')
  const [triggerPrice, setTriggerPrice] = useState('')
  const [orderType, setOrderType] = useState<'LIMIT' | 'MARKET'>('LIMIT')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (!symbol || !Number(triggerPrice) || !Number(qty)) { toast.error('Fill symbol, qty and trigger price'); return }
    setBusy(true)
    try {
      await api.createGtt({ symbol, side, qty: Number(qty), trigger, triggerPrice: Number(triggerPrice), orderType, productType: 'MIS', repeatDaily: true })
      await qc.invalidateQueries({ queryKey: ['gtt'] })
      toast.success(`GTT armed — ${side} ${symbol} ${trigger.toLowerCase()} ${triggerPrice}`)
      setTriggerPrice('')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'GTT create failed') }
    setBusy(false)
  }
  const toggle = async (r: GttRuleRow, armed: boolean) => {
    await api.patchGtt(r.id, { armed }).catch(e => toast.error(e instanceof Error ? e.message : 'failed'))
    void qc.invalidateQueries({ queryKey: ['gtt'] })
  }
  const remove = async (id: string) => {
    await api.deleteGtt(id).catch(e => toast.error(e instanceof Error ? e.message : 'failed'))
    void qc.invalidateQueries({ queryKey: ['gtt'] })
  }

  return (
    <Card title="GTT — good-till-triggered orders (all brokers)">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] mb-2">
        <Input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="symbol" className="h-6 w-32 text-[10px] tabular bg-secondary/60" />
        <button onClick={() => setSide(side === 'BUY' ? 'SELL' : 'BUY')} className={`px-2 py-0.5 rounded text-[9px] font-bold ${side === 'BUY' ? 'bg-[#00c896]/20 text-[#00c896]' : 'bg-[#ff4d5e]/20 text-[#ff4d5e]'}`}>{side}</button>
        <Input value={qty} onChange={e => setQty(e.target.value.replace(/[^0-9]/g, ''))} placeholder="qty" className="h-6 w-14 text-[10px] tabular bg-secondary/60" />
        <button
          onClick={() => setTrigger(trigger === 'ABOVE' ? 'BELOW' : 'ABOVE')}
          className="px-2 py-0.5 rounded text-[9px] font-bold bg-secondary/70 text-muted-foreground hover:text-foreground"
          title="Trigger when LTP crosses above / below the trigger price"
        >
          {trigger === 'ABOVE' ? '≥' : '≤'}
        </button>
        <Input value={triggerPrice} onChange={e => setTriggerPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="trigger ₹" className="h-6 w-24 text-[10px] tabular bg-secondary/60" />
        <button
          onClick={() => setOrderType(orderType === 'LIMIT' ? 'MARKET' : 'LIMIT')}
          className="px-2 py-0.5 rounded text-[9px] font-bold bg-secondary/70 text-muted-foreground hover:text-foreground"
        >{orderType}</button>
        <Button size="sm" className="h-6 px-2 text-[10px]" onClick={create} disabled={busy}><Plus className="h-3 w-3" /> Arm GTT</Button>
      </div>
      {rules.length === 0 && <div className="text-[10px] text-muted-foreground py-1">No GTT rules — arm one above (fires server-side, works for sim + live accounts).</div>}
      <div className="space-y-1">
        {rules.map(r => (
          <div key={r.id} className="flex items-center gap-2 px-1.5 py-1 rounded bg-secondary/30 text-[10px]">
            <span className={`font-bold ${r.side === 'BUY' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{r.side}</span>
            <span className="font-medium tabular">{r.symbol}</span>
            <span className="text-muted-foreground tabular">×{r.qty}</span>
            <span className="text-muted-foreground">when LTP {r.trigger === 'ABOVE' ? '≥' : '≤'} <b className="text-foreground tabular">{r.triggerPrice}</b> ({r.orderType})</span>
            {r.lastTriggeredAt && (
              <span className={`text-[9px] ${r.lastStatus === 'SUCCESS' ? 'term-up' : 'term-down'}`}>
                {r.lastStatus} {fmtTime(r.lastTriggeredAt)}
              </span>
            )}
            <div className="flex-1" />
            <Switch checked={r.armed} onCheckedChange={v => toggle(r, v)} />
            <button onClick={() => remove(r.id)} className="p-0.5 text-muted-foreground hover:text-[#ff4d5e]"><Trash2 className="h-3 w-3" /></button>
          </div>
        ))}
      </div>
    </Card>
  )
}
