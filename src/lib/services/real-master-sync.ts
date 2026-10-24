// @ts-nocheck
import { fetchCached, squash, parseCsvLine, isoExpiry, normStrike } from './scrip-master'
import { istToday } from './symbol-service'

// ============================================================
// REAL MASTER CONTRACTS — the symbol universe is built from the
// brokers' actual public master files, NOT generated:
//
//   DHAN    https://images.dhan.co/api-scrip-master.csv
//           (~26MB, all NSE/BSE/MCX segments + securityIds)
//   SHOONYA https://api.shoonya.com/{NSE,NFO,BSE,BFO,MCX,CDS}_symbols.txt.zip
//           (Noren trading symbols + tokens)
//
// Round-13: "Sync now" previously produced a hardcoded demo universe
// (849 synthetic symbols). It now imports the REAL tradable contracts
// — every NSE equity, index, NFO future & option (real strikes,
// expiries, lot sizes), BFO index derivatives, MCX commodities and
// CDS derivatives — and writes exact broker tokens per mapping:
//   DHAN    securityId straight from the same CSV row (exact match)
//   SHOONYA EXCH|tsym from the Noren files (keyed match)
//   ICICI   symbolic UNDERLYING|expiry|strike|CE/PE (Breeze is
//           symbol-driven — expanded per request by breezeInstrumentParams)
//
// SINGLE-PASS STREAMING: the files are parsed line-by-line and each
// row feeds the universe builder AND the token index at once, then is
// dropped — peak memory stays ~500MB instead of the 1.3GB+ double
// parse that OOM-killed the first implementation.
//
// If BOTH sources fail the sync FAILS LOUDLY (no synthetic fallback —
// the terminal must never pretend generated symbols are real).
// ============================================================

export interface RealMasterRow {
  symbol: string
  name: string
  exchange: string // NSE | NFO | BSE | BFO | MCX | CDS
  instrumentType: string // INDEX | EQ | FUT | CE | PE
  expiry?: string
  strike?: number
  optionType?: string
  lotSize: number
  tickSize: number
  underlying?: string
}

export interface RealIngestResult {
  rows: RealMasterRow[]
  stats: { label: string; count: number }[]
  notes: string[]
  sources: string[]
  /** EXACT broker-token lookup tables, keyed like masterMappingKey() */
  dhanTokens: Map<string, { securityId: string; tradingSymbol: string; smstSymbol: string }>
  shoonyaTokens: Map<string, { exch: string; tsym: string }>
}

// --- helpers -------------------------------------------------

const compact = (exp: string): string => exp.replaceAll('-', '')

function fmtStrike(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}

function lotOf(raw: string | undefined): number {
  const n = Math.round(Number(raw ?? '1'))
  return Number.isFinite(n) && n > 0 ? n : 1
}

function tickOf(raw: string | undefined): number {
  const n = Number(raw ?? '')
  return Number.isFinite(n) && n > 0 ? n : 0.05
}

/** sane tradable symbol — kills test instruments and odd junk rows */
function symbolOk(s: string): boolean {
  return s.length > 0 && s.length <= 60 && /^[A-Z0-9&\-\.]+$/.test(s) && !s.includes('TEST')
}

/** Breeze/Noren-style normalized exchange from a Dhan (exchange, segment) pair */
function dhanExchange(exch: string, segment: string): string | null {
  if (exch === 'NSE') {
    if (segment === 'E' || segment === 'I') return 'NSE'
    if (segment === 'D') return 'NFO'
    if (segment === 'C') return 'CDS'
    if (segment === 'M') return 'MCX' // NSE commodity derivatives
    return null
  }
  if (exch === 'BSE') {
    if (segment === 'I') return 'BSE'
    if (segment === 'D') return 'BFO'
    if (segment === 'E') return 'BSE'
    return null
  }
  if (exch === 'MCX') return 'MCX'
  return null
}

// universe scope (kept tradable-sized):
//   ALL NSE equities + indices, ALL NFO futures + options, BFO index
//   derivatives (SENSEX/BANKEX/SENSEX50), MCX futures + options,
//   CDS futures + options. BSE equity/stock-derivatives are mirrors of NSE.
const BFO_UNDERLYINGS = new Set(['SENSEX', 'BANKEX', 'SENSEX50'])
const EQ_SERIES = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST'])
const MAX_OPT_EXPIRIES_IDX = 12 // NIFTY weeklies + monthlies out to ~1y
const MAX_OPT_EXPIRIES_STK = 6
const MAX_OPT_EXPIRIES_MCX = 8
const MAX_FUT_EXPIRIES = 12
const MAX_EXPIRY_DAYS = 400 // drop the 2036 junk rows

/** line iterator that never materializes the giant lines array */
function iterLines(text: string, cb: (line: string) => void): void {
  let start = 0
  while (start < text.length) {
    let nl = text.indexOf('\n', start)
    if (nl < 0) nl = text.length
    if (nl > start) cb(text.slice(start, nl))
    start = nl + 1
  }
}

/** per-underlying expiry trimming (keep the nearest N expiries per class) */
class ExpiryCaps {
  private seen = new Map<string, Set<string>>()
  private kept = new Map<string, Set<string>>()
  allow(und: string, cls: string, exp: string, cap: number): boolean {
    const key = `${und}|${cls}`
    let s = this.seen.get(key)
    if (!s) { s = new Set(); this.seen.set(key, s) }
    s.add(exp)
    let k = this.kept.get(key)
    if (!k) {
      k = new Set([...s].sort().slice(0, cap))
      this.kept.set(key, k)
    }
    return k.has(exp)
  }
  /** fut variant mutates the seen set (rows arrive expiry-ordered per file) */
  allowFut(und: string, exch: string, exp: string, cap: number): boolean {
    const key = `${und}|${exch}FUT`
    let s = this.seen.get(key)
    if (!s) { s = new Set(); this.seen.set(key, s) }
    s.add(exp)
    return [...s].sort().indexOf(exp) < cap
  }
}

/**
 * ONE PASS over both master files: builds the real universe AND the exact
 * broker-token indexes together. Throws only when BOTH sources fail.
 */
export async function ingestRealMasters(): Promise<RealIngestResult> {
  const today = istToday()
  const maxDate = new Date(Date.parse(today) + MAX_EXPIRY_DAYS * 86400_000).toISOString().slice(0, 10)
  const notes: string[] = []
  const sources: string[] = []
  const stats: { label: string; count: number }[] = []
  const caps = new ExpiryCaps()

  const out = new Map<string, RealMasterRow>() // symbol|exchange → row
  const push = (r: RealMasterRow): boolean => {
    if (!symbolOk(r.symbol)) return false
    const key = `${r.symbol}|${r.exchange}`
    if (out.has(key)) return false
    out.set(key, r)
    return true
  }
  const expOk = (e: string | undefined): boolean => !!e && e >= today && e <= maxDate

  const dhanTokens = new Map<string, { securityId: string; tradingSymbol: string; smstSymbol: string }>()
  const shoonyaTokens = new Map<string, { exch: string; tsym: string }>()
  const putDhan = (key: string, securityId: string, tradingSymbol: string, smstSymbol: string): void => {
    if (key && securityId && !dhanTokens.has(key)) dhanTokens.set(key, { securityId, tradingSymbol, smstSymbol })
  }
  const putShoonya = (key: string, exch: string, tsym: string): void => {
    if (key && tsym && !shoonyaTokens.has(key)) shoonyaTokens.set(key, { exch, tsym })
  }

  // ---------- DHAN (primary — securityId + names) ----------
  const dhanCsv = await fetchCached('https://images.dhan.co/api-data/api-scrip-master.csv', 'dhan-scrip-master.csv')
  if (dhanCsv) sources.push('Dhan api-scrip-master.csv')
  else notes.push('Dhan scrip master unavailable')
  let dhanParsed = 0

  if (dhanCsv) {
    let header: string[] | null = null
    let iExch = -1, iSeg = -1, iSec = -1, iCustom = -1, iExp = -1, iStrike = -1, iOpt = -1, iInst = -1, iTrade = -1, iSeries = -1, iLot = -1, iTick = -1, iName = -1
    iterLines(dhanCsv, line => {
      if (!header) {
        header = parseCsvLine(line).map(h => h.trim())
        const col = (n: string): number => header!.indexOf(n)
        iExch = col('SEM_EXM_EXCH_ID'); iSeg = col('SEM_SEGMENT'); iSec = col('SEM_SMST_SECURITY_ID')
        iCustom = col('SEM_CUSTOM_SYMBOL'); iExp = col('SEM_EXPIRY_DATE'); iStrike = col('SEM_STRIKE_PRICE')
        iOpt = col('SEM_OPTION_TYPE'); iInst = col('SEM_INSTRUMENT_NAME'); iTrade = col('SEM_TRADING_SYMBOL')
        iSeries = col('SEM_SERIES'); iLot = col('SEM_LOT_UNITS'); iTick = col('SEM_TICK_SIZE'); iName = col('SM_SYMBOL_NAME')
        if (iSec < 0 || iTrade < 0) { notes.push('Dhan csv: SEM columns not found'); header = null }
        return
      }
      if (line.length < 10) return
      const c = parseCsvLine(line)
      const exchRaw = c[iExch] ?? '', seg = c[iSeg] ?? '', inst = (c[iInst] ?? '').trim().toUpperCase()
      const exch = dhanExchange(exchRaw, seg)
      const securityId = c[iSec] ?? ''
      if (!exch || !securityId) return
      dhanParsed++
      const trade = c[iTrade] ?? ''
      const expiry = isoExpiry(c[iExp] ?? '')
      const und = squash(inst === 'EQUITY' || inst === 'INDEX' ? trade : trade.split('-')[0])

      // token index entry (keyed exactly like masterMappingKey)
      if (inst === 'EQUITY') putDhan(`${exch}|${und}|EQ`, securityId, trade, c[iCustom] ?? '')
      else if (inst === 'INDEX') putDhan(`${exch}|${und}|INDEX`, securityId, trade, c[iCustom] ?? '')
      else if (inst.startsWith('FUT') && expiry) putDhan(`${exch}|${und}|FUT|${expiry}`, securityId, trade, c[iCustom] ?? '')
      else if (inst.startsWith('OPT') && expiry) putDhan(`${exch}|${und}|OPT|${expiry}|${normStrikeKey(c[iStrike] ?? '')}|${(c[iOpt] ?? '').trim().toUpperCase()}`, securityId, trade, c[iCustom] ?? '')

      // ---- universe row ----
      if (exch === 'NSE' && seg === 'E' && inst === 'EQUITY') {
        if (!EQ_SERIES.has((c[iSeries] ?? '').toUpperCase())) return
        const sym = trade.toUpperCase()
        push({
          symbol: sym,
          name: (c[iName] ?? '') || (c[iCustom] ?? '') || sym,
          exchange: 'NSE', instrumentType: 'EQ',
          lotSize: 1, tickSize: tickOf(c[iTick]),
        })
        return
      }
      if ((exch === 'NSE' || exch === 'BSE') && seg === 'I' && inst === 'INDEX') {
        const sym = squash(trade)
        push({
          symbol: sym,
          name: (c[iCustom] ?? '') || sym,
          exchange: exch === 'BSE' ? 'BSE' : 'NSE', instrumentType: 'INDEX',
          lotSize: 1, tickSize: tickOf(c[iTick]),
        })
        return
      }
      if (inst === 'FUTIDX' || inst === 'FUTSTK' || inst === 'FUTCOM' || inst === 'FUTCUR') {
        if (!expOk(expiry)) return
        if (exch === 'BFO') return // BSE futures mirror NFO — skip for volume
        if (!und) return
        if (!caps.allowFut(und, exch, expiry, MAX_FUT_EXPIRIES)) return
        push({
          symbol: `${und}${compact(expiry)}FUT`,
          name: `${und} ${expiry} Fut`,
          exchange: exch, instrumentType: 'FUT', expiry,
          lotSize: lotOf(c[iLot]), tickSize: tickOf(c[iTick]), underlying: und,
        })
        return
      }
      if (inst === 'OPTIDX' || inst === 'OPTSTK' || inst === 'OPTFUT') {
        if (!expOk(expiry)) return
        const opt = (c[iOpt] ?? '').trim().toUpperCase()
        if (!und || (opt !== 'CE' && opt !== 'PE')) return
        if (exch === 'BFO' && !BFO_UNDERLYINGS.has(und)) return
        if (exch === 'MCX' && !caps.allow(und, 'MCXOPT', expiry, MAX_OPT_EXPIRIES_MCX)) return
        if (exch === 'NFO' && !caps.allow(und, inst === 'OPTIDX' ? 'IDXOPT' : 'STKOPT', expiry, inst === 'OPTIDX' ? MAX_OPT_EXPIRIES_IDX : MAX_OPT_EXPIRIES_STK)) return
        const strike = Number(c[iStrike] ?? '')
        if (!Number.isFinite(strike) || strike <= 0) return
        push({
          symbol: `${und}${compact(expiry)}${fmtStrike(strike)}${opt}`,
          name: (c[iCustom] ?? '') || `${und} ${strike} ${opt} ${expiry}`,
          exchange: exch, instrumentType: opt, expiry,
          strike, optionType: opt,
          lotSize: lotOf(c[iLot]), tickSize: tickOf(c[iTick]), underlying: und,
        })
        return
      }
    })
    stats.push({ label: 'Dhan rows parsed', count: dhanParsed })
  }

  // ---------- SHOONYA / Noren (tokens + fill-in universe rows) ----------
  const SHOONYA_FILES: [string, string][] = [
    ['NSE', 'shoonya-NSE.txt'], ['NFO', 'shoonya-NFO.txt'], ['BSE', 'shoonya-BSE.txt'],
    ['BFO', 'shoonya-BFO.txt'], ['MCX', 'shoonya-MCX.txt'], ['CDS', 'shoonya-CDS.txt'],
  ]
  const shoonyaTexts = await Promise.all(SHOONYA_FILES.map(async ([exch, file]) => ({
    exch, txt: await fetchCached(`https://api.shoonya.com/${exch}_symbols.txt.zip`, file),
  })))
  let shoonyaParsed = 0
  let shoonyaAdded = 0

  for (const { exch: fallbackExch, txt } of shoonyaTexts) {
    if (!txt) continue
    let header: string[] | null = null
    let cExch = -1, cTok = -1, cLot = -1, cSym = -1, cTrade = -1, cExp = -1, cInst = -1, cOpt = -1, cStrike = -1, cTick = -1
    iterLines(txt, line => {
      const raw = line.trim()
      if (!header) {
        header = raw.replace(/,+$/, '').split(',').map(h => h.trim().toUpperCase())
        if (!header.includes('EXCHANGE')) { header = null } // not a Noren file
        const ci = (n: string): number => (header ?? []).indexOf(n)
        cExch = ci('EXCHANGE'); cTok = ci('TOKEN'); cLot = ci('LOTSIZE'); cSym = ci('SYMBOL')
        cTrade = ci('TRADINGSYMBOL'); cExp = ci('EXPIRY'); cInst = ci('INSTRUMENT')
        cOpt = ci('OPTIONTYPE'); cStrike = ci('STRIKEPRICE'); cTick = ci('TICKSIZE')
        return
      }
      if (!raw) return
      const c = raw.replace(/,+$/, '').split(',')
      if (c.length < 5) return
      const exch = (c[cExch] ?? fallbackExch).trim().toUpperCase()
      if (!['NSE', 'NFO', 'BSE', 'BFO', 'MCX', 'CDS'].includes(exch)) return
      const inst = (cInst >= 0 ? (c[cInst] ?? '') : '').trim().toUpperCase()
      const trade = (c[cTrade] ?? '').trim()
      if (!trade) return
      const expiry = isoExpiry(cExp >= 0 ? (c[cExp] ?? '') : '')
      const token = (c[cTok] ?? '').trim()
      shoonyaParsed++

      // token index — index under BOTH the bare underlying and the tsym root
      const tsymRoot = squash(trade.split('-')[0])
      const undList = [...new Set([squash(c[cSym] ?? ''), tsymRoot].filter(Boolean))]
      for (const und of undList) {
        if (inst === 'EQ') putShoonya(`${exch}|${und}|EQ`, exch, trade)
        else if (inst === 'INDEX') putShoonya(`${exch}|${und}|INDEX`, exch, trade)
        else if (inst.startsWith('FUT') && expiry) putShoonya(`${exch}|${und}|FUT|${expiry}`, exch, trade)
        else if (inst.startsWith('OPT') && expiry) putShoonya(`${exch}|${und}|OPT|${expiry}|${normStrikeKey(cStrike >= 0 ? (c[cStrike] ?? '') : '')}|${(cOpt >= 0 ? (c[cOpt] ?? '') : '').trim().toUpperCase()}`, exch, trade)
      }

      // ---- fill-in universe rows (only when Dhan did not already add) ----
      const sym0 = (c[cSym] ?? '').trim()
      if (inst === 'EQ') {
        const sym = (sym0 || trade.replace(/-EQ$/, '')).toUpperCase()
        shoonyaAdded += push({
          symbol: sym, name: sym,
          exchange: exch === 'BSE' ? 'BSE' : 'NSE', instrumentType: 'EQ',
          lotSize: lotOf(c[cLot]), tickSize: tickOf(c[cTick]),
        }) ? 1 : 0
        return
      }
      if (inst === 'INDEX') {
        const sym = squash(trade)
        shoonyaAdded += push({
          symbol: sym, name: trade,
          exchange: exch === 'BSE' ? 'BSE' : 'NSE', instrumentType: 'INDEX',
          lotSize: 1, tickSize: tickOf(c[cTick]),
        }) ? 1 : 0
        return
      }
      if (inst.startsWith('FUT')) {
        if (!expOk(expiry)) return
        if (exch === 'BFO') return
        const und = (sym0 || trade.split('-')[0] || '').toUpperCase()
        if (!und) return
        if (!caps.allowFut(und, exch, expiry, MAX_FUT_EXPIRIES)) return
        shoonyaAdded += push({
          symbol: `${und}${compact(expiry)}FUT`,
          name: `${und} ${expiry} Fut`,
          exchange: exch, instrumentType: 'FUT', expiry,
          lotSize: lotOf(c[cLot]), tickSize: tickOf(c[cTick]), underlying: und,
        }) ? 1 : 0
        return
      }
      if (inst.startsWith('OPT')) {
        if (!expOk(expiry)) return
        const und = (sym0 || trade.split('-')[0] || '').toUpperCase()
        const opt = (cOpt >= 0 ? (c[cOpt] ?? '') : '').trim().toUpperCase()
        if (!und || (opt !== 'CE' && opt !== 'PE')) return
        if (exch === 'BFO' && !BFO_UNDERLYINGS.has(und)) return
        if (exch === 'MCX' && !caps.allow(und, 'MCXOPT', expiry, MAX_OPT_EXPIRIES_MCX)) return
        if (exch === 'NFO' && !caps.allow(und, inst === 'OPTIDX' ? 'IDXOPT' : 'STKOPT', expiry, inst === 'OPTIDX' ? MAX_OPT_EXPIRIES_IDX : MAX_OPT_EXPIRIES_STK)) return
        const strike = Number(cStrike >= 0 ? (c[cStrike] ?? '') : '')
        if (!Number.isFinite(strike) || strike <= 0) return
        shoonyaAdded += push({
          symbol: `${und}${compact(expiry)}${fmtStrike(strike)}${opt}`,
          name: `${und} ${strike} ${opt} ${expiry}`,
          exchange: exch, instrumentType: opt, expiry,
          strike, optionType: opt,
          lotSize: lotOf(c[cLot]), tickSize: tickOf(c[cTick]), underlying: und,
        }) ? 1 : 0
        return
      }
    })
  }
  if (shoonyaParsed > 0) sources.push('Noren (Shoonya) symbols.txt masters')
  else notes.push('Shoonya scrip masters unavailable')
  stats.push({ label: 'Noren rows scanned', count: shoonyaParsed })
  stats.push({ label: 'Noren-only additions', count: shoonyaAdded })

  if (dhanParsed === 0 && shoonyaParsed === 0) {
    throw new Error('no real broker master contracts available — both the Dhan csv and the Noren symbols files failed to download/parse; fix connectivity and retry (no synthetic fallback by design)')
  }

  const rows = [...out.values()]
  const byExch: Record<string, number> = {}
  for (const r of rows) byExch[`${r.exchange} ${r.instrumentType}`] = (byExch[`${r.exchange} ${r.instrumentType}`] ?? 0) + 1
  for (const [k, v] of Object.entries(byExch).sort()) stats.push({ label: k, count: v })

  return { rows, stats, notes, sources, dhanTokens, shoonyaTokens }
}

function normStrikeKey(strike: string): string {
  const n = Number(strike)
  if (!Number.isFinite(n) || n === 0) return ''
  return fmtStrike(n)
}

/** kind of a master row for the mapping key: EQ | INDEX | FUT | OPT */
function kindOf(instrumentType: string): string {
  if (instrumentType === 'CE' || instrumentType === 'PE') return 'OPT'
  return instrumentType // EQ | INDEX | FUT
}

/** master row → mapping-key (must mirror the ingest token-index keys) */
export function masterMappingKey(m: { exchange: string; underlying?: string | null; symbol: string; instrumentType: string; expiry?: string | null; strike?: number | null; optionType?: string | null }): string {
  const kind = kindOf(m.instrumentType)
  const und = squash(m.underlying?.trim() || m.symbol)
  if (kind === 'EQ' || kind === 'INDEX') return `${m.exchange}|${und}|${kind}`
  if (kind === 'FUT') return `${m.exchange}|${und}|FUT|${(m.expiry ?? '').slice(0, 10)}`
  return `${m.exchange}|${und}|OPT|${(m.expiry ?? '').slice(0, 10)}|${m.strike != null && Number.isFinite(Number(m.strike)) ? fmtStrike(Number(m.strike)) : ''}|${m.optionType ?? ''}`
}
