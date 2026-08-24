/**
 * Error Classifier
 * Determines severity, category, retryability, and grouping for automation errors
 */

export type ErrorSeverity = "critical" | "high" | "medium" | "low"
export type ErrorCategory =
  | "database"
  | "lead_pipeline"
  | "communication"
  | "content"
  | "financial"
  | "cron"
  | "integration"
  | "voice"
  | "other"

export interface ErrorClassification {
  severity: ErrorSeverity
  category: ErrorCategory
  isRetryable: boolean
  suggestedRetryDelayMs: number
  // TOMBSTONE: `groupingKey: string` stood here and is DELETED — it was
  // computed on every call and read by NOTHING, in this file or anywhere else.
  // Survivor: `error_hash`, built in lib/errors/collect-error.ts and PERSISTED
  // to error_stack_traces.error_hash, which is the column the error console
  // groups on. It is also the better key: groupingKey's third component was
  // `errorMessage.substring(0, 100)`, so any message carrying an id, a count or
  // a timestamp produced a NEW group per occurrence, while error_hash is keyed
  // on file + line.
}

// Retry delays with exponential backoff
const RETRY_DELAYS = [
  30 * 1000,        // attempt 1: 30 seconds
  2 * 60 * 1000,    // attempt 2: 2 minutes
  10 * 60 * 1000,   // attempt 3: 10 minutes
  60 * 60 * 1000,   // attempt 4: 1 hour
  6 * 60 * 60 * 1000, // attempt 5+: 6 hours (max)
]

/**
 * Get retry delay based on attempt number (0-indexed)
 */
export function getRetryDelay(attemptNumber: number): number {
  if (attemptNumber < 0) return RETRY_DELAYS[0]
  if (attemptNumber >= RETRY_DELAYS.length) return RETRY_DELAYS[RETRY_DELAYS.length - 1]
  return RETRY_DELAYS[attemptNumber]
}

/**
 * Classify an error based on its message and workflow name.
 *
 * TOMBSTONE — the third parameter, `stack?: string`, is DELETED. All three call
 * sites passed it and this function never read a character of it, so the stack
 * looked consumed while nothing consumed it.
 *
 * Where the stack's job actually went: lib/errors/collect-error.ts
 * `frameFromStack`, which parses the first non-error-module frame into
 * error_stack_traces.file_path / line_number / function_name and into the
 * error_hash those columns key. That is the half that was missing — those three
 * live columns were written NULL on every in-tree row because the only optional
 * `fileInfo` argument has no caller anywhere in the tree.
 *
 * Feeding the stack into the keyword scan below instead would have been the
 * wrong build: the severity and retryability branches match bare words like
 * "auth", "contact" and "payment", and a Next.js stack contains route paths
 * carrying all three, so every classified error would have escalated to
 * critical and non-retryable on the strength of its own file paths.
 */
export function classifyError(
  errorMessage: string,
  workflowName: string
): ErrorClassification {
  const msgLower = errorMessage.toLowerCase()
  const workflowLower = workflowName.toLowerCase()

  // Determine severity
  let severity: ErrorSeverity = "medium"
  
  // Critical severity patterns
  if (
    msgLower.includes("payment") ||
    msgLower.includes("commission") ||
    msgLower.includes("database down") ||
    msgLower.includes("supabase") ||
    msgLower.includes("auth") ||
    msgLower.includes("data loss") ||
    msgLower.includes("connection refused") ||
    workflowLower.includes("commission") ||
    workflowLower.includes("payment") ||
    workflowLower.includes("billing")
  ) {
    severity = "critical"
  }
  // High severity patterns
  else if (
    msgLower.includes("lead") ||
    msgLower.includes("contact") ||
    msgLower.includes("transaction") ||
    msgLower.includes("portal") ||
    msgLower.includes("message") ||
    msgLower.includes("notification") ||
    workflowLower.includes("lead") ||
    workflowLower.includes("contact") ||
    workflowLower.includes("transaction")
  ) {
    severity = "high"
  }
  // Medium severity patterns
  else if (
    msgLower.includes("cron") ||
    msgLower.includes("scraper") ||
    msgLower.includes("video") ||
    msgLower.includes("content") ||
    workflowLower.includes("cron") ||
    workflowLower.includes("scraper") ||
    workflowLower.includes("video") ||
    false
  ) {
    severity = "medium"
  }
  // Low severity for everything else
  else {
    severity = "low"
  }

  // Determine category
  let category: ErrorCategory = "other"
  
  if (workflowLower.includes("supabase") || workflowLower.includes("postgres") || workflowLower.includes("db")) {
    category = "database"
  } else if (workflowLower.includes("lead") || workflowLower.includes("scraper") || workflowLower.includes("isa") || workflowLower.includes("contact")) {
    category = "lead_pipeline"
  } else if (workflowLower.includes("email") || workflowLower.includes("sms") || workflowLower.includes("message") || workflowLower.includes("notification") || workflowLower.includes("portal")) {
    category = "communication"
  } else if (workflowLower.includes("video") || workflowLower.includes("content") || workflowLower.includes("blog") || workflowLower.includes("social")) {
    category = "content"
  } else if (workflowLower.includes("commission") || workflowLower.includes("billing") || workflowLower.includes("stripe") || workflowLower.includes("payment") || workflowLower.includes("earning")) {
    category = "financial"
  } else if (workflowLower.includes("cron") || workflowLower.includes("scheduler") || workflowLower.includes("daily") || workflowLower.includes("weekly")) {
    category = "cron"
  } else if (workflowLower.includes("api") || workflowLower.includes("webhook") || workflowLower.includes("sync") || workflowLower.includes("oauth")) {
    category = "integration"
  } else if (workflowLower.includes("voice") || workflowLower.includes("isa_call") || workflowLower.includes("call")) {
    category = "voice"
  }

  // Determine retryability
  let isRetryable = true

  // NOT retryable: critical + financial (data integrity risk)
  if (severity === "critical" && category === "financial") {
    isRetryable = false
  }
  // NOT retryable: auth/permission errors
  else if (
    msgLower.includes("auth") ||
    msgLower.includes("permission") ||
    msgLower.includes("forbidden") ||
    msgLower.includes("unauthorized") ||
    msgLower.includes("401") ||
    msgLower.includes("403")
  ) {
    isRetryable = false
  }
  // NOT retryable: validation/schema errors
  else if (
    msgLower.includes("invalid input") ||
    msgLower.includes("schema mismatch") ||
    msgLower.includes("constraint violation") ||
    msgLower.includes("validation") ||
    msgLower.includes("required field")
  ) {
    isRetryable = false
  }
  // Retryable: network/timeout/rate limit errors
  else if (
    msgLower.includes("timeout") ||
    msgLower.includes("rate limit") ||
    msgLower.includes("network") ||
    msgLower.includes("unavailable") ||
    msgLower.includes("5") && (msgLower.includes("500") || msgLower.includes("502") || msgLower.includes("503") || msgLower.includes("504"))
  ) {
    isRetryable = true
  }
  // Default: medium/low are retryable, critical is not unless network-related
  else if (severity === "critical") {
    isRetryable = msgLower.includes("timeout") || msgLower.includes("network") || msgLower.includes("unavailable")
  }

  return {
    severity,
    category,
    isRetryable,
    suggestedRetryDelayMs: RETRY_DELAYS[0],
  }
}

/**
 * Get human-readable category label
 */
export function getCategoryLabel(category: ErrorCategory): string {
  const labels: Record<ErrorCategory, string> = {
    database: "Database",
    lead_pipeline: "Lead Pipeline",
    communication: "Communication",
    content: "Content",
    financial: "Financial",
    cron: "Cron Job",
    integration: "Integration",
    voice: "Voice",
    other: "Other",
  }
  return labels[category] || "Other"
}

/**
 * Get severity color for UI
 */
export function getSeverityColor(severity: ErrorSeverity): string {
  const colors: Record<ErrorSeverity, string> = {
    critical: "destructive",
    high: "orange",
    medium: "amber",
    low: "secondary",
  }
  return colors[severity] || "secondary"
}
