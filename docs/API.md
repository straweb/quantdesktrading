# API Reference

Two surfaces:

1. **Next.js REST API** — `http://localhost:3000/api/*` (auth: HMAC session cookie `zterm_session` set by `POST /api/auth/login`; unauthorized calls return `401 {"error": "Unauthorized — login as admin"}`).
2. **Feed mini-service** — REST on `:3004` (server-side only) and **socket.io** on `:3003` (browser reaches it through Caddy: `io('/?XTransformPort=3003')`).

---

## 1. Next.js REST endpoints

### Auth

| Method & path | Body / query | Description |
|---|---|---|
| `POST /api/auth/login` | `{username, password}` | sets `zterm_session` cookie |
| `POST /api/auth/logout` | — | clears session |
| `GET /api/auth/me` | — | current user or `null` |

### Accounts & capital

| Method & path | Description |
|---|---|
| `GET /api/accounts` | all accounts + capital state (mode, base/pct, available cash, usable) |
| `POST /api/accounts` | create account (per-broker credential fields, encrypted at rest; live brokers: blank initial capital = 100 % of broker available cash) |
| `GET/PATCH/DELETE /api/accounts/[id]` | read / update (label, `isActive` routing, `credentials` (replace) or `credentialsMerge` (partial — blank/masked keys kept), `capitalBase`, `capitalPct`, capital+mode) / delete. Round-24: credential keys are normalized to snake_case on every write (apiKey→api_key etc.) and the PATCH param-order bug that silently dropped ALL edits is fixed |
| `POST /api/accounts/bulk` | `{accounts: [row…], deleteMissing?}` — bulk add/modify/delete: row WITH `id` → modify (label/mode/credentials-merge/capital fields/`isActive`/`isOrderEnabled`), WITHOUT `id` → add, `"_delete": true` → delete; `deleteMissing: true` also deletes every account absent from the array. Response: `{ok, counts:{created,modified,deleted,errors}, detail[]}`. Powers the Admin → "Bulk JSON" dialog (textarea prefilled with the current accounts; masked secrets round-trip safely) |
| `GET /api/funds` | aggregated per-account funds ledgers |
| `POST /api/funds` | `{accountId?}` — pull REAL broker funds now (one account or every active live account; also runs automatically every 45 s). Repeated pulls share one broker call per 15 s (micro-cache); explicit pulls bypass it |
| `GET /api/portfolio` | live holdings + live marks + open positions |
| `GET /api/margin` | per-account broker margin vs usable (sandbox estimate fallback) |

### Broker sessions & diagnostics

Session flows (per broker, every attempt logged to console + `broker_logs`):
- **ICICI Breeze** — open the apiuser login URL → redirect `?apisession=` → paste it; the terminal exchanges it at `customerdetails` exactly like the Breeze SDK (GET with a JSON body `{SessionToken, AppKey}` — raw `node:https`, since Node fetch cannot send a GET body).
- **Dhan** — three flows: ① paste `PIN:TOTP` → `auth.dhan.co/app/generateAccessToken?dhanClientId=&pin=&totp=` returns the accessToken directly (server-side, no browser); ② app consent (`app/generate-consent` → `login/consentApp-login?consentAppId=` → paste the redirect `tokenId` → `app/consumeApp-consent`); ③ paste a direct JWT from web.dhan.co. **Static IP (SEBI rule):** Dhan API calls only work from whitelisted IPs — the Session dialog shows this server's public IP and offers one-click `v2/ip/setIP` / `v2/ip/modifyIP` sync (7-day edit lock applies).
- **Shoonya** — official OAuth `https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id={client_id}` → redirect `?code=` → paste; GenAcsTok checksum families are tried in order (`{code, checksum}` on NorenWClientAPI, full jData verifiers on NorenWClientTP) and every attempt is logged. QuickAuth alternative: paste `pwd:factor2(:totp)`.

| Method & path | Description |
|---|---|
| `GET /api/broker-auth` | auth status + flow descriptor + login URL (real keys substituted: Breeze `apiuser/login?api_key=<key>`, Shoonya `OAuthlogin?client_id=<id>`; Dhan AUTO-GENERATES the consent login URL when App ID + App Secret are saved — 120 s TTL cache, falls back to the web console URL) + masked `credFields` + `fieldsNeeded`; Dhan adds `serverIp` + `ipInfo` (registered IPs, match check) |
| `POST /api/accounts/[id] (session created)` | after ANY successful `broker-auth complete` the backend auto-syncs master contracts (`trigger=session`), reloads token maps and best-effort connects the account — first login of the day needs no manual Sync; the day-start loop (08:00 IST, 5-min tick) also covers session-holding accounts that are not yet connected |
| `POST /api/broker-auth` | `{accountId, action:'consent'\|'complete'\|'syncIp', code?}` — consent (Dhan generate-consent → consentApp login URL, echoed to the dialog) / session creation (flows above; exchange attempts logged) / Dhan IP sync (`getIP` → `setIP` when none, `modifyIP` when the server IP differs). Completed sessions are persisted in `broker_sessions` — refresh/restart re-uses them |
| `GET /api/broker-sessions` | persisted session status per live account: `{hasSession, connected, validatedAt, expiresAt, autoRenew, renewing, lastAction, error}` — validated against the broker (funds probe, 5-min throttle) and auto-renewed where the stored credentials allow (Shoonya QuickAuth) |
| `POST /api/broker-sessions` | `{accountId?}` — force-validate one account (or all) now |
| `POST /api/broker-test` | `{accountId}` — 4-step connectivity test: credentials → adapter mode → funds ₹ → quote LTP (timed, each underlying call logged) |
| `GET /api/broker-logs` | per-account raw call logs (every outbound broker call is tagged `[BROKER][tag]` and mirrored here) |
| `GET /api/feed/status` | live broker feed engine status: active source, ticking state, last tick age, last error, recent log lines |
| `GET /api/broker-orderbook` | live order book for one account |
| `GET /api/admin/audit` | order audit trail |

### Workspace

| Method & path | Description |
|---|---|
| `GET /api/workspace/export` | streams a ZIP of the project SOURCE (src/brokers/mini-services/prisma/docs/tests/public/strategies + configs — no node_modules/.next/runtime DBs/logs, `*.png|db|log` excluded, **any `.env`/`.env.local` explicitly excluded — secrets never ship**). Use when the platform workspace download fails. CLI twin: `bash scripts/export-source.sh`. |

### Orders

| Method & path | Body | Description |
|---|---|---|
| `GET /api/orders` | — | aggregated master + leg orders |
| `POST /api/orders` | `{symbol, exchange, side, orderType, productType, lots?, qty?, price?, triggerPrice?, capitalPct?, absoluteAmount? ("abs:<₹>" tag), source?}` | place master order → fan-out to enabled accounts (capital-sized) |
| `POST /api/orders/cancel` | `{accountId, orderId}` | cancel one leg |
| `POST /api/orders/cancel-all` | `{symbols?}` | cancel all open orders (optionally filtered) |
| `POST /api/orders/squareoff` | `{symbols?}` | market-close open positions (optionally filtered) |
| `GET /api/positions` · `GET /api/trades` | — | aggregated positions / executed trades |

### Market data proxies (→ feed :3004)

| Method & path | Query | Description |
|---|---|---|
| `GET /api/market/candles` | `symbol, tf, bars` | OHLCV series |
| `GET /api/market/quote` | `symbols` (csv) | LTP/OHLC/bid/ask/volume + lotSize + instrumentType |
| `GET /api/market/ltp` | `symbols` | light LTP batch |
| `GET /api/market/status` | — | feed health mirror |
| `GET /api/market/index` | `symbols` | index constituents + contribution pts |
| `GET /api/market/fno` | — | F&O universe grouped by exchange (expiry, contracts, lot, spot) |

### Options desk

| Method & path | Query / body | Description |
|---|---|---|
| `GET /api/options/underlyings` | — | F&O underlyings + expiries |
| `GET /api/options/chain` | `underlying, expiry?, strikes?` | chain quotes + `ceAtm/peAtm` (CE floor / PE ceil), step, lot |
| `POST /api/options/ensure-strike` | `{underlying, strike, expiry?}` | create contracts on demand (master + mappings + feed universe) |

### Symbols

| Method & path | Description |
|---|---|
| `GET /api/symbols` | browse master symbols (`?symbols=a,b` for explicit list, `?q=` search, exchange/type filters) |
| `POST /api/symbols/sync` | master-contracts sync (indices/eq/futs/weekly-monthly options/BFO/MCX/CDS) → republishes the LIVE universe (non-expired rows) → enriches Dhan/Shoonya mappings with REAL scrip-master tokens (Dhan `api-scrip-master.csv` securityIds + Noren `*_symbols.txt.zip` tsyms, cached 12 h in `db/masters/`) |
| `GET /api/symbols/resolve` | broker-specific token mapping for a symbol |

### Automation

| Method & path | Description |
|---|---|
| `GET/POST /api/autorules` · `PATCH/DELETE /api/autorules/[id]` | auto-bot rules (TIME / INDEX / INDEX_RANGE / COMPOUND conditions, actions BUY/SELL/DEPLOY/CANCEL, strikes list, entry/SL/TGT legs, repeatDaily) |
| `GET/POST /api/gtt` · `PATCH/DELETE /api/gtt/[id]` | GTT orders (edge-trigger on LTP, arm/disarm, repeatDaily) |
| `GET/PATCH /api/copytrade` | copy-trade master/slave routing matrix |
| `GET/POST /api/tickrecorder` | tick recorder config + recorded sessions (POST: toggle / symbols) |
| `GET/POST /api/replay` | paper-trading replay (POST: `{action:'start'\|'stop', file?, random?, fromTs?, toTs?, speed 0.5–20}`) |
| `GET /api/stats/session` | session win rate, realized/unrealized/net ₹, pts, charges, per-account breakdown |
| `GET /api/feed` · `POST /api/feed` | active feed source list + `simDisabled` flag / set `{source}` (radio) or `{simDisabled}` (Live-Only switch — stops the sim random-walk AND refuses sandbox fills) |

### Strategies

| Method & path | Description |
|---|---|
| `GET/POST /api/strategies` · `GET/PATCH/DELETE /api/strategies/[id]` | strategy CRUD |
| `GET /api/strategies/[id]/python` | exported Python code |
| `POST /api/strategy/run` | `{id?, code?, symbol, tf, bars, dryRun?}` — runs in a `python3` subprocess with the SDK; `signal()` routes orders (source `PYTHON`) |

---

## 2. Feed mini-service — REST (:3004)

| Path | Method | Description |
|---|---|---|
| `/health` | GET | `{ok, symbols, ts}` — watchdog target |
| `/candles` | GET | `?symbol&tf&bars` OHLCV (deterministic 3-session 1m backfill + aggregated TFs) |
| `/ltp` · `/quote` · `/depth` | GET | batch market data |
| `/feed-source` | GET/POST | active feed account + `simDisabled` (persisted to `db/feed-source.json`; switching to a live source PURGES all sim candles/states, switching back to sim reseeds from `db/universe.json`) |
| `/feed-status` | GET | live broker feed engine: source, connected, last tick age, last error, log ring |
| `/universe` | POST | publish symbol universe (from master sync) |

**Live broker feed engine** — when the active source is a live account, the feed service polls that broker's quote APIs every second (Dhan `marketfeed/quote` batched per segment, Shoonya `GetQuote`, Breeze `/quotes`), maps master symbols via `SymbolMapping`, decrypts the account session (re-read every 60 s), and pushes ticks into the same pipeline as the sim engine (fed symbols skip the random walk). Symbol mappings re-read every 2 min; status surfaces on `/feed-status`.
| `/tick-config` | GET/POST | tick recorder on/off + symbol list (`db/ticks/tick-recorder.json`) |
| `/tick-sessions` | GET | recorded session DBs |
| `/tick-sample` | GET | sample rows from a session (replay preview) |
| `/replay-config` | POST | `start/stop` replay `{file?, random?, fromTs?, toTs?, speed}` |
| `/replay-status` | GET | replay progress |

## 3. Socket.io channels (:3003)

**Emits (client → server)**

| Event | Payload | Purpose |
|---|---|---|
| `subscribe` / `unsubscribe` | `string[]` symbols | tick stream control |
| `sync:sub` | `{underlyings, indices, …}` | register per-socket sync parameters |

**Events (server → client)**

| Event | Rate | Payload |
|---|---|---|
| `ticks` | ~250 ms | `Record<symbol, Tick>` (ltp/ohlc/bid/ask/vol) |
| `sync:core` | 1 s | accounts (incl. capital base/pct/cash), positions, orders, trades, funds, session stats |
| `sync:chain` | 1 s | option chain meta per underlying (CE floor / PE ceil ATM, ±15 steps) |
| `sync:index` | 1 s | index constituents + points contribution |
| `sync:admin` | 2 s | admin/dashboard data plane: `feed` (engine health), `feedSource` (active source + sources), `accountsMeta` (per-account session presence), `brokerLogs` (per-account tails), `audit` (OrderAudit tail), `copyTrade` config, `strategies` (+ log tails), `syncInfo` (symbol/mapping counts + last sync), `gtt` rules, `autoRules`, `tickRecorder` (config + sessions), `replay` status |

Client helpers live in `src/components/terminal/lib/socket.ts` (ticks) and `src/components/terminal/lib/sync.ts` (`onSync` / `useSyncChannel` / `useSyncData`, with REST fallback).

`sync:admin` replaces the former REST polls across the UI — the Dashboard (master health + per-account dashboards), Admin view (logs / audit / copy-trade / sync-info / recorder / replay), Logs panel, Strategy view, Auto bot panel and the FEED chip all consume the websocket push and only fall back to REST while the socket is down.
