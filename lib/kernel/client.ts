// Client-safe kernel exports only.
// Do NOT export DB code, marketing engine, notification engine,
// provider code, or anything that touches server-only modules.

export type {
  NotificationRuleRow,
  GlobalSettingsRow,
  AutomationErrorRow,
  CalendarSyncLogRow,
  OnboardingStepRow,
} from "@/lib/kernel/types"

export type { CommissionRecord } from "@/lib/kernel/financial"
