// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { getChainMeta, getChainQuotes, ensureOptionContracts } from '@/lib/services/option-service'

// GET /api/options/chain?underlying=NIFTY&expiry=...&strikes=24500,24550
// Returns chain meta (spot, ATM, step, lot, expiries) + per-strike
// CE/PE quote rows (LTP, day high/low, change) for the requested strikes.
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const url = new URL(req.url)
  const underlying = (url.searchParams.get('underlying') ?? '').toUpperCase()
  if (!underlying) return NextResponse.json({ error: 'underlying required' }, { status: 400 })
  const expiry = url.searchParams.get('expiry') || null
  const strikes = (url.searchParams.get('strikes') ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)

  const meta = await getChainMeta(underlying, expiry)
  if (!meta) {
    return NextResponse.json({ error: `No option contracts for ${underlying}` }, { status: 404 })
  }

  // seed the feed states for the ATM rows so the chain/prices/order sizing
  // work the first time a real (synced) contract is viewed — real masters
  // carry no basePrice and no state until they are ensured/published
  try {
    await Promise.all([
      ensureOptionContracts(underlying, meta.atm, meta.expiry),
      ensureOptionContracts(underlying, meta.ceAtm, meta.expiry),
      ensureOptionContracts(underlying, meta.peAtm, meta.expiry),
    ])
  } catch { /* seeding is best-effort */ }

  // requested strikes + ATM rows (for the default CE/PE chart panes)
  const want = [...strikes]
  if (!want.includes(meta.atm)) want.push(meta.atm)
  if (!want.includes(meta.ceAtm)) want.push(meta.ceAtm)
  if (!want.includes(meta.peAtm)) want.push(meta.peAtm)
  const rows = await getChainQuotes(underlying, meta.expiry, want, meta.atm, meta.step, meta.ceAtm, meta.peAtm)
  const atmRow = rows.find(r => r.strike === meta.atm) ?? null
  const ceRow = rows.find(r => r.strike === meta.ceAtm) ?? null
  const peRow = rows.find(r => r.strike === meta.peAtm) ?? null

  return NextResponse.json({
    meta,
    rows,
    atmRow,
    // hedge-desk convention: CE ATM = floor(spot), PE ATM = ceil(spot)
    atmCe: ceRow ? { ...ceRow.ce, strike: meta.ceAtm } : null,
    atmPe: peRow ? { ...peRow.pe, strike: meta.peAtm } : null,
  })
}

export const dynamic = 'force-dynamic'
