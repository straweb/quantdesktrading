// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { bootstrap } from '@/lib/services/bootstrap-service'

// Search master contracts (with broker mappings attached)
export async function GET(req: NextRequest) {
  await bootstrap()
  const auth = requireAuth(req)
  if (auth) return auth
  const url = new URL(req.url)
  const q = (url.searchParams.get('q') ?? '').trim().toUpperCase()
  const exchange = url.searchParams.get('exchange') ?? ''
  const instrumentType = url.searchParams.get('type') ?? ''
  const symbolsIn = (url.searchParams.get('symbols') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50))

  const where: Record<string, unknown> = {}
  if (q) where.symbol = { contains: q }
  if (symbolsIn.length > 0) where.symbol = { in: symbolsIn } // explicit lookup (watchlist stars)
  if (exchange) where.exchange = exchange
  if (instrumentType) where.instrumentType = instrumentType

  const symbols = await db.symbolMaster.findMany({
    where,
    include: { mappings: true },
    orderBy: [{ instrumentType: 'asc' }, { symbol: 'asc' }],
    take: limit,
  })
  return NextResponse.json({ symbols })
}
