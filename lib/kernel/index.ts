// lib/kernel/index.ts
// Single entry-point for the kernel layer.
// Import from '@/lib/kernel' — never from individual kernel files outside this layer.
// No default exports.
import "server-only"
export { KernelEvent } from "./events"
export { CalendarEventType } from "./calendar-types"
export type { CalendarEventMetadata, KernelCalendarEvent } from "./calendar-types"
export { emitCalendarEvent } from "./calendar-engine"
export { checkUpcomingDeadlines } from "./calendar-deadline-watcher"
export { processKernelEvent } from "./notification-engine"
export {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "./notification-center"
export { transitionLifecycle } from "./lifecycle"
export { evaluateOutbound } from "./compliance"
export { checkBrandCompliance } from "./brand-compliance"
export type { CheckBrandComplianceParams, BrandComplianceResult } from "./brand-compliance"
export { applyBrandVoice } from "./brand-voice"
export { resolveProvider } from "./providers"
export { getEducationDelivery, getEducationPlan } from "./education"
export { getPortalMilestones, getLifetimeTrack } from "./portal"
export {
  canAccessFeature,
  incrementFeatureUsage,
  grantFeatureTrial,
  disableFeatureFor,
  mapUserTypeToTier,
} from "./0.1-feature-access"

export type {
  Persona,
  MessageType,
  ProviderType,
  EducationFormat,
  ActorRole,
  EntityType,
  JourneyPhase,
  BuyerStage,
  SellerStage,
  UserTier,
  FeatureAccessCheck,
  TransitionLifecycleParams,
  EvaluateOutboundParams,
  ComplianceResult,
  KernelContact,
} from "./types"

export {
  listNotificationRules,
  updateNotificationRule,
  createNotificationRule,
  deleteNotificationRule,
} from "./notification-rules"
export type { NotificationRuleRow } from "./notification-rules"

export { getGlobalSettings, updateGlobalSettings } from "./global-settings"
export type { GlobalSettingsRow } from "./global-settings"

// ─── LISTING OS ───────────────────────────────────────────────────────────────
// All listing lifecycle logic is owned by this module.
// Stage transitions delegate to app/actions/listing-lifecycle-core.ts.
// AI ISA is NEVER triggered from listing commands.

export {
  createListingRecord,
  createOrAttachSellerContact,
  loadListingWorkspace,
  saveListingDraft,
  validateListingLaunchReadiness,
  launchListing,
  updateListingStage,
  generateListingDescription,
  closeListingLifecycle,
  prefillListingFormFromRecord,
} from "./listings"
export type {
  CreateListingInput,
  SellerContactInput,
  ListingUpdate,
  ListingFormPrefill,
  ListingStage,
  KernelResult,
} from "./listings"

// ─── CRM / CONTACT OS ────────────────────────────────────────────────────────

export {
  resolveCanonicalPerson,
  mergeOrUpdateContactIfDuplicate,
  createOrUpdateContactFromDirectIntake,
  createContactManually,
  createLeadOnlyRecordForAcquisitionSource,
  convertLeadToContact,
  attachLeadOriginHistoryToContact,
  enrichContactAfterIntake,
  notifyAssignedAgentForNextAction,
  updateContactRecord,
  archiveContactRecord,
  loadContactWorkspace,
  generateContactFollowupDraft,

} from "./crm"
export type {
  ContactSourceAttribution,
  CreateContactParams,
  CRMContactResult,
  DeduplicateResult,
  CRMResult,
} from "./crm"

export {
  linkCalendarProvider,
  pushCalendarEventToProvider,
  pullCalendarEventsFromProvider,
  listProviderAccounts,
  listSyncLogs,
  listSyncMappings,
} from "./calendar-sync"
export type {
  CalendarProviderType,
  CalendarProviderAccountRow,
  CalendarSyncMappingRow,
  CalendarSyncLogRow,
} from "./calendar-sync"

export {
  listAutomationErrors,
  listCalendarSyncLogs,
  getObservabilityDashboard,
} from "./observability"
export type {
  AutomationErrorRow,
  ObservabilityFilterParams,
} from "./observability"

export {
  assertValidTransition,
  handleLeadCaptured,
  handleLeadScored,
  handleISAQualificationStarted,
  handleConsentReceived,
  handleLeadReadyForAssignment,
  handleLeadAssigned,
  // handleLeadConvertedToContact REMOVED — see the tombstone at
  // lib/kernel/lead-acquisition-handlers.ts:615. It was a fourth conversion
  // writer with zero call sites; this barrel line was its only non-comment
  // reference in the tree, which is exactly how an orphan looks WIRED to a
  // reference count. SURVIVOR: lib/kernel/crm.ts `convertLeadToContact`.
} from "./lead-acquisition-handlers"

export {
  getAgentOnboardingDashboard,
  completeAISessionStep,
  listOnboardingSteps,
  createOnboardingStepForBrokerage,
  updateOnboardingStepForBrokerage,
  deleteOnboardingStepForBrokerage,
  getQuizForStep,
  submitQuizAttempt,
} from "./agent-onboarding"
export type {
  OnboardingStatus,
  OnboardingStepRow,
  AgentOnboardingRow,
  StepCompletionRow,
} from "./agent-onboarding"

// ─── CALENDAR SYNC ORCHESTRATOR — DELETED (orphan doctrine §1, wave 27) ──────
//
// TOMBSTONE. `syncCalendarEventToProvider(params)` is DELETED. SURVIVOR:
// lib/kernel/calendar-sync.ts `pushCalendarEventToProvider`, which writes the
// provider's id into the `calendar_sync_mappings` registry.
//
// It had NO caller — the only reference was the re-export in lib/kernel/index.ts,
// already carried in scripts/orphan-export-baseline.json — and it was a SECOND
// SPELLING of the survivor's job (§6): the survivor files the provider's event id
// in `calendar_sync_mappings`, this filed it in `calendar_events.metadata.externalId`,
// and neither read the other's record.
//
// NOTHING WAS PORTED, because the survivor lacks nothing this had — it is better
// on all three axes that matter:
//
//  1. IT COULD NOT TELL A REAL EVENT ID FROM A FABRICATED ONE. When no calendar is
//     connected, lib/providers/calendar/index.ts:82 returns
//     `{ success: true, eventId: "mock-event-<ts>", mock: true }` so non-actor
//     callers keep working. That contract is honest — it SETS `mock` — and
//     lib/contact-validation.ts:73 reads it correctly as `success && !result.mock`.
//     This function checked `created.success && created.eventId` and never read
//     `mock`, so it wrote `mock-event-…` into the database as though a provider had
//     accepted the event. The survivor cannot do this: its adapters THROW rather
//     than returning a placeholder, and the mapping row is written only from an id
//     an adapter actually returned.
//  2. NO TENANT PREDICATE. It took a `brokerageId` and never used it — the read it
//     performed was not scoped by it (CLAUDE.md §4).
//  3. NO PROVIDER ADAPTER REGISTRY. The survivor dispatches through
//     CALENDAR_SYNC_ADAPTERS (Google, and Outlook as of wave 27) and refuses when
//     no adapter answers, instead of trusting whatever the generic provider shim
//     hands back.
//
// The live table was checked before deleting: `calendar_events` holds 0 rows, so
// no `mock-event-*` value was ever persisted and no backfill is owed.

export { createTransactionMilestoneCalendarEvents } from "./milestone-calendar-bridge"

export { findStuckAgentsAndNotify } from "./onboarding-reminders"

export { resolveAIModel } from "./ai-model"
export type { ResolveAIModelParams } from "./ai-model"

export {
  determineVisibleNavigation,
  enforceLifecycle,
  enforceCompliance,
  emitLifecycleEvent,
  resolvePageCapability,
  isStaffRole,
} from "./helpers"
export type {
  NavigationResult,
  LifecycleEnforcement,
  PageCapability,
  EmitEventParams,
} from "./helpers"

// ─── RAW LEAD SCRAPING / ACQUISITION PIPELINE OS ─────────────────────────────
// All scraping pipeline logic is owned by this module.
// Direct-contact consented intake (forms, QR, cards) uses crm.ts instead.

export {
  runScrapeSourcesChronologically,
  ingestRawSourceBatch,
  normalizeRawSourceRecord,
  dedupRawAgainstLeadAndContact,
  enrichRawRecord,
  gateRawRecordToLead,
  loadScrapingDiagnostics,
  retryFailedSourceBatch,
} from "./scraping"
export type {
  ScrapingMarket,
  IngestRawSourceBatchParams,
  IngestBatchResult,
  NormalizeRawRecordParams,
  NormalizedRawOutput,
  DedupRawParams,
  DedupResult,
  EnrichRawRecordParams,
  EnrichRawResult,
  GateRawRecordToLeadParams,
  GatingDecision,
  GateResult,
  ScrapingDiagnosticsParams,
  ScrapingDiagnosticsData,
  RetryFailedBatchParams,
  RetryBatchResult,
  RunScrapeChronologicallyParams,
  RunScrapeResult,
} from "./scraping"

// ─── USER PROVISIONING OS ────────────────────────────────────────────────────

export {
  createOrRepairUserDomainRecords,
  resolveUserWorkspaceContext,
  assignUserRoleAndEntitlements,
  assignUserToBrokerage,
  assignUserToTeam,
  repairIncompleteAccountSetup,
  emitUserProvisionedEvent,
} from "./users"
export type {
  UserDomainRole,
  UserProvisioningParams,
  ProvisioningResult,
  WorkspaceContext,
  RoleAssignmentParams,
  RoleAssignmentResult,
  RepairResult,
} from "./users"

// ─── ONBOARDING WORKSPACE OS ─────────────────────────────────────────────────

export {
  startOnboarding,
  markOnboardingStepComplete,
  loadOnboardingWorkspace,
  determineFirstLoginDestination,
} from "./onboarding"
export type {
  OnboardingWorkspace,
  OnboardingStep,
  MarkStepCompleteParams,
  MarkStepCompleteResult,
  FirstLoginDestination,
} from "./onboarding"

// ─── IDENTITY & WRITE CONTEXT ─────────────────────────────────────────────────
//
// TOMBSTONE (§1.1) — `./identity` is DELETED. It declared a SECOND resolveWriteContext()
// (plus requireWriteContext) with a different shape and no impersonation awareness, so
// half the app gated on a seam that could neither hand a caller the right client nor
// refuse a read_only grant. SURVIVOR: lib/platform/acting-context.ts:143
// (resolveWriteContext / resolveWriteContextForTenant / resolveActingContext), also
// re-exported from lib/identity/index.ts. The kernel does not re-export it: the seam
// resolves a REQUEST, and `import "server-only"` at the top of this barrel dragged the
// server graph into every module that wanted it. Import it from
// "@/lib/platform/acting-context" directly.

// ─── OUTBOUND COMMUNICATIONS ──────────────────────────────────────────────────

export { evaluateOutboundEligibility } from "./communications"
export type {
  EvaluateOutboundEligibilityParams,
  OutboundEligibilityResult,
} from "./communications"

// ─── CAPABILITY PREVIEW & CONTRACT VALIDATION ────────────────────────────────

export {
  renderCapabilityPreview,
  validateKernelContract,
} from "./preview"
export type {
  CapabilityPreview,
  RenderCapabilityPreviewParams,
  ContractValidationRule,
  ContractValidationResult,
} from "./preview"

// ─── UI COMPONENT PATH NORMALIZATION ─────────────────────────────────────────

export {
  CANONICAL_COMPONENT_ROOT,
  LEGACY_COMPONENT_ROOT,
  CANONICAL_COMPONENT_MAP,
  SURVIVOR_RULE,
  IMPORT_NORMALIZATION_RULES,
} from "./routes"
export type {
  CanonicalComponentPath,
  ComponentAuditStatus,
  ComponentAuditEntry,
  ComponentAuditResult,
  SurvivorRule,
  ImportNormalizationRule,
} from "./routes"

export {
  resolveCanonicalComponentPath,
  buildIntegrityReport,
} from "./contracts"

// ─── TRANSACTION OS — OFFER-TO-TRANSACTION COMPLIANCE BRIDGE ─────────────────
// Business rule: transaction created ONLY when offer accepted AND compliance passes.
// If accepted but not compliant → explicit HOLD state. No silent stranded offers.
// Column contracts: offers.contact_id (not buyer_id), transactions.purchase_price (not contract_price).

export {
  evaluateOfferCompliance,
  acceptOfferConditionally,
  createTransactionFromCompliantAcceptedOffer,
  seedTransactionMilestones,
  linkOfferToTransaction,
  emitTransactionInitiatedEvent,
  loadComplianceBridgeStatus,
  // ─── CANONICAL TRANSACTION OS COMMANDS ───────────────────────────────────────
  createManualTransaction,
  loadTransactionWorkspace,
  advanceTransactionStageCommand,
  completeTransactionMilestone,
  setMilestoneClientVisibilityCommand,
  attachTransactionDocument,
  updateLenderState,
  updateVendorState,
  closeTransactionCommand,
  reopenTransactionCommand,
  recalculateCommissionStateCommand,
  emitClientFriendlyUpdateCommand,
  prefillTransactionFormFromRecord,
} from "./transactions"
export type {
  KernelTxResult,
  OfferComplianceState,
  AcceptOfferConditionallyInput,
  AcceptOfferConditionallyResult,
  CreateTransactionInput,
  SeedMilestonesInput,
  CreateManualTransactionInput,
} from "./transactions"

// ─── OFFER OS ────────────────────────────────────────────────────────────────
// Canonical offer lifecycle commands.
// Counter history lives in the offers table (parent_offer_id + offer_type='counter').
// offer_counters and offer_analysis tables do NOT exist.

export {
  loadOfferWorkspace,
  loadOffersForListing,
  loadOffersForBuyer,
  recordOfferSubmitted,
  recordOfferAiAnalysis,
  compareOffersForListing,
  issueCounterOffer,
  respondToCounter,
  acceptOffer,
  rejectOffer,
  withdrawOffer,
  getOfferNegotiationHistory,
} from "./offers"
export type {
  KernelOfferResult,
  OfferRow,
} from "./offers"
// ─── MARKETING OS ────────────────────────────────────────────────────────────
// Canonical marketing commands — all content types, one kernel layer.
// Business rules:
//   • newsletter_campaigns (not email_campaigns) is the newsletter table
//   • blog_posts.publish_status (not status) controls published state
//   • ai_video_projects (not video_projects) is the video table
//   • qr_codes.agent_id references agents (not agent_user_id)
//   • No direct DB calls from UI — all writes go through these commands
export {
  loadMarketingWorkspace,
  createNewsletterCampaign,
  saveNewsletterDraft,
  scheduleNewsletterSend,
  sendNewsletterNow,
  createDirectMailCampaign,
  previewDirectMailAsset,
  submitDirectMailCampaign,
  createBlogPost,
  previewBlogPost,
  publishBlogPost,
  createVideoProject,
  previewVideoProject,
  distributeVideoAsset,
  createPodcastEpisodeKernel,
  previewPodcastEpisode,
  publishPodcastEpisode,
  createMarketingCampaign,
  repurposeContentAsset,
  // createQrAsset REMOVED in the QR merge (wave Q) — merged-then-deleted into
  // lib/marketing/tracked-qr.ts:mintTrackedQr (it was the sole writer of qr_codes.expires_at;
  // that capability moved to the survivor first). See the tombstone in ./marketing.
  previewQrAsset,
} from "./marketing"
export type {
  KernelMarketingResult,
  MarketingActorContext,
  MarketingWorkspaceData,
  CreateNewsletterCampaignInput,
  CreateDirectMailCampaignInput,
  CreateBlogPostInput,
  CreateVideoProjectInput,
  CreatePodcastEpisodeInput,
  CreateMarketingCampaignInput,
} from "./marketing"

// ─── AI TOOLS OS ─────────────────────────────────────────────────────────────
// Canonical AI Tools kernel commands — tool history, saves, and entity
// attachments flow through these commands.
// Business rules:
//   • Output is only persisted when user explicitly saves (saveAiToolOutput)
//   • attachAiOutputToEntity writes to ai_assistant_notes, not saved_ai_outputs
//   • tool_name must be a value from AiToolName union — no ad-hoc strings
//   • THE LEDGER WRITE IS NOT HERE. `runAiTool` was a second, less complete
//     writer of ai_tool_usage and is gone; the survivor is
//     app/actions/ai-tools-hub.ts:164 (executeAITool). See the tombstone at
//     lib/kernel/ai-tools.ts:199.
export {
  loadAiToolsWorkspace,
  saveAiToolOutput,
  attachAiOutputToEntity,
  previewAiOutput,
} from "./ai-tools"
export type {
  AiToolName,
  KernelAiToolsResult,
  AiToolsActorContext,
  AiToolsWorkspaceData,
  AiToolUsageRecord,
  SavedAiOutput,
  LoadAiToolsWorkspaceInput,
  SaveAiToolOutputInput,
  AttachAiOutputToEntityInput,
  PreviewAiOutputInput,
} from "./ai-tools"

// ─── AI ISA OS ───────────────────────────────────────────────────────────────
// Canonical AI Inside Sales Agent kernel commands — all ISA qualification,
// automation, handoff, outcome recording, and call context flows here.
// Business rules:
//   • leads.minimum_viable_for_isa must be true before assignAiIsaToLeadAfterGate
//   • leads.ai_isa_owner = true is the single source of truth for ISA ownership
//   • tcpa_consent required before any outreach — evaluateAiIsaEligibility enforces this
//   • handoffToHumanAgent sets ai_isa_owner = false, fires lifecycle_event
//   • pauseAiIsaAutomation sets ai_outreach_paused = true — never deletes state
//   • buildCallContext reads ai_identity_profiles: agent → team → brokerage cascade
export {
  loadAiIsaWorkspace,
  evaluateAiIsaEligibility,
  assignAiIsaToLeadAfterGate,
  startAiIsaAutomation,
  pauseAiIsaAutomation,
  resumeAiIsaAutomation,
  handoffToHumanAgent,
  recordAiIsaOutcome,
  routeHistoryToCanonicalEntity,
  resolveLeadChannel,
} from "./ai-isa"
export type {
  KernelAiIsaResult,
  AiIsaActorContext,
  AiIsaWorkspaceData,
  AiIsaCampaignRow,
  AiIsaLeadRow,
  AiIsaCallRow,
  AiIsaHandoffRow,
  EvaluateAiIsaEligibilityInput,
  EligibilityResult,
  AssignAiIsaToLeadInput,
  StartAiIsaAutomationInput,
  PauseAiIsaAutomationInput,
  ResumeAiIsaAutomationInput,
  HandoffToHumanAgentInput,
  RecordAiIsaOutcomeInput,
  RouteHistoryInput,
  ResolveLeadChannelInput,
  LeadChannelResult,
} from "./ai-isa"

// ─── REPORTING OS ────────────────────────────────────────────────────────────
// Canonical Reporting kernel commands. All report generation, CSV/PDF export,
// and email delivery flow through these commands.
// Business rules:
//   • agent_commissions (not commissions) is the source for YTD financial data
//   • business_expenses HAS brokerage_id (and team_id). CORRECTED 2026-08-22:
//     this line used to read "has no brokerage_id — always filter by agent_id
//     only", which was false and load-bearing — "filter by agent_id only" is how
//     an export gate came to scope a whole ledger off a caller-supplied agent id.
//     The column is NOT NULL since m516; when a writer omits it, trigger
//     business_expenses_derive_tenant derives it from agents.brokerage_id, then
//     teams.brokerage_id, and RAISES if neither answers. A reader scopes by the
//     SESSION's brokerage_id and then by agent_id — never by agent_id alone.
//   • generated_documents table does NOT exist — exportReportPdf uses Vercel Blob
//   • generateAgentPerformanceReport is the only command that writes to DB
//   • exportReportCsv returns CSV string — no DB write; caller drives browser download
//   • Every mutation emits KernelEvent via lifecycle_events
export {
  loadReportingWorkspace,
  generateSourcePerformanceReport,
  generateCampaignROIReport,
  generateTransactionPipelineReport,
  generateTeamPerformanceReport,
  generateAgentPerformanceReport,
  generateFinancialSummaryReport,
  generateReputationReport,
  exportReportCsv,
  exportReportPdf,
  emailReport,
} from "./reporting"
export type {
  ReportingActorContext,
  KernelReportingResult,
  LoadReportingWorkspaceInput,
  ReportingWorkspace,
  GenerateSourcePerformanceInput,
  SourcePerformanceReport,
  GenerateCampaignROIInput,
  CampaignROIReport,
  GenerateTransactionPipelineInput,
  TransactionPipelineReport,
  GenerateTeamPerformanceInput,
  TeamPerformanceReport,
  GenerateAgentPerformanceInput,
  AgentPerformanceReport,
  GenerateFinancialSummaryInput,
  FinancialSummaryReport,
  GenerateReputationInput,
  ReputationReport,
  ExportReportCsvInput,
  ExportReportCsvOutput,
  ExportReportPdfInput,
  ExportReportPdfOutput,
  EmailReportInput,
} from "./reporting"

// ─── FINANCIAL CANONICAL MANAGER ─────────────────────────────────────────────────
// Canonical Financial kernel commands. All commission approval/payment, cap tracking,
// expense creation, and financial reporting flow through these commands only.
// Business rules:
//   • agent_commissions.status transitions: calculated → approved → paid
//   • business_expenses HAS brokerage_id (and team_id) — see the Reporting OS
//     note above. NOT NULL since m516; trigger business_expenses_derive_tenant
//     derives the tenant from agents.brokerage_id / teams.brokerage_id for any
//     writer that omits it, and raises when neither can answer. createExpenseRecord
//     in ./financial stamps ctx.brokerageId explicitly. Scope reads by the
//     SESSION's tenant AND agent_id, never by agent_id alone.
//   • agent_cap_tracking is source of truth for cap state
//   • Only broker/admin/superadmin can approve/pay commissions
//   • Every mutation emits KernelEvent via lifecycle_events
export {
  loadFinancialWorkspace,
  loadAgentFinancialSummary,
  loadBrokerageFinancialSummary,
  loadCommissionQueue,
  loadCommissionDistributions,
  recalculateCommissionState,
  markCommissionApproved,
  markCommissionPaid,
  createExpenseRecord,
  exportFinancialReport,
  emailFinancialReport,
} from "./financial"
export type {
  FinancialActorContext,
  KernelFinancialResult,
  FinancialWorkspace,
  AgentFinancialSummary,
  BrokerageFinancialSummary,
  CommissionRecord,
  CommissionDistribution,
  ExpenseRecord,
  FinancialExportResult,
  LoadFinancialWorkspaceInput,
  LoadAgentFinancialSummaryInput,
  LoadBrokerageFinancialSummaryInput,
  LoadCommissionQueueInput,
  LoadCommissionDistributionsInput,
  RecalculateCommissionStateInput,
  MarkCommissionApprovedInput,
  MarkCommissionPaidInput,
  CreateExpenseRecordInput,
  ExportFinancialReportInput,
  EmailFinancialReportInput,
} from "./financial"

// ─── CRON EXECUTION LOGGING KERNEL ──────────────────────────────────────────────
// Canonical Cron Execution logging kernel commands. All cron jobs must use these
// commands to ensure silent failures are eliminated, records are tracked for audit,
// and correlation IDs enable debugging.
// Business rules:
//   • Every cron job MUST call createCronRunContext() at start
//   • recordCronStart() must be called immediately after context creation
//   • recordCronSuccess() or recordCronFailure() must be called on completion
//   • Logging failures MUST NOT crash the cron job
//   • Correlation IDs persist across all log entries for trace correlation
//   • Error messages are truncated to 2000 chars for DB safety
//   • Records processed are tracked for audit trail
export {
  createCronRunContext,
  recordCronStart,
  recordCronProgress,
  recordCronSuccess,
  recordCronFailure,
} from "./cron-logging"
export type {
  CronLoggingActorContext,
  KernelCronLoggingResult,
  CronRunContext,
  CreateCronRunContextInput,
  RecordCronStartInput,
  RecordCronProgressInput,
  RecordCronSuccessInput,
  RecordCronSuccessOutput,
  RecordCronFailureInput,
  RecordCronFailureOutput,
} from "./cron-logging"

// ─── REPUTATION / REVIEW / REFERRAL OS ──────────────────────────────────────
// Canonical reputation kernel commands. All review requests, inbound review
// recording, response publishing, referral creation and pipeline advancement
// flow through these commands — never directly through app/actions.
// Business rules:
//   • rating 1–5 only — validated in kernel, not caller
//   • respondToReview verifies reviewId belongs to agentId before writing
//   • createReviewRequest blocks duplicate pending per contact+platform
//   • Every mutation emits KernelEvent via lifecycle_events
// TOMBSTONE (§1.1, BURN-C 2026-09-04) — recordReview, createReferralRequest and
// advanceReferralStatus are gone from this barrel because they are gone from the
// kernel: nothing called them, and each capability was merged onto its live
// survivor first. See the tombstone in lib/kernel/reputation.ts for where each
// went. The referral stage graph that the third one enforced now lives in
// lib/referrals/referral-status.ts (REFERRAL_STATUS_TRANSITIONS, canAdvanceReferral).
export {
  loadReputationWorkspace,
  createReviewRequest,
  respondToReview,
  loadReferralPipeline,
  loadReviewPerformance,
} from "./reputation"
export type {
  ReputationActorContext,
  KernelReputationResult,
  ReviewRow,
  ReviewRequestRow,
  ReferralRow,
  ReputationPerformance,
  ReputationWorkspace,
  ReferralPipelineData,
  LoadReputationWorkspaceInput,
  LoadReviewPerformanceInput,
  LoadReferralPipelineInput,
  CreateReviewRequestInput,
  RespondToReviewInput,
} from "./reputation"

// ─── VENDOR / PARTNER OS ─────────────────────────────────────────────────────
// Canonical Vendor kernel commands — all record creation, assignment, status
// transitions, and deliverable attachment flow through these commands.
// Business rules:
//   • vendors is the ONE vendor table — marketplace bench AND curation/placement
//     flags (m355 merged the formerly separate vendor_directory into it)
//   • vendor_bookings.listing_id = listing-level assignments
//   • vendor_assignments + vendor_jobs = transaction-level assignments
//   • Status transitions enforced: booked→confirmed→completed | any→cancelled|no_show
//   • Every write emits a KernelEvent via lifecycle_events
export {
  loadVendorWorkspace,
  createVendorRecord,
  updateVendorRecord,
  assignVendorToListing,
  assignVendorToTransaction,
  updateVendorBookingStatus,
  attachVendorDeliverable,
  loadPartnerDirectory,
} from "./vendors"
export type {
  VendorActorContext,
  KernelVendorResult,
  VendorWorkspaceData,
  VendorRow,
  VendorDirectoryRow,
  VendorBookingRow,
  VendorAssignmentRow,
  PartnerDirectoryData,
  ReferralPartnerRow,
  LoadVendorWorkspaceInput,
  CreateVendorRecordInput,
  UpdateVendorRecordInput,
  AssignVendorToListingInput,
  AssignVendorToTransactionInput,
  UpdateVendorBookingStatusInput,
  AttachVendorDeliverableInput,
  LoadPartnerDirectoryInput,
} from "./vendors"

// ─── FORMS, E-SIGN & SMART PROPERTY WORKFLOW OS ──────────────────────────────
// Canonical forms/esign/buyer-property-action kernel commands.
// Business rules:
//   • Form context is STRICT — listing/offer/transaction context never cross-pollinates
//   • Drafts persist to form_submissions with status='draft'
//   • E-sign is TRANSPORT ONLY — provider handles API; kernel logs events
//   • Buyer property actions write to property_interests (canonical table)
//   • resolveTransactionFormsProvider reads platform_credentials — not contact data
export {
  resolveTransactionFormsProvider,
  loadAvailableTransactionForms,
  prefillFormWithContext,
  saveFormDraft,
  loadFormDraft,
  launchEsignEnvelope,
  getEsignStatus,
  syncEsignDocuments,
  recordBuyerPropertyAction,
  loadBuyerSavedProperties,
} from "./forms"
export type {
  KernelFormsResult,
  FormContextType,
  BuyerPropertyInterestLevel,
  FormTemplate,
  FormPrefillData,
  FormDraft,
  EsignStatus,
  ProviderDocument,
  BuyerPropertyInterest,
} from "./forms"

export type {
  BrokerageAgentContract,
  BrokerageAgentListInput,
  BrokerageRevenueInput,
  BrokerageComplianceInput,
  CoordinatorTransactionContract,
  CoordinatorTransactionListInput,
  CoordinatorDeadlineContract,
  DeadlineTrackingInput,
  CoordinatorMilestoneContract,
  MilestoneQueueInput,
  CoordinatorHealthScoreContract,
  HealthOverviewInput,
  ComponentImportAuditInput,
  ComponentImportAuditOutput,
  AuditComponentImports,
  UiSurfaceIntegrityReport,
} from "./contracts"
