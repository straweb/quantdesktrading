#!/usr/bin/env bash
# ============================================================
# Create .env from .env.example (idempotent + zip-safe)
#
#   bash scripts/create-env.sh [--force]
#
#  · .env missing        → copied from .env.example, DATABASE_URL
#                          pinned to this machine, and a RANDOM
#                          TERMINAL_SECRET generated (openssl or node)
#  · .env exists         → untouched (use --force to recreate)
#  · placeholder secret  → replaced with a random one on creation
#
# The start.sh boot flow calls this automatically on fresh clones.
# .env is NEVER shipped: the source-export zip explicitly excludes it
# (see src/app/api/workspace/export + scripts/export-source.sh).
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ "${1:-}" = "--force" ] && [ -f .env ]; then
  rm -f .env
fi

if [ -f .env ]; then
  echo "[create-env] .env already exists — leaving it untouched"
  exit 0
fi

if [ ! -f .env.example ]; then
  echo "[create-env] ERROR — .env.example not found" >&2
  exit 1
fi

cp .env.example .env

# pin DATABASE_URL to THIS machine's absolute path
if sed --version >/dev/null 2>&1; then
  sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=file:$ROOT/db/custom.db|" .env && rm -f .env.bak
else
  sed -i '' "s|^DATABASE_URL=.*|DATABASE_URL=file:$ROOT/db/custom.db|" .env
fi

# generate a RANDOM TERMINAL_SECRET (never ship the default placeholder)
SECRET=""
if command -v openssl >/dev/null 2>&1; then
  SECRET="$(openssl rand -hex 32 2>/dev/null || true)"
fi
if [ -z "$SECRET" ] && command -v node >/dev/null 2>&1; then
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
fi
if [ -n "$SECRET" ]; then
  if sed --version >/dev/null 2>&1; then
    sed -i.bak "s|^TERMINAL_SECRET=.*|TERMINAL_SECRET=$SECRET|" .env && rm -f .env.bak
  else
    sed -i '' "s|^TERMINAL_SECRET=.*|TERMINAL_SECRET=$SECRET|" .env
  fi
  echo "[create-env] random TERMINAL_SECRET generated"
else
  echo "[create-env] WARN — could not generate a random secret; set TERMINAL_SECRET in .env manually" >&2
fi

echo "[create-env] created .env from .env.example (DATABASE_URL → $ROOT/db/custom.db)"
echo "[create-env] NOTE: .env stays on this machine — it is excluded from every source-export zip"
