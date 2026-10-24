#!/usr/bin/env bash
# ============================================================
# Trading Terminal — start everything (restart-safe)
#   backend : FastAPI REST :8000 + socket.io WS :8001 (Python)
#   frontend: Next.js    :3000
#   caddy   : :81 -> :3000 + /pyapi->:8000 + WS->:8001 (production)
# Usage:  ./start.sh [--with-caddy]
# Running ./start.sh while already up = clean restart.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=$(pwd)
mkdir -p logs run

# --- pick the best Python for the backend ------------------------------------
# Order: uv-built .venv (openalgo-style `uv run app.py`; PEP-668-proof) →
# system python that ALREADY has the deps → pip install (PEP-668 aware, with
# --break-system-packages fallback) → hard error with fix guidance.
PYBIN=""
PYMODE=""

# 0) uv: `uv sync` builds an isolated .venv from pyproject.toml + uv.lock —
#    never touches the system python, so Debian/Ubuntu/Fedora PEP-668
#    "externally-managed-environment" blocks can't happen.
if command -v uv >/dev/null 2>&1 && [ -f pyproject.toml ]; then
  echo "[start] uv found — preparing backend venv (pyproject.toml)…"
  if (uv sync --frozen >> logs/install.log 2>&1 || uv sync >> logs/install.log 2>&1) \
     && [ -x .venv/bin/python ] \
     && .venv/bin/python -c "import fastapi, uvicorn, socketio" >/dev/null 2>&1; then
    PYBIN="$PROJECT/.venv/bin/python"
    PYMODE="uv venv ($("$PYBIN" --version 2>&1))"
  else
    echo "[start] uv sync failed — falling back to system python (see logs/install.log)"
  fi
fi

# 1) system interpreter that already has the backend deps
if [ -z "$PYBIN" ]; then
  for c in "${PYBIN_CUSTOM:-}" python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$c" >/dev/null 2>&1 || continue
    if "$c" -c "import fastapi, uvicorn, socketio" >/dev/null 2>&1; then
      PYBIN="$c"; PYMODE="system python (deps present)"; break
    fi
  done
fi

# 2) pip install into the newest system python — PEP-668 aware
if [ -z "$PYBIN" ]; then
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$c" >/dev/null 2>&1 && { PYBIN="$c"; break; }
  done
  if [ -z "$PYBIN" ]; then
    echo "[start] ERROR: no python3 found — install python3 or uv, then re-run ./start.sh"
    exit 1
  fi
  echo "[start] backend deps missing for $PYBIN — pip installing requirements.txt…"
  "$PYBIN" -c "import pip" >/dev/null 2>&1 \
    || "$PYBIN" -m ensurepip --upgrade >> logs/install.log 2>&1 || true
  if ! "$PYBIN" -m pip install -q -r requirements.txt >> logs/install.log 2>&1; then
    echo "[start] plain pip failed (PEP 668?) — retrying with --break-system-packages…"
    "$PYBIN" -m pip install -q --break-system-packages -r requirements.txt >> logs/install.log 2>&1 || true
  fi
  if "$PYBIN" -c "import fastapi, uvicorn, socketio" >/dev/null 2>&1; then
    PYMODE="system python + pip ($("$PYBIN" --version 2>&1))"
  else
    echo "[start] ERROR: backend deps unavailable for $PYBIN — see logs/install.log"
    echo "[start] Easiest fix: install uv →  curl -LsSf https://astral.sh/uv/install.sh | sh"
    echo "[start] then re-run ./start.sh (uv builds an isolated .venv automatically)."
    exit 1
  fi
fi
echo "[start] backend python: $PYBIN — $PYMODE"

# --- 0. clean slate: stop anything from a previous run ----------------------
"$(dirname "$0")/stop.sh" >/dev/null 2>&1 || true

# --- .env from .env.sample if missing (secrets never ship in the zip) -------
if [ ! -f .env ]; then
  if [ -f .env.sample ]; then
    cp .env.sample .env
    echo "[start] created .env from .env.sample — EDIT IT (APP_SECRET, ADMIN_PASSWORD)"
  fi
fi

mkdir -p logs run

# --- 0b. frontend dependencies (first run: npm i was not done yet) ----------
if [ ! -d node_modules/next ]; then
  echo "[start] node_modules missing — installing frontend dependencies (npm i)…"
  if command -v bun >/dev/null 2>&1 && [ -f bun.lock ]; then
    bun install >> logs/install.log 2>&1 || npm install >> logs/install.log 2>&1
  else
    npm install >> logs/install.log 2>&1
  fi
  echo "[start] dependencies installed"
fi

# --- 1. Python backend (REST + WS) ------------------------------------------
echo "[start] starting Python backend (REST :8000, WS :8001)…"
nohup "$PYBIN" -m backend.main > logs/backend.log 2>&1 &
echo $! > run/backend.pid

# --- 2. frontend (Next.js :3000) --------------------------------------------
start_frontend() {
  echo "[start] starting Next.js frontend :3000…"
  if command -v bun >/dev/null 2>&1 && [ -f bun.lock ]; then
    nohup bun run dev > logs/frontend.log 2>&1 &
  else
    nohup npm run dev > logs/frontend.log 2>&1 &
  fi
  echo $! > run/frontend.pid
}
start_frontend

# --- 3. wait for health ------------------------------------------------------
BACK_PID=""
[ -f run/backend.pid ] && BACK_PID=$(cat run/backend.pid)
BACK_OK=0
for i in $(seq 1 40); do
  if curl -sf --max-time 2 http://127.0.0.1:8000/pyapi/health >/dev/null 2>&1; then
    echo "[start] backend healthy"
    BACK_OK=1
    break
  fi
  if [ -n "$BACK_PID" ] && ! kill -0 "$BACK_PID" 2>/dev/null; then
    echo "[start] ERROR: backend process exited — last 30 lines of logs/backend.log:"
    echo "--------------------------------------------------------------"
    tail -n 30 logs/backend.log 2>/dev/null || true
    echo "--------------------------------------------------------------"
    break
  fi
  sleep 1
done
if [ "$BACK_OK" != "1" ] && [ -n "$BACK_PID" ] && kill -0 "$BACK_PID" 2>/dev/null; then
  echo "[start] WARNING: backend not healthy yet — check logs/backend.log"
  tail -n 10 logs/backend.log 2>/dev/null || true
fi

FRONT_OK=0
for i in $(seq 1 60); do
  if curl -sf --max-time 2 http://127.0.0.1:3000 >/dev/null 2>&1; then
    echo "[start] frontend healthy"
    FRONT_OK=1
    break
  fi
  if ! kill -0 "$(cat run/frontend.pid 2>/dev/null)" 2>/dev/null; then
    echo "[start] ERROR: frontend process exited — last 30 lines of logs/frontend.log:"
    echo "--------------------------------------------------------------"
    tail -n 30 logs/frontend.log 2>/dev/null || true
    echo "--------------------------------------------------------------"
    break
  fi
  sleep 1
done
[ "$FRONT_OK" = "1" ] || echo "[start] WARNING: frontend not healthy yet — check logs/frontend.log"

# proxy sanity: /pyapi must reach the backend THROUGH the frontend
if [ "$FRONT_OK" = "1" ]; then
  if curl -sf --max-time 4 "http://127.0.0.1:3000/pyapi/health?XTransformPort=8000" >/dev/null 2>&1; then
    echo "[start] /pyapi proxy OK (:3000 -> :8000)"
  else
    echo "[start] WARNING: /pyapi proxy not answering on :3000 (rewrite) — restart frontend if login 404s"
  fi
fi

# --- 4. optional production Caddy :81 ----------------------------------------
if [ "${1:-}" = "--with-caddy" ] && command -v caddy >/dev/null 2>&1; then
  echo "[start] starting Caddy :81 (production entry)…"
  nohup caddy run --config deploy/Caddyfile.production > logs/caddy.log 2>&1 &
  echo $! > run/caddy.pid
fi

echo
echo "[start] ready —  UI http://localhost:3000  (prod entry :81)"
echo "                 REST http://localhost:8000/pyapi/health"
echo "                 WS   :8001 (socket.io)"
echo "[start] stop with ./stop.sh  (or just re-run ./start.sh to restart)"
