'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, Clock3, Gauge, Layers, Trash2, Webhook } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, fmtTime, sideStrikeFor } from '../lib/client-api'
import type { AutoRuleRow } from '../lib/client-api'
import { useSyncChannel, type SyncAdmin } from '../lib/sync'
import { useTerminal, type WorkspaceCfg, type StrikeRowCfg } from '../lib/store'

// ============================================================
// Auto bot (right dock "Auto" tab) — rule builder v3.
// COMPOUND triggers: enable any mix of
//   · TIME     — at HH:MM:SS IST (seconds precision)
//   · RANGE    — index price inside [lo, hi]
//   · PREMIUM  — the option's own price ≤ x / in lo–hi / ≥ x
//   (delta/gamma move the premium even when the index is low —
//   the premium condition is checked per strike at fire time)
// ALL enabled conditions must be true at the same 250ms tick.
// Time rules wait inside a 5-min grace window until the other
// conditions align (2s when time is the only condition).
// Actions: BUY / SELL / DEPLOY side list / CANCEL side orders.
// Strikes: ATM ± 1..5 button row, or a picked set from the
// workspace strike rows (each with its own alloc %).
// Optional order legs (any subset): entry LIMIT ₹, SL, TGT.
// Rules run server-side — they fire even when the terminal is closed.
// ============================================================

type Action = 'BUY' | 'SELL' | 'DEPLOY' | 'CANCEL'
type PremiumMode = 'LTE' | 'RANGE' | 'GTE'

export function AutoPanel({ ws }: { ws: WorkspaceCfg }) {
  const qc = useQueryClient()
  // auto rules ride the sync:admin websocket (2s push) — REST fallback
  const adm = useSyncChannel<SyncAdmin>('sync:admin')
  const { data: rulesRest } = useQuery({ queryKey: ['autorules'], queryFn: () => api.autoRules(), enabled: !adm, refetchInterval: 3000 })
  const data = adm?.autoRules ? { rules: adm.autoRules as unknown as AutoRuleRow[] } : rulesRest
  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const unds = undData?.underlyings ?? []
  const rules = data?.rules ?? []
  const defaultUnderlying = ws.strikes?.underlying ?? (unds.some(u => u.underlying === ws.symbol) ? ws.symbol : unds[0]?.underlying ?? '')

  // ---- conditions (any mix — at least one) ----
  const [useTime, setUseTime] = useState(true)
  const [useRange, setUseRange] = useState(false)
  const [usePremium, setUsePremium] = useState(false)
  const [time, setTime] = useState('09:30:00')
  const [lo, setLo] = useState('')
  const [hi, setHi] = useState('')
  const [pmode, setPmode] = useState<PremiumMode>('LTE')
  const [pLo, setPLo] = useState('')
  const [pHi, setPHi] = useState('')

  // ---- action + strikes ----
  const [underlying, setUnderlying] = useState(defaultUnderlying)
  const [action, setAction] = useState<Action>('BUY')
  const [optType, setOptType] = useState<'CE' | 'PE'>('CE')
  const [offset, setOffset] = useState(0)
  const [allocPct, setAllocPct] = useState(100)
  const [entryPrice, setEntryPrice] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [target, setTarget] = useState('')
  const [pickStrikes, setPickStrikes] = useState(false)
  const [picked, setPicked] = useState<Record<string, number>>({}) // rowId -> allocPct
  const [repeatDaily, setRepeatDaily] = useState(true)
  const [busy, setBusy] = useState(false)

  const effUnderlying = underlying || defaultUnderlying
  const wsRows = (ws.strikes?.rows ?? []).filter(r => r.type === optType)

  // chain meta for the ITM/OTM quick-add (side-specific strikes)
  const { data: chainData } = useQuery({
    queryKey: ['autoChain', effUnderlying, ws.strikes?.expiry],
    queryFn: () => api.optionChain(effUnderlying!, ws.strikes?.expiry ?? null, []),
    enabled: !!effUnderlying,
    refetchInterval: 10_000,
  })
  const autoMeta = chainData?.meta ?? null

  /** offset (in side-ATM steps) semantics — the service adds offset*step to
   *  the SIDE ATM (CE floor / PE ceil): CE ITM = negative, PE ITM = positive. */
  const labelForOffset = (o: number) =>
    o === 0 ? 'ATM' : optType === 'CE' ? (o < 0 ? `ITM ${-o}` : `OTM ${o}`) : (o > 0 ? `ITM ${o}` : `OTM ${-o}`)
  const btnLabel = (o: number) => {
    if (o === 0) return 'ATM'
    const itm = optType === 'CE' ? o < 0 : o > 0
    return `${itm ? 'I' : 'O'}${Math.abs(o)}`
  }

  /** Add a strike for THIS arm's side to the workspace strikes list. */
  const patchWsSt = useTerminal(s => s.patchWs)
  const addArmStrike = async (strike: number) => {
    const id = `${strike}:${optType}`
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? ws.strikes
    if (!cur) return
    if (cur.rows.some(r => r.id === id)) { setPicked(p => ({ ...p, [id]: p[id] ?? allocPct })); return }
    try { await api.ensureStrike(effUnderlying || ws.strikes?.underlying || '', strike, ws.strikes?.expiry ?? null) } catch { /* contracts may exist */ }
    const cur2 = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? cur
    const next: StrikeRowCfg = { id, strike, type: optType, enabled: true, allocPct: 0 }
    const rows = [...cur2.rows, next]
    patchWsSt(ws.id, { strikes: { ...cur2, rows } })
    setPicked(p => ({ ...p, [id]: p[id] ?? allocPct }))
  }

  const togglePicked = (id: string, strike: number, on: boolean) => {
    setPicked(p => {
      const next = { ...p }
      if (on) next[id] = next[id] ?? allocPct
      else delete next[id]
      return next
    })
    void strike
  }
  const pickedList = () =>
    Object.entries(picked).map(([id, allocPct]) => {
      const row = wsRows.find(r => r.id === id)
      return { strike: row?.strike ?? 0, type: optType, allocPct }
    }).filter(s => s.strike > 0)

  const create = async () => {
    if (!effUnderlying) { toast.error('Pick an F&O underlying'); return }
    if (!useTime && !useRange && !usePremium) { toast.error('Enable at least one condition (time / range / premium)'); return }
    if (useTime && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(time)) { toast.error('Time must be HH:MM or HH:MM:SS'); return }
    if (useRange && (!lo || !hi)) { toast.error('Enter the index range low and high'); return }
    if (usePremium && pmode === 'LTE' && !pHi) { toast.error('Premium ≤: enter the max price'); return }
    if (usePremium && pmode === 'GTE' && !pLo) { toast.error('Premium ≥: enter the min price'); return }
    if (usePremium && pmode === 'RANGE' && (!pLo || !pHi)) { toast.error('Premium range: enter lo and hi'); return }
    if (pickStrikes && Object.keys(picked).length === 0) { toast.error('Pick at least one strike (or switch to ATM mode)'); return }
    const strikes = pickStrikes ? pickedList() : undefined
    const condTxt = [
      useTime ? `@ ${time}` : null,
      useRange ? `idx ${lo}-${hi}` : null,
      usePremium ? `prem ${pmode === 'LTE' ? `≤${pHi}` : pmode === 'GTE' ? `≥${pLo}` : `${pLo}-${pHi}`}` : null,
    ].filter(Boolean).join(' + ')
    const name = `${action} ${optType}${strikes?.length ? ` ×${strikes.length}` : offset ? (offset > 0 ? ` +${offset}` : ` ${offset}`) : ' ATM'} ${condTxt}${entryPrice ? ` · e${entryPrice}` : ''}${stopLoss ? ` · sl${stopLoss}` : ''}${target ? ` · t${target}` : ''}`
    setBusy(true)
    try {
      await api.createAutoRule({
        name,
        underlying: effUnderlying,
        expiry: ws.strikes?.expiry ?? null,
        kind: 'COMPOUND', // server derives the final kind from enabled conditions
        time: useTime ? time : undefined,
        lo: useRange ? Number(lo) : undefined,
        hi: useRange ? Number(hi) : undefined,
        entryOp: usePremium ? pmode : undefined,
        entryLo: usePremium && (pmode === 'RANGE' || pmode === 'GTE') ? Number(pLo) : undefined,
        entryHi: usePremium && (pmode === 'RANGE' || pmode === 'LTE') ? Number(pHi) : undefined,
        action, optType, offset, allocPct,
        strikes,
        entryPrice: entryPrice ? Number(entryPrice) : undefined,
        stopLoss: stopLoss ? Number(stopLoss) : undefined,
        target: target ? Number(target) : undefined,
        enabled: true,
        repeatDaily,
      })
      await qc.invalidateQueries({ queryKey: ['autorules'] })
      toast.success('Auto rule armed')
      setLo(''); setHi(''); setPLo(''); setPHi('')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Create failed') }
    setBusy(false)
  }

  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.patchAutoRule(id, { enabled })
      await qc.invalidateQueries({ queryKey: ['autorules'] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const remove = async (id: string) => {
    try {
      await api.deleteAutoRule(id)
      await qc.invalidateQueries({ queryKey: ['autorules'] })
      toast.success('Rule deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
  }

  const sel = 'h-6 rounded bg-secondary/60 px-1 text-[10px] outline-none'
  const btn = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[9px] font-bold ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary/70 text-muted-foreground hover:text-foreground'}`

  return (
    <div className="flex flex-col text-[11px]">
      {/* create form */}
      <div className="p-1.5 space-y-1.5 border-b border-border">
        <div className="flex items-center gap-1">
          <Bot className="h-3 w-3 text-primary" />
          <span className="text-[10px] font-bold uppercase tracking-wide">Auto bot</span>
          <div className="flex-1" />
          {/* condition chips — any mix */}
          <button onClick={() => setUseTime(!useTime)} className={btn(useTime)} title="At a specific time (HH:MM:SS IST)">Time</button>
          <button onClick={() => setUseRange(!useRange)} className={btn(useRange)} title="Index price inside a range">Range</button>
          <button onClick={() => setUsePremium(!usePremium)} className={btn(usePremium)} title="Option premium condition (delta/gamma aware)">Premium</button>
        </div>

        {/* condition inputs */}
        <div className="flex gap-1 items-center flex-wrap">
          <select value={effUnderlying} onChange={e => setUnderlying(e.target.value)} className={`${sel} min-w-0 flex-1`} title="Underlying">
            {unds.map(u => <option key={u.underlying} value={u.underlying}>{u.underlying}</option>)}
          </select>
          {useTime && (
            <Input
              value={time}
              onChange={e => setTime(e.target.value.replace(/[^0-9:]/g, ''))}
              placeholder="HH:MM:SS"
              className="h-6 w-[78px] text-[10px] tabular bg-secondary/60"
              title="Fires at this IST time (seconds precision). Combined rules wait up to 5 min for the other conditions."
            />
          )}
          {useRange && (
            <>
              <Input value={lo} onChange={e => setLo(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="idx lo" className="h-6 w-[54px] text-[10px] tabular bg-secondary/60" />
              <span className="text-muted-foreground text-[9px]">–</span>
              <Input value={hi} onChange={e => setHi(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="idx hi" className="h-6 w-[54px] text-[10px] tabular bg-secondary/60" />
            </>
          )}
        </div>
        {usePremium && (
          <div className="flex gap-1 items-center">
            <span className="text-[8px] text-muted-foreground uppercase tracking-wide shrink-0" title="Option premium condition — per strike at fire time">prem</span>
            {([['LTE', '≤'], ['RANGE', 'lo–hi'], ['GTE', '≥']] as [PremiumMode, string][]).map(([m, label]) => (
              <button key={m} onClick={() => setPmode(m)} className={btn(pmode === m)}>{label}</button>
            ))}
            {pmode === 'LTE' && (
              <Input value={pHi} onChange={e => setPHi(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="≤ ₹" className="h-6 w-[58px] text-[10px] tabular bg-secondary/60" />
            )}
            {pmode === 'GTE' && (
              <Input value={pLo} onChange={e => setPLo(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="≥ ₹" className="h-6 w-[58px] text-[10px] tabular bg-secondary/60" />
            )}
            {pmode === 'RANGE' && (
              <>
                <Input value={pLo} onChange={e => setPLo(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="lo" className="h-6 w-[50px] text-[10px] tabular bg-secondary/60" />
                <span className="text-muted-foreground text-[9px]">–</span>
                <Input value={pHi} onChange={e => setPHi(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="hi" className="h-6 w-[50px] text-[10px] tabular bg-secondary/60" />
              </>
            )}
          </div>
        )}

        {/* action + option side */}
        <div className="flex items-center gap-1">
          {(['BUY', 'SELL', 'DEPLOY', 'CANCEL'] as Action[]).map(a => (
            <button
              key={a}
              onClick={() => setAction(a)}
              title={a === 'DEPLOY' ? `Buy the full ${optType} strike list` : a === 'CANCEL' ? `Cancel pending ${optType} orders` : `Market${entryPrice ? '/LIMIT' : ''} ${a} of the ${optType}`}
              className={btn(action === a)}
            >
              <span className={a === 'SELL' ? 'text-[#ff4d5e]' : a === 'CANCEL' ? 'text-muted-foreground' : 'text-[#00c896]'}>{a}</span>
            </button>
          ))}
          <button onClick={() => setOptType(optType === 'CE' ? 'PE' : 'CE')} title="Option side" className={`${btn(optType === 'CE')} ${optType === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>
            {optType}
          </button>
        </div>

        {/* strikes: ATM/ITM/OTM buttons or picked set (single-arm strike list) */}
        <div className="flex items-center gap-1">
          <button onClick={() => setPickStrikes(false)} className={btn(!pickStrikes)}>ATM</button>
          <button
            onClick={() => setPickStrikes(true)}
            className={btn(pickStrikes)}
            title="Pick specific strikes from the workspace strike list (or build the arm's list below)"
          >Strikes</button>
          {!pickStrikes ? (
            <div className="flex items-center gap-0.5 flex-wrap">
              {[-5, -4, -3, -2, -1].map(o => (
                <button key={o} onClick={() => setOffset(o)} title={labelForOffset(o)} className={`h-4.5 w-5 text-[9px] tabular rounded ${offset === o ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:text-foreground'}`}>{btnLabel(o)}</button>
              ))}
              <button onClick={() => setOffset(0)} title="ATM" className={`px-1 h-4.5 text-[9px] font-bold rounded ${offset === 0 ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:text-foreground'}`}>ATM</button>
              {[1, 2, 3, 4, 5].map(o => (
                <button key={o} onClick={() => setOffset(o)} title={labelForOffset(o)} className={`h-4.5 w-5 text-[9px] tabular rounded ${offset === o ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:text-foreground'}`}>{btnLabel(o)}</button>
              ))}
            </div>
          ) : (
            <span className="text-[8px] text-muted-foreground">{Object.keys(picked).length} picked from {optType} rows</span>
          )}
        </div>
        {!pickStrikes && autoMeta && (
          <div className="text-[8px] text-muted-foreground">{labelForOffset(offset)} → {optType} @ {(autoMeta.step) * 0 + (optType === 'CE' ? autoMeta.ceAtm + offset * autoMeta.step : autoMeta.peAtm + offset * autoMeta.step)}</div>
        )}

        {pickStrikes && (
          <div className="rounded bg-secondary/30 p-1 space-y-0.5 max-h-36 overflow-y-auto">
            {/* ITM/ATM/OTM quick-add for THIS arm's side only */}
            {autoMeta && (
              <div className="flex items-center gap-0.5 pb-1 border-b border-border/40">
                <span className="text-[8px] font-bold text-[#4dd0e1] shrink-0">ITM</span>
                {[3, 2, 1].map(n => {
                  const s = sideStrikeFor({ ce: autoMeta.ceAtm, pe: autoMeta.peAtm }, autoMeta.step, -1, n, optType)
                  const on = wsRows.some(r => r.strike === s)
                  return (
                    <button key={n} onClick={() => addArmStrike(s)} title={`add ${optType} ${s} to this arm's list`}
                      className={`flex-1 h-4 text-[9px] tabular rounded ${on ? 'bg-primary/25 text-foreground' : 'bg-secondary/70 text-muted-foreground hover:text-foreground'}`}
                    >{n}</button>
                  )
                })}
                <button onClick={() => addArmStrike(optType === 'CE' ? autoMeta.ceAtm : autoMeta.peAtm)} title={`add ATM ${optType}`}
                  className="flex-1 h-4 text-[9px] font-bold rounded bg-primary/25 text-foreground"
                >ATM</button>
                <span className="text-[8px] font-bold text-[#e0a63f] shrink-0">OTM</span>
                {[1, 2, 3].map(n => {
                  const s = sideStrikeFor({ ce: autoMeta.ceAtm, pe: autoMeta.peAtm }, autoMeta.step, 1, n, optType)
                  const on = wsRows.some(r => r.strike === s)
                  return (
                    <button key={n} onClick={() => addArmStrike(s)} title={`add ${optType} ${s} to this arm's list`}
                      className={`flex-1 h-4 text-[9px] tabular rounded ${on ? 'bg-primary/25 text-foreground' : 'bg-secondary/70 text-muted-foreground hover:text-foreground'}`}
                    >{n}</button>
                  )
                })}
              </div>
            )}
            {wsRows.length === 0 && <div className="text-[9px] text-muted-foreground px-1">No {optType} strikes yet — use the ITM/ATM/OTM buttons above to build this arm's list.</div>}
            {wsRows.map(r => (
              <label key={r.id} className="flex items-center gap-1.5 px-1 py-0.5 text-[10px] cursor-pointer hover:bg-secondary/50 rounded">
                <input
                  type="checkbox"
                  checked={!!picked[r.id]}
                  onChange={e => togglePicked(r.id, r.strike, e.target.checked)}
                  className="accent-[#3b82f6] h-3 w-3"
                />
                <span className="tabular font-semibold w-14">{r.strike}</span>
                <span className={`text-[8px] font-bold ${r.type === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{r.type}</span>
                <div className="flex-1" />
                <input
                  value={picked[r.id] ?? allocPct}
                  onChange={e => setPicked(p => ({ ...p, [r.id]: Math.max(1, Math.min(100, Number(e.target.value.replace(/[^0-9]/g, '')) || 1)) }))}
                  className="h-4 w-10 rounded bg-secondary/60 text-center text-[9px] tabular outline-none"
                  title="Alloc % for this strike"
                />
                <span className="text-[8px] text-muted-foreground">%</span>
              </label>
            ))}
          </div>
        )}

        {/* alloc + optional order legs */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground">alloc</span>
          <input
            type="range" min={5} max={100} step={5} value={allocPct}
            onChange={e => setAllocPct(Number(e.target.value))}
            className="h-1 w-12 accent-[#3b82f6]"
          />
          <span className="tabular text-[9px] w-7 text-right">{allocPct}%</span>
          <span className="text-[8px] text-muted-foreground uppercase tracking-wide shrink-0">legs</span>
          <Input value={entryPrice} onChange={e => setEntryPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="entry ₹" className="h-6 w-[56px] text-[9px] tabular bg-secondary/60" title="Entry — LIMIT at this price (blank = market)" />
          <Input value={stopLoss} onChange={e => setStopLoss(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="sl ₹" className="h-6 w-[50px] text-[9px] tabular bg-secondary/60" title="Stop-loss — reduce-only SL-M trigger" />
          <Input value={target} onChange={e => setTarget(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="tgt ₹" className="h-6 w-[50px] text-[9px] tabular bg-secondary/60" title="Target — reduce-only LIMIT" />
        </div>

        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-[9px] text-muted-foreground cursor-pointer" title="Repeat every trading day (else fires once)">
            <input type="checkbox" checked={repeatDaily} onChange={e => setRepeatDaily(e.target.checked)} className="accent-[#3b82f6] h-3 w-3" />
            daily
          </label>
          <Button size="sm" className="h-6 px-2 text-[10px] ml-auto" onClick={create} disabled={busy}>Arm</Button>
        </div>

        <div className="text-[8px] text-muted-foreground leading-snug">
          {[
            useTime ? `at ${time} IST${repeatDaily ? ' daily' : ' (once)'}` : null,
            useRange ? `index in ${lo || '—'}–${hi || '—'}` : null,
            usePremium ? `premium ${pmode === 'LTE' ? `≤ ${pHi || '—'}` : pmode === 'GTE' ? `≥ ${pLo || '—'}` : `${pLo || '—'}–${pHi || '—'}`}` : null,
          ].filter(Boolean).join(' + ')}
          {' → '}{action} {optType}{pickStrikes ? ` ×${Object.keys(picked).length} picked` : offset ? ` side-ATM ${offset > 0 ? '+' : ''}${offset}` : ' side-ATM'} · {allocPct}%
          {entryPrice && ` · LIMIT ${entryPrice}`}{stopLoss && ` · SL ${stopLoss}`}{target && ` · TGT ${target}`}. Fires server-side.
        </div>
      </div>

      {/* rules list */}
      <div className="flex-1 overflow-y-auto">
        {rules.length === 0 && (
          <div className="p-3 text-center text-[10px] text-muted-foreground leading-relaxed">
            No rules yet. Arm a time / range / premium<br />rule above — compound conditions supported.
          </div>
        )}
        {rules.map(r => (
          <div key={r.id} className="px-2 py-1.5 border-b border-border/50 flex items-start gap-1.5">
            {r.kind === 'INDEX' ? <Gauge className="h-3 w-3 mt-0.5 text-[#4dd0e1] shrink-0" />
              : r.kind === 'INDEX_RANGE' ? <Webhook className="h-3 w-3 mt-0.5 text-[#a78bfa] shrink-0" />
              : r.kind === 'COMPOUND' ? <Layers className="h-3 w-3 mt-0.5 text-[#e0a63f] shrink-0" />
              : <Clock3 className="h-3 w-3 mt-0.5 text-[#f5a623] shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-[10px] font-semibold">{r.name}</span>
              </div>
              <div className="text-[8px] text-muted-foreground">
                {r.underlying} · {r.kind.toLowerCase()} · {r.action}{' '}
                <b className={r.optType === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}>{r.optType}</b>{' '}
                {r.strikes && r.strikes.length > 0
                  ? `×${r.strikes.length} strikes`
                  : r.offset === 0 ? 'ATM' : r.offset > 0 ? `+${r.offset}` : r.offset}
                {' · '}{r.allocPct}%{r.repeatDaily ? ' · daily' : ' · once'}
                {(r.entryPrice || r.stopLoss || r.target) && (
                  <span className="ml-1 text-[#e0a63f]">
                    [{r.entryPrice ? `e${r.entryPrice}` : ''}{r.stopLoss ? ` sl${r.stopLoss}` : ''}{r.target ? ` t${r.target}` : ''}]
                  </span>
                )}
              </div>
              {r.lastFiredAt && (
                <div className="text-[8px]">
                  <span className={r.lastStatus === 'FIRED' ? 'term-up' : 'term-down'}>
                    {r.lastStatus} {fmtTime(r.lastFiredAt)}
                  </span>
                  {r.lastMessage && <span className="text-muted-foreground"> — {r.lastMessage}</span>}
                </div>
              )}
            </div>
            <Switch checked={r.enabled} onCheckedChange={v => toggle(r.id, v)} />
            <button onClick={() => remove(r.id)} className="p-0.5 rounded text-muted-foreground hover:text-[#ff4d5e]" title="Delete rule">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
