"use client";
/** Watchlist — live ticks over WS; search wired to synced master contracts. */
import { useState } from "react";
import { pyapi } from "@/lib/terminal-client";
import { useTerminal } from "@/stores/terminal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Plus, X } from "lucide-react";

export default function Watchlist() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{
    symbol: string; name?: string; exchange: string; instrument?: string;
  }>>([]);
  const [searching, setSearching] = useState(false);
  const watchlist = useTerminal((s) => s.watchlist);
  const ticks = useTerminal((s) => s.ticks);
  const candleSymbol = useTerminal((s) => s.candleSymbol);
  const watchCandles = useTerminal((s) => s.watchCandles);

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const rows = await pyapi<typeof results>(`/masters/search?q=${encodeURIComponent(q)}&limit=25`);
      setResults(rows);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function add(symbol: string) {
    await pyapi("/watchlist", "POST", { symbol });
    setResults((r) => r.filter((x) => x.symbol !== symbol));
    useTerminal.getState().loadWatchlist();
  }

  async function remove(symbol: string) {
    await pyapi(`/watchlist/${encodeURIComponent(symbol)}`, "DELETE");
    useTerminal.getState().loadWatchlist();
  }

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex gap-1">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search master contracts…"
          className="h-8 text-xs"
        />
        <Button size="icon" variant="secondary" className="h-8 w-8" onClick={search} aria-label="search">
          <Search className="h-3.5 w-3.5" />
        </Button>
      </div>

      {results.length > 0 && (
        <div className="rounded-md border bg-card">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground border-b">
            Master search — click + to add
          </div>
          <ScrollArea className="max-h-40">
            {results.map((r) => (
              <div key={r.symbol} className="flex items-center justify-between px-2 py-1.5 text-xs hover:bg-accent/40">
                <div className="min-w-0">
                  <div className="font-mono truncate">{r.symbol}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {r.exchange} {r.instrument} {r.name ? `· ${r.name}` : ""}
                  </div>
                </div>
                <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => add(r.symbol)} aria-label={`add ${r.symbol}`}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </ScrollArea>
        </div>
      )}

      <div className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Watchlist — tick by tick (WS)
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-0.5 pr-1">
          {watchlist.map((sym) => {
            const t = ticks[sym];
            const chg = t && t.prev_close ? ((t.ltp - t.prev_close) / t.prev_close) * 100 : null;
            const active = sym === candleSymbol;
            return (
              <div
                key={sym}
                onClick={() => watchCandles(sym, 1)}
                className={`group flex items-center justify-between rounded px-2 py-1.5 cursor-pointer text-xs ${
                  active ? "bg-accent" : "hover:bg-accent/50"
                }`}
              >
                <div className="min-w-0">
                  <div className="font-mono truncate">{sym.split(":")[1]}</div>
                  <div className="text-[10px] text-muted-foreground">{sym.split(":")[0]} · {t?.source ?? "…"}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="text-right font-mono">
                    <div className={chg != null && chg < 0 ? "text-red-500" : "text-green-500"}>
                      {t ? t.ltp.toFixed(2) : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {chg != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : ""}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); remove(sym); }}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                    aria-label={`remove ${sym}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
          {!watchlist.length && (
            <div className="text-xs text-muted-foreground px-2 py-6 text-center">
              Watchlist empty — search above to add symbols
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
