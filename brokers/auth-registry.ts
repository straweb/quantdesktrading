// @ts-nocheck
// ============================================================
// Broker AUTH registry — OpenAlgo-style routing by mapping.
// Each broker folder (brokers/<name>/auth.ts) owns its complete
// session flow (start descriptor + code/token exchange + optional
// programmatic re-login) and registers it here. brokers/auth.ts is
// a thin router: authStart(brokerType) → getAuthFlow(brokerType).
// Adding a new broker's session flow = one file + one register call.
// ============================================================
import type { BrokerAuthFlow } from './auth-types'

const authFlows = new Map<string, BrokerAuthFlow>()

export function registerAuthFlow(f: BrokerAuthFlow): void {
  authFlows.set(f.brokerType, f)
}

export function getAuthFlow(brokerType: string): BrokerAuthFlow | undefined {
  return authFlows.get(brokerType)
}

export function listAuthFlows(): string[] {
  return [...authFlows.keys()]
}
