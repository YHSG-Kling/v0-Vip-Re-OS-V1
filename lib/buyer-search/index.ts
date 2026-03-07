// ─── SEARCH ENGINE ────────────────────────────────────────────────────────────
export type { BuyerSearchResult, BuyerSearchParams } from "./search-engine"
export { searchPropertiesCore, explainPropertyMatchCore } from "./search-engine"

// ─── INTENT PARSER ────────────────────────────────────────────────────────────
export type { ParsedBuyerIntent } from "./intent-parser"
export { parseNaturalLanguageQuery, mergeIntentWithContext, intentToFilters } from "./intent-parser"

// ─── PERSONA INFERENCE ────────────────────────────────────────────────────────
export type { BuyerPersona, PersonaProfile } from "./persona-inference"
export { inferBuyerPersona, getPersonaMessagingGuidelines } from "./persona-inference"

// ─── EXPLANATION GENERATOR ────────────────────────────────────────────────────
export type { BuyerFacingExplanation } from "./explanation-generator"
export { generateMatchExplanation } from "./explanation-generator"

// ─── SEARCH LOGGER ────────────────────────────────────────────────────────────
export type { BuyerSearchSignalPayload } from "./search-logger"
export {
  logBuyerSearchMatch,
  logBatchBuyerSearchMatches,
  appendBuyerSearchPreferences,
  getBuyerSearchHistory,
} from "./search-logger"
