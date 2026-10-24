'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fmtInr, fmtTime, fmtDateTime } from '../lib/client-api'
import type { AggOrder, AggTrade, AggPosition, FundRow, AccountRow } from '../lib/client-api'
import { useTerminal } from '../lib/store'
import { useSyncChannel, type SyncCore, type SyncAdmin } from '../lib/sync'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useState } from 'react'
import { toast } from 'sonner'
import { Pencil, RefreshCw, Repeat, Rocket, X, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'

const HEAD = 'text-[9px] uppercase tracking-wide text-muted-foreground'

// ============================================================
// Bottom dock: Orders / Trades / Positions / Funds / Logs.
// Rows carry context actions:
//  · Positions — Repeat (re-enter same side/size) · Swap (close +
//    open the opposite side) · Edit (Δ lots per account) · Exit
//  · Orders — Edit (re-price/qty, open only) · Cancel (open) ·
//    Repeat / Retry (filled, failed, cancelled)
// Tab labels carry SESSION counts (open/total, e.g. "1/5").
// Data arrives over the websocket sync hub (sync:core, 1s) — the
// REST queries only run as a fallback when the socket is dark.
// The whole dock collapses to a slim bar (chevron button).
// ============================================================

const isOpenOrder = (s: string) => s === 'OPEN' || s === 'PENDING'

export function BottomPanel() {
  const tab = useTerminal(s => s.bottomTab)
  const setTab = useTerminal(s => s.setBottomTab)
  const collapsed = useTerminal(s => s.bottomCollapsed)
  const setCollapsed = useTerminal(s => s.setBottomCollapsed)
  const core = useSyncChannel<SyncCore>('sync:core')

  const openOrders = core ? core.orders.filter(o => isOpenOrder(o.status)).length : null
  const totOrders = core?.orders.length ?? null
  const openPos = core?.positions.filter(p => p.netQty !== 0).length ?? null
  const totPos = core?.positions.length ?? null // open + touched today (hub includes realized rows)
  const totTrades = core?.session.trades ?? null

  const count = (n: number | null, d: number | null) =>
    n == null ? '' : <span className="ml-1 tabular text-[9px] text-muted-foreground">{d != null ? `${n}/${d}` : n}</span>

  if (collapsed) {
    return (
      <div className="flex h-full items-center gap-2 px-2 bg-card/60 border-t border-border text-[10px] overflow-x-auto">
        <span className="font-bold text-[9px] uppercase tracking-wide text-muted-foreground shrink-0">Session</span>
        <span className="tabular shrink-0">ORD {openOrders ?? '—'}{totOrders != null ? `/${totOrders}` : ''}</span>
        <span className="tabular shrink-0">POS {openPos ?? '—'}{totPos != null ? `/${totPos}` : ''}</span>
        {core && <span className={`tabular shrink-0 ${core.session.net >= 0 ? 'term-up' : 'term-down'}`}>{core.session.net >= 0 ? '+' : ''}{core.session.net.toFixed(0)}₹</span>}
        {core && <span className={`tabular shrink-0 ${core.session.pts >= 0 ? 'term-up' : 'term-down'}`}>{core.session.pts >= 0 ? '+' : ''}{core.session.pts.toFixed(1)}pts</span>}
        <div className="flex-1" />
        {(['orders', 'trades', 'positions', 'funds', 'logs'] as const).map(k => (
          <button
            key={k}
            onClick={() => { setTab(k); setCollapsed(false) }}
            className={`px-1.5 py-0.5 rounded text-[9px] shrink-0 ${tab === k ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >{k === 'trades' ? 'TRD' : k === 'positions' ? 'POS' : k === 'orders' ? 'ORD' : k === 'funds' ? 'FUND' : 'LOG'}</button>
        ))}
        <button
          onClick={() => setCollapsed(false)}
          title="Expand the bottom panel"
          className="p-1 rounded shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ChevronsUpDown className="h-3 w-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-card/40">
      <div className="flex items-center gap-1 px-2 pt-1 border-b border-border">
        {([
          ['orders', 'Orders', count(openOrders ?? 0, totOrders) as React.ReactNode],
          ['trades', 'Trade Book', count(totTrades, null) as React.ReactNode],
          ['positions', 'Positions', count(openPos ?? 0, totPos) as React.ReactNode],
          ['funds', 'Funds', null],
          ['logs', 'Broker Logs', null],
        ] as const).map(([k, label, cnt]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 text-[10px] rounded-t ${tab === k ? 'bg-card text-foreground border-x border-t border-border -mb-px' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {label}{cnt}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse the bottom panel (counts stay visible in the slim bar)"
          className="p-1 rounded text-muted-foreground hover:text-foreground mb-1"
        >
          <ChevronsDownUp className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'orders' && <OrdersTable />}
        {tab === 'trades' && <TradesTable />}
        {tab === 'positions' && <PositionsTable />}
        {tab === 'funds' && <FundsTable />}
        {tab === 'logs' && <LogsPanel />}
      </div>
    </div>
  )
}

// ---------------- shared order helpers ----------------

function useOrderActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['orders'] })
    void qc.invalidateQueries({ queryKey: ['positions'] })
    void qc.invalidateQueries({ queryKey: ['trades'] })
  }
  const place = async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await api.placeOrder(body)
      const f = res.legs.filter(l => l.status === 'FILLED').length
      if (res.status === 'FAILED') {
        toast.error(`${String(body.side)} ${String(body.symbol)} failed — ${res.message}`)
        return false
      }
      toast.success(`${String(body.side)} ${String(body.symbol)} — ${f}/${res.legs.length} account fills`)
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Order failed')
      return false
    } finally {
      refresh()
    }
  }
  const squareOff = async (symbol: string): Promise<boolean> => {
    try {
      const so = await api.squareOffAll(false, [symbol])
      toast.success(`Exit ${symbol} — ${so.filledLegs} legs closed`)
      return so.orders > 0
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Exit failed')
      return false
    } finally {
      refresh()
    }
  }
  return { place, squareOff, refresh }
}

// ---------------- orders ----------------

function OrdersTable() {
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data } = useQuery({ queryKey: ['orders'], queryFn: () => api.orders(), enabled: !sync, refetchInterval: 2500 })
  const rows: AggOrder[] = sync ? (sync.orders as unknown as AggOrder[]) : (data?.orders ?? [])
  const { place, refresh } = useOrderActions()
  const [editing, setEditing] = useState<string | null>(null)

  const repeat = (o: typeof rows[number]) =>
    place({
      symbol: o.symbol, exchange: o.exchange, side: o.side, qty: o.qty,
      orderType: o.orderType, productType: o.productType, source: 'MANUAL',
      limitPrice: o.orderType === 'LIMIT' ? o.avgPrice || undefined : undefined,
    })

  const cancel = async (o: typeof rows[number]) => {
    try {
      await api.cancelOrder(o.accountId, o.id)
      toast.success(`Cancelled ${o.symbol} ${o.side} ${o.qty}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Cancel failed')
    }
    refresh()
  }

  if (rows.length === 0) return <Empty text="No orders yet — place one from the order pad" />
  return (
    <table className="w-full text-[10px] tabular">
      <thead className={`${HEAD} sticky top-0 bg-card/95 backdrop-blur`}>
        <tr>
          <Th>Time</Th><Th>Account</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th>
          <Th>Type</Th><Th>Status</Th><Th>Avg ₹</Th><Th>Message</Th><Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(o => {
          const open = o.status === 'OPEN' || o.status === 'PENDING'
          const editable = open && o.orderType !== 'MARKET'
          return (
            <tr key={o.id} className="border-b border-border/40 hover:bg-secondary/30 align-middle">
              <Td>{fmtTime(o.createdAt)}</Td>
              <Td className="text-muted-foreground">{o.accountLabel}</Td>
              <Td className="font-medium">{o.symbol}</Td>
              <Td className={o.side === 'BUY' ? 'term-up' : 'term-down'}>{o.side}</Td>
              <Td>{o.qty}</Td>
              <Td className="text-muted-foreground">{o.orderType}/{o.productType}</Td>
              <Td><span className={`px-1 rounded text-[9px] ${statusCls(o.status)}`}>{o.status}</span></Td>
              <Td>{o.avgPrice ? o.avgPrice.toFixed(2) : '—'}</Td>
              <Td className="text-muted-foreground max-w-[180px] truncate">{o.message}</Td>
              <Td>
                {editing === o.id ? (
                  <OrderEditInline
                    order={o}
                    onDone={ok => { setEditing(null); if (ok) refresh() }}
                    onCancelReplace={async (qty, price) => {
                      await cancel(o)
                      return place({
                        symbol: o.symbol, exchange: o.exchange, side: o.side, qty,
                        orderType: o.orderType, productType: o.productType, source: 'MANUAL',
                        limitPrice: o.orderType === 'LIMIT' ? price : undefined,
                        triggerPrice: o.orderType === 'SL-M' || o.orderType === 'SL' ? price : undefined,
                      })
                    }}
                  />
                ) : (
                  <div className="flex gap-0.5">
                    {editable && (
                      <button onClick={() => setEditing(o.id)} title="Edit order (re-price / qty)" className="p-0.5 rounded text-muted-foreground hover:text-foreground">
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    {open && (
                      <button onClick={() => cancel(o)} title="Cancel this order" className="p-0.5 rounded text-muted-foreground hover:text-[#ff4d5e]">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                    {!open && (
                      <button onClick={() => repeat(o)} title={`Repeat this ${o.status.toLowerCase()} order`} className="p-0.5 rounded text-muted-foreground hover:text-foreground">
                        <Repeat className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                )}
              </Td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** Inline edit for an OPEN order: cancel + re-place with new qty/price. */
function OrderEditInline({ order, onDone, onCancelReplace }: {
  order: { symbol: string; side: 'BUY' | 'SELL'; qty: number; orderType: string; productType: string }
  onDone: (ok: boolean) => void
  onCancelReplace: (qty: number, price: number) => Promise<boolean>
}) {
  const [qty, setQty] = useState(String(order.qty))
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    const q = Number(qty), p = Number(price)
    if (!Number.isFinite(q) || q <= 0) { toast.error('Enter a valid qty'); return }
    if (!Number.isFinite(p) || p <= 0) { toast.error('Enter a valid price'); return }
    setBusy(true)
    const ok = await onCancelReplace(q, p)
    setBusy(false)
    onDone(ok)
  }
  return (
    <span className="flex items-center gap-1">
      <Input value={qty} onChange={e => setQty(e.target.value.replace(/[^0-9]/g, ''))} className="h-5 w-12 text-[9px] tabular bg-secondary/60" title="Qty (lots)" />
      <Input value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="₹" className="h-5 w-14 text-[9px] tabular bg-secondary/60" title="New price" />
      <Button size="sm" variant="secondary" className="h-5 px-1.5 text-[9px]" disabled={busy} onClick={run}>{busy ? '…' : 'Save'}</Button>
      <button onClick={() => onDone(false)} className="p-0.5 text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
    </span>
  )
}

// ---------------- trades ----------------

function TradesTable() {
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data } = useQuery({ queryKey: ['trades'], queryFn: () => api.trades(), enabled: !sync, refetchInterval: 3000 })
  const rows: AggTrade[] = sync ? (sync.trades as unknown as AggTrade[]) : (data?.trades ?? [])
  if (rows.length === 0) return <Empty text="No executed trades yet" />
  return (
    <table className="w-full text-[10px] tabular">
      <thead className={`${HEAD} sticky top-0 bg-card/95`}>
        <tr>
          <Th>Time</Th><Th>Account</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th>
          <Th>Price ₹</Th><Th>Value ₹</Th><Th>Charges ₹</Th><Th>Realized ₹</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(t => (
          <tr key={t.id} className="border-b border-border/40 hover:bg-secondary/30">
            <Td>{fmtTime(t.ts)}</Td>
            <Td className="text-muted-foreground">{t.accountLabel}</Td>
            <Td className="font-medium">{t.symbol}</Td>
            <Td className={t.side === 'BUY' ? 'term-up' : 'term-down'}>{t.side}</Td>
            <Td>{t.qty}</Td>
            <Td>{t.price.toFixed(2)}</Td>
            <Td>{fmtInr(t.value)}</Td>
            <Td className="text-muted-foreground" title={t.charges ? `B ${t.charges.brokerage} STT ${t.charges.stt} Txn ${t.charges.transaction} GST ${t.charges.gst}` : ''}>{t.chargesTotal.toFixed(2)}</Td>
            <Td className={(t.realizedPnl ?? 0) >= 0 ? 'term-up' : 'term-down'}>{t.realizedPnl !== undefined ? t.realizedPnl.toFixed(2) : '—'}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------- positions ----------------

function PositionsTable() {
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data } = useQuery({ queryKey: ['positions'], queryFn: () => api.positions(), enabled: !sync, refetchInterval: 1500 })
  const allPos: AggPosition[] = sync ? (sync.positions as unknown as AggPosition[]) : (data?.positions ?? [])
  const rows = allPos.filter(p => p.netQty !== 0)
  const netIfExitOf = (p: AggPosition) => (p as unknown as { netIfExit?: number }).netIfExit ?? p.unrealizedPnl
  const totals = sync
    ? {
        openPositions: rows.length,
        unrealizedPnl: rows.reduce((s, p) => s + p.unrealizedPnl, 0),
        realizedPnl: rows.reduce((s, p) => s + p.realizedPnl, 0),
        netIfExit: rows.reduce((s, p) => s + netIfExitOf(p), 0),
        pocket: sync.session?.pocket ?? null,
      }
    : (data?.totals ? { ...data.totals, netIfExit: data.totals.netIfExit ?? 0, pocket: null } : undefined)
  const { place, squareOff } = useOrderActions()
  const [editing, setEditing] = useState<string | null>(null)

  const lotsOf = (p: typeof rows[number]) => Math.abs(Math.round(p.netQty / (p.lotSize || 1)))

  const repeatPos = (p: typeof rows[number]) =>
    place({ symbol: p.symbol, exchange: p.exchange, side: p.netQty > 0 ? 'BUY' : 'SELL', qty: lotsOf(p), orderType: 'MARKET', productType: p.productType, source: 'MANUAL' })

  const swapPos = async (p: typeof rows[number]) => {
    toast.info(`Swap ${p.symbol} — closing then reversing…`)
    const closed = await squareOff(p.symbol)
    if (closed) {
      await place({ symbol: p.symbol, exchange: p.exchange, side: p.netQty > 0 ? 'SELL' : 'BUY', qty: lotsOf(p), orderType: 'MARKET', productType: p.productType, source: 'MANUAL' })
      toast.success(`Swapped ${p.symbol} → ${p.netQty > 0 ? 'SHORT' : 'LONG'} ${lotsOf(p)} lot(s)`)
    }
  }

  const exitPos = (p: typeof rows[number]) => squareOff(p.symbol)

  return (
    <div>
      {totals && (
        <div className="flex gap-4 px-2 py-1 text-[10px] border-b border-border/40">
          <span className="text-muted-foreground">Open: <span className="text-foreground">{totals.openPositions}</span></span>
          <span className="text-muted-foreground">Unrealized: <span className={`tabular ${totals.unrealizedPnl >= 0 ? 'term-up' : 'term-down'}`}>{fmtInr(totals.unrealizedPnl)}</span></span>
          <span className="text-muted-foreground">Realized: <span className={`tabular ${totals.realizedPnl >= 0 ? 'term-up' : 'term-down'}`}>{fmtInr(totals.realizedPnl)}</span></span>
          <span className="text-muted-foreground" title="NET in pocket after ALL charges — exit every open position at LTP now (brokerage + STT + txn + GST + SEBI + stamp)">
            Pocket @LTP: <span className={`tabular font-bold ${((totals.pocket ?? totals.netIfExit ?? 0)) >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{fmtInr(totals.pocket ?? totals.netIfExit ?? 0)}</span>
          </span>
        </div>
      )}
      {rows.length === 0 ? <Empty text="No open positions" /> : (
        <table className="w-full text-[10px] tabular">
          <thead className={`${HEAD} sticky top-0 bg-card/95`}>
            <tr>
              <Th>Account</Th><Th>Symbol</Th><Th>Prod</Th><Th>Net Qty</Th><Th>Avg ₹</Th><Th>LTP ₹</Th><Th>Unrealized ₹</Th><Th>Net @LTP ₹</Th><Th>Realized ₹</Th><Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => {
              const rowKey = `${p.accountId}-${p.symbol}-${i}`
              return (
                <tr key={rowKey} className="border-b border-border/40 hover:bg-secondary/30">
                  <Td className="text-muted-foreground">{p.accountLabel}</Td>
                  <Td className="font-medium">{p.symbol}</Td>
                  <Td className="text-muted-foreground">{p.productType}</Td>
                  <Td className={p.netQty > 0 ? 'term-up' : 'term-down'}>{p.netQty > 0 ? '+' : ''}{p.netQty}</Td>
                  <Td>{p.avgPrice.toFixed(2)}</Td>
                  <Td>{p.ltp.toFixed(2)}</Td>
                  <Td className={p.unrealizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtInr(p.unrealizedPnl)}</Td>
                  <Td className={netIfExitOf(p) >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'} title={`NET in pocket after ALL charges if exited at LTP now · exit charges ${fmtInr((p as unknown as { exitCharges?: number }).exitCharges ?? 0)}`}>{fmtInr(netIfExitOf(p))}</Td>
                  <Td className={p.realizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtInr(p.realizedPnl)}</Td>
                  <Td>
                    {editing === rowKey ? (
                      <PositionEditInline
                        lots={lotsOf(p)}
                        onDone={() => setEditing(null)}
                        onApply={async (delta) => {
                          await place({
                            symbol: p.symbol, exchange: p.exchange,
                            side: delta > 0 ? (p.netQty > 0 ? 'BUY' : 'SELL') : (p.netQty > 0 ? 'SELL' : 'BUY'),
                            qty: Math.abs(delta), orderType: 'MARKET', productType: p.productType, source: 'MANUAL',
                            reduceOnly: delta < 0,
                          })
                        }}
                      />
                    ) : (
                      <div className="flex gap-0.5">
                        <button onClick={() => repeatPos(p)} title={`Repeat — re-enter ${p.netQty > 0 ? 'LONG' : 'SHORT'} ${lotsOf(p)} lot(s)`} className="p-0.5 rounded text-muted-foreground hover:text-foreground">
                          <Repeat className="h-3 w-3" />
                        </button>
                        <button onClick={() => swapPos(p)} title="Swap — close and open the opposite side" className="p-0.5 rounded text-muted-foreground hover:text-[#f5a623]">
                          <RefreshCw className="h-3 w-3" />
                        </button>
                        <button onClick={() => setEditing(editing === rowKey ? null : rowKey)} title="Edit position — Δ lots" className="p-0.5 rounded text-muted-foreground hover:text-foreground">
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button onClick={() => exitPos(p)} title="Exit — square off this position" className="p-0.5 rounded text-muted-foreground hover:text-[#ff4d5e]">
                          <Rocket className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Inline Δ-lots editor for a position row (+ adds, − reduces, per account). */
function PositionEditInline({ lots, onDone, onApply }: {
  lots: number
  onDone: () => void
  onApply: (deltaLots: number) => Promise<void>
}) {
  const [delta, setDelta] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    const d = Number(delta)
    if (!Number.isFinite(d) || d === 0) { toast.error('Enter Δ lots (+2 / -1)'); return }
    setBusy(true)
    await onApply(Math.round(d))
    setBusy(false)
    toast.success(`Applied ${d > 0 ? '+' : ''}${d} lot(s)`)
    onDone()
  }
  return (
    <span className="flex items-center gap-1">
      <Input value={delta} onChange={e => setDelta(e.target.value.replace(/[^0-9-]/g, ''))} placeholder={`+1/-1 (now ${lots})`} className="h-5 w-24 text-[9px] bg-secondary/60" />
      <Button size="sm" variant="secondary" className="h-5 px-1.5 text-[9px]" disabled={busy} onClick={run}>{busy ? '…' : 'Apply'}</Button>
      <button onClick={onDone} className="p-0.5 text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
    </span>
  )
}

// ---------------- funds / logs ----------------

function FundsTable() {
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data } = useQuery({ queryKey: ['funds'], queryFn: () => api.funds(), enabled: !sync, refetchInterval: 4000 })
  const rows: FundRow[] = sync ? (sync.funds as unknown as FundRow[]) : (data?.funds ?? [])
  return (
    <table className="w-full text-[10px] tabular">
      <thead className={`${HEAD} sticky top-0 bg-card/95`}>
        <tr>
          <Th>Account</Th><Th>Broker</Th><Th>Cash ₹</Th><Th>Initial ₹</Th><Th>Realized PnL ₹</Th><Th>Charges Paid ₹</Th><Th>Deployed ₹</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(f => (
          <tr key={f.accountId} className="border-b border-border/40 hover:bg-secondary/30">
            <Td className="font-medium">{f.label}</Td>
            <Td className="text-muted-foreground">{f.brokerType}</Td>
            <Td>{fmtInr(f.cash)}</Td>
            <Td>{fmtInr(f.initialCapital)}</Td>
            <Td className={f.realizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtInr(f.realizedPnl)}</Td>
            <Td className="text-muted-foreground">{fmtInr(f.chargesPaid)}</Td>
            <Td>{fmtInr(f.deployed)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function LogsPanel() {
  // accounts via sync:core, broker logs via sync:admin (2s websocket push) —
  // REST only as the fallback while the socket is down
  const core = useSyncChannel<SyncCore>('sync:core')
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data: acc } = useQuery({ queryKey: ['accounts-logs'], queryFn: () => api.accounts(), enabled: !core, refetchInterval: 8000 })
  const accounts: AccountRow[] = (core?.accounts as unknown as AccountRow[]) ?? acc?.accounts ?? []
  const [sel, setSel] = useState<string>('')
  const active = sel || accounts[0]?.id || ''
  const { data } = useQuery({
    queryKey: ['broker-logs', active],
    queryFn: () => api.brokerLogs(active),
    refetchInterval: 2000,
    enabled: !!active && !adm,
  })
  const syncLogs = (adm?.brokerLogs ?? []).filter(l => l.accountId === active)
  const logs = adm ? syncLogs : (data?.logs ?? [])
  return (
    <div className="p-2 space-y-1">
      <Select value={active} onValueChange={setSel}>
        <SelectTrigger className="h-7 w-72 text-[10px]"><SelectValue placeholder="Select account" /></SelectTrigger>
        <SelectContent>
          {accounts.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="font-mono text-[10px] space-y-0.5 max-h-48 overflow-y-auto">
        {(data?.logs ?? []).map(l => (
          <div key={l.id} className="flex gap-2">
            <span className="text-muted-foreground">{fmtDateTime(l.ts)}</span>
            <span className={l.level === 'WARN' ? 'text-[#f5a623]' : l.level === 'ERROR' ? 'term-down' : 'text-foreground'}>{l.message}</span>
          </div>
        ))}
        {(data?.logs ?? []).length === 0 && <div className="text-muted-foreground">No broker activity logged yet</div>}
      </div>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium px-2 py-1 whitespace-nowrap">{children}</th>
}
function Td({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={`px-2 py-1 whitespace-nowrap ${className}`} title={title}>{children}</td>
}
function statusCls(s: string) {
  switch (s) {
    case 'FILLED': return 'bg-[#00c896]/15 text-[#00c896]'
    case 'OPEN': case 'PENDING': return 'bg-[#f5a623]/15 text-[#f5a623]'
    case 'REJECTED': case 'CANCELLED': return 'bg-[#ff4d5e]/15 text-[#ff4d5e]'
    default: return 'bg-secondary text-muted-foreground'
  }
}
function Empty({ text }: { text: string }) {
  return <div className="h-full min-h-24 flex items-center justify-center text-[11px] text-muted-foreground">{text}</div>
}
