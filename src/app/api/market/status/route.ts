// @ts-nocheck
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Service status board (multi-service health)
export async function GET() {
  const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
  let feed = false
  let symbols = 0
  try {
    const res = await fetch(`${FEED_URL}/health`, { signal: AbortSignal.timeout(1500), cache: 'no-store' })
    feed = res.ok
    if (res.ok) {
      const h = (await res.json()) as { symbols?: number }
      symbols = h.symbols ?? 0
    }
  } catch { /* down */ }
  const lastSync = await db.systemSetting.findUnique({ where: { key: 'lastMasterSync' } })
  const symbolCount = await db.symbolMaster.count()
  const accountCount = await db.brokerAccount.count()
  const enabledStrategies = await db.strategy.count({ where: { enabled: true } })
  return NextResponse.json({
    services: {
      terminalApi: 'UP',
      marketFeed: feed ? 'UP' : 'DOWN',
      strategyEngine: 'UP',
      feedSymbols: symbols,
    },
    masterContracts: { count: symbolCount, lastSync: lastSync?.value ?? null },
    accounts: accountCount,
    enabledStrategies,
  })
}

export const dynamic = 'force-dynamic'
