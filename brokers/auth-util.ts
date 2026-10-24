// @ts-nocheck
// ============================================================
// Shared auth helpers for the per-broker session flows.
// Every outbound attempt is TAGGED ([BROKER][auth:…]) so the exact
// call, status and latency reach the console AND the account's
// broker_logs (Admin → Broker Diagnostics replays it).
// ============================================================
import https from 'node:https'
import { liveFetch } from './live-api'
import { logBroker } from './database'
import { httpsKeepAliveAgent } from './http-agent'
import type { AuthStartResult, AuthCompleteResult } from './auth-types'

export type { AuthStartResult, AuthCompleteResult }

export function required(creds: Record<string, string> | null, keys: string[]): string | null {
  if (!creds) return null
  for (const k of keys) if (!creds[k]?.trim()) return null
  return keys.map(k => creds[k].trim()).join('|')
}

/** never print full secrets into logs */
export function mask(v: string | undefined): string {
  if (!v) return '(missing)'
  return v.length <= 6 ? '••••' : `${v.slice(0, 3)}••••${v.slice(-3)}`
}

/** one tagged + logged auth attempt against a broker endpoint */
export async function attempt<T>(
  broker: string,
  accountId: string,
  label: string,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Awaited<ReturnType<typeof liveFetch<T>>>> {
  const res = await liveFetch<T>(url, {
    ...init,
    callTag: { broker, accountId, tag: `auth:${label}` },
  })
  if (!res.ok && !res.error) {
    // non-2xx responses often carry the broker's reason in the body —
    // make sure it reaches broker_logs (liveFetch logs it only via ok=false path)
    logBroker(broker, accountId, `auth:${label} ${res.status} — ${JSON.stringify(res.data ?? {}).slice(0, 200)}`, 'WARN')
  }
  return res
}

/**
 * GET request WITH a JSON body — exactly what the Breeze SDK sends
 * (`requests.get(url, data=body)`). Node fetch forbids a body on GET,
 * so this uses raw node:https. Returns the parsed JSON response.
 */
export function rawGetWithBody<T>(url: string, body: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<{ status: number; data: T | null; error?: string }> {
  return new Promise(resolve => {
    let u: URL
    try { u = new URL(url) } catch { return resolve({ status: 0, data: null, error: 'bad url' }) }
    const started = Date.now()
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
        agent: httpsKeepAliveAgent(), // keep-alive — no TLS handshake per request
      },
      res => {
        let raw = ''
        res.on('data', c => { raw += c })
        res.on('end', () => {
          let data: T | null = null
          try { data = JSON.parse(raw) as T } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode ?? 0, data })
        })
      },
    )
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', e => resolve({ status: 0, data: null, error: `${e.message} (${Date.now() - started}ms)` }))
    req.write(body)
    req.end()
  })
}

/** default expiry for 'daily' broker sessions — the next 03:30 IST after now */
export function nextDailyExpiryIst(): string {
  // 03:30 IST === 22:00 UTC
  const now = Date.now()
  const d = new Date(now)
  const expiryUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22, 0, 0)
  return new Date(expiryUtc > now ? expiryUtc : expiryUtc + 24 * 3600_000).toISOString()
}
