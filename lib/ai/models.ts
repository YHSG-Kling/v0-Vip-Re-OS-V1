import { generateText } from "ai"
import { createClient } from "@/lib/supabase/server"
import { evaluateContentCompliance } from "@/lib/compliance-rules"
import { validateThemFirstContent } from "@/lib/them-first/validator"
import { 
  logAIUsage, 
  calculateCost, 
  estimateTokens, 
  checkPlatformAIEnabled,
  type AIModel 
} from "./cost-tracking"

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

export interface ComplianceContext {
  requiresFairHousingCheck: boolean
  requiresThemFirstCheck: boolean
  requiresTCPACheck: boolean
  contactId?: string
  userId?: string
  brokerageId?: string
  contentType?: "email" | "sms" | "social" | "listing" | "internal"
}

export interface AIRequest {
  model?: AIModel
  system?: string
  prompt: string
  temperature?: number
  maxTokens?: number
  fallbackModel?: AIModel
  compliance?: ComplianceContext
  metadata: {
    userId: string
    brokerageId: string
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
        .single()
      
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
          flag_type: "tcpa_violation",
          severity: "critical",
          description: violation.message,
          content_snippet: content.slice(0, 500),
          detected_at: new Date().toISOString(),
          auto_detected: true,
          status: "flagged"
        })
      }
    }
    
    // 2. Fair Housing Check
    if (context.requiresFairHousingCheck) {
      try {
        const fairHousingResult = await evaluateContentCompliance({
          content,
          contentType: context.contentType || "internal",
          userId: context.userId || "",
          brokerageId: context.brokerageId || ""
        })
        
        if (!fairHousingResult.compliant && fairHousingResult.violations) {
          for (const v of fairHousingResult.violations) {
            const violation: ComplianceViolation = {
              type: "fair_housing",
              severity: v.severity as "low" | "medium" | "high" | "critical",
              message: v.message,
              blockSending: v.severity === "high" || v.severity === "critical"
            }
            violations.push(violation)
            
            // Log high severity violations
            if (violation.blockSending) {
              await supabase.from("compliance_flags").insert({
                user_id: context.userId,
                brokerage_id: context.brokerageId,
                flag_type: "fair_housing_violation",
                severity: violation.severity,
                description: violation.message,
                content_snippet: content.slice(0, 500),
                detected_at: new Date().toISOString(),
                auto_detected: true,
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
        
        if (themFirstResult.score < 0.6) {
          const violation: ComplianceViolation = {
            type: "them_first",
            severity: themFirstResult.score < 0.3 ? "medium" : "low",
            message: `Content is too agent-focused (score: ${themFirstResult.score.toFixed(2)}). Consider rewriting to focus on client benefits.`,
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
  
  let modelInstance: any
  
  switch (config.provider) {
    case "anthropic": {
      const { anthropic } = await import("@ai-sdk/anthropic")
      modelInstance = anthropic(config.modelId)
      break
    }
    
    case "openai": {
      const { openai } = await import("@ai-sdk/openai")
      modelInstance = openai(config.modelId)
      break
    }
    
    case "google": {
      const { google } = await import("@ai-sdk/google")
      modelInstance = google(config.modelId)
      break
    }
    
    case "perplexity": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const perplexity = createOpenAI({
        apiKey: process.env.PERPLEXITY_API_KEY || "",
        baseURL: "https://api.perplexity.ai"
      })
      modelInstance = perplexity(config.modelId)
      break
    }
    
    default:
      throw new Error(`Unsupported provider: ${config.provider}`)
  }
  
  const result = await generateText({
    model: modelInstance,
    system,
    prompt,
    temperature,
    maxTokens
  })
  
  return {
    text: result.text,
    inputTokens: result.usage?.promptTokens || estimateTokens(prompt + (system || "")),
    outputTokens: result.usage?.completionTokens || estimateTokens(result.text),
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
  
  // Set defaults
  const model = request.model || "claude-sonnet"
  const temperature = request.temperature ?? 0.7
  const maxTokens = request.maxTokens ?? 2000
  
  let fallbackUsed = false
  let executionResult: Awaited<ReturnType<typeof executeModelCall>>
  
  // Try primary model
  try {
    executionResult = await executeModelCall(
      model,
      request.system,
      request.prompt,
      temperature,
      maxTokens
    )
  } catch (primaryError) {
    console.error(`[v0] Primary model ${model} failed:`, primaryError)
    
    // Try fallback if provided
    if (request.fallbackModel) {
      try {
        executionResult = await executeModelCall(
          request.fallbackModel,
          request.system,
          request.prompt,
          temperature,
          maxTokens
        )
        fallbackUsed = true
      } catch (fallbackError) {
        console.error(`[v0] Fallback model ${request.fallbackModel} failed:`, fallbackError)
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
    brokerageId: request.metadata.brokerageId,
    teamId: request.metadata.teamId,
    agentId: request.metadata.agentId,
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
    brokerageId: string
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
    brokerageId: string
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
