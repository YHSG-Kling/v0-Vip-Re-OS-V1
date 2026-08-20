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

// ─── HISTORY CARRY (link + re-point, never duplicate) ─────────────────────────
export type { HistoryCarryParams, HistoryCarryResult } from "./history-carry"
export { carryLeadHistoryToContact, REPOINTED_HISTORY_TABLES } from "./history-carry"

// ─── PORTAL ACCESS ON CONVERSION ──────────────────────────────────────────────
export type { PortalAccessParams, PortalAccessResult } from "./portal-access"
export { grantPortalAccessForPromotedContact, PORTAL_EXCLUDED_CONTACT_TYPES } from "./portal-access"

// ─── PROMOTION LOGGER ─────────────────────────────────────────────────────────
export type { PromotionLogData } from "./promotion-logger"
export { logPromotionActivity } from "./promotion-logger"
