// lib/kernel/index.ts
// Single entry-point for the kernel layer.
// Import from '@/lib/kernel' — never from individual kernel files outside this layer.
// No default exports.

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
  attachMediaToListing,
  generateListingDescription,
  createTransactionShellFromAcceptedOffer,
  closeListingLifecycle,
  prefillListingFormFromRecord,
} from "./listings"
export type {
  CreateListingInput,
  SellerContactInput,
  ListingUpdate,
  ListingFormPrefill,
  MediaAttachmentInput,
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
  applyContactSuppressionState,
} from "./crm"
export type {
  ContactSourceAttribution,
  CreateContactParams,
  CRMContactResult,
  DeduplicateResult,
  SuppressionStateParams,
  CRMResult,
} from "./crm"

export {
  linkCalendarProvider,
  pushCalendarEventToProvider,
  pullCalendarEventsFromProvider,
  listProviderAccounts,
  listSyncLogs,
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
  handleLeadConvertedToContact,
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

export { syncCalendarEventToProvider } from "./calendar-sync-orchestrator"

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
  promoteQualifiedRawToLead,
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
  PromoteRawToLeadParams,
  PromoteResult,
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

export {
  resolveWriteContext,
  requireWriteContext,
} from "./identity"
export type {
  WriteContext,
  UnauthenticatedWriteContext,
  WriteContextResult,
} from "./identity"

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
  emitOfferAcceptedEvent,
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
  createQrAsset,
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
  CreateQrAssetInput,
} from "./marketing"

// ─── AI TOOLS OS ─────────────────────────────────────────────────────────────
// Canonical AI Tools kernel commands — all tool executions, saves, and entity
// attachments flow through these commands.
// Business rules:
//   • All runs logged to ai_tool_usage — no silent executions
//   • Output is only persisted when user explicitly saves (saveAiToolOutput)
//   • attachAiOutputToEntity writes to ai_assistant_notes, not saved_ai_outputs
//   • tool_name must be a value from AiToolName union — no ad-hoc strings
export {
  loadAiToolsWorkspace,
  runAiTool,
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
  RunAiToolInput,
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
  buildCallContext,
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
  BuildCallContextInput,
  CallContext,
} from "./ai-isa"

// ─── VENDOR / PARTNER OS ─────────────────────────────────────────────────────
// Canonical Vendor kernel commands — all record creation, assignment, status
// transitions, and deliverable attachment flow through these commands.
// Business rules:
//   • vendors (marketplace) and vendor_directory (curated) are SEPARATE tables
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
