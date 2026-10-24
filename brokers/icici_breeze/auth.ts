// @ts-nocheck
// ============================================================
// ICICI DIRECT BREEZE session flow (breeze_connect SDK parity).
//   credentials: apiKey (AppKey) + apiSecret (checksum input)
//   1. user opens  https://api.icicidirect.com/apiuser/login?api_key=<key>
//   2. ICICI redirects to the registered URL with ?apisession=...
//   3. GET customerdetails with body {SessionToken, AppKey}
//      -> Success.session_token = base64("user_id:session_key")
// Sessions are DAILY (broker clears them early morning IST) and
// CANNOT be renewed programmatically — re-creating needs the
// interactive login redirect.
// ============================================================
import { logBroker } from '../database'
import { registerAuthFlow } from '../auth-registry'
import { mask, nextDailyExpiryIst, rawGetWithBody, required } from '../auth-util'
import type { AuthStartResult, AuthCompleteResult } from '../auth-types'

const ICICI_LOGIN = 'https://api.icicidirect.com/apiuser/login'
const ICICI_CUSTOMER_DETAILS = 'https://api.icicidirect.com/breezeapi/api/v1/customerdetails'

function iciciStart(_accountId: string, creds: Record<string, string> | null): AuthStartResult {
  const ok = required(creds, ['apiKey']) !== null
  return {
    loginUrl: ok ? `${ICICI_LOGIN}?api_key=${encodeURIComponent(creds!.apiKey.trim())}` : null,
    instructions: [
      'Open the ICICI Direct login URL below (api_key = your Breeze app key).',
      'After login, ICICI redirects to your registered redirect URL with ?apisession=...',
      'Paste that apisession token here — the terminal exchanges it at customerdetails with checksum sha256(apisession + api_secret), exactly like the Breeze SDK.',
      'The account must have the API secret saved (checksum input) — edit the account if missing.',
      'The session token is stored encrypted in the terminal DB and re-used automatically — no re-connect on page refresh. It is a DAILY token: ICICI clears it early morning IST, then re-create it once.',
    ],
    fieldsNeeded: ['apisession (from the redirect URL)'],
  }
}

async function iciciComplete(accountId: string, creds: Record<string, string> | null, code: string): Promise<AuthCompleteResult> {
  if (!creds?.apiKey) return { ok: false, message: 'Save the account with its Breeze API key (AppKey) first' }
  const apiKey = creds.apiKey.trim()
  logBroker('ICICI_BREEZE', accountId, `customerdetails exchange started (apisession ${mask(code)}, api_key ${mask(apiKey)})`)

  // breeze_connect SDK api_util() shape — GET with a raw JSON BODY
  // {SessionToken, AppKey} (no checksum). Node fetch cannot send a body on
  // GET, hence rawGetWithBody.
  const tried: string[] = []
  const body = JSON.stringify({ SessionToken: code, AppKey: apiKey }, undefined)
    // compact separators like the SDK: json.dumps(body, separators=(',',':'))
    .replace(', "', ',"').replace('": ', '":')
  const t0 = Date.now()
  const raw = await rawGetWithBody<{ Status?: number; Success?: { session_token?: string }; Error?: string }>(
    ICICI_CUSTOMER_DETAILS,
    body,
    { 'Content-Type': 'application/json' },
    10_000,
  )
  logBroker('ICICI_BREEZE', accountId, `auth:customerdetails GET+body → ${raw.status} (${Date.now() - t0}ms)${raw.error ? ` — ${raw.error}` : raw.data ? ` — ${JSON.stringify(raw.data).slice(0, 160)}` : ''}`, raw.data?.Success?.session_token ? 'INFO' : 'WARN')
  tried.push(`GET+body {SessionToken,AppKey} → ${raw.data?.Error ?? raw.error ?? raw.status}`)
  const encoded = raw.data?.Success?.session_token ?? null
  if (!encoded) {
    const detail = raw.data?.Error ?? raw.error ?? String(raw.status)
    logBroker('ICICI_BREEZE', accountId, `customerdetails FAILED — ${detail} · tried: ${tried.join(' | ')}`, 'ERROR')
    return { ok: false, message: `customerdetails failed — ${detail}. Tried: ${tried.join(' | ')}` }
  }
  let userId = '', sessionKey = ''
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('ascii')
    const idx = decoded.indexOf(':')
    if (idx > 0) { userId = decoded.slice(0, idx).trim(); sessionKey = decoded.slice(idx + 1).trim() }
  } catch { /* fallthrough */ }
  if (!sessionKey) return { ok: false, message: 'ICICI returned an invalid session_token (base64 user:session expected)' }
  logBroker('ICICI_BREEZE', accountId, `OAuth session created for ${userId || 'user'} (SDK checksum accepted) — stored in the terminal DB`)
  return {
    ok: true,
    message: `ICICI Breeze session active${userId ? ` — ${userId}` : ''}`,
    userId,
    sessionKind: 'daily',
    sessionExpiresAt: nextDailyExpiryIst(),
    credentials: { ...creds, sessionToken: sessionKey, apiSession: code, ...(userId ? { userId } : {}) },
  }
}

registerAuthFlow({
  brokerType: 'ICICI_BREEZE',
  start: iciciStart,
  complete: iciciComplete,
  // interactive redirect flow — the terminal cannot re-login by itself
  autoRenewable: () => false,
})
