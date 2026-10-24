// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { encryptJson } from '@/lib/crypto'
import { resetCapital } from '@/lib/services/capital-service'
import type { CapitalMode } from '@/lib/types'

type Params = { params: Promise<{ id: string }> }

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
const FEED_SRC_FILE = process.cwd() + '/db/feed-source.json'

/** revert the terminal feed source to sim (used when an account disconnects) */
async function revertFeedSourceToSim() {
  try {
    await fetch(`${FEED_URL}/feed-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'sim' }),
      signal: AbortSignal.timeout(1200),
      cache: 'no-store',
    })
  } catch {
    try {
      const { writeFile } = await import('fs/promises')
      await writeFile(FEED_SRC_FILE, JSON.stringify({ source: 'sim', updatedAt: new Date().toISOString() }, null, 2))
    } catch { /* feed service will resync */ }
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const acc = await db.brokerAccount.findUnique({ where: { id }, include: { capital: true } })
  if (!acc) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (body.label !== undefined) data.label = String(body.label)
  if (body.clientId !== undefined) data.clientId = body.clientId ? String(body.clientId) : null
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive)
  if (body.isOrderEnabled !== undefined) data.isOrderEnabled = Boolean(body.isOrderEnabled)
  if (body.isCopyMaster !== undefined) data.isCopyMaster = Boolean(body.isCopyMaster)
  if (body.status !== undefined) data.status = String(body.status)
  if (body.credentials !== undefined) {
    data.credentialsEnc = body.credentials && Object.keys(body.credentials).length ? encryptJson(body.credentials) : acc.credentialsEnc
  }
  if (body.credentialsMerge !== undefined && body.credentialsMerge && typeof body.credentialsMerge === 'object') {
    // merge into the EXISTING encrypted credentials (Edit dialog: only the
    // fields the user filled are replaced; blank/missing keys are kept)
    const { decryptJson } = await import('@/lib/crypto')
    const current = decryptJson(acc.credentialsEnc) ?? {}
    const merged: Record<string, string> = { ...current }
    for (const [k, v] of Object.entries(body.credentialsMerge as Record<string, unknown>)) {
      const s = typeof v === 'string' ? v.trim() : ''
      if (s) merged[k] = s
    }
    data.credentialsEnc = encryptJson(merged)
  }
  if (body.isLiveDataSource !== undefined && body.isLiveDataSource) {
    // only one live data source at a time
    await db.brokerAccount.updateMany({ data: { isLiveDataSource: false } })
    data.isLiveDataSource = true
  } else if (body.isLiveDataSource === false) {
    data.isLiveDataSource = false
  }
  await db.brokerAccount.update({ where: { id }, data })

  // disconnecting an account that was feeding the terminal -> fall back to sim
  if (body.isActive === false && acc.isLiveDataSource) {
    await db.brokerAccount.update({ where: { id }, data: { isLiveDataSource: false } })
    await revertFeedSourceToSim()
  }

  if (body.initialCapital !== undefined || body.mode !== undefined || body.capitalBase !== undefined || body.capitalPct !== undefined || body.resetCapital) {
    if (acc.capital) {
      if (body.resetCapital) {
        await resetCapital(id, Number(body.initialCapital ?? acc.capital.initialCapital), (body.mode ?? acc.capital.mode) as CapitalMode)
        if (body.capitalBase !== undefined || body.capitalPct !== undefined) {
          await db.capitalConfig.update({
            where: { accountId: id },
            data: {
              ...(body.capitalBase !== undefined ? { capitalBase: body.capitalBase === 'AVAILABLE_CASH_PCT' ? 'AVAILABLE_CASH_PCT' : 'FIXED' } : {}),
              ...(body.capitalPct !== undefined ? { capitalPct: Number(body.capitalPct) || 100 } : {}),
            },
          })
        }
      } else {
        await db.capitalConfig.update({
          where: { accountId: id },
          data: {
            ...(body.initialCapital !== undefined ? { initialCapital: Number(body.initialCapital) } : {}),
            ...(body.mode !== undefined ? { mode: String(body.mode) } : {}),
            ...(body.capitalBase !== undefined ? { capitalBase: body.capitalBase === 'AVAILABLE_CASH_PCT' ? 'AVAILABLE_CASH_PCT' : 'FIXED' } : {}),
            ...(body.capitalPct !== undefined ? { capitalPct: Number(body.capitalPct) || 100 } : {}),
          },
        })
      }
    }
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  await db.brokerAccount.delete({ where: { id } }).catch(() => null)
  return NextResponse.json({ ok: true })
}
