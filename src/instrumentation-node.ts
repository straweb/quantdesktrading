// @ts-nocheck
// Node-only instrumentation logic — imported ONLY from register() behind
// the NEXT_RUNTIME === 'nodejs' check so the Edge instrumentation bundle
// never includes node:crypto / child_process (that used to print an
// "unsupported in Edge Runtime" warning on every request and flooded
// dev.log at ~1MB/min, which grew the file to 76MB and broke the
// platform workspace archiver).
export async function registerNode() {
  const { bootstrap } = await import('./lib/services/bootstrap-service')
  const { ensureStrategyScheduler } = await import('./lib/services/strategy-engine')
  const { ensureOrderMonitor } = await import('./lib/services/order-monitor')
  const { ensureAutoRuleEngine } = await import('./lib/services/auto-rules-service')
  const { ensureGttEngine } = await import('./lib/services/gtt-service')

  bootstrap()
    .then(() => console.log('[instrumentation] bootstrap complete'))
    .catch(e => console.error('[instrumentation] bootstrap error:', e))

  ensureStrategyScheduler()
  ensureOrderMonitor()
  ensureAutoRuleEngine()
  ensureGttEngine()
  await ensureLiveOrderSync()
  ensureFeedWatchdog()
  ;(await import('./lib/services/funds-sync')).ensureFundsSync()
  // broker sessions are persisted in the master DB — restore/validate them
  // at boot (and every 60s) so a page refresh or restart never re-connects
  ;(await import('./lib/services/session-restore')).ensureSessionRestore()
}

/** Reconcile live broker OPEN orders against real broker order books. */
async function ensureLiveOrderSync() {
  const m = await import('./lib/services/live-order-sync')
  m.ensureLiveOrderSync()
}

/** Respawn the market-feed mini-service if :3004 goes dark, then re-push the
 *  symbol universe (a fresh feed only knows the default 8-symbol universe). */
function ensureFeedWatchdog() {
  const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
  const g = globalThis as unknown as { __feedWatchBusy?: boolean; __feedWatchTimer?: ReturnType<typeof setInterval> }
  if (g.__feedWatchTimer) return // hot-reload safe: single owner

  async function feedHealthy(): Promise<boolean> {
    try {
      const r = await fetch(`${FEED_URL}/health`, { signal: AbortSignal.timeout(1500), cache: 'no-store' })
      return r.ok
    } catch {
      return false
    }
  }

  g.__feedWatchTimer = setInterval(() => {
    if (g.__feedWatchBusy) return
    void (async () => {
      // universe guard: a manually/restarted feed only knows the default
      // 9-symbol universe — republish the master contracts when it shrinks
      try {
        const h = await fetch(`${FEED_URL}/health`, { signal: AbortSignal.timeout(1500), cache: 'no-store' })
        if (h.ok) {
          const j = (await h.json()) as { symbols?: number }
          if ((j.symbols ?? 0) > 0 && (j.symbols ?? 0) < 400 && !g.__feedWatchBusy) {
            const { db } = await import('./lib/db')
            const { publishUniverseToFeed } = await import('./lib/services/symbol-service')
            const rows = await db.symbolMaster.findMany({
              select: { symbol: true, basePrice: true, lotSize: true, instrumentType: true },
            })
            await publishUniverseToFeed(rows)
            console.log(`[instrumentation] feed universe republished (${rows.length} symbols — was ${j.symbols})`)
          }
        }
      } catch { /* health check failed — respawn path handles it */ }
      if (await feedHealthy()) return
      g.__feedWatchBusy = true
      console.warn('[instrumentation] market-feed :3004 down — respawning…')
      try {
        const { spawn } = await import('child_process')
        const path = await import('path')
        const child = spawn('bun', ['--hot', 'index.ts'], {
          cwd: path.join(process.cwd(), 'mini-services', 'market-feed'),
          detached: true,
          stdio: 'inherit',
          // the Next dev process env carries PORT=3000 which would hijack the
          // feed's socket.io port — pin the feed's ports explicitly
          env: { ...process.env, PORT: '3003', REST_PORT: '3004' },
        })
        child.unref()
        child.on('error', e => console.error('[instrumentation] feed spawn error:', e.message))
        // wait for the feed to boot, then re-push the full symbol universe
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000))
          if (await feedHealthy()) break
        }
        if (await feedHealthy()) {
          const { db } = await import('./lib/db')
          const { publishUniverseToFeed } = await import('./lib/services/symbol-service')
          const rows = await db.symbolMaster.findMany({
            select: { symbol: true, basePrice: true, lotSize: true, instrumentType: true },
          })
          await publishUniverseToFeed(rows)
          console.log(`[instrumentation] market-feed respawned — universe re-published (${rows.length} symbols)`)
        }
      } catch (e) {
        console.error('[instrumentation] feed respawn failed:', e)
      } finally {
        setTimeout(() => { g.__feedWatchBusy = false }, 10_000)
      }
    })()
  }, 10_000)
}
