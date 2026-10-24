// @ts-nocheck
import { db } from '../db'
import type { Strategy } from '@prisma/client'
import { fetchQuotes } from '../../../brokers/feed-client'
import { placeMasterOrder } from './order-router'
import { getPositions } from '../../../brokers/database'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

// ============================================================
// Strategy engine — time-based entry/exit strategies executed
// across ALL copy-trading enabled accounts (auto-sized per
// account using its own capital house rules).
//
// Runs as a 1s scheduler inside the Next.js node process.
// Each strategy is also exported as a runnable Python file in
// /strategies (OpenAlgo-style python strategy host format).
// ============================================================

const g = globalThis as unknown as {
  __strategyTimer: ReturnType<typeof setInterval> | null
  __strategyPeak: Map<string, number>
}

export function istNow(): { hhmm: string; dateStr: string; weekday: number; ts: number } {
  const now = new Date()
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const hh = String(ist.getHours()).padStart(2, '0')
  const mm = String(ist.getMinutes()).padStart(2, '0')
  return {
    hhmm: `${hh}:${mm}`,
    dateStr: ist.toISOString().slice(0, 10),
    weekday: ist.getDay(), // 0 sun ... 6 sat
    ts: ist.getTime(),
  }
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function ensureStrategyScheduler() {
  if (g.__strategyTimer) return
  g.__strategyTimer = setInterval(() => {
    runSchedulerTick().catch(e => console.error('[strategy] tick error:', e))
  }, 1000)
  console.log('[strategy] scheduler started (1s tick)')
}

async function log(strategyId: string, message: string, level = 'INFO') {
  await db.strategyLog.create({ data: { strategyId, message, level } })
}

export async function runSchedulerTick() {
  const { hhmm, dateStr, weekday } = istNow()
  const nowMin = hhmmToMin(hhmm)

  const strategies = await db.strategy.findMany({ where: { enabled: true } })
  for (const s of strategies) {
    try {
      const repeatDays = s.repeatDays.split(',').map(d => Number(d.trim())).filter(n => !isNaN(n))
      const runsToday = repeatDays.length === 0 || repeatDays.includes(weekday)
      const enteredToday = s.lastRunDate === dateStr

      if (!runsToday) continue

      const entryMin = hhmmToMin(s.entryTime)
      const exitMin = hhmmToMin(s.exitTime)
      const windowMin = s.entryWindowMin || 10

      const quotes = await fetchQuotes([s.symbol])
      const ltp = quotes[s.symbol]?.ltp ?? 0

      // ----- ENTRY -----
      if (s.status === 'IDLE' || s.status === 'WAITING_ENTRY' || s.status === 'EXITED') {
        if (enteredToday) continue
        if (nowMin >= entryMin && nowMin <= entryMin + windowMin) {
          await enterStrategy(s, ltp, dateStr)
        }
        continue
      }

      // ----- MANAGE POSITION -----
      if (s.status === 'IN_POSITION' && s.entryPrice && ltp > 0) {
        // trailing peak tracking
        if (!g.__strategyPeak) g.__strategyPeak = new Map()
        const peak = g.__strategyPeak
        if (s.direction === 'LONG') {
          const prev = peak.get(s.id) ?? s.entryPrice
          peak.set(s.id, Math.max(prev, ltp))
        } else {
          const prev = peak.get(s.id) ?? s.entryPrice
          peak.set(s.id, Math.min(prev, ltp))
        }

        let exitReason: string | null = null
        const long = s.direction === 'LONG'
        const movePct = long
          ? ((ltp - s.entryPrice) / s.entryPrice) * 100
          : ((s.entryPrice - ltp) / s.entryPrice) * 100

        if (s.stopLossPct && movePct <= -s.stopLossPct) exitReason = `Stop loss hit (${movePct.toFixed(2)}%)`
        if (s.targetPct && movePct >= s.targetPct) exitReason = `Target hit (+${movePct.toFixed(2)}%)`
        if (s.trailingSlPct) {
          const ref = peak.get(s.id) ?? s.entryPrice
          const trailMove = long ? ((ref - ltp) / ref) * 100 : ((ltp - ref) / ref) * 100
          if (trailMove >= s.trailingSlPct && movePct > 0) exitReason = `Trailing SL (${trailMove.toFixed(2)}% off peak)`
        }
        if (nowMin >= exitMin) exitReason = `Scheduled exit time ${s.exitTime}`

        if (exitReason) await exitStrategy(s, ltp, exitReason)
      }

      // safety: scheduled exit even if IN_POSITION flag mismatched
      if (s.status === 'IN_POSITION' && nowMin >= exitMin + 5) {
        const ltp2 = (await fetchQuotes([s.symbol]))[s.symbol]?.ltp ?? 0
        await exitStrategy(s, ltp2, 'Forced scheduled exit')
      }
    } catch (e) {
      await db.strategy.update({ where: { id: s.id }, data: { status: 'ERROR' } }).catch(() => {})
      await log(s.id, `Engine error: ${e instanceof Error ? e.message : String(e)}`, 'ERROR').catch(() => {})
    }
  }
}

async function enterStrategy(s: Strategy, ltp: number, dateStr: string) {
  if (ltp <= 0) {
    await log(s.id, `Entry skipped — no LTP for ${s.symbol}`)
    return
  }
  await log(s.id, `ENTRY signal ${s.direction} ${s.symbol} @ ~${ltp} (time window ${s.entryTime})`)
  const res = await placeMasterOrder({
    symbol: s.symbol,
    exchange: s.exchange,
    side: s.direction === 'LONG' ? 'BUY' : 'SELL',
    qty: s.qtyMode === 'FIXED' ? s.fixedQty : 0, // 0 => auto-size per account capital rules
    orderType: s.orderType as 'MARKET' | 'LIMIT' | 'SL' | 'SL-M',
    productType: s.productType as 'MIS' | 'CNC' | 'NRML',
    limitPrice: s.limitPrice ?? undefined,
    source: 'STRATEGY',
    strategyId: s.id,
    tag: s.capitalAmount ? `abs:${s.capitalAmount}` : undefined,
  })
  const filled = res.legs.filter(l => l.status === 'FILLED')
  await db.strategy.update({
    where: { id: s.id },
    data: {
      status: filled.length > 0 ? 'IN_POSITION' : 'WAITING_ENTRY',
      lastRunDate: dateStr,
      entryOrderId: res.masterOrderId,
      entryPrice: res.avgFillPrice ?? ltp,
    },
  })
  if (!g.__strategyPeak) g.__strategyPeak = new Map()
  g.__strategyPeak.set(s.id, res.avgFillPrice ?? ltp)
  await log(s.id, `Entry order ${res.masterOrderId}: ${res.status} — ${res.message} | legs: ${res.legs.map(l => `${l.accountLabel}:${l.status}${l.qty ? 'x' + l.qty : ''}`).join(', ')}`, res.status === 'FAILED' ? 'WARN' : 'INFO')
}

async function exitStrategy(s: Strategy, ltp: number, reason: string) {
  await log(s.id, `EXIT: ${reason}`)
  // exit each account's open position at its own size
  const accounts = await db.brokerAccount.findMany({ where: { isActive: true, isOrderEnabled: true } })
  let anyExit = false
  for (const acc of accounts) {
    const pos = getPositions(acc.brokerType, acc.id).find(p => p.symbol === s.symbol && p.exchange === s.exchange && p.netQty !== 0)
    if (!pos) continue
    const lots = Math.abs(pos.netQty) / pos.lotSize
    const res = await placeMasterOrder({
      symbol: s.symbol,
      exchange: s.exchange,
      side: pos.netQty > 0 ? 'SELL' : 'BUY',
      qty: lots,
      orderType: 'MARKET',
      productType: pos.productType,
      source: 'STRATEGY',
      strategyId: s.id,
      legAccounts: [acc.id],
      reduceOnly: true,
    })
    if (res.legs.some(l => l.status === 'FILLED')) anyExit = true
    await log(s.id, `Exit leg ${acc.label}: ${res.legs.map(l => `${l.status}${l.qty ? ' x' + l.qty : ''}`).join(', ')} @ ${res.avgFillPrice ?? '-'}`)
  }
  const pnl = ltp && s.entryPrice ? (s.direction === 'LONG' ? ltp - s.entryPrice : s.entryPrice - ltp) : 0
  await db.strategy.update({
    where: { id: s.id },
    data: {
      status: anyExit ? 'EXITED' : 'WAITING_ENTRY',
      exitOrderId: anyExit ? `EX${Date.now().toString(36).toUpperCase()}` : null,
      realizedPnl: anyExit ? s.realizedPnl + pnl : s.realizedPnl,
    },
  })
  if (g.__strategyPeak) g.__strategyPeak.delete(s.id)
  await log(s.id, `Strategy ${anyExit ? 'exited' : 'exit pending'} — indicative move ₹${pnl.toFixed(2)}/unit`)
}

// ---------------- Python export ----------------

export function generatePythonCode(s: Strategy): string {
  return `"""
${s.name} — generated by Trading Terminal Python Strategy Builder
Time-based entry/exit strategy. Runs standalone or under an
OpenAlgo-style python strategy host.

    python3 ${strategyFileName(s)}

Requires: TERMINAL_URL + TERMINAL_TOKEN env (for live routing),
or attach your broker SDK in place_order() below.
"""
import time
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
TERMINAL_URL = "${'${TERMINAL_URL:-http://localhost:3000}'}"

STRATEGY = {
    "id": "${s.id}",
    "name": "${s.name}",
    "symbol": "${s.symbol}",
    "exchange": "${s.exchange}",
    "direction": "${s.direction}",
    "product_type": "${s.productType}",
    "order_type": "${s.orderType}",
    "qty_mode": "${s.qtyMode}",
    "fixed_qty": ${s.fixedQty},
    "capital_amount": ${s.capitalAmount ?? 'None'},
    "entry_time": "${s.entryTime}",
    "entry_window_min": ${s.entryWindowMin},
    "exit_time": "${s.exitTime}",
    "repeat_days": [${s.repeatDays}],
    "stop_loss_pct": ${s.stopLossPct ?? 'None'},
    "target_pct": ${s.targetPct ?? 'None'},
    "trailing_sl_pct": ${s.trailingSlPct ?? 'None'},
}


def resolve_symbol(symbol: str) -> str:
    """Resolve canonical master symbol -> broker symbol via master contracts."""
    import requests
    r = requests.get(f"{TERMINAL_URL}/api/symbols/resolve", params={"symbol": symbol}, timeout=5)
    return r.json().get("brokerSymbol", symbol)


def get_ltp(symbol: str) -> float:
    """Fetch last traded price from the market feed service."""
    import requests
    r = requests.get(f"{TERMINAL_URL}/api/market/ltp", params={"symbol": symbol}, timeout=5)
    return float(r.json().get("ltp", 0))


def place_order(symbol: str, side: str, qty: int, product: str) -> dict:
    """Route order through the terminal (fan-out to all enabled accounts,
    sized by each account's capital house rules)."""
    import requests
    payload = {"symbol": symbol, "exchange": STRATEGY["exchange"], "side": side,
               "qty": qty, "orderType": "MARKET", "productType": product, "source": "STRATEGY"}
    r = requests.post(f"{TERMINAL_URL}/api/orders", json=payload, timeout=10)
    return r.json()


def ist_hhmm() -> str:
    return datetime.now(IST).strftime("%H:%M")


def in_entry_window() -> bool:
    now = ist_hhmm()
    e_min = int(STRATEGY["entry_time"][:2]) * 60 + int(STRATEGY["entry_time"][3:])
    n_min = int(now[:2]) * 60 + int(now[3:])
    return e_min <= n_min <= e_min + STRATEGY["entry_window_min"]


def past_exit_time() -> bool:
    now = ist_hhmm()
    x_min = int(STRATEGY["exit_time"][:2]) * 60 + int(STRATEGY["exit_time"][3:])
    n_min = int(now[:2]) * 60 + int(now[3:])
    return n_min >= x_min


def run():
    print(f"[{{ist_hhmm()}}] starting {STRATEGY['name']} on {STRATEGY['symbol']}")
    in_position = False
    entry_price = 0.0
    peak = 0.0
    done_today = None

    while True:
        today = datetime.now(IST).strftime("%Y-%m-%d")
        weekday = datetime.now(IST).weekday() + 1  # engine uses 1=Mon..5=Fri
        if weekday not in STRATEGY["repeat_days"]:
            time.sleep(30)
            continue

        ltp = get_ltp(STRATEGY["symbol"])
        hhmm = ist_hhmm()
        print(f"[{{hhmm}}] {{STRATEGY['symbol']}} LTP={{ltp}} pos={{in_position}}")

        # ---- entry ----
        if not in_position and done_today != today and in_entry_window():
            qty = STRATEGY["fixed_qty"] if STRATEGY["qty_mode"] == "FIXED" else 0  # 0 = auto-size by capital rules
            res = place_order(STRATEGY["symbol"], "BUY" if STRATEGY["direction"] == "LONG" else "SELL", qty, STRATEGY["product_type"])
            print(f"[{{hhmm}}] entry -> {{res}}")
            entry_price = res.get("avgFillPrice") or ltp
            peak = entry_price
            in_position = res.get("status") in ("SUCCESS", "PARTIAL")
            done_today = today

        # ---- manage ----
        if in_position and ltp > 0:
            peak = max(peak, ltp) if STRATEGY["direction"] == "LONG" else min(peak, ltp)
            move = ((ltp - entry_price) / entry_price * 100) if STRATEGY["direction"] == "LONG" \\
                   else ((entry_price - ltp) / entry_price * 100)
            reason = None
            if STRATEGY.get("stop_loss_pct") and move <= -STRATEGY["stop_loss_pct"]:
                reason = "stop-loss"
            if STRATEGY.get("target_pct") and move >= STRATEGY["target_pct"]:
                reason = "target"
            if STRATEGY.get("trailing_sl_pct") and move > 0:
                trail = ((peak - ltp) / peak * 100) if STRATEGY["direction"] == "LONG" else ((ltp - peak) / peak * 100)
                if trail >= STRATEGY["trailing_sl_pct"]:
                    reason = "trailing-sl"
            if past_exit_time():
                reason = "scheduled exit"
            if reason:
                res = place_order(STRATEGY["symbol"], "SELL" if STRATEGY["direction"] == "LONG" else "BUY", 0, STRATEGY["product_type"])
                print(f"[{{hhmm}}] exit ({{reason}}) -> {{res}}")
                in_position = False

        time.sleep(1)


if __name__ == "__main__":
    run()
`
}

export function strategyFileName(s: Strategy): string {
  const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `${s.id.slice(0, 8)}_${slug}.py`
}

export function exportStrategyFile(s: Strategy) {
  try {
    const dir = path.join(process.cwd(), 'strategies')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = path.join(dir, strategyFileName(s))
    writeFileSync(file, generatePythonCode(s), 'utf8')
    return file
  } catch {
    return null
  }
}
