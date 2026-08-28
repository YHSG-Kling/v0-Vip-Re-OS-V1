"use server"

/**
 * generate-social-post.ts
 *
 * AI social post and contextual draft generator.
 *
 * Brand Voice resolution follows the kernel hierarchy (brokerage → team → agent).
 * Every generated post goes through the compliance kernel before being returned:
 *   1. enforceCompliance()     — 5-gate outbound check (brand voice, fair housing,
 *                                them-first, TCPA n/a for social, authority n/a for social)
 *   2. checkBrandCompliance()  — stamps social_posts.brand_compliance_passed after save
 *
 * AI model: resolveModel("anthropic/claude-sonnet-4-20250514") per rule 9.
 * Database: Supabase — uses maybeSingle(), never single().
 */

import { generateObject, type GeneratedUsage } from "@/lib/ai/generate"
import { friendlyAiError } from "@/lib/ai/ai-error"
import { z } from "zod"
import { resolveModel } from "@/lib/ai/resolve-model"
import { createClient } from "@/lib/supabase/server"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import {
  isPriceImprovementEvent,
  priceImprovementLabel,
  publicPriceEventLabel,
} from "@/lib/listings/price-improvement-label"

// ─── TYPES ────────────────────────────────────────────────────────────────────

const GeneratedPostSchema = z.object({
  content:              z.string().describe("Full social media post body, ready to publish"),
  hashtags:             z.array(z.string()).describe("5-15 relevant hashtags without the # prefix"),
  hook:                 z.string().describe("The opening line / hook of the post"),
  cta:                  z.string().describe("Call to action at the end of the post"),
  estimated_engagement: z.enum(["low", "medium", "high"]).describe("AI confidence in engagement level"),
})

export type GeneratedPost = z.infer<typeof GeneratedPostSchema>

interface BrandVoiceRow {
  tone: string | null
  formality_level: string | null
  preferred_words: string[] | null
  prohibited_words: string[] | null
  key_brand_messages: string[] | null
  custom_instructions: string | null
  tagline: string | null
  mission_statement: string | null
}

/**
 * Merge two brand voice rows — most-specific scope wins for scalar fields;
 * array fields accumulate (brokerage + agent prohibited/preferred).
 */
function mergeBrandVoice(base: BrandVoiceRow, override: Partial<BrandVoiceRow>): BrandVoiceRow {
  return {
    tone:               override.tone               ?? base.tone,
    formality_level:    override.formality_level    ?? base.formality_level,
    key_brand_messages: override.key_brand_messages?.length ? override.key_brand_messages : base.key_brand_messages,
    prohibited_words:   [...(base.prohibited_words ?? []), ...(override.prohibited_words ?? [])],
    preferred_words:    [...(base.preferred_words  ?? []), ...(override.preferred_words  ?? [])],
    tagline:            override.tagline            ?? base.tagline,
    mission_statement:  override.mission_statement  ?? base.mission_statement,
    custom_instructions: override.custom_instructions ?? base.custom_instructions,
  }
}

const EMPTY_BRAND_VOICE: BrandVoiceRow = {
  tone: null, formality_level: null, preferred_words: null,
  prohibited_words: null, key_brand_messages: null,
  custom_instructions: null, tagline: null, mission_statement: null,
}

/**
 * Resolve brand voice using the 3-level hierarchy:
 *   1. Brokerage (base) → 2. Team (override) → 3. Agent (most-specific override)
 * Mirrors lib/kernel/brand-voice.ts loadResolvedBrandVoice() exactly.
 */
async function resolveBrandVoice(
  brokerageId: string,
  agentId?: string,
  teamId?: string
): Promise<BrandVoiceRow> {
  const supabase = await createClient()
  const SELECT = "tone, formality_level, preferred_words, prohibited_words, key_brand_messages, custom_instructions, tagline, mission_statement"
  let resolved: BrandVoiceRow = { ...EMPTY_BRAND_VOICE }

  // 1. Brokerage-level profile (agent_id IS NULL, team_id IS NULL)
  if (brokerageId) {
    const { data: brokProfile } = await supabase
      .from("brand_voice_profile")
      .select(SELECT)
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .is("team_id", null)
      .eq("is_active", true)
      .maybeSingle()

    if (brokProfile) resolved = mergeBrandVoice(resolved, brokProfile as BrandVoiceRow)
  }

  // 2. Team-level profile
  if (teamId) {
    const { data: teamProfile } = await supabase
      .from("brand_voice_profile")
      .select(SELECT)
      .eq("team_id", teamId)
      .is("agent_id", null)
      .eq("is_active", true)
      .maybeSingle()

    if (teamProfile) resolved = mergeBrandVoice(resolved, teamProfile as BrandVoiceRow)
  }

  // 3. Agent-level profile (most specific — overrides all).
  // pass 13: brand_voice_profile.agent_id FKs agents(id) but callers pass the
  // auth users.id (SequenceBuilder → assist bar) — resolve tolerantly.
  if (agentId) {
    const { data: bvpAgentRow } = await supabase
      .from("agents").select("id")
      .or(`id.eq.${agentId},user_id.eq.${agentId}`)
      .maybeSingle()
    const { data: agentProfile } = await supabase
      .from("brand_voice_profile")
      .select(SELECT)
      .eq("agent_id", bvpAgentRow?.id ?? agentId)
      .eq("is_active", true)
      .maybeSingle()

    if (agentProfile) resolved = mergeBrandVoice(resolved, agentProfile as BrandVoiceRow)
  }

  return resolved
}

// ─── PLATFORM CHARACTER LIMITS ────────────────────────────────────────────────

const CHAR_LIMITS: Record<string, number> = {
  facebook:  63000,
  instagram: 2200,
  linkedin:  3000,
  twitter:   280,
  tiktok:    2200,
}

// ─── GENERATE SOCIAL POST ─────────────────────────────────────────────────────

export async function generateSocialPostContent(params: {
  brief: string
  platform: string
  tone?: string
  contentType?: string
  listingId?: string
  brokerageId: string
  agentId: string
  teamId?: string
}): Promise<{
  success: boolean
  data?: GeneratedPost
  complianceBlocked?: boolean
  complianceViolations?: string[]
  error?: string
  /** REAL provider token counts for this call. ADDITIVE — see GeneratedUsage.
   *  This lane books nothing (the generateObject shim never calls logAIUsage),
   *  so a caller that ledgers a run of this generator MUST take the figure from
   *  here rather than inventing one. Absent when no model call was made. */
  usage?: GeneratedUsage
}> {
  try {
    const supabase = await createClient()

    // ── 1. Resolve brand voice (3-level hierarchy) ───────────────────────────
    const brandVoice = await resolveBrandVoice(params.brokerageId, params.agentId, params.teamId)

    // ── 2. Get listing context if provided ───────────────────────────────────
    let listingContext = ""
    if (params.listingId) {
      const { data: listing } = await supabase
        .from("listings")
        .select("address, city, state, list_price, bedrooms, bathrooms, sqft")
        .eq("id", params.listingId)
        .maybeSingle()

      if (listing) {
        listingContext = `\nListing: ${listing.address}, ${listing.city}, ${listing.state} — $${listing.list_price?.toLocaleString()}, ${listing.bedrooms}BR/${listing.bathrooms}BA/${listing.sqft}sqft`
      }
    }

    const charLimit = CHAR_LIMITS[params.platform] ?? 2200

    // ── 3. Build prompts from resolved brand voice ───────────────────────────
    const systemPrompt = [
      `You are an expert real estate social media strategist.`,
      `Write posts using the "Them First" framework: 40% empathy, 25% trust, 25% value, 10% solution.`,
      `NEVER use fair housing violations or protected-class language.`,
      `NEVER make guarantees about home values or investment returns.`,
      `NEVER use deceptive urgency tactics.`,
      // RENDER BOUNDARY (§6). `contentType` is the RAW social_posts.post_type
      // CHECK value, so a price post used to hand the writer the literal string
      // "price_reduction" (see the userPrompt below) and the model wrote it
      // straight into a PUBLIC caption. Owner ruling: the public word is a price
      // improvement. The stored value itself is untouched — only what the writer
      // is told to SAY.
      isPriceImprovementEvent(params.contentType)
        ? `This post announces a lowered list price. NEVER write "price reduction", "price reduced", "price drop" or "price cut" — call it a ${priceImprovementLabel("sentence")}.`
        : "",
      brandVoice.prohibited_words?.length
        ? `NEVER use these words: ${brandVoice.prohibited_words.join(", ")}.`
        : "",
      brandVoice.custom_instructions ?? "",
      brandVoice.mission_statement
        ? `Brand mission: ${brandVoice.mission_statement}`
        : "",
      brandVoice.tagline
        ? `Tagline to optionally weave in: "${brandVoice.tagline}"`
        : "",
    ].filter(Boolean).join("\n")

    const userPrompt = [
      `Create a ${params.platform} social media post.`,
      `Brief: ${params.brief}`,
      `Content type: ${publicPriceEventLabel(params.contentType, "noun") ?? params.contentType ?? "general"}`,
      `Tone: ${params.tone ?? brandVoice.tone ?? "professional and warm"}`,
      `Formality: ${brandVoice.formality_level ?? "conversational"}`,
      `Character limit: ${charLimit}`,
      listingContext,
      brandVoice.key_brand_messages?.length
        ? `Key brand messages to incorporate: ${brandVoice.key_brand_messages.join("; ")}`
        : "",
      brandVoice.preferred_words?.length
        ? `Preferred words/phrases: ${brandVoice.preferred_words.join(", ")}`
        : "",
      params.platform === "twitter"
        ? "Keep under 280 characters."
        : "Use line breaks for readability.",
    ].filter(Boolean).join("\n")

    // ── 4. Generate with AI ──────────────────────────────────────────────────
    const { object, usage } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: GeneratedPostSchema,
      system: systemPrompt,
      prompt: userPrompt,
    })

    // ── 5. Compliance gate — evaluateOutbound ───────────────────────────────
    // Social posts are broadcast content (no individual contact), so `contact`
    // is omitted: TCPA/Authority (Gates 2-3) are skipped and Fair Housing
    // (Gate 4) and Them-First (Gate 5) still run — the intent the stub
    // KernelContact used to express.
    //
    // The stub carried `id: "broadcast"`, but contacts.id and
    // compliance_events.entity_id are both uuid, so it made the contact
    // re-fetch AND the audit-row INSERT fail with 22P02. Neither destructures
    // `error`, so the gate kept blocking correctly while silently never
    // writing a compliance_events row — and COMPLIANCE_VIOLATION never fired,
    // because that notification is guarded on the insert having succeeded.
    const complianceResult = await evaluateOutbound({
      actorContext:  { userId: params.agentId, role: "agent", brokerageId: params.brokerageId, teamId: params.teamId },
      journeyType: "buyer",
      persona: "first_time",
      messageType: "social",
      content:       object.content,
    })

    if (!complianceResult.allowed) {
      return {
        success:              false,
        complianceBlocked:    true,
        complianceViolations: complianceResult.violations,
        error:                `Content blocked by compliance: ${complianceResult.violations?.[0] ?? "compliance violation"}`,
        // The model DID run and DID cost tokens even though the gate refused
        // the output. A blocked generation is spend, not a free call, so the
        // figure is carried out here too — a caller that only ledgers the happy
        // path is under-reporting real usage.
        usage,
      }
    }

    return { success: true, data: object, usage }
  } catch (error: any) {
    console.error("[generate-social-post] Error:", error)
    return { success: false, error: friendlyAiError(error, "Failed to generate post content") }
  }
}

// ─── POST-SAVE BRAND COMPLIANCE STAMP ─────────────────────────────────────────

/**
 * Call this AFTER saving the social_post row to stamp brand_compliance_passed.
 * Uses checkBrandCompliance from lib/kernel/brand-compliance.ts which also
 * verifies approved hashtags, prohibited language, and logo compliance.
 *
 * GATED + SESSION-SCOPED (was neither). This is a **compliance stamp**, not a
 * read: `checkBrandCompliance` writes `brand_compliance_passed` on the post, and
 * that flag is exactly what `app/actions/social-share.ts:canAgentSharePost` and
 * `shareListingPost` consult before letting a post go out under the brokerage's
 * name. As a `"use server"` export with no session and a caller-supplied
 * `brokerageId`, it let anyone run another tenant's brand rules against another
 * tenant's post — including evaluating a post against a *different* brokerage's
 * ruleset, which is how a post gets stamped compliant under rules that were never
 * meant to apply to it.
 *
 * `brokerageId` is now ignored and derived from the session, and the post must
 * belong to that brokerage before it is evaluated. On a refused lookup this fails
 * CLOSED — `passed: false` — because the alternative in a compliance gate is
 * stamping something nobody checked.
 */
export async function stampPostBrandCompliance(params: {
  postId: string
  /** Ignored — derived from the session. */
  brokerageId?: string
}): Promise<{ passed: boolean; violations: string[] }> {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { passed: false, violations: ["Not authenticated"] }
  }

  const supabase = await createClient()
  const { data: post, error } = await supabase
    .from("social_posts")
    .select("id")
    .eq("id", params.postId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (error) return { passed: false, violations: ["Could not verify this post"] }
  if (!post)  return { passed: false, violations: ["Post not found in your brokerage"] }

  return checkBrandCompliance({
    contentType: "social_post",
    contentId:   params.postId,
    brokerageId: ctx.brokerageId,
  })
}

// ─── WEEKLY CONTENT PLAN ──────────────────────────────────────────────────────

export async function generateWeeklyContentPlan(params: {
  brokerageId: string
  agentId: string
  teamId?: string
  marketArea?: string
  listingCount?: number
}): Promise<{
  success: boolean
  data?: Array<{
    day: string
    contentType: string
    platform: string
    hook: string
    suggestedTime: string
  }>
  error?: string
}> {
  try {
    const brandVoice = await resolveBrandVoice(params.brokerageId, params.agentId, params.teamId)

    const WeekPlanSchema = z.object({
      plan: z.array(z.object({
        day:           z.string(),
        contentType:   z.string(),
        platform:      z.string(),
        hook:          z.string(),
        suggestedTime: z.string(),
      }))
    })

    const { object } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: WeekPlanSchema,
      system: [
        "You are a social media strategist for real estate professionals.",
        "NEVER suggest content with fair housing violations or investment guarantees.",
        brandVoice.prohibited_words?.length
          ? `Never use these words in hooks: ${brandVoice.prohibited_words.join(", ")}.`
          : "",
      ].filter(Boolean).join("\n"),
      prompt: [
        "Create a 7-day social media content calendar for a real estate agent.",
        `Market area: ${params.marketArea ?? "local market"}`,
        `Active listings: ${params.listingCount ?? 0}`,
        `Brand tone: ${brandVoice.tone ?? "professional and friendly"}`,
        `Formality: ${brandVoice.formality_level ?? "conversational"}`,
        brandVoice.key_brand_messages?.length
          ? `Brand messages: ${brandVoice.key_brand_messages.join("; ")}`
          : "",
        "Include a mix of: market updates, listing highlights, tips, community spotlights, client stories.",
        "For each day: day name, content type, best platform, hook (opening line), suggested posting time.",
      ].filter(Boolean).join("\n"),
    })

    // Persist each day's plan item to campaign_calendar so the Calendar tab shows it
    try {
      const supabase = await createClient()
      const dayOrder: Record<string, number> = {
        monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
        friday: 5, saturday: 6, sunday: 0,
      }
      // Find the next Monday as the start of this week's plan
      const now = new Date()
      const todayDow = now.getDay() // 0=Sun
      const daysToMonday = todayDow === 0 ? 1 : 8 - todayDow
      const weekStart = new Date(now)
      weekStart.setDate(now.getDate() + (todayDow === 1 ? 0 : daysToMonday))
      weekStart.setHours(0, 0, 0, 0)

      const calendarRows = object.plan.map((item) => {
        const offset = dayOrder[item.day.toLowerCase()] ?? 0
        const eventDate = new Date(weekStart)
        eventDate.setDate(weekStart.getDate() + offset)
        // Parse suggested time like "9:00 AM"
        const timeParts = item.suggestedTime.match(/(\d+):(\d+)\s*(AM|PM)/i)
        if (timeParts) {
          let hour = parseInt(timeParts[1])
          const minute = parseInt(timeParts[2])
          const ampm = timeParts[3].toUpperCase()
          if (ampm === "PM" && hour < 12) hour += 12
          if (ampm === "AM" && hour === 12) hour = 0
          eventDate.setHours(hour, minute, 0, 0)
        }
        return {
          brokerage_id: params.brokerageId,
          agent_user_id: params.agentId,
          event_type: item.contentType,
          channel: item.platform,
          title: item.hook,
          scheduled_at: eventDate.toISOString(),
          notes: `AI-planned: ${item.contentType} — ${item.suggestedTime}`,
          status: "scheduled",
        }
      })
      await supabase.from("campaign_calendar").insert(calendarRows)
    } catch (calErr) {
      // Non-fatal: plan is still returned even if calendar insert fails
      console.warn("[v0] Failed to persist weekly plan to campaign_calendar:", calErr)
    }

    return { success: true, data: object.plan }
  } catch (error: any) {
    // Never leak the raw AI-gateway billing/credit error ("-1 … free plan") to
    // the user — map known infra failures to an honest, actionable message.
    return { success: false, error: friendlyAiError(error, "Failed to generate weekly plan") }
  }
}

/**
 * Generic contextual draft generator.
 * Wires brand voice + compliance kernel for all outbound content types.
 * Used by ContextualAiAssistBar and any ad-hoc draft generation.
 *
 * MERGED IN (from the AI Toolkit's Email Composer, which used to be a stub that
 * returned the literal string "AI-generated email"): `brief` and `variant`.
 * This generator could previously write a draft FROM NOTHING or IMPROVE an
 * existing one, but it had no slot for "here is what this message has to
 * accomplish" — so the Toolkit's Context box and its Email-type picker had
 * nowhere to land. Both are optional and additive; every existing caller is
 * unchanged.
 */
export async function generateContextualDraft(params: {
  agentId: string
  brokerageId?: string
  teamId?: string
  contentType: "note" | "message" | "email" | "social_post" | "seller_update" | "referral_ask" | "review_request"
  contactName?: string
  propertyAddress?: string
  currentContent?: string
  /** Free-text description of what this message must accomplish. */
  brief?: string
  /** A narrower label than contentType — "follow-up", "negotiation", "thank-you". */
  variant?: string
}): Promise<{
  success: boolean
  draft?: string
  complianceViolations?: string[]
  error?: string
  /** REAL provider token counts. ADDITIVE, and for the same reason as on
   *  generateSocialPostContent: this lane books nothing, so a caller that
   *  ledgers the run must take the figure from here. */
  usage?: GeneratedUsage
}> {
  try {
    const brandVoice = await resolveBrandVoice(
      params.brokerageId ?? "",
      params.agentId,
      params.teamId
    )

    const DraftSchema = z.object({ draft: z.string() })

    // `variant` narrows the noun ("a follow-up email", not "an email"); `brief`
    // is appended to BOTH branches because the caller's intent applies just as
    // much when improving existing copy as when writing from scratch.
    const label = params.variant ? `${params.variant} ${params.contentType}` : params.contentType
    const briefLine = params.brief?.trim()
      ? `\n\nWhat this ${label} has to accomplish: ${params.brief.trim().slice(0, 1200)}`
      : ""

    const instruction = (params.currentContent
      ? `Improve the following ${label}: "${params.currentContent.slice(0, 800)}"`
      : `Write a ${label} for ${params.contactName ?? "a client"}.${
          params.propertyAddress ? ` Property: ${params.propertyAddress}.` : ""
        }`) + briefLine

    const { object, usage } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: DraftSchema,
      system: [
        `You are a professional real estate communication assistant. Use "Them First" principles.`,
        `Tone: ${brandVoice.tone ?? "professional and warm"}.`,
        `Formality: ${brandVoice.formality_level ?? "conversational"}.`,
        brandVoice.prohibited_words?.length
          ? `Never use: ${brandVoice.prohibited_words.join(", ")}.`
          : "",
        brandVoice.custom_instructions ?? "",
      ].filter(Boolean).join("\n"),
      prompt: `${instruction}\n\nKeep it concise, authentic, and human. Do not add subject lines unless this is an email.`,
    })

    // Run compliance gate for outbound content types (not internal notes).
    // Fair Housing and Them-First evaluate the generated draft text.
    //
    // `contact` is omitted: this is a draft, and all we have is a display name
    // (params.contactName), never a resolved contacts.id — so there is no
    // recipient whose DNC/opt-out state could be checked. The stub that used
    // to stand in here carried `id: "contextual_draft_target"`, which is not a
    // uuid, so it made both the contact re-fetch and the compliance_events
    // audit INSERT fail with 22P02 without ever surfacing an error.
    const OUTBOUND_TYPES = new Set(["email", "seller_update", "referral_ask", "review_request", "message"])

    if (OUTBOUND_TYPES.has(params.contentType) && params.brokerageId) {
      // This was computed and then ignored — the call hardcoded "social", so
      // an email draft was graded against the social rule set.
      const messageType = params.contentType === "email" ? "email" : "social"

      const compliance = await evaluateOutbound({
        actorContext: { userId: params.agentId, role: "agent", brokerageId: params.brokerageId, teamId: params.teamId },
        journeyType: "buyer",
        persona: "first_time",
        messageType,
        content:      object.draft,
      })

      if (!compliance.allowed) {
        return {
          success:              false,
          complianceViolations: compliance.violations,
          error:                `Draft blocked by compliance: ${compliance.violations?.[0] ?? "compliance violation"}`,
          // A refused draft still cost tokens — carried out so the caller's
          // ledger records the spend rather than treating a block as free.
          usage,
        }
      }
    }

    return { success: true, draft: object.draft, usage }
  } catch (error: any) {
    return { success: false, error: friendlyAiError(error, "Failed to generate draft") }
  }
}

// ─── HASHTAG SUGGESTIONS ──────────────────────────────────────────────────────

export async function suggestHashtags(params: {
  content: string
  platform: string
  location?: string
}): Promise<{ hashtags: string[] }> {
  try {
    const HashtagSchema = z.object({
      hashtags: z.array(z.string()).describe("Relevant hashtags without #"),
    })

    const { object } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: HashtagSchema,
      prompt: [
        `Suggest 15 relevant ${params.platform} hashtags for this real estate post.`,
        params.location ? `Location: ${params.location}` : "",
        `Post: ${params.content.slice(0, 500)}`,
        "Mix of: broad real estate, location-specific, niche, and engagement hashtags.",
        "Return only the hashtag text without the # symbol.",
      ].filter(Boolean).join("\n"),
    })

    return { hashtags: object.hashtags }
  } catch {
    return { hashtags: ["RealEstate", "HomesForSale", "RealEstateAgent", "NewListing", "PropertyForSale"] }
  }
}
