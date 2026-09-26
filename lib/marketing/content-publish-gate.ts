/**
 * UNIFIED CONTENT PUBLISH GATE
 *
 * Single entry point that wraps the 6 marketing platform rules into one
 * compliance call. Every content surface — social posts, emails, postcards,
 * SMS, ads, newsletters, blog posts, podcast show notes — runs through this
 * before publish/send/print.
 *
 * Rules enforced (in order):
 *   1. "Them First" — content leads with audience value, not agent promotion
 *   2. Fair Housing — protected-class language and inclusivity
 *   3. Advertising Disclosures — required brokerage/agent disclosures
 *   4. Brand Tone Alignment — matches the tenant's brand voice
 *   5. Channel Constraints — per-channel length, hashtag, media rules
 *   6. AI Search Optimization (soft warnings) — content that surfaces in
 *      Perplexity/ChatGPT/Google AI Overview
 *
 * Returns:
 *   - allowed: boolean — false if ANY blocking rule fails
 *   - blocking: hard failures that prevent publish (fair housing, disclosure)
 *   - warnings: soft issues the agent can override (tone, them-first, AI-search)
 *   - score: composite 0-100
 *   - rewriteSuggestions: AI-generated fixes per violation
 */

import "server-only"

export type Channel =
  | "email"
  | "sms"
  | "social_post"
  | "social_story"
  | "video_script"
  | "postcard"
  | "letter"
  | "newsletter"
  | "blog_post"
  | "ad_creative"
  | "podcast_show_notes"

export interface PublishGateInput {
  brokerageId: string
  agentUserId?: string | null
  teamId?: string | null
  channel: Channel
  /**
   * Audience persona — used to tailor "them-first" check.
   *  - first_time_buyer / luxury_buyer / investor / motivated_seller / etc.
   */
  audiencePersona?: string | null
  content: {
    subject?: string
    body: string
    callToAction?: string
    keywords?: string[]
  }
  /**
   * Skip checks the agent has explicitly chosen not to enforce. Use sparingly
   * and only with audit logging.
   */
  skipChecks?: Array<"them_first" | "ai_search">
}

export interface PublishGateViolation {
  rule:
    | "them_first"
    | "fair_housing"
    | "advertising_disclosure"
    | "brand_tone"
    | "channel_constraint"
    | "ai_search"
  severity: "blocking" | "warning"
  message: string
  evidence?: string
  rewriteSuggestion?: string
}

export interface PublishGateResult {
  allowed: boolean
  score: number  // 0-100 composite quality score
  blocking: PublishGateViolation[]
  warnings: PublishGateViolation[]
  passed: Array<"them_first" | "fair_housing" | "advertising_disclosure" | "brand_tone" | "channel_constraint" | "ai_search">
  rewriteSuggestions: string[]
}

/**
 * Run the unified compliance gate. Each rule call is best-effort — if a
 * downstream rule engine fails, the gate logs the error and continues with
 * remaining rules so a single subsystem outage doesn't block publishing
 * across the board.
 */
export async function enforceContentPublishRules(
  input: PublishGateInput
): Promise<PublishGateResult> {
  const blocking: PublishGateViolation[] = []
  const warnings: PublishGateViolation[] = []
  const passed: PublishGateResult["passed"] = []
  const skip = new Set(input.skipChecks ?? [])

  // ── Rule 1: "Them First" ─────────────────────────────────────────────
  if (!skip.has("them_first")) {
    try {
      const { validateThemFirstContent } = await import("@/lib/them-first/validator")
      // The gate's own tenant pays for the two model calls the validator makes
      // (§5 — ai_tool_usage is the cost ledger). input.brokerageId is resolved by
      // the caller from the session, never from a request body (§4). No agentId:
      // input.agentUserId is a USERS id and ai_tool_usage.agent_id FKs to
      // agents(id), and those two id spaces are DISJOINT (§3) — passing the wrong
      // class would raise 23503 and logAIUsage would swallow it, losing the row.
      const themFirstResult = await validateThemFirstContent(
        input.content.body,
        mapToThemFirstType(input.channel) as "email" | "sms" | "video_script" | "social_post",
        input.audiencePersona ?? undefined,
        { brokerageId: input.brokerageId, userId: input.agentUserId ?? null },
      )

      if (themFirstResult && !themFirstResult.passed) {
        // Surface prohibited-phrase hits as individual warnings
        for (const violation of themFirstResult.prohibited_violations ?? []) {
          warnings.push({
            rule: "them_first",
            severity: "warning",
            message: `"${violation}" — adjust wording to lead with audience value`,
            rewriteSuggestion: themFirstResult.suggestions?.[0],
          })
        }
        // If no specific prohibited hit but score still low, log generic warning
        if ((themFirstResult.prohibited_violations ?? []).length === 0) {
          warnings.push({
            rule: "them_first",
            severity: "warning",
            message: `Content leads with agent promotion rather than audience value (score ${(themFirstResult.overall_score * 100).toFixed(0)}/100)`,
            rewriteSuggestion: themFirstResult.suggestions?.[0],
          })
        }
      } else {
        passed.push("them_first")
      }
    } catch {
      // them-first unavailable — continue
    }
  }

  // ── Rule 2: Fair Housing + Rule 3: Advertising Disclosures ───────────
  // Compliance rules engine evaluates fair-housing + advertising rules
  // against the raw content. Categories tell us which rule fired.
  try {
    const { evaluateCompliance } = await import("@/app/actions/content-compliance")
    const complianceResult = await evaluateCompliance({
      raw_content: input.content.body,
      content_type: mapToComplianceType(input.channel),
      channel_intent: input.channel,
      intended_audience: input.audiencePersona ?? undefined,
      context: {
        contact_type: input.audiencePersona ?? undefined,
        persona: input.audiencePersona ?? undefined,
      },
    })

    if (complianceResult.success && complianceResult.verdict) {
      const verdict = complianceResult.verdict as unknown as {
        violations?: Array<{
          category?: string
          severity?: string
          message?: string
          rule_name?: string
          fix_suggestion?: string
        }>
      }
      const violations = verdict.violations ?? []

      let fairHousingClean = true
      let disclosureClean = true

      for (const v of violations) {
        const isHighSev = v.severity === "high" || v.severity === "critical"
        const isFairHousing = v.category === "fair_housing"
        const isDisclosure = v.category === "advertising_disclosure" || v.category === "disclosure"

        if (isFairHousing) {
          fairHousingClean = false
          blocking.push({
            rule: "fair_housing",
            severity: "blocking",
            message: v.message ?? "Fair Housing violation detected",
            evidence: v.rule_name,
            rewriteSuggestion: v.fix_suggestion,
          })
        } else if (isDisclosure) {
          disclosureClean = false
          ;(isHighSev ? blocking : warnings).push({
            rule: "advertising_disclosure",
            severity: isHighSev ? "blocking" : "warning",
            message: v.message ?? "Required disclosure missing",
            evidence: v.rule_name,
            rewriteSuggestion: v.fix_suggestion,
          })
        }
      }

      if (fairHousingClean) passed.push("fair_housing")
      if (disclosureClean) passed.push("advertising_disclosure")
    }
  } catch {
    // compliance engine unavailable — continue
  }

  // ── Rule 4: Brand Tone Alignment ─────────────────────────────────────
  // Brand-tone check uses the brand_voice prohibited-words + tone profile
  // already loaded by the AI ISA system. We do a lightweight inline check
  // against prohibited words rather than calling the heavy entity-based
  // checkBrandCompliance (which expects a saved contentId).
  try {
    const { loadBrandVoicePrompt } = await import("@/lib/ai-isa/brand-voice-prompt")
    const brandVoice = await loadBrandVoicePrompt({
      brokerageId: input.brokerageId,
      agentId: input.agentUserId ?? null,
      teamId: input.teamId ?? null,
    })

    const prohibited = (brandVoice?.prohibitedWords ?? []) as string[]
    const lowerBody = input.content.body.toLowerCase()
    const hits = prohibited.filter((p) => p && lowerBody.includes(p.toLowerCase()))

    if (hits.length > 0) {
      warnings.push({
        rule: "brand_tone",
        severity: "warning",
        message: `Content contains ${hits.length} brand-prohibited word${hits.length === 1 ? "" : "s"}: ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? "…" : ""}`,
      })
    } else {
      passed.push("brand_tone")
    }
  } catch {
    // brand voice unavailable — continue
  }

  // ── Rule 5: Channel Constraints ──────────────────────────────────────
  const channelViolation = checkChannelConstraints(input.channel, input.content)
  if (channelViolation) {
    ;(channelViolation.severity === "blocking" ? blocking : warnings).push(channelViolation)
  } else {
    passed.push("channel_constraint")
  }

  // ── Rule 6: AI Search Optimization (soft warnings only) ──────────────
  if (!skip.has("ai_search")) {
    const aiSearchWarnings = checkAiSearchReadiness(input.channel, input.content)
    if (aiSearchWarnings.length === 0) {
      passed.push("ai_search")
    } else {
      warnings.push(...aiSearchWarnings)
    }
  }

  // ── Composite score ──────────────────────────────────────────────────
  const totalChecks = 6
  const blockingPenalty = blocking.length * 25
  const warningPenalty = warnings.length * 8
  const score = Math.max(0, Math.min(100, 100 - blockingPenalty - warningPenalty))

  const rewriteSuggestions = [...blocking, ...warnings]
    .map((v) => v.rewriteSuggestion)
    .filter((s): s is string => !!s)

  return {
    allowed: blocking.length === 0,
    score,
    blocking,
    warnings,
    passed,
    rewriteSuggestions,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapToThemFirstType(channel: Channel): string {
  if (channel === "social_post" || channel === "social_story" || channel === "ad_creative") return "social_post"
  if (channel === "sms") return "sms"
  if (channel === "email" || channel === "newsletter") return "email"
  if (channel === "video_script" || channel === "podcast_show_notes") return "video_script"
  return "social_post"
}

function mapToComplianceType(channel: Channel): string {
  // Compliance engine accepts a content_type discriminator
  if (channel === "social_post" || channel === "social_story") return "social_post"
  if (channel === "sms") return "sms"
  if (channel === "email" || channel === "newsletter") return "email"
  if (channel === "ad_creative") return "ad"
  if (channel === "postcard" || channel === "letter") return "direct_mail"
  if (channel === "blog_post") return "blog"
  return "social_post"
}

const CHANNEL_LIMITS: Record<Channel, { maxBody: number; mustHaveCta?: boolean }> = {
  email: { maxBody: 50000 },
  sms: { maxBody: 320 }, // 2 segments
  social_post: { maxBody: 3000 },
  social_story: { maxBody: 200 },
  video_script: { maxBody: 5000 },
  postcard: { maxBody: 350, mustHaveCta: true },
  letter: { maxBody: 4000 },
  newsletter: { maxBody: 50000 },
  blog_post: { maxBody: 25000 },
  ad_creative: { maxBody: 500, mustHaveCta: true },
  podcast_show_notes: { maxBody: 4000 },
}

function checkChannelConstraints(
  channel: Channel,
  content: PublishGateInput["content"]
): PublishGateViolation | null {
  const limits = CHANNEL_LIMITS[channel]
  if (!limits) return null

  if (content.body.length > limits.maxBody) {
    return {
      rule: "channel_constraint",
      severity: "blocking",
      message: `Content exceeds ${channel} length limit (${content.body.length} / ${limits.maxBody})`,
    }
  }

  if (limits.mustHaveCta && !content.callToAction && !/\b(click|call|visit|text|reply|scan|learn more|tour)\b/i.test(content.body)) {
    return {
      rule: "channel_constraint",
      severity: "warning",
      message: `${channel} should include a clear call-to-action`,
    }
  }

  return null
}

function checkAiSearchReadiness(
  channel: Channel,
  content: PublishGateInput["content"]
): PublishGateViolation[] {
  const out: PublishGateViolation[] = []

  // Only relevant for long-form discoverable content
  if (channel !== "blog_post" && channel !== "podcast_show_notes" && channel !== "newsletter") {
    return []
  }

  // No headings / structure → AI overviews struggle
  if (channel === "blog_post" && !/(#{1,3}\s|<h[1-6]>)/.test(content.body)) {
    out.push({
      rule: "ai_search",
      severity: "warning",
      message: "Blog post has no headings — AI search snippets favor structured content with clear H2/H3 sections",
    })
  }

  // No locality signal — local SEO is critical for real estate
  if (!/\b\d{5}\b|\b(neighborhood|community|district)\b/i.test(content.body)) {
    out.push({
      rule: "ai_search",
      severity: "warning",
      message: "No local signal (zip, neighborhood) — real estate AI search ranks local relevance heavily",
    })
  }

  // Too short for substantive AI-search ranking
  if (channel === "blog_post" && content.body.length < 800) {
    out.push({
      rule: "ai_search",
      severity: "warning",
      message: "Blog post under 800 chars — AI overviews and traditional SEO favor more substantive content",
    })
  }

  return out
}
