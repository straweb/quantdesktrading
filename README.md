# ⚡ Multi-Broker Trading Terminal

**QuantDesk** — the full feature-rich multi-broker trading terminal
(multi-workspace canvas charts with spot+ATM panes, ghost candles and drawing
tools, strikes desk, depth stack, order pad, auto-bot rules, GTT, copy
trading, capital house-sizing, Python strategy builder, dashboards) on an
**OpenAlgo-style Python backend**: FastAPI (REST, tool interactions only) +
socket.io/WebSocket tick-by-tick data plane, per-broker plugin folders,
DB-persisted broker sessions, and a from-scratch **canvas** candlestick chart
(no third-party chart libraries).

Brokers: **Sim feed · ICICI Direct (Breeze) · Dhan · Shoonya (Finvasia)**

---

## Architecture (Round-15 data plane)

```
 Broker WS/REST feeds                 (livestream.icicidirect.com, api-feed.dhan.co,
        │                              api.shoonya.com/NorenWSAPI, sim generator)
        ▼
 backend/brokers/<name>/{broker.py, streaming.py, mapping.py}   ← OpenAlgo-style plugins
        │   registry.py routes EVERYTHING through the mapping layer
        ▼
 MarketHub  :8001 socket.io (WS)  ── ticks / candles / funds / orders / positions
 FastAPI    :8000 REST (/pyapi)   ── TOOL interactions only: login, place order,
        │                           accounts, master sync, settings, workspace zip
        ▼
 Next.js UI :3000  — canvas chart, watchlist, order ticket, funds chip
 Caddy :81 — production entry (→ :3000, and ?XTransformPort=N routing)
```

**Data is push-only.** The UI never polls: ticks stream broker-tick-by-tick,
candles are aggregated server-side per minute and pushed live, and **funds are
on-demand + event-driven** (pushed on `funds:get`, after every order, and on
position changes) — never on a timer.

## Adding a new broker (the mapping/registry point)

1. Create `backend/brokers/<name>/` with:
   - `broker.py` — `Adapter(BaseBroker)`: authenticate / funds / orders / master
   - `streaming.py` — broker feed → unified tick callback
   - `mapping.py` — unified symbol ↔ broker token
2. Add **one line** to `REGISTRY` in `backend/brokers/registry.py`
3. Add a DB path to `BROKER_DBS` in `backend/config.py`

Nothing else changes — routing, hub, UI, DB isolation are generic.

## Run

```bash
cp .env.sample .env         # then edit APP_SECRET / ADMIN_PASSWORD
./start.sh                  # backend :8000 + :8001, frontend :3000
./start.sh --with-caddy     # also production entry :81 → :3000
./stop.sh
```

Sandbox/preview environments: the Caddy gateway routes
`/pyapi?XTransformPort=8000` and `/?XTransformPort=8001` automatically.

| Port | Service |
|------|---------|
| 81   | Caddy production entry → 3000 (+ XTransformPort routing) |
| 3000 | Next.js frontend |
| 8000 | FastAPI REST (`/pyapi/*`) — tool interactions only |
| 8001 | socket.io WebSocket — ticks/candles/funds/orders/positions |

## Environment variables (`.env` — created from `.env.sample`)

| Var | Default | Purpose |
|-----|---------|---------|
| `APP_SECRET` | change-me | signs auth tokens |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / admin123 | first-run login |
| `PYAPI_PORT` / `PYWS_PORT` | 8000 / 8001 | Python REST / WS ports |
| `DEFAULT_TRADING_MODE` | sandbox | `live` enforces LIVE ONLY |
| `TICK_FANOUT_MIN_MS` | 80 | tick coalescing window |
| `FUNDS_CACHE_TTL_S` | 3 | funds burst dedupe |
| `BREEZE_API_KEY/SECRET/SESSION_TOKEN` | — | ICICI defaults (UI stores per-account) |
| `DHAN_CLIENT_ID/ACCESS_TOKEN` | — | Dhan defaults |
| `SHOONYA_*` | — | Shoonya QuickAuth defaults |

## Session persistence (no re-login on refresh)

Every broker session (Breeze session_token, Dhan access_token, Shoonya
susertoken, sim token) is **stored in the backend DB** (`broker_sessions`
table). On page refresh the socket reconnects instantly; on backend restart
stored sessions are reused and only re-validated — regenerated **only** when
the broker rejects them. This also removes the ICICI 401 storm (Breeze
invalidates old sessions whenever a new one is generated; persisting one
session avoids regeneration). REST calls additionally back off exponentially
on 401/503 instead of hammering the broker.

## LIVE ONLY mode (no silent fallback)

The top-bar switch stores a global mode. In **LIVE ONLY**:
- sandbox-mode accounts are detached automatically
- sim ticks are refused for symbols served by live accounts
- when no live feed is connected the UI shows an explicit
  `feed:down` banner — it never silently substitutes sim data.

## Master contracts (live sources, replace-on-sync)

Sync pulls the broker's **live** master file and REPLACES all rows (never
appends — mapping counts stay exact):

| Broker | Live source |
|--------|-------------|
| Breeze | `traderweb.icicidirect.com/.../StockScriptNew.csv` + `directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip` (F&O tokens) |
| Dhan | `images.dhan.co/api-data/api-scrip-master.csv` |
| Shoonya | `api.shoonya.com/{NSE,NFO}_symbols.txt.gz` |
| Sim | generated universe (indices + equities + option chains) |

## Project layout

```
backend/
  main.py                 boots REST :8000 + WS :8001 in one loop
  config.py  db.py  auth.py  session_store.py
  brokers/                OpenAlgo-style plugins
    registry.py           ← the routing/mapping registry
    base.py               ← adapter contract (+ HTTP backoff)
    sim/ breeze/ dhan/ shoonya/   (broker.py + streaming.py + mapping.py)
  market/
    hub.py                subscriptions, tick fan-out, mode enforcement
    aggregator.py         ticks → 1m candles (live push)
    funds.py              on-demand + event-driven funds
  api/
    rest.py               FastAPI /pyapi (tool interactions, workspace zip)
    sio_server.py         socket.io data plane
src/                      Next.js terminal (canvas chart, no chart libs)
mini-services/pyapi/      sandbox/preview launcher for the Python backend
deploy/Caddyfile.production
.env.sample               → cp to .env (never shipped in the zip)
```

## Notes

- **Workspace download** (Accounts → nothing to click; endpoint
  `/pyapi/workspace/download`) zips the project **excluding `.env`, DBs,
  logs, node_modules, .git** — secrets never leave the box.
- Charting is a custom `<canvas>` renderer (candles, live ghost candle,
  volume, crosshair OHLCV legend, last-price line) — zero chart dependencies.
- Sim broker fills orders instantly at feed LTP with slippage and virtual
  funds — useful for wiring/testing without live credentials.
