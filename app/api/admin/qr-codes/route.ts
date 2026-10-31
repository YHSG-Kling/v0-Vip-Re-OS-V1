import { NextRequest, NextResponse } from 'next/server'
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from '@/lib/supabase/service'
import { resolveWriteContext } from '@/lib/platform/acting-context'
import { mintTrackedQr, QR_DESTINATION_TYPES, isQrPurpose } from '@/lib/marketing/tracked-qr'
import { qrInAppDefaultPath } from '@/lib/marketing/qr-contract'

export const dynamic = 'force-dynamic'

/** Wave 36 — canonical destination types match m148 CHECK constraint
 *  on qr_codes.destination_type. Sourced from the one QR minter so this route
 *  and the writer can never disagree about the live vocabulary. */
const VALID_DESTINATION_TYPES = new Set<string>(QR_DESTINATION_TYPES)

// TOMBSTONE (wave 141F): this route's own default-URL table (`defaultUrlForDestination`)
// is gone. It pointed landing_page at `/qr/<slug>/landing`, cma_form at `/forms/cma` and
// book_meeting at `/book` — none of which is a route in this app — so every manually
// created code of those three types was printed with a destination that 404s. The ONE
// table is lib/marketing/qr-contract.ts qrInAppDefaultPath (shared with the marketing
// material minter); `landing_page` needs no default at all because the minter already
// points a code with no target at its own /qr/<slug> landing.

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
    if (!decideClaimedTenant({ actingBrokerageId: ctx.brokerageId, claimedBrokerageId: brokerageId }).ok) { // The claimed-tenant rule is the ONE decision table (lane 93A, §6) — not a hand-rolled copy.
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

    // qr_codes.agent_id FKs agents(id); tolerate callers already sending agents.id, else the session's.
    const agentId = agentUserId
      ? ((await resolveAgentId(supabase as any, agentUserId)) ?? agentUserId)
      : ctx.agentId

    // Explicit target_url wins. Otherwise the ONE in-app default table (qr-contract.ts): the
    // home-value funnel and the agent's public profile are keyed by the minting agent's own
    // public slug (agents.public_slug — the column app/home-value/[agentSlug] and app/p/[agentSlug]
    // resolve), read under the SESSION's brokerage. A type with no app-hosted default and no
    // URL is refused — except the two that legitimately land on the code's OWN capture page
    // (landing_page, and book_meeting with neither a listing nor a public profile), which the
    // minter points at /qr/<slug> itself once the slug exists.
    let resolvedUrl: string | null = (targetUrl ?? '').trim() || null
    if (!resolvedUrl && destinationType) {
      let agentSlug: string | null = null
      if ((destinationType === 'cma_form' || destinationType === 'book_meeting') && agentId) {
        const { data: agentRow, error: agentSlugError } = await supabase
          .from('agents')
          .select('public_slug')
          .eq('id', agentId)
          .eq('brokerage_id', ctx.brokerageId)
          .maybeSingle()
        if (agentSlugError) {
          console.error('[admin/qr-codes] agent public_slug read refused:', agentSlugError.message)
        }
        agentSlug = (agentRow as { public_slug?: string | null } | null)?.public_slug ?? null
      }
      const defaultPath = qrInAppDefaultPath({ destinationType, listingId: listingId ?? null, agentSlug })
      if (defaultPath) resolvedUrl = `${origin}${defaultPath}`
    }
    const landsOnOwnPage = !resolvedUrl && (destinationType === 'landing_page' || destinationType === 'book_meeting')
    if (!resolvedUrl && !landsOnOwnPage) {
      return NextResponse.json({
        success: false,
        error: destinationType === 'listing_detail'
          ? 'Listing detail needs the listing id (or an explicit target URL).'
          : 'target_url is required (no app-hosted default exists for this destination type — provide a URL explicitly).',
      }, { status: 400 })
    }

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
 * NOTE ON target_url (wave 141F): editing it NOW reroutes every printed copy on its next scan.
 * app/api/qr/scan reads target_url fresh per scan and sends the scanner through the one
 * allow-list resolver (lib/marketing/qr-contract.ts resolveQrScanDestination): an in-app public
 * path is redirected to directly; an https host we do not own is offered on the landing page as
 * a tap-through link, never auto-followed. (Until this wave the handler never read target_url
 * and every scan landed on the generic /qr/<slug> form — the board's claim was false then.)
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

// Imported at the foot (lane 93A) so the file:line references other files hold into this one stay true (ES imports hoist).
import { decideClaimedTenant } from "@/lib/platform/acting-context"
