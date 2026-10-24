// @ts-nocheck
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { BrokerOrderRecord, BrokerTradeRecord, PositionRecord, ChargesBreakdown } from '../src/lib/types'

// ============================================================
// Per-broker-account SQLite databases (mirrors OpenAlgo's
// multiple-database layout). Each broker account gets its own
// isolated DB file: db/brokers/{brokerType}/{accountId}.db
// holding orders, trades, positions and the funds ledger.
// ============================================================

const DB_ROOT = path.join(process.cwd(), 'db', 'brokers')

function dbPathFor(brokerType: string, accountId: string): string {
  const dir = path.join(DB_ROOT, brokerType.toLowerCase())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return path.join(dir, `${accountId}.db`)
}

const g = globalThis as unknown as { __brokerDbs: Map<string, DatabaseSync> }
if (!g.__brokerDbs) g.__brokerDbs = new Map()

function getDb(brokerType: string, accountId: string): DatabaseSync {
  const key = `${brokerType}:${accountId}`
  let db = g.__brokerDbs.get(key)
  if (!db) {
    db = new DatabaseSync(dbPathFor(brokerType, accountId))
    db.exec('PRAGMA journal_mode = WAL;')
    migrate(db)
    g.__brokerDbs.set(key, db)
  }
  return db
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      master_order_id TEXT,
      strategy_id TEXT,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      instrument_type TEXT,
      side TEXT NOT NULL,
      qty INTEGER NOT NULL,
      filled_qty INTEGER DEFAULT 0,
      order_type TEXT NOT NULL,
      product_type TEXT NOT NULL,
      limit_price REAL,
      trigger_price REAL,
      status TEXT NOT NULL,
      avg_price REAL,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      instrument_type TEXT,
      product_type TEXT,
      side TEXT NOT NULL,
      qty INTEGER NOT NULL,
      price REAL NOT NULL,
      value REAL NOT NULL,
      charges_total REAL NOT NULL DEFAULT 0,
      charges_json TEXT,
      realized_pnl REAL DEFAULT 0,
      ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      instrument_type TEXT,
      product_type TEXT NOT NULL,
      net_qty INTEGER NOT NULL DEFAULT 0,
      buy_qty INTEGER NOT NULL DEFAULT 0,
      sell_qty INTEGER NOT NULL DEFAULT 0,
      avg_price REAL NOT NULL DEFAULT 0,
      realized_pnl REAL NOT NULL DEFAULT 0,
      ltp REAL NOT NULL DEFAULT 0,
      lot_size INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (symbol, exchange, product_type)
    );
    CREATE TABLE IF NOT EXISTS funds (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cash REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS broker_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'INFO',
      message TEXT NOT NULL
    );
  `)
}

export function logBroker(brokerType: string, accountId: string, message: string, level = 'INFO') {
  const db = getDb(brokerType, accountId)
  db.prepare('INSERT INTO broker_logs (ts, level, message) VALUES (?, ?, ?)').run(new Date().toISOString(), level, message)
}

export function getBrokerLogs(brokerType: string, accountId: string, limit = 100) {
  const db = getDb(brokerType, accountId)
  return db.prepare('SELECT * FROM broker_logs ORDER BY id DESC LIMIT ?').all(limit) as unknown as { id: number; ts: string; level: string; message: string }[]
}

// ---------------- Orders ----------------
export function insertOrder(brokerType: string, accountId: string, o: BrokerOrderRecord & { instrumentType?: string; strategyId?: string }) {
  const db = getDb(brokerType, accountId)
  db.prepare(`INSERT INTO orders (id, master_order_id, strategy_id, symbol, exchange, instrument_type, side, qty, filled_qty, order_type, product_type, limit_price, trigger_price, status, avg_price, message, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.id, o.masterOrderId ?? null, o.strategyId ?? null, o.symbol, o.exchange, o.instrumentType ?? null,
    o.side, o.qty, o.filledQty, o.orderType, o.productType, o.limitPrice ?? null, o.triggerPrice ?? null,
    o.status, o.avgPrice ?? null, o.message ?? null, o.createdAt, o.updatedAt,
  )
}

export function updateOrder(brokerType: string, accountId: string, orderId: string, patch: Partial<BrokerOrderRecord>) {
  const db = getDb(brokerType, accountId)
  const sets: string[] = []
  const vals: (string | number | null)[] = []
  const map: Record<string, string> = { status: 'status', filledQty: 'filled_qty', avgPrice: 'avg_price', message: 'message', masterOrderId: 'master_order_id' }
  for (const [k, col] of Object.entries(map)) {
    if (patch[k as keyof BrokerOrderRecord] !== undefined) {
      sets.push(`${col} = ?`)
      vals.push(patch[k as keyof BrokerOrderRecord] as string | number)
    }
  }
  sets.push('updated_at = ?')
  vals.push(new Date().toISOString())
  vals.push(orderId)
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function getOrders(brokerType: string, accountId: string, limit = 200): BrokerOrderRecord[] {
  const db = getDb(brokerType, accountId)
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Record<string, unknown>[]
  return rows.map(r => ({
    id: r.id as string,
    masterOrderId: (r.master_order_id as string) ?? undefined,
    strategyId: (r.strategy_id as string) ?? undefined,
    symbol: r.symbol as string,
    exchange: r.exchange as string,
    side: r.side as BrokerOrderRecord['side'],
    qty: r.qty as number,
    filledQty: r.filled_qty as number,
    orderType: r.order_type as BrokerOrderRecord['orderType'],
    productType: r.product_type as BrokerOrderRecord['productType'],
    limitPrice: (r.limit_price as number) ?? undefined,
    triggerPrice: (r.trigger_price as number) ?? undefined,
    status: r.status as string,
    avgPrice: (r.avg_price as number) ?? undefined,
    message: (r.message as string) ?? undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }))
}

export function getOpenOrders(brokerType: string, accountId: string): BrokerOrderRecord[] {
  return getOrders(brokerType, accountId, 500).filter(o => o.status === 'OPEN')
}

// ---------------- Trades ----------------
export function insertTrade(brokerType: string, accountId: string, t: BrokerTradeRecord & { instrumentType?: string; productType?: string }) {
  const db = getDb(brokerType, accountId)
  db.prepare(`INSERT INTO trades (id, order_id, symbol, exchange, instrument_type, product_type, side, qty, price, value, charges_total, charges_json, realized_pnl, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    t.id, t.orderId, t.symbol, t.exchange, t.instrumentType ?? null, t.productType ?? null,
    t.side, t.qty, t.price, t.value, t.chargesTotal, JSON.stringify(t.charges), t.realizedPnl ?? 0, t.ts,
  )
}

export function getTrades(brokerType: string, accountId: string, limit = 200): (BrokerTradeRecord & { instrumentType?: string; productType?: string })[] {
  const db = getDb(brokerType, accountId)
  const rows = db.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT ?').all(limit) as unknown as Record<string, unknown>[]
  return rows.map(r => ({
    id: r.id as string,
    orderId: r.order_id as string,
    symbol: r.symbol as string,
    exchange: r.exchange as string,
    instrumentType: (r.instrument_type as string) ?? undefined,
    productType: (r.product_type as string) ?? undefined,
    side: r.side as BrokerTradeRecord['side'],
    qty: r.qty as number,
    price: r.price as number,
    value: r.value as number,
    chargesTotal: r.charges_total as number,
    charges: JSON.parse((r.charges_json as string) || '{}') as ChargesBreakdown,
    realizedPnl: (r.realized_pnl as number) ?? undefined,
    ts: r.ts as string,
  }))
}

// ---------------- Positions ----------------
export function upsertPosition(brokerType: string, accountId: string, p: PositionRecord & { instrumentType?: string }) {
  const db = getDb(brokerType, accountId)
  db.prepare(`INSERT INTO positions (symbol, exchange, instrument_type, product_type, net_qty, buy_qty, sell_qty, avg_price, realized_pnl, ltp, lot_size, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol, exchange, product_type) DO UPDATE SET
      net_qty=excluded.net_qty, buy_qty=excluded.buy_qty, sell_qty=excluded.sell_qty,
      avg_price=excluded.avg_price, realized_pnl=excluded.realized_pnl, ltp=excluded.ltp,
      lot_size=excluded.lot_size, instrument_type=excluded.instrument_type, updated_at=excluded.updated_at`).run(
    p.symbol, p.exchange, p.instrumentType ?? null, p.productType, p.netQty, p.buyQty, p.sellQty,
    p.avgPrice, p.realizedPnl, p.ltp, p.lotSize, p.updatedAt,
  )
}

export function getPositions(brokerType: string, accountId: string): (PositionRecord & { instrumentType?: string })[] {
  const db = getDb(brokerType, accountId)
  const rows = db.prepare('SELECT * FROM positions').all() as unknown as Record<string, unknown>[]
  return rows.map(r => ({
    symbol: r.symbol as string,
    exchange: r.exchange as string,
    instrumentType: (r.instrument_type as string) ?? undefined,
    productType: r.product_type as PositionRecord['productType'],
    netQty: r.net_qty as number,
    buyQty: r.buy_qty as number,
    sellQty: r.sell_qty as number,
    avgPrice: r.avg_price as number,
    realizedPnl: r.realized_pnl as number,
    ltp: r.ltp as number,
    unrealizedPnl: 0,
    lotSize: r.lot_size as number,
    updatedAt: r.updated_at as string,
  }))
}

export function deletePosition(brokerType: string, accountId: string, symbol: string, exchange: string, productType: string) {
  const db = getDb(brokerType, accountId)
  db.prepare('DELETE FROM positions WHERE symbol = ? AND exchange = ? AND product_type = ?').run(symbol, exchange, productType)
}

// ---------------- Funds ----------------
export function setCash(brokerType: string, accountId: string, cash: number) {
  const db = getDb(brokerType, accountId)
  db.prepare(`INSERT INTO funds (id, cash, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET cash = excluded.cash, updated_at = excluded.updated_at`).run(cash, new Date().toISOString())
}

export function getCash(brokerType: string, accountId: string): number {
  const db = getDb(brokerType, accountId)
  const row = db.prepare('SELECT cash FROM funds WHERE id = 1').get() as { cash: number } | undefined
  return row?.cash ?? 0
}
