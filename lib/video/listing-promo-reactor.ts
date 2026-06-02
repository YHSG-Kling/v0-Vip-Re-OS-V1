/**
 * lib/video/listing-promo-reactor.ts
 *
 * Auto-generated "Just Listed" social-format avatar video. Fires on
 * KernelEvent.LISTING_PUBLISHED from the kernel event-reactor. End-to-end
 * flow saves the agent from manually composing + posting every just-listed
 * announcement across FB / IG / LinkedIn:
 *
 *   1. Listing publishes → kernel reactor invokes this module.
 *   2. Ledger insert (m124) — partial unique index on (listing_id, event_type)
 *      makes the whole flow idempotent.
 *   3. Compose a script from listing facts (address, price, beds, baths, sqft,
 *      property_type). The facts are read from the listings table — the AI
 *      Gateway turns the structured facts into a 15-25 second script. No
 *      hallucinated facts; the prompt explicitly bans invented details.
 *   4. PRE-FLIGHT COMPLIANCE in broadcast shape: Brand voice (brokerage
 *      prohibited words, key messages), Fair Housing (state-specific via
 *      state_protected_classes — Florida etc.), Them-First. Per-contact
 *      gates skipped (this is a broadcast). On violations: ONE AI Gateway
 *      redraft with the violation list fed back. If redraft also fails,
 *      ledger marks 'failed' and we never spend D-ID render credit.
 *   5. ai_video_projects row with video_type='listing_promo',
 *      usage_intent='public_marketing', compliance_status='passed'.
 *   6. dispatchVideo (D-ID-first per getPlatformVideoProvider). The
 *      poll-did-videos cron picks up the queued render, downloads the
 *      finished mp4 to OUR Supabase storage (listing-media bucket), and
 *      writes the canonical video_url.
 *   7. The listing-promo-social-publish cron sweeps videos whose render has
 *      landed, drafts social_posts rows for FB / IG / LinkedIn (one per
 *      platform), and stamps ledger.status='social_drafted'.
 *   8. The publish-social-posts cron (existing) sends them when approved.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchVideo } from "@/lib/providers/dispatch"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"
import { evaluateOutbound } from "@/lib/kernel/compliance"

export type ListingPromoEventType = "just_listed" | "just_sold" | "price_changed"

export interface ListingPromoInput {
  brokerageId:  string
  listingId:    string
  /** users.id of the listing agent. Resolved from listings.agent_id (which
   *  on the live schema is already a users.id). */
  agentUserId:  string
  eventType:    ListingPromoEventType
}

export interface ListingPromoResult {
  ok:        boolean
  status:    "rendering" | "already_queued" | "skipped" | "failed"
  videoProjectId?: string
  ledgerId?: string
  reason?:   string
  violations?: string[]
}

interface ListingRow {
  id:            string
  brokerage_id:  string | null
  address:       string | null
  city:          string | null
  state:         string | null
  zip:           string | null
  list_price:    number | null
  bedrooms:      number | null
  bathrooms:     number | null
  sqft:          number | null
  property_type: string | null
  status:        string | null
  mls_number:    string | null
}

export async function dispatchListingPromoVideo(
  input: ListingPromoInput,
): Promise<ListingPromoResult> {
  const svc = createServiceClient()

  // 1. Load listing facts — these populate the script. The fact list is
  //    AUTHORITATIVE; the prompt instructs the model to use only these.
  const { data: listing } = await svc
    .from("listings")
    .select("id, brokerage_id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, property_type, status, mls_number")
    .eq("id", input.listingId)
    .maybeSingle()
  const l = listing as ListingRow | null
  if (!l) return { ok: false, status: "skipped", reason: "listing not found" }
  if (l.brokerage_id !== input.brokerageId) {
    return { ok: false, status: "skipped", reason: "tenant mismatch" }
  }

  // 2. Idempotency ledger
  const ledger = await svc
    .from("listing_promo_videos")
    .insert({
      brokerage_id: input.brokerageId,
      listing_id:   input.listingId,
      agent_id:     input.agentUserId,
      event_type:   input.eventType,
      status:       "queued",
    })
    .select("id")
    .maybeSingle()
  if (ledger.error) {
    if ((ledger.error as { code?: string }).code === "23505") {
      return { ok: true, status: "already_queued", reason: "duplicate event for this listing" }
    }
    return { ok: false, status: "failed", reason: `ledger insert: ${ledger.error.message}` }
  }
  const ledgerId = ledger.data?.id as string | undefined

  // 3. Agent voice/avatar gate — same as intro-video-reactor.
  const { data: profile } = await svc
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url")
    .eq("agent_id", input.agentUserId)
    .maybeSingle()
  if (!profile?.elevenlabs_voice_id || (!profile.did_photo_url && !profile.did_video_url)) {
    await svc.from("listing_promo_videos")
      .update({ status: "failed", error_message: "agent has no voice/avatar profile" })
      .eq("id", ledgerId!)
    return { ok: false, status: "failed", reason: "agent voice/avatar profile not configured" }
  }

  // 4. Draft script + pre-flight compliance (broadcast shape — no contact).
  const facts = buildFacts(l, input.eventType)
  let script: string
  try {
    script = await draftScript({ facts, eventType: input.eventType, violations: [] })
  } catch (err) {
    await svc.from("listing_promo_videos")
      .update({ status: "failed", error_message: `script: ${(err as Error).message}` })
      .eq("id", ledgerId!)
    return { ok: false, status: "failed", reason: "script generation failed" }
  }

  const compliance1 = await evaluateOutbound({
    actorContext: { brokerageId: input.brokerageId, userId: input.agentUserId, role: "system" },
    journeyType:  "seller",
    persona:      "other",
    messageType:  "social",
    content:      script,
    // broadcast shape — no per-contact gates
  })

  if (!compliance1.allowed) {
    try {
      script = await draftScript({ facts, eventType: input.eventType, violations: compliance1.violations })
    } catch (err) {
      await svc.from("listing_promo_videos")
        .update({ status: "failed", error_message: `redraft: ${(err as Error).message}` })
        .eq("id", ledgerId!)
      return { ok: false, status: "failed", reason: "script redraft failed" }
    }
    const compliance2 = await evaluateOutbound({
      actorContext: { brokerageId: input.brokerageId, userId: input.agentUserId, role: "system" },
      journeyType:  "seller",
      persona:      "other",
      messageType:  "social",
      content:      script,
    })
    if (!compliance2.allowed) {
      const reason = compliance2.violations.join("; ").slice(0, 800)
      await svc.from("listing_promo_videos")
        .update({ status: "failed", error_message: `compliance failed after redraft: ${reason}` })
        .eq("id", ledgerId!)
      return {
        ok:         false,
        status:     "failed",
        reason:     "compliance violations on both attempts",
        violations: compliance2.violations,
      }
    }
  }

  // 5. ai_video_projects row + dispatchVideo.
  const titleByEvent: Record<ListingPromoEventType, string> = {
    just_listed:    `Just Listed — ${l.address ?? "Property"}`,
    just_sold:      `Just Sold — ${l.address ?? "Property"}`,
    price_changed:  `Price Update — ${l.address ?? "Property"}`,
  }
  const { data: project, error: projErr } = await svc
    .from("ai_video_projects")
    .insert({
      brokerage_id:   input.brokerageId,
      agent_id:       input.agentUserId,
      listing_id:     input.listingId,
      title:          titleByEvent[input.eventType],
      script_content: script,
      video_type:     "listing_promo",
      status:         "queued",
      usage_intent:   "public_marketing",
      audience_type:  "customer_facing",
      duration_seconds: 25,
      compliance_status: "passed",
      compliance_evaluated_at: new Date().toISOString(),
      video_metadata: {
        promo_event_type: input.eventType,
        promo_ledger_id:  ledgerId,
        listing_address:  l.address,
        list_price:       l.list_price,
      },
    })
    .select("id")
    .single()
  if (projErr || !project) {
    await svc.from("listing_promo_videos")
      .update({ status: "failed", error_message: `ai_video_projects: ${projErr?.message}` })
      .eq("id", ledgerId!)
    return { ok: false, status: "failed", reason: "video project insert failed" }
  }

  await svc.from("listing_promo_videos")
    .update({ video_project_id: project.id, status: "rendering" })
    .eq("id", ledgerId!)

  const submission = await dispatchVideo({
    brokerageId:    input.brokerageId,
    userId:         input.agentUserId,
    templateId:     script,
    recipientEmail: "system@internal",
    scriptVars: {
      address:        l.address ?? "",
      list_price:     String(l.list_price ?? ""),
      bedrooms:       String(l.bedrooms ?? ""),
      bathrooms:      String(l.bathrooms ?? ""),
      sqft:           String(l.sqft ?? ""),
      property_type:  l.property_type ?? "",
      event_type:     input.eventType,
    },
    systemSource:   `listing_promo.${input.eventType}`,
    metadata: {
      ai_video_project_id: project.id,
      promo_ledger_id:     ledgerId,
    },
  })
  if (!submission.success) {
    await svc.from("listing_promo_videos")
      .update({ status: "failed", error_message: `dispatchVideo: ${submission.error}` })
      .eq("id", ledgerId!)
    return { ok: false, status: "failed", reason: submission.error ?? "dispatchVideo failed" }
  }

  await svc.from("lifecycle_events").insert({
    brokerage_id:  input.brokerageId,
    actor_user_id: input.agentUserId,
    event_type:    KernelEvent.VIDEO_GENERATION_REQUESTED,
    metadata: {
      promo_ledger_id:     ledgerId,
      ai_video_project_id: project.id,
      promo_event_type:    input.eventType,
    },
    entity_id:   project.id,
    entity_type: "ai_video_project",
    source:      "system",
    processed:   false,
  })

  return { ok: true, status: "rendering", videoProjectId: project.id, ledgerId }
}

// ─── Facts → script ─────────────────────────────────────────────────────────

interface ListingFacts {
  address:       string
  city_state:    string
  list_price:    string
  bedrooms:      string
  bathrooms:     string
  sqft:          string
  property_type: string
}

function buildFacts(l: ListingRow, _event: ListingPromoEventType): ListingFacts {
  const usd = (n: number | null) => n != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n) : ""
  return {
    address:       l.address ?? "",
    city_state:    [l.city, l.state].filter(Boolean).join(", "),
    list_price:    usd(l.list_price),
    bedrooms:      l.bedrooms != null ? String(l.bedrooms) : "",
    bathrooms:     l.bathrooms != null ? String(l.bathrooms) : "",
    sqft:          l.sqft != null ? l.sqft.toLocaleString("en-US") : "",
    property_type: l.property_type ?? "",
  }
}

async function draftScript(args: {
  facts:      ListingFacts
  eventType:  ListingPromoEventType
  violations: string[]
}): Promise<string> {
  const hookByEvent: Record<ListingPromoEventType, string> = {
    just_listed:    "Just listed",
    just_sold:      "Just sold",
    price_changed:  "Price update",
  }
  const violationLine = args.violations.length > 0
    ? `\n\nYour previous draft failed the compliance gate with these violations:\n- ${args.violations.join("\n- ")}\n\nRewrite so EVERY violation is resolved. Same length + same intent, just compliance-clean.`
    : ""
  const prompt = `Write a 15-25 second social-media video script for a real estate agent announcing "${hookByEvent[args.eventType]}".

Use ONLY these property facts — do not invent any number, feature, or claim:
- Address: ${args.facts.address || "(omitted)"}
- City/State: ${args.facts.city_state || "(omitted)"}
- Price: ${args.facts.list_price || "(omitted)"}
- Bedrooms: ${args.facts.bedrooms || "(omitted)"}
- Bathrooms: ${args.facts.bathrooms || "(omitted)"}
- Square feet: ${args.facts.sqft || "(omitted)"}
- Property type: ${args.facts.property_type || "(omitted)"}

Style:
- First-person, energetic but professional
- Lead with the hook + address
- 2-3 quick facts about the property
- Close with "DM me to schedule a tour" or equivalent
- 40-60 words total
- No exclamation marks
- AVOID any reference to protected characteristics (race, religion, family status, national origin, gender, sexual orientation, disability, source of income)
- AVOID phrases like "perfect for families", "great for empty-nesters", "ideal starter home for newlyweds" — these imply preference
- AVOID guaranteed-return / value-promise language
- Skip any fact that's "(omitted)"

Return ONLY the script text the agent will speak on camera.${violationLine}`

  const { text } = await generateTextRouted({
    feature:     "listing_promo_script",
    prompt,
    maxTokens:   220,
    temperature: 0.55,
  })
  return text.trim()
}
