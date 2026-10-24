// @ts-nocheck
import { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { spawn } from 'child_process'
import path from 'path'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ============================================================
// Source-code export — streams a ZIP of the project SOURCE (no
// node_modules / .next / runtime DBs / logs) so the latest code
// can always be downloaded from the preview, independent of the
// platform workspace archiver (which fails on huge workspaces).
// GET /api/workspace/export  (admin auth)
// ============================================================

// everything needed to rebuild + run the terminal elsewhere
const INCLUDE_DIRS = ['src', 'brokers', 'mini-services', 'prisma', 'docs', 'tests', 'public', 'strategies', 'examples']
const INCLUDE_FILES = [
  'package.json', 'package-lock.json', 'bun.lock', 'bunfig.toml',
  'tsconfig.json', 'next.config.ts', 'tailwind.config.ts', 'postcss.config.mjs',
  'eslint.config.mjs', 'components.json', 'Caddyfile',
  'README.md', '.env.example', 'start.sh', 'stop.sh',
]
// db/ holds runtime data — ship ONLY the JSON config stores
const DB_JSON = ['gtt.json', 'feed-source.json', 'auto-rules.json']
const SCRIPTS = ['create-env.sh', 'export-source.sh', 'repair-cash.ts']
// secrets NEVER leave the machine: the include list is an allowlist that
// can never match .env, and these excludes strip any stray .env that may
// exist inside an included directory (defence in depth)
const EXCLUDES = ['-x', '*.png', '*.db', '*.log', '.env', '*/.env', '*.env.local', '*/.env.local']

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth

  const root = process.cwd()
  const targets: string[] = [
    ...INCLUDE_DIRS,
    ...INCLUDE_FILES,
    ...DB_JSON.map(f => path.join('db', f)),
    ...SCRIPTS.map(f => path.join('scripts', f)),
  ]
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const outName = `quantdesk-source-${stamp}.zip`

  // pack into a temp file (reliable, content-length known), then stream it back
  const dir = await mkdtemp(path.join(tmpdir(), 'qd-export-'))
  const zipPath = path.join(dir, outName)
  try {
    await new Promise<void>((resolve, reject) => {
      // `-@` reads the target list from stdin; the EXCLUDES strip any
      // screenshots / runtime DBs / logs / .env secrets that happen to
      // live inside the included dirs
      const proc = spawn('zip', ['-r', '-q', '-9', zipPath, '-@', ...EXCLUDES], { cwd: root })
      let stderr = ''
      proc.stderr.on('data', c => { stderr += String(c) })
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}: ${stderr.slice(0, 300)}`))))
      proc.on('error', reject)
      proc.stdin.write(targets.map(t => `${t}\n`).join(''))
      proc.stdin.end()
    })

    const buf = await readFile(zipPath)
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${outName}"`,
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'export failed' }, { status: 500 })
  } finally {
    void rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
}
