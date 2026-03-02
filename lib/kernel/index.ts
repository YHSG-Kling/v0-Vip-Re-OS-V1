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
  getAgentOnboardingDashboard,
  completeOnboardingStep,
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
