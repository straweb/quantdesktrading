// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import path from 'path'
import { inflateRawSync } from 'node:zlib'
import { db } from '../db'

// ============================================================
// BROKER SCRIP-MASTER ENRICHMENT
//
// The synthetic SymbolMapping rows (mapSymbol) are not enough for
// real broker APIs:
//   · DHAN    needs the numeric SEM_SMST_SECURITY_ID (+ segment)
//   · SHOONYA needs the official Noren trading symbol (tsym)
//             e.g. NIFTY29OCT2625000CE — not our generated one
//
// This module downloads the two public master files (cached on
// disk for 12h under db/masters/), indexes them and rewrites the
// SymbolMapping rows for DHAN/SHOONYA with REAL broker tokens:
//   DHAN    https://images.dhan.co/api-data/api-scrip-master.csv
//   SHOONYA https://api.shoonya.com/{NSE,NFO,BSE,BFO,MCX,CDS}_symbols.txt.zip
//
// Every step is best-effort: a failed download keeps the existing
// (synthetic) mapping and reports the reason in the SyncLog.
// Source of the endpoints: straweb/hedging broker/{dhan,shoonya}/
// database/master_contract_db.py.
// ============================================================

const MASTERS_DIR = path.join(process.cwd(), 'db', 'masters')
const TTL_MS = 12 * 3600_000

export interface DhanRow {
  exch: string; segment: string; securityId: string; smstSymbol: string
  tradingSymbol: string; expiry: string; strike: string; optionType: string
  instrument: string; series: string; lotUnits: string
  tickSize?: string; name?: string
}

export interface ShoonyaRow {
  exch: string; token: string; lotSize: string; symbol: string
  tradingSymbol: string; expiry: string; instrument: string
  optionType: string; strike: string; tickSize: string
}

// ---------------- tiny ZIP reader (store + deflate) ----------------
function unzipFirstEntry(buf: Buffer): string | null {
  try {
    // find End Of Central Directory (scan back — comment may follow)
    let eocd = -1
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) return null
    const count = buf.readUInt16LE(eocd + 10)
    let ptr = buf.readUInt32LE(eocd + 16)
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(ptr) !== 0x02014b50) break
      const method = buf.readUInt16LE(ptr + 10)
      const compSize = buf.readUInt32LE(ptr + 20)
      const nameLen = buf.readUInt16LE(ptr + 28)
      const extraLen = buf.readUInt16LE(ptr + 30)
      const commentLen = buf.readUInt16LE(ptr + 32)
      const localOffset = buf.readUInt32LE(ptr + 42)
      const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8')
      if (name.endsWith('.txt')) {
        // local header: sig(4) ver(2) flags(2) method(2) … nameLen(2) extraLen(2) at +26/+28
        const lNameLen = buf.readUInt16LE(localOffset + 26)
        const lExtraLen = buf.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + lNameLen + lExtraLen
        const data = buf.slice(dataStart, dataStart + compSize)
        const out = method === 8 ? inflateRawSync(data) : data
        return out.toString('utf8')
      }
      ptr += 46 + nameLen + extraLen + commentLen
    }
    return null
  } catch {
    return null
  }
}

// ---------------- cached downloads ----------------
async function fetchCached(url: string, file: string, maxAgeMs = TTL_MS): Promise<string | null> {
  const fp = path.join(MASTERS_DIR, file)
  try {
    if (existsSync(fp)) {
      const age = Date.now() - statSync(fp).mtimeMs
      if (age < maxAgeMs) {
        const txt = readFileSync(fp, 'utf8')
        // guard against a previous bug that cached raw zip bytes under a .txt name
        if (!txt.startsWith('PK\u0003\u0004')) return txt
      }
    }
  } catch { /* refetch */ }
  try {
    mkdirSync(MASTERS_DIR, { recursive: true })
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000), cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    // detect the ZIP payload from the URL (cache names are normalized .txt)
    if (url.endsWith('.zip') || buf[0] === 0x50 && buf[1] === 0x4b) {
      const txt = unzipFirstEntry(buf)
      if (!txt) throw new Error('zip parse failed')
      writeFileSync(fp, txt)
      return txt
    }
    writeFileSync(fp, buf)
    return buf.toString('utf8')
  } catch (e) {
    // stale cache beats nothing (if it parses)
    try {
      if (existsSync(fp)) {
        const txt = readFileSync(fp, 'utf8')
        if (!txt.startsWith('PK\u0003\u0004')) return txt
      }
    } catch { /* ignore */ }
    console.error(`[scrip-master] ${file} download failed:`, e instanceof Error ? e.message : e)
    return null
  }
}

// ---------------- normalizers ----------------
export function isoExpiry(raw: string): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  // "2026-10-29"
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  // "29-10-2026" (Dhan DD-MM-YYYY)
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})/.exec(s)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  // "29-Oct-2026" (Noren)
  const mons = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s)
  if (m) {
    const mi = mons.indexOf(m[2].toLowerCase())
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  return ''
}

export function normStrike(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n) || n === 0) return ''
  return Number.isInteger(n) ? String(n) : String(n)
}

export function squash(s: string): string {
  return (s ?? '').replace(/[\s_\-]/g, '').toUpperCase()
}

export { fetchCached }

// ---------------- minimal CSV line parser (quoted fields) ----------------
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

// ---------------- DHAN index ----------------
// CSV header (api-scrip-master.csv):
//   SEM_EXM_EXCH_ID, SEM_SEGMENT, SEM_SMST_SECURITY_ID, SEM_INSTRUMENT_NAME,
//   SEM_EXPIRY_CODE, SEM_TRADING_SYMBOL, SEM_LOT_UNITS, SEM_CUSTOM_SYMBOL,
//   SEM_EXPIRY_DATE, SEM_STRIKE_PRICE, SEM_OPTION_TYPE, SEM_TICK_SIZE, ...
// TRADING_SYMBOL shapes: "RELIANCE" (EQ) · "NIFTY" (INDEX) ·
//   "NIFTY-29Oct2026-25500-CE" (weekly opt) · "BANKNIFTY-Dec2026-69400-CE"
//   (monthly opt) · "SENSEX-Nov2026-FUT" (fut)
export async function loadDhanIndex(): Promise<Map<string, DhanRow[]> | null> {
  const rows = await loadDhanRows()
  if (!rows) return null
  const idx = new Map<string, DhanRow[]>()
  const addKey = (k: string, row: DhanRow) => {
    if (!k) return
    const arr = idx.get(k) ?? []
    arr.push(row)
    idx.set(k, arr)
  }
  for (const row of rows) {
    addKey(squash(row.tradingSymbol), row)
    // derivative rows are additionally indexed under their UNDERLYING so a
    // NIFTY lookup finds "NIFTY-29Oct2026-25500-CE"-style trading symbols
    const parts = row.tradingSymbol.split('-')
    if (row.instrument.startsWith('OPT') && parts.length >= 4) addKey(squash(parts.slice(0, -3).join('-')), row)
    else if (row.instrument.startsWith('FUT') && parts.length >= 3) addKey(squash(parts.slice(0, -2).join('-')), row)
  }
  return idx
}

/** EVERY parsed Dhan master row (flat) — used by the real master sync.
 *  Null when the CSV cannot be downloaded/parsed (no fake data fallback). */
export async function loadDhanRows(): Promise<DhanRow[] | null> {
  const csv = await fetchCached('https://images.dhan.co/api-data/api-scrip-master.csv', 'dhan-scrip-master.csv')
  if (!csv) return null
  const lines = csv.split('\n')
  if (lines.length < 2) return null
  const header = parseCsvLine(lines[0]).map(h => h.trim())
  const col = (name: string): number => header.indexOf(name)
  const iExch = col('SEM_EXM_EXCH_ID'), iSeg = col('SEM_SEGMENT'), iSec = col('SEM_SMST_SECURITY_ID')
  const iCustom = col('SEM_CUSTOM_SYMBOL'), iExp = col('SEM_EXPIRY_DATE'), iStrike = col('SEM_STRIKE_PRICE')
  const iOpt = col('SEM_OPTION_TYPE'), iInst = col('SEM_INSTRUMENT_NAME'), iTrade = col('SEM_TRADING_SYMBOL')
  const iSeries = col('SEM_SERIES'), iLot = col('SEM_LOT_UNITS'), iTick = col('SEM_TICK_SIZE')
  const iName = col('SM_SYMBOL_NAME')
  if (iSec < 0 || iTrade < 0) { console.error('[scrip-master] dhan csv: SEM columns not found'); return null }
  const out: DhanRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length < 10) continue
    const c = parseCsvLine(line)
    const row: DhanRow & { tickSize?: string; name?: string } = {
      exch: c[iExch] ?? '', segment: c[iSeg] ?? '', securityId: c[iSec] ?? '', smstSymbol: c[iCustom] ?? '',
      tradingSymbol: c[iTrade] ?? '', expiry: isoExpiry(c[iExp] ?? ''), strike: normStrike(c[iStrike] ?? ''),
      optionType: (c[iOpt] ?? '').trim().toUpperCase(), instrument: (c[iInst] ?? '').trim().toUpperCase(),
      series: c[iSeries] ?? '', lotUnits: c[iLot] ?? '',
      tickSize: iTick >= 0 ? (c[iTick] ?? '').trim() : '', name: iName >= 0 ? (c[iName] ?? '').trim() : '',
    }
    if (!row.securityId) continue
    out.push(row)
  }
  return out
}

export function pickDhan(
  idx: Map<string, DhanRow[]>,
  master: { symbol: string; underlying?: string | null; exchange: string; instrumentType: string; expiry: string | null; strike: number | null; optionType: string | null },
): DhanRow | null {
  const segWanted = master.instrumentType === 'INDEX' ? 'I'
    : master.instrumentType === 'EQ' ? 'E'
    : master.exchange === 'MCX' ? 'M'
    : master.exchange === 'CDS' ? 'C'
    : 'D'
  const instOk = (r: DhanRow): boolean => {
    if (master.instrumentType === 'INDEX') return r.instrument === 'INDEX'
    if (master.instrumentType === 'EQ') return r.instrument === 'EQUITY'
    if (master.instrumentType === 'FUT') return r.instrument.startsWith('FUT')
    if (master.instrumentType === 'CE' || master.instrumentType === 'PE') return r.instrument.startsWith('OPT')
    return false
  }
  const wantExp = master.expiry ? master.expiry.slice(0, 10) : ''
  // master.symbol for derivatives is the option/future TICKER — the scrip
  // master index is keyed by UNDERLYING (NIFTY, not NIFTY2026102724400CE)
  const lookupSym = master.underlying?.trim() || master.symbol
  const rows = idx.get(squash(lookupSym)) ?? []
  const cands: { r: DhanRow; dist: number }[] = []
  for (const r of rows) {
    if (r.segment !== segWanted || !instOk(r)) continue
    // segment E also carries bonds/SDLs ("656MH32", series SG) — require EQ-family series
    if (master.instrumentType === 'EQ' && r.series && !['EQ', 'BE', 'BZ', 'SM', 'ST'].includes(r.series.toUpperCase())) continue
    let dist = 0
    if (master.instrumentType === 'FUT' || master.instrumentType === 'CE' || master.instrumentType === 'PE') {
      // expiry must exist; exact wins, nearest listed within 7 days is the
      // fallback (our generated calendar can drift from the broker's)
      if (!r.expiry) continue
      if (wantExp) {
        dist = Math.abs(Date.parse(r.expiry) - Date.parse(wantExp))
        if (dist > 7 * 86400_000) continue
      }
    }
    if (master.instrumentType === 'CE' || master.instrumentType === 'PE') {
      if (r.optionType !== master.instrumentType) continue
      const s = Number(master.strike)
      if (!Number.isFinite(s) || !r.strike || Math.abs(Number(r.strike) - s) > 0.01) continue
    }
    cands.push({ r, dist })
  }
  if (cands.length === 0) {
    // index fallback: "NIFTY MIDCAP 150" style names contain our symbol
    if (master.instrumentType === 'INDEX') {
      for (const [key, arr] of idx.entries()) {
        if (!key.includes(squash(master.symbol))) continue
        const r = arr.find(x => x.segment === 'I' && x.instrument === 'INDEX')
        if (r) return r
      }
    }
    return null
  }
  cands.sort((a, b) => a.dist - b.dist)
  return cands[0].r
}

// ---------------- SHOONYA index ----------------
const SHOONYA_FILES: [string, string][] = [
  ['NSE', 'shoonya-NSE.txt'], ['NFO', 'shoonya-NFO.txt'], ['BSE', 'shoonya-BSE.txt'],
  ['BFO', 'shoonya-BFO.txt'], ['MCX', 'shoonya-MCX.txt'], ['CDS', 'shoonya-CDS.txt'],
]

export async function loadShoonyaIndex(): Promise<Map<string, ShoonyaRow[]> | null> {
  const rows = await loadShoonyaRows()
  if (!rows) return null
  const idx = new Map<string, ShoonyaRow[]>()
  const addKey = (k: string, row: ShoonyaRow) => {
    if (!k) return
    const arr = idx.get(k) ?? []
    arr.push(row)
    idx.set(k, arr)
  }
  for (const row of rows) {
    addKey(squash(row.tradingSymbol), row)
    if (row.symbol) addKey(squash(row.symbol), row)
  }
  return idx
}

/** EVERY parsed Noren master row (flat) — used by the real master sync.
 *  Null when none of the six files can be downloaded/parsed. */
export async function loadShoonyaRows(): Promise<ShoonyaRow[] | null> {
  // parallel downloads — first sync pulls all six zips at once (cached 12h after)
  const results = await Promise.all(SHOONYA_FILES.map(async ([exch, file]) => ({ exch, txt: await fetchCached(`https://api.shoonya.com/${exch}_symbols.txt.zip`, file) })))
  const out: ShoonyaRow[] = []
  for (const { exch, txt } of results) {
    if (!txt) continue
    out.push(...parseShoonyaText(txt, exch))
  }
  return out.length > 0 ? out : null
}

function parseShoonyaText(txt: string, fallbackExch: string): ShoonyaRow[] {
  const out: ShoonyaRow[] = []
  const lines = txt.split('\n')
  // header-driven columns — the layout differs per exchange file
  // (NSE lacks Expiry/Strike; MCX inserts a GNGD column after LotSize)
  const header = lines[0].trim().replace(/,+$/, '').split(',').map(h => h.trim().toUpperCase())
  if (!header.includes('EXCHANGE')) return out
  const ci = (name: string): number => header.indexOf(name)
  const cExch = ci('EXCHANGE'), cTok = ci('TOKEN'), cLot = ci('LOTSIZE'), cSym = ci('SYMBOL')
  const cTrade = ci('TRADINGSYMBOL'), cExp = ci('EXPIRY'), cInst = ci('INSTRUMENT')
  const cOpt = ci('OPTIONTYPE'), cStrike = ci('STRIKEPRICE'), cTick = ci('TICKSIZE')
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const c = line.replace(/,+$/, '').split(',')
    if (c.length < 5) continue
    const row: ShoonyaRow = {
      exch: (c[cExch] ?? fallbackExch).trim(), token: (c[cTok] ?? '').trim(), lotSize: (c[cLot] ?? '').trim(),
      symbol: (c[cSym] ?? '').trim(), tradingSymbol: (c[cTrade] ?? '').trim(),
      expiry: isoExpiry(cExp >= 0 ? (c[cExp] ?? '') : ''), instrument: cInst >= 0 ? (c[cInst] ?? '').trim().toUpperCase() : '',
      optionType: cOpt >= 0 ? (c[cOpt] ?? '').trim().toUpperCase() : '',
      strike: cStrike >= 0 ? normStrike(c[cStrike] ?? '') : '',
      tickSize: cTick >= 0 ? (c[cTick] ?? '').trim() : '',
    }
    if (!row.tradingSymbol) continue
    out.push(row)
  }
  return out
}

export function pickShoonya(
  idx: Map<string, ShoonyaRow[]>,
  master: { symbol: string; underlying?: string | null; exchange: string; instrumentType: string; expiry: string | null; strike: number | null; optionType: string | null },
): ShoonyaRow | null {
  const exchWanted = master.exchange.toUpperCase()
  const instOk = (r: ShoonyaRow): boolean => {
    if (master.instrumentType === 'INDEX') return r.instrument === 'INDEX'
    if (master.instrumentType === 'EQ') return r.instrument === 'EQ'
    if (master.instrumentType === 'FUT') return r.instrument.startsWith('FUT')
    if (master.instrumentType === 'CE' || master.instrumentType === 'PE') return r.instrument.startsWith('OPT')
    return false
  }
  const wantExp = master.expiry ? master.expiry.slice(0, 10) : ''
  const lookupSym = master.underlying?.trim() || master.symbol
  const rows = idx.get(squash(lookupSym)) ?? []
  const cands: { r: ShoonyaRow; dist: number }[] = []
  for (const r of rows) {
    if (r.exch !== exchWanted || !instOk(r)) continue
    let dist = 0
    if (master.instrumentType === 'FUT' || master.instrumentType === 'CE' || master.instrumentType === 'PE') {
      if (!r.expiry) continue
      if (wantExp) {
        dist = Math.abs(Date.parse(r.expiry) - Date.parse(wantExp))
        if (dist > 7 * 86400_000) continue
      }
    }
    if (master.instrumentType === 'CE' || master.instrumentType === 'PE') {
      if (r.optionType !== master.instrumentType) continue
      const s = Number(master.strike)
      if (!Number.isFinite(s) || !r.strike || Math.abs(Number(r.strike) - s) > 0.01) continue
    }
    cands.push({ r, dist })
  }
  if (cands.length === 0) {
    // index fallback: Noren names indices "Nifty 50" / "Nifty Bank"
    if (master.instrumentType === 'INDEX') {
      const want = squash(master.symbol)
      for (const [key, arr] of idx.entries()) {
        if (!key.includes(want)) continue
        const r = arr.find(x => x.exch === exchWanted && x.instrument === 'INDEX')
        if (r) return r
      }
    }
    return null
  }
  cands.sort((a, b) => a.dist - b.dist)
  return cands[0].r
}

// ---------------- main entry ----------------
export interface EnrichResult {
  dhanUpdated: number
  shoonyaUpdated: number
  notes: string[]
}

/**
 * Rewrite DHAN/SHOONYA SymbolMapping rows with real broker tokens from the
 * public scrip masters. Never throws; reports per-broker counts.
 */
export async function enrichBrokerMappings(): Promise<EnrichResult> {
  const out: EnrichResult = { dhanUpdated: 0, shoonyaUpdated: 0, notes: [] }
  const mappings = await db.symbolMapping.findMany({
    where: { brokerType: { in: ['DHAN', 'SHOONYA'] } },
    include: { master: true },
  })
  const perBroker = new Map<string, typeof mappings>()
  for (const m of mappings) {
    const arr = perBroker.get(m.brokerType) ?? []
    arr.push(m)
    perBroker.set(m.brokerType, arr)
  }

  if (perBroker.has('DHAN')) {
    try {
      const idx = await loadDhanIndex()
      if (!idx) out.notes.push('Dhan scrip master unavailable — securityId mappings unchanged')
      else {
        for (const m of perBroker.get('DHAN')!) {
          const r = pickDhan(idx, m.master)
          if (!r) continue
          if (m.brokerToken === r.securityId && m.brokerSymbol === (r.tradingSymbol || m.brokerSymbol)) continue
          await db.symbolMapping.update({
            where: { id: m.id },
            data: { brokerToken: r.securityId, brokerSymbol: r.tradingSymbol || r.smstSymbol },
          })
          out.dhanUpdated++
        }
        out.notes.push(`Dhan: ${out.dhanUpdated} securityId mappings from api-scrip-master.csv`)
      }
    } catch (e) {
      out.notes.push(`Dhan enrichment failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (perBroker.has('SHOONYA')) {
    try {
      const idx = await loadShoonyaIndex()
      if (!idx) out.notes.push('Shoonya scrip masters unavailable — tsym mappings unchanged')
      else {
        for (const m of perBroker.get('SHOONYA')!) {
          const r = pickShoonya(idx, m.master)
          if (!r) continue
          const token = `${r.exch}|${r.tradingSymbol}`
          if (m.brokerToken === token) continue
          await db.symbolMapping.update({
            where: { id: m.id },
            data: { brokerToken: token, brokerSymbol: r.tradingSymbol },
          })
          out.shoonyaUpdated++
        }
        out.notes.push(`Shoonya: ${out.shoonyaUpdated} tsym mappings from ${exchNote(out.shoonyaUpdated)}`)
      }
    } catch (e) {
      out.notes.push(`Shoonya enrichment failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return out
}

function exchNote(n: number): string {
  return n > 0 ? 'symbols.txt masters' : 'symbols.txt masters (no matches)'
}
