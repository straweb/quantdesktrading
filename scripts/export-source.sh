#!/usr/bin/env bash
# Export the project SOURCE CODE as a zip into download/ — independent of the
# platform workspace archiver (which fails on huge workspaces with
# "Failed to archive workspace files").
# Usage: bash scripts/export-source.sh [output.zip]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-download/quantdesk-source-$(date +%Y%m%d-%H%M).zip}"
mkdir -p "$(dirname "$OUT")"

zip -r -q -9 "$OUT" \
  src brokers mini-services prisma docs tests public strategies examples \
  package.json bun.lock bunfig.toml tsconfig.json next.config.ts tailwind.config.ts \
  postcss.config.mjs eslint.config.mjs components.json Caddyfile \
  README.md .env.example start.sh stop.sh \
  db/gtt.json db/feed-source.json db/auto-rules.json \
  scripts/create-env.sh scripts/export-source.sh scripts/repair-cash.ts \
  -x '*.png' '*.db' '*.log' '.env' '*/.env' '*.env.local' '*/.env.local'
# ^ .env (real secrets) is NEVER shipped — only .env.example travels.
#   scripts/create-env.sh regenerates .env (with a fresh random
#   TERMINAL_SECRET) on the target machine via ./start.sh.

echo "source exported → $OUT ($(du -h "$OUT" | cut -f1))"
