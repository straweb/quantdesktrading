"use client";
/**
 * ChartCanvas — pure <canvas> candlestick chart (custom-built; no TradingView /
 * OpenAlgo / third-party chart libraries, per project constraint).
 *
 * Renders: candles + live (ghost) candle, volume sub-pane, last-price line,
 * crosshair with OHLCV legend, right price axis, bottom time axis.
 * Data comes exclusively from the WS store (candles:history + live candle events).
 */
import { useEffect, useRef, useState } from "react";
import { useTerminal } from "@/stores/terminal";

const UP = "#16a34a";
const DOWN = "#dc2626";
const GRID = "rgba(148,163,184,0.12)";
const AXIS_TEXT = "#94a3b8";

export default function ChartCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const candles = useTerminal((s) => s.candles);
  const liveCandle = useTerminal((s) => s.liveCandle);
  const symbol = useTerminal((s) => s.candleSymbol);
  const tick = useTerminal((s) => s.ticks[s.candleSymbol]);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const all = liveCandle
      ? [...candles.filter((c) => c.t !== liveCandle.t), liveCandle]
      : candles;
    if (!all.length) {
      ctx.fillStyle = AXIS_TEXT;
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText("waiting for candles (WS)…", 16, 24);
      return;
    }

    const padR = 64, padB = 22, padT = 8;
    const volH = Math.max(46, h * 0.16);
    const priceH = h - padB - volH - padT;
    const plotW = w - padR;

    const view = all.slice(-Math.max(30, Math.floor(plotW / 8)));
    const n = view.length;
    const cw = plotW / n;
    const bodyW = Math.max(1.5, Math.min(11, cw * 0.62));

    let lo = Infinity, hi = -Infinity, vMax = 0;
    for (const c of view) {
      lo = Math.min(lo, c.l);
      hi = Math.max(hi, c.h);
      vMax = Math.max(vMax, c.v || 0);
    }
    const span = hi - lo || 1;
    lo -= span * 0.06;
    hi += span * 0.06;
    const y = (p: number) => padT + (hi - p) / (hi - lo) * priceH;
    const vy = (v: number) => h - padB - (vMax ? (v / vMax) * volH : 0);

    // grid + price axis
    ctx.strokeStyle = GRID;
    ctx.fillStyle = AXIS_TEXT;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const p = lo + ((hi - lo) * i) / steps;
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(p.toFixed(p > 1000 ? 0 : 2), plotW + 6, yy + 3);
    }

    // volume bars
    for (let i = 0; i < n; i++) {
      const c = view[i];
      const cx = i * cw + cw / 2;
      ctx.fillStyle = c.c >= c.o ? "rgba(22,163,74,0.35)" : "rgba(220,38,38,0.35)";
      const vh = h - padB - vy(c.v || 0);
      ctx.fillRect(cx - bodyW / 2, h - padB - vh, bodyW, vh);
    }

    // candles
    for (let i = 0; i < n; i++) {
      const c = view[i];
      const cx = Math.round(i * cw + cw / 2);
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? UP : DOWN;
      ctx.fillStyle = up ? UP : DOWN;
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, y(c.h));
      ctx.lineTo(cx + 0.5, y(c.l));
      ctx.stroke();
      const yo = y(c.o), yc = y(c.c);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);
    }

    // last price line + tag
    const last = liveCandle ?? view[view.length - 1];
    const lp = last.c;
    const lpy = Math.round(y(lp)) + 0.5;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(148,163,184,0.6)";
    ctx.beginPath();
    ctx.moveTo(0, lpy);
    ctx.lineTo(plotW, lpy);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = last.c >= last.o ? UP : DOWN;
    ctx.fillRect(plotW, lpy - 8, padR, 16);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 10px ui-monospace, monospace";
    ctx.fillText(lp.toFixed(lp > 1000 ? 1 : 2), plotW + 4, lpy + 3);

    // time axis
    ctx.fillStyle = AXIS_TEXT;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    const tStep = Math.max(1, Math.floor(n / 6));
    for (let i = n - 1; i >= 0; i -= tStep) {
      const d = new Date(view[i].t * 1000);
      const label = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      ctx.fillText(label, i * cw + cw / 2, h - 6);
    }

    // crosshair
    if (mouse && mouse.x < plotW) {
      const idx = Math.min(n - 1, Math.max(0, Math.floor(mouse.x / cw)));
      const c = view[idx];
      const cx = Math.round(idx * cw + cw / 2) + 0.5;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(148,163,184,0.5)";
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, h - padB);
      ctx.moveTo(0, mouse.y);
      ctx.lineTo(plotW, mouse.y);
      ctx.stroke();
      ctx.restore();
      // legend
      const d = new Date(c.t * 1000);
      const chg = ((c.c - c.o) / c.o) * 100;
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "left";
      const legend = `${d.toLocaleDateString()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}  O ${c.o}  H ${c.h}  L ${c.l}  C ${c.c}  V ${Math.round(c.v)}  (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)`;
      ctx.fillText(legend, 8, h - 6);
      // price at cursor
      const pv = hi - ((mouse.y - padT) / priceH) * (hi - lo);
      if (mouse.y > padT && mouse.y < padT + priceH) {
        ctx.fillStyle = "rgba(71,85,105,0.9)";
        ctx.fillRect(plotW, mouse.y - 8, padR, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(pv.toFixed(pv > 1000 ? 1 : 2), plotW + 4, mouse.y + 3);
      }
    }
  }, [candles, liveCandle, size, mouse]);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full bg-[#0b0e14] rounded-md overflow-hidden border"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setMouse({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
      onMouseLeave={() => setMouse(null)}
    >
      <canvas ref={canvasRef} className="block cursor-crosshair" />
      <div className="absolute top-2 left-3 text-xs text-muted-foreground font-mono">
        {symbol} {tick ? (
          <span className={tick.ltp >= (tick.prev_close ?? tick.ltp) ? "text-green-500" : "text-red-500"}>
            {tick.ltp}
          </span>
        ) : null}
      </div>
    </div>
  );
}
