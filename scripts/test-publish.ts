import { publishUniverseToFeed } from '../src/lib/services/symbol-service.ts'
async function main(): Promise<void> {
  await publishUniverseToFeed([{ symbol: 'TSXPUB', basePrice: 150, lotSize: 1, instrumentType: 'EQ' }])
  const r = await fetch('http://localhost:3004/ltp?symbols=TSXPUB')
  console.log('ltp after publish:', await r.text())
  process.exit(0)
}
void main()
