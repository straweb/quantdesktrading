// @ts-nocheck
// ============================================================
// Broker auth flow types — shared by the per-broker auth modules
// and the auth registry (OpenAlgo-style: each broker folder owns
// its session flow; brokers/auth.ts routes by mapping).
// ============================================================

/** Per-broker session bootstrap descriptor — shown in the admin Session dialog. */
export interface AuthStartResult {
  loginUrl: string | null // null = direct-paste only
  instructions: string[]
  fieldsNeeded: string[]
}

export interface AuthCompleteResult {
  ok: boolean
  message: string
  credentials?: Record<string, string>
  userId?: string | null
  /** ISO timestamp when the broker session expires, when the flow knows it */
  sessionExpiresAt?: string
  /** 'daily' | 'fixed' — mirrors adapter.sessionKind() for the UI */
  sessionKind?: 'daily' | 'fixed' | 'none'
}

export interface BrokerAuthFlow {
  brokerType: string
  start(accountId: string, creds: Record<string, string> | null): AuthStartResult
  complete(accountId: string, creds: Record<string, string> | null, code: string): Promise<AuthCompleteResult>
  /** can the terminal re-create the session itself from stored credentials? */
  autoRenewable?(creds: Record<string, string> | null): boolean
  /** programmatic re-login from stored credentials (QuickAuth etc.) */
  renew?(accountId: string, creds: Record<string, string>): Promise<AuthCompleteResult>
}
