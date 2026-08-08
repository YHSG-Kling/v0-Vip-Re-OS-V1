"use server"

// lib/ads/ad-monitor.ts
// Layer 9.4 — Competitive Ad + Post Monitor
// Kernel gates: canAccessFeature('competitor_monitor'), NO outbound publishing
// processKernelEvent(COMPETITOR_CONTENT_ALERTED) when severity >= 'high'

import { createClient } from "@/lib/supabase/server"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateText } from "ai"

// ─── TYPES ────────────────────────────────────────────────────────────────────

// PLATFORM VOCABULARIES — verified against the LIVE CHECK constraints, which are
// DIFFERENT for the two tables and did not match these unions:
//   competitor_ads_source_platform_check   → facebook | instagram | google
//   competitor_posts_source_platform_check → facebook | instagram | linkedin | x | youtube | tiktok
// The ad union previously offered 'linkedin' and 'tiktok', which the ads CHECK
// rejects (23514) — those branches were unreachable, and any caller taking the type
// at its word would have hit an opaque database error. The post union offered
// 'twitter', which the posts CHECK also rejects (the live vocabulary is 'x'), and
// omitted the 'x' and 'youtube' values it does admit.
export type CompetitorAdPlatform = "facebook" | "instagram" | "google"
export type CompetitorPostPlatform =
  | "facebook" | "instagram" | "linkedin" | "x" | "youtube" | "tiktok"

export const COMPETITOR_AD_PLATFORMS: readonly CompetitorAdPlatform[] = [
  "facebook", "instagram", "google",
] as const
export const COMPETITOR_POST_PLATFORMS: readonly CompetitorPostPlatform[] = [
  "facebook", "instagram", "linkedin", "x", "youtube", "tiktok",
] as const

export interface IngestCompetitorAdParams {
  /** Ignored — the tenant is resolved from the session by requireBrokerage(). */
  brokerageId?: string
  sourcePlatform: CompetitorAdPlatform
  competitorName: string
  adHeadline: string
  adCopy: string
  mediaUrl?: string
  landingPageUrl?: string
  rawPayload?: Record<string, unknown>
}

export interface IngestCompetitorPostParams {
  /** Ignored — the tenant is resolved from the session by requireBrokerage(). */
  brokerageId?: string
  sourcePlatform: CompetitorPostPlatform
  competitorName: string
  postCaption: string
  mediaUrl?: string
  postUrl?: string
  publishedAt?: string
  rawPayload?: Record<string, unknown>
}

export interface Insight {
  insightType: string
  insightSummary: string
  confidenceScore: number
}

export interface CompetitorAd {
  id: string
  brokerage_id: string
  source_platform: string
  competitor_name: string
  ad_headline: string
  ad_copy: string
  media_url: string | null
  landing_page_url: string | null
  first_seen_at: string
  last_seen_at: string
  raw_payload: Record<string, unknown> | null
}

export interface CompetitorPost {
  id: string
  brokerage_id: string
  source_platform: string
  competitor_name: string
  post_caption: string
  media_url: string | null
  post_url: string | null
  published_at: string | null
  first_seen_at: string
  raw_payload: Record<string, unknown> | null
}

export interface AdInsight {
  id: string
  brokerage_id: string
  source_type: string
  source_id: string | null
  insight_type: string
  insight_summary: string
  confidence_score: number
  created_at: string
}

export interface TrendAlert {
  id: string
  brokerage_id: string
  source_table: string
  source_id: string | null
  alert_type: string
  alert_message: string
  severity: "low" | "medium" | "high" | "critical"
  is_resolved: boolean
  resolved_at: string | null
  created_at: string
}

/**
 * Session gate for the ingest writers below.
 *
 * NOT EXPORTED. This module carries `"use server"`, so **every exported async
 * function in it is a publicly reachable HTTP endpoint**, lib/ directory or not.
 * Exporting a helper here would mint another one.
 *
 * The `canAccessFeature(params.brokerageId, …)` call the writers already had is
 * an ENTITLEMENT check, not an authentication check — it answers "is this
 * brokerage's plan allowed the competitor monitor", which any caller satisfies by
 * naming a brokerage whose plan is. It never established who was asking.
 */
async function requireBrokerage(): Promise<
  { ok: true; brokerageId: string } | { ok: false; error: string }
> {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
  return { ok: true, brokerageId: ctx.brokerageId }
}

// ─── INGEST COMPETITOR AD ─────────────────────────────────────────────────────

/**
 * GATED + SESSION-SCOPED (was neither). `brokerageId` came from the caller and
 * nothing authenticated the request, so anyone could write arbitrary rows —
 * `competitor_name`, `ad_headline`, `ad_copy`, and a free-form `raw_payload`
 * jsonb — into any tenant's `competitor_ads` table.
 *
 * That is worse than ordinary tenant pollution, because `generateInsights` in
 * this same file reads these rows back and feeds `ad_copy` into an LLM prompt.
 * An unauthenticated writer into a table that is later prompted from is a
 * **prompt-injection channel into another tenant's AI spend**, not just bad data.
 */
export async function ingestCompetitorAd(
  params: IngestCompetitorAdParams
): Promise<{ success: boolean; adId?: string; error?: string }> {
  try {
    const gate = await requireBrokerage()
    if (!gate.ok) return { success: false, error: gate.error }
    const brokerageId = gate.brokerageId

    const supabase = await createClient()

    // Kernel gate: canAccessFeature (entitlement, on the RESOLVED brokerage)
    const accessResult = await canAccessFeature(brokerageId, "competitor_monitor")
    if (!accessResult.allowed) {
      return { success: false, error: accessResult.reason || "Feature access denied" }
    }

    // Upsert on (brokerage_id, source_platform, ad_headline) updating last_seen_at
    const { data: existing, error: checkError } = await supabase
      .from("competitor_ads")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("source_platform", params.sourcePlatform)
      .eq("ad_headline", params.adHeadline)
      .maybeSingle()

    if (checkError && checkError.code !== "PGRST116") {
      return { success: false, error: checkError.message }
    }

    if (existing) {
      // Update last_seen_at
      const { error: updateError } = await supabase
        .from("competitor_ads")
        .update({
          last_seen_at: new Date().toISOString(),
          ad_copy: params.adCopy,
          media_url: params.mediaUrl || null,
          landing_page_url: params.landingPageUrl || null,
          raw_payload: params.rawPayload || null,
        })
        .eq("id", existing.id)

      if (updateError) {
        return { success: false, error: updateError.message }
      }

      return { success: true, adId: existing.id }
    }

    // Insert new
    const { data, error } = await supabase
      .from("competitor_ads")
      .insert({
        brokerage_id: brokerageId,
        source_platform: params.sourcePlatform,
        competitor_name: params.competitorName,
        ad_headline: params.adHeadline,
        ad_copy: params.adCopy,
        media_url: params.mediaUrl || null,
        landing_page_url: params.landingPageUrl || null,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        raw_payload: params.rawPayload || null,
      })
      .select("id")
      .single()

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, adId: data.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── INGEST COMPETITOR POST ───────────────────────────────────────────────────

/**
 * GATED + SESSION-SCOPED (was neither) — same defect and same fix as
 * `ingestCompetitorAd` above. `post_caption` is the field `generateInsights`
 * later prompts from, so the unauthenticated-writer-feeding-an-LLM concern
 * applies here identically.
 */
export async function ingestCompetitorPost(
  params: IngestCompetitorPostParams
): Promise<{ success: boolean; postId?: string; error?: string }> {
  try {
    const gate = await requireBrokerage()
    if (!gate.ok) return { success: false, error: gate.error }
    const brokerageId = gate.brokerageId

    const supabase = await createClient()

    // Kernel gate: canAccessFeature (entitlement, on the RESOLVED brokerage)
    const accessResult = await canAccessFeature(brokerageId, "competitor_monitor")
    if (!accessResult.allowed) {
      return { success: false, error: accessResult.reason || "Feature access denied" }
    }

    const { data, error } = await supabase
      .from("competitor_posts")
      .insert({
        brokerage_id: brokerageId,
        source_platform: params.sourcePlatform,
        competitor_name: params.competitorName,
        post_caption: params.postCaption,
        media_url: params.mediaUrl || null,
        post_url: params.postUrl || null,
        published_at: params.publishedAt || null,
        first_seen_at: new Date().toISOString(),
        raw_payload: params.rawPayload || null,
      })
      .select("id")
      .single()

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, postId: data.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── GENERATE INSIGHTS ────────────────────────────────────────────────────────

export async function generateInsights(
  brokerageId: string
): Promise<{ success: boolean; insights?: Insight[]; error?: string }> {
  try {
    const supabase = await createClient()

    // Kernel gate: canAccessFeature
    const accessResult = await canAccessFeature(brokerageId, "competitor_monitor")
    if (!accessResult.allowed) {
      return { success: false, error: accessResult.reason || "Feature access denied" }
    }

    // Step 1: SELECT last 20 competitor_ads + last 20 competitor_posts for this brokerage
    const { data: recentAds, error: adsError } = await supabase
      .from("competitor_ads")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("first_seen_at", { ascending: false })
      .limit(20)

    if (adsError) {
      return { success: false, error: adsError.message }
    }

    const { data: recentPosts, error: postsError } = await supabase
      .from("competitor_posts")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("first_seen_at", { ascending: false })
      .limit(20)

    if (postsError) {
      return { success: false, error: postsError.message }
    }

    if ((!recentAds || recentAds.length === 0) && (!recentPosts || recentPosts.length === 0)) {
      return { success: true, insights: [] }
    }

    // Step 2: Build Claude API prompt
    const provider = await resolveProvider({ providerType: "ai", actorContext: { userId: "", brokerageId } })

    const adsForPrompt = (recentAds || []).map((ad) => ({
      platform: ad.source_platform,
      competitor: ad.competitor_name,
      headline: ad.ad_headline,
      copy: ad.ad_copy,
      landingPage: ad.landing_page_url,
    }))

    const postsForPrompt = (recentPosts || []).map((post) => ({
      platform: post.source_platform,
      competitor: post.competitor_name,
      caption: post.post_caption,
      url: post.post_url,
      publishedAt: post.published_at,
    }))

    const systemPrompt = `You are a competitive intelligence analyst specializing in real estate marketing. Analyze competitor content and provide actionable insights.`

    const userPrompt = `Analyze these real estate competitor ads and posts. Return ONLY valid JSON with no extra text:

COMPETITOR ADS:
${JSON.stringify(adsForPrompt, null, 2)}

COMPETITOR POSTS:
${JSON.stringify(postsForPrompt, null, 2)}

Return EXACTLY this JSON structure:
{
  "copyTrends": ["string array of messaging trends"],
  "creativeTrends": ["string array of visual/format trends"],
  "cadencePattern": "string describing posting frequency patterns",
  "ctaStyle": "string describing call-to-action styles used",
  "topPerformingAngles": ["string array of marketing angles that appear most used"],
  "recommendations": ["string array of actionable recommendations for your client"]
}

Be specific to real estate marketing. Identify patterns like:
- Emotional vs. value-driven messaging
- Video vs. static imagery trends
- Seasonal or market-specific themes
- Price anchoring strategies
- Lead generation tactics`

    const { text } = await generateText({
      model: provider.providerKey,
      system: systemPrompt,
      prompt: userPrompt,
      maxOutputTokens: 2000,
    })

    // Parse the JSON response
    let analysis: {
      copyTrends: string[]
      creativeTrends: string[]
      cadencePattern: string
      ctaStyle: string
      topPerformingAngles: string[]
      recommendations: string[]
    }

    try {
      // Extract JSON from potential markdown code blocks
      let jsonStr = text
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim()
      }
      analysis = JSON.parse(jsonStr)
    } catch {
      return { success: false, error: "Failed to parse AI response as JSON" }
    }

    // Step 3: INSERT ad_insights for each insight
    const insights: Insight[] = []

    // Copy trends
    for (const trend of analysis.copyTrends || []) {
      insights.push({
        insightType: "copy_trend",
        insightSummary: trend,
        confidenceScore: 0.75,
      })
    }

    // Creative trends
    for (const trend of analysis.creativeTrends || []) {
      insights.push({
        insightType: "creative_trend",
        insightSummary: trend,
        confidenceScore: 0.75,
      })
    }

    // Cadence pattern
    if (analysis.cadencePattern) {
      insights.push({
        insightType: "cadence_pattern",
        insightSummary: analysis.cadencePattern,
        confidenceScore: 0.70,
      })
    }

    // CTA style
    if (analysis.ctaStyle) {
      insights.push({
        insightType: "cta_style",
        insightSummary: analysis.ctaStyle,
        confidenceScore: 0.70,
      })
    }

    // Top performing angles
    for (const angle of analysis.topPerformingAngles || []) {
      insights.push({
        insightType: "top_angle",
        insightSummary: angle,
        confidenceScore: 0.80,
      })
    }

    // Recommendations
    for (const rec of analysis.recommendations || []) {
      insights.push({
        insightType: "recommendation",
        insightSummary: rec,
        confidenceScore: 0.85,
      })
    }

    // Insert all insights
    for (const insight of insights) {
      const { error: insertError } = await supabase.from("ad_insights").insert({
        brokerage_id: brokerageId,
        source_type: "competitor_analysis",
        source_id: null,
        insight_type: insight.insightType,
        insight_summary: insight.insightSummary,
        confidence_score: insight.confidenceScore,
      })

      if (insertError) {
        console.error("Failed to insert insight:", insertError)
      }

      // Step 4: If new insight has insight_type = 'competitor_launch' or 'creative_trend':
      // INSERT trend_alerts with appropriate alert_type and severity
      if (insight.insightType === "competitor_launch" || insight.insightType === "creative_trend") {
        const severity = insight.insightType === "competitor_launch" ? "high" : "medium"

        const { data: alertData, error: alertError } = await supabase
          .from("trend_alerts")
          .insert({
            brokerage_id: brokerageId,
            source_table: "ad_insights",
            source_id: null,
            alert_type: insight.insightType,
            alert_message: insight.insightSummary,
            severity,
            is_resolved: false,
          })
          .select("id")
          .single()

        if (alertError) {
          console.error("Failed to insert trend alert:", alertError)
        }

        // Fire kernel event for high severity
        if (severity === "high") {
          await processKernelEvent({
            event: KernelEvent.COMPETITOR_CONTENT_ALERTED,
            brokerageId,
            entityType: "ad_insight",
            entityId: alertData?.id ?? "unknown",
          })
        }
      }
    }

    return { success: true, insights }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── RESOLVE ALERT ────────────────────────────────────────────────────────────

export async function resolveAlert(
  alertId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("trend_alerts")
      .update({
        is_resolved: true,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", alertId)

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── GET COMPETITOR ADS ───────────────────────────────────────────────────────

export async function getCompetitorAds(
  brokerageId: string
): Promise<{ success: boolean; ads?: CompetitorAd[]; error?: string }> {
  try {
    const supabase = await createClient()

    const accessResult = await canAccessFeature(brokerageId, "competitor_monitor")
    if (!accessResult.allowed) {
      return { success: false, error: accessResult.reason || "Feature access denied" }
    }

    const { data, error } = await supabase
      .from("competitor_ads")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("first_seen_at", { ascending: false })

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, ads: data || [] }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── GET COMPETITOR POSTS ─────────────────────────────────────────────────────

export async function getCompetitorPosts(
  brokerageId: string
): Promise<{ success: boolean; posts?: CompetitorPost[]; error?: string }> {
  try {
    const supabase = await createClient()

    const accessResult = await canAccessFeature(brokerageId, "competitor_monitor")
    if (!accessResult.allowed) {
      return { success: false, error: accessResult.reason || "Feature access denied" }
    }

    const { data, error } = await supabase
      .from("competitor_posts")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("first_seen_at", { ascending: false })

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, posts: data || [] }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── GET AD INSIGHTS ──────────────────────────────────────────────────────────

export async function getAdInsights(
  brokerageId: string
): Promise<{ success: boolean; insights?: AdInsight[]; error?: string }> {
  try {
    const supabase = await createClient()

    const accessResult = await canAccessFeature(brokerageId, "competitor_monitor")
    if (!accessResult.allowed) {
      return { success: false, error: accessResult.reason || "Feature access denied" }
    }

    const { data, error } = await supabase
      .from("ad_insights")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, insights: data || [] }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── GET TREND ALERTS ─────────────────────────────────────────────────────────

export async function getTrendAlerts(
  brokerageId: string
): Promise<{ success: boolean; alerts?: TrendAlert[]; error?: string }> {
  try {
    const supabase = await createClient()

    const accessResult = await canAccessFeature(brokerageId, "competitor_monitor")
    if (!accessResult.allowed) {
      return { success: false, error: accessResult.reason || "Feature access denied" }
    }

    const { data, error } = await supabase
      .from("trend_alerts")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, alerts: data || [] }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}
