"use client";
/** Positions + Orders — pushed live over WS (positions event on every tick-driven pnl change). */
import { useTerminal } from "@/stores/terminal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

export default function PositionsOrders() {
  const positions = useTerminal((s) => s.positions);
  const orders = useTerminal((s) => s.orders);

  const totalPnl = positions.reduce((a, p) => a + (p.pnl || 0), 0);

  return (
    <Tabs defaultValue="positions" className="flex flex-col h-full gap-1.5">
      <TabsList className="h-8 grid grid-cols-2 w-full">
        <TabsTrigger value="positions" className="text-xs h-7">
          Positions {positions.length ? `(${positions.length})` : ""}
        </TabsTrigger>
        <TabsTrigger value="orders" className="text-xs h-7">
          Orders {orders.length ? `(${orders.length})` : ""}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="positions" className="min-h-0 flex-1">
        <div className="flex justify-between px-1 pb-1 text-[10px] text-muted-foreground">
          <span>MTM (WS live)</span>
          <span className={totalPnl < 0 ? "text-red-500 font-mono" : "text-green-500 font-mono"}>
            {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
          </span>
        </div>
        <ScrollArea className="h-[210px]">
          {positions.length ? (
            positions.map((p, i) => (
              <div key={`${p.symbol}-${i}`} className="flex items-center justify-between px-2 py-1.5 text-xs border-b border-border/40">
                <div>
                  <div className="font-mono">{p.symbol.split(":")[1]}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {p.qty > 0 ? "+" : ""}{p.qty} @ {p.avg_price} · {p.product}
                  </div>
                </div>
                <div className="text-right font-mono">
                  <div>{p.ltp?.toFixed?.(2) ?? p.ltp}</div>
                  <div className={p.pnl < 0 ? "text-red-500 text-[11px]" : "text-green-500 text-[11px]"}>
                    {p.pnl >= 0 ? "+" : ""}{p.pnl?.toFixed?.(2) ?? p.pnl}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="text-xs text-muted-foreground text-center py-8">No open positions</div>
          )}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="orders" className="min-h-0 flex-1">
        <ScrollArea className="h-[230px]">
          {orders.length ? (
            orders.map((o, i) => (
              <div key={o.broker_order_id || i} className="flex items-center justify-between px-2 py-1.5 text-xs border-b border-border/40">
                <div>
                  <div className="font-mono">
                    <span className={o.side === "BUY" ? "text-green-500" : "text-red-500"}>{o.side}</span>{" "}
                    {o.symbol.split(":")[1]}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {o.qty} × {o.order_type} {o.price ? `@ ${o.price}` : ""} · {o.product}
                    {o.broker_order_id ? ` · ${o.broker_order_id}` : ""}
                  </div>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  o.status === "complete" ? "bg-green-500/15 text-green-500"
                  : o.status === "cancelled" ? "bg-zinc-500/15 text-zinc-400"
                  : "bg-amber-500/15 text-amber-500"}`}>
                  {o.status}
                </span>
              </div>
            ))
          ) : (
            <div className="text-xs text-muted-foreground text-center py-8">No orders yet</div>
          )}
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}
