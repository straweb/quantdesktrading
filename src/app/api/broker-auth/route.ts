// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { encryptJson } from '@/lib/crypto'
import { authStart, authComplete, dhanGenerateConsent, getAuthFlow } from '@brokers/auth'
import { credsFor, getAdapter } from '@brokers/registry'
import type { BrokerType } from '@/lib/types'

// ============================================================
// Broker session auth — OAuth-style app-credential session flows
// for the live brokers (ICICI Breeze / Dhan / Shoonya), matching
// the straweb/hedging broker/*/api/auth_api.py patterns.
//   GET  ?accountId=   → flow descriptor + current session status
//   POST { accountId, action: 'consent' | 'complete', code? }
// ============================================================

function mask(v?: string): string | null {
  if (!v) return null
  return v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`
}

/** masked per-broker credential fields for the Edit-Account dialog
 *  (values never leave the server unmasked; blank input = unchanged) */
function credFieldsFor(brokerType: string, creds: Record<string, string> | null) {
  const m = (k: string) => mask(creds?.[k] ?? undefined)
  switch (brokerType) {
    case 'ICICI_BREEZE':
      return [
        { key: 'apiKey', label: 'API key (Breeze AppKey)', masked: m('apiKey'), sample: 'e.g. Naa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5' },
        { key: 'apiSecret', label: 'API secret (checksum input)', masked: m('apiSecret'), sample: 'e.g. p9Q8r7S6t5U4v3W2x1Y0z9A8b7C6d5E4' },
      ]
    case 'DHAN':
      return [
        { key: 'clientId', label: 'Dhan Client ID', masked: m('clientId'), sample: 'e.g. 1100123456' },
        { key: 'appId', label: 'Partner ID (optional)', masked: m('appId'), sample: 'partner apps only — enables the consent flow' },
        { key: 'appSecret', label: 'Partner Secret (optional)', masked: m('appSecret'), sample: 'partner apps only — pairs with Partner ID' },
      ]
    case 'SHOONYA':
      return [
        { key: 'userId', label: 'User ID (login id)', masked: m('userId'), sample: 'e.g. FA12345' },
        { key: 'apiKey', label: 'API key (app client_id)', masked: m('apiKey'), sample: 'e.g. 68f3a1b9c2d4e5f6a7b8c9d0e1f2a3b4' },
        { key: 'apiSecret', label: 'API secret', masked: m('apiSecret'), sample: 'e.g. 9d8c7b6a5f4e3d2c1b0a998877665544' },
      ]
    default:
      return []
  }
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const accountId = req.nextUrl.searchParams.get('accountId')
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return NextResponse.json({ error: 'account not found' }, { status: 404 })
  const creds = credsFor(acc.credentialsEnc)
  const adapter = getAdapter(acc.brokerType as BrokerType)
  const flow = authStart(acc.brokerType, acc.id, creds)
  return NextResponse.json({
    accountId: acc.id,
    label: acc.label,
    brokerType: acc.brokerType,
    sessionKind: adapter?.sessionKind?.() ?? 'none',
    hasSession: !!(creds?.sessionToken || creds?.accessToken || creds?.sessionId),
    sessionMasked: mask(creds?.sessionToken ?? creds?.accessToken ?? creds?.sessionId ?? undefined),
    sessionCreatedAt: creds?.sessionCreatedAt ?? null,
    sessionExpiresAt: creds?.sessionExpiresAt || null,
    autoRenew: !!(getAuthFlow(acc.brokerType)?.autoRenewable?.(creds) && getAuthFlow(acc.brokerType)?.renew),
    userId: creds?.userId ?? acc.clientId ?? null,
    liveCapable: adapter?.isLiveCapable() ?? false,
    mode: adapter?.modeLabel(creds) ?? 'sandbox',
    credFields: credFieldsFor(acc.brokerType, creds),
    ...flow,
  })
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => null)
  const accountId: string | undefined = body?.accountId
  const action: string = body?.action ?? 'complete'
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return NextResponse.json({ error: 'account not found' }, { status: 404 })
  const creds = credsFor(acc.credentialsEnc) ?? {}

  if (action === 'consent') {
    // Dhan step-1 (other brokers expose a static login URL from GET)
    if (acc.brokerType !== 'DHAN') return NextResponse.json({ error: 'consent flow only applies to Dhan' }, { status: 400 })
    const r = await dhanGenerateConsent(acc.id, creds)
    return NextResponse.json(r)
  }

  if (action === 'complete') {
    const r = await authComplete(acc.brokerType, acc.id, creds, String(body?.code ?? ''))
    if (r.ok && r.credentials) {
      // PERSIST the session to the master DB (encrypted) with creation/expiry
      // metadata — refreshes and restarts re-use the stored token, never a
      // re-connect prompt. Feed/funds/adapters reload it from here per cycle.
      const { stampSessionMeta } = await import('@/lib/services/session-restore')
      const stored = stampSessionMeta(r.credentials, { sessionKind: r.sessionKind, sessionExpiresAt: r.sessionExpiresAt })
      await db.brokerAccount.update({
        where: { id: acc.id },
        data: { credentialsEnc: encryptJson(stored) },
      })
      // session just went live — pull the REAL broker funds immediately so
      // capital sizing (% of available cash) has the actual balance
      if (acc.brokerType !== 'SIMFEED') {
        try {
          const { syncAccountFunds } = await import('@/lib/services/funds-sync')
          const f = await syncAccountFunds(acc.id, { force: true })
          if (f.ok) r.message += ` · funds ₹${f.cash?.toLocaleString('en-IN')}`
        } catch { /* funds pull is best-effort */ }
      }
    }
    return NextResponse.json(r)
  }

  return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 })
}
