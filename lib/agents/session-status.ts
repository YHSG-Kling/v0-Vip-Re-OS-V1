/**
 * lib/agents/session-status.ts
 *
 * Pure boundary normalization for managed-agent session status. Kept free of
 * "server-only" so it is unit-testable and reusable on both sides. The
 * canonical vocabulary MUST match the managed_agent_sessions_status_check
 * constraint (running | idle | terminated | error).
 */

/** Canonical managed-agent session status — matches managed_agent_sessions_status_check. */
export type ManagedSessionStatus = "running" | "idle" | "terminated" | "error"

export const MANAGED_SESSION_STATUSES: readonly ManagedSessionStatus[] = [
  "running", "idle", "terminated", "error",
] as const

/**
 * Normalize the raw Anthropic sessions-API status into our constrained
 * vocabulary at the boundary. The sessions API is an EXTERNAL enum
 * (active / in_progress / completed / …) that must never flow unmapped into
 * managed_agent_sessions.status — an unrecognized value would violate the
 * CHECK constraint and fail the insert (orphaning the live Anthropic session).
 * A freshly created session is "running"; the webhook handler drives all
 * subsequent transitions via mapped event types
 * (run_started→running, idled→idle, terminated→terminated).
 */
export function normalizeManagedSessionStatus(raw: string | null | undefined): ManagedSessionStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "idle":
    case "idled":        return "idle"
    case "terminated":
    case "completed":
    case "ended":
    case "done":         return "terminated"
    case "error":
    case "failed":       return "error"
    case "running":
    case "active":
    case "in_progress":
    case "":             return "running"
    default:             return "running"
  }
}
