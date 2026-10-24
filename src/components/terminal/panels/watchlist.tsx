'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, GripHorizontal, Layers, Plus, Search, Star, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { api, fmtMoney, sideOffsetLabel } from '../lib/client-api'
import type { SymbolRow } from '../lib/client-api'
import type { FnoUniverseResp, FnoUnderlyingRow } from '../lib/client-api'
import type { IndexComponentRow, IndexComponentsResp } from '../lib/client-api'
import { useTerminal, defaultDepthPanels, addDepthPanelTo, type DepthPanelCfg, type WorkspaceCfg } from '../lib/store'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'
import { useSyncData } from '../lib/sync'
import type { Tick } from '@/lib/types'

// ============================================================
// Left panel — watchlist with N tabs:
//  · Watch  — starred symbols (persisted)
//  · Index  — all indices; rows expand into constituent stocks
//             (H / LTP / L / Vol / chg% / contribution pts);
//             a COMMODITIES section lists MCX underlyings
//  · FNO    — latest-expiry option/futures underlyings from ALL
//             exchanges: NFO, BFO, BFNO, MCX, CDS — indices,
//             stocks, commodities, currency
//  · user tabs — any number of custom symbol lists (+ to add,
//             double-click to rename, × to delete; the star adds
//             the row to the ACTIVE user tab)
// Sorting (symbol / LTP / chg) on every tab; rows show LTP, the
// change pts + %, and day H/L. Clicking any row opens (or re-
// activates) that symbol's workspace — F&O underlyings load the
// spot + ATM CE/PE layout with the strikes panel pre-bound.
// ============================================================

type BuiltinTab = 'watch' | 'index' | 'fno'
type TabKey = BuiltinTab | `user:${string}`

type SortKey = 'sym' | 'ltp' | 'chg'
type ConstitSortKey = 'pts' | 'sym' | 'ltp' | 'chg' | 'vol'

/** Depth-add icon for any watchlist row — loads the symbol into the ACTIVE
 *  workspace's bottom-left depth panel stack. */
function DepthAddIcon({ symbol }: { symbol: string }) {
  const add = () => {
    const st = useTerminal.getState()
    const cur = st.workspaces.find(w => w.id === st.activeWs)
    if (!cur) return
    const { patch, error } = addDepthPanelTo(cur, symbol)
    if (error) { toast.info(error); return }
    st.patchWs(cur.id, patch)
    toast.success(`Depth panel added — ${symbol}`)
  }
  return (
    <button
      onClick={e => { e.stopPropagation(); add() }}
      title={`Load ${symbol} market depth panel`}
      className="p-0.5 rounded shrink-0 text-muted-foreground/45 hover:text-foreground hover:bg-secondary/60"
    >
      <Layers className="h-3 w-3" />
    </button>
  )
}

export function Watchlist() {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<TabKey>('watch')
  const [ticks, setTicks] = useState<Record<string, Tick>>({})
  const [expandedIdx, setExpandedIdx] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortKey>('sym')
  const [sortAsc, setSortAsc] = useState(true)
  const [renaming, setRenaming] = useState<string | null>(null)
  const selectedSymbol = useTerminal(s => s.selectedSymbol)
  const watchSymbols = useTerminal(s => s.watchSymbols)
  const toggleWatch = useTerminal(s => s.toggleWatch)
  const openSymbolWorkspace = useTerminal(s => s.openSymbolWorkspace)
  const wlTabs = useTerminal(s => s.wlTabs)
  const addWlTab = useTerminal(s => s.addWlTab)
  const removeWlTab = useTerminal(s => s.removeWlTab)
  const renameWlTab = useTerminal(s => s.renameWlTab)
  const toggleWlTabSymbol = useTerminal(s => s.toggleWlTabSymbol)

  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const fnoSet = useMemo(() => new Set((undData?.underlyings ?? []).map(u => u.underlying)), [undData])
  const indexMeta = useMemo(() => new Map((undData?.underlyings ?? []).map(u => [u.underlying, u])), [undData])

  // ---- FNO universe (all exchanges) ----
  const { data: fnoData } = useQuery({
    queryKey: ['fnoUniverse'],
    queryFn: () => api.fnoUniverse(),
    refetchInterval: 10_000,
    enabled: tab === 'fno' || tab === 'index',
  })
  const fnoGroups = fnoData?.groups ?? []

  const isUserTab = tab.startsWith('user:')
  const userTabId = isUserTab ? tab.slice(5) : null
  const userTab = wlTabs.find(t => t.id === userTabId) ?? null

  const typeFilter = ''
  // master-contract SEARCH — any tab: typing queries every synced SymbolMaster
  // row (849+ symbols incl. the broker master contracts), so results show even
  // when the current tab only holds 3 starred rows (the round-12 search bug)
  const searchActive = q.trim().length > 0
  const { data: searchData } = useQuery({
    queryKey: ['symbols-search', q],
    queryFn: () => api.symbols(q, typeFilter),
    refetchInterval: 60_000,
    enabled: searchActive,
  })
  const { data } = useQuery({
    queryKey: ['symbols', q, typeFilter],
    queryFn: () => api.symbols(q, typeFilter),
    refetchInterval: 60_000,
    enabled: !isUserTab && tab !== 'watch' && tab !== 'index' && tab !== 'fno' && !searchActive,
  })

  // rows for the generic master-list search (fallback tab)
  const symbols = useMemo(() => {
    const list = data?.symbols ?? []
    const rank = (r: SymbolRow) => (r.instrumentType === 'INDEX' ? 0 : r.instrumentType === 'EQ' ? 1 : r.instrumentType === 'FUT' ? 2 : 3)
    return [...list].sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol)).slice(0, 60)
  }, [data])

  // Watch tab rows — starred symbols resolved against master contracts
  const { data: watchData } = useQuery({
    queryKey: ['symbols-watch', watchSymbols.join(',')],
    queryFn: () => api.symbolsByList(watchSymbols),
    refetchInterval: 60_000,
    enabled: tab === 'watch' && watchSymbols.length > 0,
  })
  const watchRows = useMemo(() => {
    const map = new Map((watchData?.symbols ?? []).map(s => [s.symbol, s]))
    const out: SymbolRow[] = []
    for (const sym of watchSymbols) {
      const row = map.get(sym)
      if (row) out.push(row)
      else out.push({ id: `adhoc-${sym}`, symbol: sym, name: sym, exchange: '—', instrumentType: fnoSet.has(sym) ? 'INDEX' : 'EQ', lotSize: indexMeta.get(sym)?.lotSize ?? 1, mappings: [] })
    }
    return out
  }, [watchData, watchSymbols, fnoSet, indexMeta])

  // Index tab rows — all indices (+ commodities section from the FNO universe)
  const { data: idxData } = useQuery({
    queryKey: ['symbols-index'],
    queryFn: () => api.symbols('', 'INDEX'),
    refetchInterval: 60_000,
    enabled: tab === 'index',
  })
  const indexRows = useMemo(() => (idxData?.symbols ?? []).slice(0, 20), [idxData])
  const commRows = useMemo(() => {
    const out: FnoUnderlyingRow[] = []
    for (const g of fnoGroups) {
      if (g.exchange === 'MCX') for (const u of g.underlyings) if (u.segment === 'COMM') out.push(u)
    }
    return out
  }, [fnoGroups])

  // user tab rows
  const { data: userData } = useQuery({
    queryKey: ['symbols-usertab', userTab?.symbols.join(',')],
    queryFn: () => api.symbolsByList(userTab?.symbols ?? []),
    refetchInterval: 60_000,
    enabled: isUserTab && (userTab?.symbols.length ?? 0) > 0,
  })
  const userRows = useMemo(() => {
    const map = new Map((userData?.symbols ?? []).map(s => [s.symbol, s]))
    const out: SymbolRow[] = []
    for (const sym of userTab?.symbols ?? []) {
      const row = map.get(sym)
      if (row) out.push(row)
      else out.push({ id: `adhoc-${sym}`, symbol: sym, name: sym, exchange: '—', instrumentType: fnoSet.has(sym) ? 'INDEX' : 'EQ', lotSize: indexMeta.get(sym)?.lotSize ?? 1, mappings: [] })
    }
    return out
  }, [userData, userTab, fnoSet, indexMeta])

  // ---- generic row model + sort (LTP/chg come from live ticks) ----
  interface Row {
    key: string
    symbol: string
    name: string
    exchange: string
    instrumentType: string
    lotSize: number
    ltp: number
    chg: number
    chgPct: number
    high: number
    low: number
    fno: boolean
    exp?: string | null
    contracts?: number
    row?: SymbolRow
  }
  const tickOf = (sym: string, fb?: number): { ltp: number; chg: number; chgPct: number; high: number; low: number } => {
    const t = ticks[sym]
    if (t && t.prevClose) {
      return { ltp: t.ltp, chg: t.ltp - t.prevClose, chgPct: ((t.ltp - t.prevClose) / t.prevClose) * 100, high: t.high, low: t.low }
    }
    return { ltp: fb ?? 0, chg: 0, chgPct: 0, high: 0, low: 0 }
  }
  const mkRow = (r: SymbolRow): Row => {
    const t = tickOf(r.symbol, r.basePrice ?? 0)
    return { key: r.id, symbol: r.symbol, name: r.name, exchange: r.exchange, instrumentType: r.instrumentType, lotSize: r.lotSize, ...t, fno: fnoSet.has(r.symbol), row: r }
  }
  const mkFnoRow = (u: FnoUnderlyingRow): Row => {
    const t = tickOf(u.underlying, u.spot)
    return { key: `fno-${u.exchange}-${u.underlying}`, symbol: u.underlying, name: u.name, exchange: u.exchange, instrumentType: u.instrumentType, lotSize: u.lotSize, ltp: u.spot || t.ltp, chg: t.chg, chgPct: t.chgPct || u.chgPct, high: t.high, low: t.low, fno: u.contracts > 0, exp: u.latestExpiry, contracts: u.contracts }
  }

  const baseRows: Row[] = useMemo(() => {
    if (tab === 'watch') return watchRows.map(mkRow)
    if (tab === 'index') return indexRows.map(mkRow)
    if (isUserTab) return userRows.map(mkRow)
    if (tab === 'fno') return fnoGroups.flatMap(g => g.underlyings.map(mkFnoRow))
    return symbols.map(mkRow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, watchRows, indexRows, userRows, fnoGroups, symbols, ticks])

  const visible = useMemo(() => {
    // SEARCH MODE: master-contract results replace the tab rows (deduped)
    if (searchActive) {
      const list = (searchData?.symbols ?? []).map(mkRow)
      const seen = new Set<string>()
      const uniq = list.filter(r => (seen.has(r.symbol) ? false : (seen.add(r.symbol), true)))
      const val = (r: Row) => (sortBy === 'sym' ? 0 : sortBy === 'ltp' ? r.ltp : r.chgPct)
      return [...uniq].sort((a, b) => sortBy === 'sym' ? (sortAsc ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol)) : (sortAsc ? val(a) - val(b) : val(b) - val(a)))
    }
    let list = baseRows
    if (q && (tab === 'watch' || tab === 'index' || isUserTab || tab === 'fno')) {
      list = list.filter(r => r.symbol.includes(q) || (r.name ?? '').toUpperCase().includes(q))
    }
    const val = (r: Row) => (sortBy === 'sym' ? 0 : sortBy === 'ltp' ? r.ltp : r.chgPct)
    return [...list].sort((a, b) => sortBy === 'sym' ? (sortAsc ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol)) : (sortAsc ? val(a) - val(b) : val(b) - val(a)))
  }, [baseRows, q, tab, isUserTab, sortBy, sortAsc, searchActive, searchData])

  const visibleKey = visible.map(r => r.symbol).join(',')
  useEffect(() => {
    const list = visibleKey ? visibleKey.split(',') : []
    subscribeTicks(list)
    return () => unsubscribeTicks(list)
  }, [visibleKey])

  useEffect(() => onTicks(setTicks), [])

  // feed-source switch → purge all local tick state (no sim residue)
  const dataEpoch = useTerminal(s => s.dataEpoch)
  useEffect(() => { setTicks({}) }, [dataEpoch])

  const openWs = (symbol: string) => openSymbolWorkspace(symbol, fnoSet.has(symbol))
  // indices ALWAYS open the spot + ATM CE/PE workspace (charts + right strikes
  // tab), even when the sim chain is missing — panes show placeholders then
  const openIdxWs = (symbol: string) => openSymbolWorkspace(symbol, true)

  /** star = add/remove in the ACTIVE user tab; on builtin tabs = the Watch list */
  const starFor = (symbol: string): { on: boolean; fn: () => void; title: string } => {
    if (isUserTab && userTab) {
      const on = userTab.symbols.includes(symbol)
      return { on, fn: () => toggleWlTabSymbol(userTab.id, symbol), title: on ? `Remove from ${userTab.name}` : `Add to ${userTab.name}` }
    }
    const on = watchSymbols.includes(symbol)
    return { on, fn: () => toggleWatch(symbol), title: on ? 'Remove from Watch tab' : 'Star → Watch tab' }
  }

  const sortCtl = (
    <div className="flex items-center gap-1 px-2 pb-1">
      <select value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)} className="h-4.5 rounded bg-secondary/60 px-0.5 text-[8px] outline-none" title="Sort rows">
        <option value="sym">symbol</option>
        <option value="ltp">LTP</option>
        <option value="chg">chg%</option>
      </select>
      <button onClick={() => setSortAsc(a => !a)} className="px-1 rounded bg-secondary/60 hover:text-foreground text-[8px]" title={sortAsc ? 'Ascending' : 'Descending'}>{sortAsc ? '↑' : '↓'}</button>
      <div className="flex-1" />
      <span className="text-[8px] text-muted-foreground">LTP · chg · H/L</span>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="p-2 space-y-1.5 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={e => setQ(e.target.value.toUpperCase())}
            placeholder="Search… (enter opens a workspace)"
            className="h-8 pl-7 text-xs bg-secondary/60"
          />
        </div>
        <div className="flex gap-0.5 flex-wrap items-center">
          <button
            onClick={() => setTab('watch')}
            className={`px-1.5 py-0.5 text-[10px] rounded ${tab === 'watch' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
          >Watch</button>
          <button
            onClick={() => setTab('index')}
            className={`px-1.5 py-0.5 text-[10px] rounded ${tab === 'index' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
          >Index</button>
          <button
            onClick={() => setTab('fno')}
            title="Latest-expiry F&O from NFO / BFO / BFNO / MCX / CDS"
            className={`px-1.5 py-0.5 text-[10px] rounded ${tab === 'fno' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
          >FNO</button>
          {wlTabs.map(t => (
            <span key={t.id} className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] group ${tab === `user:${t.id}` ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
              {renaming === t.id ? (
                <input
                  autoFocus
                  defaultValue={t.name}
                  onBlur={e => { renameWlTab(t.id, e.target.value.trim() || t.name); setRenaming(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  className="w-12 bg-transparent outline-none text-[10px]"
                />
              ) : (
                <button
                  onClick={() => setTab(`user:${t.id}`)}
                  onDoubleClick={() => setRenaming(t.id)}
                  title={`${t.name} — ${t.symbols.length} symbols (double-click to rename)`}
                >{t.name}</button>
              )}
              <button
                onClick={e => { e.stopPropagation(); if (tab === `user:${t.id}`) setTab('watch'); removeWlTab(t.id) }}
                className="opacity-0 group-hover:opacity-70 hover:!opacity-100"
                title={`Delete ${t.name}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <button
            onClick={() => setTab(`user:${addWlTab()}`)}
            title="New watchlist tab — double-click its name to rename"
            className="p-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        {isUserTab && userTab && (
          <div className="text-[8px] text-muted-foreground">custom tab — tap the star on any row to add it here</div>
        )}
        {tab === 'fno' && (
          <div className="text-[8px] text-muted-foreground">latest-expiry contracts · NFO / BFO / BFNO / MCX / CDS</div>
        )}
      </div>
      {sortCtl}
      <div className="flex-1 overflow-y-auto">
        {/* Index tab: expandable constituent lists + commodities */}
        {tab === 'index' && (
          <>
            {visible.map(r => (
              <IndexRow
                key={r.key}
                symbol={r.symbol}
                name={r.name}
                lotSize={r.lotSize}
                tick={ticks[r.symbol]}
                active={r.symbol === selectedSymbol}
                starred={watchSymbols.includes(r.symbol)}
                onStar={() => toggleWatch(r.symbol)}
                onOpen={() => openIdxWs(r.symbol)}
                onOpenSymbol={sym => openWs(sym)}
                expanded={expandedIdx === r.symbol}
                onToggle={() => setExpandedIdx(expandedIdx === r.symbol ? null : r.symbol)}
              />
            ))}
            {commRows.length > 0 && (
              <div className="px-2 pt-2 pb-1 text-[8px] uppercase tracking-wide text-muted-foreground bg-card/60 sticky top-0">commodities · mcx</div>
            )}
            {commRows.map(u => {
              const r = mkFnoRow(u)
              return (
                <SymbolRowItem
                  key={r.key}
                  row={{ id: r.key, symbol: r.symbol, name: r.name, exchange: r.exchange, instrumentType: 'COMM', lotSize: r.lotSize, mappings: [] }}
                  tick={ticks[r.symbol]}
                  fallbackLtp={r.ltp}
                  active={r.symbol === selectedSymbol}
                  starred={watchSymbols.includes(r.symbol)}
                  onStar={() => toggleWatch(r.symbol)}
                  onOpen={() => openWs(r.symbol)}
                />
              )
            })}
          </>
        )}
        {/* FNO tab: grouped by exchange */}
        {tab === 'fno' && fnoGroups.map(g => (
          <div key={g.exchange}>
            <div className="px-2 py-1 text-[8px] uppercase tracking-wide text-muted-foreground bg-card/60 sticky top-0 border-y border-border/40">
              {g.label} · {g.underlyings.length}
            </div>
            {visible.filter(r => r.exchange === g.exchange).map(r => (
              <FnoRowItem key={r.key} row={r} active={r.symbol === selectedSymbol} starred={watchSymbols.includes(r.symbol)} onStar={() => toggleWatch(r.symbol)} onOpen={() => openWs(r.symbol)} />
            ))}
          </div>
        ))}
        {/* watch / user tabs / fallback search results */}
        {(tab === 'watch' || isUserTab || (tab !== 'index' && tab !== 'fno')) && visible.map(r => (
          <SymbolRowItem
            key={r.key}
            row={r.row ?? { id: r.key, symbol: r.symbol, name: r.name, exchange: r.exchange, instrumentType: r.instrumentType, lotSize: r.lotSize, mappings: [] }}
            tick={ticks[r.symbol]}
            fallbackLtp={r.ltp}
            active={r.symbol === selectedSymbol}
            starred={starFor(r.symbol).on}
            onStar={() => starFor(r.symbol).fn()}
            onOpen={() => openWs(r.symbol)}
          />
        ))}
        {visible.length === 0 && (
          <div className="p-4 text-center text-[11px] text-muted-foreground">
            {searchActive ? (searchData
              ? `No master-contract matches for "${q}" — run Master Contracts sync in Admin if the broker list is stale.`
              : 'Searching master contracts…')
            : tab === 'watch' ? 'No starred symbols — tap the star on any row.'
            : isUserTab ? 'Empty tab — tap the star on any row to add symbols here.'
            : tab === 'fno' ? 'No F&O contracts — sync master contracts in Admin.'
            : 'No symbols. Sync master contracts in Admin.'}
          </div>
        )}
      </div>
    </div>
  )
}

function starBtn(starred: boolean, onStar: () => void, title?: string) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onStar() }}
      title={title ?? (starred ? 'Remove from Watch tab' : 'Star → Watch tab')}
      className={`p-0.5 rounded shrink-0 ${starred ? 'text-[#e0a63f]' : 'text-muted-foreground/40 hover:text-[#e0a63f]'}`}
    >
      <Star className="h-3 w-3" fill={starred ? 'currentColor' : 'none'} />
    </button>
  )
}

/** Generic symbol row — LTP + change pts/% + day H/L. */
function SymbolRowItem({ row, tick, active, starred, onStar, onOpen, fallbackLtp }: {
  row: SymbolRow
  tick?: Tick
  active: boolean
  starred: boolean
  onStar: () => void
  onOpen: () => void
  fallbackLtp?: number
}) {
  const ltp = tick?.ltp ?? fallbackLtp ?? row.basePrice ?? 0
  const prev = tick?.prevClose ?? 0
  const chg = tick && prev ? ltp - prev : 0
  const chgPct = tick && prev ? (chg / prev) * 100 : 0
  const up = tick ? chg >= 0 : true
  return (
    <div
      onClick={onOpen}
      className={`w-full px-2 py-1.5 flex items-center justify-between text-left border-l-2 cursor-pointer transition-colors ${
        active ? 'border-[#e0a63f] bg-accent' : 'border-transparent hover:bg-secondary/50'
      }`}
    >
      <div className="min-w-0">
        <div className="text-[11px] font-medium truncate">{row.symbol}</div>
        <div className="text-[9px] text-muted-foreground">
          {row.exchange} · {row.instrumentType}{row.instrumentType === 'EQ' || row.instrumentType === 'COMM' || row.instrumentType === 'CUR' ? ` · L${row.lotSize}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <div className="text-right tabular">
          <div className={`text-[11px] ${tick ? (ltp >= (prev || ltp) ? 'term-up' : 'term-down') : ''}`}>
            {ltp ? ltp.toFixed(2) : '—'}
          </div>
          <div className={`text-[9px] ${up ? 'term-up' : 'term-down'}`}>
            {tick ? `${up ? '+' : ''}${chg.toFixed(2)} (${chgPct.toFixed(2)}%)` : '—'}
            {tick?.high ? <span className="text-muted-foreground"> · {tick.high.toFixed(0)}/{tick.low.toFixed(0)}</span> : null}
          </div>
        </div>
        <DepthAddIcon symbol={row.symbol} />
        {starBtn(starred, onStar)}
      </div>
    </div>
  )
}

/** FNO tab row — exchange badge + latest expiry + contract count. */
function FnoRowItem({ row, active, starred, onStar, onOpen }: {
  row: { symbol: string; name: string; exchange: string; lotSize: number; ltp: number; chgPct: number; high: number; low: number; fno: boolean; exp?: string | null; contracts?: number }
  active: boolean
  starred: boolean
  onStar: () => void
  onOpen: () => void
}) {
  return (
    <div
      onClick={onOpen}
      className={`w-full px-2 py-1.5 flex items-center justify-between text-left border-l-2 cursor-pointer transition-colors ${
        active ? 'border-[#e0a63f] bg-accent' : 'border-transparent hover:bg-secondary/50'
      }`}
      title={`${row.name} · lot ${row.lotSize} — click to open its workspace`}
    >
      <div className="min-w-0">
        <div className="text-[11px] font-medium truncate flex items-center gap-1">
          {row.symbol}
          <span className="text-[7px] px-1 rounded bg-secondary/80 text-muted-foreground">{row.exchange}</span>
        </div>
        <div className="text-[9px] text-muted-foreground truncate">
          {row.exp ? `${row.exp} · ${row.contracts ?? 0} strikes · L${row.lotSize}` : `L${row.lotSize}`}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <div className="text-right tabular">
          <div className={`text-[11px] ${row.chgPct >= 0 ? 'term-up' : 'term-down'}`}>{row.ltp ? row.ltp.toFixed(2) : '—'}</div>
          <div className={`text-[9px] ${row.chgPct >= 0 ? 'term-up' : 'term-down'}`}>
            {row.ltp ? `${row.chgPct >= 0 ? '+' : ''}${row.chgPct.toFixed(2)}%` : '—'}
          </div>
        </div>
        <DepthAddIcon symbol={row.symbol} />
        {starBtn(starred, onStar)}
      </div>
    </div>
  )
}

function IndexRow({ symbol, name, lotSize, tick, active, starred, onStar, onOpen, onOpenSymbol, expanded, onToggle }: {
  symbol: string
  name: string
  lotSize: number
  tick?: Tick
  active: boolean
  starred: boolean
  onStar: () => void
  onOpen: () => void
  onOpenSymbol: (s: string) => void
  expanded: boolean
  onToggle: () => void
}) {
  // per-index constituent sort (pts default — biggest contributors first)
  const [constitSort, setConstitSort] = useState<{ key: ConstitSortKey; asc: boolean }>({ key: 'pts', asc: false })
  const ltp = tick?.ltp ?? 0
  const chg = tick && tick.prevClose ? ((tick.ltp - tick.prevClose) / tick.prevClose) * 100 : 0
  const up = chg >= 0
  return (
    <div className={active ? 'bg-accent/60' : ''}>
      <div
        onClick={onOpen}
        className={`w-full px-2 py-1.5 flex items-center justify-between text-left border-l-2 cursor-pointer transition-colors ${
          active ? 'border-[#e0a63f]' : 'border-transparent hover:bg-secondary/50'
        }`}
      >
        <div className="flex items-center gap-1 min-w-0">
          <button
            onClick={e => { e.stopPropagation(); onToggle() }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground shrink-0"
            title={`${expanded ? 'Hide' : 'Show'} ${symbol} constituents`}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold truncate">{symbol}</div>
            <div className="text-[9px] text-muted-foreground truncate">{name} · L{lotSize}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="text-right tabular">
            <div className={`text-[11px] ${tick ? (tick.ltp >= (tick.prevClose || tick.ltp) ? 'term-up' : 'term-down') : ''}`}>
              {ltp ? ltp.toFixed(2) : '—'}
            </div>
            <div className={`text-[9px] ${up ? 'term-up' : 'term-down'}`}>
              {tick ? `${up ? '+' : ''}${chg.toFixed(2)}%` : '—'}
            </div>
          </div>
          {starBtn(starred, onStar)}
          <DepthAddIcon symbol={symbol} />
        </div>
      </div>
      {expanded && (
        <>
          <div className="flex items-center justify-end gap-0.5 px-2.5 pb-0.5">
            <span className="text-[8px] text-muted-foreground mr-auto">sort</span>
            {([['pts', 'pts'], ['sym', 'sym'], ['ltp', 'LTP'], ['chg', 'chg%'], ['vol', 'vol']] as [ConstitSortKey, string][]).map(([k, lbl]) => (
              <button
                key={k}
                onClick={() => { if (k === constitSort.key) setConstitSort(s => ({ ...s, asc: !s.asc })); else setConstitSort({ key: k, asc: k === 'sym' }) }}
                className={`px-1 py-0.5 rounded text-[8px] ${constitSort.key === k ? 'bg-primary/25 text-foreground' : 'bg-secondary/60 text-muted-foreground hover:text-foreground'}`}
              >{lbl}{constitSort.key === k ? (constitSort.asc ? '↑' : '↓') : ''}</button>
            ))}
          </div>
          <ConstituentList symbol={symbol} onOpenSymbol={onOpenSymbol} sort={constitSort} />
        </>
      )}
    </div>
  )
}

/** Constituents of an expanded index: H / LTP / L / Vol / chg% / +pts contribution
 *  + user sorting (pts / symbol / LTP / chg% / vol). */
function ConstituentList({ symbol, onOpenSymbol, sort }: { symbol: string; onOpenSymbol: (s: string) => void; sort: { key: ConstitSortKey; asc: boolean } }) {
  // realtime via sync:index (2s) — REST fallback when the hub has no payload yet
  const sync = useSyncData<IndexComponentsResp>(
    'sync:index',
    d => !!d && (d as { index?: { symbol?: string } }).index?.symbol === symbol,
    { index: [symbol] },
  )
  const { data: rest, isLoading, error } = useQuery({
    queryKey: ['index-components', symbol],
    queryFn: () => api.indexComponents(symbol),
    enabled: !sync,
    refetchInterval: 5000,
    retry: false,
  })
  const data = sync ?? rest

  const rows: (IndexComponentRow & { key: string })[] = useMemo(
    () => (data?.constituents ?? []).map(c => ({ ...c, key: c.symbol })),
    [data],
  )
  const sorted = useMemo(() => {
    const val = (c: IndexComponentRow & { key: string }): number | string => {
      switch (sort.key) {
        case 'sym': return c.symbol
        case 'ltp': return c.ltp
        case 'chg': return c.chgPct
        case 'vol': return c.vol ?? 0
        default: return c.pts
      }
    }
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b)
      const cmp = typeof va === 'string' || typeof vb === 'string'
        ? String(va).localeCompare(String(vb))
        : (va as number) - (vb as number)
      return sort.asc ? cmp : -cmp
    })
  }, [rows, sort])

  if (isLoading) return <div className="px-6 py-2 text-[9px] text-muted-foreground">loading constituents…</div>
  if (error || !data) return <div className="px-6 py-2 text-[9px] text-muted-foreground">constituents unavailable</div>

  return (
    <div className="bg-[#0b0e11]/60 border-y border-border/60 py-1">
      <div className="flex items-center justify-between px-2.5 pb-1 text-[8px] uppercase tracking-wide text-muted-foreground">
        <span>contribution · Σ {data.totalPts >= 0 ? '+' : ''}{data.totalPts.toFixed(1)} pts</span>
        <span>H LTP L Vol chg%</span>
      </div>
      {sorted.map(c => {
        const up = c.chgPct >= 0
        return (
          <div
            key={c.key}
            onClick={() => onOpenSymbol(c.symbol)}
            className="px-2.5 py-1 flex items-center justify-between text-[10px] cursor-pointer hover:bg-secondary/40"
            title={`${c.symbol} — weight ${c.weight}% · click to open its workspace`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`tabular text-[9px] w-10 shrink-0 ${c.pts >= 0 ? 'term-up' : 'term-down'}`}>
                {c.pts >= 0 ? '+' : ''}{c.pts.toFixed(1)}
              </span>
              <span className="font-medium truncate">{c.symbol}</span>
              <span className="text-[8px] text-muted-foreground shrink-0">{c.weight}%</span>
            </div>
            <div className="flex items-center gap-2 tabular shrink-0 text-[9px]">
              <span className="text-muted-foreground">{fmtMoney(c.high, 0)}</span>
              <span className={`font-semibold ${up ? 'term-up' : 'term-down'}`}>{fmtMoney(c.ltp, 1)}</span>
              <span className="text-muted-foreground">{fmtMoney(c.low, 0)}</span>
              <span className="text-muted-foreground w-10 text-right">{fmtVolShort(c.vol)}</span>
              <span className={`w-12 text-right ${up ? 'term-up' : 'term-down'}`}>{up ? '+' : ''}{c.chgPct.toFixed(2)}%</span>
              <DepthAddIcon symbol={c.symbol} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function fmtVol(v: number): string {
  if (v >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`
  if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(Math.round(v))
}
function fmtVolShort(v: number): string {
  return fmtVol(v)
}

// ------------------------------------------------------------
// Depth panel stack (bottom-left dock).
// N market-depth panels stacked top-to-bottom:
//  · [+] adds a depth panel for the currently selected symbol
//  · X removes a panel
//  · drag the top edge of a panel to adjust its height
//  · the stack scrolls when panels exceed the space, so the
//    watchlist (search panel) above shrinks as depth grows
//  · quantity renders in LOTS when the instrument has a lot size,
//    otherwise raw shares
// ------------------------------------------------------------

const DEPTH_MIN_H = 96
const DEPTH_MAX_H = 460

export function DepthStack({ ws }: { ws: WorkspaceCfg }) {
  const patchWs = useTerminal(s => s.patchWs)
  const selectedSymbol = useTerminal(s => s.selectedSymbol)
  // persisted cfg; fall back to a single panel for the workspace symbol
  const panels: DepthPanelCfg[] = ws.depthPanels ?? defaultDepthPanels(ws.symbol)

  const setPanels = (next: DepthPanelCfg[]) => patchWs(ws.id, { depthPanels: next })

  const addPanel = () => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id) ?? ws
    const sym = selectedSymbol || ws.symbol
    const { patch, error } = addDepthPanelTo(cur, sym)
    if (error) { toast.info(error); return }
    setPanels(patch.depthPanels!)
  }

  const removePanel = (id: string) => setPanels(panels.filter(p => p.id !== id))

  const resizePanel = (id: string, height: number) =>
    setPanels(panels.map(p => (p.id === id ? { ...p, height } : p)))

  return (
    <div className="border-t border-border flex flex-col min-h-0 max-h-[72%] shrink-0">
      <div className="flex items-center gap-1 px-2 py-1 bg-card/30 shrink-0">
        <Layers className="h-3 w-3 text-muted-foreground" />
        <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Depth</span>
        <span className="text-[9px] text-muted-foreground">{panels.length}</span>
        <div className="flex-1" />
        <button
          onClick={addPanel}
          title={`Add depth panel for ${selectedSymbol || ws.symbol}`}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
      <div className="overflow-y-auto min-h-0">
        {panels.map(p => (
          <DepthPanel key={p.id} cfg={p} onRemove={() => removePanel(p.id)} onResize={h => resizePanel(p.id, h)} />
        ))}
      </div>
    </div>
  )
}

function DepthPanel({ cfg, onRemove, onResize }: {
  cfg: DepthPanelCfg
  onRemove: () => void
  onResize: (height: number) => void
}) {
  const symbol = cfg.symbol
  const [height, setHeight] = useState(cfg.height)
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof api.quote>> | null>(null)
  const [ltp, setLtp] = useState(0)
  const [prev, setPrev] = useState(0)
  const dragRef = useRef<{ startY: number; startH: number; h: number } | null>(null)

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resize commit
  useEffect(() => setHeight(cfg.height), [cfg.height])

  // feed-source switch → drop the cached quote book (sim data must not linger)
  const dataEpoch = useTerminal(s => s.dataEpoch)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- feed-source purge
  useEffect(() => { setQuote(null); setLtp(0); setPrev(0) }, [dataEpoch])

  useEffect(() => {
    let dead = false
    const pull = async () => {
      try {
        const q = await api.quote(symbol)
        if (!dead) setQuote(q)
      } catch { /* live source may not feed this symbol yet — keep it blank */ }
    }
    pull()
    const iv = setInterval(pull, 4000)
    return () => { dead = true; clearInterval(iv) }
  }, [symbol, dataEpoch])

  useEffect(() => onTicks(map => {
    const t = map[symbol]
    if (t) { setLtp(t.ltp); setPrev(t.prevClose) }
  }), [symbol])

  // drag the top edge to resize (local during drag, committed on release)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height, h: height }
    const move = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const next = Math.max(DEPTH_MIN_H, Math.min(DEPTH_MAX_H, Math.round(d.startH + (d.startY - ev.clientY))))
      d.h = next
      setHeight(next)
    }
    const up = () => {
      const d = dragRef.current
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (d && d.h !== d.startH) onResize(d.h)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const chg = ltp && prev ? ltp - prev : 0
  const chgPct = ltp && prev ? (chg / prev) * 100 : 0
  const up = chg >= 0
  const lotSize = quote?.lotSize ?? 1
  const inLots = lotSize > 1
  const qtyLabel = inLots ? 'LOT' : 'QTY'
  const fmtQty = (qty: number) => (inLots ? (qty / lotSize).toFixed(inLots && qty / lotSize < 10 ? 1 : 0) : String(qty))

  return (
    <div className="border-b border-border/60" style={{ height }} data-depth-panel={symbol}>
      {/* resize handle (top edge) */}
      <div
        onMouseDown={startResize}
        title="Drag to resize this depth panel"
        className="h-2 flex items-center justify-center cursor-row-resize text-muted-foreground/40 hover:text-muted-foreground hover:bg-secondary/40"
      >
        <GripHorizontal className="h-2.5 w-2.5" />
      </div>
      <div className="px-2 pb-1.5 space-y-1.5 flex flex-col h-[calc(100%-8px)]">
        <div className="flex items-center justify-between shrink-0">
          <div className="text-[11px] font-semibold truncate">
            {symbol}
            {inLots && <span className="ml-1 text-[8px] text-muted-foreground font-normal">L{lotSize}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="text-right">
              <div className={`text-xs font-bold tabular leading-none ${up ? 'term-up' : 'term-down'}`}>{ltp ? ltp.toFixed(2) : quote?.ltp?.toFixed(2) ?? '—'}</div>
              <div className={`text-[9px] tabular ${up ? 'term-up' : 'term-down'}`}>
                {ltp ? `${up ? '+' : ''}${chg.toFixed(2)} (${chgPct.toFixed(2)}%)` : ''}
              </div>
            </div>
            <button onClick={onRemove} title="Remove this depth panel" className="p-0.5 rounded text-muted-foreground hover:text-[#ff4d5e]">
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1 text-[10px] tabular shrink-0">
          <div className="bg-up rounded px-1.5 py-0.5 flex justify-between">
            <span className="text-muted-foreground">Bid</span>
            <span className="term-up">{quote?.bid?.toFixed(2) ?? '—'}</span>
          </div>
          <div className="bg-down rounded px-1.5 py-0.5 flex justify-between">
            <span className="text-muted-foreground">Ask</span>
            <span className="term-down">{quote?.ask?.toFixed(2) ?? '—'}</span>
          </div>
        </div>
        {quote?.depth && (
          <div className="grid grid-cols-2 gap-x-3 text-[10px] tabular flex-1 min-h-0 overflow-hidden">
            <div>
              <div className="text-muted-foreground text-[9px] mb-0.5 flex justify-between"><span>BID</span><span>{qtyLabel}</span></div>
              {quote.depth.buys.slice(0, 5).map((b, i) => (
                <div key={i} className="flex justify-between py-[1px]">
                  <span className="term-up">{b.price.toFixed(2)}</span>
                  <span className="text-muted-foreground">{fmtQty(b.qty)}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-muted-foreground text-[9px] mb-0.5 flex justify-between"><span>ASK</span><span>{qtyLabel}</span></div>
              {quote.depth.sells.slice(0, 5).map((b, i) => (
                <div key={i} className="flex justify-between py-[1px]">
                  <span className="term-down">{b.price.toFixed(2)}</span>
                  <span className="text-muted-foreground">{fmtQty(b.qty)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
