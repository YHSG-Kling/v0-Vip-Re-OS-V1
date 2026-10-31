"use server"

// lib/ads/ad-creator.ts
// Layer 9.5 — Ad Campaign Creation and AI Creative Generation
// Kernel gates: canAccessFeature('ad_creator'), resolveProvider, applyBrandVoice, evaluateOutbound

import { bestEffort } from "@/lib/db/best-effort"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { mayUseFeature } from "@/lib/billing/billing-access"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { KernelContact } from "@/lib/kernel/types"
import { generateTextRouted } from "@/lib/ai/models"
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
  const accessCheck = await mayUseFeature(userId, "ad_creator")
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
  await bestEffort(import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    brokerageId: brokerageId,
    entityType: "ad_campaign",
    entityId: campaign.id,
    event: "ad_campaign_created",
    actorUserId: userId,
    metadata: {
      platform: params.platform,
      objective: params.objective,
      campaign_name: params.campaignName,
    },
    auditOnly: true,
  }).then(k.asWriteResult)), "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped")

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
  const accessCheck = await mayUseFeature(userId, "ad_creator")
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
    .select("platform, objective, campaign_name, team_id, targeting_config, marketing_campaign_id")
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
    // Wave 97 (lane 97C): the ROUTED lane books ai_tool_usage under the SESSION's tenant + user
    // (was a raw pinned-Sonnet call that booked nothing), with fair-use pre-flight + Data Guard.
    const { text } = await generateTextRouted({
      feature: "marketing_script_generation",
      brokerageId,
      userId,
      prompt,
      maxTokens: 1500,
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
    // Wave 141 (lane 141E): a campaign that names a LEAD MAGNET sends every creative to that magnet's
    // capture page with the attribution the capture keeps — campaign (marketing_campaigns.id, the
    // attribution FK contacts.campaign_attribution_id points at), ad campaign, platform as utm_source,
    // and PER VARIATION the creative itself. Resolved per variation below; the batch destination stays
    // the one resolution for listing / brand-site campaigns.
    const leadMagnetId = typeof targeting.lead_magnet_id === "string" && targeting.lead_magnet_id ? targeting.lead_magnet_id : null
    const platform = String((campaign as { platform?: string }).platform ?? "")
    const { attributionSlug } = await import("@/lib/lead-magnets/attribution")
    const baseAttribution = leadMagnetId ? {
      campaignId: (campaign as { marketing_campaign_id?: string | null }).marketing_campaign_id ?? null,
      adCampaignId,
      utmSource: platform || null,
      utmMedium: platform === "google" ? "paid_search" : "paid_social",
      utmCampaign: String((campaign as { campaign_name?: string }).campaign_name ?? "") || null,
    } : null
    const destinationUrl = leadMagnetId ? null : await resolveAdDestination(supabase as never, {
      brokerageId: context.brokerageId,
      listingId: typeof targeting.listing_id === "string" ? targeting.listing_id : null,
      teamId: (campaign as { team_id?: string | null }).team_id ?? null,
    })

    const processedVariations: AdCreativeVariation[] = []

    for (const original of variations) {
      // `variation` is what lands (the rewrite loop below may replace its copy; the name never changes).
      let variation = original
      const variationDestination = leadMagnetId
        ? await resolveAdDestination(supabase as never, {
            brokerageId: context.brokerageId,
            leadMagnetId,
            attribution: { ...baseAttribution, creative: attributionSlug(variation.variationName) },
          })
        : destinationUrl

      // Run all 5 compliance gates: Brand Voice → TCPA → Authority → Fair Housing → Them-First
      // Ad creative uses the "social" channel and a synthetic broadcast contact (no real recipient).
      const gateFor = (v: AdCreativeVariation) => evaluateOutbound({
        actorContext: {
          userId,
          brokerageId: context.brokerageId,
          role: "agent",
        },
        journeyType: "seller",
        persona: "other",
        messageType: "social",
        content: `${v.headline} ${v.primaryText} ${v.description}`,
        contact: broadcastAdContact(context.brokerageId),
      })
      let complianceResult = await gateFor(variation)

      // THE FAIR-HOUSING REWRITE LOOP (wave 142, lane 142E; owner: "any fair housing flags on copy ai should
      // rewrite with those comments in mind"). A rejected variation goes BACK to the routed lane with the
      // specific findings (the ONE pattern list's phrase → fix, plus the gate's own violations), is re-gated
      // through the SAME five gates, at most PUBLIC_COPY_MAX_REWRITES times. Still rejected → it lands as
      // rejected with its compliance_events row (the human surface), never silently dropped.
      let rewriteAttempts = 0
      if (!complianceResult.allowed) {
        const { rewritePublicCopyUntilCompliant, scanPublicCopy, renderFindingsForRewrite } = await import("@/lib/kernel/marketing/public-copy-rewrite")
        let latest = variation
        let latestGate = complianceResult
        const loop = await rewritePublicCopyUntilCompliant({
          text: `${variation.headline} ${variation.primaryText} ${variation.description}`,
          surface: "ad",
          gate: async (text) => {
            const scan = await scanPublicCopy(text, "ad")
            const findings = [...scan.findings, ...(latestGate.violations ?? []).map((v) => ({ phrase: v, fix: "Describe the home and the service; promise no outcome; name no protected class.", reference: "lib/kernel/compliance.ts evaluateOutbound", severity: "blocker" as const }))]
            return { ok: latestGate.allowed && scan.ok, findings, warnings: scan.warnings }
          },
          rewrite: async (_text, findings) => {
            const { text } = await generateTextRouted({
              feature: "marketing_script_generation",
              brokerageId,
              userId,
              prompt:
                `Rewrite this ${campaign.platform} ad creative so EVERY finding below is resolved. Keep the same intent and the character limits (headline ≤40, primaryText ≤125, description ≤30). Fair Housing Act applies: describe the home and the service, never who should want it; no guarantees.\n\n` +
                `Current creative:\n${JSON.stringify({ headline: latest.headline, primaryText: latest.primaryText, description: latest.description, callToAction: latest.callToAction })}\n\n` +
                `Findings:\n${renderFindingsForRewrite(findings)}\n\nRespond with ONLY a JSON object {"headline","primaryText","description","callToAction"}.`,
              maxTokens: 400,
            })
            const m = text.match(/\{[\s\S]*\}/)
            if (!m) return null
            const parsed = JSON.parse(m[0]) as Partial<AdCreativeVariation>
            if (typeof parsed.headline !== "string" || typeof parsed.primaryText !== "string") return null
            latest = { ...latest, headline: parsed.headline, primaryText: parsed.primaryText, description: typeof parsed.description === "string" ? parsed.description : latest.description, callToAction: typeof parsed.callToAction === "string" ? parsed.callToAction : latest.callToAction }
            latestGate = await gateFor(latest)
            return `${latest.headline} ${latest.primaryText} ${latest.description}`
          },
        })
        rewriteAttempts = loop.rewrites
        variation = latest
        complianceResult = latestGate
      }

      // ── 6b. THE FINAL PERSONALIZATION PHASE (owner ruling 20 / contract C4 — wave 145, lane 145Z; lane 145G Outside-lane 3):
      //    the ad's body copy passes finalizeForDistribution (assetKind ad_creative — no tagline in an ad; the renderer places the
      //    logo), machine phrasing removed and facts kept; the FINAL is what is stored and what the human approves (staged below
      //    as the creative's version, the human told). A final that still carries a hard fair-housing finding or a brand-prohibited
      //    word goes to the human as REJECTED with the finding, exactly as a compliance refusal does.
      let adFinal: Awaited<ReturnType<typeof import("@/lib/marketing/humanize-final").finalizeForDistribution>> | null = null
      if (complianceResult.allowed) {
        try {
          const { finalizeForDistribution, resolveTenantBrandForFinal } = await import("@/lib/marketing/humanize-final")
          const { createServiceClient } = await import("@/lib/supabase/service")
          const brand = await resolveTenantBrandForFinal(createServiceClient(), { brokerageId: context.brokerageId, agentUserId: userId })
          adFinal = await finalizeForDistribution({ assetKind: "ad_creative", text: variation.primaryText, tenantBrand: brand.brand })
          const hard = [...adFinal.fairHousing, ...adFinal.brandVoice.prohibited.map((w) => `prohibited by the brand voice: "${w}"`)]
          if (hard.length) complianceResult = { ...complianceResult, allowed: false, violations: [...(complianceResult.violations ?? []), ...hard] as any, blockedReason: "final_phase" } as typeof complianceResult
          else if (adFinal.text.trim() && adFinal.text.length <= 125) variation = { ...variation, primaryText: adFinal.text }
        } catch (finalErr) {
          console.error(`[ad-creator] the final personalization phase could not run — the gated draft goes to the human as written: ${(finalErr as Error)?.message ?? finalErr}`)
        }
      }

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
          destination_url: variationDestination,
          approval_status: approvalStatus,
        })
        .select("id")
        .single()

      // The staged FINAL — the version the human's approval covers, and the human is told it is ready (C4 version ledger).
      if (!insertError && creativeRecord && complianceResult.allowed && adFinal) {
        try {
          const { stageDistributionFinal } = await import("@/lib/marketing/humanize-final")
          const { createServiceClient } = await import("@/lib/supabase/service")
          const staged = await stageDistributionFinal(createServiceClient(), {
            brokerageId: context.brokerageId, assetTable: "ad_creative_variations", assetId: creativeRecord.id, final: adFinal,
            createdBy: userId, notifyUserId: userId, storedAs: variation.primaryText,
          })
          if (!staged.ok) console.error(`[ad-creator] creative ${creativeRecord.id}: the humanized final was NOT recorded — ${staged.error}`)
        } catch (stageErr) {
          console.error(`[ad-creator] creative ${creativeRecord.id}: staging the final threw — ${(stageErr as Error)?.message ?? stageErr}`)
        }
      }

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
            // The loop's evidence for the reviewer: how many AI rewrites ran before the human got it.
            blocked_reason: `${complianceResult.blockedReason ?? "compliance"}${rewriteAttempts ? ` (after ${rewriteAttempts} AI rewrite${rewriteAttempts === 1 ? "" : "s"} — escalated to a human)` : ""}`,
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

  // ── 1b. WHO may approve (contract C5 — owner ruling 9, wave 146 lane 146E) ──
  // The creative's campaign owner approves their own; the team lead / brokerage approve as oversight; the brokerage
  // is REQUIRED only where the tenant's policy or a recorded legal requirement says so. Session user + tenant only.
  const { requirePublishApprover } = await import("@/lib/kernel/approval-authority")
  const { createServiceClient } = await import("@/lib/supabase/service")
  const authority = await requirePublishApprover({ brokerageId, assetKind: "ad_creative", assetTable: "ad_creative_variations", assetId: variationId, approverUserId: userId, client: createServiceClient() })
  if (!authority.ok) return { success: false, error: authority.reason }

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
    await bestEffort(supabase
      .from("ad_creative_variations")
      .update({ approval_status: "rejected" })
      .eq("id", variationId)
      .eq("brokerage_id", brokerageId), "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent")

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
  await bestEffort(import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    brokerageId: brokerageId,
    entityType: "ad_creative_variation",
    entityId: variationId,
    event: "ad_creative_rejected",
    actorUserId: userId,
    metadata: { reason: reason ?? null },
  }).then(k.asWriteResult)), "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped")

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
      // kernel_event_id RETIRED (m597): the column linked to a kernel_events
      // table that never existed, no publisher ever produced an id ("will be
      // set by kernel event" was a promise nothing kept), and after the drop a
      // write naming it would PGRST204-refuse the ENTIRE row — failing every
      // launch. The durable event link is the lifecycle_events insert below.
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
  await bestEffort(import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    brokerageId: brokerageId,
    entityType: "ad_campaign",
    entityId: campaignId,
    event: "ad_campaign_launched",
    actorUserId: userId,
    metadata: {
      platform: campaign.platform,
      campaign_name: campaign.campaign_name,
    },
    auditOnly: true,
  }).then(k.asWriteResult)), "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped")

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
