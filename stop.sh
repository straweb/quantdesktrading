#!/usr/bin/env bash
# Trading Terminal — stop backend + frontend + caddy
cd "$(dirname "$0")"

for name in backend frontend caddy; do
  if [ -f "run/$name.pid" ]; then
    pid=$(cat "run/$name.pid")
    if kill -0 "$pid" 2>/dev/null; then
      echo "[stop] stopping $name (pid $pid)…"
      # kill the whole process group first (npm/bun spawn children)
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      for i in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.3
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "run/$name.pid"
  fi
done

# stray children (uvicorn/socket.io workers / next dev / bun / uv-run app.py)
pkill -f "backend.main" 2>/dev/null || true
pkill -f "venv/bin/python app\.py" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true

# wait for the ports to actually free up so a restart binds cleanly
for port in 8000 8001 3000; do
  for i in $(seq 1 20); do
    if ! curl -s --max-time 1 -o /dev/null "http://127.0.0.1:$port" 2>/dev/null; then
      break
    fi
    sleep 0.3
  done
done

echo "[stop] done"
