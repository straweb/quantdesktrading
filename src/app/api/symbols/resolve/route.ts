// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Resolve canonical symbol -> per-broker symbols (used by exported python strategies)
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase()
  const brokerType = url.searchParams.get('broker') ?? ''
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })

  const master = await db.symbolMaster.findFirst({ where: { symbol }, include: { mappings: true } })
  if (!master) return NextResponse.json({ error: 'unknown symbol' }, { status: 404 })

  if (brokerType) {
    const m = master.mappings.find(x => x.brokerType === brokerType)
    return NextResponse.json({ symbol: master.symbol, exchange: master.exchange, brokerSymbol: m?.brokerSymbol ?? master.symbol, brokerToken: m?.brokerToken ?? null, lotSize: master.lotSize })
  }
  return NextResponse.json({
    symbol: master.symbol,
    exchange: master.exchange,
    lotSize: master.lotSize,
    mappings: Object.fromEntries(master.mappings.map(m => [m.brokerType, { brokerSymbol: m.brokerSymbol, brokerToken: m.brokerToken }])),
  })
}
