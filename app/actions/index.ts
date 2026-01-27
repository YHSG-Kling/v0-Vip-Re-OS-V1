/**
 * SMART ENGINE - SERVER ACTIONS INDEX
 * ====================================
 * Central export point for all server actions.
 * Import from here for consistency and to avoid duplicates.
 * 
 * IMPORTANT: Always use these canonical exports rather than importing
 * directly from individual action files to prevent duplication.
 */

// ============================================
// CRM & CONTACTS (Primary: crm.ts)
// ============================================
export { 
  getContacts,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  searchContacts,
  getContactTimeline,
  mergeContacts,
} from "./crm"

// Additional contact functions from contact-details.ts
export {
  getContactActivity,
  getContactDocuments,
  getContactTransactions,
  getContactInteractions,
} from "./contact-details"

// Contact enrichment
export {
  enrichContactData,
  getContactInsights,
} from "./contact-enrichment"

// Conversation analytics & sentiment tracking
export {
  logConversationMetadata,
  runWeeklyAIAudit,
  getConversationAnalytics,
  getAuditFlags,
  reviewAuditFlag,
} from "./conversation-analytics"

// Voice call bridge & AI voice bots
export {
  initiateWhisperBridge,
  updateWhisperBridgeStatus,
  triggerVapiVoiceBot,
  updateVapiCallStatus,
  getWhisperBridgeCalls,
  getVapiVoiceCalls,
} from "./voice-call-bridge"

// Voice assistant (hands-free AI assistant)
export {
  processVoiceCommand,
  startVoiceSession,
  endVoiceSession,
  getVoiceConfig,
  updateVoiceConfig,
  getVoiceCommandHistory,
} from "./voice-assistant"

// AI ISA (Inside Sales Agent) - Autonomous outbound calling
export {
  launchAIISACampaign,
  queueAIISACall,
  handleVapiCallComplete,
  getAIISACampaigns,
  getAIISACalls,
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
  startAgentOnboarding,
  getOnboardingStatus,
  completeOnboardingStep,
  matchMentor,
  verifyAgentLicense,
  generateWelcomeMessage,
  getOnboardingAnalytics,
  askOnboardingBuddy,
  submitQuizAttempt,
  certifyAgent,
} from "./ai-agent-onboarding"

// ============================================
// LISTINGS (Primary: listings.ts)
// ============================================
export {
  getListings,
  getListingById,
  createListing,
  updateListing,
  deleteListing,
  getListingTimeline,
  getSellerReports,
  updateListingStatus,
} from "./listings"

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
  confirmShowing,
  getShowingFeedback,
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
  getDocumentRequirements,
  getDocumentEducation,
  analyzeDocument,
} from "./documents"

// ============================================
// AGENTS & USERS (Primary: agents.ts)
// ============================================
export {
  getAgents,
  getAgentById,
  updateAgent,
  getAgentStats,
  getAgentAchievements,
  getAgentCommissions,
  getAgentExpenses,
  getAgentGoals,
  getAgentContacts,
} from "./agents"

// ============================================
// COMMUNICATIONS (Primary: communications.ts)
// ============================================
export {
  sendSMS,
  sendEmail,
  logCall,
  getContactHistory,
  getCommunicationStats,
} from "./communications"

// ============================================
// AI SERVICES
// ============================================

// AI Text Generation
export { generateAIText, generateAIObject } from "./ai-generate"

// AI CMA
export { generateAICMA, getCMAReports, updateCMAReport } from "./ai-cma"

// AI Offer Creation
export { aiAnalyzeOfferStrategy, generateOfferLetter } from "./ai-offer-creation"

// AI Newsletter
export { getNewsletters, createNewsletter, generateNewsletterContent } from "./ai-newsletter"

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
export { executeWorkflow, getWorkflowStatus } from "./workflows"

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
// DEMO CONTACTS
// ============================================
export { getDemoContactByPersona, getAllDemoContacts } from "./demo-contacts"

// ============================================
// COMPLIANCE MONITORING
// ============================================
export {
  logAuditEvent,
  checkComplianceStatus,
  trackCertificationExpiration,
  analyzeFairHousingRisk,
  monitorTRIDCompliance,
  applyDocumentRetention,
  exportAuditTrail,
  scanContentCompliance,
  submitContentForApproval,
  reviewContentApproval,
  logCommunicationWithCompliance,
  getApprovedContentLibrary,
  getPendingApprovals,
  getComplianceViolations,
  generateComplianceReport,
  createTRIDTimeline,
  updateTRIDMilestone,
} from "./compliance-monitoring"
