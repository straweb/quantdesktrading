// @ts-nocheck
// ============================================================
// Feed-adapter side-load — importing this module registers every
// broker's live feed adapter into the feed registry.
// OpenAlgo-style: add a new broker's market data by creating
// brokers/<name>/feed.ts that calls registerFeedAdapter() and
// importing it here (one line).
//
// Used by the market-feed mini-service (bun) — keep it free of
// Next.js imports.
// ============================================================
import './dhan/feed'
import './shoonya/feed'
import './icici_breeze/feed'
