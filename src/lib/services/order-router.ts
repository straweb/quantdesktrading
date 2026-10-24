// @ts-nocheck
import { db } from '../db'
import { getAdapter, newId, type LegContext, type SymbolMapInfo } from '../../../brokers/index'
import { getPositions, getTrades } from '../../../brokers/database'
import { fetchQuotes } from '../../../brokers/feed-client'
import { computeUsableCapital, getCapitalState, marginForUnits, onTradeSettled, sizeUnitsForCapital } from './capital-service'
import { round2 } from '../charges'
import { optionPremium } from './symbol-service'
import type { MasterOrderResult, OrderLegResult, PlaceOrderRequest } from '../types'

// ============================================================
// Order router / copy-trading engine.
// One master order -> N broker legs (every account where
// isOrderEnabled=true), each leg sized by its own capital house
// rules, resolved through per-broker symbol mappings.
// ============================================================

export interface ResolvedInstrument {
  masterSymbol: string
  exchange: string
  instrumentType: string
  lotSize: number
  underlying?: string | null
  expiry?: string | null
  strike?: number | null
  optionType?: string | null
  basePrice?: number | null
}

export async function resolveInstrument(symbol: string, exchange?: string): Promise<ResolvedInstrument | null> {
  const s = await db.symbolMaster.findFirst({
    where: exchange ? { symbol, exchange } : { symbol },
  })
  if (!s) return null
  return {
    masterSymbol: s.symbol,
    exchange: s.exchange,
    instrumentType: s.instrumentType,
    lotSize: s.lotSize,
    underlying: s.underlying,
    expiry: s.expiry,
    strike: s.strike,
    optionType: s.optionType,
    basePrice: s.basePrice,
  }
}

export interface AccountLeg {
  accountId: string
  label: string
  brokerType: keyof typeof import('../types').BROKER_META
  credentialsEnc: string | null
}

export async function getExecutableAccounts(onlyIds?: string[]): Promise<{ id: string; label: string; brokerType: any; credentialsEnc: string | null }[]> {
  const accounts = await db.brokerAccount.findMany({
    where: {
      isActive: true,
      isOrderEnabled: true,
      status: 'ACTIVE',
      ...(onlyIds && onlyIds.length ? { id: { in: onlyIds } } : {}),
    },
    orderBy: { sortOrder: 'asc' },
  })
  return accounts.map(a => ({ id: a.id, label: a.label, brokerType: a.brokerType, credentialsEnc: a.credentialsEnc }))
}

/**
 * Reference price when the feed has NO state for the symbol (never
 * opened/seeded). Estimates from the underlying's CURRENT price — options
 * via the same premium model the chain uses, futures from the underlying —
 * instead of the old ₹1000 placeholder that broke sizing.
 */
async function estimatePriceFromMaster(inst: ResolvedInstrument): Promise<number> {
  const daysTo = (exp: string | null | undefined): number =>
    Math.max(0, Math.round(((exp ? Date.parse(exp) : 0) - Date.now()) / 86400_000))
  try {
    if ((inst.instrumentType === 'CE' || inst.instrumentType === 'PE') && inst.strike) {
      const und = inst.underlying ?? ''
      let spot = und ? (await fetchQuotes([und]))[und]?.ltp ?? 0 : 0
      if (!(spot > 0) && und) {
        const base = await db.symbolMaster.findFirst({ where: { symbol: und } })
        spot = base?.basePrice ?? 0
      }
      if (!(spot > 0)) return 0
      return optionPremium(spot, inst.strike, inst.instrumentType as 'CE' | 'PE', daysTo(inst.expiry))
    }
    if (inst.instrumentType === 'FUT' && inst.underlying) {
      const q = await fetchQuotes([inst.underlying])
      const uLtp = q[inst.underlying]?.ltp ?? 0
      if (uLtp > 0) return uLtp
      const base = await db.symbolMaster.findFirst({ where: { symbol: inst.underlying } })
      return base?.basePrice ?? 0
    }
    return inst.basePrice ?? 0
  } catch {
    return 0
  }
}

export async function placeMasterOrder(req: PlaceOrderRequest): Promise<MasterOrderResult> {
  const masterOrderId = newId('MO-')
  const inst = await resolveInstrument(req.symbol, req.exchange)
  if (!inst) {
    return { masterOrderId, symbol: req.symbol, exchange: req.exchange, side: req.side, lots: req.qty, status: 'FAILED', legs: [], message: `Unknown symbol ${req.symbol} — sync master contracts first` }
  }

  const accounts = await getExecutableAccounts(req.legAccounts)
  if (accounts.length === 0) {
    return { masterOrderId, symbol: inst.masterSymbol, exchange: inst.exchange, side: req.side, lots: req.qty, status: 'FAILED', legs: [], message: 'No order-enabled accounts. Enable accounts in Admin.' }
  }

  const quotes = await fetchQuotes([inst.masterSymbol])
  let ltp = quotes[inst.masterSymbol]?.ltp ?? 0
  if (!(ltp > 0)) {
    // no feed state (symbol never opened/seeded) — NEVER fall back to the old
    // ₹1000 placeholder (it mispriced options by 10-1000× and made sizing
    // reject). Estimate from the UNDERLYING's current price instead.
    ltp = await estimatePriceFromMaster(inst)
  }
  if (!(ltp > 0)) {
    return { masterOrderId, symbol: inst.masterSymbol, exchange: req.exchange, side: req.side, lots: req.qty, status: 'FAILED', legs: [], message: `No price for ${req.symbol} — no live tick and no reference price (open the chain or wait for the feed)` }
  }

  const legs: OrderLegResult[] = []
  let anyFill = false
  let fillCount = 0

  for (const acc of accounts) {
    const adapter = getAdapter(acc.brokerType as never)
    if (!adapter) {
      legs.push({ accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, brokerOrderId: null, status: 'SKIPPED', qty: 0, message: 'No adapter' })
      continue
    }

    // --- per-account qty sizing (house capital rules) ---
    // reduceOnly legs (exits/square-offs) bypass capital checks entirely —
    // closing a position reduces risk and must never be blocked.
    // They are also capped at each account's OWN held qty so a reduce
    // never flips a flat/short account into an unintended position.
    let qtyUnitsOrLots = req.qty
    if (req.reduceOnly) {
      const posNow = getPositions(acc.brokerType, acc.id).find(p => p.symbol === inst.masterSymbol && p.exchange === inst.exchange && p.productType === req.productType)
      const heldLots = posNow
        ? (req.side === 'SELL'
            ? (posNow.netQty > 0 ? Math.floor(posNow.netQty / inst.lotSize) : 0)
            : (posNow.netQty < 0 ? Math.floor(-posNow.netQty / inst.lotSize) : 0))
        : 0
      qtyUnitsOrLots = Math.min(req.qty, heldLots)
      if (qtyUnitsOrLots <= 0) {
        legs.push({ accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, brokerOrderId: null, status: 'SKIPPED', qty: 0, message: 'No position to reduce' })
        continue
      }
    } else if (req.source === 'MANUAL' || req.source === 'STRATEGY' || req.source === 'API') {
      const capital = await getCapitalState(acc.id)
      if (!capital) {
        legs.push({ accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, brokerOrderId: null, status: 'SKIPPED', qty: 0, message: 'No capital config' })
        continue
      }
      const usable = computeUsableCapital(capital)
      const sized = sizeUnitsForCapital({
        usable, price: ltp, instrumentType: inst.instrumentType, productType: req.productType,
        lotSize: inst.lotSize, sharePct: req.capitalPct ?? 100, absoluteAmount: req.tag?.startsWith('abs:') ? Number(req.tag.slice(4)) : undefined,
        roundToLot: inst.instrumentType !== 'EQ',
      })
      if (req.qty > 0) {
        // explicit qty: execute same qty if capital allows, else reject leg
        const need = marginForUnits(req.qty * inst.lotSize, ltp, inst.instrumentType, req.productType)
        if (need > usable) {
          legs.push({ accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, brokerOrderId: null, status: 'SKIPPED', qty: req.qty, message: `Insufficient usable capital (need ₹${round2(need)}, have ₹${round2(usable)})` })
          continue
        }
        qtyUnitsOrLots = req.qty
      } else {
        qtyUnitsOrLots = Math.floor(sized / inst.lotSize)
        if (qtyUnitsOrLots < 1) {
          legs.push({ accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, brokerOrderId: null, status: 'SKIPPED', qty: 0, message: `Sized qty 0 (usable ₹${round2(usable)})` })
          continue
        }
      }
    }

    // --- position margin delta bookkeeping ---
    const posBefore = getPositions(acc.brokerType, acc.id).find(p => p.symbol === inst.masterSymbol && p.exchange === inst.exchange && p.productType === req.productType)
    const marginBefore = posBefore && posBefore.avgPrice > 0 ? marginForUnits(Math.abs(posBefore.netQty), posBefore.avgPrice, inst.instrumentType, req.productType) : 0

    const ctx: LegContext = {
      accountId: acc.id,
      accountLabel: acc.label,
      brokerType: acc.brokerType,
      credentials: null, // decrypted below via adapter-specific helper
      order: {
        side: req.side, qty: qtyUnitsOrLots, orderType: req.orderType, productType: req.productType,
        limitPrice: req.limitPrice, triggerPrice: req.triggerPrice,
        masterOrderId, strategyId: req.strategyId, source: req.source,
      },
      symbolMap: {
        masterSymbol: inst.masterSymbol, exchange: inst.exchange, instrumentType: inst.instrumentType,
        lotSize: inst.lotSize, brokerSymbol: inst.masterSymbol, brokerToken: undefined,
      } as SymbolMapInfo,
      ltp,
    }

    // resolve broker-specific mapping + credentials
    const mapping = await db.symbolMapping.findFirst({ where: { master: { symbol: inst.masterSymbol, exchange: inst.exchange }, brokerType: acc.brokerType } })
    if (mapping) {
      ctx.symbolMap.brokerSymbol = mapping.brokerSymbol
      ctx.symbolMap.brokerToken = mapping.brokerToken
    } else {
      const generated = adapter.mapSymbol({ symbol: inst.masterSymbol, exchange: inst.exchange, instrumentType: inst.instrumentType, expiry: null, strike: null, optionType: null })
      ctx.symbolMap.brokerSymbol = generated.brokerSymbol
      ctx.symbolMap.brokerToken = generated.brokerToken ?? undefined
    }
    const { decryptJson } = await import('../crypto')
    ctx.credentials = decryptJson(acc.credentialsEnc)

    let leg: OrderLegResult
    try {
      leg = await adapter.placeOrder(ctx)
    } catch (e) {
      console.error(`[order-router] leg ${acc.label} failed:`, e)
      leg = { accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, brokerOrderId: null, status: 'REJECTED', qty: qtyUnitsOrLots, message: `Adapter error: ${e instanceof Error ? e.message : String(e)}` }
    }
    legs.push(leg)

    if (leg.status === 'FILLED') {
      anyFill = true
      fillCount++
      // margin delta + settlement booking (single source of truth)
      const posAfter = getPositions(acc.brokerType, acc.id).find(p => p.symbol === inst.masterSymbol && p.exchange === inst.exchange && p.productType === req.productType)
      const marginAfter = posAfter && posAfter.avgPrice > 0 ? marginForUnits(Math.abs(posAfter.netQty), posAfter.avgPrice, inst.instrumentType, req.productType) : 0
      const marginDelta = round2(marginAfter - marginBefore)
      const t = latestTradeFor(acc.brokerType, acc.id, leg.brokerOrderId)
      await onTradeSettled({
        accountId: acc.id,
        realizedNetPnl: t?.realizedPnl ?? 0,
        charges: t?.chargesTotal ?? 0,
        marginDelta,
      })
    }
  }

  const status: MasterOrderResult['status'] = fillCount === 0 ? 'FAILED' : fillCount === accounts.length ? 'SUCCESS' : 'PARTIAL'

  await db.orderAudit.create({
    data: {
      id: masterOrderId,
      source: req.source,
      action: 'PLACE',
      masterSymbol: inst.masterSymbol,
      exchange: inst.exchange,
      side: req.side,
      qty: req.qty,
      price: req.limitPrice ?? null,
      legsJson: JSON.stringify(legs),
      status: fillCount > 0 ? (fillCount === accounts.length ? 'SUCCESS' : 'PARTIAL') : 'FAILED',
    },
  })

  const fills = legs.filter(l => l.price !== undefined && l.status === 'FILLED')
  const avgFillPrice = fills.length ? round2(fills.reduce((s, l) => s + (l.price ?? 0), 0) / fills.length) : undefined

  return {
    masterOrderId,
    symbol: inst.masterSymbol,
    exchange: inst.exchange,
    side: req.side,
    lots: req.qty,
    status,
    legs,
    avgFillPrice,
    message: `${fillCount}/${accounts.length} legs filled`,
  }
}

/** Find the trade row generated by a leg fill (realized pnl + charges) */
function latestTradeFor(brokerType: string, accountId: string, brokerOrderId?: string | null) {
  if (!brokerOrderId) return undefined
  return getTrades(brokerType, accountId, 50).find(t => t.orderId === brokerOrderId)
}

export async function squareOffAll(
  source: 'SQUAREOFF' | 'KILLSWITCH' = 'SQUAREOFF',
  filter?: { symbols?: string[] },
): Promise<MasterOrderResult[]> {
  const only = filter?.symbols && filter.symbols.length > 0 ? new Set(filter.symbols) : null
  const accounts = await getExecutableAccounts()
  const results: MasterOrderResult[] = []
  for (const acc of accounts) {
    const positions = getPositions(acc.brokerType, acc.id).filter(p => p.netQty !== 0 && (!only || only.has(p.symbol)))
    for (const p of positions) {
      const res = await placeMasterOrder({
        symbol: p.symbol,
        exchange: p.exchange,
        side: p.netQty > 0 ? 'SELL' : 'BUY',
        qty: Math.abs(p.netQty) / p.lotSize,
        orderType: 'MARKET',
        productType: p.productType,
        source,
        legAccounts: [acc.id],
        reduceOnly: true,
      })
      results.push(res)
    }
  }
  await db.orderAudit.create({
    data: {
      id: newId('SO-'), source, action: 'SQUAREOFF_ALL', masterSymbol: '*', exchange: '*',
      side: '*', qty: 0, legsJson: JSON.stringify(results.map(r => ({ id: r.masterOrderId, status: r.status }))),
      status: results.some(r => r.status === 'FAILED') ? 'PARTIAL' : 'SUCCESS',
    },
  })
  return results
}

export async function cancelAllOrders(symbolFilter?: string[]): Promise<number> {
  const only = symbolFilter && symbolFilter.length > 0 ? new Set(symbolFilter) : null
  const accounts = await getExecutableAccounts()
  let cancelled = 0
  for (const acc of accounts) {
    const adapter = getAdapter(acc.brokerType)
    if (!adapter) continue
    const { getOpenOrders } = await import('../../../brokers/database')
    for (const o of getOpenOrders(acc.brokerType, acc.id)) {
      if (only && !only.has(o.symbol)) continue
      const ctx: LegContext = {
        accountId: acc.id, accountLabel: acc.label, brokerType: acc.brokerType, credentials: null,
        order: { side: o.side, qty: o.qty, orderType: o.orderType, productType: o.productType, masterOrderId: o.masterOrderId ?? '', source: 'KILLSWITCH' },
        symbolMap: { masterSymbol: o.symbol, exchange: o.exchange, instrumentType: 'EQ', lotSize: 1, brokerSymbol: o.symbol },
        ltp: 0,
      }
      const { decryptJson } = await import('../crypto')
      ctx.credentials = decryptJson(acc.credentialsEnc)
      const r = await adapter.cancelOrder(ctx, o.id)
      if (r.ok) {
        cancelled++
        const { updateOrder } = await import('../../../brokers/database')
        updateOrder(acc.brokerType, acc.id, o.id, { status: 'CANCELLED', message: 'Killed by user' })
      }
    }
  }
  return cancelled
}
