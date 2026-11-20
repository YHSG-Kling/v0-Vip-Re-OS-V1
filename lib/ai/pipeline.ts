/**
 * lib/ai/pipeline.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single AI execution pipeline for the entire platform.
 *
 * Handles in order:
 *   1. Persona context injection   — prepend agent persona to system prompt
 *   2. Brand voice injection       — append brokerage brand voice guidelines
 *   3. Compliance filtering        — fair housing / TCPA / Them-First (via models.ts)
 *   4. Cost tracking               — token + dollar cost logged per call (via models.ts)
 *   5. Logging                     — ai_tool_usage row + monthly aggregate (via models.ts)
 *
 * Exports:
 *   runPipeline        — full pipeline (requires agentId + brokerageId)
 *   runPipelineSimple  — drop-in for raw generateText callers; best-effort logging
 *   PipelineRequest    — input type
 *   PipelineResponse   — output type (same shape as AIResponse from models.ts)
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  generateAIResponse,
  type AIRequest,
  type AIResponse,
  type ComplianceContext,
  type AIModel,
} from "./models"
// WAVE 151 (lane 151I): THE ONE brand-voice reader compiles the versioned sender-voice brief; the person's own words come
// from THE ONE memory read. Both modules are already on the app/crm/page.tsx import graph — no module is added.
import { loadSenderVoiceBrief, renderSenderVoiceBrief, invalidateSenderVoiceBriefCache } from "@/lib/kernel/brand-voice"
import { loadContactMemoryForPrompt, contactMemoryPromptSection } from "@/lib/kernel/conversation-memory"

// ─── PERSONA CACHE (in-memory, short-lived) ───────────────────────────────────
const personaCache = new Map<string, { context: string; expiresAt: number }>()
const PERSONA_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ─── BRAND VOICE CACHE ────────────────────────────────────────────────────────
const brandVoiceCache = new Map<string, { snippet: string; expiresAt: number }>()
const BRAND_VOICE_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface PersonaContext {
  personaId?: string
  /** Override the DB lookup and inject this string directly */
  inlinePersona?: string
}

export interface BrandVoiceContext {
  /** Override the DB lookup and inject this string directly */
  inlineBrandVoice?: string
}

export interface PipelineRequest {
  // Core AI parameters
  model?: AIModel
  system?: string
  prompt: string
  temperature?: number
  maxTokens?: number
  fallbackModel?: AIModel

  // Identity — required for full pipeline
  metadata: {
    userId: string
    brokerageId: string
    teamId?: string | null
    agentId?: string | null
    feature?: string
    contactId?: string
  }

  // Persona injection
  persona?: PersonaContext

  // Brand voice injection
  brandVoice?: BrandVoiceContext

  // Compliance
  compliance?: ComplianceContext
}

export type PipelineResponse = AIResponse

// ─── PERSONA INJECTION ────────────────────────────────────────────────────────

async function resolvePersonaContext(
  agentId: string | null | undefined,
  personaOverride?: PersonaContext
): Promise<string> {
  // Inline override takes precedence
  if (personaOverride?.inlinePersona) {
    return personaOverride.inlinePersona
  }

  if (!agentId) return ""

  // Check cache
  const cached = personaCache.get(agentId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.context
  }

  try {
    const supabase = await createClient()

    // Agent display name lives on the joined users row.
    const { data: agent } = await supabase
      .from("agents")
      .select(`id, users ( first_name, last_name )`)
      .eq("id", agentId)
      .single()

    if (!agent) return ""

    // Agent-scoped AI persona — the canonical ai_identity_profiles table (the same store the voice /
    // widget / ISA stack uses). The old path queried agents.ai_persona_id → ai_personas, neither of
    // which exists, so persona context silently never loaded.
    const { data: persona } = await supabase
      .from("ai_identity_profiles")
      .select("persona_label, tone, formality_level, followup_style, prohibited_language")
      .eq("scope_type", "agent")
      .eq("scope_id", agentId)
      .maybeSingle()

    let contextLines: string[] = []

    if (persona) {
      if (persona.persona_label) contextLines.push(`AGENT PERSONA: ${persona.persona_label}`)
      if (persona.tone) contextLines.push(`Tone: ${persona.tone}`)
      if (persona.formality_level) contextLines.push(`Formality: ${persona.formality_level}`)
      if (persona.followup_style) contextLines.push(`Follow-up Style: ${persona.followup_style}`)
      if (Array.isArray(persona.prohibited_language) && persona.prohibited_language.length) {
        contextLines.push(`Avoid: ${(persona.prohibited_language as string[]).join("; ")}`)
      }
    }

    const agentFullName = [
      (agent.users as any)?.first_name,
      (agent.users as any)?.last_name,
    ]
      .filter(Boolean)
      .join(" ")
    if (agentFullName) {
      contextLines.push(`Agent Name: ${agentFullName}`)
    }

    const context = contextLines.length ? contextLines.join("\n") : ""

    personaCache.set(agentId, { context, expiresAt: Date.now() + PERSONA_CACHE_TTL_MS })
    return context
  } catch (error) {
    console.error("[pipeline] Persona resolution failed:", error)
    return ""
  }
}

// ─── BRAND VOICE INJECTION ────────────────────────────────────────────────────

/**
 * resolveBrandVoice — CASCADE: the brokerage brand voice is ALWAYS the base (the
 * tenant of record whose voice content pulls from), then the TEAM's voice and the
 * AGENT's own voice layer on top (their tone/tagline/preferred+prohibited words
 * refine the base). Mirrors resolveBrandContext's brokerage → team → agent cascade
 * so brand SETTINGS and brand VOICE resolve the same way.
 *
 * WAVE 151 (lane 151I) — ONE READER (LAW 2). The private three-row brand_voice_profile read that stood here
 * (BV_SELECT; "brokerage base" / "TEAM VOICE OVERLAY" / "AGENT VOICE OVERLAY" lines) is DELETED. TOMBSTONE — SURVIVOR:
 * lib/kernel/brand-voice.ts loadSenderVoiceBrief, the same brokerage → team → agent cascade (resolveBrandVoiceCore,
 * every read tenant-pinned and read for its error) widened to the sender's examples, signature, positioning and local
 * areas, and VERSIONED (`v1:<sha12>`), rendered by renderSenderVoiceBrief. scope.agentId is the agents.id the pipeline
 * carries (metadata.agentId); the loader crosses it to the users row inside the tenant. The cache key, the inline
 * override and the service client are unchanged (scripts/brand-voice-cascade-simulator.ts).
 */
async function resolveBrandVoice(
  scope: { brokerageId: string; teamId?: string | null; agentId?: string | null },
  brandVoiceOverride?: BrandVoiceContext
): Promise<string> {
  if (brandVoiceOverride?.inlineBrandVoice) return brandVoiceOverride.inlineBrandVoice

  const cacheKey = `${scope.brokerageId}:${scope.teamId ?? ""}:${scope.agentId ?? ""}`
  const cached = brandVoiceCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.snippet

  try {
    // SERVICE client — the cascade reads the brokerage-BASE and TEAM voice rows
    // (scoped by brokerage_id / team_id, not the caller's agent_id), which the
    // user-scoped RLS client silently drops. Mirrors resolveBrandContext, the
    // brand SETTINGS resolver, which reads the same cross-scope rows via service.
    const supabase = createServiceClient()
    const brief = await loadSenderVoiceBrief(supabase as never, { brokerageId: scope.brokerageId, teamId: scope.teamId ?? null, agentId: scope.agentId ?? null })
    const snippet = renderSenderVoiceBrief(brief)
    brandVoiceCache.set(cacheKey, { snippet, expiresAt: Date.now() + BRAND_VOICE_CACHE_TTL_MS })
    return snippet
  } catch (error) {
    console.error("[pipeline] Brand voice resolution failed:", error)
    return ""
  }
}

// ─── AUDIENCE INJECTION (wave 151, lane 151I — "gear it to them first") ───────
//
// When the call is about ONE contact, what that person SAID (THE ONE memory read, lib/kernel/conversation-memory.ts —
// tenant-pinned, current facts only, a refused read injects nothing) goes into the system prompt BEFORE the caller's own
// system — the writer is conditioned on the person before the first draft, never asked to personalise afterwards.
async function resolveAudienceContext(brokerageId: string, contactId: string | null | undefined): Promise<string> {
  if (!contactId) return ""
  try {
    const mem = await loadContactMemoryForPrompt({ contactId, brokerageId, client: createServiceClient() })
    return contactMemoryPromptSection(mem)
  } catch (error) {
    console.error("[pipeline] Audience (contact memory) resolution failed — nothing injected:", error)
    return ""
  }
}

// ─── SYSTEM PROMPT BUILDER ────────────────────────────────────────────────────

/** The owner's order: WHO is writing (the sender's voice brief), the agent's AI persona, WHO it is for, then the caller's own system. */
function buildEnrichedSystem(
  original: string | undefined,
  personaContext: string,
  brandVoice: string,
  audience: string = "",
): string {
  const parts: string[] = []

  if (brandVoice) parts.push(brandVoice)
  if (personaContext) parts.push(personaContext)
  if (audience) parts.push(audience)
  if (original) parts.push(original)

  return parts.join("\n\n")
}

// ─── FULL PIPELINE ────────────────────────────────────────────────────────────

/**
 * runPipeline — full execution with persona + brand voice + compliance + cost + logging.
 * Use this wherever metadata.agentId and metadata.brokerageId are available.
 */
export async function runPipeline(request: PipelineRequest): Promise<PipelineResponse> {
  const [personaContext, brandVoice, audience] = await Promise.all([
    resolvePersonaContext(request.metadata.agentId, request.persona),
    resolveBrandVoice(
      { brokerageId: request.metadata.brokerageId, teamId: request.metadata.teamId, agentId: request.metadata.agentId },
      request.brandVoice,
    ),
    resolveAudienceContext(request.metadata.brokerageId, request.metadata.contactId),
  ])

  const enrichedSystem = buildEnrichedSystem(request.system, personaContext, brandVoice, audience)

  const aiRequest: AIRequest = {
    model: request.model,
    system: enrichedSystem || undefined,
    prompt: request.prompt,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    fallbackModel: request.fallbackModel,
    compliance: request.compliance,
    metadata: request.metadata,
  }

  return generateAIResponse(aiRequest)
}

// ─── SIMPLE DROP-IN ───────────────────────────────────────────────────────────

export interface SimplePipelineOptions {
  model?: AIModel
  system?: string
  temperature?: number
  maxTokens?: number
  feature?: string
  /**
   * The tenant this call is booked to, for IN-PROCESS server callers that already hold it
   * (e.g. the lead pipeline's effectiveBrokerageId). Never from a request body. A session
   * agent's own brokerage still wins when there is one (CLAUDE.md §4).
   */
  brokerageId?: string | null
}

/**
 * runPipelineSimple — lightweight wrapper for callers that don't have a full
 * agent context available (e.g. public-facing routes, utility functions).
 *
 * Does NOT inject persona or brand voice (no agentId/brokerageId required).
 * Logs usage best-effort with anonymous identity fallback.
 * Returns just the text string — same DX as `generateText().text`.
 */
export async function runPipelineSimple(
  prompt: string,
  options?: SimplePipelineOptions
): Promise<string> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Best-effort identity resolution — never throws.
    // Lane 93D live walk: these were the sentinels "anonymous" / "platform". Both land in
    // uuid columns — ai_quota_overrides.brokerage_id (fair-use pre-flight), then
    // ai_tool_usage.user_id/brokerage_id, increment_ai_usage_monthly, usage_counters and
    // billing_usage — and every one refused 22P02 into a console line. So every sessionless
    // call (the lead pipeline's analyzeLead, the transaction AI helpers on a cron) reached
    // NO cost ledger (§5: a wrong number there is a wrong invoice). null is what logAIUsage
    // admits; with neither tenant nor user it now says "not booked" out loud.
    const userId: string | null = user?.id ?? null
    let brokerageId: string | null = options?.brokerageId ?? null
    let agentId: string | null = null

    if (user?.id) {
      try {
        const { data: agent } = await supabase
          .from("agents")
          .select("id, brokerage_id")
          .eq("user_id", user.id)
          .single()
        if (agent) {
          agentId = agent.id
          brokerageId = agent.brokerage_id
        }
      } catch {
        // Proceed with platform fallback
      }
    }

    const response = await generateAIResponse({
      model: options?.model,
      system: options?.system,
      prompt,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      metadata: {
        userId,
        brokerageId,
        agentId,
        teamId: null,
        feature: options?.feature || "simple",
      },
    })

    return response.text
  } catch (error) {
    console.error("[pipeline] runPipelineSimple failed:", error)
    throw error
  }
}

// ─── CACHE INVALIDATION ───────────────────────────────────────────────────────

export function invalidatePersonaCache(agentId: string): void {
  personaCache.delete(agentId)
}

export function invalidateBrandVoiceCache(brokerageId: string): void {
  // The cache is keyed `${brokerageId}:${teamId}:${agentId}` — every scope of the tenant goes, and so does the ONE
  // reader's compiled brief (wave 151I), so a saved setting reaches the next draft.
  for (const k of [...brandVoiceCache.keys()]) if (k.startsWith(`${brokerageId}:`)) brandVoiceCache.delete(k)
  invalidateSenderVoiceBriefCache(brokerageId)
}
