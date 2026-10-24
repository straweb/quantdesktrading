// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getAdapter, type LegContext, type SymbolMapInfo } from '../../../../brokers/index'
import { decryptJson } from '@/lib/crypto'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ============================================================
// POST /api/margin — per-account order margin estimate.
// { accountId, symbol, side, qty, price, productType }
// Dhan: POST /v2/margincalculator · Shoonya: GetMargin ·
// Breeze: /customer/margins?action=buy|sell.
// The account's usable capital is included for the
// required-vs-available check.
// ============================================================

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    const body = await req.json() as {
      accountId?: string
      symbol?: string
      side?: 'BUY' | 'SELL'
      qty?: number
      price?: number
      productType?: string
    }
    if (!body.accountId || !body.symbol || !body.qty || !body.price) {
      return NextResponse.json({ error: 'accountId, symbol, qty, price are required' }, { status: 400 })
    }
    const acc = await db.brokerAccount.findUnique({
      where: { id: body.accountId },
      include: { capital: true },
    })
    if (!acc) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    // resolve the account's broker symbol mapping
    const master = await db.symbolMaster.findFirst({ where: { symbol: body.symbol } })
    const mapping = master
      ? await db.symbolMapping.findFirst({ where: { masterId: master.id, brokerType: acc.brokerType } })
      : null
    if (!master || !mapping) {
      return NextResponse.json({ error: `No ${acc.brokerType} mapping for ${body.symbol}` }, { status: 404 })
    }

    const adapter = getAdapter(acc.brokerType as never)
    const creds = decryptJson(acc.credentialsEnc)
    const usable = acc.capital
      ? Math.max(0, (acc.capital.mode === 'PROFIT_ONLY'
          ? (acc.capital.firstTradeDone ? acc.capital.realizedPnl : acc.capital.initialCapital)
          : acc.capital.mode === 'INITIAL_WITH_LOSS_REDUCTION'
            ? acc.capital.initialCapital + Math.min(0, acc.capital.realizedPnl)
            : acc.capital.initialCapital + acc.capital.realizedPnl) - acc.capital.deployed)
      : 0

    if (!adapter?.marginCalc || !creds) {
      // sandbox estimate: notional (options) or notional / 5 (intraday EQ/FUT)
      const notional = master.instrumentType === 'CE' || master.instrumentType === 'PE' ? body.qty * master.lotSize * body.price : body.qty * master.lotSize * body.price
      const est = master.instrumentType === 'CE' || master.instrumentType === 'PE' ? notional : Math.round(notional / 5)
      return NextResponse.json({
        estimate: { required: est, available: usable, detail: `sandbox estimate — ${master.instrumentType === 'CE' || master.instrumentType === 'PE' ? 'premium payable' : 'intraday ~20% leverage'}` },
        usable,
        live: false,
      })
    }

    const ctx: LegContext = {
      accountId: acc.id,
      accountLabel: acc.label,
      brokerType: acc.brokerType as never,
      credentials: creds,
      order: { side: body.side === 'SELL' ? 'SELL' : 'BUY', qty: body.qty, orderType: 'LIMIT', productType: (body.productType as 'MIS' | 'CNC' | 'NRML') ?? 'MIS', limitPrice: body.price, masterOrderId: '', source: 'API' },
      symbolMap: {
        masterSymbol: master.symbol,
        exchange: master.exchange,
        instrumentType: master.instrumentType,
        lotSize: master.lotSize,
        brokerSymbol: mapping.brokerSymbol,
        brokerToken: mapping.brokerToken ?? undefined,
      } as SymbolMapInfo,
      ltp: body.price,
    }
    const out = await adapter.marginCalc(ctx, {
      side: body.side === 'SELL' ? 'SELL' : 'BUY',
      qty: body.qty,
      price: body.price,
      productType: body.productType ?? 'MIS',
    })
    return NextResponse.json({ estimate: out, usable, live: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Margin calc failed' }, { status: 502 })
  }
}
