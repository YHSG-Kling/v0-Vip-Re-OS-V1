// ─── CONTACT MANAGEMENT ───────────────────────────────────────────────────────
// createContact / updateContact DELETED (wave 57, Task B duplicates round 2)
// — see the tombstones in ./contact-management.service.ts naming their
// survivors in app/actions/contacts.ts. getContacts DELETED (wave 60,
// duplicates round 6, lane 60C) — survivor app/actions/contacts.ts:95.
export {
  deleteContact,
  getContact,
  addContactTags,
  removeContactTags,
  mergeContacts,
} from "./contact-management.service"

// ─── CONTENT GENERATION ───────────────────────────────────────────────────────
export type { ContentGenerationParams, ContentGenerationResult } from "./content-generation.service"
export { generateContent, bulkGenerateContent } from "./content-generation.service"

// ─── LEAD MANAGEMENT ──────────────────────────────────────────────────────────
export type { LeadScoringParams, LeadScoringResult } from "./lead-management.service"
export {
  calculateLeadScore,
  bulkRecalculateLeadScores,
  bulkRecalculateScrapedLeadScores,
  bulkRecalculateAllScores,
  getTopLeads,
  getLeadsNeedingAttention,
} from "./lead-management.service"

// ─── PLATFORM SYNC ────────────────────────────────────────────────────────────
// TOMBSTONE (dead-import tranche): `./platform-sync.service` is DELETED, and so
// is the `export {}` that stood here re-exporting nothing from it.
//
// The file had been hollowed out to FOUR IMPORTS AND NO EXPORTS —
// createServiceClient, isValidUUID, handleError and callConnector, every one of
// them dead, which is how the dead-import census found it. Its single export was
// ever `triggerGHLWorkflow`, and that capability is gone by decision, not by
// accident: app/crm/page.tsx:1468 records "we no longer trigger GHL workflows
// from the contact card".
//
// WHERE THE SURVIVING HALVES LIVE:
//   · LISTING SYNDICATION (the name this file's title claimed) →
//     lib/platform-sync.ts:43 syncToPlatform / :145 removePlatformListing /
//     :186 updatePlatformListing, wired from
//     app/actions/marketing-package-automation.ts:12.
//   · THE GHL DIRECTION THAT SURVIVES is inbound, not outbound —
//     lib/workflow/triggers.ts:109 (`ghl_contact_tag_added`) received by
//     app/api/workflow/trigger/route.ts.
// The stale pointer at lib/services/communication.service.tsx:177 ("GHL sync is
// owned by lib/services/platform-sync.service.ts") is corrected there.

// ─── SOCIAL PUBLISHING ────────────────────────────────────────────────────────
export type { PublishPostParams, PublishResult } from "./social-publishing.service"
export {
  publishToSocialMedia,
  schedulePost,
  getPostAnalytics,
  bulkPublishPosts,
  cancelScheduledPost,
} from "./social-publishing.service"

// ─── TRANSACTION MANAGEMENT ───────────────────────────────────────────────────
export type { UpdateTransactionParams } from "./transaction-management.service"
export {
  updateTransaction,
  getTransactionDetails,
  getAgentTransactions,
  archiveTransaction,
  // calculateTransactionCommission consolidated into lib/commission/engine.ts:calculateCommission
} from "./transaction-management.service"

// ─── COMMUNICATION ────────────────────────────────────────────────────────────
// sendEmail / sendSMS re-exports REMOVED (duplicates round 5, lane 59C,
// 2026-09-12) — this barrel had zero importers of either name (the barrel
// itself has zero importers, full stop), and the underlying
// communication.service.tsx wrappers were deleted; see the tombstone there
// naming lib/providers/messaging/index.ts as survivor.
export type { LogCommunicationParams } from "./communication.service"
export {
  logCommunication,
  sendCalculatorResults,
  sendCollaborativeSearchInvite,
  sendAnniversaryMessage,
} from "./communication.service"
