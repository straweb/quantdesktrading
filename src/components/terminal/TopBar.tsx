"use client";
/**
 * TopBar — mode switch (LIVE ONLY enforcement), WS health chip, funds chip
 * (on-demand + event-driven via WS), account switcher, Accounts & Masters dialogs.
 */
import { useEffect, useState } from "react";
import { toast } from "@/hooks/use-toast";
import { pyapi } from "@/lib/terminal-client";
import { useTerminal, type AccountRow } from "@/stores/terminal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Wallet, RefreshCw, Users, Database, LogOut, Wifi, WifiOff } from "lucide-react";

const CRED_FIELDS: Record<string, Array<[string, string]>> = {
  sim: [],
  breeze: [
    ["api_key", "API Key"],
    ["api_secret", "API Secret"],
    ["session_token", "Session Token (from TOTP login)"],
  ],
  dhan: [
    ["client_id", "Client ID"],
    ["access_token", "Access Token (web.dhan.co)"],
    ["api_key", "API Key (consent flow, optional)"],
    ["api_secret", "API Secret (consent flow, optional)"],
  ],
  shoonya: [
    ["uid", "User ID"],
    ["password", "Password"],
    ["totp", "TOTP / Factor2"],
    ["vendor_code", "Vendor Code"],
    ["api_key", "API Key (imei)"],
    ["api_secret", "API Secret (app_idkey)"],
    ["susertoken", "Susertoken (direct, optional)"],
  ],
};

export default function TopBar() {
  const mode = useTerminal((s) => s.mode);
  const setMode = useTerminal((s) => s.setMode);
  const wsConnected = useTerminal((s) => s.wsConnected);
  const rtt = useTerminal((s) => s.rttMs);
  const funds = useTerminal((s) => s.funds);
  const requestFunds = useTerminal((s) => s.requestFunds);
  const accounts = useTerminal((s) => s.accounts);
  const user = useTerminal((s) => s.user);
  const logout = useTerminal((s) => s.logout);
  const lastSyncInfo = useTerminal((s) => s.lastSyncInfo);

  return (
    <header className="flex items-center gap-2 h-12 px-3 border-b bg-card shrink-0">
      <div className="font-bold text-sm tracking-tight mr-1">⚡ Terminal</div>

      <div className="flex items-center gap-1.5 rounded-md border px-2 py-1">
        <span className={`text-[10px] font-bold ${mode === "live" ? "text-red-500" : "text-zinc-400"}`}>
          {mode === "live" ? "LIVE ONLY" : "SANDBOX"}
        </span>
        <Switch
          checked={mode === "live"}
          onCheckedChange={(v) => setMode(v ? "live" : "sandbox").catch((e) =>
            toast({ title: "Mode switch failed", description: String(e.message || e), variant: "destructive" }))
          }
          aria-label="trading mode"
        />
      </div>

      <Badge variant={wsConnected ? "default" : "destructive"} className="gap-1 font-mono text-[10px]">
        {wsConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
        WS {wsConnected ? (rtt != null ? `${rtt}ms` : "ok") : "down"}
      </Badge>

      {/* funds chip — click refreshes on demand; updates automatically on orders/positions */}
      <button
        onClick={requestFunds}
        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 hover:bg-accent/50 transition"
        title="Pull funds (on demand via WS)"
      >
        <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-xs">
          {funds?.error ? (
            <span className="text-red-500">{funds.error}</span>
          ) : (
            <>
              ₹{(funds?.available ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              <span className="text-muted-foreground"> / used ₹{(funds?.used ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
            </>
          )}
        </span>
        <RefreshCw className="h-3 w-3 text-muted-foreground" />
        {funds?.source && <span className="text-[9px] text-muted-foreground uppercase">{funds.source}</span>}
      </button>

      <div className="flex-1" />

      {lastSyncInfo && <span className="text-[10px] text-muted-foreground hidden md:inline">{lastSyncInfo}</span>}

      <AccountsDialog />
      <MastersDialog />

      {user && (
        <Button variant="ghost" size="sm" onClick={logout} className="gap-1 h-8 text-xs">
          {user.username} <LogOut className="h-3.5 w-3.5" />
        </Button>
      )}
    </header>
  );
}

function AccountsDialog() {
  const accounts = useTerminal((s) => s.accounts);
  const loadAccounts = useTerminal((s) => s.loadAccounts);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function connect(id: number) {
    setBusyId(id);
    try {
      await pyapi(`/accounts/${id}/connect`, "POST", {});
      toast({ title: "Account connected", description: "Session persisted in backend DB — refresh won't re-login" });
    } catch (e) {
      toast({ title: "Connect failed", description: String(e instanceof Error ? e.message : e), variant: "destructive" });
    } finally {
      setBusyId(null);
      loadAccounts();
    }
  }

  async function disconnect(id: number) {
    setBusyId(id);
    try {
      await pyapi(`/accounts/${id}/disconnect`, "POST", {});
    } finally {
      setBusyId(null);
      loadAccounts();
    }
  }

  async function remove(id: number) {
    await pyapi(`/accounts/${id}`, "DELETE");
    loadAccounts();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1 h-8 text-xs">
          <Users className="h-3.5 w-3.5" /> Accounts
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">Broker accounts</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh] pr-2">
          <div className="space-y-2">
            {accounts.map((a) => (
              <div key={a.id} className="rounded-md border p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-semibold uppercase">{a.broker}</span>
                    <span className="text-xs text-muted-foreground ml-2">{a.label}</span>
                    <Badge variant={a.mode === "live" ? "destructive" : "secondary"} className="ml-2 text-[9px]">{a.mode}</Badge>
                  </div>
                  <Badge variant={a.status === "connected" ? "default" : a.status === "error" ? "destructive" : "outline"} className="text-[10px]">
                    {a.status}
                  </Badge>
                </div>
                {a.status_message && <div className="text-[11px] text-red-500 font-mono">{a.status_message}</div>}
                <div className="flex gap-1.5">
                  {a.status === "connected" ? (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === a.id} onClick={() => disconnect(a.id)}>
                      Disconnect
                    </Button>
                  ) : (
                    <Button size="sm" className="h-7 text-xs" disabled={busyId === a.id} onClick={() => connect(a.id)}>
                      {busyId === a.id ? "Connecting…" : "Connect (reuse stored session)"}
                    </Button>
                  )}
                  <EditAccount account={a} onSaved={loadAccounts} />
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => remove(a.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
            <AddAccount onSaved={loadAccounts} />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function AddAccount({ onSaved }: { onSaved: () => void }) {
  const [broker, setBroker] = useState("breeze");
  const [label, setLabel] = useState("");
  const [accMode, setAccMode] = useState("live");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [initialCapital, setInitialCapital] = useState("");
  const [capitalMode, setCapitalMode] = useState("fixed");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await pyapi("/accounts", "POST", {
        broker, label: label || `${broker} account`, mode: accMode,
        credentials: creds,
        initial_capital: initialCapital ? Number(initialCapital) : null,
        initial_capital_mode: initialCapital ? capitalMode : null,
      });
      toast({ title: "Account added", description: "Fill credentials then Connect" });
      onSaved();
    } catch (e) {
      toast({ title: "Add failed", description: String(e instanceof Error ? e.message : e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-dashed p-2.5 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">Add broker account</div>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Broker</Label>
          <Select value={broker} onValueChange={(v) => { setBroker(v); setCreds({}); }}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sim">Sim Feed</SelectItem>
              <SelectItem value="breeze">ICICI Direct (Breeze)</SelectItem>
              <SelectItem value="dhan">Dhan</SelectItem>
              <SelectItem value="shoonya">Shoonya (Finvasia)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Mode</Label>
          <Select value={accMode} onValueChange={setAccMode}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="live">Live</SelectItem>
              <SelectItem value="sandbox">Sandbox</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${broker} #1`} className="h-8" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {CRED_FIELDS[broker].map(([key, placeholder]) => (
          <div key={key} className="space-y-1">
            <Label className="text-xs">{placeholder}</Label>
            <Input
              type={key.toLowerCase().includes("secret") || key.toLowerCase().includes("password") ? "password" : "text"}
              value={creds[key] ?? ""}
              onChange={(e) => setCreds((c) => ({ ...c, [key]: e.target.value }))}
              className="h-8 font-mono text-xs"
              placeholder={key.toLowerCase().includes("token") ? "paste and Connect — stored in DB" : ""}
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1 col-span-1">
          <Label className="text-xs">Initial capital</Label>
          <Input value={initialCapital} onChange={(e) => setInitialCapital(e.target.value)} type="number" className="h-8" placeholder="e.g. 500000" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Mode</Label>
          <Select value={capitalMode} onValueChange={setCapitalMode}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">Fixed ₹</SelectItem>
              <SelectItem value="percent">% of funds</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button size="sm" className="w-full h-8 text-xs" onClick={save} disabled={busy}>
            {busy ? "Adding…" : "Add account"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EditAccount({ account, onSaved }: { account: AccountRow; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [accMode, setAccMode] = useState(account.mode);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await pyapi(`/accounts/${account.id}`, "PUT", {
        broker: account.broker, label, mode: accMode,
        credentials: { ...account.credentials, ...creds },
      });
      toast({ title: "Account updated" });
      setOpen(false);
      onSaved();
    } catch (e) {
      toast({ title: "Update failed", description: String(e instanceof Error ? e.message : e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs">Edit</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Edit {account.broker} account</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Mode</Label>
              <Select value={accMode} onValueChange={setAccMode}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="live">Live</SelectItem>
                  <SelectItem value="sandbox">Sandbox</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {CRED_FIELDS[account.broker].map(([key, placeholder]) => (
            <div key={key} className="space-y-1">
              <Label className="text-xs">{placeholder} <span className="text-muted-foreground">(saved: {account.credentials[key] ? "•••" : "no"})</span></Label>
              <Input
                value={creds[key] ?? ""}
                onChange={(e) => setCreds((c) => ({ ...c, [key]: e.target.value }))}
                className="h-8 font-mono text-xs"
                placeholder="leave blank to keep current"
              />
            </div>
          ))}
          <Button size="sm" className="w-full h-8" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save (re-authenticates on next connect)"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MastersDialog() {
  const masterStatus = useTerminal((s) => s.masterStatus);
  const [busy, setBusy] = useState<string | null>(null);

  async function sync(broker: string) {
    setBusy(broker);
    try {
      const r = await pyapi<{ source_url: string; symbols: number; source_kind: string; replaced?: boolean }>(
        "/masters/sync", "POST", { broker });
      toast({
        title: `${broker} master synced`,
        description: `${r.symbols} symbols from ${r.source_url} (replace mode)`,
      });
    } catch (e) {
      toast({ title: `${broker} sync failed`, description: String(e instanceof Error ? e.message : e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1 h-8 text-xs">
          <Database className="h-3.5 w-3.5" /> Masters
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">Master contracts (live broker sources, replace-on-sync)</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {Object.entries(masterStatus).map(([broker, st]) => (
            <div key={broker} className="rounded-md border p-2.5 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold uppercase">{broker}</div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {st.symbols} symbols · {st.mappings} mappings
                  {st.last_sync ? ` · ${st.last_sync.source_kind} · ${st.last_sync.source_url.slice(0, 46)}` : ""}
                </div>
              </div>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy === broker} onClick={() => sync(broker)}>
                {busy === broker ? "Syncing…" : "Sync live"}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
