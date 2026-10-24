// Next.js instrumentation — runs once when the server boots.
// Bootstraps master DB, starts the strategy scheduler, the resting-order
// monitor, and a watchdog that keeps the market-feed mini-service alive
// (the feed service in turn watchdogs this dev server — mutual recovery).
//
// The node-only logic lives in instrumentation-node.ts and is imported
// behind the DOCUMENTED positive conditional form — Turbopack replaces
// process.env.NEXT_RUNTIME at build time per runtime, so the Edge
// instrumentation bundle eliminates the node-only branch entirely
// (no node:crypto warnings, no per-request log spam).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node')
    await registerNode()
  }
}
