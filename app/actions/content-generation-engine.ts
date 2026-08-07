"use server"

import { isValidUUID } from "@/lib/validations"
import { handleError, ValidationError } from "@/lib/errors"
import {
  generateTextContent,
  generateAudioScript,
  generateVideoScript,
  generateImagePrompt,
  generateOmnipresentContent,
  generateContentVariations,
  gatherContext,
  enrichPromptWithContext,
  logContentGeneration,
  logOmnipresentGeneration,
  getContentGenerationHistory,
  getContentGenerationStats,
  type ContentGenerationParams,
  type ContentGenerationOutput,
} from "@/lib/content-generation"
import { v4 as uuidv4 } from "uuid"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import {
  buildComplianceSystemBlocks,
  precheckBriefForFairHousing,
  postcheckScript,
} from "@/lib/video/script-compliance"

// ============================================
// SYSTEM 4.1 – CONTENT GENERATION ENGINE
// Server Actions (Public API)
// Draft-only, no publishing/approval.
// The video lane DOES run the shared compliance gate
// (lib/video/script-compliance.ts): a Fair Housing violation in the prompt is
// refused, and the generated script comes back with advisory warnings.
// ============================================

export interface ContentGenerationResult {
  success: boolean
  content?: ContentGenerationOutput
  content_id?: string // Runtime-only UUID (not persisted)
  error?: string
  /** Advisory compliance notes from the post-generation gate (video lane). */
  complianceWarnings?: string[]
}

export interface BatchContentGenerationResult {
  success: boolean
  contents?: ContentGenerationOutput[]
  generated_count?: number
  failed_count?: number
  error?: string
}

/**
 * Resolve the caller's effective actor identity from session.
 * - If session has an agentId, verify it belongs to this brokerage and use it.
 * - Otherwise (broker/admin/TC — no `agents` row) return agentId: null. The
 *   caller is still fully identified by userId; see the id-space note below.
 *
 * SECURITY: Never trusts a caller-supplied agent_id. AI inference + writes
 * are always attributed to the authenticated session.
 *
 * ─── WHY agentId IS `string | null` AND NOT `?? userId` ──────────────────────
 *
 * This used to end with `return { agentId: ctx.userId, ... }` for agent-less
 * callers, and that agentId went straight into `activities.agent_id`. Verified
 * against the live database:
 *
 *   activities_agent_id_fkey  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
 *
 * The FK exists and is valid, `agent_id` is nullable, and `agents.id` /
 * `users.id` are disjoint id spaces (a join of the two on id returns 0 rows).
 * So the substitution was not a rare mismatch — it was a guaranteed 23503 on
 * every single broker/admin generation, swallowed by logContentGeneration
 * (which returns { success: false } that no caller reads). Content came back
 * fine; the activity row never existed.
 *
 * activities also has a purpose-built `agent_user_id → users(id)` column, and
 * the activities_set_brokerage trigger already has an `agent_user_id` branch.
 * The schema anticipated the agent-less actor. So: RESOLVE (agents.id when one
 * exists, NULL when it does not, users.id recorded in its own column), never
 * SUBSTITUTE one id space for the other.
 */
async function resolveAuthorizedAgentId(): Promise<
  | { ok: true; agentId: string | null; brokerageId: string; userId: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { ok: false, error: "Unauthorized" }
  }

  // Prefer agents.id when we have one.
  if (ctx.agentId) {
    // Verify the agent row actually belongs to this brokerage.
    const svc = createServiceClient()
    const { data: agentRow, error: agentErr } = await svc
      .from("agents")
      .select("id, brokerage_id")
      .eq("id", ctx.agentId)
      .maybeSingle()
    // A REFUSED read is not "no rows" — supabase-js resolves failed queries, so
    // without checking `error` a transport/RLS failure would masquerade as
    // "this agent does not exist" and downgrade the caller to the agent-less
    // path. Fail closed instead.
    if (agentErr) {
      return { ok: false, error: "Forbidden" }
    }
    if (!agentRow || agentRow.brokerage_id !== ctx.brokerageId) {
      return { ok: false, error: "Forbidden" }
    }
    return { ok: true, agentId: ctx.agentId, brokerageId: ctx.brokerageId, userId: ctx.userId }
  }

  // No agents row (broker/admin/TC/etc.). agent_id stays NULL — the schema
  // allows it — and the human is recorded in activities.agent_user_id.
  return { ok: true, agentId: null, brokerageId: ctx.brokerageId, userId: ctx.userId }
}

/**
 * Generate TEXT content (email, newsletter, SMS, blog, social, ads, listings)
 */
export async function generateText(params: {
  agent_id?: string // ignored — derived from session
  content_type: ContentGenerationParams["content_type"]
  channel_intent?: ContentGenerationParams["channel_intent"]
  listing_id?: string
  contact_id?: string
  transaction_id?: string
  custom_prompt?: string
  target_audience?: string
  tone?: string
  length?: "short" | "medium" | "long"
  source_urls?: string[]
}): Promise<ContentGenerationResult> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }
    const agentId = auth.agentId

    // Gather context from database
    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    // Enrich prompt with context
    const enrichedPrompt = params.custom_prompt
      ? await enrichPromptWithContext(params.custom_prompt, context)
      : ""

    // Generate content
    const content = await generateTextContent({
      content_type: params.content_type,
      channel_intent: params.channel_intent,
      custom_prompt: enrichedPrompt || params.custom_prompt,
      target_audience: params.target_audience,
      tone: params.tone,
      length: params.length,
      source_urls: params.source_urls,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    // Generate runtime UUID (not persisted to database)
    const content_id = uuidv4()

    // Log to activities table (ONLY database write)
    await logContentGeneration({
      // agentId is an agents.id or NULL; auth.userId is a users.id. Distinct
      // columns, distinct FKs — never collapse them into one.
      agent_id: agentId,
      agent_user_id: auth.userId,
      brokerage_id: auth.brokerageId,
      content_output: content,
      entity_id: content_id,
      entity_type: "content",
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateText")
  }
}

/**
 * Generate AUDIO script (podcast, short-form audio)
 */
export async function generateAudio(params: {
  agent_id?: string // ignored — derived from session
  content_type: "podcast_script" | "audio_script"
  duration_minutes?: number
  listing_id?: string
  contact_id?: string
  transaction_id?: string
  custom_prompt?: string
  target_audience?: string
}): Promise<ContentGenerationResult> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }
    const agentId = auth.agentId

    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    const enrichedPrompt = params.custom_prompt
      ? await enrichPromptWithContext(params.custom_prompt, context)
      : ""

    const content = await generateAudioScript({
      content_type: params.content_type,
      duration_minutes: params.duration_minutes,
      custom_prompt: enrichedPrompt || params.custom_prompt,
      target_audience: params.target_audience,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    const content_id = uuidv4()

    await logContentGeneration({
      // agentId is an agents.id or NULL; auth.userId is a users.id. Distinct
      // columns, distinct FKs — never collapse them into one.
      agent_id: agentId,
      agent_user_id: auth.userId,
      brokerage_id: auth.brokerageId,
      content_output: content,
      entity_id: content_id,
      entity_type: "content",
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateAudio")
  }
}

/**
 * Generate VIDEO script (long-form, short-form, social video)
 */
export async function generateVideo(params: {
  agent_id?: string // ignored — derived from session
  content_type: "video_script"
  channel_intent?: "youtube" | "tiktok" | "instagram" | "facebook"
  video_length_seconds?: number
  listing_id?: string
  contact_id?: string
  transaction_id?: string
  custom_prompt?: string
  target_audience?: string
}): Promise<ContentGenerationResult> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }
    const agentId = auth.agentId

    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    const enrichedPrompt = params.custom_prompt
      ? await enrichPromptWithContext(params.custom_prompt, context)
      : ""

    // Compliance gate — the same one the video wizard enforces. This path
    // (EducationEditor → generateVideo) reaches a fifth generateVideoScript,
    // the one in lib/content-generation/content-generator.ts, which had no
    // Fair Housing check and no brand voice anywhere in its chain.
    //
    // The actor is resolved above: agentId is an agents.id, userId a users.id.
    // evaluateOutbound's actorContext wants the users.id, so pass auth.userId —
    // these are distinct id spaces and must not be substituted for each other.
    const actor = { userId: auth.userId, brokerageId: auth.brokerageId }
    const brief = enrichedPrompt || params.custom_prompt
    if (brief?.trim()) {
      const preCheck = await precheckBriefForFairHousing(actor, brief, "buyer")
      if (preCheck.blocked) {
        return {
          success: false,
          error: `Prompt contains a Fair Housing violation: ${preCheck.reason}`,
        }
      }
    }

    const complianceBlocks = await buildComplianceSystemBlocks(auth.brokerageId)

    const content = await generateVideoScript({
      content_type: params.content_type,
      channel_intent: params.channel_intent,
      video_length_seconds: params.video_length_seconds,
      // The generator takes a single prompt, so the guidelines lead it.
      custom_prompt: [complianceBlocks.join("\n\n"), brief].filter(Boolean).join("\n\n"),
      target_audience: params.target_audience,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    const complianceWarnings = await postcheckScript(actor, content.raw_content, "buyer")

    const content_id = uuidv4()

    await logContentGeneration({
      // agentId is an agents.id or NULL; auth.userId is a users.id. Distinct
      // columns, distinct FKs — never collapse them into one.
      agent_id: agentId,
      agent_user_id: auth.userId,
      brokerage_id: auth.brokerageId,
      content_output: content,
      entity_id: content_id,
      entity_type: "content",
    })

    return {
      success: true,
      content,
      content_id,
      complianceWarnings,
    }
  } catch (error) {
    return handleError(error, "generateVideo")
  }
}

/**
 * Generate IMAGE prompt (for external image generation)
 */
export async function generateImage(params: {
  agent_id?: string // ignored — derived from session
  channel_intent?: string
  listing_id?: string
  contact_id?: string
  custom_prompt?: string
  tone?: string
}): Promise<ContentGenerationResult> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }
    const agentId = auth.agentId

    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
    })

    const enrichedPrompt = params.custom_prompt
      ? await enrichPromptWithContext(params.custom_prompt, context)
      : ""

    const content = await generateImagePrompt({
      content_type: "image_prompt",
      channel_intent: params.channel_intent as any,
      custom_prompt: enrichedPrompt || params.custom_prompt,
      tone: params.tone,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
    })

    const content_id = uuidv4()

    await logContentGeneration({
      // agentId is an agents.id or NULL; auth.userId is a users.id. Distinct
      // columns, distinct FKs — never collapse them into one.
      agent_id: agentId,
      agent_user_id: auth.userId,
      brokerage_id: auth.brokerageId,
      content_output: content,
      entity_id: content_id,
      entity_type: "content",
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateImage")
  }
}

/**
 * Generate OMNIPRESENT content (one idea → many formats)
 */
export async function generateOmnipresent(params: {
  agent_id?: string // ignored — derived from session
  core_idea: string
  target_audience?: string
  listing_id?: string
  contact_id?: string
  formats: Array<"podcast" | "video" | "newsletter" | "social_post" | "blog">
}): Promise<BatchContentGenerationResult> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }
    const agentId = auth.agentId

    const contents = await generateOmnipresentContent({
      core_idea: params.core_idea,
      target_audience: params.target_audience,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      formats: params.formats,
    })

    await logOmnipresentGeneration({
      agent_id: agentId,
      agent_user_id: auth.userId,
      brokerage_id: auth.brokerageId,
      core_idea: params.core_idea,
      formats_generated: contents,
    })

    return {
      success: true,
      contents,
      generated_count: contents.length,
      failed_count: 0,
    }
  } catch (error) {
    return handleError(error, "generateOmnipresent")
  }
}

/**
 * Generate content VARIATIONS (for A/B testing)
 */
export async function generateVariations(params: {
  agent_id?: string // ignored — derived from session
  content_type: ContentGenerationParams["content_type"]
  channel_intent?: ContentGenerationParams["channel_intent"]
  listing_id?: string
  contact_id?: string
  custom_prompt?: string
  target_audience?: string
  variation_count?: number
}): Promise<BatchContentGenerationResult> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }
    const agentId = auth.agentId

    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
    })

    const enrichedPrompt = params.custom_prompt
      ? await enrichPromptWithContext(params.custom_prompt, context)
      : ""

    const variations = await generateContentVariations(
      {
        content_type: params.content_type,
        channel_intent: params.channel_intent,
        custom_prompt: enrichedPrompt || params.custom_prompt,
        target_audience: params.target_audience,
        listing_id: params.listing_id,
        contact_id: params.contact_id,
      },
      params.variation_count || 3
    )

    // Log each variation
    for (const content of variations) {
      const content_id = uuidv4()
      await logContentGeneration({
        agent_id: agentId,
        agent_user_id: auth.userId,
        brokerage_id: auth.brokerageId,
        content_output: content,
        entity_id: content_id,
        entity_type: "content",
      })
    }

    return {
      success: true,
      contents: variations,
      generated_count: variations.length,
      failed_count: 0,
    }
  } catch (error) {
    return handleError(error, "generateVariations")
  }
}

/**
 * Get content generation history
 */
export async function getGenerationHistory(params: {
  agent_id?: string // ignored — derived from session
  limit?: number
  content_type?: string
}): Promise<{
  success: boolean
  history?: Array<any>
  error?: string
}> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    // Rows written by an agent-less caller carry agent_id = NULL and identify
    // the actor via agent_user_id, so the read must be given both.
    const history = await getContentGenerationHistory({
      agent_id: auth.agentId,
      agent_user_id: auth.userId,
      limit: params.limit,
      content_type: params.content_type,
    })

    return {
      success: true,
      history,
    }
  } catch (error) {
    return handleError(error, "getGenerationHistory")
  }
}

/**
 * Get content generation stats
 */
export async function getGenerationStats(params: {
  agent_id?: string // ignored — derived from session
  date_range?: { start: string; end: string }
}): Promise<{
  success: boolean
  stats?: {
    total_generated: number
    by_content_type: Record<string, number>
    by_channel: Record<string, number>
    recent_generations: number
  }
  error?: string
}> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    const stats = await getContentGenerationStats({
      agent_id: auth.agentId,
      agent_user_id: auth.userId,
      date_range: params.date_range,
    })

    return {
      success: true,
      stats,
    }
  } catch (error) {
    return handleError(error, "getGenerationStats")
  }
}

/**
 * Generate listing description from external URL (for repurposing)
 */
export async function generateFromURL(params: {
  agent_id?: string // ignored — derived from session
  source_url: string
  content_type: ContentGenerationParams["content_type"]
  custom_instructions?: string
}): Promise<ContentGenerationResult> {
  try {
    const auth = await resolveAuthorizedAgentId()
    if (!auth.ok) return { success: false, error: auth.error }
    const agentId = auth.agentId

    const content = await generateTextContent({
      content_type: params.content_type,
      source_urls: [params.source_url],
      custom_prompt: `Repurpose content from the following source:\n${params.source_url}\n\n${params.custom_instructions || ""}`,
    })

    const content_id = uuidv4()

    await logContentGeneration({
      // agentId is an agents.id or NULL; auth.userId is a users.id. Distinct
      // columns, distinct FKs — never collapse them into one.
      agent_id: agentId,
      agent_user_id: auth.userId,
      brokerage_id: auth.brokerageId,
      content_output: content,
      entity_id: content_id,
      entity_type: "content",
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateFromURL")
  }
}

// Silence unused-import warning for isValidUUID (kept for future validation hooks)
void isValidUUID
void ValidationError
