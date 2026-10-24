import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// AES-256-GCM encryption for broker credentials at rest.
// Key derived from TERMINAL_SECRET env (or stable default for sandbox).

const SECRET = process.env.TERMINAL_SECRET || 'zterm-default-secret-change-in-prod'
const KEY = createHash('sha256').update(SECRET).digest()

export function encryptJson(obj: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const plain = Buffer.from(JSON.stringify(obj), 'utf8')
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

export function decryptJson<T = Record<string, string>>(payload: string | null | undefined): T | null {
  if (!payload) return null
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.')
    const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()])
    return JSON.parse(dec.toString('utf8')) as T
  } catch {
    return null
  }
}

export function maskSecrets(obj: Record<string, string> | null): Record<string, string> {
  if (!obj) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v && k.toLowerCase().includes('secret') || k.toLowerCase().includes('key') || k.toLowerCase().includes('token')
      ? '••••' + v.slice(-4)
      : v
  }
  return out
}

// ---------- password hashing (scrypt) ----------
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export function hmacToken(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('hex')
}
