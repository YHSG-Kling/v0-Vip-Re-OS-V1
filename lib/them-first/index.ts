// ─── EMPATHY LIBRARY ──────────────────────────────────────────────────────────
//
// TOMBSTONE (2026-08-27, §1.3, lane CB) — app/api/them-first/empathy-response/
// route.ts is DELETED. It was an UNAUTHENTICATED, tenant-less HTTP door and the
// library's ONLY consumer, itself called by nothing (repo-wide, stripped
// source; recorded by the prospects_route_family_retired registry entry as the
// open question of this family). The question is now answered the §1.2 way:
// the library is WIRED to a real surface — empathyGuidanceForCrmPersona (the
// CRM-persona bridge in ./empathy-library.ts) feeds the authored Them-First
// arc into the nurture rail's drip-campaign prompt at
// app/actions/ai-lead-nurturing.ts (generatePersonalizedCampaign), keyed off
// the contact's live persona/contact_type. With a wired consumer in place, an
// uncalled public route serving the same content is a duplicate door, not a
// capability.
export type { EmpathyResponse } from "./empathy-library"
export {
  EMPATHY_RESPONSES,
  getEmpathyResponse,
  getAllEmpathyResponses,
  listAllPersonas,
  empathyGuidanceForCrmPersona,
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
