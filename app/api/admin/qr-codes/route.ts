import { NextRequest, NextResponse } from 'next/server'
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from '@/lib/supabase/service'
import { resolveWriteContext } from '@/lib/platform/acting-context'
import { QR_DESTINATION_TYPES, isQrPurpose, isQrDestinationType, type QrPurpose, type QrDestinationType } from '@/lib/marketing/tracked-qr'
import { qrInAppDefaultPath, type QrTokenScope, type QrConsentContext } from '@/lib/marketing/qr-contract'
// WAVE 152 (lane 152C): the GOVERNED doors — a mint is unique per idempotency key with ledger evidence and a safe
// destination; a destination edit is versioned; pause / resume go through the one lifecycle table.
import { mintGovernedQr, editQrDestination, changeQrLifecycle, type QrActor } from '@/lib/marketing/qr-governance'

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
      /** WAVE 152 (152C) — the request's idempotency key (the board draws one per create form; a retry re-sends it). */
      idempotencyKey?: string
      tokenScope?: QrTokenScope
      placement?: string
      mailLayout?: string
      channel?: string
      source?: string
      teamId?: string
      locationId?: string
      printSizeIn?: number
      trackingEnabled?: boolean
      consentContext?: QrConsentContext
      purposeContext?: string
      assetId?: string
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

    // TOMBSTONE (wave 152, 152C): the campaign-ownership read that lived here moved INTO the governed mint
    // (lib/marketing/qr-governance.ts mintGovernedQr — campaign AND listing, both under the session's brokerage),
    // so every governed door checks it, not only this one. SURVIVOR: mintGovernedQr.

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

    // WAVE 152 (152C): THE GOVERNED MINT. The tenant and the creator come from the SESSION (ctx); the
    // idempotency key makes a retried click return the SAME code; the destination is validated (https,
    // verified tenant hosts + the external allow-list, no loop, no personal data); the mint is ledgered.
    const actor: QrActor = { brokerageId: ctx.brokerageId, userId: ctx.userId, agentId: (agentId as string | null) ?? null, userType: ctx.userType }
    const minted = await mintGovernedQr({
      idempotencyKey: (body.idempotencyKey ?? '').trim(),
      label,
      purpose: (isQrPurpose(purpose) ? purpose : 'general') as QrPurpose,
      destinationType: isQrDestinationType(destinationType) ? (destinationType as QrDestinationType) : null,
      targetUrl: resolvedUrl,
      listingId: listingId ?? null,
      marketingCampaignId: body.marketingCampaignId ?? null,
      expiresAt: body.expiresAt ?? null,
      teamId: body.teamId ?? null,
      locationId: body.locationId ?? null,
      channel: body.channel ?? null,
      source: body.source ?? null,
      placement: body.placement ?? null,
      mailLayout: body.mailLayout ?? null,
      assetId: body.assetId ?? null,
      purposeContext: body.purposeContext ?? null,
      consentContext: body.consentContext ?? null,
      tokenScope: body.tokenScope,
      printSizeIn: typeof body.printSizeIn === 'number' ? body.printSizeIn : null,
      trackingEnabled: body.trackingEnabled !== false,
    }, actor, { client: supabase, origin, appOrigins: [origin, new URL(req.url).origin] })

    if (!minted.ok) {
      const status = minted.code === 'not_permitted' ? 403 : minted.code === 'in_flight' ? 409 : minted.code === 'refused' ? 503 : 400
      return NextResponse.json({ success: false, error: minted.message }, { status })
    }

    const { data: qrCode, error } = await supabase
      .from('qr_codes')
      .select('id, slug, label, purpose, target_url, destination_type, listing_id, marketing_campaign_id, expires_at, scan_count, lead_count, is_active, created_at')
      .eq('id', minted.code.id)
      .eq('brokerage_id', ctx.brokerageId)
      .single()

    if (error || !qrCode) {
      return NextResponse.json({ success: false, error: 'The code was created, but it could not be read back. Reload the page to see it.' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      qrCode,
      scanUrl: minted.code.scanUrl,
      qrImageDataUrl: minted.code.imageDataUrl,
      created: !minted.replayed,
      replayed: minted.replayed,
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
      /** WAVE 152 (152C): why the destination changed — kept on the new version and the ledger row. */
      reason?: string
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

    // WAVE 152 (152C): THREE KINDS OF CHANGE, THREE DOORS. TOMBSTONE: this handler wrote
    // `target_url`, `destination_type` and `is_active` in one raw UPDATE — any URL (http,
    // `javascript:`, another tenant's tracking link, a page carrying a phone number), no
    // version kept, no evidence. SURVIVORS (lib/marketing/qr-governance.ts): the destination
    // → editQrDestination (validated, versioned, ledgered); pause/resume → changeQrLifecycle
    // (the one transition table; a retired code never resumes). Only the board's own
    // metadata (name, purpose, end date) is a plain tenant-scoped update here.
    const actor: QrActor = { brokerageId: ctx.brokerageId, userId: ctx.userId, agentId: ctx.agentId ?? null, userType: ctx.userType }
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin
    const notices: string[] = []

    if (body.targetUrl !== undefined || body.destinationType !== undefined) {
      const { data: current, error: curErr } = await supabase.from('qr_codes').select('target_url').eq('id', id).eq('brokerage_id', ctx.brokerageId).maybeSingle()
      if (curErr || !current) return NextResponse.json({ success: false, error: curErr ? 'We couldn\'t load this code. Nothing was changed.' : 'Not found' }, { status: curErr ? 503 : 404 })
      const nextType = body.destinationType === undefined ? undefined : (isQrDestinationType(body.destinationType) ? body.destinationType : null)
      const edit = await editQrDestination(
        { qrCodeId: id, targetUrl: body.targetUrl !== undefined ? body.targetUrl : (current as { target_url: string }).target_url, destinationType: nextType, reason: body.reason ?? null },
        actor,
        { client: supabase, origin, appOrigins: [origin, new URL(req.url).origin] },
      )
      if (!edit.ok) {
        const status = edit.code === 'not_found' ? 404 : edit.code === 'conflict' || edit.code === 'in_flight' ? 409 : edit.code === 'refused' || edit.code === 'unavailable' ? 503 : 400
        return NextResponse.json({ success: false, error: edit.message }, { status })
      }
      if (!edit.unchanged) notices.push(`Destination saved as version ${edit.history[edit.history.length - 1]?.version ?? 1}; printed copies follow it on their next scan.`)
    }

    if (body.isActive !== undefined) {
      const life = await changeQrLifecycle({ qrCodeId: id, action: body.isActive ? 'resume' : 'pause' }, actor, { client: supabase })
      if (!life.ok) {
        return NextResponse.json({ success: false, error: life.message }, { status: life.code === 'not_found' ? 404 : life.code === 'terminal' ? 409 : 400 })
      }
    }

    // Metadata only — only the fields the caller specified (partial PATCH semantics).
    const patch: Record<string, unknown> = {}
    if (body.label !== undefined)        patch.label = body.label.trim()
    if (body.purpose !== undefined)      patch.purpose = body.purpose
    if (body.expiresAt !== undefined)    patch.expires_at = body.expiresAt

    if (Object.keys(patch).length > 0) {
      const { data: written, error: metaErr } = await supabase
        .from('qr_codes')
        .update(patch)
        .eq('id', id)
        .eq('brokerage_id', ctx.brokerageId)
        .select('id')
      if (metaErr) return NextResponse.json({ success: false, error: 'The name, purpose or end date wasn\'t saved. Try again in a moment.' }, { status: 503 })
      if (!Array.isArray(written) || written.length !== 1) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    } else if (body.targetUrl === undefined && body.destinationType === undefined && body.isActive === undefined) {
      return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 })
    }

    const { data: updated, error } = await supabase
      .from('qr_codes')
      .select('id, slug, label, purpose, target_url, destination_type, listing_id, marketing_campaign_id, expires_at, scan_count, lead_count, is_active, created_at')
      .eq('id', id)
      .eq('brokerage_id', ctx.brokerageId)
      .single()
    if (error || !updated) {
      return NextResponse.json({ success: false, error: 'The change was saved, but the code could not be read back. Reload the page to see it.' }, { status: 500 })
    }
    return NextResponse.json({ success: true, qrCode: updated, notices })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

// Imported at the foot (lane 93A) so the file:line references other files hold into this one stay true (ES imports hoist).
import { decideClaimedTenant } from "@/lib/platform/acting-context"
