// @ts-nocheck
// Broker plugin entrypoint — importing this module registers
// every broker adapter into the registry.
// OpenAlgo-style: add a new broker by creating a folder with an
// adapter.ts implementing BrokerAdapter and importing it here.
export * from './registry'
// auth flows (routes by mapping — see brokers/auth.ts) + one adapter per broker
import './auth'
import './simfeed/adapter'
import './dhan/adapter'
import './shoonya/adapter'
import './icici_breeze/adapter'
