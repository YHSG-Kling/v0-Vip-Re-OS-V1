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
