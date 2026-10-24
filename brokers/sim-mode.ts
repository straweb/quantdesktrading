// @ts-nocheck
// ============================================================
// GLOBAL LIVE-ONLY MODE (admin checkbox).
//
// When enabled (db/feed-source.json `simDisabled: true`):
//   • the feed service stops the sim random-walk entirely —
//     charts/watchlists show REAL data only (or nothing)
//   • broker adapters REFUSE sandbox fills (orders without a live
//     broker session are REJECTED, never simulated)
//
// Read by the Next.js server (adapters/order router) and shared
// semantics with the Bun feed service (same JSON file).
// ============================================================

import { readFileSync, existsSync } from 'fs'
import path from 'path'

export interface SimModeState {
  simDisabled: boolean
  source: string
  ts: number
}

let cache: SimModeState | null = null
const TTL = 3000

function candidates(): string[] {
  // Next.js server cwd = project root; some dev proxies run deeper — probe both
  return [
    path.resolve(process.cwd(), 'db/feed-source.json'),
    path.resolve(process.cwd(), '../../db/feed-source.json'),
  ]
}

export function readFeedSourceFile(): { source?: string; simDisabled?: boolean; updatedAt?: string } {
  for (const p of candidates()) {
    try {
      if (!existsSync(p)) continue
      return JSON.parse(readFileSync(p, 'utf8')) as { source?: string; simDisabled?: boolean; updatedAt?: string }
    } catch { /* try next */ }
  }
  return {}
}

/** true when the admin disabled the sim feed + sandbox fills (Live-Only mode) */
export function isSimDisabled(): boolean {
  const now = Date.now()
  if (cache && now - cache.ts < TTL) return cache.simDisabled
  const raw = readFeedSourceFile()
  cache = { simDisabled: raw.simDisabled === true, source: raw.source ?? 'sim', ts: now }
  return cache.simDisabled
}

export function feedSourceId(): string {
  if (cache && Date.now() - cache.ts < TTL) return cache.source
  isSimDisabled()
  return cache?.source ?? 'sim'
}
