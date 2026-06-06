import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/** Wave 36 — canonical destination types match m148 CHECK constraint
 *  on qr_codes.destination_type. */
const VALID_DESTINATION_TYPES = new Set([
  'landing_page',
  'video_avatar_tour',
  'cma_form',
  'listing_detail',
  'book_meeting',
  'podcast_episode',
  'anniversary_video',
  'other',
])

function generateSlug(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const suffix = Math.random().toString(36).slice(2, 7)
  return `${base}-${suffix}`
}

/** Build a sensible default target_url when the caller doesn't supply
 *  one. For app-hosted destination_types (landing_page, cma_form,
 *  book_meeting) we route to existing app pages. For external types
 *  (video_avatar_tour, podcast_episode, anniversary_video, other) the
 *  caller must supply targetUrl — we fail validation otherwise. */
function defaultUrlForDestination(
  destinationType: string | null,
  slug: string,
  origin: string,
): string | null {
  if (!destinationType) return null
  switch (destinationType) {
    case 'landing_page':   return `${origin}/qr/${slug}/landing`
    case 'cma_form':       return `${origin}/forms/cma?qr=${slug}`
    case 'book_meeting':   return `${origin}/book?qr=${slug}`
    case 'listing_detail': return null  // requires listing_id from caller
    default:               return null  // external — caller supplies
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const supabaseAuth = await createClient()
    const { data: { user } } = await supabaseAuth.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await req.json()) as {
      label: string
      purpose?: string
      destinationType?: string
      targetUrl?: string
      listingId?: string
      agentUserId: string
      brokerageId: string
    }

    const { label, purpose, destinationType, targetUrl, listingId, agentUserId, brokerageId } = body
    if (!label || !brokerageId) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    if (destinationType && !VALID_DESTINATION_TYPES.has(destinationType)) {
      return NextResponse.json({
        success: false,
        error: `Invalid destination_type. Must be one of: ${[...VALID_DESTINATION_TYPES].join(', ')}`,
      }, { status: 400 })
    }

    const supabase = createServiceClient()
    const slug = generateSlug(label)
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin

    // Resolve target_url with this precedence:
    //   1. Caller-supplied targetUrl (the explicit override)
    //   2. listing-detail with listingId → app listing page
    //   3. App-hosted default for the destinationType
    //   4. Hard-fail — qr_codes.target_url is NOT NULL
    let resolvedUrl: string | null = (targetUrl ?? '').trim() || null
    if (!resolvedUrl && destinationType === 'listing_detail' && listingId) {
      resolvedUrl = `${origin}/listing/${listingId}`
    }
    if (!resolvedUrl) {
      resolvedUrl = defaultUrlForDestination(destinationType ?? null, slug, origin)
    }
    if (!resolvedUrl) {
      return NextResponse.json({
        success:false,
        error: 'target_url is required (no app-hosted default exists for this destination type — provide a URL explicitly).',
      }, { status: 400 })
    }

    const { data: qrCode, error } = await supabase
      .from('qr_codes')
      .insert({
        slug,
        label,
        purpose: purpose ?? null,
        target_url: resolvedUrl,
        destination_type: destinationType ?? null,
        listing_id: listingId ?? null,
        agent_id: agentUserId,
        brokerage_id: brokerageId,
        is_active: true,
        scan_count: 0,
        lead_count: 0,
      })
      .select('id, slug, label, purpose, target_url, destination_type, listing_id, scan_count, lead_count, is_active, created_at')
      .single()

    if (error || !qrCode) {
      return NextResponse.json({ success: false, error: error?.message ?? 'Failed to create QR code' }, { status: 500 })
    }

    return NextResponse.json({ success: true, qrCode })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

/** PATCH — edit target_url + destination_type + label on an existing
 *  QR. CRITICAL UX: a printed postcard's QR routes through /api/qr/scan
 *  which redirects to target_url. Updating target_url here REROUTES
 *  every printed copy in the wild without reprinting. The agent
 *  who designed the campaign can repoint stale postcards from a
 *  sunsetted landing page to the current campaign's URL.
 *
 *  Tenant scope: callers can only edit QRs in their own brokerage. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const supabaseAuth = await createClient()
    const { data: { user } } = await supabaseAuth.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await req.json()) as {
      id: string
      brokerageId: string
      label?: string
      purpose?: string | null
      destinationType?: string | null
      targetUrl?: string
      isActive?: boolean
    }
    const { id, brokerageId } = body
    if (!id || !brokerageId) {
      return NextResponse.json({ success: false, error: 'id and brokerageId required' }, { status: 400 })
    }

    if (body.destinationType && !VALID_DESTINATION_TYPES.has(body.destinationType)) {
      return NextResponse.json({
        success: false,
        error: `Invalid destination_type.`,
      }, { status: 400 })
    }

    // Tenant ownership check before any write.
    const supabase = createServiceClient()
    const { data: existing } = await supabase
      .from('qr_codes')
      .select('id, brokerage_id')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (existing.brokerage_id !== brokerageId) {
      return NextResponse.json({ success: false, error: 'Tenant mismatch' }, { status: 403 })
    }

    // Build the patch — only include fields the caller specified so
    // the partial PATCH semantics are preserved.
    const patch: Record<string, unknown> = {}
    if (body.label !== undefined)        patch.label = body.label.trim()
    if (body.purpose !== undefined)      patch.purpose = body.purpose
    if (body.destinationType !== undefined) patch.destination_type = body.destinationType
    if (body.targetUrl !== undefined) {
      const trimmed = body.targetUrl.trim()
      if (!trimmed) {
        return NextResponse.json({ success: false, error: 'targetUrl cannot be empty' }, { status: 400 })
      }
      patch.target_url = trimmed
    }
    if (body.isActive !== undefined)     patch.is_active = body.isActive

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 })
    }

    const { data: updated, error } = await supabase
      .from('qr_codes')
      .update(patch)
      .eq('id', id)
      .eq('brokerage_id', brokerageId)
      .select('id, slug, label, purpose, target_url, destination_type, listing_id, scan_count, lead_count, is_active, created_at')
      .single()
    if (error || !updated) {
      return NextResponse.json({ success: false, error: error?.message ?? 'Update failed' }, { status: 500 })
    }
    return NextResponse.json({ success: true, qrCode: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
