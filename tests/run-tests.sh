#!/usr/bin/env bash
# ============================================================
# Test runner — unit + (optional) E2E smoke.
#
#   bash tests/run-tests.sh          # unit only
#   bash tests/run-tests.sh --e2e    # unit + E2E against running server
#   bash tests/run-tests.sh --unit --e2e
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."

MODE_UNIT=0; MODE_E2E=0
for arg in "$@"; do
  case "$arg" in
    --unit) MODE_UNIT=1 ;;
    --e2e)  MODE_E2E=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done
if [ "$MODE_UNIT" = "0" ] && [ "$MODE_E2E" = "0" ]; then MODE_UNIT=1; fi

FAILED=0

if [ "$MODE_UNIT" = "1" ]; then
  echo "──────── Unit tests (bun test) ────────"
  bun test tests/unit || FAILED=1
fi

if [ "$MODE_E2E" = "1" ]; then
  echo
  echo "──────── E2E API smoke (against running deployment) ────────"
  # quick gate: is the stack up?
  if ! curl -s --max-time 3 http://localhost:3000/api/auth/me >/dev/null 2>&1; then
    echo "✗ Next.js not reachable on :3000 — start the app first (bun run dev / bun run start)."
    FAILED=1
  else
    bash tests/e2e/api-smoke.sh || FAILED=1
  fi
fi

exit $FAILED
