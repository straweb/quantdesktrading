// Measure the ingest memory footprint (the sync runs inside the Next server)
async function main(): Promise<void> {
  const { ingestRealMasters } = await import('../src/lib/services/real-master-sync.ts')
  const mu = () => process.memoryUsage().heapUsed / 1048576
  console.log('heap before:', mu().toFixed(0), 'MB')
  const t0 = Date.now()
  const r = await ingestRealMasters()
  console.log(`heap after: ${mu().toFixed(0)} MB · rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`)
  console.log(`rows ${r.rows.length} · dhanTokens ${r.dhanTokens.size} · shoonyaTokens ${r.shoonyaTokens.size} · ${(Date.now() - t0) / 1000}s`)
  process.exit(0)
}
void main()
