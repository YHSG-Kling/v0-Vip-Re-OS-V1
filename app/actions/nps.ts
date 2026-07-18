"use server"

// TENANT → PLATFORM NPS actions — the survey card's server half.
//
// Deliberately NOT principal-gated: every tenant team member's opinion counts,
// so any authenticated tenant user (agent, TC, broker, admin …) can answer.
// The only exclusions are honest ones: contact-portal logins and platform
// staff (no brokerage_id) are not subscribers, and an impersonating staff
// member must never file NPS as the tenant they're acting as.
//
// Idempotency: UNIQUE(user_id, period) on platform_nps_responses — a duplicate
// submit in the same month is reported as success, not an error. Eligibility
// (once per QUARTER, 30+ days of tenancy) lives in lib/platform/nps.ts.

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { shouldPromptNps, submitNps } from "@/lib/platform/nps"

/** Should the current user see the NPS survey card? False on any doubt. */
export async function shouldPromptNpsAction(): Promise<{ prompt: boolean }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { prompt: false }
  // Staff acting-as a tenant never gets surveyed on the tenant's behalf.
  if (ctx.isImpersonating) return { prompt: false }
  return { prompt: await shouldPromptNps(ctx.userId) }
}

/** Record the current user's score (+ optional one-liner) for this month. */
export async function submitNpsAction(params: {
  score: number
  verbatim?: string
}): Promise<{ ok: true; alreadySubmitted?: boolean } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "Only tenant workspace members can respond" }
  if (ctx.isImpersonating) return { ok: false, error: "Impersonating staff cannot submit NPS for a tenant" }

  const r = await submitNps({
    userId: ctx.userId,
    brokerageId: ctx.brokerageId,
    score: params.score,
    verbatim: params.verbatim ?? null,
  })
  if (!r.ok) return { ok: false, error: r.error ?? "Failed to record response" }
  return { ok: true, alreadySubmitted: r.alreadySubmitted }
}
