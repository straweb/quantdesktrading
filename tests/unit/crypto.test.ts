import { describe, expect, test } from 'bun:test'
import { decryptJson, encryptJson, hashPassword, hmacToken, maskSecrets, verifyPassword } from '../../src/lib/crypto'

// Crypto layer — AES-256-GCM credential encryption at rest, scrypt password
// hashing, HMAC session-token signing. Key derives from TERMINAL_SECRET.

describe('crypto — encryptJson / decryptJson', () => {
  test('roundtrip preserves the object', () => {
    const creds = { apiKey: 'K1', apiSecret: 'S•cret=42', userId: 'FA12345' }
    const sealed = encryptJson(creds)
    expect(typeof sealed).toBe('string')
    // sealed payload is iv.tag.ciphertext (3 base64 parts)
    expect(sealed.split('.')).toHaveLength(3)
    expect(sealed).not.toContain('S•cret')
    expect(decryptJson(sealed)).toEqual(creds)
  })

  test('ciphertext differs across calls (random IV)', () => {
    expect(encryptJson({ a: 1 })).not.toBe(encryptJson({ a: 1 }))
  })

  test('tampered payload fails authentication → null', () => {
    const sealed = encryptJson({ apiKey: 'K1' })
    const parts = sealed.split('.')
    parts[2] = Buffer.from('{"apiKey":"EVIL"}').toString('base64')
    expect(decryptJson(parts.join('.'))).toBeNull()
  })

  test('truncated payload → null (never throws)', () => {
    expect(decryptJson('garbage')).toBeNull()
    expect(decryptJson('a.b')).toBeNull()
    expect(decryptJson('')).toBeNull()
    expect(decryptJson(null)).toBeNull()
    expect(decryptJson(undefined)).toBeNull()
  })
})

describe('crypto — maskSecrets', () => {
  test('masks secret/key/token fields, keeps the rest', () => {
    const masked = maskSecrets({ apiKey: 'abcd1234', apiSecret: 'wxyz9876', sessionToken: 'tok123456', userId: 'FA12345' })
    expect(masked.apiKey).toBe('••••1234')
    expect(masked.apiSecret).toBe('••••9876')
    expect(masked.sessionToken).toBe('••••3456')
    expect(masked.userId).toBe('FA12345')
  })

  test('null input → empty object', () => {
    expect(maskSecrets(null)).toEqual({})
  })
})

describe('crypto — password hashing (scrypt)', () => {
  test('verify succeeds for the right password, fails for the wrong one', () => {
    const stored = hashPassword('admin123')
    expect(stored).not.toContain('admin123')
    expect(verifyPassword('admin123', stored)).toBe(true)
    expect(verifyPassword('admin124', stored)).toBe(false)
    expect(verifyPassword('', stored)).toBe(false)
  })

  test('salted — same password hashes differently', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })
})

describe('crypto — hmacToken', () => {
  test('deterministic per payload, distinct across payloads', () => {
    expect(hmacToken('admin|1700000000')).toBe(hmacToken('admin|1700000000'))
    expect(hmacToken('admin|1700000000')).not.toBe(hmacToken('admin|1700000001'))
    // 64 hex chars = sha256 digest
    expect(hmacToken('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})
