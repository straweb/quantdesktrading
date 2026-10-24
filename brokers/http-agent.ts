// @ts-nocheck
// ============================================================
// Shared keep-alive HTTPS agent for all broker REST traffic.
//
// Without a shared agent every broker call paid a full TCP+TLS
// handshake (~150-300ms on top of the request) — the single biggest
// latency source of the live feed, funds and quote calls. A
// persistent agent reuses the warm connection (OpenAlgo-style
// requests.Session parity): after the first call, subsequent
// requests reuse the socket and run 2-4× faster.
//
// Bun-safe (no Next imports) — used by breeze.ts, auth-util and the
// feed service alike. The agent is process-wide (warm sockets are
// shared across Next requests AND feed cycles).
// ============================================================
import https from 'node:https'

let agent: https.Agent | null = null

export function httpsKeepAliveAgent(): https.Agent {
  if (!agent) {
    agent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: 8,
      maxFreeSockets: 4,
      scheduling: 'lifo' as never,
    })
  }
  return agent
}
