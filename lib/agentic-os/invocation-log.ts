// lib/agentic-os/invocation-log.ts
// Audit + continued-learning log for the Agentic API. Every INVOKE decision (and its
// outcome) is recorded so the platform has (a) an audit trail of what agents did, and
// (b) a learning corpus — decision distribution, which capabilities get denied for a
// missing scope, which connectors are most invoked, drift/error rates. Fire-and-forget:
// logging must never break the invocation path.
//
// The decision→outcome mapping is pure + exported so it is unit-tested without a DB.

import { createServiceClient } from "@/lib/supabase/service"

export type InvocationOutcome = "executed" | "planned" | "denied" | "error"

/** Pure: collapse a planner/route decision into a coarse outcome for rollups. */
export function outcomeForDecision(decision: string): InvocationOutcome {
  switch (decision) {
    case "executed":
      return "executed"
    case "execute":
    case "requires_confirmation":
    case "no_executor":
      return "planned"
    case "unauthorized":
    case "invalid_input":
    case "blocked":
    case "not_connected":
      return "denied"
    case "error":
      return "error"
    default:
      return "planned"
  }
}

export interface InvocationLogInput {
  capability: string
  kind: "vendor" | "app" | "connected"
  verb?: string | null
  decision: string
  brokerageId?: string | null
  callerVia?: string | null
  authorized?: boolean | null
  durationMs?: number | null
  error?: string | null
  detail?: Record<string, unknown>
}

/**
 * Record one invocation. Never throws — a logging failure is swallowed so it can't break
 * the caller. Returns true when the row was written.
 */
export async function recordInvocation(input: InvocationLogInput): Promise<boolean> {
  try {
    const svc = createServiceClient()
    const { error } = await svc.from("agentic_invocation_log").insert({
      capability: input.capability,
      kind: input.kind,
      verb: input.verb ?? null,
      decision: input.decision,
      outcome: outcomeForDecision(input.decision),
      brokerage_id: input.brokerageId ?? null,
      caller_via: input.callerVia ?? null,
      authorized: input.authorized ?? null,
      duration_ms: input.durationMs ?? null,
      error: input.error ?? null,
      detail: input.detail ?? {},
    })
    return !error
  } catch {
    return false
  }
}
