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
import {
  generateAIResponse,
  type AIRequest,
  type AIResponse,
  type ComplianceContext,
  type AIModel,
} from "./models"

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

const BV_SELECT = "brokerage_id, team_id, agent_id, tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement"

/** Format one brand_voice_profile row into labeled lines (empty when no profile). */
function formatVoiceProfileLines(profile: any, label: string): string[] {
  if (!profile) return []
  const lines: string[] = [`${label}:`]
  if (profile.tagline) lines.push(`Tagline: "${profile.tagline}"`)
  if (profile.tone) lines.push(`Tone: ${profile.tone}`)
  if (profile.formality_level) lines.push(`Formality: ${profile.formality_level}`)
  if (profile.key_brand_messages?.length) lines.push(`Key Messages: ${profile.key_brand_messages.join(" | ")}`)
  if (profile.preferred_words?.length) lines.push(`Preferred Words: ${profile.preferred_words.join(", ")}`)
  if (profile.prohibited_words?.length) lines.push(`Never Use: ${profile.prohibited_words.join(", ")}`)
  return lines.length > 1 ? lines : []
}

/**
 * resolveBrandVoice — CASCADE: the brokerage brand voice is ALWAYS the base (the
 * tenant of record whose voice content pulls from), then the TEAM's voice and the
 * AGENT's own voice layer on top (their tone/tagline/preferred+prohibited words
 * refine the base). Mirrors resolveBrandContext's brokerage → team → agent cascade
 * so brand SETTINGS and brand VOICE resolve the same way. brand_voice_profile is
 * scoped by brokerage_id / team_id / agent_id (scripts 524 + 1049).
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
    const supabase = await createClient()

    const { data: brokerage } = await supabase.from("brokerages").select("id, name").eq("id", scope.brokerageId).single()
    if (!brokerage) return ""

    // Base: the brokerage-scoped voice (team_id + agent_id null).
    const [baseRes, teamRes, agentRes] = await Promise.all([
      supabase.from("brand_voice_profile").select(BV_SELECT)
        .eq("brokerage_id", scope.brokerageId).is("team_id", null).is("agent_id", null)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      scope.teamId
        ? supabase.from("brand_voice_profile").select(BV_SELECT).eq("team_id", scope.teamId)
            .order("updated_at", { ascending: false }).limit(1).maybeSingle()
        : Promise.resolve({ data: null }),
      scope.agentId
        ? supabase.from("brand_voice_profile").select(BV_SELECT).eq("agent_id", scope.agentId)
            .order("updated_at", { ascending: false }).limit(1).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    const snippetLines: string[] = [
      ...formatVoiceProfileLines(baseRes.data, `BRAND VOICE — ${brokerage.name} (brokerage base)`),
      ...formatVoiceProfileLines((teamRes as any).data, "TEAM VOICE OVERLAY"),
      ...formatVoiceProfileLines((agentRes as any).data, "AGENT VOICE OVERLAY"),
    ]
    // No profile at any scope → still name the brokerage so content is grounded.
    if (snippetLines.length === 0) snippetLines.push(`Brokerage: ${brokerage.name}`)

    const snippet = snippetLines.join("\n")
    brandVoiceCache.set(cacheKey, { snippet, expiresAt: Date.now() + BRAND_VOICE_CACHE_TTL_MS })
    return snippet
  } catch (error) {
    console.error("[pipeline] Brand voice resolution failed:", error)
    return ""
  }
}

// ─── SYSTEM PROMPT BUILDER ────────────────────────────────────────────────────

function buildEnrichedSystem(
  original: string | undefined,
  personaContext: string,
  brandVoice: string
): string {
  const parts: string[] = []

  if (personaContext) parts.push(personaContext)
  if (brandVoice) parts.push(brandVoice)
  if (original) parts.push(original)

  return parts.join("\n\n")
}

// ─── FULL PIPELINE ────────────────────────────────────────────────────────────

/**
 * runPipeline — full execution with persona + brand voice + compliance + cost + logging.
 * Use this wherever metadata.agentId and metadata.brokerageId are available.
 */
export async function runPipeline(request: PipelineRequest): Promise<PipelineResponse> {
  const [personaContext, brandVoice] = await Promise.all([
    resolvePersonaContext(request.metadata.agentId, request.persona),
    resolveBrandVoice(
      { brokerageId: request.metadata.brokerageId, teamId: request.metadata.teamId, agentId: request.metadata.agentId },
      request.brandVoice,
    ),
  ])

  const enrichedSystem = buildEnrichedSystem(request.system, personaContext, brandVoice)

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

    // Best-effort identity resolution — never throws
    const userId = user?.id || "anonymous"
    let brokerageId = "platform"
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
  brandVoiceCache.delete(brokerageId)
}
