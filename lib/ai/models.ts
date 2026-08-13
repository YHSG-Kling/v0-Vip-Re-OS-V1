import { generateText, Output, stepCountIs } from "ai"
import type { z } from "zod"
import { createGateway } from "@ai-sdk/gateway"
import { resolveModel } from "@/lib/ai/resolve-model"
import { createClient } from "@/lib/supabase/server"
import { evaluateContentCompliance } from "@/lib/compliance-rules"
import { validateThemFirstContent } from "@/lib/them-first"
import { resolveAIModel } from "@/lib/kernel/ai-model"
import {
  logAIUsage,
  calculateCost,
  estimateTokens,
  checkPlatformAIEnabled,
  type AIModel
} from "./cost-tracking"
import { checkAIFairUse } from "./fair-use"

export type { AIModel } from "./cost-tracking"

function toGatewayModel(modelStr: string) {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) throw new Error("AI_GATEWAY_API_KEY is not configured")
  return createGateway({ apiKey: key })(modelStr)
}

const MODEL_CONFIG: Record<AIModel, { provider: string; modelId: string }> = {
  "claude-sonnet": { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
  "claude-opus": { provider: "anthropic", modelId: "claude-opus-4-20250514" },
  "claude-haiku": { provider: "anthropic", modelId: "claude-haiku-4-20250514" },
  "gpt-4o": { provider: "openai", modelId: "gpt-4o" },
  "gpt-4-turbo": { provider: "openai", modelId: "gpt-4-turbo" },
  "gpt-4o-mini": { provider: "openai", modelId: "gpt-4o-mini" },
  "gemini-pro": { provider: "google", modelId: "gemini-2.0-flash-exp" },
  "gemini-flash": { provider: "google", modelId: "gemini-2.0-flash-exp" },
  "perplexity-sonar": { provider: "perplexity", modelId: "sonar" },
  "perplexity-sonar-pro": { provider: "perplexity", modelId: "sonar-pro" }
}

/**
 * AI_TASK_ROUTING
 * ─────────────────────────────────────────────────────────────
 * Maps every feature/task type to its designated model + fallback.
 *
 * ROUTING RULES:
 *
 * claude-sonnet  → Long-form content generation, compliance-checked output,
 *                  anything going to a client or public-facing surface.
 *                  Best reasoning + instruction following for RE context.
 *
 * claude-haiku   → Fast internal tasks: classification, tagging, scoring,
 *                  short summaries, UI suggestions. Low cost, high volume.
 *
 * gpt-4o         → Structured data extraction, JSON output, form parsing,
 *                  code-adjacent tasks, function calling patterns.
 *                  Strong at strict schema adherence.
 *
 * gpt-4o-mini    → Simple yes/no decisions, sentiment labels, quick filters,
 *                  routing logic, single-field extractions. Cheapest option.
 *
 * perplexity-sonar-pro → Real-time market data, neighborhood research,
 *                        current news, anything requiring live web search.
 *                        Has internet access — the others do not.
 *
 * perplexity-sonar → Same as above for lighter research tasks.
 *
 * gemini-flash   → Vision tasks: property photo analysis, document scanning,
 *                  image classification. Fastest multimodal option.
 * ─────────────────────────────────────────────────────────────
 */
export const AI_TASK_ROUTING: Record<string, {
  model: AIModel
  fallback: AIModel
  reason: string
}> = {

  // ── CONTENT CREATION (client-facing, compliance-checked) ──────────────────
  email_generation:          { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Long-form client email — needs brand voice + Them-First compliance" },
  sms_generation:            { model: "claude-sonnet", fallback: "gpt-4o-mini",  reason: "Short-form outbound SMS — compliance critical" },
  newsletter_generation:     { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Full newsletter — long context, brand voice required" },
  social_post_generation:    { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Public-facing social content — Them-First + fair housing check" },
  listing_description:       { model: "claude-sonnet", fallback: "gpt-4o",       reason: "MLS-facing listing copy — fair housing compliance required" },
  video_script_generation:   { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Video scripts — brand voice, persona-aware, Them-First scored" },
  marketing_script_generation:{ model: "claude-sonnet", fallback: "gpt-4o",      reason: "Call/listing/objection scripts saved to the scripts library — agent-facing copy, brand voice" },
  direct_mail_copy:          { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Physical mailer copy — compliance + persona targeting" },
  blog_post_generation:      { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Long-form blog — SEO + brand voice" },
  ai_reply_coach:            { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Coaching agent reply drafts — nuanced tone guidance" },
  smart_reply_generation:    { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Generate smart reply suggestions for inbound messages" },
  communication_summary_generation: { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Summarize communication history for agent quick reference" },
  listing_presentation:      { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Seller presentation content — high stakes, brand quality" },
  cma_narrative:             { model: "claude-sonnet", fallback: "gpt-4o",       reason: "CMA written analysis — professional, data-driven narrative" },
  offer_analysis:            { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Offer comparison narrative for buyer — decision-critical" },
  playbook_response:         { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Agent coaching playbook responses — nuanced guidance" },
  portal_message:            { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Client portal messages — relationship-critical, client-facing" },
  ai_isa_response:           { model: "claude-sonnet", fallback: "gpt-4o",       reason: "ISA conversation replies — empathy + conversion critical" },
  home_assistant_qa:         { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Lifetime portal 'ask your home anything' — scoped, compliance-safe, client-facing" },
  sequence_step_content:     { model: "claude-sonnet", fallback: "gpt-4o",       reason: "Drip sequence email/SMS — must pass compliance pipeline" },
  live_avatar_conversation:  { model: "gpt-4o-mini",   fallback: "claude-haiku", reason: "D-ID Agents real-time conversational turns — latency-critical, short replies" },

  // ── RESEARCH + LIVE DATA (needs internet) ─────────────────────────────────
  market_insight_generation: { model: "perplexity-sonar-pro", fallback: "claude-sonnet", reason: "Live market data + neighborhood stats — requires web search" },
  neighborhood_research:     { model: "perplexity-sonar-pro", fallback: "claude-sonnet", reason: "Current school ratings, walkability, local stats" },
  competitive_monitoring:    { model: "perplexity-sonar-pro", fallback: "claude-sonnet", reason: "Live competitor listings + market positioning" },
  pricing_research:          { model: "perplexity-sonar",     fallback: "claude-sonnet", reason: "Current comp sales data — live MLS/web context" },
  home_value_estimate:       { model: "perplexity-sonar",     fallback: "claude-sonnet", reason: "Live AVM + recent sales context" },
  lead_enrichment_research:  { model: "perplexity-sonar",     fallback: "claude-sonnet", reason: "Web-research gap-fill for lead contact/identity when skip-trace is thin" },

  // ── STRUCTURED DATA EXTRACTION + JSON OUTPUT ──────────────────────────────
  // (offer_analysis lives above under decision-critical tasks; reuses same key)
  offer_data_extraction:     { model: "gpt-4o", fallback: "claude-sonnet",  reason: "Extract structured fields from offer documents — schema strict" },
  document_parsing:          { model: "gpt-4o", fallback: "claude-sonnet",  reason: "Parse contracts/forms into structured data" },
  lead_data_extraction:      { model: "gpt-4o", fallback: "claude-haiku",   reason: "Extract contact fields from raw lead payloads" },
  generate_json:             { model: "gpt-4o", fallback: "claude-sonnet",  reason: "Any task requiring strict JSON schema output" },
  license_verification:      { model: "gpt-4o", fallback: "claude-sonnet",  reason: "Extract license record fields from state regulator registry pages — extraction only, schema strict" },
  copilot_plan_generation:   { model: "gpt-4o", fallback: "claude-sonnet",  reason: "Structured daily plan with typed task objects" },
  transaction_coordinator:   { model: "gpt-4o", fallback: "claude-sonnet",  reason: "TC task list generation — structured milestone output" },

  // ── VISION + IMAGE ANALYSIS ────────────────────────────────────────────────
  property_image_analysis:   { model: "gemini-flash", fallback: "gpt-4o",   reason: "Photo scoring, feature detection, virtual staging analysis" },
  document_image_scan:       { model: "gemini-flash", fallback: "gpt-4o",   reason: "Scan uploaded document images for text extraction" },

  // ── FAST INTERNAL TASKS (classification, scoring, routing) ────────────────
  lead_analysis:             { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Lead scoring + persona classification — high volume, fast" },
  lead_routing:              { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Assign lead to agent/ISA — decision only, no content" },
  behavioral_pattern_detect: { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Classify contact behavior signals — runs frequently" },
  compliance_check:          { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Quick fair housing / Them-First flag detection" },
  sentiment_analysis:        { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Score inbound message sentiment — runs on every reply" },
  tag_classification:        { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Auto-tag contacts from conversation — fast, high volume" },
  import_value_normalization:{ model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Data Steward: map imported CRM values to canonical vocabulary — one batched call per import" },
  deal_health_check:         { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Transaction health score — runs every 4 hours on all deals" },
  onboarding_step_suggest:   { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Next onboarding action recommendation — internal only" },
  coaching_insight:          { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Agent performance nudge — internal, runs nightly" },

  // ── SIMPLE DECISIONS + ROUTING (cheapest path) ────────────────────────────
  intent_classification:     { model: "gpt-4o-mini", fallback: "claude-haiku", reason: "Classify user intent — voice/command bar routing" },
  yes_no_decision:           { model: "gpt-4o-mini", fallback: "claude-haiku", reason: "Binary decisions — approve/deny heuristics" },
  generate_text:             { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Generic short text — default fallback for unspecified tasks" },
  simple:                    { model: "claude-haiku", fallback: "gpt-4o-mini", reason: "Generic simple task from pipeline.ts runPipelineSimple" },
  unspecified:               { model: "claude-sonnet", fallback: "gpt-4o",     reason: "Unknown feature — default to best general model" },
}

/**
 * selectModelForTask
 * Returns the designated model and fallback for a given feature/task name.
 * Falls back to "unspecified" routing if the feature is not in the table.
 *
 * @example
 * const { model, fallback } = selectModelForTask("email_generation")
 * // → { model: "claude-sonnet", fallback: "gpt-4o" }
 */
export function selectModelForTask(feature: string): {
  model: AIModel
  fallback: AIModel
} {
  const route = AI_TASK_ROUTING[feature] ?? AI_TASK_ROUTING["unspecified"]
  return { model: route.model, fallback: route.fallback }
}

export interface ComplianceContext {
  requiresFairHousingCheck: boolean
  requiresThemFirstCheck: boolean
  requiresTCPACheck: boolean
  contactId?: string
  userId?: string
  brokerageId?: string | null
  contentType?: "email" | "sms" | "social" | "listing" | "internal"
}

export interface AIRequest {
  model?: AIModel
  system?: string
  prompt?: string
  messages?: Array<{ role: string; content: unknown }>
  temperature?: number
  maxTokens?: number
  fallbackModel?: AIModel
  compliance?: ComplianceContext
  metadata: {
    userId: string
    brokerageId?: string | null
    teamId?: string | null
    agentId?: string | null
    feature?: string
    contactId?: string
  }
}

export interface ComplianceViolation {
  type: "fair_housing" | "tcpa" | "them_first" | "other"
  severity: "low" | "medium" | "high" | "critical"
  message: string
  blockSending: boolean
}

export interface AIResponse {
  text: string
  model: AIModel
  tokensUsed: {
    input: number
    output: number
    total: number
  }
  costCents: number
  fallbackUsed: boolean
  complianceChecked: boolean
  complianceViolations: ComplianceViolation[]
  compliancePassed: boolean
  timestamp: string
  requestId: string
}

/**
 * Check content against compliance rules
 */
async function checkCompliance(
  content: string,
  context: ComplianceContext
): Promise<{ passed: boolean; violations: ComplianceViolation[] }> {
  const violations: ComplianceViolation[] = []
  const supabase = await createClient()
  
  try {
    // 1. TCPA Check - verify contact is not on DNC list
    if (context.requiresTCPACheck && context.contactId) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("dnc_status")
        .eq("id", context.contactId)
        .maybeSingle()
      
      if (contact?.dnc_status === true) {
        const violation: ComplianceViolation = {
          type: "tcpa",
          severity: "critical",
          message: "Contact is on Do Not Call list - cannot send outbound communication",
          blockSending: true
        }
        violations.push(violation)
        
        // Log blocking TCPA violation
        await supabase.from("compliance_flags").insert({
          user_id: context.userId,
          brokerage_id: context.brokerageId,
          violation_type: "tcpa_violation", // real column (was phantom flag_type)
          severity: "critical",
          flagged_content: `${violation.message} :: ${content.slice(0, 400)}`, // was phantom content_snippet/description
          detected_at: new Date().toISOString(),
          status: "flagged"
        })
      }
    }
    
    // 2. Fair Housing Check
    if (context.requiresFairHousingCheck) {
      try {
        const fairHousingResult = await evaluateContentCompliance({
          raw_content: content,
          content_type: context.contentType || "internal",
          channel_intent: context.contentType || "internal",
        })
        
        if (fairHousingResult.compliance_status !== "pass" && fairHousingResult.violations) {
          for (const v of fairHousingResult.violations) {
            const violation: ComplianceViolation = {
              type: "fair_housing",
              severity: v.severity as "low" | "medium" | "high" | "critical",
              message: v.description,
              blockSending: (v.severity as string) === "high" || (v.severity as string) === "critical"
            }
            violations.push(violation)
            
            // Log high severity violations
            if (violation.blockSending) {
              await supabase.from("compliance_flags").insert({
                user_id: context.userId,
                brokerage_id: context.brokerageId,
                violation_type: "fair_housing_violation", // real column (was phantom flag_type)
                severity: violation.severity,
                flagged_content: `${violation.message} :: ${content.slice(0, 400)}`, // was phantom content_snippet/description
                detected_at: new Date().toISOString(),
                status: "flagged"
              })
            }
          }
        }
      } catch (error) {
        console.error("[v0] Fair housing check failed:", error)
      }
    }
    
    // 3. Them-First Check
    if (context.requiresThemFirstCheck) {
      try {
        const themFirstResult = await validateThemFirstContent(content, "email")
        
        if (!themFirstResult.passed || (themFirstResult as any).score < 0.6) {
          const score = (themFirstResult as any).score ?? 0
          const violation: ComplianceViolation = {
            type: "them_first",
            severity: score < 0.3 ? "medium" : "low",
            message: `Content is too agent-focused (score: ${score.toFixed(2)}). Consider rewriting to focus on client benefits.`,
            blockSending: false // Them-First is advisory, not blocking
          }
          violations.push(violation)
        }
      } catch (error) {
        console.error("[v0] Them-First check failed:", error)
      }
    }
    
    const anyBlockingViolations = violations.some(v => v.blockSending)
    
    return {
      passed: !anyBlockingViolations,
      violations
    }
  } catch (error) {
    console.error("[v0] Compliance check error:", error)
    return { passed: true, violations: [] }
  }
}

/**
 * Execute model call with provider-specific configuration
 */
async function executeModelCall(
  model: AIModel,
  system: string | undefined,
  prompt: string,
  temperature: number,
  maxTokens: number
): Promise<{
  text: string
  inputTokens: number
  outputTokens: number
  modelUsed: AIModel
}> {
  const config = MODEL_CONFIG[model]
  
  if (!config) {
    throw new Error(`Unknown model: ${model}`)
  }
  
  // ONE LANE. Every provider in MODEL_CONFIG — including Perplexity — is reached
  // as "provider/modelId" through the Vercel AI Gateway.
  //
  // Perplexity used to be special-cased here with a direct `createOpenAI` client
  // pointed at https://api.perplexity.ai on PERPLEXITY_API_KEY. That was the only
  // text-generation call in the repo that left the gateway, and it disagreed with
  // generateTextRouted/generateObjectRouted BELOW IN THIS SAME FILE, which have
  // always sent perplexity-sonar / perplexity-sonar-pro through toGatewayModel.
  // The gateway carries them (`perplexity/sonar`, `perplexity/sonar-pro` are
  // GatewayModelId members in @ai-sdk/gateway), so the second client bought
  // nothing but a second key, a second bill and a second failure mode.
  const modelStr = `${config.provider}/${config.modelId}` as Parameters<typeof resolveModel>[0]
  const modelInstance: ReturnType<typeof resolveModel> = toGatewayModel(resolveModel(modelStr) as string)

  // ── DATA GUARD — the model-boundary checkpoint ────────────────────────────
  // Redact high-confidence secrets (SSN/ITIN, EIN, card PAN, bank account/routing) from the
  // system + prompt before they ever reach the LLM. The AI managers never need these; this
  // prevents them leaking into prompt logs / provider retention. Conservative — leaves names,
  // addresses, prices, phones untouched, so there is no functional loss.
  const { redactSensitive } = await import("@/lib/data-guard")
  const safeSystem = redactSensitive(system).text
  const { text: safePrompt } = redactSensitive(prompt)

  const result = await generateText({
    model: modelInstance,
    system: safeSystem || undefined,
    prompt: safePrompt,
    temperature,
    maxOutputTokens: maxTokens,
  })

  return {
    text: result.text,
    inputTokens: (result.usage as any)?.inputTokens ?? (result.usage as any)?.promptTokens ?? estimateTokens(prompt + (system || "")),
    outputTokens: (result.usage as any)?.outputTokens ?? (result.usage as any)?.completionTokens ?? estimateTokens(result.text),
    modelUsed: model
  }
}

/**
 * Generate AI response with full compliance checking and usage tracking
 */
export async function generateAIResponse(request: AIRequest): Promise<AIResponse> {
  const requestId = `ai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  const timestamp = new Date().toISOString()
  
  // Check platform AI enabled
  const platformCheck = await checkPlatformAIEnabled()
  if (!platformCheck.enabled) {
    throw new Error(platformCheck.reason || "AI features are disabled")
  }

  // Fair-use quota pre-flight (subscription-included AI — protects platform margin).
  // Estimate the call's token cost from the prompt + system so we trip BEFORE the
  // call rather than after the counter actually exceeds. Background jobs without
  // brokerageId are uncapped (handled inside checkAIFairUse).
  const estimatedTokens = estimateTokens(
    (request.prompt ?? "") + (request.system ?? "")
  ) + (request.maxTokens ?? 2000)
  const fairUse = await checkAIFairUse({
    brokerageId: request.metadata.brokerageId,
    addTokens:   estimatedTokens,
  })
  if (!fairUse.allowed) {
    throw new Error(fairUse.message ?? "AI fair-use limit reached for this billing period.")
  }

  // Resolve model through kernel cascade.
  // Priority: governance caps > explicit caller request > feature routing > platform default.
  // Explicit caller models are NOT exempt from governance — caps always apply when
  // actor context is available. Only background jobs (no userId/brokerageId) skip caps.
  let resolvedModel: AIModel

  if (request.metadata.userId && request.metadata.brokerageId) {
    // Full actor context — run kernel cascade with caller preference (may be undefined)
    resolvedModel = await resolveAIModel({
      feature:        request.metadata.feature || "unspecified",
      actorContext: {
        userId:      request.metadata.userId,
        agentId:     request.metadata.agentId   ?? undefined,
        brokerageId: request.metadata.brokerageId,
        teamId:      request.metadata.teamId     ?? undefined,
      },
      requestedModel: request.model ?? undefined,
    })
  } else {
    // No actor context — background job, webhook, cron.
    // Cannot evaluate brokerage caps without knowing who the actor is.
    // Use explicit request.model if provided, else static routing table.
    const { model: staticDefault } = selectModelForTask(
      request.metadata.feature || "unspecified"
    )
    resolvedModel = request.model ?? staticDefault
  }
  const model = resolvedModel

  // Fallback: use routed fallback from static table if no explicit fallback provided
  const { fallback: routedFallback } = selectModelForTask(
    request.metadata.feature || "unspecified"
  )
  const resolvedFallback = request.fallbackModel ?? routedFallback

  const temperature = request.temperature ?? 0.7
  const maxTokens = request.maxTokens ?? 2000
  
  let fallbackUsed = false
  let executionResult: Awaited<ReturnType<typeof executeModelCall>>
  
  // Try primary model
  try {
    executionResult = await executeModelCall(
      model,
      request.system,
      request.prompt ?? "",
      temperature,
      maxTokens
    )
  } catch (primaryError) {
    console.error(`[v0] Primary model ${model} failed:`, primaryError)
    
    // Try fallback if provided
    if (resolvedFallback) {
      try {
        executionResult = await executeModelCall(
          resolvedFallback,
          request.system,
          request.prompt ?? "",
          temperature,
          maxTokens
        )
        fallbackUsed = true
      } catch (fallbackError) {
        console.error(`[v0] Fallback model ${resolvedFallback} failed:`, fallbackError)
        throw new Error("Both primary and fallback models failed")
      }
    } else {
      throw primaryError
    }
  }
  
  // Run compliance checks if requested
  let complianceResult = { passed: true, violations: [] as ComplianceViolation[] }
  const complianceChecked = !!request.compliance
  
  if (request.compliance) {
    complianceResult = await checkCompliance(executionResult.text, request.compliance)
  }
  
  // Calculate cost
  const costCents = calculateCost(
    executionResult.modelUsed,
    executionResult.inputTokens,
    executionResult.outputTokens
  )
  
  // Log usage
  await logAIUsage({
    userId: request.metadata.userId,
    // `?? null`, NOT `?? ""`. These three land in uuid columns on ai_tool_usage.
    // Postgres refuses '' for a uuid with 22P02 (`invalid input syntax for type
    // uuid: ""` — reproduced live), and logAIUsage swallows the insert error into
    // a console line. So every call that lacked a full identity triple — a
    // background job, a cron, an unauthenticated path — vanished from the cost
    // ledger entirely rather than landing with the fields it did know.
    //
    // This matters more now than it did: ai_tool_usage is the single source of
    // record for AI spend (the content cost surface, increment_ai_usage_monthly
    // and the ai_tokens_monthly fair-use counter all read it), so a swallowed
    // insert is unbilled, uncapped spend. All three columns are nullable.
    brokerageId: request.metadata.brokerageId ?? null,
    teamId: request.metadata.teamId ?? null,
    agentId: request.metadata.agentId ?? null,
    model: executionResult.modelUsed,
    inputTokens: executionResult.inputTokens,
    outputTokens: executionResult.outputTokens,
    feature: request.metadata.feature || "unspecified",
    requestId
  })
  
  return {
    text: executionResult.text,
    model: executionResult.modelUsed,
    tokensUsed: {
      input: executionResult.inputTokens,
      output: executionResult.outputTokens,
      total: executionResult.inputTokens + executionResult.outputTokens
    },
    costCents,
    fallbackUsed,
    complianceChecked,
    complianceViolations: complianceResult.violations,
    compliancePassed: complianceResult.passed,
    timestamp,
    requestId
  }
}

/**
 * generateTextRouted
 * ─────────────────────────────────────────────────────────────
 * Drop-in replacement for the raw AI SDK `generateText` that routes
 * every call through AI_TASK_ROUTING → resolveAIModel instead of
 * accepting a hardcoded model string.
 *
 * Usage — change the import, keep the call site exactly the same:
 *   import { generateTextRouted as generateText } from "@/lib/ai/models"
 *
 * The `model` field is accepted for backwards-compat but is IGNORED —
 * the routing table governs which model actually runs.
 * The optional `feature` key selects the routing row (defaults to "unspecified"
 * → claude-sonnet, which is the Anthropic default for all content tasks).
 */
export interface RoutedTextRequest {
  /** Ignored — routing table governs model selection */
  model?: string
  prompt?: string
  system?: string
  maxTokens?: number
  temperature?: number
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * Feature key from AI_TASK_ROUTING.
   * Defaults to "unspecified" → claude-sonnet + gpt-4o fallback.
   * @example "email_generation" | "social_post_generation" | "lead_analysis"
   */
  feature?: string
  /** Optional — used only for usage logging, not routing */
  userId?: string
  brokerageId?: string | null
  agentId?: string
  /** Tools the model can invoke — same shape as AI SDK's tool() helper.
   *  When omitted, behaves as a plain text-generation call (current default). */
  tools?: Record<string, unknown>
  /** Multi-step tool calling: stop after N steps. Defaults to 1 (text only)
   *  in the SDK; set higher for tool-using flows (typical: 5). */
  maxSteps?: number
}

/**
 * Structured-output variant of generateTextRouted — same routing, fallback,
 * and gateway wrapping as the text version, but returns a typed object via
 * the AI SDK's experimental_output schema.
 *
 * Use this instead of importing `generateText` from "ai" when you need
 * structured JSON output. Bypassing this skips brokerage routing + fallback +
 * gateway billing.
 */
export async function generateObjectRouted<TSchema extends z.ZodTypeAny>(
  request: RoutedTextRequest & { schema: TSchema }
): Promise<{ object: z.infer<TSchema> }> {
  const feature = request.feature ?? 'unspecified'
  const { model: routedModel, fallback } = selectModelForTask(feature)

  // Fair-use pre-flight (skipped for background jobs without brokerageId)
  const estTokens = estimateTokens((request.prompt ?? "") + (request.system ?? "")) + (request.maxTokens ?? 2000)
  const fairUse = await checkAIFairUse({ brokerageId: request.brokerageId, addTokens: estTokens })
  if (!fairUse.allowed) throw new Error(fairUse.message ?? "AI fair-use limit reached.")

  // Data Guard — redact high-confidence secrets before either model call (primary + fallback).
  {
    const { redactSensitive } = await import("@/lib/data-guard")
    if (request.prompt) request.prompt = redactSensitive(request.prompt).text
    if (request.system) request.system = redactSensitive(request.system).text
  }

  const primaryConfig = MODEL_CONFIG[routedModel] ?? MODEL_CONFIG['claude-sonnet']
  const primaryModelStr = `${primaryConfig.provider}/${primaryConfig.modelId}`
  const primaryInstance = toGatewayModel(resolveModel(primaryModelStr as Parameters<typeof resolveModel>[0]) as string)

  let modelUsed: AIModel = routedModel
  let inputTokens = 0
  let outputTokens = 0
  let resultObject: z.infer<TSchema>

  try {
    const result = await generateText({
      model: primaryInstance,
      prompt: request.prompt,
      system: request.system,
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
      messages: request.messages as any,
      experimental_output: Output.object({ schema: request.schema }),
    })
    inputTokens  = (result.usage as any)?.inputTokens  ?? (result.usage as any)?.promptTokens     ?? estimateTokens((request.prompt ?? "") + (request.system ?? ""))
    outputTokens = (result.usage as any)?.outputTokens ?? (result.usage as any)?.completionTokens ?? 0
    resultObject = result.experimental_output as z.infer<TSchema>
  } catch {
    const fallbackConfig = MODEL_CONFIG[fallback] ?? MODEL_CONFIG['gpt-4o']
    const fallbackModelStr = `${fallbackConfig.provider}/${fallbackConfig.modelId}`
    const fallbackInstance = toGatewayModel(resolveModel(fallbackModelStr as Parameters<typeof resolveModel>[0]) as string)
    const result = await generateText({
      model: fallbackInstance,
      prompt: request.prompt,
      system: request.system,
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
      messages: request.messages as any,
      experimental_output: Output.object({ schema: request.schema }),
    })
    modelUsed    = fallback
    inputTokens  = (result.usage as any)?.inputTokens  ?? (result.usage as any)?.promptTokens     ?? estimateTokens((request.prompt ?? "") + (request.system ?? ""))
    outputTokens = (result.usage as any)?.outputTokens ?? (result.usage as any)?.completionTokens ?? 0
    resultObject = result.experimental_output as z.infer<TSchema>
  }

  if (request.userId && request.brokerageId) {
    await logAIUsage({
      userId:       request.userId,
      brokerageId:  request.brokerageId,
      agentId:      request.agentId ?? null,
      model:        modelUsed,
      inputTokens,
      outputTokens,
      feature,
    })
  }

  return { object: resultObject }
}

export async function generateTextRouted(
  request: RoutedTextRequest
): Promise<{ text: string }> {
  const feature = request.feature ?? 'unspecified'
  const { model: routedModel, fallback } = selectModelForTask(feature)

  // Fair-use pre-flight (skipped for background jobs without brokerageId)
  const estTokens = estimateTokens((request.prompt ?? "") + (request.system ?? "")) + (request.maxTokens ?? 2000)
  const fairUse = await checkAIFairUse({ brokerageId: request.brokerageId, addTokens: estTokens })
  if (!fairUse.allowed) throw new Error(fairUse.message ?? "AI fair-use limit reached.")

  // Data Guard — redact high-confidence secrets before either model call (primary + fallback).
  {
    const { redactSensitive } = await import("@/lib/data-guard")
    if (request.prompt) request.prompt = redactSensitive(request.prompt).text
    if (request.system) request.system = redactSensitive(request.system).text
  }

  // Resolve primary model to gateway-wrapped provider instance
  const primaryConfig = MODEL_CONFIG[routedModel] ?? MODEL_CONFIG['claude-sonnet']
  const primaryModelStr = `${primaryConfig.provider}/${primaryConfig.modelId}`
  const primaryInstance = toGatewayModel(resolveModel(primaryModelStr as Parameters<typeof resolveModel>[0]) as string)

  // When tools are present we need multi-step support; default to 5 steps so
  // the model can call a tool, see the result, and produce a final reply.
  const stopWhen = request.tools ? stepCountIs(request.maxSteps ?? 5) : undefined

  let modelUsed: AIModel = routedModel
  let inputTokens = 0
  let outputTokens = 0
  let resultText = ""

  try {
    const result = await generateText({
      model: primaryInstance,
      prompt: request.prompt,
      system: request.system,
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
      messages: request.messages as any,
      tools: request.tools as any,
      stopWhen,
    })
    inputTokens  = (result.usage as any)?.inputTokens  ?? (result.usage as any)?.promptTokens     ?? estimateTokens((request.prompt ?? "") + (request.system ?? ""))
    outputTokens = (result.usage as any)?.outputTokens ?? (result.usage as any)?.completionTokens ?? estimateTokens(result.text)
    resultText   = result.text
  } catch {
    // Automatic fallback to secondary model via gateway
    const fallbackConfig = MODEL_CONFIG[fallback] ?? MODEL_CONFIG['gpt-4o']
    const fallbackModelStr = `${fallbackConfig.provider}/${fallbackConfig.modelId}`
    const fallbackInstance = toGatewayModel(resolveModel(fallbackModelStr as Parameters<typeof resolveModel>[0]) as string)
    const result = await generateText({
      model: fallbackInstance,
      prompt: request.prompt,
      system: request.system,
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
      messages: request.messages as any,
      tools: request.tools as any,
      stopWhen,
    })
    modelUsed    = fallback
    inputTokens  = (result.usage as any)?.inputTokens  ?? (result.usage as any)?.promptTokens     ?? estimateTokens((request.prompt ?? "") + (request.system ?? ""))
    outputTokens = (result.usage as any)?.outputTokens ?? (result.usage as any)?.completionTokens ?? estimateTokens(result.text)
    resultText   = result.text
  }

  if (request.userId && request.brokerageId) {
    await logAIUsage({
      userId:       request.userId,
      brokerageId:  request.brokerageId,
      agentId:      request.agentId ?? null,
      model:        modelUsed,
      inputTokens,
      outputTokens,
      feature,
    })
  }

  return { text: resultText }
}

/**
 * Generate simple text response without compliance checks
 */
export async function generateSimpleText(
  prompt: string,
  metadata: { 
    userId: string
    brokerageId: string
    teamId?: string
    agentId?: string
    feature?: string 
  },
  options?: { 
    model?: AIModel
    system?: string
    temperature?: number 
  }
): Promise<string> {
  const response = await generateAIResponse({
    prompt,
    model: options?.model,
    system: options?.system,
    temperature: options?.temperature,
    metadata: {
      userId: metadata.userId,
      brokerageId: metadata.brokerageId,
      teamId: metadata.teamId || null,
      agentId: metadata.agentId || null,
      feature: metadata.feature
    }
  })
  
  return response.text
}

/**
 * Generate public-facing content with Fair Housing and Them-First compliance
 */
export async function generatePublicContent(
  prompt: string,
  metadata: {
    userId: string
    brokerageId?: string | null
    teamId?: string
    agentId?: string
    contentType: "email" | "sms" | "social" | "listing"
    feature?: string
  }
): Promise<AIResponse> {
  return generateAIResponse({
    prompt,
    metadata: {
      userId: metadata.userId,
      brokerageId: metadata.brokerageId,
      teamId: metadata.teamId || null,
      agentId: metadata.agentId || null,
      feature: metadata.feature
    },
    compliance: {
      requiresFairHousingCheck: true,
      requiresThemFirstCheck: true,
      requiresTCPACheck: false,
      userId: metadata.userId,
      brokerageId: metadata.brokerageId,
      contentType: metadata.contentType
    }
  })
}

/**
 * Generate outbound message with full compliance (TCPA, Fair Housing, Them-First)
 */
export async function generateOutboundMessage(
  prompt: string,
  contactId: string,
  metadata: {
    userId: string
    brokerageId?: string | null
    teamId?: string
    agentId?: string
    contentType: "email" | "sms"
    feature?: string
  }
): Promise<AIResponse> {
  return generateAIResponse({
    prompt,
    metadata: {
      userId: metadata.userId,
      brokerageId: metadata.brokerageId,
      teamId: metadata.teamId || null,
      agentId: metadata.agentId || null,
      feature: metadata.feature,
      contactId
    },
    compliance: {
      requiresFairHousingCheck: true,
      requiresThemFirstCheck: true,
      requiresTCPACheck: true,
      contactId,
      userId: metadata.userId,
      brokerageId: metadata.brokerageId,
      contentType: metadata.contentType
    }
  })
}
