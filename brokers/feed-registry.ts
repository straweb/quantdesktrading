// @ts-nocheck
// ============================================================
// Broker FEED registry — OpenAlgo-style routing by mapping.
//
// Every broker lives in its own folder (brokers/<name>/) and can
// expose a live market-data poller by registering a BrokerFeedAdapter
// here. The live-broker-feed engine (mini-services/market-feed) is
// GENERIC: it resolves symbols → mappings (SymbolMapping rows) and
// hands them to whichever adapter is registered for the account's
// brokerType. Adding a new broker's feed = one file + one register
// call — no engine changes.
//
// ⚠ Bun-safe: this module and every feed adapter run inside the
//   market-feed mini-service (bun) — no Next.js imports allowed.
// ============================================================

export interface FeedMappingRow {
  masterSymbol: string
  exchange: string
  instrumentType: string
  lotSize: number
  brokerSymbol: string
  brokerToken: string
}

export interface FeedQuote {
  ltp?: number
  bid?: number
  ask?: number
  open?: number
  high?: number
  low?: number
  prevClose?: number
  volume?: number
}

/** mutable slice of the engine status the adapter is allowed to update */
export interface FeedStatusSink {
  errors: number
  polls: number
  symbols: number
  lastError: string | null
  errorTs: number | null
}

export interface FeedPollCtx {
  accountId: string
  /** decrypted credentials straight from the master DB (fresh every cycle) */
  creds: Record<string, string>
  /** subscribed symbols mapped to this broker's tokens */
  targets: FeedMappingRow[]
  /** apply a real quote into the tick pipeline (creates live states on demand) */
  applyQuote(symbol: string, q: FeedQuote, m?: FeedMappingRow): boolean
  /** credentials were REJECTED — engine reloads creds + backs off */
  noteAuthFailure(brokerLabel: string, detail: string): void
  /** adapter-owned status updates */
  status: FeedStatusSink
  pushLog(line: string, level?: 'INFO' | 'WARN' | 'ERROR'): void
}

export interface BrokerFeedAdapter {
  brokerType: string // master-DB BrokerAccount.brokerType (DHAN | SHOONYA | ICICI_BREEZE | …)
  poll(ctx: FeedPollCtx): Promise<void>
}

const feedAdapters = new Map<string, BrokerFeedAdapter>()

export function registerFeedAdapter(a: BrokerFeedAdapter): void {
  feedAdapters.set(a.brokerType, a)
}

export function getFeedAdapter(brokerType: string): BrokerFeedAdapter | undefined {
  return feedAdapters.get(brokerType)
}

export function listFeedAdapters(): string[] {
  return [...feedAdapters.keys()]
}
