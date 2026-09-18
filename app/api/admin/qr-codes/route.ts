import { NextRequest, NextResponse } from 'next/server'
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from '@/lib/supabase/service'
import { resolveWriteContext } from '@/lib/platform/acting-context'
import { mintTrackedQr, QR_DESTINATION_TYPES, isQrPurpose } from '@/lib/marketing/tracked-qr'

export const dynamic = 'force-dynamic'

/** Wave 36 — canonical destination types match m148 CHECK constraint
 *  on qr_codes.destination_type. Sourced from the one QR minter so this route
 *  and the writer can never disagree about the live vocabulary. */
const VALID_DESTINATION_TYPES = new Set<string>(QR_DESTINATION_TYPES)

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

/**
 * POST — create a QR code.
 *
 * MERGED-THEN-DELETED: this route's own `qr_codes` insert is gone. It was one of nine rival
 * creation paths — it set destination_type but had NO idempotency at all, so a retried request
 * minted a second code for the same thing. The write now goes through the one minter,
 * lib/marketing/tracked-qr.ts:mintTrackedQr. What this route contributed and KEPT: the
 * destination_type validation set (now sourced from the minter itself) and the app-hosted
 * default-URL table below.
 *
 * TENANT: the route authenticated the caller and then inserted with a SERVICE client using the
 * `brokerageId` out of the request body — so any authenticated user could mint a QR code into any
 * brokerage. The tenant now comes from the session; a supplied brokerageId is only checked
 * against it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveWriteContext()
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: 401 })
    }
    if (!ctx.brokerageId) {
      return NextResponse.json({ success: false, error: 'No brokerage on your account' }, { status: 403 })
    }

    const body = (await req.json()) as {
      label: string
      purpose?: string
      destinationType?: string
      targetUrl?: string
      listingId?: string
      marketingCampaignId?: string
      expiresAt?: string
      agentUserId?: string
      brokerageId?: string
    }

    const { label, purpose, destinationType, targetUrl, listingId, agentUserId, brokerageId } = body
    if (!label) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }
    if (brokerageId && brokerageId !== ctx.brokerageId) {
      return NextResponse.json({ success: false, error: 'Tenant mismatch' }, { status: 403 })
    }

    if (destinationType && !VALID_DESTINATION_TYPES.has(destinationType)) {
      return NextResponse.json({
        success: false,
        error: `Invalid destination_type. Must be one of: ${[...VALID_DESTINATION_TYPES].join(', ')}`,
      }, { status: 400 })
    }
    if (purpose && !isQrPurpose(purpose)) {
      return NextResponse.json({ success: false, error: 'Invalid purpose.' }, { status: 400 })
    }

    const supabase = createServiceClient()
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin

    // A campaign FK proves the campaign exists, never that it is ours.
    let marketingCampaignId: string | null = null
    if (body.marketingCampaignId) {
      const { data: campaign, error: campaignError } = await supabase
        .from('marketing_campaigns')
        .select('id')
        .eq('id', body.marketingCampaignId)
        .eq('brokerage_id', ctx.brokerageId)
        .maybeSingle()
      if (campaignError) {
        return NextResponse.json({ success: false, error: campaignError.message }, { status: 500 })
      }
      if (!campaign) {
        return NextResponse.json({ success: false, error: 'That campaign is not on your brokerage' }, { status: 403 })
      }
      marketingCampaignId = campaign.id as string
    }

    // Explicit target_url precedence (unchanged), except the slug-bearing defaults which can only
    // be built AFTER the minter assigns a slug — those are patched on below.
    let resolvedUrl: string | null = (targetUrl ?? '').trim() || null
    if (!resolvedUrl && destinationType === 'listing_detail' && listingId) {
      resolvedUrl = `${origin}/listing/${listingId}`
    }
    const needsSlugDerivedDefault =
      !resolvedUrl && !!destinationType && ['landing_page', 'cma_form', 'book_meeting'].includes(destinationType)
    if (!resolvedUrl && !needsSlugDerivedDefault) {
      return NextResponse.json({
        success: false,
        error: 'target_url is required (no app-hosted default exists for this destination type — provide a URL explicitly).',
      }, { status: 400 })
    }

    // qr_codes.agent_id FKs agents(id); tolerate callers already sending agents.id, else the session's.
    const agentId = agentUserId
      ? ((await resolveAgentId(supabase as any, agentUserId)) ?? agentUserId)
      : ctx.agentId

    const minted = await mintTrackedQr({
      brokerageId: ctx.brokerageId,
      agentId,
      label,
      destinationType: (destinationType as any) ?? null,
      targetUrl: resolvedUrl,
      listingId: listingId ?? null,
      marketingCampaignId,
      expiresAt: body.expiresAt ?? null,
      purpose: (purpose as any) ?? undefined,
      origin,
    }, supabase)

    if (!minted) {
      return NextResponse.json({ success: false, error: 'Failed to create QR code' }, { status: 500 })
    }

    if (needsSlugDerivedDefault) {
      const derived = defaultUrlForDestination(destinationType ?? null, minted.slug, origin)
      if (derived) {
        const { error: patchError } = await supabase
          .from('qr_codes').update({ target_url: derived }).eq('id', minted.qrCodeId)
        if (patchError) {
          return NextResponse.json({ success: false, error: patchError.message }, { status: 500 })
        }
      }
    }

    const { data: qrCode, error } = await supabase
      .from('qr_codes')
      .select('id, slug, label, purpose, target_url, destination_type, listing_id, marketing_campaign_id, expires_at, scan_count, lead_count, is_active, created_at')
      .eq('id', minted.qrCodeId)
      .single()

    if (error || !qrCode) {
      return NextResponse.json({ success: false, error: error?.message ?? 'Failed to read back QR code' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      qrCode,
      scanUrl: minted.scanUrl,
      qrImageDataUrl: minted.qrCodeDataUrl,
      created: minted.created,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

/**
 * PATCH — edit an existing QR code's label, purpose, destination_type, target_url, expiry, or
 * active flag.
 *
 * ★ TENANT HOLE CLOSED ★ This handler used to read `brokerageId` from the REQUEST BODY and
 * "verify" it as `existing.brokerage_id === body.brokerageId`. That check is SELF-SATISFYING: the
 * attacker supplies both halves, so any authenticated user who knew a QR code's id and its owning
 * brokerage id could edit ANOTHER TENANT'S code — relabel it, deactivate it, or repoint it. A QR
 * is a printed artifact in the wild, so that is a live redirect hijack, not a cosmetic edit. The
 * tenant is now resolved SERVER-SIDE from the session and the body value is NOT READ AT ALL —
 * comparing a caller-supplied identity is not a gate, it is a formality.
 *
 * NOTE ON target_url: the previous comment here claimed that editing it "REROUTES every printed
 * copy in the wild". It does not. app/api/qr/scan resolves the slug, records the scan, and
 * redirects to the public `/qr/<slug>` landing — it never reads target_url. target_url is the
 * SEMANTIC destination shown on the QR surfaces. Re-pointing the actual redirect is a separate
 * capability that does not exist yet; do not describe this as one.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveWriteContext()
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: 401 })
    }
    if (!ctx.brokerageId) {
      return NextResponse.json({ success: false, error: 'No brokerage on your account' }, { status: 403 })
    }

    // `brokerageId` is deliberately absent from this type: the tenant comes from the session and
    // a body-supplied one must never reach a query.
    const body = (await req.json()) as {
      id: string
      label?: string
      purpose?: string | null
      destinationType?: string | null
      targetUrl?: string
      expiresAt?: string | null
      isActive?: boolean
    }
    const { id } = body
    if (!id) {
      return NextResponse.json({ success: false, error: 'id required' }, { status: 400 })
    }

    if (body.destinationType && !VALID_DESTINATION_TYPES.has(body.destinationType)) {
      return NextResponse.json({ success: false, error: 'Invalid destination_type.' }, { status: 400 })
    }
    if (body.purpose && !isQrPurpose(body.purpose)) {
      return NextResponse.json({ success: false, error: 'Invalid purpose.' }, { status: 400 })
    }

    // Tenant ownership check before any write, against the SESSION's brokerage.
    const supabase = createServiceClient()
    const { data: existing, error: lookupError } = await supabase
      .from('qr_codes')
      .select('id, brokerage_id')
      .eq('id', id)
      .maybeSingle()
    if (lookupError) {
      return NextResponse.json({ success: false, error: lookupError.message }, { status: 500 })
    }
    if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (existing.brokerage_id !== ctx.brokerageId) {
      // Same answer as a missing row: whether a code exists in someone else's brokerage is not
      // this caller's business to learn.
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
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
    if (body.expiresAt !== undefined)    patch.expires_at = body.expiresAt
    if (body.isActive !== undefined)     patch.is_active = body.isActive

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 })
    }

    const { data: updated, error } = await supabase
      .from('qr_codes')
      .update(patch)
      .eq('id', id)
      .eq('brokerage_id', ctx.brokerageId)
      .select('id, slug, label, purpose, target_url, destination_type, listing_id, marketing_campaign_id, expires_at, scan_count, lead_count, is_active, created_at')
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
