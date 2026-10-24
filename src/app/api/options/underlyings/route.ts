// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { listOptionUnderlyings } from '@/lib/services/option-service'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const underlyings = await listOptionUnderlyings()
  return NextResponse.json({ underlyings })
}

export const dynamic = 'force-dynamic'
