"use client";
/** OrderTicket — place orders via REST (tool interaction); fills stream back over WS. */
import { useState } from "react";
import { toast } from "@/hooks/use-toast";
import { pyapi } from "@/lib/terminal-client";
import { useTerminal } from "@/stores/terminal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function OrderTicket() {
  const symbol = useTerminal((s) => s.candleSymbol);
  const tick = useTerminal((s) => s.ticks[s.candleSymbol]);
  const refreshOrders = useTerminal((s) => s.refreshOrders);
  const requestFunds = useTerminal((s) => s.requestFunds);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [qty, setQty] = useState("1");
  const [orderType, setOrderType] = useState("MARKET");
  const [price, setPrice] = useState("");
  const [product, setProduct] = useState("MIS");
  const [busy, setBusy] = useState(false);

  async function place() {
    setBusy(true);
    try {
      const res = await pyapi<{ order_id: string; status: string; filled_price?: number }>(
        "/orders/place", "POST", {
          symbol, side, qty: Number(qty) || 1,
          order_type: orderType,
          price: orderType === "LIMIT" ? Number(price || tick?.ltp || 0) : null,
          product,
        });
      toast({
        title: `${side} order ${res.status}`,
        description: `${qty} ${symbol} @ ${res.filled_price ?? "broker ack"}`,
      });
      refreshOrders();
      requestFunds();       // event-driven funds refresh (no polling)
    } catch (e) {
      toast({ title: "Order failed", description: String(e instanceof Error ? e.message : e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          variant={side === "BUY" ? "default" : "outline"}
          onClick={() => setSide("BUY")}
          className="h-9 bg-green-600 hover:bg-green-700 text-white data-[state=inactive]:bg-transparent"
        >BUY</Button>
        <Button
          variant={side === "SELL" ? "default" : "outline"}
          onClick={() => setSide("SELL")}
          className="h-9 bg-red-600 hover:bg-red-700 text-white data-[state=inactive]:bg-transparent"
        >SELL</Button>
      </div>
      <div className="text-xs font-mono text-muted-foreground">
        {symbol} · LTP {tick ? tick.ltp.toFixed(2) : "—"} {tick?.source ? `(${tick.source})` : ""}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Qty</Label>
          <Input value={qty} onChange={(e) => setQty(e.target.value)} type="number" min={1} className="h-8" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <Select value={orderType} onValueChange={setOrderType}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="MARKET">MARKET</SelectItem>
              <SelectItem value="LIMIT">LIMIT</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Price</Label>
          <Input
            value={orderType === "MARKET" ? "MKT" : price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={orderType === "MARKET"} type="number" className="h-8" placeholder="0.00"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Product</Label>
          <Select value={product} onValueChange={setProduct}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="MIS">MIS</SelectItem>
              <SelectItem value="CNC">CNC</SelectItem>
              <SelectItem value="NRML">NRML</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button onClick={place} disabled={busy} className="w-full h-9 font-semibold">
        {busy ? "Placing…" : `${side} ${qty || 0} ${symbol.split(":")[1] || ""}`}
      </Button>
    </div>
  );
}
