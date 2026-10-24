"""
Options chain builder + FNO universe + index constituents.

Builds the strikes-desk payloads FROM the per-broker master DBs (real
contracts) + hub ticks (real/sim quotes).  ATM convention (hedge-desk):
  ceAtm = floor(spot/step)*step , peAtm = ceil(spot/step)*step
"""
from __future__ import annotations

from typing import Optional
import math
import time

from backend import db

# Step sizes per underlying (fallback when the master rows don't imply one)
STEPS = {
    "NIFTY": 50, "BANKNIFTY": 100, "SENSEX": 100, "FINNIFTY": 50,
    "MIDCPNIFTY": 25, "NIFTYNXT50": 25,
}
DEFAULT_STEP = 100

INDEX_NAMES = {
    "NIFTY": "NIFTY 50", "BANKNIFTY": "NIFTY BANK", "SENSEX": "BSE SENSEX",
    "FINNIFTY": "NIFTY FIN SERVICE", "MIDCPNIFTY": "NIFTY MID SELECT",
}

# index constituents (symbol -> [members]) — used for the watchlist Index tab
CONSTITUENTS: dict[str, list[str]] = {
    "NIFTY": ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "ITC", "LT",
              "SBIN", "AXISBANK", "TATAMOTORS"],
    "BANKNIFTY": ["HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK"],
    "SENSEX": ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS"],
}


def _master_all(exchanges: Optional[tuple[str, ...]] = None) -> list[dict]:
    """Union of master rows across broker DBs (dedup by symbol)."""
    out: dict[str, dict] = {}
    for name in db.broker_dbs_keys():
        try:
            if exchanges:
                marks = ",".join("?" for _ in exchanges)
                rows = db.broker_db(name).query(
                    f"SELECT * FROM master WHERE exchange IN ({marks})", exchanges)
            else:
                rows = db.broker_db(name).query("SELECT * FROM master")
        except Exception:
            continue
        for r in rows:
            out.setdefault(r["symbol"], r)
    return list(out.values())


def _underlyings() -> list[dict]:
    """FNO underlyings = INDEX/EQ rows that have option contracts."""
    rows = _master_all(("NFO", "BFO", "BFNO", "MCX", "CDS", "NSE"))
    opts = [r for r in rows if (r.get("instrument") or "").upper() == "OPT"]
    by_under: dict[str, list[dict]] = {}
    for o in opts:
        sym = o.get("symbol") or ""
        # NFO:NIFTY29O2525000CE -> NIFTY ; strip date+strike+right
        under = _underlying_of(sym)
        if under:
            by_under.setdefault(under, []).append(o)
    out = []
    for under, contracts in by_under.items():
        expiries = sorted({c["expiry"] for c in contracts if c.get("expiry")})
        idx_row = next((r for r in rows if _clean_symbol(r.get("symbol")) == under), None)
        out.append({
            "underlying": under,
            "name": (idx_row or {}).get("name") or INDEX_NAMES.get(under, under),
            "lotSize": int(contracts[0].get("lotsize") or 1),
            "expiries": expiries,
            "instrumentType": "INDEX" if under in INDEX_NAMES else "EQ",
        })
    return sorted(out, key=lambda u: u["underlying"])


def _underlying_of(opt_symbol: str) -> Optional[str]:
    sym = opt_symbol.split(":")[-1]
    for under in ("BANKNIFTY", "NIFTYNXT50", "MIDCPNIFTY", "FINNIFTY", "SENSEX", "NIFTY"):
        if sym.startswith(under):
            return under
    # EQ options: UNDERLYING<date><strike><CE/PE> — heuristics fail; match masters
    for r in _master_all(("NSE",)):
        s = (r.get("symbol") or "").split(":")[-1]
        if s and sym.startswith(s) and len(s) > 3:
            return s
    return None


def _clean_symbol(symbol: Optional[str]) -> str:
    return (symbol or "").split(":")[-1]


def _spot(underlying: str) -> tuple[float, float]:
    """(spot, prevClose) from the hub tick cache, else master base."""
    from backend.market.hub import Hub
    hub = Hub.instance()
    for sym in (f"NSE:{underlying}", f"BSE:{underlying}"):
        t = hub.ticks.get(sym)
        if t and t.get("ltp"):
            return float(t["ltp"]), float(t.get("prev_close") or t["ltp"])
    row = None
    for name in db.broker_dbs_keys():
        row = db.broker_db(name).one(
            "SELECT * FROM master WHERE symbol LIKE ? AND instrument IN ('INDEX','EQ')",
            (f"%:{underlying}",))
        if row:
            break
    base = float((row or {}).get("strike") or 0) or _fallback_spot(underlying)
    return base, base


def _fallback_spot(underlying: str) -> float:
    return {"NIFTY": 25450.0, "BANKNIFTY": 56750.0, "SENSEX": 79000.0}.get(underlying, 1000.0)


def _step_of(underlying: str) -> int:
    return STEPS.get(underlying, DEFAULT_STEP)


def _cell(symbol: str, exists: bool) -> dict:
    from backend.market.hub import Hub
    hub = Hub.instance()
    t = hub.ticks.get(symbol)
    if not t:
        return {"symbol": symbol, "exists": exists, "ltp": 0, "prevClose": 0,
                "high": 0, "low": 0, "changePct": 0}
    ltp = float(t.get("ltp") or 0)
    prev = float(t.get("prev_close") or 0)
    return {"symbol": symbol, "exists": True, "ltp": ltp, "prevClose": prev,
            "high": float(t.get("high") or 0), "low": float(t.get("low") or 0),
            "changePct": round(((ltp - prev) / prev) * 100, 2) if prev else 0}


def _opt_symbol(underlying: str, expiry: str, strike: int, right: str) -> str:
    return f"NFO:{underlying}{expiry}{strike}{right}"


def _expiries_of(underlying: str) -> list[str]:
    # an active FNO session pins its expiry first (chain follows the session)
    try:
        from backend import fnosim
        svc = fnosim.SVC
        sess = svc.session_of(underlying) if hasattr(svc, "session_of") else None
        if sess is not None and sess.expiry:
            rest = []
            for u in _underlyings():
                if u["underlying"] == underlying:
                    rest = [e for e in u["expiries"] if e != sess.expiry]
                    break
            return [sess.expiry, *rest]
        # legacy single-session manager shape
        if getattr(svc, "active", False) and getattr(svc, "underlying", None) == underlying \
                and getattr(svc, "expiry", None):
            return [svc.expiry] + [e for u in _underlyings() if u["underlying"] == underlying
                                   for e in u["expiries"] if e != svc.expiry]
    except Exception:
        pass
    for u in _underlyings():
        if u["underlying"] == underlying:
            return u["expiries"]
    return []


def _greeks_for(underlying: str, strike: float, right: str, spot: float) -> Optional[dict]:
    """Black-Scholes greeks for a chain leg — only for underlyings running an
    FNO session (expiry + IV come from the session's geek settings; T uses
    the session's replay clock so greeks evolve with the walked session)."""
    try:
        from backend import fnosim
        sess = fnosim.SVC.session_of(underlying)
        if not sess:
            return None
        exp_dt = sess.expiry_dt
        if exp_dt:
            T = max(0.0, (exp_dt - sess.now_dt()).total_seconds()) / (365 * 86400)
        else:
            T = 5 / 365
        g = fnosim._bs_greeks(right, spot, float(strike), T, sess.iv)
        g["iv"] = round(sess.iv * 100, 1)
        return g
    except Exception:
        return None


def build_chain(underlying: str, expiry: Optional[str], band: int = 15) -> dict:
    """Full chain payload for the strikes panel / sync:chain channel."""
    spot, prev = _spot(underlying)
    step = _step_of(underlying)
    atm = round(spot / step) * step
    ce_atm = math.floor(spot / step) * step
    pe_atm = math.ceil(spot / step) * step
    expiries = _expiries_of(underlying)
    exp = expiry if expiry in expiries else (expiries[0] if expiries else None)
    rows = []
    if exp:
        for k in range(-band, band + 1):
            strike = int(atm + k * step)
            ce_sym = _opt_symbol(underlying, exp, strike, "CE")
            pe_sym = _opt_symbol(underlying, exp, strike, "PE")
            ce = _cell(ce_sym, True)
            pe = _cell(pe_sym, True)
            ce_g = _greeks_for(underlying, strike, "CE", spot)
            pe_g = _greeks_for(underlying, strike, "PE", spot)
            if ce_g:
                ce["greeks"] = ce_g
            if pe_g:
                pe["greeks"] = pe_g
            rows.append({
                "strike": strike, "offset": k,
                "offsetCe": round((strike - ce_atm) / step),
                "offsetPe": round((strike - pe_atm) / step),
                "ce": ce, "pe": pe,
            })
    atm_row = next((r for r in rows if r["strike"] == atm), None)
    # side-ATM rows: CE ATM = floor(spot/step), PE ATM = ceil(spot/step) — pick
    # the row whose strike matches each side ATM (spot 25404 → CE 25400, PE 25450)
    atm_ce_row = next((r for r in rows if r["strike"] == ce_atm), None)
    atm_pe_row = next((r for r in rows if r["strike"] == pe_atm), None)
    atm_ce = {**atm_ce_row["ce"], "strike": atm_ce_row["strike"]} if atm_ce_row else None
    atm_pe = {**atm_pe_row["pe"], "strike": atm_pe_row["strike"]} if atm_pe_row else None
    u = next((u for u in _underlyings() if u["underlying"] == underlying), {})
    sess_iv = None
    try:
        from backend import fnosim
        sess = fnosim.SVC.session_of(underlying)
        if sess:
            sess_iv = round(sess.iv * 100, 1)
    except Exception:
        sess_iv = None
    return {
        "meta": {
            "underlying": underlying, "exchange": "NFO", "spot": spot, "prevClose": prev,
            "atm": atm, "ceAtm": ce_atm, "peAtm": pe_atm, "step": step,
            "lotSize": u.get("lotSize", 75) if isinstance(u, dict) else 75,
            "expiry": exp or "", "expiries": expiries,
            "sessionIv": sess_iv,
            "strikesAvailable": [r["strike"] for r in rows],
        },
        "rows": rows, "atmRow": atm_row, "atmCe": atm_ce, "atmPe": atm_pe,
        "ts": int(time.time() * 1000),
    }


def chain_symbols(underlying: str, expiry: Optional[str], band: int = 15) -> list[str]:
    """Every option-leg symbol of a chain band (for server-side subscription)."""
    spot, _ = _spot(underlying)
    step = _step_of(underlying)
    atm = round(spot / step) * step
    expiries = _expiries_of(underlying)
    exp = expiry if expiry in expiries else (expiries[0] if expiries else None)
    if not exp:
        return []
    out = []
    for k in range(-band, band + 1):
        strike = int(atm + k * step)
        out.append(_opt_symbol(underlying, exp, strike, "CE"))
        out.append(_opt_symbol(underlying, exp, strike, "PE"))
    return out


async def ensure_chain_subscribed(underlying: str, expiry: Optional[str]) -> None:
    """Subscribe every chain leg so sync:chain carries live quotes."""
    from backend.market.hub import Hub
    hub = Hub.instance()
    for sym in chain_symbols(underlying, expiry):
        await hub._ensure_source(sym)


async def ensure_index_subscribed(symbol: str) -> None:
    """Subscribe an index + its constituents (sync:index quotes)."""
    from backend.market.hub import Hub
    hub = Hub.instance()
    for sym in [symbol] + CONSTITUENTS.get(symbol, []):
        await hub._ensure_source(f"NSE:{sym}" if ":" not in sym else sym)


def ensure_strike(underlying: str, strike: float, expiry: Optional[str]) -> dict:
    """Insert synthetic option contracts (both sides) into every broker master."""
    exps = _expiries_of(underlying)
    exp = expiry if expiry in exps else (exps[0] if exps else None)
    if not exp:
        return {"ok": False, "created": 0, "symbols": [], "message": f"no expiries for {underlying}"}
    created, symbols = 0, []
    for name in db.broker_dbs_keys():
        bdb = db.broker_db(name)
        if bdb.one("SELECT COUNT(*) c FROM master")["c"] == 0:
            continue
        for right in ("CE", "PE"):
            sym = _opt_symbol(underlying, exp, int(strike), right)
            row = bdb.one("SELECT token FROM master WHERE symbol=?", (sym,))
            if not row:
                lot = 75 if underlying == "NIFTY" else 35
                bdb.exec(
                    "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (sym.split(":")[1], sym, f"{underlying} {exp} {int(strike)} {right}",
                     "NFO", "OPT", exp, strike, right, lot))
                created += 1
            symbols.append(sym)
        # refresh token maps of connected accounts of this broker
        from backend.market.hub import Hub
        hub = Hub.instance()
        for aid, _ad in list(hub.adapters.items()):
            acc = db.core().one("SELECT broker FROM accounts WHERE id=?", (aid,))
            if acc and acc["broker"] == name:
                hub._load_token_map(aid)
    return {"ok": True, "created": created, "symbols": symbols}


def index_components(symbol: str) -> dict:
    """Index + constituent quotes for the watchlist Index tab."""
    spot, prev = _spot(symbol)
    from backend.market.hub import Hub
    hub = Hub.instance()
    tick = hub.ticks.get(f"NSE:{symbol}") or hub.ticks.get(f"BSE:{symbol}") or {}
    ltp = float(tick.get("ltp") or spot)
    members = CONSTITUENTS.get(symbol, [])
    constituents = []
    total_pts = 0.0
    for m in members:
        t = hub.ticks.get(f"NSE:{m}")
        if not t:
            row = db.broker_db("sim").one("SELECT * FROM master WHERE symbol=?", (f"NSE:{m}",))
            if not row:
                continue
            constituents.append({
                "symbol": m, "weight": 0, "ltp": float(row.get("strike") or 0),
                "high": 0, "low": 0, "vol": 0, "chgPct": 0, "pts": 0,
            })
            continue
        mltp = float(t.get("ltp") or 0)
        mprev = float(t.get("prev_close") or mltp)
        chg_pct = ((mltp - mprev) / mprev * 100) if mprev else 0
        constituents.append({
            "symbol": m, "weight": 0, "ltp": mltp,
            "high": float(t.get("high") or 0), "low": float(t.get("low") or 0),
            "vol": float(t.get("vol") or 0), "chgPct": round(chg_pct, 2),
            "pts": round(mltp - mprev, 2),
        })
    chg_pts = ltp - prev
    total_pts = round(sum(c["pts"] for c in constituents), 2)
    return {
        "index": {"symbol": symbol, "name": INDEX_NAMES.get(symbol, symbol), "ltp": ltp,
                  "prevClose": prev, "high": float(tick.get("high") or 0),
                  "low": float(tick.get("low") or 0), "vol": float(tick.get("vol") or 0),
                  "chgPts": round(chg_pts, 2),
                  "chgPct": round((chg_pts / prev * 100) if prev else 0, 2)},
        "constituents": constituents, "totalPts": total_pts,
    }


def fno_universe() -> dict:
    """FNO underlyings grouped by exchange (admin FNO tab).  Spot-only
    stocks/indices (no option contracts synced yet — the Session Simulator
    generates their chain on session start) are appended so they can be
    picked as session underlyings too."""
    rows = _master_all(("NFO", "BFO", "BFNO", "MCX", "CDS", "NSE", "BSE"))
    opts = [r for r in rows if (r.get("instrument") or "").upper() == "OPT"]
    by_under: dict[str, list[dict]] = {}
    for o in opts:
        under = _underlying_of(o.get("symbol") or "")
        if under:
            by_under.setdefault(under, []).append(o)
    groups: dict[str, list[dict]] = {}
    for under, contracts in sorted(by_under.items()):
        expiries = sorted({c["expiry"] for c in contracts if c.get("expiry")})
        idx_row = next((r for r in rows if _clean_symbol(r.get("symbol")) == under), None)
        exch = (idx_row or contracts[0]).get("exchange") or "NFO"
        spot, prev = _spot(under)
        from backend.market.hub import Hub
        tick = Hub.instance().ticks.get(f"NSE:{under}") or {}
        ltp = float(tick.get("ltp") or spot)
        seg = "IDX" if under in INDEX_NAMES else "EQ"
        groups.setdefault(exch, []).append({
            "underlying": under,
            "name": (idx_row or {}).get("name") or INDEX_NAMES.get(under, under),
            "exchange": exch, "segment": seg,
            "instrumentType": "INDEX" if seg == "IDX" else "EQ",
            "lotSize": int(contracts[0].get("lotsize") or 1),
            "latestExpiry": expiries[0] if expiries else None,
            "contracts": len(contracts), "spot": ltp,
            "chgPct": round(((ltp - prev) / prev * 100) if prev else 0, 2),
        })
    # spot-only underlyings (EQ stocks / indexes the session simulator can run)
    have = {g["underlying"] for rs in groups.values() for g in rs}
    seen: set[str] = set()
    from backend.market.hub import Hub as _Hub
    for r in rows:
        inst = (r.get("instrument") or "").upper()
        if inst not in ("EQ", "INDEX"):
            continue
        exch = r.get("exchange") or "NSE"
        if exch not in ("NSE", "BSE"):
            continue
        under = _clean_symbol(r.get("symbol"))
        if not under or under in have or under in seen:
            continue
        seen.add(under)
        tick = _Hub.instance().ticks.get(r.get("symbol") or "") or {}
        ltp = float(tick.get("ltp") or 0)
        prev = float(tick.get("prev_close") or 0) or ltp
        groups.setdefault(exch, []).append({
            "underlying": under,
            "name": r.get("name") or under,
            "exchange": exch,
            "segment": "IDX" if inst == "INDEX" else "EQ",
            "instrumentType": inst,
            "lotSize": int(r.get("lotsize") or 1),
            "latestExpiry": None,
            "contracts": 0, "spot": ltp,
            "chgPct": round(((ltp - prev) / prev * 100) if prev else 0, 2),
        })
    labels = {"NFO": "NSE F&O", "BFO": "BSE F&O", "BFNO": "BSE F&O", "MCX": "MCX Commodity", "CDS": "NSE Currency",
              "NSE": "NSE Cash (session spot)", "BSE": "BSE Cash (session spot)"}
    return {"groups": [{"exchange": ex, "label": labels.get(ex, ex), "underlyings": rows}
                       for ex, rows in sorted(groups.items())]}
