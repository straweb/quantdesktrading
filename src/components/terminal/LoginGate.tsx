"use client";
/** Login gate — default admin/admin123 (env ADMIN_USERNAME / ADMIN_PASSWORD). */
import { useState } from "react";
import { useTerminal } from "@/stores/terminal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function LoginGate() {
  const login = useTerminal((s) => s.login);
  const [u, setU] = useState("admin");
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      await login(u, p);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-lg">⚡ Trading Terminal</CardTitle>
          <CardDescription className="text-xs">
            FastAPI + WebSocket data plane · sim / breeze / dhan / shoonya
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={u} onChange={(e) => setU(e.target.value)} placeholder="username" />
          <Input
            value={p} onChange={(e) => setP(e.target.value)} type="password"
            placeholder="password" onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {err && <div className="text-xs text-destructive">{err}</div>}
          <Button className="w-full" onClick={submit} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-[10px] text-muted-foreground text-center">
            Default: admin / admin123 — change via .env (ADMIN_USERNAME, ADMIN_PASSWORD)
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
