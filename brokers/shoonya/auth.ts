// @ts-nocheck
// ============================================================
// SHOONYA (Finvasia Noren) session flow.
//   credentials: userId + apiKey (app client_id) + apiSecret
//   OAuth:  https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id=<client_id>
//           -> redirect ?code=...
//           POST NorenWClientTP/GenAcsTok
//           jData={apkversion, uid, pwd=<verifier>, factor2, vc, appkey=sha256(uid|secret), imei}
//           verifier = sha256(code+secret) | sha256(secret+code) (variant list)
//           -> { stat: 'Ok', susertoken }
//   QuickAuth (direct): "pwd:factor2(:totp)" paste — jData with the same
//           appkey; vc tried as both "<uid>_U" and the app client_id.
//           INVALID_VERIFIER = the pwd checksum didn't match — every variant
//           is attempted and logged so the working one is visible.
// Sessions are DAILY (Noren clears them early morning IST). QuickAuth
// credentials (password/factor2) ARE stored (encrypted) so the terminal
// can re-login programmatically — auto-renew with no user action.
// ============================================================
import { createHash } from 'node:crypto'
import { logBroker } from '../database'
import { registerAuthFlow } from '../auth-registry'
import { attempt, mask, nextDailyExpiryIst, required } from '../auth-util'
import type { AuthStartResult, AuthCompleteResult } from '../auth-types'

const SHOONYA_OAUTH = 'https://api.shoonya.com/OAuthlogin/authorize/oauth'
const SHOONYA_TP = 'https://api.shoonya.com/NorenWClientTP'
const SHOONYA_API = 'https://api.shoonya.com/NorenWClientAPI'

function shoonyaStart(_accountId: string, creds: Record<string, string> | null): AuthStartResult {
  const ok = required(creds, ['apiKey', 'apiSecret']) !== null
  return {
    loginUrl: ok
      ? `${SHOONYA_OAUTH}?client_id=${encodeURIComponent(creds!.apiKey.trim())}`
      : null,
    instructions: [
      'Open the Shoonya OAuth URL below (client_id = your app client_id from Prism).',
      'After login, Shoonya redirects to your registered redirect URL with ?code=...',
      'Paste that code here — GenAcsTok exchanges it (verifier checksums are tried automatically and every attempt is logged).',
      'Direct mode: use QuickAuth — paste password:PAN/DOB(:TOTP) in the box, e.g. mypass:ABCD1234E or mypass:ABCD1234E:987654.',
      'QuickAuth credentials are stored encrypted — the terminal auto-renews the daily session itself, so a page refresh never asks you to re-connect.',
    ],
    fieldsNeeded: ok ? ['code (from the redirect URL) — or QuickAuth password/factor2/TOTP'] : ['apiKey (client_id)', 'apiSecret'],
  }
}

/** QuickAuth re-login from stored qa credentials (also used by renew). */
async function shoonyaQuickAuth(accountId: string, creds: Record<string, string>): Promise<AuthCompleteResult> {
  const clientId = creds.apiKey.trim()
  const secret = creds.apiSecret.trim()
  const uid = creds.userId?.trim() ?? ''
  const pwd = creds.qaPassword ?? ''
  const factor2 = creds.qaFactor2 ?? ''
  const totp = creds.qaTotp ?? ''
  if (!pwd || !factor2 || !uid) {
    return { ok: false, message: 'QuickAuth credentials missing — paste "pwd:factor2(:totp)" once in the Session dialog and they are stored for auto-renew' }
  }
  const appKey = createHash('sha256').update(`${uid}|${secret}`).digest('hex')
  const mk = (vc: string) => {
    const payload: Record<string, string> = {
      apkversion: '1.0.0', uid, pwd, factor2,
      vc, appkey: appKey, imei: 'abc1234', source: 'WEB',
    }
    if (totp) payload.totp = totp
    return payload
  }
  const tried: string[] = []
  for (const [label, vc] of [['vc=uid_U', `${uid}_U`], ['vc=client_id', clientId]] as [string, string][]) {
    const res2 = await attempt<{ stat?: string; susertoken?: string; emsg?: string }>(
      'SHOONYA', accountId, `quickauth(${label})`,
      `${SHOONYA_TP}/QuickAuth`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `jData=${JSON.stringify(mk(vc))}`, timeoutMs: 8000 },
    )
    tried.push(`QuickAuth ${label} → ${res2.data?.emsg ?? res2.data?.stat ?? res2.error ?? res2.status}`)
    if (res2.data?.stat === 'Ok' && res2.data.susertoken) {
      logBroker('SHOONYA', accountId, `QuickAuth session created (${label}) — token stored in the terminal DB`)
      return {
        ok: true,
        message: 'Shoonya session active (QuickAuth)',
        userId: uid,
        sessionKind: 'daily',
        sessionExpiresAt: nextDailyExpiryIst(),
        credentials: { ...creds, qaPassword: pwd, qaFactor2: factor2, ...(totp ? { qaTotp: totp } : {}), sessionId: res2.data.susertoken },
      }
    }
  }
  return { ok: false, message: `QuickAuth failed — ${tried.join(' | ')}. Check the password:factor2(:totp) format and that User ID is saved.` }
}

async function shoonyaComplete(accountId: string, creds: Record<string, string> | null, code: string): Promise<AuthCompleteResult> {
  if (!creds?.apiKey || !creds?.apiSecret) return { ok: false, message: 'Save the account with Shoonya api_key (client_id) + api_secret first' }
  const clientId = creds.apiKey.trim()
  const secret = creds.apiSecret.trim()
  const uid = creds.userId?.trim() ?? ''
  const tried: string[] = []
  const c = code

  // ---- QuickAuth shorthand: "pwd:factor2(:totp)" → direct session, no browser ----
  if (c.includes(':') && !c.startsWith('jData')) {
    const [pwd, factor2, totp] = c.split(':').map(s => s.trim())
    if (pwd && factor2 && uid) {
      const r = await shoonyaQuickAuth(accountId, { ...creds, qaPassword: pwd, qaFactor2: factor2, ...(totp ? { qaTotp: totp } : {}) })
      if (r.ok) return r
      tried.push(r.message)
      return { ok: false, message: r.message }
    }
    if (pwd && factor2 && !uid) return { ok: false, message: 'Save User ID (login id) on the account for QuickAuth (edit the account)' }
  }

  // ---- OAuth GenAcsTok when a redirect code is given ----
  // hedging auth_api.py parity: checksum = sha256(client_id + api_secret + code)
  // on NorenWClientAPI/GenAcsTok jData={code, checksum} -> {stat:'Ok', access_token}
  if (!uid) return { ok: false, message: 'Save the Shoonya User ID (login id) on the account — GenAcsTok needs uid + appkey' }
  const appKey = createHash('sha256').update(`${uid}|${secret}`).digest('hex')
  // ---- family A: NorenWClientAPI/GenAcsTok {code, checksum} ----
  // DOCUMENTED variant FIRST, then fallbacks — and NEVER break early:
  // INVALID_VERIFIER just means that one checksum was wrong.
  const checksums: [string, string][] = [
    ['sha256(client_id+secret+code)', createHash('sha256').update(`${clientId}${secret}${c}`).digest('hex')],
    ['sha256(code+secret)', createHash('sha256').update(`${c}${secret}`).digest('hex')],
    ['sha256(secret+code)', createHash('sha256').update(`${secret}${c}`).digest('hex')],
  ]
  for (const [label, checksum] of checksums) {
    const res = await attempt<{ stat?: string; access_token?: string; susertoken?: string; emsg?: string }>(
      'SHOONYA', accountId, `GenAcsTok-api(${label})`,
      `${SHOONYA_API}/GenAcsTok`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `jData=${JSON.stringify({ code: c, checksum })}`, timeoutMs: 8000 },
    )
    tried.push(`API ${label} → ${res.data?.emsg ?? res.data?.stat ?? res.error ?? res.status}`)
    const token = res.data?.access_token ?? res.data?.susertoken
    if (res.data?.stat === 'Ok' && token) {
      logBroker('SHOONYA', accountId, `OAuth (GenAcsTok) session created — checksum ${label} accepted`)
      return { ok: true, message: 'Shoonya session active (GenAcsTok)', userId: uid, sessionKind: 'daily', sessionExpiresAt: nextDailyExpiryIst(), credentials: { ...creds, sessionId: token } }
    }
    if (/invalid\s*code|expired|no data/i.test(res.data?.emsg ?? '')) break // code itself is bad — checksums won't help
  }
  // ---- family B: NorenWClientTP/GenAcsTok full jData (legacy docs shape) ----
  const verifiers: [string, string][] = [
    ['sha256(code+secret)', createHash('sha256').update(`${c}${secret}`).digest('hex')],
    ['sha256(secret+code)', createHash('sha256').update(`${secret}${c}`).digest('hex')],
    ['sha256(secret+uid+code)', createHash('sha256').update(`${secret}${uid}${c}`).digest('hex')],
    ['sha256(code)', createHash('sha256').update(c).digest('hex')],
  ]
  for (const [label, verifier] of verifiers) {
    const payload = {
      apkversion: '1.0.0', uid, pwd: verifier, factor2: '',
      vc: clientId, appkey: appKey, imei: 'abc1234',
    }
    const res = await attempt<{ stat?: string; access_token?: string; susertoken?: string; emsg?: string }>(
      'SHOONYA', accountId, `GenAcsTok-tp(${label})`,
      `${SHOONYA_TP}/GenAcsTok`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `jData=${JSON.stringify(payload)}`, timeoutMs: 8000 },
    )
    tried.push(`TP ${label} → ${res.data?.emsg ?? res.data?.stat ?? res.error ?? res.status}`)
    const token = res.data?.access_token ?? res.data?.susertoken
    if (res.data?.stat === 'Ok' && token) {
      logBroker('SHOONYA', accountId, `OAuth (GenAcsTok) session created — verifier ${label} accepted`)
      return { ok: true, message: 'Shoonya session active (GenAcsTok)', userId: uid, sessionKind: 'daily', sessionExpiresAt: nextDailyExpiryIst(), credentials: { ...creds, sessionId: token } }
    }
    if (/invalid\s*code|expired|no data/i.test(res.data?.emsg ?? '')) break
  }
  logBroker('SHOONYA', accountId, `GenAcsTok FAILED — ${tried.join(' | ')}`, 'ERROR')
  return { ok: false, message: `GenAcsTok failed — ${tried.join(' | ')}. The redirect code is single-use and short-lived: open the OAuth URL again and paste a FRESH code. Or use QuickAuth: paste pwd:factor2 (e.g. mypass:ABCD1234E).` }
}

registerAuthFlow({
  brokerType: 'SHOONYA',
  start: shoonyaStart,
  complete: shoonyaComplete,
  // QuickAuth credentials stored on the account → programmatic re-login
  autoRenewable: creds => !!(creds?.qaPassword && creds?.qaFactor2 && creds?.userId),
  renew: (accountId, creds) => shoonyaQuickAuth(accountId, creds),
})
