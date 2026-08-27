// ─── EMPATHY LIBRARY ──────────────────────────────────────────────────────────
export type { EmpathyResponse } from "./empathy-library"
export {
  EMPATHY_RESPONSES,
  getEmpathyResponse,
  getAllEmpathyResponses,
  listAllPersonas,
} from "./empathy-library"

// ─── VALIDATOR ────────────────────────────────────────────────────────────────
//
// TOMBSTONE (2026-08-27, §1.3) — app/api/validate-them-first/route.ts is
// DELETED. It was a session-gated HTTP wrapper around validateThemFirstContent
// with ZERO in-tree callers (the lane that added its auth recorded the same:
// "Nothing in the tree addresses this route"). The capability is not lost —
// the validator's LIVE consumer is lib/ai/models.ts:387, which runs it inline
// on gateway-generated email content, and the deterministic Them-First verdict
// every gate shares is lib/compliance-rules/rule-evaluators.ts:402
// evaluateThemFirstFocus (via lib/kernel/compliance). A future interactive
// "score my copy" surface should call validateThemFirstContent through a
// server action carrying the session's tenant, exactly as models.ts does.
export type { ContentType, ValidationResult } from "./validator"
export { validateThemFirstContent } from "./validator"
