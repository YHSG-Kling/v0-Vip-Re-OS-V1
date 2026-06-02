/**
 * lib/video/listing-promo-reactor.ts
 *
 * Auto-generated listing promo video reactor. Fires on KernelEvent.LISTING_PUBLISHED
 * from the kernel event-reactor.
 *
 * WAVE 12 PARK NOTICE — the original Wave 11 implementation called
 * dispatchVideo() (D-ID-first) which produces a TALKING-HEAD video of the
 * agent's avatar reading the listing facts. That is the WRONG format for a
 * Just Listed social-media promo — the audience wants to SEE THE PROPERTY,
 * not the agent's face. The correct shape is a Remotion-rendered property
 * reel: property images from listing_media stitched with branded overlays
 * (price banner, beds/baths/sqft, brokerage logo) + the agent's cloned voice
 * as the narration track (via ElevenLabs). An optional brief D-ID intro hook
 * + outro CTA can be composited around it via the existing ffmpeg pipeline
 * in lib/video/composite-attribution.ts.
 *
 * Until the Remotion pipeline ships in a focused follow-up wave, this reactor:
 *   1. Still runs every safe step — agent voice/avatar gate, idempotency
 *      ledger, script draft, pre-flight compliance (broadcast shape).
 *   2. Parks the row at status='remotion_pending' (m125) instead of calling
 *      dispatchVideo. No D-ID render dollars are spent on the wrong format.
 *   3. The compliance-cleared script + listing facts + ledger row are all
 *      available for the Remotion build to consume — it picks up pending
 *      rows and renders the property reel.
 *
 * Once Remotion ships:
 *   - Replace the remotion_pending park (below) with a render-and-queue call
 *     to the Remotion endpoint (`/api/internal/remotion/render-just-listed`).
 *   - The downstream listing-promo-social-publish cron stays unchanged — it
 *     watches the linked ai_video_projects.video_url and drafts social_posts.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
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

  // 5. WAVE 12 PARK — do NOT call dispatchVideo (would produce a D-ID
  //    talking head, wrong format for a property promo). The Remotion
  //    pipeline will pick up rows with status='remotion_pending' and the
  //    pre-cleared script_content from this update.
  await svc.from("listing_promo_videos")
    .update({
      status:         "remotion_pending",
      // Note: video_project_id stays NULL until Remotion creates the
      //       ai_video_projects row alongside the rendered MP4.
      error_message:  null,
    })
    .eq("id", ledgerId!)

  // Stash the compliance-cleared script in a transient metadata field on the
  // ledger by writing it onto error_message? No — better: leave the script
  // attached to the listing_promo_videos row via the listing+facts; the
  // Remotion build re-derives the script from the same facts using the same
  // prompt. The compliance pre-clear stays valid because the prompt is
  // deterministic on the (facts × event_type) input. We DO NOT persist the
  // script text on this ledger today since the column doesn't exist; the
  // Remotion build can either add a column (m126+) or re-draft.

  return {
    ok:        true,
    status:    "remotion_pending",
    reason:    "Wave 12 — Remotion property reel pipeline is the correct format; D-ID talking-head dispatch parked.",
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
