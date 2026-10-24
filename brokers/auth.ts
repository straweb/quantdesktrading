// @ts-nocheck
// ============================================================
// Broker session AUTH — ROUTER (OpenAlgo-style mapping).
//
// Each broker folder owns its complete session flow:
//   brokers/icici_breeze/auth.ts  — Breeze customerdetails exchange
//   brokers/dhan/auth.ts          — PIN:TOTP / app+partner consent / JWT
//   brokers/shoonya/auth.ts       — OAuth GenAcsTok + QuickAuth
// and registers it into the auth registry. This module only routes
// by brokerType (the master-DB BrokerAccount.brokerType mapping), so
// adding a new broker never touches this file or the API routes.
//
// Exported API is unchanged (authStart / authComplete /
// dhanGenerateConsent) — callers (routes, session-restore) are stable.
// ============================================================
import { getAuthFlow } from './auth-registry'
import type { AuthStartResult, AuthCompleteResult, BrokerAuthFlow } from './auth-types'

export type { AuthStartResult, AuthCompleteResult, BrokerAuthFlow }
export { getAuthFlow, registerAuthFlow, listAuthFlows } from './auth-registry'
export { nextDailyExpiryIst } from './auth-util'

// register every broker's flow (one import per broker — the only
// line that grows when a new broker is added)
import './icici_breeze/auth'
import './dhan/auth'
import './shoonya/auth'

/** GET — per-broker session bootstrap descriptor for the Session dialog. */
export function authStart(brokerType: string, accountId: string, creds: Record<string, string> | null): AuthStartResult {
  const flow = getAuthFlow(brokerType)
  if (!flow) return { loginUrl: null, instructions: [`Broker ${brokerType} has no live session flow (sim feed needs none).`], fieldsNeeded: [] }
  return flow.start(accountId, creds)
}

/** POST — exchange the redirect code/session for session tokens (per broker). */
export async function authComplete(brokerType: string, accountId: string, creds: Record<string, string> | null, code: string): Promise<AuthCompleteResult> {
  const c = (code ?? '').trim()
  if (!c) return { ok: false, message: 'Paste the redirect code/session token first' }
  const flow = getAuthFlow(brokerType)
  if (!flow) return { ok: false, message: `Broker ${brokerType} has no live session flow (sim feed needs none)` }
  try {
    return await flow.complete(accountId, creds, c)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'auth failed' }
  }
}

/** Dhan step-1 consent — routed to the Dhan flow module. */
export async function dhanGenerateConsent(accountId: string, creds: Record<string, string> | null): Promise<{ ok: boolean; loginUrl?: string; message: string }> {
  const flow = getAuthFlow('DHAN')
  if (!flow) return { ok: false, message: 'Dhan auth flow not registered' }
  const mod = await import('./dhan/auth')
  return mod.dhanGenerateConsent(accountId, creds)
}

/** Can the terminal re-create this account's session by itself? */
export function isAutoRenewable(brokerType: string, creds: Record<string, string> | null): boolean {
  const flow = getAuthFlow(brokerType)
  return !!flow?.autoRenewable?.(creds) && !!flow?.renew
}

/** Programmatic session re-login (Shoonya QuickAuth today). */
export async function renewSession(brokerType: string, accountId: string, creds: Record<string, string>): Promise<AuthCompleteResult | null> {
  const flow = getAuthFlow(brokerType)
  if (!flow?.renew) return null
  return flow.renew(accountId, creds)
}
