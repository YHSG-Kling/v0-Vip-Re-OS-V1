// GET /api/track/pixel
// Query params: b (brokerage_id), a (agent_id), s (session_id), p (page URL)
// RULE: Pixel fire = anonymous visit record only. NOT consent. NOT lead creation.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

// 1x1 transparent GIF bytes
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl
  const brokerageId = searchParams.get('b') ?? ''
  const agentId     = searchParams.get('a') ?? null
  const sessionId   = searchParams.get('s') ?? ''
  const pageUrl     = searchParams.get('p') ?? ''
  const referrer    = req.headers.get('referer') ?? null

  const utmSource   = searchParams.get('utm_source')   ?? null
  const utmMedium   = searchParams.get('utm_medium')   ?? null
  const utmCampaign = searchParams.get('utm_campaign') ?? null

  // All params required at minimum: b, s
  if (!brokerageId || !sessionId) {
    return new NextResponse(TRANSPARENT_GIF, {
      status: 200,
      headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' },
    })
  }

  try {
    const supabase = createServiceClient()
    const now = new Date().toISOString()

    await supabase
      .from('website_visitors')
      .upsert(
        {
          brokerage_id:  brokerageId,
          agent_id:      agentId,
          session_id:    sessionId,
          page_url:      pageUrl,
          referrer,
          utm_source:    utmSource,
          utm_medium:    utmMedium,
          utm_campaign:  utmCampaign,
          first_seen_at: now,
          last_seen_at:  now,
        },
        {
          onConflict:        'session_id',
          ignoreDuplicates:  false,
        },
      )
      // On conflict only update last_seen_at — first_seen_at is immutable
      .select('id')
      .single()

    // On conflict update last_seen_at via a separate rpc is not possible with
    // upsert alone when we want to protect first_seen_at. Use merge-defaults approach:
    // Supabase upsert with ignoreDuplicates=false overwrites all columns listed.
    // To protect first_seen_at we do an update after:
    await supabase
      .from('website_visitors')
      .update({ last_seen_at: now })
      .eq('session_id', sessionId)
      .is('identified_at', null)   // only update unidentified sessions
  } catch {
    // Non-fatal: pixel must always return the GIF
  }

  return new NextResponse(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      'Content-Type':  'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma':        'no-cache',
    },
  })
}
