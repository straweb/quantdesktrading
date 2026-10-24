import { execFile } from 'child_process'

// ============================================================
// Fresh-clone self-heal: a repo cloned without .env / without a
// pushed schema makes every Prisma query throw, and the login
// route used to answer a bare "Login temporarily unavailable".
// These helpers classify the failure and repair the schema by
// shelling out to the local prisma CLI (dev only — start.sh /
// npm run setup do the same thing explicitly for production).
// ============================================================

const SCHEMA_ERR_RE =
  /P2021|P2022|does not exist in the current database|table.*(?:does not|missing)|Invalid `prisma|error: Environment variable not found: DATABASE_URL/i

export function isMissingSchemaError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e)
  return SCHEMA_ERR_RE.test(msg)
}

export function isPrismaClientNotGenerated(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /did not initialize yet|@prisma\/client/i.test(msg)
}

// single-flight guard — concurrent logins must not run db push twice
let schemaPromise: Promise<void> | null = null

/** Run `prisma generate` + `prisma db push` against the local schema (one-shot, cached). */
export function ensureDbSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = new Promise<void>((resolve, reject) => {
      // prefer the repo-local CLI; fall back to npx (downloads nothing —
      // prisma is a direct dependency)
      const { existsSync } = require('fs') as typeof import('fs')
      const { join } = require('path') as typeof import('path')
      const localBin = join(process.cwd(), 'node_modules', '.bin', 'prisma')
      const cmd = existsSync(localBin) ? localBin : 'prisma'
      const run = (args: string[]) =>
        new Promise<void>((res, rej) => {
          execFile(cmd, args, { cwd: process.cwd(), env: process.env, timeout: 120_000 }, (err, stdout, stderr) => {
            if (err) rej(new Error(String(stderr || err).slice(0, 400)))
            else res()
          })
        })
      void (async () => {
        await run(['generate'])
        await run(['db', 'push', '--skip-generate', '--accept-data-loss'])
        console.log('[db-setup] prisma generate + db push OK')
      })().then(() => resolve(), reject)
    }).catch(e => {
      schemaPromise = null // allow a later retry
      throw e
    })
  }
  return schemaPromise
}
