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
  groupingKey: string
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
 * Classify an error based on its message, workflow name, and optional stack trace
 */
export function classifyError(
  errorMessage: string,
  workflowName: string,
  stack?: string
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

  // Generate grouping key
  const groupingKey = `${workflowName}:${category}:${errorMessage.substring(0, 100)}`

  return {
    severity,
    category,
    isRetryable,
    suggestedRetryDelayMs: RETRY_DELAYS[0],
    groupingKey,
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
