import { createServer } from 'http'
import { Server } from 'socket.io'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
// bun:sqlite — embedded recorder for tick-by-tick session backups
// (used later for paper trading / replay). Node fallback: not supported.
// @ts-ignore bun runtime builtin
import { Database } from 'bun:sqlite'
import { ensureLiveFeed, liveFedSymbols, liveFeedStatus, decryptJson } from './live-broker-feed'

// ============================================================
// Market Feed Mini-Service (port 3003, bun runtime)
// - Simulated tick engine (random walk, per-symbol volatility)
// - Candle aggregation for 1m/3m/5m/15m/30m/1h/1d
// - Deterministic historical backfill (3 sessions of 1m bars)
// - Socket.io streaming for subscribed symbols
// - REST: health / universe / candles / ltp / quote / depth
//         /feed-source (active feed account — one at a time)
// In production this service hosts pluggable feed adapters
// (Dhan WebSocket, Shoonya WebSocket, ICICI Breeze stream);
// the sim feed is the default source and the sandbox fallback.
// ============================================================

interface UniverseEntry {
  symbol: string
  basePrice: number
  lotSize: number
  instrumentType: string
}

interface SymbolState {
  symbol: string
  instrumentType: string
  lotSize: number
  base: number
  ltp: number
  prevClose: number
  open: number
  high: number
  low: number
  vol: number
  vola: number // per-tick volatility
  bid: number
  ask: number
  lastTickDir: number
  /** true when the state came from the sim universe (fabricated depth is
   *  allowed); live-broker states leave this unset — depth is REAL L1 only */
  simFed?: boolean
}

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

const PORT = Number(process.env.PORT || 3003) // socket.io (browser via Caddy)
const REST_PORT = Number(process.env.REST_PORT || 3004) // REST (Next.js server-side proxy)

// ---------- default universe (before master sync pushes the real one) ----------
const DEFAULT_UNIVERSE: UniverseEntry[] = [
  { symbol: 'NIFTY', basePrice: 24500, lotSize: 1, instrumentType: 'INDEX' },
  { symbol: 'BANKNIFTY', basePrice: 51800, lotSize: 1, instrumentType: 'INDEX' },
  { symbol: 'SENSEX', basePrice: 81000, lotSize: 1, instrumentType: 'INDEX' },
  { symbol: 'RELIANCE', basePrice: 2870, lotSize: 250, instrumentType: 'EQ' },
  { symbol: 'TCS', basePrice: 4150, lotSize: 175, instrumentType: 'EQ' },
  { symbol: 'HDFCBANK', basePrice: 1740, lotSize: 550, instrumentType: 'EQ' },
  { symbol: 'INFY', basePrice: 1870, lotSize: 400, instrumentType: 'EQ' },
  { symbol: 'SBIN', basePrice: 830, lotSize: 750, instrumentType: 'EQ' },
  { symbol: 'ICICIBANK', basePrice: 1265, lotSize: 700, instrumentType: 'EQ' },
]

const TF_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '1d': 86_400_000,
}

// ---------- seeded PRNG for deterministic history ----------
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

function volaFor(instrumentType: string): number {
  // per-250ms-tick volatility (annualizes to realistic daily moves)
  if (instrumentType === 'INDEX') return 0.00006
  if (instrumentType === 'FUT') return 0.0001
  if (instrumentType === 'CE' || instrumentType === 'PE') return 0.0007
  return 0.00012
}

function volaHist(instrumentType: string): number {
  // per 5s history sub-step
  if (instrumentType === 'INDEX') return 0.00018
  if (instrumentType === 'FUT') return 0.0003
  if (instrumentType === 'CE' || instrumentType === 'PE') return 0.0022
  return 0.00035
}

// ---------- state ----------
const g = globalThis as unknown as {
  __feedState: {
    states: Map<string, SymbolState>
    candles: Map<string, Candle[]> // key symbol|tf
    subs: Map<string, Set<string>> // socketId -> symbols
  } | undefined
}

if (!g.__feedState) {
  g.__feedState = { states: new Map(), candles: new Map(), subs: new Map() }
}
const S = g.__feedState

// ---------- active feed source (persisted; one at a time) ----------
const FEED_SRC_FILE = process.env.FEED_SRC_FILE || path.resolve(process.cwd(), '../../db/feed-source.json')
const UNIVERSE_FILE = process.env.UNIVERSE_FILE || path.resolve(process.cwd(), '../../db/universe.json')
let feedSource = 'sim'
let simDisabled = false
try {
  const raw = JSON.parse(readFileSync(FEED_SRC_FILE, 'utf8')) as { source?: string; simDisabled?: boolean }
  feedSource = raw.source ?? 'sim'
  simDisabled = raw.simDisabled === true
} catch { /* first boot — default 'sim' */ }

/** true when the sim engine may drive prices (sim source AND live-only off) */
function simWalkAllowed(): boolean {
  return feedSource === 'sim' && !simDisabled
}

// ---------- tick recorder (session live-feed backup) ----------
// Every tick of the configured symbols is written to a per-session SQLite
// DB (one file per feed boot, plus a new file when the IST date rolls over).
// Default: NIFTY + SENSEX. Admin can disable or add symbols via REST/Next API.
// These archives power the future paper-trading/replay engine.
const TICK_DIR = path.resolve(process.cwd(), '../../db/ticks')
const TICK_CFG_FILE = process.env.TICK_CFG_FILE || path.join(TICK_DIR, 'tick-recorder.json')

interface TickCfg { enabled: boolean; symbols: string[] }
let tickCfg: TickCfg = { enabled: true, symbols: ['NIFTY', 'SENSEX'] }
try {
  const raw = readFileSync(TICK_CFG_FILE, 'utf8')
  const parsed = JSON.parse(raw) as Partial<TickCfg>
  if (typeof parsed.enabled === 'boolean') tickCfg.enabled = parsed.enabled
  if (Array.isArray(parsed.symbols)) tickCfg.symbols = parsed.symbols.filter(s => typeof s === 'string').slice(0, 32)
} catch { /* first boot — defaults */ }

interface TickSession {
  db: InstanceType<typeof Database> | null
  file: string
  startedAt: string
  istDate: string
  rows: number
}
const gTick = g as unknown as { __tickSession?: TickSession }
const gTimers = g as unknown as { __tickRecTimer?: ReturnType<typeof setInterval> }

function istDateStr(ts = Date.now()): string {
  return new Date(ts + 5.5 * 3600_000).toISOString().slice(0, 10)
}

function openTickSession(): void {
  if (!gTimers.__tickRecTimer) {
    gTimers.__tickRecTimer = setInterval(recordTickOnce, 250)
  }
  if (!tickCfg.enabled) { closeTickSession(); return }
  if (gTick.__tickSession) return
  try {
    const now = Date.now()
    const day = istDateStr(now)
    const dir = path.join(TICK_DIR, day)
    mkdirSync(dir, { recursive: true })
    const d = new Date(now + 5.5 * 3600_000)
    const file = path.join(dir, `session-${d.toISOString().slice(11, 19).replaceAll(':', '')}.db`)
    const DatabaseAny = Database as unknown as new (p: string) => InstanceType<typeof Database>
    const dbh = new DatabaseAny(file)
    dbh.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        ts INTEGER NOT NULL, symbol TEXT NOT NULL, ltp REAL, bid REAL, ask REAL,
        vol INTEGER, high REAL, low REAL, open REAL, prevClose REAL
      );
      CREATE INDEX IF NOT EXISTS ix_ticks_sym_ts ON ticks(symbol, ts);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `)
    dbh.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('startedAt', ?), ('symbols', ?)`).run(
      new Date(now).toISOString(), tickCfg.symbols.join(','),
    )
    gTick.__tickSession = { db: dbh, file, startedAt: new Date(now).toISOString(), istDate: day, rows: 0 }
    console.log(`[market-feed] tick recorder ON — session ${file} (${tickCfg.symbols.join(', ')})`)
    pruneTickSessions()
  } catch (e) {
    console.error('[market-feed] tick session open failed:', e)
  }
}

function closeTickSession(): void {
  const s = gTick.__tickSession
  if (s?.db) { try { s.db.close() } catch { /* ignore */ } }
  if (s) console.log(`[market-feed] tick session closed (${s.rows} rows) — ${s.file}`)
  gTick.__tickSession = undefined
}

function recordTickOnce(): void {
  const s = gTick.__tickSession
  if (!tickCfg.enabled) { if (s) closeTickSession(); return }
  if (!s) { openTickSession(); return }
  // new IST day -> new session file (a fresh db per trading session)
  if (s.istDate !== istDateStr()) { closeTickSession(); openTickSession(); return }
  if (!s.db) return
  const now = Date.now()
  const stmt = s.db.prepare(`INSERT INTO ticks (ts, symbol, ltp, bid, ask, vol, high, low, open, prevClose) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  const many: unknown[][] = []
  for (const sym of tickCfg.symbols) {
    const st = S.states.get(sym)
    if (!st) continue
    many.push([now, sym, st.ltp, st.bid, st.ask, st.vol, st.high, st.low, st.open, st.prevClose])
  }
  if (many.length === 0) return
  try {
    s.db.transaction(() => { for (const r of many) stmt.run(...(r as [unknown])) })()
    s.rows += many.length
  } catch (e) {
    console.error('[market-feed] tick write failed:', e)
  }
}

function tickSessionInfo() {
  const s = gTick.__tickSession
  return s
    ? { file: s.file, startedAt: s.startedAt, rows: s.rows }
    : null
}

/** Keep only the newest KEEP tick-session archives (across all day dirs) —
 *  without this db/ticks grows unbounded (~20MB per day) and the platform
 *  workspace archiver eventually fails on the workspace size. */
function pruneTickSessions(keep = 8): void {
  try {
    if (!existsSync(TICK_DIR)) return
    const all: { p: string; m: number }[] = []
    for (const day of readdirSync(TICK_DIR)) {
      const dayDir = path.join(TICK_DIR, day)
      for (const f of readdirSync(dayDir)) {
        if (!f.endsWith('.db')) continue
        const p = path.join(dayDir, f)
        all.push({ p, m: statSync(p).mtimeMs })
      }
    }
    all.sort((a, b) => b.m - a.m)
    for (const old of all.slice(keep)) {
      try { unlinkSync(old.p); console.log(`[market-feed] pruned old tick session ${old.p}`) } catch { /* in use — next pass */ }
    }
  } catch { /* never break recording over pruning */ }
}

function listTickSessions(): { file: string; bytes: number; mtime: string }[] {
  const out: { file: string; bytes: number; mtime: string }[] = []
  try {
    if (!existsSync(TICK_DIR)) return out
    for (const day of readdirSync(TICK_DIR)) {
      const dayDir = path.join(TICK_DIR, day)
      for (const f of readdirSync(dayDir)) {
        if (!f.endsWith('.db')) continue
        const p = path.join(dayDir, f)
        const stt = statSync(p)
        out.push({ file: path.relative(path.resolve(process.cwd(), '../..'), p), bytes: stt.size, mtime: stt.mtime.toISOString() })
      }
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => (a.file < b.file ? 1 : -1)).slice(0, 40)
}

// ============================================================
// PAPER-TRADING REPLAY ENGINE
// Plays a RECORDED tick session (db/ticks/<day>/session-*.db)
// back through the normal live pipeline: symbol states, candles
// and socket streams are driven by the recorded ticks with their
// timestamps SHIFTED so the replay start maps to "now". The
// terminal, auto-rules and paper accounts see a normal session —
// admin can start it at ANY time (random session or a specific
// date-time range) and trade it as live paper trading.
// ============================================================
interface ReplayRow { ts: number; symbol: string; ltp: number; bid: number; ask: number; vol: number; high: number; low: number; open: number; prevClose: number }
interface ReplayState {
  rows: ReplayRow[]
  idx: number
  baseTs: number // first row ts (recording clock)
  startWall: number // Date.now() at start (wall clock)
  speed: number
  file: string
  total: number
}
const gReplay = g as unknown as { __replay?: ReplayState }
const gRepTimers = g as unknown as { __replayTimer?: ReturnType<typeof setInterval> }
const replayedSymbols = new Set<string>()

function applyTickToSeries(symbol: string, price: number, volDelta: number, nowMs: number): void {
  const bars = S.candles.get(`${symbol}|1m`)
  if (!bars) return
  const bs = bucketStart(nowMs, '1m')
  let cur = bars[bars.length - 1]
  if (!cur || cur.t !== bs) {
    bars.push({ t: bs, o: price, h: price, l: price, c: price, v: Math.max(0, volDelta) })
    if (bars.length > DAYS_BACK * 1440 + 500) bars.splice(0, 200)
    for (const tf of Object.keys(TF_MS)) {
      if (tf === '1m') continue
      const sk = `${symbol}|${tf}`
      const series = S.candles.get(sk)
      if (!series) continue
      const b2 = bucketStart(nowMs, tf)
      const last2 = series[series.length - 1]
      if (last2 && last2.t === b2) {
        last2.h = Math.max(last2.h, price)
        last2.l = Math.min(last2.l, price)
        last2.c = price
        last2.v += Math.max(0, volDelta)
      } else {
        series.push({ t: b2, o: price, h: price, l: price, c: price, v: Math.max(0, volDelta) })
      }
    }
  } else {
    cur.h = Math.max(cur.h, price)
    cur.l = Math.min(cur.l, price)
    cur.c = price
    cur.v += Math.max(0, volDelta)
  }
}

function applyReplayTick(row: ReplayRow, startWall: number, baseTs: number, speed: number): void {
  let st = S.states.get(row.symbol)
  if (!st) {
    loadUniverse([{ symbol: row.symbol, basePrice: row.ltp || 100, lotSize: 1, instrumentType: 'INDEX' }])
    st = S.states.get(row.symbol)
    if (!st) return
  }
  replayedSymbols.add(row.symbol)
  const prevLtp = st.ltp
  st.ltp = r2(row.ltp)
  if (row.prevClose) st.prevClose = r2(row.prevClose)
  if (row.open) st.open = r2(row.open)
  st.high = Math.max(st.high, r2(row.high || row.ltp))
  st.low = Math.min(st.low === 0 ? r2(row.low || row.ltp) : st.low, r2(row.low || row.ltp))
  st.bid = r2(row.bid || row.ltp * 0.9995)
  st.ask = r2(row.ask || row.ltp * 1.0005)
  st.lastTickDir = row.ltp >= prevLtp ? 1 : -1
  // recorded day volume is cumulative — take the delta for the candle
  const dv = Math.max(0, (row.vol || 0) - Math.max(0, (st as unknown as { _lastVol?: number })._lastVol ?? 0))
  ;(st as unknown as { _lastVol?: number })._lastVol = row.vol || 0
  st.vol = Math.max(st.vol, row.vol || st.vol)
  // VIRTUAL clock: the recorded moment mapped onto the wall clock
  const virtNow = startWall + (row.ts - baseTs) / speed
  applyTickToSeries(row.symbol, st.ltp, dv, virtNow)
}

function replayStep(): void {
  const r = gReplay.__replay
  if (!r) return
  const now = Date.now()
  const targetTs = r.baseTs + (now - r.startWall) * r.speed
  let budget = 4000 // cap per step so huge speeds cannot stall the loop
  while (r.idx < r.rows.length && r.rows[r.idx].ts <= targetTs && budget-- > 0) {
    applyReplayTick(r.rows[r.idx], r.startWall, r.baseTs, r.speed)
    r.idx++
  }
  if (r.idx >= r.rows.length) {
    console.log('[market-feed] replay finished —', r.total, 'ticks ·', r.file)
    stopReplay()
  }
}

function stopReplay(): void {
  if (gRepTimers.__replayTimer) { clearInterval(gRepTimers.__replayTimer); gRepTimers.__replayTimer = undefined }
  gReplay.__replay = undefined
  replayedSymbols.clear()
  for (const st of S.states.values()) delete (st as unknown as { _lastVol?: number })._lastVol
}

function replayStatus() {
  const r = gReplay.__replay
  if (!r) return { active: false, file: null as string | null, speed: 1, startedAt: null as string | null, total: 0, played: 0, symbols: [...replayedSymbols], progressPct: 0 }
  return {
    active: true,
    file: r.file,
    speed: r.speed,
    startedAt: new Date(r.startWall).toISOString(),
    total: r.total,
    played: r.idx,
    symbols: [...replayedSymbols],
    progressPct: r.total ? Math.round((r.idx / r.total) * 100) : 0,
  }
}

async function loadReplayRows(file: string | null, random: boolean, fromTs: number | null, toTs: number | null): Promise<{ rows: ReplayRow[]; file: string } | null> {
  let target = file
  if (!target || random) {
    const sessions = listTickSessions()
    if (sessions.length === 0) return null
    target = random ? sessions[Math.floor(Math.random() * sessions.length)].file : sessions[0].file
  }
  const full = path.resolve(process.cwd(), '../..', target)
  if (!full.includes('db/ticks') || target.includes('..')) return null
  const DatabaseAny = Database as unknown as new (p: string, ro: boolean) => InstanceType<typeof Database>
  const dbh = new DatabaseAny(full, true)
  try {
    const conds: string[] = []
    const args: unknown[] = []
    if (fromTs) { conds.push('ts >= ?'); args.push(fromTs) }
    if (toTs) { conds.push('ts <= ?'); args.push(toTs) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = dbh.prepare(`SELECT ts, symbol, ltp, bid, ask, vol, high, low, open, prevClose FROM ticks ${where} ORDER BY ts ASC LIMIT 400000`).all(...(args as [unknown])) as ReplayRow[]
    return { rows, file: target }
  } finally {
    dbh.close()
  }
}

// ---------- sidecar supervisor: keep the Next.js dev server alive ----------
// This service is boot-spawned and outlives agent tool sessions (whose spawned
// processes get reaped at session boundaries), so it doubles as the dev-server
// watchdog: whenever :3000 stops answering, respawn `bun run dev` detached.
const PROJECT_ROOT = path.resolve(process.cwd(), '../..')
let devStarting = false

async function devHealthy(): Promise<boolean> {
  try {
    const r = await fetch('http://localhost:3000/api/auth/me', { signal: AbortSignal.timeout(2500) })
    return r.status < 500 // any HTTP response means the server is up
  } catch {
    return false
  }
}

function spawnDevServer() {
  if (devStarting) return
  devStarting = true
  console.log('[market-feed] :3000 down — spawning Next.js dev server…')
  try {
    const child = spawn('bun', ['run', 'dev'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      // our own env may carry PORT=3003 — the dev script binds :3000 via -p
      env: { ...process.env, PORT: '3000' },
    })
    child.unref()
    child.on('error', e => console.error('[market-feed] dev spawn error:', e.message))
  } catch (e) {
    console.error('[market-feed] dev spawn failed:', e)
  } finally {
    // cooldown so a crashing server cannot trigger a tight respawn loop
    setTimeout(() => { devStarting = false }, 20_000)
  }
}

// watchdog itself is registered in the single-owner timer block at the bottom
// of this file (survives hot reloads without stacking)

const DAYS_BACK = 3

function bucketStart(ts: number, tf: string): number {
  const ms = TF_MS[tf] ?? 60000
  return Math.floor(ts / ms) * ms
}

function buildHistory(entry: UniverseEntry) {
  const rnd = mulberry32(hashStr(entry.symbol) % 2 ** 31)
  // independent stream for volume so adding index volume never perturbs the
  // deterministic price path (same rnd() call sequence as before)
  const vrnd = mulberry32((hashStr(entry.symbol) ^ 0x9e3779b9) >>> 0)
  const vola = volaHist(entry.instrumentType)
  const now = Date.now()
  const oneMin = TF_MS['1m']
  const startTs = bucketStart(now, '1m') - DAYS_BACK * 24 * 3600_000
  const bars: Candle[] = []
  let price = entry.basePrice * (0.995 + rnd() * 0.01)
  const MEAN_REV = 0.0006

  for (let t = startTs; t <= bucketStart(now, '1m'); t += oneMin) {
    const o = price
    let h = o, l = o, c = o
    // 12 sub-steps per minute
    for (let i = 0; i < 12; i++) {
      const shock = (rnd() - 0.5) * 2 * vola
      c = c * (1 + shock + MEAN_REV * (entry.basePrice - c) / entry.basePrice)
      h = Math.max(h, c)
      l = Math.min(l, c)
    }
    const v = Math.round((entry.instrumentType === 'INDEX' ? 2200 + vrnd() * 19000 : 400 + vrnd() * 2600) * (entry.lotSize > 1 ? 1 : 8))
    bars.push({ t, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v })
    price = c
  }
  S.candles.set(`${entry.symbol}|1m`, bars)
  return { last: bars[bars.length - 1]?.c ?? entry.basePrice, prevDayClose: entry.basePrice * 0.997 }
}

function r2(n: number) { return Math.round(n * 100) / 100 }

function loadUniverse(list: UniverseEntry[]) {
  for (const e of list) {
    if (S.states.has(e.symbol)) continue
    const { last, prevDayClose } = buildHistory(e)
    const bars = S.candles.get(`${e.symbol}|1m`)!
    const todayBars = bars.slice(-375)
    S.states.set(e.symbol, {
      symbol: e.symbol,
      instrumentType: e.instrumentType,
      lotSize: e.lotSize,
      base: e.basePrice,
      ltp: last,
      prevClose: r2(prevDayClose),
      open: todayBars[0]?.o ?? last,
      high: Math.max(...todayBars.map(b => b.h)),
      low: Math.min(...todayBars.map(b => b.l)),
      vol: todayBars.reduce((s, b) => s + b.v, 0),
      vola: volaFor(e.instrumentType),
      bid: r2(last * 0.9995),
      ask: r2(last * 1.0005),
      lastTickDir: 1,
      simFed: true,
    })
  }
}

// aggregate 1m -> tf (cached arrays appended on rollover)
function getSeries(symbol: string, tf: string): Candle[] {
  const key = `${symbol}|${tf}`
  if (tf === '1m') return S.candles.get(key) ?? []
  const base = S.candles.get(`${symbol}|1m`) ?? []
  let series = S.candles.get(key)
  if (!series) {
    series = aggregate(base, tf)
    S.candles.set(key, series)
  }
  return series
}

function aggregate(base: Candle[], tf: string): Candle[] {
  const ms = TF_MS[tf]
  const out: Candle[] = []
  let cur: Candle | null = null
  for (const b of base) {
    const bs = bucketStart(b.t, tf)
    if (!cur || cur.t !== bs) {
      if (cur) out.push(cur)
      cur = { t: bs, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
    } else {
      cur.h = Math.max(cur.h, b.h)
      cur.l = Math.min(cur.l, b.l)
      cur.c = b.c
      cur.v += b.v
    }
  }
  if (cur) out.push(cur)
  return out
}

// ---------- tick engine ----------
function tickOnce() {
  // NO SIM FALLBACK: once a real broker account is the feed source (or the
  // admin disabled the sim feed), the random walk stops for EVERY symbol —
  // the terminal shows real data or nothing.
  if (!simWalkAllowed()) return
  const now = Date.now()
  for (const st of S.states.values()) {
    if (replayedSymbols.has(st.symbol)) continue // replay drives this symbol
    if (liveFedSymbols().has(st.symbol)) continue // a real broker feed drives this symbol
    const shock = (Math.random() - 0.5) * 2 * st.vola
    const meanRev = (st.base - st.ltp) / st.base * 0.0006
    st.ltp = r2(st.ltp * (1 + shock + meanRev))
    st.lastTickDir = shock >= 0 ? 1 : -1
    st.high = Math.max(st.high, st.ltp)
    st.low = Math.min(st.low, st.ltp)
    st.bid = r2(st.ltp - Math.max(0.05, st.ltp * 0.0004))
    st.ask = r2(st.ltp + Math.max(0.05, st.ltp * 0.0004))
    // per-tick traded volume — EQ/FUT/OPT scale with lot size, indices get a
    // synthetic flow calibrated to match the historical per-minute volumes
    // (history: ~2200-21000/min for INDEX, ~3200-24000/min for lot>1 EQ)
    const dv = st.instrumentType !== 'INDEX'
      ? Math.round(Math.random() * st.lotSize * 2)
      : Math.round(10 + Math.random() * 60)
    st.vol += dv

    // update 1m candle
    const key = `${st.symbol}|1m`
    const bars = S.candles.get(key)
    if (bars) {
      const bs = bucketStart(now, '1m')
      let cur = bars[bars.length - 1]
      if (!cur || cur.t !== bs) {
        cur = { t: bs, o: st.ltp, h: st.ltp, l: st.ltp, c: st.ltp, v: dv }
        bars.push(cur)
        // keep memory bounded
        if (bars.length > DAYS_BACK * 1440 + 500) bars.splice(0, 200)
        // invalidate higher tf caches lazily (they re-aggregate tail)
        for (const tf of Object.keys(TF_MS)) {
          if (tf === '1m') continue
          const sk = `${st.symbol}|${tf}`
          const series = S.candles.get(sk)
          if (series) {
            const b2 = bucketStart(now, tf)
            const last2 = series[series.length - 1]
            if (last2 && last2.t === b2) {
              last2.h = Math.max(last2.h, st.ltp)
              last2.l = Math.min(last2.l, st.ltp)
              last2.c = st.ltp
              last2.v += dv
            } else {
              series.push({ t: b2, o: st.ltp, h: st.ltp, l: st.ltp, c: st.ltp, v: dv })
            }
          }
        }
      } else {
        cur.h = Math.max(cur.h, st.ltp)
        cur.l = Math.min(cur.l, st.ltp)
        cur.c = st.ltp
        cur.v += dv
      }
    }
  }
}

function subscribedSymbols(): Set<string> {
  const set = new Set<string>()
  for (const syms of S.subs.values()) for (const s of syms) set.add(s)
  return set
}

// ---------- http server ----------
const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json')

  const json = (code: number, obj: unknown) => {
    res.statusCode = code
    res.end(JSON.stringify(obj))
  }

  if (url.pathname === '/health') return json(200, { ok: true, symbols: S.states.size, ts: Date.now() })

  // live broker feed diagnostics — which account feeds, is it ticking, last error
  if (url.pathname === '/feed-status') {
    const st = liveFeedStatus()
    return json(200, {
      ...st,
      sourceIsLive: st.source !== 'sim',
      fresh: st.lastTickTs != null && Date.now() - st.lastTickTs < 15_000,
    })
  }

  // ---- tick recorder config (session live-feed backup) ----
  if (url.pathname === '/tick-config') {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        try {
          const b = JSON.parse(body) as Partial<TickCfg>
          if (typeof b.enabled === 'boolean') tickCfg.enabled = b.enabled
          if (Array.isArray(b.symbols)) {
            tickCfg.symbols = b.symbols.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().toUpperCase()).slice(0, 32)
          }
          try {
            mkdirSync(path.dirname(TICK_CFG_FILE), { recursive: true })
            writeFileSync(TICK_CFG_FILE, JSON.stringify(tickCfg, null, 2))
          } catch (e) { console.error('[market-feed] tick-config persist failed:', e) }
          if (tickCfg.enabled) openTickSession()
          else closeTickSession()
          console.log(`[market-feed] tick recorder config: enabled=${tickCfg.enabled} symbols=[${tickCfg.symbols.join(',')}]`)
          json(200, { ok: true, ...tickCfg, session: tickSessionInfo() })
        } catch (e) { json(400, { ok: false, error: String(e) }) }
      })
      return
    }
    return json(200, { ...tickCfg, session: tickSessionInfo() })
  }

  if (url.pathname === '/tick-sessions') {
    return json(200, { sessions: listTickSessions(), current: tickSessionInfo() })
  }

  // tick sample replay — future paper-trading input:
  // GET /tick-sample?file=db/ticks/2026-10-21/session-091500.db&symbol=NIFTY&limit=200&from=0
  if (url.pathname === '/tick-sample') {
    const file = url.searchParams.get('file') ?? ''
    const symbol = url.searchParams.get('symbol') ?? ''
    const limit = Math.min(5000, Number(url.searchParams.get('limit') ?? 500))
    const from = Math.max(0, Number(url.searchParams.get('from') ?? 0))
    if (!file || !file.includes('db/ticks') || file.includes('..')) return json(400, { error: 'file required' })
    try {
      const DatabaseAny = Database as unknown as new (p: string, ro: boolean) => InstanceType<typeof Database>
      const dbh = new DatabaseAny(path.resolve(process.cwd(), '../..', file), true)
      const rows = symbol
        ? dbh.prepare('SELECT * FROM ticks WHERE symbol = ? ORDER BY ts LIMIT ? OFFSET ?').all(symbol, limit, from)
        : dbh.prepare('SELECT * FROM ticks ORDER BY ts LIMIT ? OFFSET ?').all(limit, from)
      dbh.close()
      return json(200, { file, count: rows.length, ticks: rows })
    } catch (e) { return json(500, { error: String(e) }) }
  }

  // ---- paper-trading replay (admin) ----
  if (url.pathname === '/replay-config') {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', async () => {
        try {
          const b = JSON.parse(body) as { mode?: string; file?: string | null; random?: boolean; fromTs?: number | null; toTs?: number | null; speed?: number }
          if (b.mode === 'stop') {
            stopReplay()
            return json(200, { ok: true, ...replayStatus() })
          }
          if (b.mode === 'start') {
            const loaded = await loadReplayRows(b.file ?? null, !!b.random, b.fromTs ?? null, b.toTs ?? null)
            if (!loaded || loaded.rows.length === 0) return json(400, { ok: false, error: 'no recorded tick session available (enable the tick recorder and let it capture some minutes first)' })
            stopReplay()
            const speed = Math.max(0.5, Math.min(20, b.speed ?? 1))
            gReplay.__replay = { rows: loaded.rows, idx: 0, baseTs: loaded.rows[0].ts, startWall: Date.now(), speed, file: loaded.file, total: loaded.rows.length }
            if (gRepTimers.__replayTimer) clearInterval(gRepTimers.__replayTimer)
            gRepTimers.__replayTimer = setInterval(replayStep, 100)
            console.log(`[market-feed] replay START ${loaded.file} · ${loaded.rows.length} ticks · speed ${speed}x${b.fromTs ? ` · from ${new Date(b.fromTs).toISOString()}` : ''}${b.toTs ? ` · to ${new Date(b.toTs).toISOString()}` : ''}`)
            return json(200, { ok: true, ...replayStatus() })
          }
          json(400, { ok: false, error: 'mode must be start|stop' })
        } catch (e) { json(400, { ok: false, error: String(e) }) }
      })
      return
    }
    return json(200, replayStatus())
  }

  if (url.pathname === '/replay-status') return json(200, replayStatus())

  // ---- active feed source (which account the terminal pulls data from) ----
  // Persisted to a shared JSON file so the Next.js API can read/write it too.
  // 'sim' = built-in simulated feed; otherwise a BrokerAccount id whose
  // adapter websocket is used when that broker feed is connected.
  if (url.pathname === '/feed-source') {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        try {
          const b = JSON.parse(body) as { source?: string; simDisabled?: boolean }
          let changedSource = false
          if (b.source !== undefined) {
            if (!b.source || typeof b.source !== 'string') return json(400, { ok: false, error: 'source required' })
            changedSource = b.source !== feedSource
            feedSource = b.source
          }
          if (typeof b.simDisabled === 'boolean') simDisabled = b.simDisabled
          try {
            mkdirSync(path.dirname(FEED_SRC_FILE), { recursive: true })
            // preserve sibling keys (read-modify-write) — the file carries both
            // the source radio and the admin Live-Only switch
            let prev: Record<string, unknown> = {}
            try { prev = JSON.parse(readFileSync(FEED_SRC_FILE, 'utf8')) as Record<string, unknown> } catch { /* first write */ }
            writeFileSync(FEED_SRC_FILE, JSON.stringify({ ...prev, source: feedSource, simDisabled, updatedAt: new Date().toISOString() }, null, 2))
          } catch (e) {
            console.error('[market-feed] feed-source persist failed:', e)
          }
          if (changedSource) {
            if (feedSource !== 'sim') {
              // LIVE SOURCE: purge every simulated price/candle so charts,
              // depth and watchlists can only show real broker data
              S.states.clear()
              S.candles.clear()
              replayedSymbols.clear()
              console.log(`[market-feed] feed source -> ${feedSource} — sim market data PURGED (live only)`)
            } else {
              // back to sim — reseed the universe (last published list first)
              try {
                const saved = JSON.parse(readFileSync(UNIVERSE_FILE, 'utf8')) as UniverseEntry[]
                if (Array.isArray(saved) && saved.length) loadUniverse(saved)
                else loadUniverse(DEFAULT_UNIVERSE)
              } catch { loadUniverse(DEFAULT_UNIVERSE) }
              console.log('[market-feed] feed source -> sim — universe reseeded')
            }
          } else {
            console.log(`[market-feed] feed source -> ${feedSource} (simDisabled=${simDisabled})`)
          }
          json(200, { ok: true, source: feedSource, simDisabled })
        } catch (e) {
          json(400, { ok: false, error: String(e) })
        }
      })
      return
    }
    return json(200, { source: feedSource, simDisabled })
  }

  if (url.pathname === '/universe') {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        try {
          const { universe } = JSON.parse(body) as { universe: UniverseEntry[] }
          loadUniverse(universe)
          // persist so a sim-source switch can reseed without the Next app
          try {
            mkdirSync(path.dirname(UNIVERSE_FILE), { recursive: true })
            writeFileSync(UNIVERSE_FILE, JSON.stringify(universe))
          } catch { /* best effort */ }
          json(200, { ok: true, symbols: S.states.size })
        } catch (e) {
          json(400, { ok: false, error: String(e) })
        }
      })
      return
    }
    return json(200, { universe: [...S.states.values()].map(s => ({ symbol: s.symbol, basePrice: s.ltp, lotSize: s.lotSize, instrumentType: s.instrumentType })) })
  }

  if (url.pathname === '/ltp') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
    const quotes: Record<string, unknown> = {}
    for (const s of symbols) {
      const st = S.states.get(s)
      if (st) {
        quotes[s] = { symbol: s, ltp: st.ltp, prevClose: st.prevClose, open: st.open, high: st.high, low: st.low, vol: st.vol, ts: Date.now() }
      }
    }
    return json(200, { quotes })
  }

  if (url.pathname === '/quote') {
    const s = url.searchParams.get('symbol') ?? ''
    const st = S.states.get(s)
    if (!st) return json(404, { error: 'unknown symbol' })
    if (st.simFed) {
      // SIM state — fabricated L2 depth is fine (it is a simulation)
      return json(200, {
        symbol: s, ltp: st.ltp, prevClose: st.prevClose, open: st.open, high: st.high, low: st.low, vol: st.vol,
        bid: st.bid, ask: st.ask,
        depth: {
          buys: [0, 1, 2, 3, 4].map(i => ({ price: r2(st.bid - i * (st.ltp * 0.0005 + 0.05)), qty: Math.round(50 + Math.random() * 900) })),
          sells: [0, 1, 2, 3, 4].map(i => ({ price: r2(st.ask + i * (st.ltp * 0.0005 + 0.05)), qty: Math.round(50 + Math.random() * 900) })),
        },
        ts: Date.now(),
      })
    }
    // LIVE state — only what the broker actually sent. Level 1 bid/ask are
    // real; deeper levels stay empty (Breeze/Noren REST quotes don't carry
    // a full book — fabricating one here would show fake market depth).
    return json(200, {
      symbol: s, ltp: st.ltp, prevClose: st.prevClose, open: st.open, high: st.high, low: st.low, vol: st.vol,
      bid: st.bid, ask: st.ask,
      depth: {
        buys: st.bid > 0 ? [{ price: st.bid, qty: 0 }] : [],
        sells: st.ask > 0 ? [{ price: st.ask, qty: 0 }] : [],
      },
      ts: Date.now(),
    })
  }

  if (url.pathname === '/candles') {
    const symbol = url.searchParams.get('symbol') ?? ''
    const tf = url.searchParams.get('tf') ?? '5m'
    const limit = Math.min(3000, Number(url.searchParams.get('limit') ?? 500))
    if (!S.states.has(symbol)) return json(404, { error: `unknown symbol ${symbol}` })
    const series = getSeries(symbol, tf)
    return json(200, { symbol, tf, candles: series.slice(-limit) })
  }

  json(404, { error: 'not found' })
})

// ---------- socket server (socket.io, path '/' per gateway convention) ----------
const socketServer = createServer()

const io = new Server(socketServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

io.on('connection', socket => {
  S.subs.set(socket.id, new Set())

  socket.on('subscribe', (symbols: string[]) => {
    const set = S.subs.get(socket.id)
    if (set) for (const s of symbols || []) set.add(s)
    socket.emit('subscribed', { symbols, count: set?.size ?? 0 })
  })

  socket.on('unsubscribe', (symbols: string[]) => {
    const set = S.subs.get(socket.id)
    if (set) for (const s of symbols || []) set.delete(s)
  })

  // ---- realtime sync hub subscription (replaces N polling REST calls) ----
  socket.on('sync:sub', (p: { chains?: { underlying: string; expiry?: string | null }[]; index?: string[] }) => {
    ;(socket as unknown as { __syncSubs?: { chains: { underlying: string; expiry: string | null }[]; index: string[] } }).__syncSubs = {
      chains: (p?.chains ?? []).map(c => ({ underlying: c.underlying, expiry: c.expiry ?? null })),
      index: p?.index ?? [],
    }
  })

  socket.on('disconnect', () => S.subs.delete(socket.id))
})

loadUniverse(DEFAULT_UNIVERSE)

// ---- timers: bun --hot stacks intervals across reloads — deregister the
// previous module's loops first (globalThis survives hot reloads) ----
interface HotTimers { tick?: ReturnType<typeof setInterval>; stream?: ReturnType<typeof setInterval>; watch?: ReturnType<typeof setInterval>; tickRec?: ReturnType<typeof setInterval>; sync?: ReturnType<typeof setInterval>; replay?: ReturnType<typeof setInterval> }
const hot = g as unknown as { __feedTimers?: HotTimers }
if (hot.__feedTimers) {
  if (hot.__feedTimers.tick) clearInterval(hot.__feedTimers.tick)
  if (hot.__feedTimers.stream) clearInterval(hot.__feedTimers.stream)
  if (hot.__feedTimers.watch) clearInterval(hot.__feedTimers.watch)
  if (hot.__feedTimers.tickRec) clearInterval(hot.__feedTimers.tickRec)
  if (hot.__feedTimers.replay) clearInterval(hot.__feedTimers.replay)
}
hot.__feedTimers = {}
// replay timer ownership (hot-reload safe): re-register if a replay is live
if (gRepTimers.__replayTimer) { clearInterval(gRepTimers.__replayTimer); gRepTimers.__replayTimer = setInterval(replayStep, 100) }
// the tick-recorder loop registers itself via gTimers.__tickRecTimer inside
// openTickSession() — clear any stale one left by a previous module instance
if (gTimers.__tickRecTimer) clearInterval(gTimers.__tickRecTimer)
gTimers.__tickRecTimer = undefined

// ---- tick recorder: open the session DB if enabled (after timer cleanup) ----
if (tickCfg.enabled) openTickSession()

// tick loop 250ms — streams subscribed symbols
hot.__feedTimers.tick = setInterval(tickOnce, 250)

// live broker feed engine — polls the ACTIVE broker account's quote APIs
// and pushes real ticks into the same pipeline (skips random-walk for fed symbols)
ensureLiveFeed({
  S,
  subscribed: subscribedSymbols,
  bucketStart,
  r2,
  getTickCfg: () => tickCfg,
})
hot.__feedTimers.stream = setInterval(() => {
  const syms = subscribedSymbols()
  if (syms.size === 0) return
  const ticks: unknown[] = []
  const now = Date.now()
  for (const s of syms) {
    const st = S.states.get(s)
    if (!st) continue
    ticks.push({ symbol: s, ltp: st.ltp, prevClose: st.prevClose, open: st.open, high: st.high, low: st.low, vol: st.vol, bid: st.bid, ask: st.ask, ts: now })
  }
  if (ticks.length) io.emit('ticks', ticks)
}, 250)

// dev-server watchdog — every 10s, respawn `bun run dev` when :3000 is dark
hot.__feedTimers.watch = setInterval(() => {
  void devHealthy().then(up => { if (!up) spawnDevServer() })
}, 10_000)

httpServer.listen(REST_PORT, () => {
  console.log(`[market-feed] REST listening on :${REST_PORT} with ${S.states.size} symbols`)
})
socketServer.on('error', e => console.error('[market-feed] socket.io error:', (e as Error).message))
httpServer.on('error', e => console.error('[market-feed] REST error:', (e as Error).message))
socketServer.listen(PORT, () => {
  console.log(`[market-feed] socket.io listening on :${PORT}`)
})

process.on('SIGTERM', () => { httpServer.close(() => process.exit(0)); socketServer.close(() => process.exit(0)) })
process.on('SIGINT', () => { httpServer.close(() => process.exit(0)); socketServer.close(() => process.exit(0)) })

// ============================================================
// REALTIME SYNC HUB — the browser subscribes ONCE ('sync:sub')
// and receives everything over the existing socket.io feed link:
//   sync:core  (1s)  accounts + positions + orders + trades +
//                    funds + session stats — read DIRECTLY from
//                    the SQLite files (master db/custom.db +
//                    db/brokers/{type}/{account}.db, read-only)
//                    so there is NO Next.js HTTP hop and no API lag
//   sync:chain (1s)  option chain quotes per subscribed
//                    underlying/expiry (CE floor / PE ceil ATM)
//   sync:index (2s)  index constituents + pts contribution
// The Next.js REST routes stay available as a fallback (auth,
// order placement and CRUD still go through HTTP — commands are
// rare; data flows over the websocket).
// ============================================================

const FEED_PROJECT_ROOT = path.resolve(process.cwd(), '../..') // service always runs from mini-services/market-feed
const MASTER_DB_PATH = path.join(FEED_PROJECT_ROOT, 'db', 'custom.db')

// index weights (mirror of symbol-service INDEX_CONSTITUENTS)
const INDEX_WEIGHTS: Record<string, { symbol: string; weight: number }[]> = {
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
  ],
}

function openRO(p: string): Database | null {
  try {
    if (!existsSync(p)) return null
    return new Database(p, { readonly: true })
  } catch { return null }
}

function istDayStartMs(): number {
  const d = new Date(Date.now() + 5.5 * 3600_000)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime() - 5.5 * 3600_000
}

interface SyncCoreRow { [k: string]: unknown }

function buildCorePayload(): SyncCoreRow | null {
  const master = openRO(MASTER_DB_PATH)
  if (!master) return null
  let accounts: SyncCoreRow[] = []
  try {
    accounts = master.prepare(`
      SELECT ba.id, ba.label, ba.brokerType, ba.status, ba.isActive, ba.isOrderEnabled,
             ba.isLiveDataSource, ba.isCopyMaster, ba.clientId,
             cc.initialCapital, cc.mode, cc.capitalBase, cc.capitalPct, cc.realizedPnl, cc.chargesPaid, cc.deployed, cc.firstTradeDone
      FROM BrokerAccount ba LEFT JOIN CapitalConfig cc ON cc.accountId = ba.id
      ORDER BY ba.sortOrder ASC
    `).all() as SyncCoreRow[]
  } catch { master.close(); return null }
  master.close()

  const sessionStart = istDayStartMs()
  const accRows: SyncCoreRow[] = []
  const posRows: SyncCoreRow[] = []
  const orderRows: SyncCoreRow[] = []
  const tradeRows: SyncCoreRow[] = []
  const fundRows: SyncCoreRow[] = []
  const perAccount: SyncCoreRow[] = []
  const symbolPts = new Map<string, number>()
  let closes = 0, wins = 0, pts = 0, realizedTot = 0, chargesTot = 0

  for (const a of accounts) {
    const mode = String(a.mode ?? 'INITIAL_PLUS_PNL')
    const realizedPnl = Number(a.realizedPnl ?? 0)
    const deployed = Number(a.deployed ?? 0)
    // broker DB (opened first so the %-of-cash base can read live funds)
    const brokerDb = openRO(path.join(FEED_PROJECT_ROOT, 'db', 'brokers', String(a.brokerType).toLowerCase(), `${a.id}.db`))
    // capital source: FIXED rupee amount or % of the account's live available cash
    const capitalBase = String(a.capitalBase ?? 'FIXED')
    const capitalPct = Number(a.capitalPct ?? 100)
    let availableCash: number | null = null
    if (brokerDb && capitalBase === 'AVAILABLE_CASH_PCT') {
      try {
        const f = brokerDb.prepare('SELECT cash FROM funds WHERE id = 1').get() as { cash: number } | undefined
        availableCash = Number(f?.cash ?? 0)
      } catch { availableCash = null }
    }
    const initialCapital = capitalBase === 'AVAILABLE_CASH_PCT' && availableCash != null
      ? r2(Math.max(0, availableCash * (capitalPct / 100)))
      : Number(a.initialCapital ?? 0)
    let base: number
    if (capitalBase === 'AVAILABLE_CASH_PCT' && availableCash != null) {
      // % of live cash: the balance already contains PnL — usable = share − deployed
      base = initialCapital
    } else if (mode === 'PROFIT_ONLY') base = a.firstTradeDone ? realizedPnl : initialCapital
    else if (mode === 'INITIAL_WITH_LOSS_REDUCTION') base = initialCapital + Math.min(0, realizedPnl)
    else base = initialCapital + realizedPnl
    const usable = r2(Math.max(0, base - deployed))

    let openPos = 0, openOrd = 0
    let aUnreal = 0
    if (brokerDb) {
      // positions (live mark from the feed's own quote engine)
      let pos: SyncCoreRow[] = []
      try { pos = brokerDb.prepare('SELECT * FROM positions').all() as SyncCoreRow[] } catch { pos = [] }
      for (const p of pos) {
        const netQty = Number(p.net_qty ?? 0)
        const sym = String(p.symbol)
        const st = S.states.get(sym)
        const ltp = st?.ltp ?? Number(p.ltp ?? 0)
        const unreal = (ltp - Number(p.avg_price ?? 0)) * netQty
        aUnreal += unreal
        // push open positions AND positions touched this session (realized
        // rows power the "1/5 open/total" session counts in the UI)
        if (netQty !== 0) openPos++
        if (netQty !== 0 || Number(p.realized_pnl ?? 0) !== 0) {
          posRows.push({
            accountId: a.id, accountLabel: a.label, brokerType: a.brokerType,
            symbol: sym, exchange: p.exchange, productType: p.product_type,
            netQty, buyQty: p.buy_qty, sellQty: p.sell_qty,
            avgPrice: p.avg_price, realizedPnl: p.realized_pnl, ltp,
            unrealizedPnl: r2(unreal), lotSize: p.lot_size, updatedAt: p.updated_at,
          })
        }
      }
      // orders (recent first)
      let ords: SyncCoreRow[] = []
      try { ords = brokerDb.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 60').all() as SyncCoreRow[] } catch { ords = [] }
      for (const o of ords) {
        if (o.status === 'OPEN' || o.status === 'PENDING') openOrd++
        orderRows.push({
          id: o.id, masterOrderId: o.master_order_id ?? undefined, symbol: o.symbol, exchange: o.exchange,
          side: o.side, qty: o.qty, filledQty: o.filled_qty, orderType: o.order_type, productType: o.product_type,
          status: o.status, avgPrice: o.avg_price ?? undefined, message: o.message ?? undefined,
          createdAt: o.created_at, updatedAt: o.updated_at,
          accountId: a.id, accountLabel: a.label, brokerType: a.brokerType,
        })
      }
      // trades (session subset for stats; recent 60 pushed)
      let trs: SyncCoreRow[] = []
      try { trs = brokerDb.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT 400').all() as SyncCoreRow[] } catch { trs = [] }
      let aCloses = 0, aWins = 0, aPts = 0, aReal = 0, aChg = 0, aTradesN = 0
      for (const t of trs) {
        const tsMs = new Date(String(t.ts)).getTime()
        if (tsMs < sessionStart) continue
        aTradesN++
        aChg += Number(t.charges_total ?? 0)
        const rp = t.realized_pnl
        if (rp === null || rp === undefined) continue
        aCloses++
        aReal += Number(rp)
        if (Number(rp) > 0) aWins++
        const unitPts = Number(t.qty) > 0 ? Number(rp) / Number(t.qty) : 0
        aPts += unitPts
        symbolPts.set(String(t.symbol), (symbolPts.get(String(t.symbol)) ?? 0) + unitPts)
      }
      for (const t of trs.slice(0, 60)) {
        let charges: unknown = null
        try { charges = t.charges_json ? JSON.parse(String(t.charges_json)) : null } catch { charges = null }
        tradeRows.push({
          id: t.id, orderId: t.order_id, symbol: t.symbol, exchange: t.exchange, side: t.side,
          qty: t.qty, price: t.price, value: t.value, chargesTotal: t.charges_total, charges,
          realizedPnl: t.realized_pnl ?? undefined, ts: t.ts,
          accountId: a.id, accountLabel: a.label, brokerType: a.brokerType,
        })
      }
      closes += aCloses; wins += aWins; pts += aPts; realizedTot += aReal; chargesTot += aChg
      perAccount.push({
        accountId: a.id, label: a.label, brokerType: a.brokerType,
        trades: aTradesN, closes: aCloses, wins: aWins, pts: r2(aPts),
        realized: r2(aReal), unrealized: r2(aUnreal), charges: r2(aChg),
      })
      brokerDb.close()
    }

    accRows.push({
      id: a.id, label: a.label, brokerType: a.brokerType, status: a.status,
      isActive: !!a.isActive, isLiveDataSource: !!a.isLiveDataSource, isOrderEnabled: !!a.isOrderEnabled,
      isCopyMaster: !!a.isCopyMaster, clientId: a.clientId ?? null,
      usableCapital: usable, initialCapital: r2(initialCapital), realizedPnl: r2(realizedPnl),
      capitalBase, capitalPct, availableCash: availableCash != null ? r2(availableCash) : null,
      chargesPaid: r2(Number(a.chargesPaid ?? 0)), deployed: r2(deployed),
      mode, modeLabel: mode, firstTradeDone: !!a.firstTradeDone,
      openPositions: openPos, openOrders: openOrd,
    })
    fundRows.push({
      accountId: a.id, label: a.label, brokerType: a.brokerType,
      cash: r2(initialCapital + realizedPnl - chargesTot * 0), // cash ≈ initial + realized (deployed tracked separately)
      initialCapital: r2(initialCapital), realizedPnl: r2(realizedPnl),
      chargesPaid: r2(Number(a.chargesPaid ?? 0)), deployed: r2(deployed),
    })
  }

  const unrealTotal = r2(perAccount.reduce((s: number, a) => s + Number(a.unrealized ?? 0), 0))
  const topSymbols = [...symbolPts.entries()]
    .map(([symbol, p]) => ({ symbol, pts: r2(p) }))
    .sort((x, y) => Math.abs(y.pts) - Math.abs(x.pts))
    .slice(0, 6)

  return {
    accounts: accRows,
    positions: posRows,
    orders: orderRows,
    trades: tradeRows,
    funds: fundRows,
    session: {
      winRate: closes > 0 ? r2((wins / closes) * 100) : null,
      pts: r2(pts),
      realized: r2(realizedTot),
      unrealized: unrealTotal,
      net: r2(realizedTot + unrealTotal),
      closes, wins,
      trades: perAccount.reduce((s: number, a) => s + Number(a.trades ?? 0), 0),
      charges: r2(chargesTot),
      perAccount,
      topSymbols,
    },
    sessionStart: new Date(istDayStartMs()).toISOString(),
    ts: Date.now(),
  }
}

function inferStep(strikes: number[]): number {
  if (strikes.length < 3) return 50
  const diffs = new Map<number, number>()
  for (let i = 1; i < strikes.length; i++) {
    const d = Math.round(strikes[i] - strikes[i - 1])
    if (d > 0) diffs.set(d, (diffs.get(d) ?? 0) + 1)
  }
  let best = 50, bestN = 0
  for (const [d, n] of diffs) if (n > bestN) { best = d; bestN = n }
  return best || 50
}

function optionCell(sym: string): SyncCoreRow {
  const st = S.states.get(sym)
  const ltp = st?.ltp ?? 0
  const prev = st?.prevClose ?? 0
  return {
    symbol: sym,
    exists: !!st,
    ltp: r2(ltp),
    prevClose: r2(prev),
    high: r2(st?.high ?? 0),
    low: r2(st?.low ?? 0),
    changePct: prev ? r2(((ltp - prev) / prev) * 100) : 0,
  }
}

function buildChainPayload(underlying: string, expiry: string | null): SyncCoreRow | null {
  const master = openRO(MASTER_DB_PATH)
  if (!master) return null
  let exp = expiry
  try {
    if (!exp) {
      const row = master.prepare(`
        SELECT MIN(expiry) AS e FROM SymbolMaster
        WHERE underlying = ? AND exchange = 'NFO' AND instrumentType IN ('CE','PE') AND expiry >= ?
      `).get(underlying, istDateStr()) as { e?: string | null } | undefined
      exp = row?.e ?? null
    }
    if (!exp) { master.close(); return null }
    const rows = master.prepare(`
      SELECT symbol, strike, optionType, lotSize FROM SymbolMaster
      WHERE underlying = ? AND exchange = 'NFO' AND instrumentType IN ('CE','PE') AND expiry = ?
      ORDER BY strike ASC
    `).all(underlying, exp) as { symbol: string; strike: number; optionType: string; lotSize: number }[]
    master.close()
    if (rows.length === 0) return null

    const spotState = S.states.get(underlying)
    const spot = spotState?.ltp ?? 0
    const prevClose = spotState?.prevClose ?? 0
    const strikes = [...new Set(rows.map(r => Number(r.strike)))]
    const step = inferStep(strikes)
    const ceAtm = Math.floor(spot / step) * step
    const peAtm = Math.ceil(spot / step) * step
    const lotSize = rows[0]?.lotSize ?? 1

    // payload budget: ATM ± 15 steps each side
    const lo = Math.min(ceAtm, peAtm) - 15 * step
    const hi = Math.max(ceAtm, peAtm) + 15 * step
    const byStrike = new Map<number, { ce?: SyncCoreRow; pe?: SyncCoreRow; lot: number }>()
    for (const r of rows) {
      const k = Number(r.strike)
      if (k < lo || k > hi) continue
      const e = byStrike.get(k) ?? { lot: r.lotSize }
      if (r.optionType === 'CE') e.ce = optionCell(r.symbol)
      else e.pe = optionCell(r.symbol)
      byStrike.set(k, e)
    }
    const outRows = [...byStrike.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([strike, e]) => ({
        strike,
        offset: 0,
        offsetCe: Math.round((strike - ceAtm) / step),
        offsetPe: Math.round((strike - peAtm) / step),
        ce: e.ce ?? { symbol: `${underlying}${exp!.replaceAll('-', '')}${strike}CE`, exists: false, ltp: 0, prevClose: 0, high: 0, low: 0, changePct: 0 },
        pe: e.pe ?? { symbol: `${underlying}${exp!.replaceAll('-', '')}${strike}PE`, exists: false, ltp: 0, prevClose: 0, high: 0, low: 0, changePct: 0 },
      }))

    return {
      meta: {
        underlying, exchange: 'NFO', spot: r2(spot), prevClose: r2(prevClose),
        atm: ceAtm, ceAtm, peAtm, step, lotSize, expiry: exp, expiries: [exp],
        strikesAvailable: strikes,
      },
      rows: outRows,
      atmCe: (() => { const r = outRows.find(o => o.strike === ceAtm); return r ? { ...r.ce, strike: r.strike } : null })(),
      atmPe: (() => { const r = outRows.find(o => o.strike === peAtm); return r ? { ...r.pe, strike: r.strike } : null })(),
      ts: Date.now(),
    }
  } catch {
    try { master.close() } catch { /* already closed */ }
    return null
  }
}

function buildIndexPayload(name: string): SyncCoreRow | null {
  const weights = INDEX_WEIGHTS[name]
  const base = S.states.get(name)
  if (!weights || !base) return null
  const constituents = weights.map(w => {
    const st = S.states.get(w.symbol)
    if (!st) return null
    const prev = st.prevClose
    const chgPts = prev ? r2(st.ltp - prev) : 0
    return {
      symbol: w.symbol, weight: w.weight,
      ltp: r2(st.ltp), high: r2(st.high), low: r2(st.low), vol: st.vol,
      chgPct: prev ? r2(((st.ltp - prev) / prev) * 100) : 0,
      pts: r2(chgPts * (w.weight / 100)),
    }
  }).filter(Boolean) as SyncCoreRow[]
  const totalPts = r2(constituents.reduce((s: number, c) => s + Number((c as { pts: number }).pts), 0))
  return {
    index: {
      symbol: name, name, ltp: r2(base.ltp), prevClose: r2(base.prevClose),
      high: r2(base.high), low: r2(base.low), vol: base.vol,
      chgPts: r2(base.ltp - base.prevClose),
      chgPct: base.prevClose ? r2(((base.ltp - base.prevClose) / base.prevClose) * 100) : 0,
    },
    constituents,
    totalPts,
    ts: Date.now(),
  }
}

// ============================================================
// sync:admin (2s) — the admin/dashboard data plane over the same
// websocket: feed engine health, per-account broker_logs tails,
// order audit, copy-trade config, strategies (+ log tails), GTT
// rules, auto rules, tick recorder + replay status, sync counts.
// Mirrors the REST aggregates so the UI can drop those polls.
// ============================================================
function buildAdminPayload(): SyncCoreRow | null {
  const master = openRO(MASTER_DB_PATH)
  if (!master) return null

  const acctRows: SyncCoreRow[] = []
  const sources: SyncCoreRow[] = [{ id: 'sim', label: 'Sim Feed (built-in)', brokerType: null, hasSession: false }]
  const logRows: SyncCoreRow[] = []
  try {
    const accounts = master.prepare(`
      SELECT id, label, brokerType, isActive, isOrderEnabled, credentialsEnc,
             (credentialsEnc IS NOT NULL AND credentialsEnc != '') AS hasCreds
      FROM BrokerAccount ORDER BY sortOrder ASC
    `).all() as SyncCoreRow[]
    master.close()

    for (const a of accounts) {
      // session presence = LIVE account (vs sandbox) — mirrors the /api/feed
      // sources so the FEED chip can badge LIVE/SANDBOX over the websocket
      const creds = decryptJson<{ sessionToken?: string; accessToken?: string; sessionId?: string }>((a as { credentialsEnc?: string }).credentialsEnc ?? null)
      const hasSession = !!(creds?.sessionToken || creds?.accessToken || creds?.sessionId)
      acctRows.push({ id: a.id, label: a.label, brokerType: a.brokerType, isActive: !!a.isActive, hasCreds: !!a.hasCreds, hasSession })
      sources.push({ id: String(a.id), label: String(a.label), brokerType: a.brokerType ?? null, hasSession })
      // per-account broker_logs tail (read-only) — feeds the Logs panel +
      // admin diagnostics without the 2s REST poll
      const bdb = openRO(path.join(FEED_PROJECT_ROOT, 'db', 'brokers', String(a.brokerType).toLowerCase(), `${a.id}.db`))
      if (bdb) {
        try {
          const logs = bdb.prepare('SELECT ts, level, message FROM broker_logs ORDER BY id DESC LIMIT 14').all() as { ts: string; level: string; message: string }[]
          for (const l of logs) {
            logRows.push({ ts: l.ts, level: l.level, message: l.message, accountId: a.id, accountLabel: a.label, brokerType: a.brokerType })
          }
        } catch { /* no logs table yet */ }
        bdb.close()
      }
    }
  } catch { try { master.close() } catch { /* already closed */ } return null }
  logRows.sort((x, y) => (String(x.ts) < String(y.ts) ? 1 : -1))

  // master-DB reads for the admin surfaces (fresh connection — the earlier
  // one was closed after the account scan)
  let copyTrade: SyncCoreRow | null = null
  let strategies: SyncCoreRow[] = []
  let audits: SyncCoreRow[] = []
  let counts = { symbols: 0, mappings: 0 }
  let lastSync: string | null = null
  const m2 = openRO(MASTER_DB_PATH)
  if (m2) {
    try {
      copyTrade = (m2.prepare('SELECT id, enabled, masterAccountId, capitalSharePct, slippagePct, roundToLot, skipFailedLegs, killSwitch FROM CopyTradeConfig LIMIT 1').get() as SyncCoreRow | undefined) ?? null
      strategies = m2.prepare(`SELECT id, name, enabled, status, exchange, symbol, direction, productType, orderType, qtyMode, fixedQty, capitalAmount, entryTime, entryWindowMin, exitTime, repeatDays, stopLossPct, targetPct, trailingSlPct, lastRunDate, entryPrice, realizedPnl FROM Strategy ORDER BY name ASC`).all() as SyncCoreRow[]
      const logTail = m2.prepare('SELECT strategyId, ts, level, message FROM StrategyLog ORDER BY ts DESC LIMIT 240').all() as { strategyId: string; ts: string; level: string; message: string }[]
      const logsBy = new Map<string, SyncCoreRow[]>()
      for (const l of logTail) {
        const arr = logsBy.get(l.strategyId) ?? []
        if (arr.length < 8) arr.push({ id: `${l.strategyId}-${l.ts}-${arr.length}`, ts: l.ts, level: l.level, message: l.message })
        logsBy.set(l.strategyId, arr)
      }
      for (const s of strategies) s.logs = logsBy.get(String(s.id)) ?? []
      audits = m2.prepare(`SELECT id, ts, source, action, masterSymbol, side, qty, status, message, legsJson FROM OrderAudit ORDER BY ts DESC LIMIT 30`).all() as SyncCoreRow[]
      const cs = m2.prepare('SELECT COUNT(*) AS n FROM SymbolMaster').get() as { n: number }
      const cm = m2.prepare('SELECT COUNT(*) AS n FROM SymbolMapping').get() as { n: number }
      counts = { symbols: Number(cs?.n ?? 0), mappings: Number(cm?.n ?? 0) }
      const ls = m2.prepare('SELECT ts FROM SyncLog ORDER BY ts DESC LIMIT 1').get() as { ts: string } | undefined
      lastSync = ls?.ts ?? null
    } catch { /* admin payload partials are fine */ }
    m2.close()
  }

  // JSON-file stores
  const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
  const gttRaw = readJson(path.join(FEED_PROJECT_ROOT, 'db', 'gtt.json')) as { rules?: SyncCoreRow[] } | null
  const autoRaw = readJson(path.join(FEED_PROJECT_ROOT, 'db', 'auto-rules.json')) as { rules?: SyncCoreRow[] } | null

  // in-process engine states (mirror the /feed-status + /replay-config REST)
  const lf = liveFeedStatus()
  const feed = {
    ...lf,
    sourceIsLive: lf.source !== 'sim',
    fresh: lf.lastTickTs != null && Date.now() - lf.lastTickTs < 15_000,
  }

  return {
    feed,
    feedSource: { source: feedSource, simDisabled, sources },
    accountsMeta: acctRows,
    brokerLogs: logRows.slice(0, 60),
    audit: audits,
    copyTrade,
    strategies,
    syncInfo: { lastSync, counts },
    gtt: gttRaw?.rules ?? [],
    autoRules: autoRaw?.rules ?? [],
    tickRecorder: { enabled: tickCfg.enabled, symbols: tickCfg.symbols, session: tickSessionInfo(), sessions: listTickSessions().slice(0, 12) },
    replay: replayStatus(),
    ts: Date.now(),
  }
}

// 1s sync loop — computes the core payload ONCE per tick and fans it out
// with per-socket chain/index payloads (based on each socket's sync:sub)
if (!hot.__feedTimers.sync) {
  let lastIdxAt = 0
  let lastIndexCache = new Map<string, SyncCoreRow | null>()
  let adminTick = 0
  let adminCache: SyncCoreRow | null = null
  hot.__feedTimers.sync = setInterval(() => {
    const sockets = [...io.sockets.sockets.values()] as unknown as { __syncSubs?: { chains: { underlying: string; expiry: string | null }[]; index: string[] }; emit: (ev: string, d: unknown) => void; id: string }[]
    if (sockets.length === 0) return
    // sync:admin every 2s (one computation, fanned to every socket)
    if (++adminTick % 2 === 0) {
      adminCache = buildAdminPayload()
      if (adminCache) for (const s of sockets) s.emit('sync:admin', adminCache)
    }
    const core = buildCorePayload()
    const idxFresh = Date.now() - lastIdxAt > 2000
    if (idxFresh) { lastIdxAt = Date.now(); lastIndexCache = new Map() }
    for (const s of sockets) {
      if (core) s.emit('sync:core', core)
      const subs = s.__syncSubs
      if (!subs) continue
      if (subs.chains) {
        for (const c of subs.chains) {
          const p = buildChainPayload(c.underlying, c.expiry)
          if (p) s.emit('sync:chain', p)
        }
      }
      if (subs.index) {
        for (const ix of subs.index) {
          if (!idxFresh && lastIndexCache.has(ix)) {
            const cached = lastIndexCache.get(ix)
            if (cached) s.emit('sync:index', cached)
            continue
          }
          const p = buildIndexPayload(ix)
          lastIndexCache.set(ix, p)
          if (p) s.emit('sync:index', p)
        }
      }
    }
  }, 1000)
}

// reload-probe 1792602789
