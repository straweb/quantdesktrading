// @ts-nocheck
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { db } from '../db'
import { placeMasterOrder } from './order-router'

// ============================================================
// Python strategy runner (backend tool).
// Runs user python code in a short-lived subprocess. The prelude
// injects a tiny SDK:
//   get_candles(symbol, tf, limit) — OHLCV from the feed service
//   get_quote(symbol)              — live quote (ws-backed engine)
//   log(...)                       — streamed to the run console
//   signal(side, qty?, price?, msg?) — fires a REAL master order
//                                      (fan-out to all enabled
//                                      accounts) unless dryRun
// Data comes from the same websocket-fed engine the terminal
// uses (REST on :3004), so strategies see the live tape.
// ============================================================

const RUNS_DIR = path.join(process.cwd(), 'db', 'pyruns')
const FEED_REST = process.env.FEED_REST_URL || 'http://localhost:3004'

export interface PythonSignal { ts: string; symbol: string; side: string; qty?: number; price?: number; message?: string }

export interface PythonRunResult {
  ok: boolean
  runId: string
  logs: string[]
  signals: PythonSignal[]
  ordersPlaced: number
  error?: string
  ms: number
}

const PRELUDE = `import json, sys, urllib.request
FEED = "${FEED_REST}"
def _get(path):
    with urllib.request.urlopen(FEED + path, timeout=4) as r:
        return json.loads(r.read())
def get_candles(symbol="NIFTY", tf="5m", limit=200):
    """OHLCV candles: [{t,o,h,l,c,v}] — live websocket-fed engine."""
    return _get("/candles?symbol=%s&tf=%s&limit=%d" % (symbol, tf, limit)).get("candles", [])
def get_quote(symbol="NIFTY"):
    """Live quote: {ltp, prevClose, open, high, low, vol, bid, ask}."""
    return _get("/quote?symbol=%s" % symbol)
def log(*a):
    print(json.dumps({"type": "log", "msg": " ".join(str(x) for x in a)}), flush=True)
def signal(side, qty=None, price=None, msg="", symbol=None):
    """Fire an order — side BUY/SELL, qty in lots (None = capital-sized)."""
    print(json.dumps({"type": "signal", "side": side, "qty": qty, "price": price, "msg": msg, "symbol": symbol or SYMBOL}), flush=True)
`

function cleanupOldRuns(): void {
  try {
    if (readdirSync(RUNS_DIR).length <= 40) return
    const files = readdirSync(RUNS_DIR).map(f => ({ f, m: statSync(path.join(RUNS_DIR, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m).slice(0, 20)
    for (const x of files) { try { unlinkSync(path.join(RUNS_DIR, x.f)) } catch { /* ignore */ } }
  } catch { /* ignore */ }
}

export async function runPythonStrategy(opts: {
  code: string
  symbol?: string
  tf?: string
  bars?: number
  dryRun?: boolean
  timeoutMs?: number
}): Promise<PythonRunResult> {
  const runId = `py${Date.now().toString(36)}`
  const started = Date.now()
  const logs: string[] = []
  const signals: PythonSignal[] = []
  let ordersPlaced = 0

  mkdirSync(RUNS_DIR, { recursive: true })
  cleanupOldRuns()
  const file = path.join(RUNS_DIR, `${runId}.py`)
  // symbol/tf/bars become friendly defaults the script can pre-load
  const header = `# auto-run ${new Date().toISOString()} · symbol=${opts.symbol ?? 'NIFTY'} tf=${opts.tf ?? '5m'} bars=${opts.bars ?? 200}\nSYMBOL = ${JSON.stringify(opts.symbol ?? 'NIFTY')}\nTF = ${JSON.stringify(opts.tf ?? '5m')}\nBARS = ${Number(opts.bars ?? 200)}\n`
  writeFileSync(file, PRELUDE + header + '\n# ---- user strategy code ----\n' + (opts.code || ''))

  return await new Promise<PythonRunResult>((resolve) => {
    const child = spawn('python3', [file], { cwd: process.cwd(), env: { ...process.env, PYTHONUNBUFFERED: '1' } })
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) { child.kill('SIGKILL'); err += '\n[runner] timed out after 20s' }
    }, opts.timeoutMs ?? 20_000)

    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { unlinkSync(file) } catch { /* ignore */ }
      resolve({
        ok: err.trim() === '',
        runId,
        logs: logs.slice(-300),
        signals,
        ordersPlaced,
        error: err.trim() || undefined,
        ms: Date.now() - started,
      })
    }

    const pending = new Set<Promise<void>>()
    const handleLine = async (raw: string) => {
      const line = raw.trim()
      if (!line) return
      const job = (async () => {
      try {
        const msg = JSON.parse(line) as { type?: string; msg?: string; side?: string; qty?: number; price?: number; symbol?: string }
        if (msg.type === 'signal') {
          const side = (msg.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY'
          const sig: PythonSignal = { ts: new Date().toISOString(), symbol: msg.symbol || opts.symbol || 'NIFTY', side, qty: msg.qty, price: msg.price, message: msg.msg }
          signals.push(sig)
          logs.push(`▸ SIGNAL ${side} ${sig.symbol}${msg.qty ? ` ×${msg.qty} lots` : ''}${msg.price ? ` @ ${msg.price}` : ''}${msg.msg ? ` — ${msg.msg}` : ''}`)
          if (!opts.dryRun) {
            try {
              const res = await placeMasterOrder({
                symbol: sig.symbol,
                exchange: 'NFO',
                side,
                qty: msg.qty && msg.qty > 0 ? msg.qty : 0,
                orderType: 'MARKET',
                productType: 'MIS',
                source: 'PYTHON',
                strategyId: runId,
                ...(msg.qty && msg.qty > 0 ? {} : { capitalPct: 25 }),
              })
              ordersPlaced += res.legs.filter(l => l.status === 'FILLED').length
              logs.push(`  order ${res.status} — ${res.legs.filter(l => l.status === 'FILLED').length}/${res.legs.length} account fills${res.message ? ` (${res.message})` : ''}`)
            } catch (e) {
              logs.push(`  order failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          } else {
            logs.push('  (dry run — no order placed)')
          }
        } else {
          logs.push(String(msg.msg ?? line))
        }
      } catch {
        logs.push(line) // plain python print
      }
      })()
      pending.add(job)
      await job.finally(() => pending.delete(job))
    }

    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) void handleLine(l)
    })
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e: Error) => { err += `\n[runner] spawn failed: ${e.message}` })
    child.on('close', () => {
      const tail = buf.trim() ? handleLine(buf) : Promise.resolve()
      // wait for in-flight order placements so the run result includes them
      void Promise.all([tail, ...pending]).then(() => finish())
    })
  })
}

/** Persist a run's outcome for the strategy page history (best-effort). */
export async function recordPythonRun(strategyId: string | null, r: PythonRunResult, code: string): Promise<void> {
  try {
    if (strategyId) {
      await db.strategyLog.create({
        data: {
          strategyId,
          level: r.ok ? 'INFO' : 'ERROR',
          message: `python run ${r.runId}: ${r.signals.length} signal(s), ${r.ordersPlaced} fills, ${r.ms}ms${r.error ? ` — ${r.error.slice(0, 200)}` : ''}`,
        },
      })
    }
    void code
  } catch { /* logging is best-effort */ }
}
