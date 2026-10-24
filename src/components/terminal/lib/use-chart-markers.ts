'use client'

import { useMemo } from 'react'
import { toast } from 'sonner'
import { useTerminal } from './store'
import { useSyncChannel, type SyncCore } from './sync'
import { api, fmtMoney } from './client-api'
import type { ChartMarker } from '../chart/canvas-chart'

// ============================================================
// Shared chart-marker plumbing:
//  · entry markers from OPEN positions (@ avg price + PnL + %)
//  · draggable SL / target level markers (persisted per symbol)
// MARKER DRAG SEMANTICS (close-position orders):
//  · TGT  drag → arm a reduce-only LIMIT at the dropped price that
//          CLOSES the position (target-to-close; sells longs /
//          buys shorts at held lots)
//  · SL   drag → arm a reduce-only SL-M = STOP-SELL (long) /
//          STOP-BUY (short) that flattens the position
// Re-dragging REPLACES: any previously resting reduce-only orders
// of the same kind on that symbol are cancelled before the new
// one is armed (no stacked exits).
// ============================================================

export function useChartCore(): SyncCore | null {
  return useSyncChannel<SyncCore>('sync:core')
}

export function useChartMarkers(symbol: string, core: SyncCore | null, lotSize = 1): ChartMarker[] {
  const levels = useTerminal(s => s.chartLevels[symbol])
  return useMemo(() => {
    const out: ChartMarker[] = []
    const rows = (core?.positions ?? []).filter(p => p.symbol === symbol && p.netQty !== 0 && p.avgPrice > 0)
    // ONE aggregated entry marker per symbol (the sync stream emits one row
    // per ACCOUNT — three identical chips would just crowd small panes)
    const absQty = rows.reduce((s, p) => s + Math.abs(p.netQty), 0)
    const netQty = rows.reduce((s, p) => s + p.netQty, 0)
    const avg = absQty ? rows.reduce((s, p) => s + p.avgPrice * Math.abs(p.netQty), 0) / absQty : 0
    const pnl = rows.reduce((s, p) => s + p.unrealizedPnl, 0)
    const pos = rows[0]
    if (rows.length && netQty !== 0 && avg > 0) {
      const pct = avg ? (pnl / Math.abs(avg * netQty)) * 100 : 0
      out.push({
        id: 'pos-agg',
        kind: 'entry',
        price: avg,
        label: netQty > 0 ? 'L' : 'S',
        color: netQty > 0 ? '#00c896' : '#ff4d5e',
        sub: `${pnl >= 0 ? '+' : ''}${fmtMoney(pnl, 0)} · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
      })
    }
    // SL / target markers exist ONLY while a position is open — when the
    // position closes the sync stream drops it and these disappear (the
    // persisted chartLevels stay for the next position on this symbol).
    if (pos && netQty !== 0) {
      const long = netQty > 0
      if (levels?.sl && levels.sl > 0) {
        out.push({ id: 'lvl-sl', kind: 'sl', price: levels.sl, label: long ? 'S·SELL' : 'S·BUY', color: '#ff4d5e' })
      } else {
        // suggested stop — drag it to arm the real stop-sell / stop-buy
        out.push({ id: 'lvl-sl', kind: 'sl', price: Number((avg * (long ? 0.98 : 1.02)).toFixed(2)), label: long ? 'S·SELL' : 'S·BUY', color: '#ff4d5e', sub: 'drag = stop' })
      }
      if (levels?.target && levels.target > 0) {
        out.push({ id: 'lvl-tgt', kind: 'target', price: levels.target, label: 'CLOSE', color: '#00c896' })
      } else {
        // suggested target — drag it anywhere (drop arms a real close-position LIMIT)
        out.push({ id: 'lvl-tgt', kind: 'target', price: Number((avg * (long ? 1.04 : 0.96)).toFixed(2)), label: 'CLOSE', color: '#00c896', sub: 'drag = close' })
      }
    }
    void lotSize
    return out
  }, [core, symbol, levels, lotSize])
}

/** Cancel this terminal's resting EXIT-side (reduce) orders on `symbol`
 *  (replace-on-redrag — entry orders on the other side stay untouched). */
async function cancelStaleReduceOrders(symbol: string, exitSide: 'BUY' | 'SELL'): Promise<number> {
  try {
    const { orders } = await api.orders()
    const stale = orders.filter(o => o.symbol === symbol && o.status === 'OPEN' && o.side === exitSide)
    let n = 0
    for (const o of stale) n += await api.cancelOrder(o.accountId, o.id).then(() => 1).catch(() => 0)
    return n
  } catch {
    return 0
  }
}

/** Drop a draggable level marker: persist + arm the real close-position order. */
export async function commitChartLevel(symbol: string, kind: 'sl' | 'target', price: number, core: SyncCore | null): Promise<void> {
  useTerminal.getState().setChartLevel(symbol, kind, price)
  const pos = (core?.positions ?? []).find(p => p.symbol === symbol && p.netQty !== 0)
  if (!pos) {
    toast.info(`${kind === 'sl' ? 'Stop' : 'Target-to-close'} level set @ ${fmtMoney(price)} — open a position, then drag again to arm the order`)
    return
  }
  // close-position semantics: exit side is opposite the position
  const side = pos.netQty > 0 ? 'SELL' : 'BUY'
  const lots = Math.max(1, Math.floor(Math.abs(pos.netQty) / (pos.lotSize || 1)))
  const exchange = pos.exchange || 'NFO'
  try {
    const replaced = await cancelStaleReduceOrders(symbol, side)
    const res = await api.placeOrder(
      kind === 'sl'
        ? { symbol, exchange, side, qty: lots, orderType: 'SL-M', productType: 'MIS', source: 'MANUAL', triggerPrice: price, reduceOnly: true, strategyId: 'reduce' }
        : { symbol, exchange, side, qty: lots, orderType: 'LIMIT', productType: 'MIS', source: 'MANUAL', limitPrice: price, reduceOnly: true, strategyId: 'reduce' },
    )
    const f = res.legs.filter(l => l.status === 'FILLED').length
    const r = res.legs.filter(l => l.status === 'OPEN').length
    if (f + r === 0) { toast.error(`${kind === 'sl' ? 'Stop' : 'Target'} order failed — ${res.message}`); return }
    const what = kind === 'sl'
      ? `${side === 'SELL' ? 'Stop-sell' : 'Stop-buy'} (close ${lots} lot(s))`
      : `Target-to-close (${side} ${lots} lot(s))`
    toast.success(`${what} @ ${fmtMoney(price)}${replaced ? ` · replaced ${replaced} old exit(s)` : ''}${r ? ` · ${r} resting` : ''}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Level order failed')
  }
}
