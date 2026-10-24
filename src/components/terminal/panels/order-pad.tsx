'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, fmtInr } from '../lib/client-api'
import type { AccountRow } from '../lib/client-api'
import { useSyncChannel, type SyncCore } from '../lib/sync'
import { useTerminal } from '../lib/store'
import { onTicks } from '../lib/socket'
import { useEffect } from 'react'
import type { Tick } from '@/lib/types'

export function OrderPad() {
  const symbol = useTerminal(s => s.selectedSymbol)
  const side = useTerminal(s => s.side)
  const setSide = useTerminal(s => s.setSide)
  const orderType = useTerminal(s => s.orderType)
  const setOrderType = useTerminal(s => s.setOrderType)
  const productType = useTerminal(s => s.productType)
  const setProductType = useTerminal(s => s.setProductType)
  const qty = useTerminal(s => s.qty)
  const setQty = useTerminal(s => s.setQty)
  const qtyMode = useTerminal(s => s.qtyMode)
  const setQtyMode = useTerminal(s => s.setQtyMode)
  const limitPrice = useTerminal(s => s.limitPrice)
  const setLimitPrice = useTerminal(s => s.setLimitPrice)

  const [ltp, setLtp] = useState(0)
  const [placing, setPlacing] = useState(false)

  useEffect(() => onTicks(map => {
    const t = map[symbol]
    if (t) setLtp(t.ltp)
  }), [symbol])

  const { data: symData } = useQuery({
    queryKey: ['symbol-one', symbol],
    queryFn: () => api.symbols(symbol, ''),
    refetchInterval: 30_000,
  })
  const sym = symData?.symbols.find(s => s.symbol === symbol)
  const lotSize = sym?.lotSize ?? 1
  const isOption = sym?.instrumentType === 'CE' || sym?.instrumentType === 'PE'

  // accounts via the sync:core websocket — REST fallback while the socket is down
  const core = useSyncChannel<SyncCore>('sync:core')
  const { data: accountsRest } = useQuery({
    queryKey: ['accounts-op'],
    queryFn: () => api.accounts(),
    enabled: !core,
    refetchInterval: 3000,
  })
  const accountsData = core ? { accounts: core.accounts as unknown as AccountRow[] } : accountsRest
  const execAccounts = (accountsData?.accounts ?? []).filter(a => a.isOrderEnabled && a.isActive)

  // estimated deployment across enabled accounts (AUTO sizing)
  const est = useMemo(() => {
    const px = orderType === 'LIMIT' && limitPrice ? limitPrice : ltp
    if (qtyMode === 'MANUAL') {
      const units = qty * lotSize
      return { units, perAccount: execAccounts.map(a => ({ label: a.label, units, margin: px * units / (isOption || productType === 'CNC' ? 1 : 5) })) }
    }
    const perAccount = execAccounts.map(a => {
      const lev = isOption || productType === 'CNC' ? 1 : 5
      const notional = a.usableCapital * lev
      const raw = notional / (px || 1)
      const lots = Math.floor(raw / lotSize)
      const units = Math.min(qty > 0 ? qty * lotSize : Infinity, lots * lotSize)
      return { label: a.label, units: isFinite(units) ? units : 0, margin: units * px / lev }
    })
    const totalUnits = perAccount.reduce((s, p) => s + p.units, 0)
    return { units: totalUnits / lotSize, perAccount }
  }, [qtyMode, qty, lotSize, ltp, limitPrice, orderType, execAccounts, isOption, productType])

  const place = async () => {
    if (!sym) { toast.error('Symbol not found in master contracts'); return }
    setPlacing(true)
    try {
      const res = await api.placeOrder({
        symbol,
        exchange: sym.exchange,
        side,
        qty: qtyMode === 'MANUAL' ? qty : 0, // 0 => auto-size per account capital rules
        orderType,
        productType,
        limitPrice: orderType === 'LIMIT' || orderType === 'SL' ? limitPrice : undefined,
        triggerPrice: orderType === 'SL' || orderType === 'SL-M' ? limitPrice : undefined,
        source: 'MANUAL',
      })
      const filled = res.legs.filter(l => l.status === 'FILLED').length
      if (res.status === 'FAILED') {
        toast.error(`Order failed — ${res.message}`)
      } else {
        toast.success(`${side} ${symbol} → ${filled}/${res.legs.length} accounts filled`, {
          description: res.legs.map(l => `${l.accountLabel.split(' ')[0]}: ${l.status}${l.qty ? '×' + l.qty : ''}`).join(' · '),
        })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Order failed')
    } finally {
      setPlacing(false)
    }
  }

  const price = orderType === 'LIMIT' && limitPrice ? limitPrice : ltp

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold">{symbol}</div>
        <div className={`text-xs font-bold tabular ${ltp ? '' : 'text-muted-foreground'}`}>{ltp ? ltp.toFixed(2) : '—'}</div>
      </div>
      {sym && (
        <div className="text-[9px] text-muted-foreground">
          {sym.exchange} · {sym.instrumentType} · Lot {lotSize}
        </div>
      )}

      {/* side switch */}
      <div className="grid grid-cols-2 gap-1">
        <button
          onClick={() => setSide('BUY')}
          className={`h-8 rounded text-xs font-bold transition-colors ${side === 'BUY' ? 'bg-[#00c896] text-black' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
        >BUY</button>
        <button
          onClick={() => setSide('SELL')}
          className={`h-8 rounded text-xs font-bold transition-colors ${side === 'SELL' ? 'bg-[#ff4d5e] text-black' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
        >SELL</button>
      </div>

      {/* product */}
      <div className="grid grid-cols-3 gap-1">
        {(['MIS', 'CNC', 'NRML'] as const).map(p => (
          <button key={p} onClick={() => setProductType(p)}
            className={`h-6 rounded text-[10px] ${productType === p ? 'bg-accent text-foreground border border-primary/60' : 'bg-secondary text-muted-foreground'}`}>{p}</button>
        ))}
      </div>

      {/* order type */}
      <div className="grid grid-cols-4 gap-1">
        {(['MARKET', 'LIMIT', 'SL', 'SL-M'] as const).map(t => (
          <button key={t} onClick={() => setOrderType(t)}
            className={`h-6 rounded text-[9px] ${orderType === t ? 'bg-accent text-foreground border border-primary/60' : 'bg-secondary text-muted-foreground'}`}>{t}</button>
        ))}
      </div>

      {(orderType === 'LIMIT' || orderType === 'SL' || orderType === 'SL-M') && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground w-10">Price</span>
          <Input
            type="number"
            value={limitPrice ?? ''}
            onChange={e => setLimitPrice(e.target.value ? Number(e.target.value) : null)}
            className="h-7 text-xs tabular"
            placeholder={ltp ? ltp.toFixed(2) : '0'}
          />
        </div>
      )}

      {/* qty */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground w-10">Qty</span>
        <div className="flex flex-1 gap-1">
          <Button variant="secondary" size="sm" className="h-7 px-2" onClick={() => setQty(qty - 1)}>−</Button>
          <Input
            type="number"
            value={qty}
            onChange={e => setQty(Number(e.target.value) || 0)}
            disabled={qtyMode === 'AUTO'}
            className="h-7 text-xs text-center tabular"
          />
          <Button variant="secondary" size="sm" className="h-7 px-2" onClick={() => setQty(qty + 1)}>+</Button>
        </div>
      </div>

      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>Auto-size: each account uses its own capital house rules</span>
        <button
          onClick={() => setQtyMode(qtyMode === 'AUTO' ? 'MANUAL' : 'AUTO')}
          className={`px-1.5 py-0.5 rounded ${qtyMode === 'AUTO' ? 'bg-primary/20 text-primary' : 'bg-secondary'}`}
        >
          {qtyMode === 'AUTO' ? 'AUTO' : 'MANUAL'}
        </button>
      </div>

      {/* per-account sizing preview */}
      <div className="rounded bg-secondary/40 p-1.5 text-[9px] space-y-0.5">
        <div className="flex justify-between text-muted-foreground">
          <span>Est. units</span>
          <span className="tabular text-foreground">{Math.round(est.units * (lotSize || 1)).toLocaleString('en-IN')}</span>
        </div>
        {est.perAccount.slice(0, 6).map(p => (
          <div key={p.label} className="flex justify-between">
            <span className="text-muted-foreground truncate max-w-[120px]">{p.label}</span>
            <span className="tabular">{p.units > 0 ? `${p.units}u · ${fmtInr(p.margin)}` : '—'}</span>
          </div>
        ))}
      </div>

      <Button
        onClick={place}
        disabled={placing}
        className={`h-9 text-xs font-bold text-black ${side === 'BUY' ? 'bg-[#00c896] hover:bg-[#00b886]' : 'bg-[#ff4d5e] hover:bg-[#f03d4e]'}`}
      >
        {placing ? 'Routing…' : `${side} ${symbol}`}
      </Button>
      <div className="text-[9px] text-muted-foreground text-center">
        Routes to {execAccounts.length} enabled account(s) · LTP ref {price ? price.toFixed(2) : '—'}
      </div>
    </div>
  )
}
