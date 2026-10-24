// @ts-nocheck
// ============================================================
// Tiny TTL micro-cache for hot REST paths (OpenAlgo-style speed).
//
// The UI fires several concurrent requests for the same payload
// (chart open, watchlist focus, depth panel, funds chips). Without
// a cache every one of them walked the full proxy → feed-service →
// broker round-trip. This cache:
//   · serves repeated reads from memory within the TTL
//   · coalesces concurrent misses into ONE loader (inflight dedupe)
//   · never grows: entries expire and the map is swept opportunistically
// Correctness: TTLs are deliberately SHORT (sub-second to seconds) —
// they remove duplicate work, they never serve stale market data
// beyond one UI interaction.
// ============================================================

interface Entry<T> { v: T; exp: number }

const store = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

function sweep(): void {
  if (store.size < 512) return
  const now = Date.now()
  for (const [k, e] of store) if (e.exp < now) store.delete(k)
}

/** get-or-load with TTL + inflight dedupe. loader failures are NOT cached. */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.exp > now) return hit.v
  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending
  const p = (async () => {
    try {
      const v = await loader()
      store.set(key, { v, exp: Date.now() + ttlMs })
      return v
    } finally {
      inflight.delete(key)
      sweep()
    }
  })()
  inflight.set(key, p)
  return p
}

/** drop one key (or every entry when omitted) — used by purge paths */
export function invalidate(key?: string): void {
  if (key) store.delete(key)
  else store.clear()
}
