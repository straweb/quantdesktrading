# User Guide — Multi-Broker Trading Terminal

A practical, screen-by-screen guide to operating the terminal. Open the app at **http://localhost:81** (production gateway) and sign in — default credentials are `admin` / `admin123` (change them in the Admin view for production).

---

## 1. Screen layout at a glance

```
┌────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR   logo · Terminal/Strategy/Dashboard/Admin · FEED chip ·           │
│           session-stats chip · capital chips (one per account)             │
├──────────┬──────────────────────────────────────────────┬──────────────────┤
│ LEFT     │  CENTER — chart panes (resizable layouts)    │ RIGHT DOCK tabs  │
│ Watchlist│   spot chart, ATM CE/PE panes, scratch pane  │  Strikes         │
│ tabs +   │   each pane: toolbar row, legend, drawing    │  Order Pad       │
│ depth    │   tools, per-chart indicators/ghost/scales   │  Auto            │
│ stack    ├──────────────────────────────────────────────┴──────────────────┤
│          │ BOTTOM DOCK — Orders | Trades | Positions | Funds | Broker Logs  │
└──────────┴──────────────────────────────────────────────────────────────────┘
```

Everything is persisted per **workspace**: layouts, timeframes, indicators, drawings, strike lists, watchlist tabs and bottom-dock state survive reloads and are restored after login.

---

## 2. Top bar

### 2.1 View switcher

- **Terminal** — the main trading screen (watchlist + charts + strike panel + orders).
- **Strategy** — strategy builder and Python runner (see §10).
- **Dashboard** — Master (admin) KPI overview: net P&L, win rate, net points, margin used, charges, fill rate, realized-P&L curve, per-account table, portfolio (live holdings + positions), margin calculator, GTT manager. Plus the **Master — system health** strip (feed engine, broker sessions, symbol universe, copy-trade + recorder) and **account dashboards** — one realtime card per broker account; click a card for the full per-account drill-down (funds, positions, orders, session stats, broker logs). Everything flows over the websocket (no REST polling).
- **Admin** — accounts, copy-trade routing, capital config, tick recorder, replay manager, broker sessions, audit log (see §11).

### 2.2 FEED chip (feed source & account control)

The `FEED LIVE <source>` chip opens a dropdown with **one row per account**:

- radio — select which account's feed drives the whole terminal (one active feed source at a time; the built-in **Sim Feed** is the default);
- **live-feed health** — when a broker account feeds the terminal, the chip carries a data dot (green = ticking, amber = stalled) and the dropdown shows the poll state (symbols fed, last tick age, last error — e.g. "no session — create it in Admin → Session");
- **PnL** — live per-account P&L, coloured by sign;
- **Cap** — current usable capital; **click it to edit capital inline** — `% of available cash` or fixed ₹, each with a **slider + input box side-by-side** (slider steps: 1 % / ₹5k; typing any value also works, both stay in sync), **changeable at any time (even while connected)**; the 🎒 wallet icon pulls the **REAL broker available cash** on demand (the % base also auto-refreshes from the funds API every 45 s); the same slider editor lives in the top-bar **capital chips** popover;
- 🔗 / 🔗̶ **Connect / Disconnect** icon — enables or disables the account for order routing (disconnecting the currently feeding account automatically falls back to the sim feed);
- 📡 **Feed on/off** icon — use this account as feed source or revert to sim.

> Note: the FEED chip is LIVE only when the app is opened through the **:81 Caddy gateway**. Opened directly on :3000 the browser cannot reach socket.io (:3003 has no proxy path there) and the chip shows DOWN — this is expected.

### 2.3 Session stats chip

Trophy chip showing the session **win rate** and **net points** (Σ realizedPnL / qty). Click for the breakdown: realized / unrealized / net ₹, charges, per-account and top-symbols tables (this powers the Dashboard KPI row too).

### 2.4 Capital chips (one per account)

Icon-only chips (broker glyph + compact ₹ amount) summarizing each account:

- **coloured dot** = order-routing enabled/disabled;
- **amber `%` badge** = capital source is "% of available cash" mode;
- click to open the popover:
  - **order-routing Switch** — instant enable/disable of this account in the fan-out;
  - **capital source picker**: `Fixed ₹` or `% of cash` (1–100 with a live "= ₹" preview from the broker's available funds);
  - **capital size input** and **sizing-mode select** (the three house modes, §12);
  - realized P&L and computed **usable ₹** with a plain-language explanation line;
  - **Apply** commits.

---

## 3. Workspaces & chart layouts

Tabs across the top of the terminal are **workspaces**. Create as many as you like; each remembers its own layout, charts, strikes, watchlist tab and bottom-dock state.

- **Layouts** (`[1]` `[S+2]` `[2×2]` selector in the toolbar):
  - `1` — single chart;
  - `S+2` — spot chart on top, **live ATM CE** (left) and **ATM PE** (right) panes below — the default for any F&O workspace;
  - `2×2` — spot / CE / PE / scratch grid.
- **Pane dividers are draggable** (react-resizable-panels).
- **ATM-follow vs PIN**: option panes follow the live side-ATM (CE ATM = floor(spot/step), PE ATM = ceil(spot/step)) and re-key as spot moves, showing an *ATM-follow* badge. Clicking a strike row **pins** that strike into the CE or PE pane (pin badge + unpin button). The scratch pane defaults to the underlying spot.
- Every index and F&O stock opens with the **default three-chart layout** (spot + ATM CE + ATM PE) and the right-dock strike tab pre-loaded. Clicking a watchlist symbol (or an index constituent) opens its own per-symbol workspace.
- **Depth buttons** (layers icon) at the start of every pane header push that symbol into the left depth stack (§5.3).

### Timeframes

1m / 3m / 5m / 15m / 30m / 1h / 1d from the toolbar. The interval is **auto-locked across all open charts in a workspace** so the synced crosshair can work.

---

## 4. Charts — the in-house Canvas engine

Charts are rendered on raw Canvas (no TradingView). All per-chart settings live under each pane's toolbar row and persist per chart.

### 4.1 Toolbar row (under the legend, single row of groups)

`[Cursor] | [Type] [Ind] [Ghost] [Scale] [Breaks] | [Lines] [Fib] [Shapes] [Measure] [Position] [Annotate] [Pattern] | [Clear n]`

- Groups are **icon + text buttons**; clicking a group opens a flyout menu (click again or press Esc / click outside to close). Hovering a group shows an amber **info note** describing the tools inside.
- The flyout **stays open** so you can toggle several things at once.
- The `[Clear n]` group removes drawings (n = count on this chart).
- Per-chart settings are independent — two panes can use different indicators/ghost/scales.

### 4.2 Chart types & indicators (`Type`, `Ind`)

- Types: **candles / line / area**.
- Overlays: **SMA 20 / SMA 50 / EMA 9 / EMA 21 / Session VWAP** (IST-day reset) / **Bollinger(20,2)**.
- Sub-panels: **RSI(14)** (30/70 guides), **MACD(12,26,9)**, **ADX(14)** (+DI/−DI dashed, ADX purple, 20/40 guides) — stacked slots with legend readouts.
- **Volume histogram** renders in every mode (compact band in option panes) with a `Vol` max label.

### 4.3 Ghost candles (`Ghost`)

The ghost overlay renders a second timeframe inside/around the chart's own candles. The rule is fixed: **live-feed candles are always SOLID; ghost candles are always HOLLOW** — in both directions:

- **ghost TF lower than chart TF** (e.g. 5m chart + 1m ghost): hollow 1m candles drawn *inside* the solid base candles (with a carve-out notch where they overlap so hollow bars stay visible);
- **ghost TF higher** (e.g. 1m chart + 15m ghost): hollow 15m *shells* wrapped outside the solid 1m candles (`· 15m shell ·` shown in the legend).

Pick the ghost TF (1m/3m/5m/15m/1h) and style (Hollow / Fade) from the flyout. The legend's second row always shows the inner TF's OHLCV.

### 4.4 Scales (`Scale`)

Right-axis scale modes (topmost enabled wins): **Price**, **Percent**, **Inverted %**, **Points** — plus a left **measurement column** with tinted labels for the others. All percent/point modes need a **baseline** (defaults to the session open, dashed amber line):

- **drag the baseline** (grab anywhere along the line) to move it;
- or use `Set baseline` pick-mode, then click any chart point;
- double-click resets to session open.

### 4.5 Breaks (`Breaks`)

Per-chart vertical guides: **session** (09:15 / 15:30 IST lines + band shading), **hour** (dashed line each IST hour, in-session only), **range** (previous-day high/low dotted lines + break-triangle markers where today crossed them).

### 4.6 Drawing tools (28)

Click a tool, then click-click (two anchors) or drag on the canvas. `Esc` cancels, `Del` deletes the selected drawing, endpoints can be re-dragged, drawings survive pan/zoom/reload (stored per chart).

| Group | Tools |
|---|---|
| **Lines** | trend line, ray, horizontal line, horizontal ray, vertical line, arrow |
| **Fib** | retracement (0.382…0.786), extension (…2.618), time zones, fan |
| **Shapes** | rectangle, ellipse, circle |
| **Measure** | price-range (Δ pts, %, bars, duration), forecast (projected Δ box) |
| **Position** | **Long position / Short position boxes** (see §4.7) |
| **Annotate** | text, price note, pin/flag, comment (leader + bubble), callout (arrow + bubble), table (`|`-separated rows), pencil/free-hand |
| **Pattern** | multi-point pattern (click vertices, double-click / Enter / right-click to finish) with a **flat pattern list** — Double Top/Bottom, Head & Shoulders, Triangles, ABCD, Flags, Wedges… |

Text-style tools open an inline editor at the anchor — `Enter` commits (empty input deletes), `Esc` cancels.

### 4.7 Long / Short position tool

Draws an entry→target box with a built-in risk plan:

- defaults: **1 : 1.5 reward-to-risk** and **10 % stop-loss** distance;
- **drag the Target or SL edge** to reshape (the box re-computes RR live);
- box-resize handles reshape the target zone;
- use it to plan trades, and combine with §4.8 markers to actually place orders.

### 4.8 Position markers & drag-to-order

While you hold a position, its chart shows an **entry marker** (L/S tag with live PnL ₹ and %) plus **suggested SL / Target lines** (auto-seeded ±2 % / ±4 %):

- **drag a line to any price** — on drop it arms a **real reduce-only order** for your held quantity: dragging the upper line sets a *close/target* (LIMIT), dragging below sets a *stop-sell* (long) or *stop-buy* (short) SL-M;
- labels read `CLOSE`, `S·SELL` / `S·BUY` accordingly;
- **re-dragging replaces** the previous exit orders (stale ones are cancelled automatically);
- double-click a line removes it.

### 4.9 Legend, crosshair, zoom & pan

- The legend is **always on**: symbol · TF · LTP · chg% · O/H/L/C/V · time + indicator readouts; hovering emphasizes the focused candle.
- **Crosshair sync**: hovering one chart draws the crosshair + time/price bubbles on every same-timeframe chart in the workspace.
- **Wheel** = time zoom; **wheel on the price axis** (or Shift+wheel) = price-scale zoom; **drag plot** = free pan (both axes); **drag price axis** = squeeze/stretch; **drag time axis** = time pan; **double-click** resets.
- Panning reveals **≥3 bars of future space** (projected time labels + dashed divider). The floating **▶ LIVE** button (green dot) snaps the view back to the live edge.

---

## 5. Watchlist (left panel) & depth stack

### 5.1 Tabs

- **Watch** — starred symbols (star anything to add it to the *active* user tab);
- **Index** — indices with **expandable constituents** (weight, live LTP, change %, **contribution in points**, sortable); includes a **Commodities · MCX** section; SENSEX/BANKEX included;
- **FNO** — all exchanges grouped with sticky headers: **NSE F&O / BFO / MCX / CDS** — latest expiry, contract count, lot size, live spot + change %;
- **N user tabs** — add your own tabs (double-click to rename, × to delete), star symbols into the active tab;
- per-tab **sort** (symbol / LTP / chg% ↑↓) and a **search box** — typing queries the FULL synced master-contract list (round-13: the REAL broker masters — every NSE equity/index, NFO/BFO/MCX/CDS futures & options ≈ 55k instruments) regardless of tab; results replace the tab rows until you clear the box;
- every row has a **depth-add icon** (pushes that symbol into the depth stack) and clicking a row opens its per-symbol workspace (F&O symbols land with the spot+CE/PE layout ready).

### 5.2 Depth panels (order-book stack)

`[+]` in the watchlist (or the layers icon on any chart/strike row) adds a **market-depth panel** for that symbol. Up to 6 stack bottom-left; drag the top grip to resize (96–460 px); × removes. Options show **quantity in lots** (header shows the lot size).

---

## 6. Strike Panel (right dock → *Strikes*)

The options desk. Bind it by opening an F&O workspace (auto) or pick an underlying + expiry manually.

### 6.1 Header bar

Spot LTP, computed **ATM** (CE/PE), strike step, lot size, and the workspace allocation mode toggle **[% / ₹]**.

### 6.2 Quick-add rows

- `ITM [5..1] · ATM · OTM [1..5]` buttons per side — labels are **live ITM/OTM semantics** (CE: negative offset = ITM; PE mirrored). Titles show the exact strike each button will add (e.g. `CE ITM1 → 22950`). Buttons **track spot in realtime** via the sync hub, so they never go stale.
- A **specific-strike input** (snaps to the step) creates contracts on demand — new strikes are added to the symbol master, broker mappings and the feed universe automatically.

### 6.3 Strike rows

Line 1: enable toggle · strike + ITM/ATM/OTM label · **allocation slider + %** (or ₹ amount in FIXED mode) · LTP + change pts(%) · day H/L · position badge (L/S lots).
Line 2: `≈ ₹amount · N lots · ₹/lot` sizing preview · per-strike PnL · `B` / `S` (plain market buy/sell of that strike) · `X` (remove row) · **edit** (inline desk: Entry / Target / StopLoss price orders at price, Δ lots per leg, exit full) · **depth-add icon**.

- **Side headers** show side Σ%, side PnL and (in % mode) keep enabled rows **normalized to exactly 100 %** (proportional scaling).
- **Sort bar**: strike / LTP / chg% / PnL ↑↓; **filters**: all / enabled / has-position.
- The strike loaded in a chart pane glows (active-strike ring).

### 6.4 Deploy bar

`Deploy CE` · `Deploy PE` · `Cancel CE` · `Cancel PE` · `Swap CE→PE` · `Swap PE→CE` · `Exit All` + a live **PnL strip** (open / booked / net, per-account nets).

- **Deploy** sends one master order per *enabled* strike, fanned out to every routing-enabled account, sized per account by its capital rules (toast: `Deploy CE: 3/3 enabled strikes · 9 account fills`).
- **Swap** squares off the from-side legs then deploys the to-side (auto-adds the side ATM if the list is empty).
- **Exit All** flattens every open position from the terminal.

---

## 7. Order Pad (right dock → *Order Pad*)

Manual order ticket with the **AUTO house-sizing preview per account** before you send: symbol, side (B/S), order type (MARKET / LIMIT / SL / SL-M), product (MIS/CNC/NRML), lots with editable quantity, limit/trigger prices. Each enabled account's expected lot count is previewed from its usable capital before submit.

---
## 8. Auto Bot (right dock → *Auto*)

Event-driven rules that place orders automatically. A rule combines up to **three conditions (AND)** and fires only when *all* enabled conditions are true on the same 250 ms engine tick:

| Condition | Meaning |
|---|---|
| **Time** | fires at `HH:MM(:SS)` IST — seconds precision, 2 s window solo / up to 5 min when combined |
| **Index range** | fires when the index spot enters the `[lo, hi]` band (steady-state inside the band) |
| **Premium** | gate on the chosen option's own LTP — `≤ x`, `≥ x`, or `[lo, hi]` (delta/gamma-aware) |

Action per arm: **BUY** / **SELL** / **DEPLOY** (buy the arm's strike list) / **CANCEL** (cancel pending orders of those symbols).

Strike selection per arm: **ATM ± 0–5** offset buttons with live ITM/OTM labels, or a **strike picker** — checkbox list of the workspace's strike rows with per-strike allocation, plus quick-add buttons that create and select strikes on demand.

Optional **legs** after fill: entry LIMIT price, stop-loss (reduce-only SL-M) and target (reduce-only LIMIT) — armed automatically at your held quantity.

- `repeat daily` arms the rule every trading day, otherwise it is one-shot.
- The list shows each rule's kind icons, strike count, leg badges, arm/disarm switch, last status/message and delete.
- Set `AUTO_DEBUG=1` in `.env` to log every fire decision server-side.

## 9. Bottom dock

Tabs — **Orders · Trades · Positions · Funds · Broker Logs** — each label carries live counts (`ORD 2/180`, `POS 3/33`). Collapse with the chevron: the dock shrinks to a slim **session bar** (≈36 px min-height) showing `ORD · POS · net ₹ · pts` plus quick tab buttons.

Row actions:

- **Positions**: `Repeat` (re-enter same side/size) · `Swap` (close + reverse) · `Edit` (inline Δ lots per account) · `Exit` (close position);
- **Orders**: `Edit` (cancel-and-replace with new qty/price) · `Cancel` (for OPEN) · `Repeat` (for filled/cancelled/failed);
- **Funds**: per-account cash, margin used, available;
- **Broker Logs**: per-account adapter log lines for debugging live-broker calls.

Quick global actions live in the header of the dock: **B / S** quick tickets, **Cancel All**, **Square Off All**.

## 10. Strategy view (builder + Python runner)

- Build a strategy from blocks (symbol, timeframe, entry/exit conditions, SL/target/trailing, schedule) or open the **Python console**:
  - code editor with symbol / timeframe / bars / **dry-run** options;
  - injected SDK: `get_candles(symbol, tf, bars)`, `get_quote(symbol)`, `log(...)`, `signal(side, qty=None, price=None, msg=..., symbol=...)` — data streams from the feed service REST (:3004);
  - `signal()` routes through the same capital-aware router as manual orders (source `PYTHON`);
  - saved strategies can be exported as `.py` files (`strategies/`) and run by id.
- Strategy logs (runs, signals, errors) are visible per strategy; a 20 s subprocess timeout guards runaway code.

## 11. Admin view

- **Trading mode (Live-Only switch)** — the *Disable Sim Feed & Sandbox* checkbox at the top of Admin. ON: the sim random-walk stops for every symbol (charts show real broker data or nothing) and broker adapters **refuse** sandbox fills — orders without a live broker session are REJECTED, never simulated. OFF: sim feed + sandbox available as usual. The FEED chip shows an amber **LIVE-ONLY** badge while it is on.
- **Live-Only steering (round-13)** — while Live-Only is ON the terminal can never sit on a sandbox account: enabling the switch auto-moves the feed source from any session-less account to the first account that HAS a broker session (same broker preferred; a toast tells you it moved), the FEED dropdown badges every account **LIVE** (session present) or **SANDBOX** (no session) and blocks sandbox rows, and the API refuses them outright.
- **Session expiry surfacing (round-13)** — broker sessions expire daily (ICICI Breeze especially). When the broker rejects the credentials the FEED chip shows `SESSION REJECTED by <broker> (…) — re-create it in Admin → Session`, the feed engine re-reads credentials every cycle (a freshly created session is picked up within a second) and backs off 30 s between attempts instead of hammering the broker; the funds chip returns the same remedy (e.g. for ICICI's `Invalid User Details` / `Unauthorized User`) instead of a raw error. Fix: Admin → accounts → **Session** → re-run the login flow.
- **Accounts** — add/remove broker accounts. Live brokers use per-broker **OAuth-style credential fields** (ICICI: api key + secret; Dhan: client id + optional partner id/secret; Shoonya: user id + api key + secret). Every input shows a **sample value / format hint** (e.g. Dhan client id `1100123456`, Shoonya user id `FA12345`). For live brokers, leave **Initial Capital blank** and the account starts with **100 % of the REAL broker available cash** (pulled from the funds API; changeable anytime).
- **Edit accounts** — the ✏️ button on a live account row opens the Edit dialog: user id / client id / api key / secret can be **modified at any time** (stored values show masked; leave a field empty to keep it — secrets never need retyping).
- **Broker sessions** — per live account, a **Session** dialog walks the consent flow: open/copy the generated login URL → paste the returned code/token → create session. Active sessions show a masked session chip and a green state. Flows per broker:
  - **ICICI Breeze** — paste the redirect `apisession`; the exchange uses the exact Breeze-SDK call (GET with body `{SessionToken, AppKey}`).
  - **Dhan** — three flows: ① paste **`PIN:TOTP`** (e.g. `123456:987654`) for direct token generation; ② **app consent** (OpenAlgo parity): save the DhanHQ **App ID + App Secret** (web.dhan.co → profile → DhanHQ Trading APIs → create app) and your Dhan Client ID, press *Generate consent* → `auth.dhan.co/app/generate-consent?client_id=…` → log in at the consentApp-login URL → paste the redirect `tokenId` (exchanged at `app/consumeApp-consent`); ③ paste a direct JWT from web.dhan.co.
  - **Shoonya** — official OAuth URL (`api.shoonya.com/OAuthlogin/authorize/oauth?client_id=…`) → paste the redirect `code` (single-use + short-lived: always open a FRESH one). The exchange sends `GenAcsTok` with `checksum = sha256(app_client_id + api_secret + code)` (documented variant first, fallbacks tried automatically). QuickAuth alternative: paste **`pwd:factor2`** (optionally `:totp`), e.g. `mypass:ABCD1` or `mypass:ABCD1:987654`.
- **Broker Diagnostics** — the debugging panel: pick an account → **Test connection** runs a timed 4-step report (credentials → adapter mode → funds ₹ → quote LTP) and the raw **broker log stream** below shows every outbound call (`[BROKER][tag] METHOD url → status (ms)`), so a failing integration is visible line by line.
- **Copy-trade routing** — the master/executes matrix: which account receives fan-out orders (order-routing toggle mirrors the capital chips).
- **Capital config** — per account: initial capital, source (fixed ₹ / % of available cash), sizing mode, reset.
- **Tick Data Recorder** — RECORDING switch, symbol chips (default NIFTY + SENSEX), current session rows and the list of recorded session DBs (replay data source).
- **Replay Manager (paper trading)** — start a replay from a **random recorded session** or a specific session / IST date-time range, at **0.5×–20×** speed. Replayed ticks stream as if live (virtual clock), so charts, strikes, auto-bot and orders all behave exactly like a market day. Stop returns the feed to normal simulation.
- **Audit log** — order audit trail (source, account fan-out, sizing decisions).

## 12. Capital sizing — the house concept

Every order routed to an account is sized from its **usable capital**:

```
Fixed ₹ source:   usable = f(mode) − deployed
% of cash source: usable = capitalPct% × live available cash − deployed
```

| Mode (fixed ₹ source only) | Deployable base |
|---|---|
| **PROFIT_ONLY** | first trade uses the full initial capital; afterwards only accumulated **net profit** |
| **INITIAL_PLUS_PNL** | initial capital **+ realized P&L** (compounding) |
| **INITIAL_WITH_LOSS_REDUCTION** | initial capital **− every loss incl. charges**; profits never add back |

- `deployed` = margin locked in open positions — always subtracted.
- **Exits never bypass sizing checks** — closing/reducing positions is always allowed.
- With `% of cash`, the cash balance *is* the live pot (P&L already inside it), so house modes are bypassed by design (noted in the UI).
- Per-strike `% allocation` splits each side's usable capital; `FIXED ₹` mode sends absolute amounts (clamped to usable).

## 13. Order flow & safety

- Orders fan out from the **master order** to every routing-enabled account; each leg is sized independently and audited.
- Broker charges (STT, GST, txn, SEBI, stamp, brokerage) are computed per leg per segment and settled into realized P&L and the funds ledger.
- Resting orders (Entry/Target/SL from the strike desk or marker drags) are monitored **every second** on sim feed; live accounts reconcile fills against the real broker book **every 5 s** (auth-retry included).
- **Kill switch discipline**: `Exit All` + `Cancel All` + `Square Off All` are always one click away (bottom dock header).

## 14. Troubleshooting / FAQ

| Symptom | Cause & fix |
|---|---|
| FEED chip shows **DOWN** on :3000 | Expected — browser socket.io only proxies via Caddy (:81). Use http://localhost:81. |
| FEED chip DOWN on :81 | Feed service not running — check `curl localhost:3004/health`; the watchdog respawns it within ~10 s, or start it manually (`cd mini-services/market-feed && PORT=3003 REST_PORT=3004 bun index.ts`). |
| Login fails after restart | Hard-refresh the tab (stale HMR chunks). Default `admin`/`admin123` is re-seeded only if the admin row is missing. |
| Option quotes empty after feed restart | The universe guard republishes 850+ symbols automatically; if you restarted the feed manually, wait one watchdog cycle or restart the Next process. |
| Live broker returns 401 | Session expired — re-run **Admin → Accounts → Session** for that account. |
| Orders rejected "insufficient capital" | House rules — that account's usable capital is ₹0 (e.g. PROFIT_ONLY after losses). Adjust in the capital chip popover. |
| Can't see ITM/OTM on quick-add buttons | Open an F&O workspace first — labels come from the live option-chain sync. |
