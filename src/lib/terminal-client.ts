"use client";
/**
 * Data-plane client.
 *
 * ALL streaming data (ticks, candles, funds, orders, positions, mode,
 * account status) flows over ONE socket.io connection to the Python
 * backend WS port (:8001) through the Caddy gateway (?XTransformPort).
 *
 * REST (/pyapi, :8000) is used ONLY for tool interactions:
 *   login, account CRUD/connect, place/cancel order, master sync,
 *   settings, workspace download.  (Round-15 architecture)
 */
import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;
let restToken = "";

export function setRestToken(t: string) {
  restToken = t;
}

export function getSocket(): Socket {
  if (socket && socket.connected) return socket;
  socket = io("/?XTransformPort=8001", {
    path: "/",
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    timeout: 12000,
    forceNew: false,
  });
  if (typeof window !== "undefined") {
    (window as unknown as { __sock: Socket }).__sock = socket;   // dev diagnostics
  }
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

/** REST call to the FastAPI backend through the gateway. */
export async function pyapi<T = unknown>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown
): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`/pyapi${path}${sep}XTransformPort=8000`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(restToken ? { Authorization: `Bearer ${restToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string; detail?: string })?.error ||
      (data as { detail?: string })?.detail ||
      `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return data as T;
}
