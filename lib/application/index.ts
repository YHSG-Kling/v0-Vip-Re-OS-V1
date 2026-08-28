// ─── AI ISA ───────────────────────────────────────────────────────────────────
// launchAIISACampaignService / getAIISACampaignsService / getAIISACallsService
// were deleted (lane E2 2026-08-28) — tombstones naming their survivors sit in
// ./ai-isa. queueAIISACallService survives as retryFailedCallsService's engine
// and is not re-exported here (no external caller).
export {
  retryFailedCallsService,
  updateCampaignStatusService,
} from "./ai-isa"

// ─── COMPLIANCE MONITORING ────────────────────────────────────────────────────
// logAuditEventService / analyzeFairHousingRiskService /
// logCommunicationWithComplianceService were deleted (lane E2 2026-08-28) —
// tombstones naming their survivors sit in ./compliance-monitoring.
export {
  checkComplianceStatusService,
  resolveComplianceAlertService,
  resolveCompRiskFlagService,
  trackCertificationExpirationService,
  monitorTRIDComplianceService,
  createTRIDTimelineService,
  updateTRIDMilestoneService,
  applyDocumentRetentionService,
  exportAuditTrailService,
  scanContentComplianceService,
  submitContentForApprovalService,
  reviewContentApprovalService,
  getApprovedContentLibraryService,
  getPendingApprovalsService,
  getComplianceViolationsService,
  generateComplianceReportService,
} from "./compliance-monitoring"

// ─── LEAD APPLICATION SERVICE ─────────────────────────────────────────────────
export type { LeadScore, LeadIntent, LeadStatus, LeadSource, Lead } from "./lead-application-service"
export {
  // Admin lead view + Lane B import (the canonical service surface).
  // The former "leads-wide" block (serviceCreateLead/serviceScrape*Leads/
  // serviceAssignLead/…) was removed — dead code on a phantom schema that
  // bypassed raw_scraped_leads ingestion and the assignment engine's
  // AI-ISA qualification gate. See lead-application-service.ts footer.
  serviceGetLeads,
  serviceGetLead,
  serviceEnrichLead,
  serviceRejectLead,
  serviceImportLeads,
} from "./lead-application-service"

// ─── LISTING LIFECYCLE ────────────────────────────────────────────────────────
export {
  scheduleListingAppointmentService,
  updateListingStageService,
  advanceListingStageService,
  scheduleClosingGift,
  getListingTimelineService,
  getListingTasksService,
  completeListingTaskService,
  handleListingAppointmentBookedService,
  handleListingAgreementSignedService,
  handleListingLiveService,
  handlePriceReductionService,
  handleOfferReceivedService,
  handleContingencyClearedService,
  handleClosingApproachingService,
  triggerReviewSequenceService,
  sendReviewRequestService,
} from "./listing-lifecycle"

// ─── LISTINGS ─────────────────────────────────────────────────────────────────
export { getListingsService, createListingService } from "./listings"

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────
export {
  getTransactions,
  getTransactionById,
  createTransaction,
  updateTransaction,
  generateMilestones,
  completeMilestone,
  getTransactionMilestones,
  updateMilestone,
  getClosingChecklist,
  updateChecklistItem,
  addParticipant,
  updateParticipant,
  removeParticipant,
  addLender,
  updateLender,
  addTitleEscrow,
  updateTitleEscrow,
  scheduleInspection,
  updateInspection,
  completeInspection,
  orderVendorService,
  updateVendorService,
  addTransactionDocument,
  updateDocumentStatus,
  addTimelineEntry,
  getTransactionTimeline,
  addDeadline,
  updateDeadline,
  completeDeadline,
  getUpcomingDeadlines,
  addCommission,
  calculateCommissions,
  markCommissionPaid,
  submitRepairRequest,
  respondToRepairRequest,
  finalizeRepairNegotiation,
  getTransactionStats,
  getPendingDocuments,
  generateClientTimeline,
  generateCostBreakdown,
  generateStatusUpdate,
  generateSmartChecklist,
  detectTransactionIssues,
  deliverEducationalContent,
  monitorTransactionHealth,
  detectTransactionDelays,
  celebrateMilestone,
  loadClientDashboard,
  loadAgentDashboard,
  getAgentTransactionKanban,
  updateTransactionStage,
  getClientTasks,
  autoProgressMilestone,
} from "./transactions"
