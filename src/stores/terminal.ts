"use client";
/**
 * Terminal store — single source of truth for the trading UI.
 * Everything real-time arrives via socket.io events (no REST polling);
 * REST is used only for tool interactions (login/orders/accounts).
 */
import { create } from "zustand";
import { getSocket, pyapi, setRestToken } from "@/lib/terminal-client";

export type Tick = {
  symbol: string;
  ltp: number;
  bid?: number | null;
  ask?: number | null;
  vol?: number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prev_close?: number | null;
  ts: number;
  source: string;
};

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type OrderRow = {
  id?: number;
  symbol: string;
  side: string;
  qty: number;
  price?: number | null;
  order_type: string;
  product: string;
  status: string;
  avg_price?: number | null;
  broker_order_id?: string;
  created_at?: number;
};
export type PositionRow = {
  id?: number;
  symbol: string;
  qty: number;
  avg_price: number;
  ltp: number;
  pnl: number;
  product: string;
};
export type FundsData = {
  available?: number;
  used?: number;
  total?: number;
  source?: string;
  error?: string;
  ts?: number;
};
export type AccountRow = {
  id: number;
  broker: string;
  label: string;
  mode: string;
  status: string;
  status_message?: string;
  credentials: Record<string, string>;
  initial_capital?: number | null;
  initial_capital_mode?: string | null;
  has_credentials?: boolean;
};
export type MasterStatus = Record<string, {
  symbols: number;
  mappings: number;
  last_sync?: { source_url: string; source_kind: string; symbols: number; ts: number } | null;
}>;

type TerminalState = {
  user: { username: string; role: string } | null;
  token: string | null;
  wsConnected: boolean;
  rttMs: number | null;
  mode: "live" | "sandbox";
  feedDown: { symbol: string; reason: string } | null;
  ticks: Record<string, Tick>;
  candleSymbol: string;
  candleTf: number;
  candles: Candle[];
  liveCandle: Candle | null;
  funds: FundsData | null;
  orders: OrderRow[];
  positions: PositionRow[];
  accounts: AccountRow[];
  masterStatus: MasterStatus;
  watchlist: string[];
  lastSyncInfo: string | null;
  init: () => () => void;
  login: (u: string, p: string) => Promise<void>;
  logout: () => void;
  loadAccounts: () => Promise<void>;
  loadMasters: () => Promise<void>;
  loadWatchlist: () => Promise<void>;
  watchCandles: (symbol: string, tf: number) => void;
  requestFunds: () => void;
  refreshOrders: () => void;
  refreshPositions: () => void;
  setMode: (m: "live" | "sandbox") => Promise<void>;
};

const emptyState = {
  user: null,
  token: null,
  wsConnected: false,
  rttMs: null,
  mode: "sandbox" as const,
  feedDown: null,
  ticks: {},
  candleSymbol: "NSE:NIFTY",
  candleTf: 1,
  candles: [],
  liveCandle: null,
  funds: null,
  orders: [],
  positions: [],
  accounts: [],
  masterStatus: {},
  watchlist: [],
  lastSyncInfo: null,
};

function persist(token: string | null, user: TerminalState["user"]) {
  try {
    if (token) {
      localStorage.setItem("tt_token", token);
      localStorage.setItem("tt_user", JSON.stringify(user));
    } else {
      localStorage.removeItem("tt_token");
      localStorage.removeItem("tt_user");
    }
  } catch {
    /* ignore */
  }
}

export const useTerminal = create<TerminalState>((set, get) => {
  const socket = () => getSocket();

  const handlers: Array<[string, (data: unknown) => void]> = [
    ["tick", (d) => {
      const t = d as Tick;
      set((s) => ({ ticks: { ...s.ticks, [t.symbol]: t } }));
    }],
    ["candle", (d) => {
      const c = d as Candle & { symbol: string; tf: number; live: boolean };
      const st = get();
      if (c.symbol !== st.candleSymbol || c.tf !== st.candleTf) return;
      if (c.live) set({ liveCandle: c });
      else {
        set((s) => {
          const arr = [...s.candles];
          const idx = arr.findIndex((x) => x.t === c.t);
          if (idx >= 0) arr[idx] = c;
          else if (!arr.length || c.t > arr[arr.length - 1].t) arr.push(c);
          return { candles: arr.slice(-450) };
        });
      }
    }],
    ["candles:history", (d) => {
      const p = d as { symbol: string; tf: number; candles: Candle[] };
      const st = get();
      if (typeof window !== "undefined") {
        (window as unknown as { __ch: unknown }).__ch = {
          got: { symbol: p.symbol, tf: p.tf, n: (p.candles || []).length },
          state: { symbol: st.candleSymbol, tf: st.candleTf },
        };
      }
      if (p.symbol === st.candleSymbol && p.tf === st.candleTf) {
        set({ candles: p.candles, liveCandle: null });
      }
    }],
    ["funds", (d) => {
      const f = d as FundsData;
      set({ funds: { ...f, ts: f.ts || Date.now() } });
    }],
    ["orders", (d) => set({ orders: (d as OrderRow[]) || [] })],
    ["positions", (d) => set({ positions: (d as PositionRow[]) || [] })],
    ["order_update", () => {
      get().refreshOrders();
      get().refreshPositions();
    }],
    ["mode", (d) => {
      const m = (d as { mode: string }).mode as "live" | "sandbox";
      set({ mode: m });
    }],
    ["account_status", () => {
      get().loadAccounts();
    }],
    ["feed:down", (d) => set({ feedDown: d as { symbol: string; reason: string } })],
    ["master:synced", (d) => {
      const r = d as { broker: string; symbols: number; source_kind: string };
      set({ lastSyncInfo: `${r.broker}: ${r.symbols} symbols (${r.source_kind})` });
      get().loadMasters();
    }],
    ["connect", () => {
      set({ wsConnected: true, feedDown: null });
      const st = get();
      socket().emit("sub", { symbols: st.watchlist });
      socket().emit("candles:get", { symbol: st.candleSymbol, tf: st.candleTf });
      socket().emit("funds:get", {});
      socket().emit("orders:get", {});
      socket().emit("positions:get", {});
      socket().emit("mode:get", {});
    }],
    ["disconnect", () => set({ wsConnected: false })],
  ];

  // rtt probe (lightweight, 4s — measures the full WS round trip)
  setInterval(() => {
    const s = socket();
    if (!s.connected) return;
    const t0 = performance.now();
    const timer = setTimeout(() => set({ rttMs: null }), 3000);
    s.emit("ping-rtt", { t: t0 });
    s.once("pong-rtt", () => {
      clearTimeout(timer);
      set({ rttMs: Math.round(performance.now() - t0) });
    });
  }, 4000);

  return {
    ...emptyState,

    init: () => {
      // restore session (page refresh must NOT require reconnect/auth again)
      let token: string | null = null;
      let user: TerminalState["user"] = null;
      try {
        token = localStorage.getItem("tt_token");
        user = JSON.parse(localStorage.getItem("tt_user") || "null");
      } catch {
        /* ignore */
      }
      if (token && user) {
        setRestToken(token);
        set({ token, user });
      }
      for (const [ev, fn] of handlers) socket().on(ev, fn as never);
      const cleanup = () => {
        for (const [ev, fn] of handlers) socket().off(ev, fn as never);
      };
      if (token) {
        get().loadAccounts();
        get().loadMasters();
        get().loadWatchlist();
      }
      return cleanup;
    },

    login: async (u, p) => {
      const res = await pyapi<{ token: string; username: string; role: string }>(
        "/auth/login", "POST", { username: u, password: p });
      setRestToken(res.token);
      persist(res.token, { username: res.username, role: res.role });
      set({ token: res.token, user: { username: res.username, role: res.role } });
      get().loadAccounts();
      get().loadMasters();
      get().loadWatchlist();
    },

    logout: () => {
      persist(null, null);
      setRestToken("");
      set({ ...emptyState });
    },

    loadAccounts: async () => {
      try {
        const rows = await pyapi<AccountRow[]>("/accounts");
        set({ accounts: rows });
      } catch {
        /* not logged in yet */
      }
    },
    loadMasters: async () => {
      try {
        const st = await pyapi<MasterStatus>("/masters/status");
        set({ masterStatus: st });
      } catch {
        /* ignore */
      }
    },
    loadWatchlist: async () => {
      try {
        const rows = await pyapi<{ symbol: string }[]>("/watchlist");
        const symbols = rows.map((r) => r.symbol);
        set({ watchlist: symbols });
        if (symbols.length) socket().emit("sub", { symbols });
      } catch {
        /* ignore */
      }
    },

    watchCandles: (symbol, tf) => {
      set({ candleSymbol: symbol, candleTf: tf, candles: [], liveCandle: null });
      const prev = get().watchlist;
      socket().emit("candles:get", { symbol, tf });
      if (!prev.includes(symbol)) {
        socket().emit("sub", { symbols: [symbol] });
        set({ watchlist: [...prev, symbol] });
      }
    },

    requestFunds: () => socket().emit("funds:get", {}),

    refreshOrders: () => socket().emit("orders:get", {}),
    refreshPositions: () => socket().emit("positions:get", {}),

    setMode: async (m) => {
      await pyapi("/settings/mode", "POST", { mode: m });
      set({ mode: m });
    },
  };
});

// dev diagnostics: inspect via __tt.getState() in the browser console
if (typeof window !== "undefined") {
  (window as unknown as { __tt: unknown }).__tt = useTerminal;
}
