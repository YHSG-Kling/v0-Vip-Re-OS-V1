/**
 * lib/direct-mail/listing-lifecycle-mail-reactor.ts
 *
 * Wave 36 — the direct-mail twin of lib/video/listing-promo-reactor.ts.
 * When a listing lifecycle event fires (LISTING_PUBLISHED →
 * 'just_listed', OPEN_HOUSE_SCHEDULED → 'open_house_announce',
 * LISTING_UNDER_CONTRACT → 'just_sold', LISTING_PRICE_REDUCED →
 * 'price_reduction', etc.), this reactor checks lifecycle_promo_
 * policy.mail_enabled for the scope, resolves the target audience,
 * and dispatches branded postcards through orchestrateRenderAndSend.
 *
 * Per-event recommendations baked in (subscriber's per-(scope, event)
 * row overrides):
 *
 *   just_listed         6x9 + property photo + status badge JUST LISTED
 *                       → farm (the agents' market footprint sees the
 *                         credibility piece)
 *   just_sold           6x9 + property photo + status badge JUST SOLD
 *                       → farm + sphere (credibility AND referral fuel)
 *   open_house_announce 6x9 + property photo + status badge OPEN HOUSE
 *                       → farm (RSVP push)
 *   open_house_reminder 4x6 (24h reminder, no photo — text-only)
 *                       → farm (only those who didn't RSVP yet)
 *   price_reduction     4x6 + property photo
 *                       → buyer searches matching the listing
 *   coming_soon         6x9 (early buzz — premium pre-launch piece)
 *                       → farm
 *
 * Per-event copy hooks the AI uses (woven via DirectMailCopyContext
 * .hookFacts.listingAddress + the topicHook is left empty so the
 * AI builds copy from the listing facts, not a bank topic).
 *
 * Same fall-through behavior as orchestrateRenderAndSend: on copy
 * gate failure or render error, the orchestrator drops to the
 * brokerage's fallback Lob template — the channel never goes dark.
 *
 * Idempotency: a direct_mail_campaigns row tagged
 * (target_audience='lifecycle:{event_type}', marketing_campaign_id=
 * <listing_id> as a sentinel) prevents the same event firing
 * postcards twice for the same listing.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { orchestrateRenderAndSend } from "@/lib/direct-mail/orchestrate-send"
import { resolveMailingAddressForContact } from "@/lib/contacts/resolve-mailing-address"
import type { LifecycleEventType } from "@/lib/kernel/lifecycle-promo-policy"
import type { Persona } from "@/lib/kernel/types"

export interface DispatchLifecycleMailArgs {
  brokerageId: string
  listingId:   string
  agentUserId: string
  eventType:   LifecycleEventType
}

export interface DispatchLifecycleMailResult {
  ok:           boolean
  event:        LifecycleEventType
  status:       "dispatched" | "skipped" | "already_sent" | "failed"
  reason?:      string
  recipientsConsidered?: number
  sent?:        number
  rendered?:    number
  failed?:      number
}

interface EventDefaults {
  /** Default size when policy row's mail_postcard_size is null. */
  size:        "4x6" | "6x9"
  statusBadge: string | null
  /** AI copy persona — drives prompt tone. Sellers' market events
   *  for the brokerage's farm, buyers' market events otherwise. */
  persona:     Persona
  /** Whether to include a property photo on the front. */
  withPhoto:   boolean
}

const EVENT_DEFAULTS: Record<LifecycleEventType, EventDefaults> = {
  coming_soon:         { size: "6x9", statusBadge: "COMING SOON", persona: "upsize",     withPhoto: true  },
  just_listed:         { size: "6x9", statusBadge: "JUST LISTED", persona: "upsize",     withPhoto: true  },
  open_house_announce: { size: "6x9", statusBadge: "OPEN HOUSE",  persona: "first_time", withPhoto: true  },
  open_house_reminder: { size: "4x6", statusBadge: "THIS WEEKEND", persona: "first_time", withPhoto: false },
  price_reduction:     { size: "4x6", statusBadge: "PRICE REDUCED", persona: "first_time", withPhoto: true  },
  under_contract:      { size: "4x6", statusBadge: "UNDER CONTRACT", persona: "upsize",   withPhoto: false },
  just_sold:           { size: "6x9", statusBadge: "JUST SOLD",   persona: "upsize",     withPhoto: true  },
}

const PER_BROKERAGE_HARD_CAP_PER_EVENT = 500

export async function dispatchLifecycleMail(
  args: DispatchLifecycleMailArgs,
): Promise<DispatchLifecycleMailResult> {
  const svc = createServiceClient()

  // 1. Resolve listing + agent + agent's team for the brand cascade.
  //    listings.team_id is the canonical source; agent.team_id is the
  //    fallback when the listing didn't capture team explicitly.
  const { data: listing } = await svc
    .from("listings")
    .select("id, brokerage_id, agent_id, team_id, address, city, state, zip, list_price")
    .eq("id", args.listingId)
    .maybeSingle()
  const l = listing as {
    id: string
    brokerage_id: string | null
    agent_id: string | null
    team_id: string | null
    address: string | null
    city: string | null
    state: string | null
    zip: string | null
    list_price: number | null
  } | null
  if (!l) return { ok: false, event: args.eventType, status: "failed", reason: "listing_not_found" }
  if (l.brokerage_id !== args.brokerageId) {
    return { ok: false, event: args.eventType, status: "failed", reason: "tenant_mismatch" }
  }

  // Hero photo precedence (Wave 36 m156):
  //   1. listing_photos.is_hero=true — explicit agent pick
  //   2. listing_photos.order_index=0 — MLS default
  //   3. null → composition falls back to brand-color gradient
  // Two parallel queries; pick the first non-null.
  const [heroFlagged, mlsFirst] = await Promise.all([
    svc.from("listing_photos")
      .select("photo_url")
      .eq("listing_id", args.listingId)
      .eq("is_hero", true)
      .limit(1)
      .maybeSingle(),
    svc.from("listing_photos")
      .select("photo_url")
      .eq("listing_id", args.listingId)
      .order("order_index", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])
  const propertyPhotoUrl =
    ((heroFlagged.data?.photo_url as string | undefined) ??
     (mlsFirst.data?.photo_url as string | undefined) ??
     null)

  // Agent team_id for brand cascade — listings.team_id first, agent's
  // own team_id as fallback for older listings without it set.
  const { data: agentRow } = await svc
    .from("agents")
    .select("id, team_id")
    .eq("user_id", args.agentUserId)
    .maybeSingle()
  const agentTeamId: string | null =
    l.team_id ?? (agentRow?.team_id as string | undefined) ?? null
  const agentId:     string | null = (agentRow?.id as string | undefined) ?? null

  // 2. Idempotency — same (listing, event_type) doesn't double-fire.
  const { count: prior } = await svc
    .from("direct_mail_campaigns")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", args.brokerageId)
    .eq("target_audience", `lifecycle:${args.eventType}`)
    .eq("marketing_campaign_id", args.listingId)
  if ((prior ?? 0) > 0) {
    return { ok: true, event: args.eventType, status: "already_sent" }
  }

  // 3. Read the per-(scope, event_type) policy. Cascade scope:
  //    agent → team → brokerage → platform default.
  type PolicyRow = {
    mail_enabled: boolean | null
    mail_postcard_size: string | null
    mail_template_id: string | null
    mail_target_audience: string | null
    mail_max_recipients: number | null
  }
  const scopeIds = [
    agentId ? { type: "agent", id: agentId } : null,
    agentTeamId ? { type: "team", id: agentTeamId } : null,
    { type: "brokerage", id: args.brokerageId },
  ].filter((s): s is { type: string; id: string } => s !== null)

  let policy: PolicyRow | null = null
  for (const s of scopeIds) {
    const { data } = await svc
      .from("lifecycle_promo_policy")
      .select("mail_enabled, mail_postcard_size, mail_template_id, mail_target_audience, mail_max_recipients")
      .eq("scope_type", s.type)
      .eq("scope_id",   s.id)
      .eq("event_type", args.eventType)
      .maybeSingle()
    if (data) {
      policy = data as PolicyRow
      break
    }
  }
  if (!policy?.mail_enabled) {
    return { ok: true, event: args.eventType, status: "skipped", reason: "mail_not_enabled_for_scope" }
  }

  const defaults = EVENT_DEFAULTS[args.eventType]
  const size = (policy.mail_postcard_size as "4x6" | "6x9" | null) ?? defaults.size
  const audience = (policy.mail_target_audience ?? "farm") as "farm" | "sphere" | "farm+sphere"
  const cap = Math.min(
    policy.mail_max_recipients ?? 100,
    PER_BROKERAGE_HARD_CAP_PER_EVENT,
  )

  // 4. Build the recipient list per audience.
  const recipientIds = new Set<string>()
  if (audience === "farm" || audience === "farm+sphere") {
    // Pull the agent's farm zips → contacts in those zips.
    if (agentId) {
      const { data: territories } = await svc
        .from("farm_territories")
        .select("zip_codes")
        .eq("agent_id", agentId)
        .eq("brokerage_id", args.brokerageId)
        .eq("is_active", true)
      const zips = new Set<string>()
      for (const t of (territories ?? []) as Array<{ zip_codes: string[] | null }>) {
        for (const z of t.zip_codes ?? []) if (z) zips.add(z)
      }
      if (zips.size > 0) {
        const { data: farmContacts } = await svc
          .from("contacts")
          .select("id")
          .eq("brokerage_id", args.brokerageId)
          .eq("mailing_address_verified", true)
          .in("zip_code", [...zips])
          .neq("dnc_status", true)
          .neq("direct_mail_opt_out", true)
          .limit(cap)
        for (const c of (farmContacts ?? []) as Array<{ id: string }>) {
          recipientIds.add(c.id)
        }
      }
    }
  }
  if (audience === "sphere" || audience === "farm+sphere") {
    // Sphere = contacts the agent has touched in the last 12 months.
    const sphereCutoff = new Date(Date.now() - 365 * 86_400_000).toISOString()
    const { data: sphereContacts } = await svc
      .from("contacts")
      .select("id, last_contacted_at")
      .eq("brokerage_id", args.brokerageId)
      .eq("agent_id", args.agentUserId)
      .eq("mailing_address_verified", true)
      .gte("last_contacted_at", sphereCutoff)
      .neq("dnc_status", true)
      .neq("direct_mail_opt_out", true)
      .limit(cap)
    for (const c of (sphereContacts ?? []) as Array<{ id: string }>) {
      recipientIds.add(c.id)
    }
  }

  const recipientList = [...recipientIds].slice(0, cap)
  if (recipientList.length === 0) {
    return { ok: true, event: args.eventType, status: "skipped", reason: "no_eligible_recipients" }
  }

  // 5. Get the brokerage's Lob fallback template.
  const { data: brokerageRow } = await svc
    .from("brokerages")
    .select("lob_fallback_template_id")
    .eq("id", args.brokerageId)
    .maybeSingle()
  const fallbackTpl = policy.mail_template_id
    ?? (brokerageRow?.lob_fallback_template_id as string | null)
    ?? ""
  if (!fallbackTpl) {
    return { ok: true, event: args.eventType, status: "skipped", reason: "no_fallback_template_configured" }
  }

  // 6. Dispatch one piece per recipient via the orchestrator. Per-piece
  //    Fair Housing gate + de-conflict + Lob spend still all apply.
  const propertyAddress = [l.address, l.city, l.state].filter(Boolean).join(", ")
  let sent = 0, rendered = 0, failed = 0
  for (const contactId of recipientList) {
    const addr = await resolveMailingAddressForContact({ contactId, brokerageId: args.brokerageId })
    if (!addr) { failed++; continue }
    const { data: c } = await svc
      .from("contacts")
      .select("first_name, last_name")
      .eq("id", contactId)
      .maybeSingle()
    const name = [c?.first_name, c?.last_name].filter(Boolean).join(" ") || "Neighbor"

    const result = await orchestrateRenderAndSend({
      brokerageId: args.brokerageId,
      contactId,
      userId:      args.agentUserId,
      agentId:     agentId ?? undefined,
      recipientName:  name,
      mailingAddress: addr.street,
      city:           addr.city,
      state:          addr.state,
      zip:            addr.zip,
      pieceType:      "postcard",
      postcardSize:   size,
      propertyPhotoUrl: defaults.withPhoto ? propertyPhotoUrl : null,
      statusBadge:    defaults.statusBadge,
      copyCtx: {
        brokerageId: args.brokerageId,
        teamId:      agentTeamId,
        agentUserId: args.agentUserId,
        contactId,
        persona:     defaults.persona,
        qrDestinationType: args.eventType === "open_house_announce" || args.eventType === "open_house_reminder"
          ? "book_meeting"
          : "listing_detail",
        hookFacts: {
          listingAddress: propertyAddress || undefined,
        },
      },
      fallbackTemplateId: fallbackTpl,
      systemSource:       `lifecycle:${args.eventType}`,
    })

    if (result.success) sent++
    else failed++
    if (result.rendered) rendered++

    // Log the campaign with the sentinel that makes the idempotency
    // check work for the NEXT firing.
    await svc.from("direct_mail_campaigns").insert({
      brokerage_id:        args.brokerageId,
      agent_id:            args.agentUserId,
      contact_id:          contactId,
      marketing_campaign_id: args.listingId,
      campaign_name:       `Lifecycle ${args.eventType} - ${propertyAddress.slice(0, 60)}`,
      target_audience:     `lifecycle:${args.eventType}`,
      quantity:            1,
      status:              result.success ? "sent" : "failed",
      piece_type:          "postcard",
      lob_order_id:        result.messageId ?? null,
      mailing_date:        result.success ? new Date().toISOString().slice(0, 10) : null,
      pieces_mailed:       result.success ? 1 : 0,
      is_ai_generated:     true,
      approval_status:     result.rendered ? "auto_approved" : "fell_back",
      variant_id:          result.variantPick?.variantId ?? null,
      compliance_event_id: result.complianceEventId ?? null,
      created_at:          new Date().toISOString(),
    })
  }

  return {
    ok: true,
    event: args.eventType,
    status: sent > 0 ? "dispatched" : (failed > 0 ? "failed" : "skipped"),
    recipientsConsidered: recipientList.length,
    sent,
    rendered,
    failed,
  }
}
