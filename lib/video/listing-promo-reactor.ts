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
 *         · REUSES the gated script persisted at step 4c (re-fitting it to the
 *           composition budget + re-running the rule-based gate on the exact
 *           text it speaks — zero model calls; re-drafts only as fallback)
 *         · synthesizes ElevenLabs voiceover → Supabase blob URL
 *         · Remotion render (1080×1920, 25s, @ 30fps) → Supabase blob URL
 *         · UPDATES the staged ai_video_projects row (compliance_status='passed')
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
import { resolveLifecycleAutoSpawn, isWithinCooldown, type LifecycleEventType } from "@/lib/kernel/lifecycle-promo-policy"
// ── SCRIPT LENGTH IS DERIVED, NEVER TYPED (§6) ───────────────────────────────
// promoNarrationBudget is the ONE answer to "how long may this event's script
// be", and it derives from the composition the event actually renders on
// (lib/video/promo-composition.ts:136 → composition-geometry → script-structure
// WORDS_PER_MINUTE / NARRATION_HEADROOM). See the TOMBSTONE on EventTemplate.
import { promoNarrationBudget, promoEventLabel } from "@/lib/video/promo-composition"
import {
  fitNarrationToBudget,
  narrationLengthDirective,
  narrationMaxTokens,
} from "@/lib/video/script-structure"

// Wave 27 — extended from 3 event types to the full 7-moment listing
// lifecycle. The reactor remains the single dispatcher; per-event branches
// live in draftScript (hook + tone) and buildFacts (context hints —
// e.g. open_house_announce gets the event date pulled in).
export type ListingPromoEventType = LifecycleEventType

export interface ListingPromoInput {
  brokerageId:  string
  listingId:    string
  /** The listing agent. Callers may pass EITHER an agents.id (what
   *  listings.agent_id actually holds) or a users.id; dispatchListingPromoVideo
   *  normalises to both classes before use and writes the agents.id. */
  agentUserId:  string
  eventType:    ListingPromoEventType
  /** Wave 27 — when true, skip the lifecycle_promo_policy auto_spawn check
   *  (cooldown still applies). Set by the manual-trigger action when an
   *  agent explicitly requests a promo for an opted-out event type. */
  bypassPolicy?: boolean
  /** Wave 27 — optional event-specific context the script template can
   *  weave in. For open_house_announce/reminder this carries the event
   *  date+time. For just_sold it can carry the sale price (when the agent
   *  consents to disclosure). Schema-flexible; the template only reads
   *  fields it cares about. */
  eventContext?: Record<string, unknown>
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

  // ── ID-CLASS NORMALISATION (resolve-or-keep) ───────────────────────────────
  //
  // The 13 call sites are split: most feed listings.agent_id (an agents.id)
  // straight through, some pass a genuine users.id. Normalising HERE covers all
  // of them with one seam. Both classes are needed downstream — the users.id for
  // the policy resolver and the compliance actor context, the agents.id for
  // listing_promo_videos.agent_id and agent_voice_profiles.agent_id.
  let agentUserId = input.agentUserId
  if (agentUserId) {
    const { data: agentRow } = await svc
      .from("agents")
      .select("user_id")
      .eq("id", agentUserId)
      .maybeSingle()
    if (agentRow?.user_id) agentUserId = agentRow.user_id as string
  }

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

  // 1b. Wave 27 — policy + cooldown gate. The lifecycle-promo-policy
  //     resolver walks agent → team → brokerage → platform_default for
  //     the (event_type, scope) pair. If the resolved decision is
  //     auto_spawn=false, the reactor exits with status='skipped' and
  //     the manual-trigger action stays the only path to fire this promo
  //     for this subscriber. Cooldown gates rapid-fire events (a listing
  //     whose price is edited three times in a day → one price_reduction).
  //
  //     This gate is only consulted on automatic reactor invocations.
  //     The manual-trigger action sets a `bypassPolicy: true` flag so
  //     an agent who explicitly clicks "Generate promo" gets it even
  //     when the policy is opted-out. (Cooldown still applies — manual
  //     clicks during a 24h window still debounce.)
  if (!input.bypassPolicy) {
    const policy = await resolveLifecycleAutoSpawn(
      { agentUserId, brokerageId: input.brokerageId },
      input.eventType,
    )
    if (!policy.autoSpawn) {
      return { ok: true, status: "skipped", reason: `policy_opt_out:${policy.resolvedFrom}` }
    }
    if (policy.cooldownHours && policy.cooldownHours > 0) {
      const blocked = await isWithinCooldown({
        listingId:     input.listingId,
        eventType:     input.eventType,
        cooldownHours: policy.cooldownHours,
      })
      if (blocked) {
        return { ok: true, status: "skipped", reason: `cooldown:${policy.cooldownHours}h` }
      }
    }
  }

  // 2. Idempotency ledger. Server-only resolver: this module is already
  //    "server-only" reactor code and the mapping is re-read on every lifecycle
  //    event a listing throws, which is what its cache is for.
  //    listing_promo_videos.agent_id is NOT NULL, so an unresolvable agent means
  //    the promo cannot be recorded at all — refuse loudly rather than stage a
  //    row the FK will reject. Nothing is watching this reactor.
  const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
  const agentRecordId = await resolveUserIdToAgentRecord(agentUserId, input.brokerageId)
  if (!agentRecordId) {
    console.error(
      `[listing-promo] no agent profile for users.id=${agentUserId} in brokerage=${input.brokerageId}` +
      ` — listing=${input.listingId} event=${input.eventType} promo not staged`,
    )
    return { ok: false, status: "failed", reason: "no agent profile for this user in this brokerage" }
  }

  const ledger = await svc
    .from("listing_promo_videos")
    .insert({
      brokerage_id: input.brokerageId,
      listing_id:   input.listingId,
      agent_id:     agentRecordId,
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

  // 3. Agent voice/avatar gate — same agents.id resolved above.
  const { data: profile } = await svc
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url")
    .eq("agent_id", agentRecordId)
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
      draft: ({ violations }) => draftScript({
        facts, eventType: input.eventType, eventContext: input.eventContext, violations,
        // §4 — `input.brokerageId` is this reactor run's tenant and the listing
        // was checked against it at :141; agentUserId is resolved, not supplied.
        brokerageId: input.brokerageId,
        userId: agentUserId,
      }),
      gate: async (s) => {
        const r = await evaluateOutbound({
          actorContext: { brokerageId: input.brokerageId, userId: agentUserId, role: "system" },
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

  // 4c. PERSIST THE GATED SCRIPT — ONE DRAFT PER PROMO (§5).
  //
  // This script used to be a pre-flight probe that was gated and then
  // DISCARDED: the spoken narration was drafted AGAIN by
  // app/api/internal/remotion/render-just-listed/route.ts::draftAndClearScript,
  // so every promo bought TWO model drafts (both billed to ai_tool_usage — a
  // wrong number there is a wrong invoice) and the text the gate cleared was
  // never the text that was spoken. The ledger row (listing_promo_videos) has
  // no script column live, so the script lands where the render endpoint
  // already reads and writes: the promo's own ai_video_projects row, created
  // here at 'queued' with video_metadata.promo_ledger_id as the join key. The
  // render endpoint REUSES script_content (re-fitting it to the budget and
  // re-running the rule-based evaluateOutbound gate on the exact text it will
  // speak — zero model calls) and UPDATES this same row when the render lands,
  // exactly where it used to insert a fresh one.
  //
  // HONEST DEGRADATION: if this insert is refused, the render endpoint finds
  // no staged row and drafts fresh — the pre-fix behavior, logged loudly, never
  // a lost promo.
  {
    const staged = await svc.from("ai_video_projects").insert({
      brokerage_id:   input.brokerageId,
      agent_id:       agentRecordId,
      listing_id:     input.listingId,
      title:          `${promoEventLabel(input.eventType)} — ${l.address ?? "listing"}`,
      script_content: script,
      video_type:     "listing_promo",
      status:         "queued",
      usage_intent:   "public_marketing",
      audience_type:  "customer_facing",
      compliance_status: "passed",
      compliance_evaluated_at: new Date().toISOString(),
      video_metadata: {
        promo_event_type:     input.eventType,
        promo_ledger_id:      ledgerId,
        listing_id:           input.listingId,
        staged_by:            "listing_promo_reactor",
        narration_precleared: true,
      },
    }).select("id").maybeSingle()
    if (staged.error || !staged.data) {
      console.error(
        `[listing-promo] could not persist the gated script for ledger=${ledgerId}: ` +
        `${staged.error?.message ?? "no row returned"} — the render endpoint will re-draft (second billed call)`,
      )
    }
  }

  // 5. Stage at status='remotion_pending'. The Wave 14 render cron drains
  //    these rows by POSTing to /api/internal/remotion/render-just-listed.
  //    The render endpoint reuses the persisted script above (re-gating the
  //    exact text it will speak); the pre-clear we just did is the FAST-FAIL
  //    guard — a script that fails compliance here never reaches the cron and
  //    render dollars are never spent on it.
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
  facts:        ListingFacts
  eventType:    ListingPromoEventType
  eventContext?: Record<string, unknown>
  violations:   string[]
  /** Tenant + actor for the AI cost ledger — the reactor run's own brokerage
   *  and the resolved agent user, never a caller-supplied value (§4). */
  brokerageId?: string | null
  userId?:      string | null
}): Promise<string> {
  // Wave 27 — per-event hook + close. Each lifecycle moment carries
  // distinct intent: announcement vs. invitation vs. social-proof vs.
  // pricing signal. The shared Fair-Housing fence stays universal.
  const tmpl = TEMPLATES[args.eventType]
  // THE BUDGET, DERIVED FROM THE COMPOSITION THIS EVENT WILL RENDER ON.
  // Not a literal: compositionForPromoEvent routes the event, geometryFor reads
  // its frames/fps, and narrationBudget applies the ONE words-per-minute pace and
  // headroom. The four promo compositions are 25s (JustListedReel) and 12s (the
  // three square event cuts), so ONE typed length was wrong for three of them.
  const budget = promoNarrationBudget(args.eventType)
  const ctxLine = renderEventContext(args.eventType, args.eventContext)
  const violationLine = args.violations.length > 0
    ? `\n\nYour previous draft failed the compliance gate with these violations:\n- ${args.violations.join("\n- ")}\n\nRewrite so EVERY violation is resolved. Same length + same intent, just compliance-clean.`
    : ""
  const prompt = `Write a ${budget.compositionSeconds}-second social-media video script for a real estate agent. ${tmpl.intent}

Use ONLY these property facts — do not invent any number, feature, or claim:
- Address: ${args.facts.address || "(omitted)"}
- City/State: ${args.facts.city_state || "(omitted)"}
- Price: ${args.facts.list_price || "(omitted)"}
- Bedrooms: ${args.facts.bedrooms || "(omitted)"}
- Bathrooms: ${args.facts.bathrooms || "(omitted)"}
- Square feet: ${args.facts.sqft || "(omitted)"}
- Property type: ${args.facts.property_type || "(omitted)"}
${ctxLine}

Style:
- First-person, ${tmpl.tone}
- Lead with: "${tmpl.hook}"
- ${tmpl.bodyGuidance}
- Close with: ${tmpl.closingCta}
- ${narrationLengthDirective(budget)}
- No exclamation marks
- AVOID any reference to protected characteristics (race, religion, family status, national origin, gender, sexual orientation, disability, source of income)
- AVOID phrases like "perfect for families", "great for empty-nesters", "ideal starter home for newlyweds" — these imply preference
- AVOID guaranteed-return / value-promise / market-direction claims ("prices are going up", "you'll make money", "tight inventory will push prices")
- Skip any fact that's "(omitted)"
${tmpl.extraConstraints ? `- ${tmpl.extraConstraints}\n` : ""}
Return ONLY the script text the agent will speak on camera.${violationLine}`

  const { text } = await generateTextRouted({
    brokerageId: args.brokerageId ?? null,
    userId: args.userId ?? null,
    feature:     "listing_promo_script",
    prompt,
    // SIZED FROM THE SAME NUMBER. The flat 220 that stood here bought ~3× the
    // text a 12-second square cut can carry, and the overflow was paid for and
    // thrown away — ai_tool_usage is the cost ledger (§5), so an over-large
    // token budget is a real invoice, not a rounding error.
    maxTokens:   narrationMaxTokens(budget),
    temperature: 0.55,
  })
  // VERIFY, DON'T TRUST — a word ceiling in a prompt is a request. Same policy
  // and the same function the render endpoint uses (trim at a sentence boundary
  // and SAY SO), so the pre-flight gate below clears a script of the length the
  // render path can actually speak, not one 2× longer.
  const fit = fitNarrationToBudget(text.trim(), budget)
  if (fit.note) console.warn(`[listing-promo-reactor] ${args.eventType} — ${fit.note}`)
  return fit.script
}

// ─────────────────────────────────────────────────────────────────────────────
// TOMBSTONE (§1.1 / §6) — `EventTemplate.durationSeconds` and
// `EventTemplate.wordCount` are GONE, along with their 14 hand-tuned literals
// ("35-50", "15-20", …). SURVIVOR: lib/video/promo-composition.ts:136
// promoNarrationBudget, which derives both from the composition the event
// actually renders on (lib/remotion/composition-geometry.ts COMPOSITION_GEOMETRY
// → lib/video/script-structure.ts narrationBudget / WORDS_PER_MINUTE).
//
// WHY THEY WERE A DEFECT AND NOT A STYLE CHOICE. Measured against the live
// geometry table by test:promo-narration-budget, FIVE of the seven typed
// ceilings were over the budget of the composition their event renders on, and
// THREE were over 2× — every one of those three a 12-second square cut:
//   event                composition            budget  typed ceiling
//   coming_soon          ComingSoonReel (12s)     24 w   50 w  (2.08×)
//   open_house_announce  OpenHouseAnnounceReel    24 w   55 w  (2.29×)
//   open_house_reminder  OpenHouseAnnounceReel    24 w   40 w  (1.67×)
//   just_sold            JustSoldReelSquare       24 w   55 w  (2.29×)
//   just_listed          JustListedReel (25s)     50 w   60 w  (1.20×)
//   price_reduction      JustListedReel           50 w   50 w  (1.00×)
//   under_contract       JustListedReel           50 w   40 w  (0.80×)
// The numbers are DERIVED and printed by test:promo-narration-budget rather
// than pinned here — the table above is the finding, not the assertion (§2).
//
// WHAT THIS FILE'S DRAFT IS FOR, so the next reader does not mistake it. The
// script drafted here IS the spoken narration: step 4c persists it, gated and
// budget-fitted, onto the promo's staged ai_video_projects row, and
// app/api/internal/remotion/render-just-listed/route.ts::draftAndClearScript
// REUSES it (re-fitting + re-gating the exact text it speaks, with zero model
// calls). It used to be a pre-flight probe that was gated and then DISCARDED
// while the render endpoint drafted a second script — two ai_tool_usage rows
// for one artefact, and the gated text was not the spoken text. The re-draft
// survives only as the render endpoint's FALLBACK for a staged row that was
// never written or no longer clears the render-time gate.
// ─────────────────────────────────────────────────────────────────────────────
interface EventTemplate {
  hook:             string
  intent:           string
  tone:             string
  bodyGuidance:     string
  closingCta:       string
  extraConstraints?: string
}

const TEMPLATES: Record<ListingPromoEventType, EventTemplate> = {
  coming_soon: {
    hook:            "Coming soon",
    intent:          "Announce a listing that's about to hit market and invite interested buyers to register early.",
    tone:            "anticipatory, exclusive",
    bodyGuidance:    "Hint at 2 standout features (without disclosing every detail — the goal is to drive registration)",
    closingCta:      `"DM me to be first on the list when this hits MLS"`,
    extraConstraints: "Do NOT state an exact MLS go-live date unless eventContext.go_live_date was provided",
  },
  just_listed: {
    hook:            "Just listed",
    intent:          "Announce a new on-market listing.",
    tone:            "energetic but professional",
    bodyGuidance:    "2-3 quick facts about the property",
    closingCta:      `"DM me to schedule a tour" or equivalent`,
  },
  open_house_announce: {
    hook:            "Open house this weekend",
    intent:          "Invite the audience to a scheduled open house.",
    tone:            "warm, welcoming, low-pressure",
    bodyGuidance:    "Name the day + time window + 1-2 reasons it's worth a stop",
    closingCta:      `"Come by — no appointment needed"`,
    extraConstraints: "Lead with the date+time from eventContext if provided",
  },
  open_house_reminder: {
    hook:            "Reminder — open house tomorrow",
    intent:          "Remind subscribers about the open house happening within the next 24 hours.",
    tone:            "friendly, brief, urgent without pushy",
    bodyGuidance:    "Restate day + time + address line",
    closingCta:      `"See you there"`,
    extraConstraints: "Keep it short — this is a reminder, not the original announcement",
  },
  price_reduction: {
    hook:            "Pricing update",
    intent:          "Announce the new list price with no opinion on whether the property is underpriced or a deal.",
    tone:            "neutral, factual",
    bodyGuidance:    "State the new price + 1 line on what hasn't changed about the property",
    closingCta:      `"Same property, new positioning — DM if it fits your search"`,
    extraConstraints: "Do NOT say 'priced to sell', 'motivated seller', 'great deal', 'won't last', or any phrase implying urgency, distress, or guaranteed appreciation",
  },
  under_contract: {
    hook:            "Off market",
    intent:          "Announce that the listing went under contract.",
    tone:            "celebratory but understated",
    bodyGuidance:    "Brief acknowledgement of the milestone + 1 line about buyer demand in the area (if eventContext provides supportable stats)",
    closingCta:      `"If you missed this one, DM me — I track similar listings"`,
    extraConstraints: "Do NOT disclose sale price, contingencies, or any deal terms",
  },
  back_on_market: {
    hook:            "Available again",
    intent:          "Announce that a previously-pending listing is back on market and available to see.",
    tone:            "positive, matter-of-fact — a fresh opportunity",
    bodyGuidance:    "One line that it's available again + 2 quick property facts",
    closingCta:      `"It's available again — DM me to see it before it's gone"`,
    extraConstraints: "Do NOT speculate on WHY the prior deal fell through, imply seller distress, or use 'motivated seller' / 'priced to sell' / any urgency-or-distress phrasing",
  },
  just_sold: {
    hook:            "Just sold",
    intent:          "Announce a closed sale as a social-proof signal.",
    tone:            "professional, confident, not boastful",
    bodyGuidance:    "Brief mention of the journey + 1 line about your process (NOT about price or value)",
    closingCta:      `"If you're thinking of selling, let's talk about your timeline"`,
    extraConstraints: "Do NOT disclose final sale price unless eventContext.disclose_sale_price=true AND the disclosed_sale_price field is supplied. Do NOT make market-direction claims",
  },
}

function renderEventContext(eventType: ListingPromoEventType, ctx: Record<string, unknown> | undefined): string {
  if (!ctx) return ""
  const lines: string[] = []
  // Per-event whitelist: only render fields the template's prompt cares about.
  // Schema-flexible inputs are common (caller might pass extra keys); the
  // whitelist prevents the model from seeing irrelevant context.
  if ((eventType === "open_house_announce" || eventType === "open_house_reminder") && ctx.event_date) {
    lines.push(`- Open house date+time: ${String(ctx.event_date)}`)
  }
  if (eventType === "coming_soon" && ctx.go_live_date) {
    lines.push(`- MLS go-live date: ${String(ctx.go_live_date)}`)
  }
  if (eventType === "just_sold" && ctx.disclose_sale_price === true && ctx.disclosed_sale_price) {
    lines.push(`- Final sale price (disclosure approved): ${String(ctx.disclosed_sale_price)}`)
  }
  return lines.length > 0 ? `\nEvent context:\n${lines.join("\n")}` : ""
}
