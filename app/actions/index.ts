/**
 * SMART ENGINE - SERVER ACTIONS INDEX
 * ====================================
 * Central export point for all server actions.
 * Import from here for consistency and to avoid duplicates.
 * 
 * IMPORTANT: Always use these canonical exports rather than importing
 * directly from individual action files to prevent duplication.
 *
 * CENSUS (lane CD, 2026-08-28): the paragraph above is FALSE IN PRACTICE and
 * has been for some time — ZERO files import this barrel (every `…/actions`
 * import specifier in the tree was resolved; none lands here; positive control
 * getContacts resolves 7 direct-path importers). Of the 157 names re-exported
 * here, 93 are referenced somewhere by direct path and 64 are BARREL-ONLY —
 * reachable on paper only, which scripts/orphan-export-guard.ts scores as
 * "wired" because a barrel mention counts as a reference. So this file is not
 * an entry point; it is a paper shield over 64 function-level orphans
 * (list in the lane-CD report). Do not add new re-exports here to "wire"
 * something. Whether the barrel is deleted (flipping those 64 into the orphan
 * ledger honestly, which the only-down baseline must absorb) is the
 * integrator's call, recorded open.
 */

// ============================================
// CRM & CONTACTS (Primary: crm.ts)
// ============================================
// Lane E2 (2026-08-28) adjudicated the 51 barrel-only names recorded by the
// census above: each was either DELETED at its defining module (tombstone
// naming the survivor sits there) or WIRED to a real importer — in either
// case its line here is gone, because a barrel mention is paper, not a wire.
export {
  getContacts,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  searchContacts,
  // getContactTimeline deleted — tombstone at crm.ts names the survivor
  mergeContacts,
} from "./crm"

// Additional contact functions from contact-details.ts
export {
  getContactActivity,
  getContactDocuments,
  getContactTransactions,
  // getContactInteractions deleted — tombstone at contact-details.ts
} from "./contact-details"

// Contact enrichment
export {
  // enrichContactData alias deleted (§6) — canonical name is enrichContact
  getContactInsights,
} from "./contact-enrichment"

// Conversation analytics & sentiment tracking
export {
  logConversationMetadata,
  runWeeklyAIAudit,
  // getConversationAnalytics / getAuditFlags deleted — tombstones in module
  reviewAuditFlag,
} from "./conversation-analytics"

// Voice call bridge & AI voice bots
export {
  initiateWhisperBridge,
  updateWhisperBridgeStatus,
  triggerAiVoiceCall,
  // getWhisperBridgeCalls deleted — tombstone at voice-call-bridge.ts
} from "./voice-call-bridge"

// Voice assistant (hands-free AI assistant)
export {
  processVoiceCommand,
  startVoiceSession,
  endVoiceSession,
  getVoiceConfig,
  updateVoiceConfig,
  // getVoiceCommandHistory deleted — tombstone at voice-assistant.ts
} from "./voice-assistant"

// AI ISA (Inside Sales Agent) - Autonomous outbound calling
export {
  // launchAIISACampaign / queueAIISACall / getAIISACampaigns / getAIISACalls
  // deleted — tombstone at ai-isa.ts names the live survivors
  retryFailedCalls,
  updateCampaignStatus,
} from "./ai-isa"

// AI Tools Hub - Centralized AI tools with RAG knowledge base
export {
  executeAITool,
  toggleToolFavorite,
  getUserFavorites,
  getAIToolUsageStats,
} from "./ai-tools-hub"

// Agent Onboarding - 7-day onboarding with AI Buddy
export {
  // startAgentOnboarding / getOnboardingStatus deleted — tombstones at
  // ai-agent-onboarding.ts name the kernel-lane survivors
  completeAISessionStep,
  // matchMentor retired → canonical deterministic matcher at app/actions/onboarding/mentorship.ts
  // verifyAgentLicense retired → the licence is verified against the STATE REGISTRY by
  // app/actions/onboarding/license.ts:submitLicenseDetails → lib/onboarding/license-verifier.ts.
  // The copy here asked an LLM to "simulate a verification result with high confidence"
  // and wrote verification_status='verified' from the agent's own session.
  generateWelcomeMessage,
  // getOnboardingAnalytics / askOnboardingBuddy deleted — tombstones at
  // ai-agent-onboarding.ts
  // submitQuizAttempt retired → canonical gated writer at
  // lib/kernel/agent-onboarding.ts:submitQuizAttempt (reached from
  // app/actions/onboarding/onboarding-quiz-actions.ts:submitQuiz)
  // certifyAgent deleted — tombstone at ai-agent-onboarding.ts names
  // claimCertification as canonical
} from "./ai-agent-onboarding"

// ============================================
// LISTINGS (Primary: listings.ts)
// ============================================
export {
  getListings,
  getListingById,
  createListing,
  updateListing,
  // TOMBSTONE — `deleteListing` was here. SURVIVOR: `archiveListing` at
  // app/actions/listings.ts. A listing is RETAINED, never destroyed (owner's
  // ruling: "listing shouldn't be deleted because of rules of needing to keep
  // real estate records"). `unarchiveListing` is the way back and is exported
  // beside it, because a one-way hide is a delete with extra steps.
  archiveListing,
  unarchiveListing,
  getListingTimeline,
} from "./listings"
export { updateListingStatus } from "./listings-kernel"

// ============================================
// TRANSACTIONS (Primary: transactions.ts)
// ============================================
export {
  getTransactions,
  getTransactionById,
  createTransaction,
  updateTransaction,
  addParticipant,
  addLender,
  scheduleInspection,
  completeInspection,
  addDeadline,
  completeDeadline,
  addCommission,
  calculateCommissions,
  markCommissionPaid,
  submitRepairRequest,
  respondToRepairRequest,
  completeMilestone,
} from "./transactions"

// ============================================
// SHOWINGS & TOURS (Primary: showings.ts)
// ============================================
export {
  getShowings,
  createShowing,
  updateShowing,
  cancelShowing,
  // confirmShowing deleted — tombstone at showings.ts names
  // approveShowingRequest as the survivor
  completeShowing,
} from "./showings"

// Tour management
export {
  getTours,
  createTour,
  updateTour,
  optimizeTourRoute,
} from "./ai-showing-management"

// ============================================
// DOCUMENTS (Primary: documents.ts)
// ============================================
export {
  getDocuments,
  uploadDocument,
  deleteDocument,
  getDocumentWithAnalysis,
  analyzeDocument,
} from "./documents"
// NOTE: getDocumentRequirements and getDocumentEducation were removed —
// these functions do not exist in documents.ts

// ============================================
// AGENTS & USERS (Primary: agents.ts)
// ============================================
export {
  getAgents,
  // getAgentById / updateAgent / getAgentContacts deleted — tombstones at
  // agents.ts name the admin agent-360/profile and contacts.ts survivors
  getAgentStats,
  getAgentAchievements,
  getAgentCommissions,
  getAgentExpenses,
  getAgentGoals,
} from "./agents"

// ============================================
// COMMUNICATIONS (Primary: communications.ts)
// ============================================
export {
  sendSMS,
  sendEmail,
  logCall,
  // getContactHistory deleted — tombstone at communications.ts
  getCommunicationStats,
} from "./communications"

// ============================================
// AI SERVICES
// ============================================

// AI Text Generation
export { generateAIText, generateAIObject } from "./ai-generate"

// AI CMA
export { generateAICMA, getCMAReports, updateCMAReport } from "./ai-cma"

// AI Offer Creation — the aiAnalyzeOfferStrategy / generateOfferLetter
// aliases were deleted (§6); canonical names are aiOfferStrategyAdvisor /
// aiGenerateBuyerLetter in ai-offer-creation.ts

// AI Newsletter — the createNewsletter / generateNewsletterContent aliases
// were deleted (§6); canonical names are createNewsletterCampaign /
// aiWriteNewsletterContent in ai-newsletter.ts
export { getNewsletters } from "./ai-newsletter"

// AI Direct Mail
export { getDirectMailCampaigns, createDirectMailCampaign } from "./ai-direct-mail"

// ============================================
// OPEN HOUSES
// ============================================
export {
  scheduleOpenHouse,
  getOpenHouseVisitors,
  recordVisitor,
  optimizeOpenHouseTiming,
} from "./open-house-automation"

// ============================================
// WORKFLOWS
// ============================================
// NOTE: executeAITool is already exported above from ai-tools-hub — not re-exported here
// checkFairHousingCompliance / startSmartDrip / calculateListingMetrics /
// grantPortalAccess / triggerComplianceChecklist deleted — tombstones at
// workflows.ts name each survivor
export {
  generateCopilotPlan,
  sendMessage,
  triggerCMAPackage,
  generateScriptContent,
  retryFailedWorkflow,
  logUserActivity,
} from "./workflows"

// ============================================
// APPOINTMENTS & CALENDAR
// ============================================
export {
  getAppointments,
  createAppointment,
  updateAppointment,
  cancelAppointment,
} from "./ai-calendar-management"

// ============================================
// TASKS
// ============================================
export {
  getTasks,
  createTask,
  updateTask,
  completeTask,
  deleteTask,
} from "./tasks"

// ============================================
// AI LEAD SCORING
// ============================================
export {
  scoreLeadWithAI,
  getLeadInsights,
  bulkScoreLeads,
} from "./ai-lead-scoring"

// ============================================
// VENDORS
// ============================================
export { getVendors, createVendor } from "./ai-client-gifting"


// ============================================
// COMPLIANCE MONITORING
// ============================================
// logAuditEvent / analyzeFairHousingRisk / applyDocumentRetention /
// logCommunicationWithCompliance deleted — tombstones at
// compliance-monitoring.ts name each survivor (retention now runs from the
// daily compliance cron)
export {
  checkComplianceStatus,
  trackCertificationExpiration,
  monitorTRIDCompliance,
  exportAuditTrail,
  scanContentCompliance,
  submitContentForApproval,
  reviewContentApproval,
  getApprovedContentLibrary,
  getPendingApprovals,
  getComplianceViolations,
  generateComplianceReport,
  createTRIDTimeline,
  updateTRIDMilestone,
} from "./compliance-monitoring"
