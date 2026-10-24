// @ts-nocheck
import { db } from '../db'
import { adapters } from '../../../brokers/index'
import { BROKER_TYPES } from '../types'
import type { BrokerType } from '../types'

// ============================================================
// Master contracts (symbols) service.
// - Generates/refreshes the canonical SymbolMaster universe
//   (in production these are the daily NSE/BSE contract files
//   downloaded from the exchange; here a deterministic seeded
//   generator produces the same shape).
// - Maps every master symbol to each broker's own symbol/token
//   via the broker adapters -> SymbolMapping (copy trading ready).
// - Publishes the universe to the market feed mini-service.
// ============================================================

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'

export const INDEX_UNIVERSE: { symbol: string; name: string; base: number }[] = [
  { symbol: 'NIFTY', name: 'Nifty 50 Index', base: 24500 },
  { symbol: 'BANKNIFTY', name: 'Nifty Bank Index', base: 51800 },
  { symbol: 'FINNIFTY', name: 'Nifty Financial Services', base: 23100 },
  { symbol: 'MIDCPNIFTY', name: 'Nifty Midcap Select', base: 12250 },
  { symbol: 'SENSEX', name: 'BSE Sensex', base: 81000 },
]

/** Index constituent weights (%) used by the watchlist Index tab —
 *  contribution pts ≈ stock change pts × weight/100. Only symbols that
 *  exist in the EQ_UNIVERSE are listed (the rest of the real index weight
 *  sits in names we don't simulate). */
export const INDEX_CONSTITUENTS: Record<string, { symbol: string; weight: number }[]> = {
  NIFTY: [
    { symbol: 'RELIANCE', weight: 9.5 }, { symbol: 'HDFCBANK', weight: 8.6 },
    { symbol: 'ICICIBANK', weight: 7.4 }, { symbol: 'INFY', weight: 5.9 },
    { symbol: 'TCS', weight: 4.6 }, { symbol: 'ITC', weight: 4.4 },
    { symbol: 'LT', weight: 4.0 }, { symbol: 'KOTAKBANK', weight: 3.4 },
    { symbol: 'BHARTIARTL', weight: 3.4 }, { symbol: 'SBIN', weight: 3.1 },
    { symbol: 'AXISBANK', weight: 2.9 }, { symbol: 'M&M', weight: 2.6 },
    { symbol: 'MARUTI', weight: 2.4 }, { symbol: 'SUNPHARMA', weight: 2.0 },
    { symbol: 'TATAMOTORS', weight: 1.9 }, { symbol: 'NTPC', weight: 1.7 },
    { symbol: 'POWERGRID', weight: 1.6 }, { symbol: 'HINDUNILVR', weight: 1.6 },
    { symbol: 'ULTRACEMCO', weight: 1.5 }, { symbol: 'BAJFINANCE', weight: 1.5 },
    { symbol: 'ASIANPAINT', weight: 1.1 }, { symbol: 'TITAN', weight: 1.1 },
    { symbol: 'WIPRO', weight: 1.0 }, { symbol: 'HCLTECH', weight: 1.0 },
    { symbol: 'TECHM', weight: 1.0 }, { symbol: 'TATASTEEL', weight: 0.9 },
    { symbol: 'JSWSTEEL', weight: 0.9 }, { symbol: 'COALINDIA', weight: 0.8 },
    { symbol: 'ADANIENT', weight: 0.8 }, { symbol: 'ONGC', weight: 0.8 },
  ],
  BANKNIFTY: [
    { symbol: 'HDFCBANK', weight: 27.1 }, { symbol: 'ICICIBANK', weight: 23.3 },
    { symbol: 'SBIN', weight: 10.2 }, { symbol: 'KOTAKBANK', weight: 9.4 },
    { symbol: 'AXISBANK', weight: 8.4 }, { symbol: 'INDUSINDBK', weight: 5.0 },
  ],
  FINNIFTY: [
    { symbol: 'HDFCBANK', weight: 24.9 }, { symbol: 'ICICIBANK', weight: 20.4 },
    { symbol: 'KOTAKBANK', weight: 9.6 }, { symbol: 'AXISBANK', weight: 7.7 },
    { symbol: 'BAJFINANCE', weight: 7.6 }, { symbol: 'SBIN', weight: 6.2 },
  ],
  MIDCPNIFTY: [
    { symbol: 'TATASTEEL', weight: 6.4 }, { symbol: 'JSWSTEEL', weight: 5.9 },
    { symbol: 'COALINDIA', weight: 5.1 }, { symbol: 'ASIANPAINT', weight: 4.7 },
    { symbol: 'TITAN', weight: 4.4 }, { symbol: 'MARUTI', weight: 4.2 },
  ],
  SENSEX: [
    { symbol: 'RELIANCE', weight: 9.9 }, { symbol: 'HDFCBANK', weight: 9.3 },
    { symbol: 'ICICIBANK', weight: 8.2 }, { symbol: 'INFY', weight: 6.1 },
    { symbol: 'TCS', weight: 4.5 }, { symbol: 'BHARTIARTL', weight: 4.1 },
    { symbol: 'ITC', weight: 3.9 }, { symbol: 'LT', weight: 3.6 },
    { symbol: 'KOTAKBANK', weight: 3.1 }, { symbol: 'SBIN', weight: 3.0 },
    { symbol: 'AXISBANK', weight: 2.8 }, { symbol: 'M&M', weight: 2.7 },
    { symbol: 'MARUTI', weight: 2.6 }, { symbol: 'SUNPHARMA', weight: 2.1 },
    { symbol: 'TATAMOTORS', weight: 1.9 }, { symbol: 'NTPC', weight: 1.8 },
    { symbol: 'HINDUNILVR', weight: 1.7 }, { symbol: 'POWERGRID', weight: 1.6 },
    { symbol: 'ULTRACEMCO', weight: 1.6 }, { symbol: 'BAJFINANCE', weight: 1.5 },
    { symbol: 'ASIANPAINT', weight: 1.1 }, { symbol: 'TITAN', weight: 1.1 },
    { symbol: 'WIPRO', weight: 1.0 }, { symbol: 'HCLTECH', weight: 1.0 },
    { symbol: 'TECHM', weight: 1.0 }, { symbol: 'TATASTEEL', weight: 0.9 },
    { symbol: 'JSWSTEEL', weight: 0.9 }, { symbol: 'COALINDIA', weight: 0.8 },
    { symbol: 'ADANIENT', weight: 0.8 }, { symbol: 'ONGC', weight: 0.8 },
  ],
}

export const EQ_UNIVERSE: { symbol: string; name: string; base: number; lot: number }[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', base: 2870, lot: 250 },
  { symbol: 'TCS', name: 'Tata Consultancy Services Ltd', base: 4150, lot: 175 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', base: 1740, lot: 550 },
  { symbol: 'INFY', name: 'Infosys Ltd', base: 1870, lot: 400 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', base: 1265, lot: 700 },
  { symbol: 'SBIN', name: 'State Bank of India', base: 830, lot: 750 },
  { symbol: 'AXISBANK', name: 'Axis Bank Ltd', base: 1170, lot: 625 },
  { symbol: 'LT', name: 'Larsen & Toubro Ltd', base: 3620, lot: 150 },
  { symbol: 'ITC', name: 'ITC Ltd', base: 465, lot: 1600 },
  { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd', base: 990, lot: 800 },
  { symbol: 'TATASTEEL', name: 'Tata Steel Ltd', base: 155, lot: 5500 },
  { symbol: 'WIPRO', name: 'Wipro Ltd', base: 545, lot: 1500 },
  { symbol: 'HCLTECH', name: 'HCL Technologies Ltd', base: 1790, lot: 350 },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance Ltd', base: 7150, lot: 75 },
  { symbol: 'MARUTI', name: 'Maruti Suzuki India Ltd', base: 12800, lot: 50 },
  { symbol: 'TITAN', name: 'Titan Company Ltd', base: 3480, lot: 175 },
  { symbol: 'ASIANPAINT', name: 'Asian Paints Ltd', base: 2950, lot: 200 },
  { symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical Industries Ltd', base: 1780, lot: 350 },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement Ltd', base: 11200, lot: 50 },
  { symbol: 'ADANIENT', name: 'Adani Enterprises Ltd', base: 3100, lot: 300 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd', base: 1580, lot: 475 },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever Ltd', base: 2520, lot: 300 },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank Ltd', base: 1780, lot: 400 },
  { symbol: 'M&M', name: 'Mahindra & Mahindra Ltd', base: 2980, lot: 200 },
  { symbol: 'POWERGRID', name: 'Power Grid Corporation', base: 345, lot: 1800 },
  { symbol: 'NTPC', name: 'NTPC Ltd', base: 375, lot: 1500 },
  { symbol: 'ONGC', name: 'Oil & Natural Gas Corp Ltd', base: 285, lot: 2250 },
  { symbol: 'JSWSTEEL', name: 'JSW Steel Ltd', base: 985, lot: 675 },
  { symbol: 'COALINDIA', name: 'Coal India Ltd', base: 495, lot: 1350 },
  { symbol: 'TECHM', name: 'Tech Mahindra Ltd', base: 1680, lot: 600 },
]

function nextExpiries(count: number, weekday = 4): string[] {
  // weekday: 4 = Thursday (ISO). Returns next `count` Thursday dates YYYY-MM-DD
  const out: string[] = []
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  while (out.length < count) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() === weekday) {
      out.push(d.toISOString().slice(0, 10))
    }
  }
  return out
}

function nextMonthEnds(count: number, weekday = 4): string[] {
  // last `weekday` of the next `count` months (for monthly futures/options)
  const out: string[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 0) // last day of month
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

export function optionPremium(base: number, strike: number, type: 'CE' | 'PE', days: number): number {
  const intrinsic = type === 'CE' ? Math.max(0, base - strike) : Math.max(0, strike - base)
  const moneyness = Math.abs(base - strike) / base
  const tv = base * 0.006 * Math.sqrt(Math.max(1, days) / 14) * Math.exp(-moneyness * 18)
  return Math.max(intrinsic + tv, 0.05)
}

// NSE-style strike step by underlying price level
export function strikeStepFor(price: number): number {
  if (price < 200) return 5
  if (price < 500) return 10
  if (price < 1000) return 20
  if (price < 2500) return 50
  return 100
}

/** calendar date in IST — the exchange timezone the expiry dates belong to */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
}

export interface SyncResult {
  symbolCount: number
  mappedCount: number
  version: string
}

export async function syncMasterContracts(source: 'SEED' | 'DAILY_SYNC' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const version = istToday()
  try {
    // ---- REAL master contracts from the brokers' public master files ----
    // (round-13: the old seeded generator produced 849 demo symbols — the
    //  universe is now the actual tradable contracts with real strikes,
    //  expiries, lot sizes and exact broker tokens; no synthetic fallback)
    const { ingestRealMasters, masterMappingKey } = await import('./real-master-sync')
    // ONE streaming pass — universe rows + exact broker-token indexes together
    const { rows, stats, notes, sources, dhanTokens, shoonyaTokens } = await ingestRealMasters()
    if (rows.length === 0) {
      throw new Error(`real master sync produced 0 symbols (${notes.join('; ') || 'no notes'}) — master files unreachable or unparseable`)
    }

    // 1. FULL CLEAN REBUILD (SQLite createMany has no skipDuplicates):
    //    drop every mapping + master, then bulk-insert the real universe.
    //    Contracts ensured on demand earlier today are recreated by
    //    ensureOptionContracts the next time a pane needs them.
    await db.symbolMapping.deleteMany({})
    await db.symbolMaster.deleteMany({})

    // 2. bulk-insert the masters
    for (let i = 0; i < rows.length; i += 2000) {
      const chunk = rows.slice(i, i + 2000).map(r => ({
        symbol: r.symbol, name: r.name, exchange: r.exchange, instrumentType: r.instrumentType,
        expiry: r.expiry ?? null, strike: r.strike ?? null, optionType: r.optionType ?? null,
        lotSize: r.lotSize, tickSize: r.tickSize, underlying: r.underlying ?? null,
        basePrice: null as number | null, version,
      }))
      await db.symbolMaster.createMany({ data: chunk })
    }

    // 3. rebuild the broker mappings with EXACT tokens:
    //    DHAN securityId (same csv row) · SHOONYA EXCH|tsym (Noren) ·
    //    ICICI symbolic underlying token · SIMFEED bases only (derivative
    //    sim mappings are ensured on demand by ensureOptionContracts)
    const masters = await db.symbolMaster.findMany({
      select: { id: true, symbol: true, exchange: true, instrumentType: true, underlying: true, expiry: true, strike: true, optionType: true },
    })
    const iciciAdapter = adapters['ICICI_BREEZE' as BrokerType]
    const simAdapter = adapters['SIMFEED' as BrokerType]
    const dhanRows: { masterId: string; brokerType: string; brokerSymbol: string; brokerToken: string }[] = []
    const shoonyaRows: typeof dhanRows = []
    const iciciRows: typeof dhanRows = []
    const simRows: typeof dhanRows = []
    for (const m of masters) {
      const key = masterMappingKey(m)
      const d = dhanTokens.get(key)
      if (d) dhanRows.push({ masterId: m.id, brokerType: 'DHAN', brokerSymbol: d.tradingSymbol || d.smstSymbol, brokerToken: d.securityId })
      const sn = shoonyaTokens.get(key)
      if (sn) shoonyaRows.push({ masterId: m.id, brokerType: 'SHOONYA', brokerSymbol: sn.tsym, brokerToken: `${sn.exch.toUpperCase()}|${sn.tsym}` })
      if (iciciAdapter) {
        const gen = iciciAdapter.mapSymbol({
          symbol: m.symbol, exchange: m.exchange, instrumentType: m.instrumentType,
          underlying: m.underlying, expiry: m.expiry, strike: m.strike, optionType: m.optionType,
        })
        iciciRows.push({ masterId: m.id, brokerType: 'ICICI_BREEZE', brokerSymbol: gen.brokerSymbol, brokerToken: gen.brokerToken })
      }
      if (simAdapter && (m.instrumentType === 'EQ' || m.instrumentType === 'INDEX')) {
        const gen = simAdapter.mapSymbol({
          symbol: m.symbol, exchange: m.exchange, instrumentType: m.instrumentType,
          underlying: m.underlying, expiry: m.expiry, strike: m.strike, optionType: m.optionType,
        })
        simRows.push({ masterId: m.id, brokerType: 'SIMFEED', brokerSymbol: gen.brokerSymbol, brokerToken: gen.brokerToken })
      }
    }
    const writeMappings = async (list: typeof dhanRows): Promise<number> => {
      for (let i = 0; i < list.length; i += 5000) {
        await db.symbolMapping.createMany({ data: list.slice(i, i + 5000) })
      }
      return list.length
    }
    // sequential — SQLite has a single writer, parallel createMany locks up
    const nDhan = await writeMappings(dhanRows)
    const nShoonya = await writeMappings(shoonyaRows)
    const nIcici = await writeMappings(iciciRows)
    const nSim = await writeMappings(simRows)
    const mappedCount = nDhan + nShoonya + nIcici + nSim

    // 4. (the exact-key token indexes replace the old fuzzy enrichment pass —
    //    same files, same keys, no second 26MB re-parse)
    const enrichNote = ''

    // 5. NO feed-universe publish — the sim universe (db/universe.json) is
    //    untouched; live feeds resolve mappings per subscribed symbol.

    const statNote = stats.filter(st => st.count > 0).map(st => `${st.label} ${st.count.toLocaleString('en-IN')}`).join(' · ')
    const mapNote = `mappings — Dhan ${nDhan.toLocaleString('en-IN')} · Shoonya ${nShoonya.toLocaleString('en-IN')} · ICICI ${nIcici.toLocaleString('en-IN')} · SimFeed ${nSim.toLocaleString('en-IN')}`
    const message = `REAL master contracts (${sources.join(' + ')}) — ${rows.length.toLocaleString('en-IN')} symbols · ${statNote} · ${mapNote}${enrichNote}`

    await db.syncLog.create({
      data: { source, exchange: 'ALL', symbolCount: rows.length, mappedCount, status: 'SUCCESS', message, version },
    })
    await db.systemSetting.upsert({
      where: { key: 'lastMasterSync' },
      create: { key: 'lastMasterSync', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    console.log(`[symbol-sync] ${message}`)
    return { symbolCount: rows.length, mappedCount, version }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try {
      await db.syncLog.create({
        data: { source, exchange: 'ALL', symbolCount: 0, mappedCount: 0, status: 'FAILED', message: `REAL master sync FAILED — ${msg}` },
      })
    } catch { /* logging must never mask the original error */ }
    throw e
  }
}

export async function publishUniverseToFeed(masterRows: { symbol: string; basePrice: number | null; lotSize: number; instrumentType: string }[]) {
  try {
    const universe = masterRows.map(m => ({
      symbol: m.symbol,
      basePrice: m.basePrice ?? 1000,
      lotSize: m.lotSize,
      instrumentType: m.instrumentType,
    }))
    const res = await fetch(`${FEED_URL}/universe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ universe }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) console.error(`[symbol-sync] universe publish failed — HTTP ${res.status}`)
    else console.log(`[symbol-sync] universe published — ${universe.length} symbols (feed states total: ${(await res.json() as { symbols?: number }).symbols ?? '?'})`)
  } catch (e) {
    // feed service may still be booting — it pulls the universe lazily too
    console.error('[symbol-sync] universe publish error:', e instanceof Error ? e.message : e)
  }
}

export async function isMasterSynced(): Promise<boolean> {
  const count = await db.symbolMaster.count()
  return count > 0
}
