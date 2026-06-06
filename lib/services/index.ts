// ─── CONTACT MANAGEMENT ───────────────────────────────────────────────────────
export type { CreateContactParams, UpdateContactParams } from "./contact-management.service"
export {
  createContact,
  updateContact,
  deleteContact,
  getContact,
  getContacts,
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
export {
  triggerGHLWorkflow,
} from "./platform-sync.service"

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
  calculateTransactionCommission,
} from "./transaction-management.service"

// ─── COMMUNICATION ────────────────────────────────────────────────────────────
export type { SendEmailParams, SendSMSParams, LogCommunicationParams } from "./communication.service"
export {
  sendEmail,
  sendSMS,
  logCommunication,
  sendCalculatorResults,
  sendCollaborativeSearchInvite,
  sendAnniversaryMessage,
  sendVendorBookingConfirmation,
} from "./communication.service"
