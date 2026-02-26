// ─── RESPONSE GENERATOR ───────────────────────────────────────────────────────
export type { ResponseContext, GeneratedResponse } from "./response-generator"
export { generateAIResponse } from "./response-generator"

// ─── QUALIFICATION ENGINE ─────────────────────────────────────────────────────
export type { QualificationSignals, ExtractSignalsParams } from "./qualification-engine"
export { extractQualificationSignals, persistQualificationSignals } from "./qualification-engine"

// ─── HANDOFF DETECTOR ─────────────────────────────────────────────────────────
export type { HandoffSignal, HandoffContext } from "./handoff-detector"
export { evaluateHandoffReadiness, logHandoffSignal } from "./handoff-detector"
