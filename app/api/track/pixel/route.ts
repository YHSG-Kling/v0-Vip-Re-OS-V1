// GET /api/track/pixel
// Query params: b (brokerage_id), a (agent_id), s (session_id), p (page URL)
// RULE: Pixel fire = anonymous visit record only. NOT consent. NOT lead creation.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
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

    // WAVE 156 (lane 156F) — A SESSION NEVER CHANGES TENANT. This was an `.upsert(…, { onConflict: 'session_id' })`
    // that wrote `brokerage_id: b` on EVERY hit. `session_id` is UNIQUE across the whole table, so a second pixel fire
    // carrying the same session id under ANOTHER brokerage's `b` (any page can fire it — `b` and `s` are query params)
    // MOVED the existing row into that tenant, together with the contact_id / lead_id the first tenant's identify loop
    // had stamped on it: one tenant's identified visitor, linked to its contact, re-homed in another tenant's
    // Website Visitor Tracking table and, through /api/track/identify (which takes its tenant FROM this row), matched
    // against the second tenant's contacts. It also rewrote first_seen_at on every hit. Now: read the row the unique
    // session id names; a row owned by another tenant is REFUSED (nothing written — a session id is not portable
    // between tenants); the owner's row is refreshed in place, pinned to its own id AND tenant; no row → insert.
    const { data: existing, error: readError } = await supabase
      .from('website_visitors')
      .select('id, brokerage_id')
      .eq('session_id', sessionId)
      .maybeSingle()
    const owned = existing as { id: string; brokerage_id: string | null } | null
    if (readError) {
      console.error('[track/pixel] session read refused — nothing written:', readError.message)
    } else if (owned && owned.brokerage_id !== brokerageId) {
      console.warn('[track/pixel] session id already belongs to another tenant — refused, nothing written')
    } else if (owned) {
      await sentinelWrite(supabase, supabase
        .from('website_visitors')
        .update({ page_url: pageUrl, last_seen_at: now })
        .eq('id', owned.id)
        .eq('brokerage_id', brokerageId), { table: "website_visitors", flow: "website_visitors_write", reason: "pixel must always return the GIF" })
    } else {
      await sentinelWrite(supabase, supabase
        .from('website_visitors')
        .insert({
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
        }), { table: "website_visitors", flow: "website_visitors_write", reason: "pixel must always return the GIF" })
    }
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
