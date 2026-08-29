"use server"

// lib/ads/ad-creator.ts
// Layer 9.5 — Ad Campaign Creation and AI Creative Generation
// Kernel gates: canAccessFeature('ad_creator'), resolveProvider, applyBrandVoice, evaluateOutbound

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { KernelContact } from "@/lib/kernel/types"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
// THE EXCLUSION SLOT GATE. Not a second fair-housing classifier (CLAUDE.md §6):
// it calls the persona gate's exclusion arm and the token gate, both of which
// already own their answers. See lib/ads/audience-exclusion.ts's header for why
// the PLACEMENT of an audience — not only its own rule type — decides which
// operation it performs.
import { verifyExclusionSlot, recordSuppressionUse } from "@/lib/ads/audience-exclusion"
import type {
  CreateAdCampaignParams,
  GenerateAdCreativeParams,
  AdCreativeVariation,
} from "@/lib/ads/ad-creator-types"

// ─── INTERNAL: BROADCAST AD CONTACT ──────────────────────────────────────────
// Ads are public-facing creative — not outbound to a specific contact.
// We construct a synthetic broadcast contact so evaluateOutbound can run
// brand voice + fair housing + them-first checks without a TCPA gate.
// TCPA only applies to sms/phone channels, not social ad creative.
function broadcastAdContact(brokerageId: string): KernelContact {
  return {
    id: `broadcast:${brokerageId}`,
    first_name: "Ad",
    last_name: "Audience",
    contact_type: "buyer",
    persona: "other",
    tcpa_consent: true,          // social channel — TCPA gate does not fire
    dnc_status: false,
    isa_reengage_allowed: false,
    stop_outreach: false,
    brokerage_id: brokerageId,
  } as unknown as KernelContact
}

// Types now live in @/lib/ads/ad-creator-types so this file can be a
// clean "use server" module (Next 16 rejects type exports in such files).

// ─── SESSION GATE ─────────────────────────────────────────────────────────────
// Every export here is a "use server" action — a public HTTP endpoint. Each one
// used to take `userId` and `brokerageId` **from the caller** and had no auth gate
// at all, so:
//   • `canAccessFeature(userId, …)` was an entitlement check on a caller-chosen
//     identity — i.e. no entitlement check;
//   • `created_by` / `actor_user_id` on ad_campaigns and lifecycle_events were
//     forgeable audit fields;
//   • `generateAdCreative` spent Claude tokens on the platform key with no auth
//     and (see below) no feature gate whatsoever.
// The actor and tenant are now taken from the session. The `userId` parameter and
// the `brokerageId` fields on the params objects are RETAINED but IGNORED so
// existing call sites keep type-checking (house pattern in this repo).
//
// NOT exported — a "use server" module may only export async functions, and this
// is an internal gate, not an endpoint.
async function resolveAdActor(): Promise<
  { ok: true; userId: string; brokerageId: string } | { ok: false; error: string }
> {
  const session = await getAgentContext()
  if (!session.isAuthenticated) {
    return { ok: false, error: "Not authenticated" }
  }
  if (!session.brokerageId) {
    return { ok: false, error: "No brokerage on this account" }
  }
  return { ok: true, userId: session.userId, brokerageId: session.brokerageId }
}

// ─── createAdCampaign ─────────────────────────────────────────────────────────

export async function createAdCampaign(
  _userId: string,
  params: CreateAdCampaignParams
): Promise<{ success: boolean; campaignId?: string; error?: string; suppressionAuditWarning?: string }> {
  // ── 0. Session gate ─────────────────────────────────────────────────────────
  const actor = await resolveAdActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const { userId, brokerageId } = actor

  const supabase = await createClient()

  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ad_creator")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  // ── 1b. The EXCLUSION SLOT (owner: "capability is vital to this os to have
  //       not exclude") ──────────────────────────────────────────────────────
  // This is the door the ads dashboard, the wizard-staging lane and the workflow
  // adapter all come through, so it is the one an operator's declared
  // suppression list actually arrives at. Every audience named in
  // `targeting_config.excluded_audience_ids` is checked against the persona
  // gate's EXCLUSION arm and the token gate before the row is written; a
  // protected-characteristic persona audience in that slot is refused. Tenant is
  // the SESSION's (`actor.brokerageId`), never the params object's (§4).
  const exclusionVerdict = await verifyExclusionSlot({
    supabase,
    brokerageId,
    targeting: params.targetingConfig,
    campaignLabel: params.campaignName,
  })
  if (!exclusionVerdict.ok) {
    return { success: false, error: exclusionVerdict.refusal }
  }

  // ── 2. Insert ad_campaigns ──────────────────────────────────────────────────
  // brokerage_id / agent_user_id / created_by are session-derived. The UI has
  // always passed `agentUserId: userId` (the signed-in user), so this changes no
  // behaviour — it just stops the value being assertable from outside.
  const { data: campaign, error } = await supabase
    .from("ad_campaigns")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: userId,
      marketing_campaign_id: params.marketingCampaignId || null,
      campaign_name: params.campaignName,
      platform: params.platform,
      objective: params.objective,
      daily_budget: params.dailyBudget || null,
      lifetime_budget: params.lifetimeBudget || null,
      start_date: params.startDate || null,
      end_date: params.endDate || null,
      targeting_config: params.targetingConfig,
      status: "draft",
      created_by: userId,
    })
    .select("id")
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  // ── 3. Lifecycle event + kernel event ───────────────────────────────────────
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "ad_campaign",
    entity_id: campaign.id,
    event_type: "ad_campaign_created",
    actor_user_id: userId,
    metadata: {
      platform: params.platform,
      objective: params.objective,
      campaign_name: params.campaignName,
    },
  })

  // ── 4. Increment usage ──────────────────────────────────────────────────────
  await incrementFeatureUsage(userId, "ad_creator")

  // ── 5. The suppression-use audit record (migration m538) ────────────────────
  // Best-effort by design and its refusal is RETURNED rather than swallowed: the
  // columns do not exist until the integrator applies m538, and "not yet
  // auditable" must not read as "not checked". The gate at step 1b already ran.
  const suppressionAudit = await recordSuppressionUse({
    supabase,
    brokerageId,
    campaignId: campaign.id,
    governed: exclusionVerdict.governed,
  })

  return {
    success: true,
    campaignId: campaign.id,
    ...(suppressionAudit.error ? { suppressionAuditWarning: suppressionAudit.error } : {}),
  }
}

// ─── generateAdCreative ───────────────────────────────────────────────────────

export async function generateAdCreative(
  _userId: string,
  params: GenerateAdCreativeParams
): Promise<{ success: boolean; variations?: AdCreativeVariation[]; error?: string }> {
  // ── 0. Session gate — this endpoint spends model tokens on the platform key ──
  const actor = await resolveAdActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const { userId, brokerageId } = actor

  const supabase = await createClient()
  const { adCampaignId } = params

  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  // This step was MISSING: the file header documents `canAccessFeature('ad_creator')`
  // as a kernel gate and the numbered comments below skip from 1 to 3, but no gate
  // was ever called here — so the only AI-spending export in the file was also the
  // only one not metered. Added, with the matching usage increment at the end.
  const accessCheck = await canAccessFeature(userId, "ad_creator")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  // ── 2. Get campaign details ─────────────────────────────────────────────────
  // Tenant predicate added: this read was `.eq("id", adCampaignId)` alone, so a
  // bare campaign uuid disclosed another brokerage's campaign name/objective and,
  // worse, let the caller write creative variations against it below.
  // `targeting_config` is read for the campaign's listing_id — the first rung of
  // the destination ladder below. It is the same jsonb the auto-producer stamps
  // (lib/ads/listing-ad-producer.ts) and the launch assembler already reads.
  const { data: campaign, error: campaignError } = await supabase
    .from("ad_campaigns")
    .select("platform, objective, campaign_name, team_id, targeting_config")
    .eq("id", adCampaignId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // A refused read is not "no rows" — fail closed on either.
  if (campaignError || !campaign) {
    return { success: false, error: "Campaign not found" }
  }

  // The brokerage is the session's, never `context.brokerageId` from the caller.
  const context = { ...params.context, brokerageId }

  // ── 3. Apply brand voice to get tone guidelines for the AI prompt ──────────
  // applyBrandVoice is also called inside evaluateOutbound (Gate 1) — calling
  // it here separately gives us the tone notes to bake into the AI prompt so
  // the generated copy respects brokerage brand voice before compliance runs.
  const brandVoice = await applyBrandVoice({
    brokerageId: context.brokerageId,
    actorRole: "agent",
    journeyType: "seller",
    persona: "other",
    messageType: "social",
    content: "",   // Empty — we just want the voice notes, not a content evaluation
  })

  // ── 4. Build AI prompt ──────────────────────────────────────────────────────
  const prompt = `
You are an expert real estate advertising copywriter. Generate 3 A/B test variations of ad creative for a ${campaign.platform} ad campaign.

Campaign Details:
- Campaign Name: ${campaign.campaign_name}
- Objective: ${campaign.objective}
- Platform: ${campaign.platform}
${context.listingAddress ? `- Listing Address: ${context.listingAddress}` : ""}
${context.listingPrice ? `- Listing Price: $${context.listingPrice.toLocaleString()}` : ""}
${context.agentName ? `- Agent Name: ${context.agentName}` : ""}

Brand Voice Guidelines (MUST follow exactly):
${brandVoice.notes.length > 0 ? brandVoice.notes.join("\n") : "Professional, trustworthy, and approachable tone."}
${brandVoice.violations.length > 0 ? `\nAvoid these violations: ${brandVoice.violations.join(", ")}` : ""}

Real estate compliance rules (MUST follow — Fair Housing Act applies):
- Do NOT use language that implies preference for or against any protected class
- Do NOT use phrases like "perfect for families", "great neighborhood", "ideal for couples"
- Do NOT make investment return claims or guarantee appreciation
- Use buyer-first language — focus on them, not the agent

Generate exactly 3 variations with different approaches:
- Variation A: Emotional appeal (focus on lifestyle, dreams, discovery)
- Variation B: Value proposition (focus on features, condition, location)
- Variation C: Market context (focus on current market opportunities)

For each variation, provide:
1. variationName (e.g., "Emotional Appeal")
2. headline (max 40 characters)
3. primaryText (max 125 characters)
4. description (max 30 characters)
5. callToAction (e.g., "Learn More", "Schedule a Tour", "Contact Agent")

Respond with ONLY valid JSON array of 3 objects, no other text.
`

  // ── 5. Generate variations via AI ───────────────────────────────────────────
  try {
    const { text } = await generateText({
      model: resolveModel("anthropic/claude-sonnet-4-20250514" as Parameters<typeof resolveModel>[0]),
      prompt,
      maxOutputTokens: 1500,
    })

    // Parse JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      return { success: false, error: "Failed to parse AI response" }
    }

    const parsed: unknown = JSON.parse(jsonMatch[0])

    // The model's output is written straight into ad_creative_variations, where
    // variation_name is NOT NULL — an off-shape response would either insert
    // rubbish or throw a 23502 that the old code discarded. Validate the shape and
    // keep only well-formed variations.
    const rawList: unknown[] = Array.isArray(parsed) ? (parsed as unknown[]) : []
    const variations: AdCreativeVariation[] = rawList
      .filter(
        (v): v is AdCreativeVariation =>
          !!v &&
          typeof v === "object" &&
          typeof (v as any).variationName === "string" &&
          (v as any).variationName.trim().length > 0
      )

    if (variations.length === 0) {
      return { success: false, error: "AI returned no usable creative variations" }
    }

    // ── 6. Evaluate compliance for each variation ─────────────────────────────
    //
    // WHERE THE CLICK GOES, resolved ONCE for the batch (it is a property of the
    // campaign, not of a variation). `destination_url` is read at launch
    // (lib/ads/launch-assembler.ts:51) and was written by nothing, so
    // validateAdReadiness refused EVERY Google ad and every non-`leads` Meta
    // objective these variations belong to with
    // `missing: ["creative.destinationUrl"]` — a human could approve a creative
    // that had no path to a provider. Null stays null and keeps that refusal:
    // see lib/ads/ad-destination.ts for why an unresolvable destination must
    // never be filled in with a guessed host.
    const { resolveAdDestination } = await import("./ad-destination")
    const targeting = (campaign.targeting_config ?? {}) as Record<string, unknown>
    const destinationUrl = await resolveAdDestination(supabase as never, {
      brokerageId: context.brokerageId,
      listingId: typeof targeting.listing_id === "string" ? targeting.listing_id : null,
      teamId: (campaign as { team_id?: string | null }).team_id ?? null,
    })

    const processedVariations: AdCreativeVariation[] = []

    for (const variation of variations) {
      const combinedText = `${variation.headline} ${variation.primaryText} ${variation.description}`

      // Run all 5 compliance gates: Brand Voice → TCPA → Authority → Fair Housing → Them-First
      // Ad creative uses the "social" channel and a synthetic broadcast contact (no real recipient).
      const complianceResult = await evaluateOutbound({
        actorContext: {
          userId,
          brokerageId: context.brokerageId,
          role: "agent",
        },
        journeyType: "seller",
        persona: "other",
        messageType: "social",
        content: combinedText,
        contact: broadcastAdContact(context.brokerageId),
      })

      // ── 7. Insert into ad_creative_variations ─────────────────────────────────
      const approvalStatus = complianceResult.allowed ? "draft" : "rejected"
      
      const { data: creativeRecord, error: insertError } = await supabase
        .from("ad_creative_variations")
        .insert({
          ad_campaign_id: adCampaignId,
          brokerage_id: context.brokerageId,
          variation_name: variation.variationName,
          headline: variation.headline,
          primary_text: variation.primaryText,
          description: variation.description,
          call_to_action: variation.callToAction,
          destination_url: destinationUrl,
          approval_status: approvalStatus,
        })
        .select("id")
        .single()

      if (!insertError && creativeRecord) {
        // If rejected due to compliance, log the reason
        if (!complianceResult.allowed) {
          // actor_role IS NOT NULL ON compliance_events (live schema, no default,
          // no BEFORE-INSERT trigger). This insert omitted it, so every one of
          // these rows was refused 23502 and the error was dropped — the
          // fair-housing / brand-voice rejection of an ad creative has NEVER
          // reached the compliance ledger. "agent" is the same role this
          // function hands evaluateOutbound above; it is not a new claim.
          const { error: complianceLogError } = await supabase.from("compliance_events").insert({
            brokerage_id: context.brokerageId,
            actor_user_id: userId,
            actor_role: "agent",
            entity_type: "ad_creative_variation",
            entity_id: creativeRecord.id,
            gate_name: "evaluateOutbound",
            message_type: "social",
            violations: complianceResult.violations || [],
            blocked_reason: complianceResult.blockedReason ?? null,
            allowed: false,
          })
          if (complianceLogError) {
            console.error(
              "[ad-creator] compliance_events insert REFUSED — an ad-creative rejection went unrecorded:",
              complianceLogError.message,
            )
          }
        }
      }

      processedVariations.push(variation)
    }

    // ── 8. Meter the spend ──────────────────────────────────────────────────────
    await incrementFeatureUsage(userId, "ad_creator")

    return { success: true, variations: processedVariations }
  } catch (err: any) {
    return { success: false, error: err.message || "AI generation failed" }
  }
}

// ─── approveCreativeVariation ─────────────────────────────────────────────────

export async function approveCreativeVariation(
  _userId: string,
  variationId: string,
  _brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  // ── 0. Session gate — approval is what makes a creative launchable ──────────
  const actor = await resolveAdActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const { userId, brokerageId } = actor

  const supabase = await createClient()

  // ── 1. Verify variation exists and is not already approved ──────────────────
  const { data: existing, error: fetchError } = await supabase
    .from("ad_creative_variations")
    .select("id, approval_status, headline, primary_text, description")
    .eq("id", variationId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (fetchError || !existing) {
    return { success: false, error: "Creative variation not found" }
  }

  if (existing.approval_status === "approved") {
    return { success: true }
  }

  // ── 2. Compliance gate — must pass before approval is granted ───────────────
  // Reconstruct the ad copy text from the stored variation for compliance eval.
  const combinedText = [
    existing.headline ?? "",
    existing.primary_text ?? "",
    existing.description ?? "",
  ]
    .filter(Boolean)
    .join(" ")

  const complianceResult = await evaluateOutbound({
    actorContext: {
      userId,
      brokerageId,
      role: "agent",
    },
    journeyType: "seller",
    persona: "other",
    messageType: "social",
    content: combinedText,
    contact: broadcastAdContact(brokerageId),
  })

  if (!complianceResult.allowed) {
    // Log the rejection event.
    // actor_role IS NOT NULL on compliance_events (live schema, no default, no
    // trigger) — omitting it refused this row 23502 every single time, so the
    // approval refusal was shown to the operator and recorded nowhere. "agent"
    // is the role this same function passes to evaluateOutbound above.
    const { error: complianceLogError } = await supabase.from("compliance_events").insert({
      brokerage_id: brokerageId,
      actor_user_id: userId,
      actor_role: "agent",
      entity_type: "ad_creative_variation",
      entity_id: variationId,
      gate_name: "approveCreativeVariation",
      message_type: "social",
      violations: complianceResult.violations || [],
      blocked_reason: complianceResult.blockedReason ?? "Compliance check failed",
      allowed: false,
    })
    if (complianceLogError) {
      console.error(
        "[ad-creator] compliance_events insert REFUSED — a creative-approval refusal went unrecorded:",
        complianceLogError.message,
      )
    }

    // Also mark the variation as rejected so the UI surfaces the failure
    await supabase
      .from("ad_creative_variations")
      .update({ approval_status: "rejected" })
      .eq("id", variationId)
      .eq("brokerage_id", brokerageId)

    return {
      success: false,
      error: `Compliance check failed: ${complianceResult.violations.join("; ")}`,
    }
  }

  // ── 3. Update approval status ───────────────────────────────────────────────
  // `.select("id")` so a row RLS hides (or one that vanished between the read and
  // the write) reports failure instead of a silent success on zero rows.
  const { data: approved, error } = await supabase
    .from("ad_creative_variations")
    .update({ approval_status: "approved" })
    .eq("id", variationId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) {
    return { success: false, error: error.message }
  }

  if (!approved?.length) {
    return { success: false, error: "Creative variation not found" }
  }

  return { success: true }
}

// ─── rejectCreativeVariation ──────────────────────────────────────────────────

export async function rejectCreativeVariation(
  _userId: string,
  variationId: string,
  _brokerageId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  // ── 0. Session gate ─────────────────────────────────────────────────────────
  const actor = await resolveAdActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const { userId, brokerageId } = actor

  const supabase = await createClient()

  const { data: rejected, error } = await supabase
    .from("ad_creative_variations")
    .update({ approval_status: "rejected" })
    .eq("id", variationId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) {
    return { success: false, error: error.message }
  }

  if (!rejected?.length) {
    return { success: false, error: "Creative variation not found" }
  }

  // `reason` was accepted and then silently discarded — the human's rejection
  // note, which is the whole point of a review queue, was never stored anywhere.
  // ad_creative_variations has no rejection_reason column (verified against the
  // live schema), so it is recorded on the lifecycle ledger instead, where the
  // approval rail already reads ad_creative events.
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "ad_creative_variation",
    entity_id: variationId,
    event_type: "ad_creative_rejected",
    actor_user_id: userId,
    metadata: { reason: reason ?? null },
  })

  return { success: true }
}

// ─── launchAdCampaign ─────────────────────────────────────────────────────────

export async function launchAdCampaign(
  _userId: string,
  campaignId: string,
  _brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  // ── 0. Session gate — launching a campaign starts real ad spend ─────────────
  const actor = await resolveAdActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const { userId, brokerageId } = actor

  const supabase = await createClient()

  // ── 1. Get campaign and verify status ───────────────────────────────────────
  const { data: campaign, error: fetchError } = await supabase
    .from("ad_campaigns")
    .select("status, platform, campaign_name")
    .eq("id", campaignId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (fetchError || !campaign) {
    return { success: false, error: "Campaign not found" }
  }

  // Guard: status MUST be 'approved'
  if (campaign.status !== "approved") {
    return {
      success: false,
      error: `Cannot launch campaign. Current status is '${campaign.status}', must be 'approved'`,
    }
  }

  // ── 2. Update campaign status ───────────────────────────────────────────────
  // The tenant predicate was present on the read above but MISSING on this write.
  // Added, plus `.select("id")` so a no-op update cannot report a launch.
  const { data: launched, error: updateError } = await supabase
    .from("ad_campaigns")
    .update({
      status: "launching",
      kernel_event_id: null, // Will be set by kernel event
    })
    .eq("id", campaignId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  if (!launched?.length) {
    return { success: false, error: "Campaign not found" }
  }

  // ── 3. Record lifecycle event ───────────────────────────────────────────────
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "ad_campaign",
    entity_id: campaignId,
    event_type: "ad_campaign_launched",
    actor_user_id: userId,
    metadata: {
      platform: campaign.platform,
      campaign_name: campaign.campaign_name,
    },
  })

  return { success: true }
}

// ─── updateCampaignStatus ─────────────────────────────────────────────────────

// SCHEMA DRIFT (verified live): the accepted union used to include "active" and
// "completed", neither of which exists in ad_campaigns_status_check —
// CHECK (status IN ('draft','pending_review','approved','launching','live',
// 'paused','ended','failed')). Passing either was a guaranteed 23514. The union is
// narrowed to the real vocabulary; the only call site passes "approved".
export async function updateCampaignStatus(
  _userId: string,
  campaignId: string,
  _brokerageId: string,
  newStatus:
    | "draft"
    | "pending_review"
    | "approved"
    | "launching"
    | "live"
    | "paused"
    | "ended"
    | "failed"
): Promise<{ success: boolean; error?: string }> {
  // ── 0. Session gate ─────────────────────────────────────────────────────────
  const actor = await resolveAdActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const { brokerageId } = actor

  const supabase = await createClient()

  const { data: updated, error } = await supabase
    .from("ad_campaigns")
    .update({ status: newStatus })
    .eq("id", campaignId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) {
    return { success: false, error: error.message }
  }

  if (!updated?.length) {
    return { success: false, error: "Campaign not found" }
  }

  return { success: true }
}

// ─── getCampaignCreatives — MERGED-THEN-DELETED (orphan burn-down w2s2) ───────
//
// SURVIVOR: lib/kernel/ads.ts:previewAdCreative — the same
// `ad_creative_variations` read, brokerage-scoped, and strictly stronger: it
// first loads the campaign under the tenant predicate and refuses when the
// campaign is not the caller's, so a bare campaign uuid cannot probe. The list
// axis the ads page actually renders is covered by
// lib/kernel/ads.ts:loadAdsWorkspace, which nests `ad_creative_variations (*)`;
// every dashboard mutation refreshes through it with router.refresh().
//
// MERGED FIRST, then deleted. The one capability this had that the survivor
// lacked was a deterministic `.order("created_at", { ascending: true })` — A/B
// variations rendered in generation order rather than whatever order Postgres
// happened to return. That ordering now lives on `previewAdCreative`; w2s2
// recorded it as the explicit precondition for this deletion, and it is met.
//
// Removing it also closes a public endpoint: this file is `"use server"`, so
// every export here is a reachable HTTP endpoint, and this one was an
// unauthenticated read of a tenant's ad copy until w2s2 gated it.
