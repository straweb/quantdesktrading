// @ts-nocheck
// ============================================================
// DHAN session flow (DhanHQ v2 — docs: dhanhq.co/docs/v2/authentication).
//   credentials: clientId (Dhan client id) + optional app id/secret
//   A. DIRECT (individual): POST auth.dhan.co/app/generateAccessToken
//        ?dhanClientId=<id>&pin=<6-digit>&totp=<6-digit>
//        -> { dhanClientId, accessToken, expiryTime }   (paste "pin:totp")
//   B. APP consent: POST auth.dhan.co/app/generate-consent?client_id=<id>
//        headers app_id/app_secret -> consentAppId
//        login: consentApp-login -> redirect ?tokenId=...
//        POST app/consumeApp-consent?tokenId= -> accessToken
//      (legacy PARTNER consent kept as fallback)
//   C. Direct JWT paste (from web.dhan.co → Access DhanHQ APIs)
// Tokens are FIXED-duration (24h, expiryTime returned by the broker).
// ============================================================
import { logBroker } from '../database'
import { registerAuthFlow } from '../auth-registry'
import { attempt, mask, required } from '../auth-util'
import type { AuthStartResult, AuthCompleteResult } from '../auth-types'

const DHAN_AUTH = 'https://auth.dhan.co'

// consent state kept in-memory per account (step-1 output)
const consentStore = new Map<string, string>()

function dhanStart(_accountId: string, creds: Record<string, string> | null): AuthStartResult {
  const hasApp = required(creds, ['appId', 'appSecret']) !== null
  const hasClient = required(creds, ['clientId']) !== null
  return {
    loginUrl: null, // filled after generate-consent (async) — see dhanGenerateConsent()
    instructions: hasApp
      ? [
          'Press "Generate consent" — the terminal calls auth.dhan.co/app/generate-consent?client_id=<Dhan Client ID> with app_id/app_secret headers (DhanHQ app consent — OpenAlgo parity).',
          'Open the returned consentApp-login URL, log in with Dhan credentials + TOTP, and copy the tokenId from the redirect (?tokenId=...).',
          'Paste the tokenId here — app/consumeApp-consent returns the accessToken + dhanClientId.',
          'Shortcut without a browser: paste "PIN:TOTP" (e.g. 123456:987654) below — the terminal calls app/generateAccessToken directly.',
          'Or paste a direct JWT access token (from web.dhan.co → Access DhanHQ APIs).',
          'The token is stored encrypted in the terminal DB and re-used automatically — no re-connect on page refresh (Dhan tokens last 24h).',
        ]
      : [
          'Three ways to create the session:',
          '1 · DIRECT: paste "PIN:TOTP" (e.g. 123456:987654) — needs the Dhan Client ID saved + TOTP enabled.',
          '2 · APP CONSENT: save the DhanHQ App ID + App Secret (web.dhan.co → profile → DhanHQ Trading APIs → create app) plus your Dhan Client ID, press Generate consent, log in at the consent URL, paste the redirect tokenId.',
          '3 · Paste a direct JWT access token from web.dhan.co (valid 24h).',
          'The token is stored encrypted in the terminal DB and re-used automatically — no re-connect on page refresh.',
        ],
    fieldsNeeded: hasClient ? ['PIN:TOTP, or tokenId (consent), or a JWT'] : ['clientId'],
  }
}

/** Dhan step 1 — app consent (DhanHQ app_id/app_secret, OpenAlgo parity).
 *  Partner-consent endpoint kept as a fallback for partner deployments. */
export async function dhanGenerateConsent(accountId: string, creds: Record<string, string> | null): Promise<{ ok: boolean; loginUrl?: string; message: string }> {
  if (!creds?.appId?.trim() || !creds?.appSecret?.trim()) {
    return { ok: false, message: 'Consent needs the DhanHQ App ID + App Secret saved on the account (web.dhan.co → profile → DhanHQ Trading APIs → create app). No DhanHQ app? Paste "PIN:TOTP" (e.g. 123456:987654) or a direct JWT in the session dialog instead.' }
  }
  const appId = creds.appId.trim()
  const appSecret = creds.appSecret.trim()
  const clientId = creds.clientId?.trim() ?? ''
  logBroker('DHAN', accountId, `app generate-consent started (app_id ${mask(appId)}${clientId ? `, client ${mask(clientId)}` : ''})`)

  // PRIMARY: /app/generate-consent?client_id=<dhanClientId> (requires the client id)
  if (clientId) {
    const res = await attempt<{ status?: string; consentAppId?: string; errorType?: string; errorMessage?: string }>(
      'DHAN', accountId, 'app:generate-consent',
      `${DHAN_AUTH}/app/generate-consent?client_id=${encodeURIComponent(clientId)}`,
      { method: 'POST', headers: { app_id: appId, app_secret: appSecret }, timeoutMs: 8000 },
    )
    const consentAppId = res.data?.consentAppId ?? null
    if (res.data?.status === 'success' && consentAppId) {
      consentStore.set(accountId, consentAppId)
      const loginUrl = `${DHAN_AUTH}/login/consentApp-login?consentAppId=${encodeURIComponent(consentAppId)}`
      logBroker('DHAN', accountId, `consent generated ${mask(consentAppId)} — consentApp-login URL ready`)
      return { ok: true, loginUrl, message: 'Consent generated — open the login URL, log in, then paste the redirect tokenId' }
    }
    logBroker('DHAN', accountId, `app generate-consent FAILED — ${res.data?.errorMessage ?? res.data?.errorType ?? JSON.stringify(res.data ?? {}).slice(0, 140) ?? res.error ?? res.status}`, 'WARN')
  } else {
    logBroker('DHAN', accountId, 'app generate-consent skipped — no Dhan Client ID saved on the account', 'WARN')
  }

  // FALLBACK: legacy partner consent (partner deployments)
  const res2 = await attempt<{ consentId?: string; consentStatus?: string; errorType?: string; errorMessage?: string }>(
    'DHAN', accountId, 'partner:generate-consent',
    `${DHAN_AUTH}/partner/generate-consent`,
    { method: 'POST', headers: { partner_id: appId, partner_secret: appSecret }, timeoutMs: 8000 },
  )
  const consentId = res2.data?.consentId ?? null
  if (consentId) {
    consentStore.set(accountId, consentId)
    const loginUrl = `${DHAN_AUTH}/consent-login?consentId=${encodeURIComponent(consentId)}`
    logBroker('DHAN', accountId, `partner consent generated ${mask(consentId)} — consent-login URL ready`)
    return { ok: true, loginUrl, message: 'Partner consent generated — open the login URL, log in, then paste the redirect tokenId' }
  }
  const reason = res2.data?.errorMessage ?? res2.data?.errorType ?? (res2.data ? JSON.stringify(res2.data).slice(0, 160) : res2.error ?? String(res2.status))
  logBroker('DHAN', accountId, `generate-consent FAILED (app + partner) — ${reason}`, 'ERROR')
  return { ok: false, message: `Failed to get consent — ${reason}. Check the App ID/App Secret (DhanHQ app) + Dhan Client ID are saved, or use PIN:TOTP / a direct JWT. See Admin → Broker Diagnostics for the exact request log.` }
}

async function dhanComplete(accountId: string, creds: Record<string, string> | null, code: string): Promise<AuthCompleteResult> {
  // direct JWT paste (access tokens are long JWT strings)
  if (code.length > 100) {
    logBroker('DHAN', accountId, 'Direct access token saved')
    return { ok: true, message: 'Dhan access token saved', credentials: { ...(creds ?? {}), accessToken: code }, sessionKind: 'fixed' }
  }
  // DIRECT PIN:TOTP flow — app/generateAccessToken (individual traders)
  const pinTotp = code.match(/^(\d{4,8})\s*[:|]\s*(\d{6})$/)
  if (pinTotp) {
    const clientId = creds?.clientId?.trim() ?? ''
    if (!clientId) return { ok: false, message: 'Save the Dhan Client ID on the account (Edit dialog) for the PIN:TOTP direct flow' }
    const [, pin, totp] = pinTotp
    logBroker('DHAN', accountId, `direct token generation started (client ${mask(clientId)}, pin ${mask(pin)})`)
    const res = await attempt<{ dhanClientId?: string; dhanClientName?: string; dhanClientUcc?: string; accessToken?: string; expiryTime?: string; errorType?: string; errorMessage?: string }>(
      'DHAN', accountId, 'app:generateAccessToken',
      `${DHAN_AUTH}/app/generateAccessToken?dhanClientId=${encodeURIComponent(clientId)}&pin=${encodeURIComponent(pin)}&totp=${encodeURIComponent(totp)}`,
      { method: 'POST', timeoutMs: 8000 },
    )
    if (res.data?.accessToken) {
      const cid = res.data.dhanClientId ?? clientId
      logBroker('DHAN', accountId, `direct session created for ${cid}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`)
      return {
        ok: true,
        message: `Dhan session active — ${cid}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`,
        userId: cid,
        sessionKind: 'fixed',
        sessionExpiresAt: res.data.expiryTime || undefined,
        credentials: { ...(creds ?? {}), accessToken: res.data.accessToken, clientId: cid },
      }
    }
    const reason = res.data?.errorMessage ?? res.data?.errorType ?? (res.data ? JSON.stringify(res.data).slice(0, 160) : res.error ?? String(res.status))
    logBroker('DHAN', accountId, `generateAccessToken FAILED — ${reason}`, 'ERROR')
    return { ok: false, message: `Direct token generation failed — ${reason}. Check TOTP is enabled + the PIN is correct, or paste a JWT.` }
  }
  // CONSENT consume (tokenId from the consentApp-login redirect).
  // app/consumeApp-consent first (DhanHQ app consent), then partner.
  if (!creds?.appId || !creds?.appSecret) return { ok: false, message: 'tokenId exchange needs the DhanHQ App ID + App Secret on the account — or paste "PIN:TOTP" / a direct JWT instead' }
  const consentId = consentStore.get(accountId)
  logBroker('DHAN', accountId, `consent exchange started (${consentId ? `consentId ${mask(consentId)}, ` : ''}tokenId ${mask(code)})`)
  const appHeaders = { app_id: creds.appId.trim(), app_secret: creds.appSecret.trim(), 'Content-Type': 'application/json' }
  const partnerHeaders = { partner_id: creds.appId.trim(), partner_secret: creds.appSecret.trim() }
  const exchanges: [string, string, Record<string, string>][] = [
    ['app:consumeApp-consent', `${DHAN_AUTH}/app/consumeApp-consent?tokenId=${encodeURIComponent(code)}`, appHeaders],
    ['partner:consume-consent', `${DHAN_AUTH}/partner/consume-consent?tokenId=${encodeURIComponent(code)}`, partnerHeaders],
  ]
  for (const [label, url, hdrs] of exchanges) {
    const res = await attempt<{ accessToken?: string; dhanClientId?: string; dhanClientName?: string; dhanClientUcc?: string; expiryTime?: string; errorType?: string; errorMessage?: string }>(
      'DHAN', accountId, label, url,
      { method: 'POST', headers: hdrs, timeoutMs: 8000 },
    )
    if (res.data?.accessToken) {
      const clientId = res.data.dhanClientId ?? creds.clientId ?? ''
      logBroker('DHAN', accountId, `OAuth session created for ${clientId}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`)
      return {
        ok: true,
        message: `Dhan session active — ${clientId || 'client'}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`,
        userId: clientId,
        sessionKind: 'fixed',
        sessionExpiresAt: res.data.expiryTime || undefined,
        credentials: { ...(creds ?? {}), accessToken: res.data.accessToken, clientId },
      }
    }
    logBroker('DHAN', accountId, `${label} FAILED — ${res.data?.errorMessage ?? res.data?.errorType ?? JSON.stringify(res.data ?? {}).slice(0, 140) ?? res.error ?? res.status}`, 'WARN')
  }
  return { ok: false, message: 'tokenId exchange failed — generate a FRESH consent (tokenId is single-use) and retry, or paste "PIN:TOTP" / a direct JWT. Exact request logs are in Admin → Broker Diagnostics.' }
}

registerAuthFlow({
  brokerType: 'DHAN',
  start: dhanStart,
  complete: dhanComplete,
  // renewal needs a FRESH TOTP code (the pasted one is single-use) — the
  // terminal cannot generate it, so no auto-renew; sessions last 24h and
  // are validated + surfaced by the session-restore service.
  autoRenewable: () => false,
})
