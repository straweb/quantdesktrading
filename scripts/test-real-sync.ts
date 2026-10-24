// Round-13 verification: run the REAL master sync end-to-end and sample
// the resulting masters + broker mappings.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main(): Promise<void> {
  const t0 = Date.now()
  const { syncMasterContracts } = await import('../src/lib/services/symbol-service.ts')
  const r = await syncMasterContracts('MANUAL')
  console.log(`SYNC RESULT: ${r.symbolCount} symbols, ${r.mappedCount} mappings in ${((Date.now() - t0) / 1000).toFixed(1)}s (version ${r.version})`)

  const samples = [
    { symbol: 'RELIANCE', exchange: 'NSE' },
    { symbol: 'NIFTY', exchange: 'NSE' },
    { symbol: 'NIFTY', exchange: 'BSE' },
  ]
  for (const s of samples) {
    const m = await db.symbolMaster.findUnique({ where: { symbol_exchange: s }, include: { mappings: true } })
    if (!m) { console.log(`MISSING ${s.symbol}/${s.exchange}`); continue }
    const mp = Object.fromEntries(m.mappings.map(x => [x.brokerType, `${x.brokerSymbol} → ${x.brokerToken}`]))
    console.log(`${m.symbol} [${m.instrumentType}] lot=${m.lotSize}`, mp)
  }
  // one real NIFTY option + future
  const opt = await db.symbolMaster.findFirst({
    where: { underlying: 'NIFTY', instrumentType: 'CE', expiry: { gte: r.version } },
    orderBy: [{ expiry: 'asc' }, { strike: 'asc' }],
    include: { mappings: true },
  })
  if (opt) {
    const mp = Object.fromEntries(opt.mappings.map(x => [x.brokerType, `${x.brokerSymbol} → ${x.brokerToken}`]))
    console.log(`SAMPLE OPT ${opt.symbol} exp=${opt.expiry} strike=${opt.strike} lot=${opt.lotSize}`, mp)
  }
  const fut = await db.symbolMaster.findFirst({
    where: { underlying: 'NIFTY', instrumentType: 'FUT' },
    orderBy: { expiry: 'asc' },
    include: { mappings: true },
  })
  if (fut) {
    const mp = Object.fromEntries(fut.mappings.map(x => [x.brokerType, `${x.brokerSymbol} → ${x.brokerToken}`]))
    console.log(`SAMPLE FUT ${fut.symbol} exp=${fut.expiry} lot=${fut.lotSize}`, mp)
  }
  const counts = await db.symbolMaster.groupBy({ by: ['exchange', 'instrumentType'], _count: true })
  console.log('SEGMENTS:', counts.map(c => `${c.exchange}/${c.instrumentType}=${c._count}`).join(' '))
  const mapCounts = await db.symbolMapping.groupBy({ by: ['brokerType'], _count: true })
  console.log('MAPPINGS:', mapCounts.map(c => `${c.brokerType}=${c._count}`).join(' '))
  const log = await db.syncLog.findFirst({ orderBy: { createdAt: 'desc' } })
  console.log('SYNCLOG:', log?.status, '—', log?.message?.slice(0, 400))
}

main().then(() => db.$disconnect()).catch(e => { console.error('FAILED:', e); db.$disconnect().then(() => process.exit(1)) })
