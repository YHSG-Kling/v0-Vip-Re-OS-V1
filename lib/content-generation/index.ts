// ─── CONTENT GENERATOR ────────────────────────────────────────────────────────
export type { ContentGenerationOutput, ContentGenerationParams } from "./content-generator"
export {
  generateTextContent,
  generateAudioScript,
  generateVideoScript,
  // generateImagePrompt RETIRED (wave 155, lane 155R20) — see the tombstone in ./content-generator.ts
  generateOmnipresentContent,
  generateContentVariations,
} from "./content-generator"

// ─── CONTEXT ENRICHER ─────────────────────────────────────────────────────────
export type {
  EnrichedContext,
  ListingContext,
  ContactContext,
  TransactionContext,
} from "./context-enricher"
export { gatherContext, enrichPromptWithContext } from "./context-enricher"

// ─── GENERATION LOGGER ────────────────────────────────────────────────────────
export {
  logContentGeneration,
  logBatchContentGeneration,
  logOmnipresentGeneration,
  getContentGenerationHistory,
  getContentGenerationStats,
} from "./generation-logger"
