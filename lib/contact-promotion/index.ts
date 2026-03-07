// ─── PROMOTION ELIGIBILITY ────────────────────────────────────────────────────
export type { PromotionEligibility } from "./promotion-eligibility"
export { validatePromotionEligibility } from "./promotion-eligibility"

// ─── CONTACT CREATOR ──────────────────────────────────────────────────────────
export type { ContactCreationData } from "./contact-creator"
export { createContactFromLead } from "./contact-creator"

// ─── LEAD DEACTIVATOR ─────────────────────────────────────────────────────────
export { deactivateLead } from "./lead-deactivator"

// ─── PROMOTE LEAD TO CONTACT ──────────────────────────────────────────────────
export type { PromotionResult } from "./promote-lead-to-contact"
export { promoteLeadToContactService } from "./promote-lead-to-contact"

// ─── PROMOTION LOGGER ─────────────────────────────────────────────────────────
export type { PromotionLogData } from "./promotion-logger"
export { logPromotionActivity } from "./promotion-logger"
