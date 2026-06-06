"use server"

// lib/ads/ad-creator.ts
// Layer 9.5 — Ad Campaign Creation and AI Creative Generation
// Kernel gates: canAccessFeature('ad_creator'), resolveProvider, applyBrandVoice, evaluateOutbound

import { createClient } from "@/lib/supabase/server"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { KernelContact } from "@/lib/kernel/types"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import type {
  TargetingConfig,
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

// ─── createAdCampaign ─────────────────────────────────────────────────────────

export async function createAdCampaign(
  userId: string,
  params: CreateAdCampaignParams
): Promise<{ success: boolean; campaignId?: string; error?: string }> {
  const supabase = await createClient()

  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ad_creator")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  // ── 2. Insert ad_campaigns ──────────────────────────────────────────────────
  const { data: campaign, error } = await supabase
    .from("ad_campaigns")
    .insert({
      brokerage_id: params.brokerageId,
      agent_user_id: params.agentUserId,
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
    brokerage_id: params.brokerageId,
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

  return { success: true, campaignId: campaign.id }
}

// ─── generateAdCreative ───────────────────────────────────────────────────────

export async function generateAdCreative(
  userId: string,
  params: GenerateAdCreativeParams
): Promise<{ success: boolean; variations?: AdCreativeVariation[]; error?: string }> {
  const supabase = await createClient()
  const { adCampaignId, context } = params

  // ── 1. Get campaign details ─────────────────────────────────────────────────
  const { data: campaign } = await supabase
    .from("ad_campaigns")
    .select("platform, objective, campaign_name")
    .eq("id", adCampaignId)
    .single()

  if (!campaign) {
    return { success: false, error: "Campaign not found" }
  }

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

    const variations: AdCreativeVariation[] = JSON.parse(jsonMatch[0])

    // ── 6. Evaluate compliance for each variation ─────────────────────────────
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
          approval_status: approvalStatus,
        })
        .select("id")
        .single()

      if (!insertError && creativeRecord) {
        // If rejected due to compliance, log the reason
        if (!complianceResult.allowed) {
          await supabase.from("compliance_events").insert({
            brokerage_id: context.brokerageId,
            actor_user_id: userId,
            entity_type: "ad_creative_variation",
            entity_id: creativeRecord.id,
            gate_name: "evaluateOutbound",
            message_type: "social",
            violations: complianceResult.violations || [],
            blocked_reason: complianceResult.blockedReason ?? null,
            allowed: false,
          })
        }
      }

      processedVariations.push(variation)
    }

    return { success: true, variations: processedVariations }
  } catch (err: any) {
    return { success: false, error: err.message || "AI generation failed" }
  }
}

// ─── approveCreativeVariation ─────────────────────────────────────────────────

export async function approveCreativeVariation(
  userId: string,
  variationId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
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
    // Log the rejection event
    await supabase.from("compliance_events").insert({
      brokerage_id: brokerageId,
      actor_user_id: userId,
      entity_type: "ad_creative_variation",
      entity_id: variationId,
      gate_name: "approveCreativeVariation",
      message_type: "social",
      violations: complianceResult.violations || [],
      blocked_reason: complianceResult.blockedReason ?? "Compliance check failed",
      allowed: false,
    })

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
  const { error } = await supabase
    .from("ad_creative_variations")
    .update({ approval_status: "approved" })
    .eq("id", variationId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── rejectCreativeVariation ──────────────────────────────────────────────────

export async function rejectCreativeVariation(
  userId: string,
  variationId: string,
  brokerageId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { error } = await supabase
    .from("ad_creative_variations")
    .update({ approval_status: "rejected" })
    .eq("id", variationId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── launchAdCampaign ─────────────────────────────────────────────────────────

export async function launchAdCampaign(
  userId: string,
  campaignId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
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
  const { error: updateError } = await supabase
    .from("ad_campaigns")
    .update({
      status: "launching",
      kernel_event_id: null, // Will be set by kernel event
    })
    .eq("id", campaignId)

  if (updateError) {
    return { success: false, error: updateError.message }
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

export async function updateCampaignStatus(
  userId: string,
  campaignId: string,
  brokerageId: string,
  newStatus: "draft" | "pending_review" | "approved" | "active" | "paused" | "completed"
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { error } = await supabase
    .from("ad_campaigns")
    .update({ status: newStatus })
    .eq("id", campaignId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── getCampaignCreatives ─────────────────────────────────────────────────────

export async function getCampaignCreatives(
  campaignId: string,
  brokerageId: string
): Promise<{ success: boolean; creatives?: any[]; error?: string }> {
  const supabase = await createClient()

  const { data: creatives, error } = await supabase
    .from("ad_creative_variations")
    .select("*")
    .eq("ad_campaign_id", campaignId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, creatives: creatives || [] }
}
