/**
 * lib/video/listing-promo-reactor.ts
 *
 * Auto-generated listing promo video reactor. Fires on KernelEvent.LISTING_PUBLISHED
 * from the kernel event-reactor.
 *
 * WAVE 14 — Remotion + D-ID hybrid pipeline. The reactor stages the row at
 * status='remotion_pending' (after pre-flight compliance) and the
 * /api/cron/listing-promo-render cron drains those rows by POSTing to the
 * internal Remotion render endpoint. Decoupling the kickoff lets the kernel
 * event-reactor return fast (no 90s render blocking) and gives us natural
 * retry semantics — a failed render leaves the row at remotion_pending and
 * the next tick picks it up.
 *
 * End-to-end flow once a listing publishes:
 *
 *   LISTING_PUBLISHED
 *     → kernel reactor invokes this module
 *     → contacts.video_opt_out (n/a for listings) + agent_voice_profile gate
 *     → idempotency ledger insert (m124, partial unique on listing × event)
 *     → AI Gateway drafts the narration script
 *     → pre-flight evaluateOutbound (broadcast shape — Brand voice + Fair
 *       Housing state-specific + Them-First; ONE redraft on violation)
 *     → status='remotion_pending' (this file ends here)
 *
 *   /api/cron/listing-promo-render every 5 min
 *     → claims the oldest remotion_pending row
 *     → POSTs to /api/internal/remotion/render-just-listed
 *         · re-resolves listing facts + brand + agent voice id
 *         · re-runs compliance against the freshly-drafted script
 *         · synthesizes ElevenLabs voiceover → Supabase blob URL
 *         · Remotion render (1080×1920, 25s, @ 30fps) → Supabase blob URL
 *         · creates ai_video_projects row with compliance_status='passed'
 *         · submits D-ID intro hook + outro CTA renders via dispatchVideo
 *         · status='generating' until both D-ID renders land
 *
 *   poll-did-videos every 2 min (existing)
 *     → downloads each D-ID render to OUR Supabase storage
 *     → updates the linked ai_video_projects rows
 *
 *   /api/cron/listing-promo-hybrid-composite every 2 min
 *     → detects projects with all 3 components ready (Remotion + intro + outro)
 *     → ffmpeg concatIntroOutro from lib/video/composite-attribution.ts
 *     → uploads stitched mp4 → updates ai_video_projects.video_url
 *     → status='completed', listing_promo_videos.status='rendering'
 *
 *   /api/cron/listing-promo-social-publish every 2 min (Wave 11+)
 *     → drafts social_posts rows for FB / IG / LinkedIn / Twitter / TikTok /
 *       YouTube / Pinterest / Google Business with per-platform captions
 *     → existing publish-social-posts cron sends once approved
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"

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
  status:    "rendering" | "remotion_pending" | "already_queued" | "skipped" | "failed"
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
    const result = await runWithComplianceRedraft({
      draft: ({ violations }) => draftScript({ facts, eventType: input.eventType, violations }),
      gate: async (s) => {
        const r = await evaluateOutbound({
          actorContext: { brokerageId: input.brokerageId, userId: input.agentUserId, role: "system" },
          journeyType:  "seller",
          persona:      "other",
          messageType:  "social",
          content:      s,
          // broadcast shape — no per-contact gates
        })
        return { allowed: r.allowed, violations: r.violations }
      },
    })
    if (!result.ok) {
      const reason = result.violations.join("; ").slice(0, 800)
      await svc.from("listing_promo_videos")
        .update({ status: "failed", error_message: `compliance failed after redraft: ${reason}` })
        .eq("id", ledgerId!)
      return {
        ok:         false,
        status:     "failed",
        reason:     "compliance violations on both attempts",
        violations: result.violations,
      }
    }
    script = result.script
  } catch (err) {
    await svc.from("listing_promo_videos")
      .update({ status: "failed", error_message: `script: ${(err as Error).message}` })
      .eq("id", ledgerId!)
    return { ok: false, status: "failed", reason: "script generation failed" }
  }

  // 5. Stage at status='remotion_pending'. The Wave 14 render cron drains
  //    these rows by POSTing to /api/internal/remotion/render-just-listed.
  //    The render endpoint re-resolves facts + re-runs compliance against
  //    the freshly-drafted script (deterministic on facts × event_type) so
  //    the pre-clear we just did is the FAST-FAIL guard — a script that
  //    fails compliance here never reaches the cron + render dollars are
  //    never spent on it.
  await svc.from("listing_promo_videos")
    .update({
      status:         "remotion_pending",
      error_message:  null,
    })
    .eq("id", ledgerId!)

  return {
    ok:        true,
    status:    "remotion_pending",
    reason:    "Staged for Remotion + ElevenLabs + (hybrid) D-ID intro/outro pipeline; the listing-promo-render cron picks this up within 5 minutes.",
    ledgerId,
  }
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
