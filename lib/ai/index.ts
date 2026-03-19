// ─── CORE GENERATION ──────────────────────────────────────────────────────────
export { generateAIJSON, generateAIText, generateChatResponse, generateAIObject } from "./generate"

// ─── MODELS / RESPONSE PIPELINE ───────────────────────────────────────────────
export type { ComplianceContext, AIRequest, ComplianceViolation, AIResponse } from "./models"
export { generateAIResponse, generateSimpleText, generatePublicContent, generateOutboundMessage, selectModelForTask, AI_TASK_ROUTING } from "./models"

// ─── PIPELINE (persona / brand-voice aware) ───────────────────────────────────
export type { PersonaContext, BrandVoiceContext, PipelineRequest, PipelineResponse, SimplePipelineOptions } from "./pipeline"
export { runPipeline, runPipelineSimple, invalidatePersonaCache, invalidateBrandVoiceCache } from "./pipeline"

// ─── LEAD ANALYZER ────────────────────────────────────────────────────────────
export { analyzeLead } from "./lead-analyzer"

// ─── VISION ANALYZER ──────────────────────────────────────────────────────────
export { analyzePropertyImages } from "./vision-analyzer"

// ─── SMART SUGGESTIONS ────────────────────────────────────────────────────────
export type { SmartSuggestionData } from "./smart-suggestions"
export { generateSmartSuggestions } from "./smart-suggestions"

// ─── COST TRACKING ────────────────────────────────────────────────────────────
export type { AIModel } from "./cost-tracking"
export {
  getModelPricing,
  calculateCost,
  estimateTokens,
  logAIUsage,
  getCurrentMonthUsage,
  checkPlatformAIEnabled,
} from "./cost-tracking"
