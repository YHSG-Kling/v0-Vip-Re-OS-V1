// Client-safe kernel exports only.
// Do NOT export DB code, marketing engine, notification engine,
// provider code, or anything that touches server-only modules.

export type {
  NotificationRuleRow,
  GlobalSettingsRow,
  AutomationErrorRow,
  CalendarSyncLogRow,
  OnboardingStepRow,
  CommissionRecord,
} from "@/lib/kernel/types"
