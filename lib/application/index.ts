// ─── AI ISA ───────────────────────────────────────────────────────────────────
// getAIISACampaignsService / getAIISACallsService were deleted (lane E2
// 2026-08-28) — tombstones naming their survivors sit in ./ai-isa.
// launchAIISACampaignService and queueAIISACallService were RESTORED by owner
// ruling (lane F1 2026-08-28): the launcher is a campaign-type chooser that
// enrolls the matched segment into the sequence cadence (it does not dial);
// the call-queue service regained its public action door in
// app/actions/ai-isa.ts:queueAIISACall.
// updateCampaignStatusService was deleted (lane G5 2026-08-28) — it was an
// ungated, tenant-free write. Survivors are app/actions/ai-isa.ts:
// toggleCampaignStatus (active↔paused) and completeISACampaign (terminal);
// tombstone in ./ai-isa.
export {
  launchAIISACampaignService,
  queueAIISACallService,
  retryFailedCallsService,
} from "./ai-isa"
export type { ISALaunchCampaignType, LaunchAIISACampaignResult } from "./ai-isa"

// ─── COMPLIANCE MONITORING ────────────────────────────────────────────────────
// logAuditEventService / logCommunicationWithComplianceService were deleted
// (lane E2 2026-08-28) — tombstones naming their survivors sit in
// ./compliance-monitoring. analyzeFairHousingRiskService was RESTORED by owner
// ruling (lane F2 2026-08-28): the contact-linked post-hoc review is a
// different business process from the generation-time and outbound gates.
export {
  analyzeFairHousingRiskService,
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
export type { FairHousingInteractionType } from "./compliance-monitoring"

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
  getSmartChecklists,
  setTaskItemCompleted,
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
