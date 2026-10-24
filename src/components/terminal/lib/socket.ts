'use client'

import { io, type Socket } from 'socket.io-client'
import type { Tick } from '@/lib/types'

// Singleton socket.io client for the Python market hub (FastAPI :8001).
// Browser always connects through the Caddy gateway via XTransformPort.
//
// Wire protocol (Python Hub):
//   emit  'sub'   {symbols: [...]}        (quantdesk called this 'subscribe')
//   emit  'unsub' {symbols: [...]}
//   on    'tick'  single tick (snake_case) -> converted to camelCase Tick
//         and fanned out to every onTicks listener.

type TickListener = (ticks: Record<string, Tick>) => void

const g = globalThis as unknown as {
  __ztermSocket: Socket | null
  __ztermListeners: Set<TickListener>
  __ztermSubs: Set<string>
  __ztermStatus: Set<(up: boolean) => void>
  __ztermLastTicks: Record<string, Tick>
}

if (!g.__ztermSocket) {
  g.__ztermSocket = null
  g.__ztermListeners = new Set()
  g.__ztermSubs = new Set()
  g.__ztermStatus = new Set()
  g.__ztermLastTicks = {}
}

/** Tick TTL — entries older than this drop out of the fanout map so a
 *  feed-source switch (server purges its tick cache) never leaves stale
 *  prices lingering in UI maps that replace state wholesale (watchlist). */
const TICK_TTL_MS = 6000

function fanoutMap(t: Tick): Record<string, Tick> {
  const now = Date.now()
  const acc = g.__ztermLastTicks
  // prune stale entries (cheap amortized: only when the map grows)
  const keys = Object.keys(acc)
  if (keys.length > 24) {
    for (const k of keys) {
      if (now - (acc[k]?.ts ?? 0) > TICK_TTL_MS) delete acc[k]
    }
  }
  acc[t.symbol] = t
  const bare = t.symbol.includes(':') ? t.symbol.split(':')[1] : null
  if (bare) acc[bare] = t
  return acc
}

/** Hub tick (snake_case) -> UI Tick (camelCase). */
function toTick(raw: Record<string, unknown>): Tick {
  return {
    symbol: String(raw.symbol ?? ''),
    ltp: Number(raw.ltp ?? 0),
    prevClose: Number(raw.prev_close ?? raw.prevClose ?? 0),
    open: Number(raw.open ?? 0),
    high: Number(raw.high ?? 0),
    low: Number(raw.low ?? 0),
    vol: Number(raw.vol ?? 0),
    bid: raw.bid != null ? Number(raw.bid) : undefined,
    ask: raw.ask != null ? Number(raw.ask) : undefined,
    ts: Number(raw.ts ?? Date.now()),
  }
}

export function onTicks(fn: TickListener): () => void {
  g.__ztermListeners.add(fn)
  return () => g.__ztermListeners.delete(fn)
}

export function onFeedStatus(fn: (up: boolean) => void): () => void {
  g.__ztermStatus.add(fn)
  fn(!!g.__ztermSocket?.connected)
  return () => g.__ztermStatus.delete(fn)
}

export function subscribeTicks(symbols: string[]) {
  const added = symbols.filter(s => !g.__ztermSubs.has(s))
  added.forEach(s => g.__ztermSubs.add(s))
  g.__ztermSocket?.emit('sub', { symbols: added })
}

export function unsubscribeTicks(symbols: string[]) {
  symbols.forEach(s => g.__ztermSubs.delete(s))
  g.__ztermSocket?.emit('unsub', { symbols })
}

/**
 * Resolve the socket.io URL for the current origin:
 *  - Caddy gateway (:81 / :80 / same-origin prod): '/?XTransformPort=8001'
 *    (Caddy routes by the XTransformPort query, WebSocket-upgrade aware).
 *  - Next.js dev / direct :3000: Next cannot proxy WS upgrades — connect
 *    straight to the Python WS port 8001 (CORS is open on the hub).
 */
function hubUrl(): string {
  if (typeof window === 'undefined') return '/?XTransformPort=8001'
  const { protocol, hostname, port } = window.location
  if (port === '3000' || port === '3001') {
    return `${protocol}//${hostname}:8001`
  }
  return '/?XTransformPort=8001'
}

export function ensureSocket(): Socket {
  if (g.__ztermSocket?.connected) return g.__ztermSocket
  if (g.__ztermSocket) return g.__ztermSocket

  const socket = io(hubUrl(), {
    path: '/',
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1500,
    timeout: 10000,
  })

  socket.on('connect', () => {
    // resubscribe everything after (re)connect
    if (g.__ztermSubs.size) socket.emit('sub', { symbols: [...g.__ztermSubs] })
    g.__ztermStatus.forEach(fn => fn(true))
  })
  socket.on('disconnect', () => g.__ztermStatus.forEach(fn => fn(false)))
  socket.on('connect_error', () => g.__ztermStatus.forEach(fn => fn(false)))

  socket.on('tick', (raw: Record<string, unknown>) => {
    if (!raw || !raw.symbol) return
    const t = toTick(raw)
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __qdLastTick?: unknown; __qdTickCount?: number }
      w.__qdLastTick = t
      w.__qdTickCount = (w.__qdTickCount ?? 0) + 1
    }
    const map = fanoutMap(t)
    g.__ztermListeners.forEach(fn => {
      try { fn(map) } catch (e) { console.error('[qd] tick listener error', e) }
    })
  })

  // Round-26: when the hub purges (feed-source switch / Live-Only toggle) it
  // bumps the epoch — every client-side market-data holder must drop its
  // cached ticks IMMEDIATELY so sim data can never linger under a live source.
  const purgeLocalTicks = () => {
    g.__ztermLastTicks = {}
    g.__ztermListeners.forEach(fn => {
      try { fn({}) } catch { /* listener guards itself */ }
    })
  }
  socket.on('feed:epoch', purgeLocalTicks)
  socket.on('feed:source', purgeLocalTicks)

  g.__ztermSocket = socket
  return socket
}
