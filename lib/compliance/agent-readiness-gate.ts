// lib/compliance/agent-readiness-gate.ts
//
// AGENT READINESS GATE — the server-side HARD block that stops a license/CE/ethics-BLOCKED agent from
// performing a license-dependent act (putting a legal document out for signature). The readiness
// evaluator already warns + gates advisory findings at offer intake; this is the enforcement chokepoint
// so a lapsed agent can't actually send. Reuses the CANONICAL evaluateLicenseReadiness (no drift with
// the offer-time gate + the autonomous sweep).
//
// SCOPING (honest, minimal-false-positive): only blocks when the ACTING user IS an agent with a hard
// blocker. A non-agent actor (broker admin / TC / support) has no agents row → not blocked (they're not
// the licensee). Missing license data → not blocked (we never fabricate a blocker from absent data).

import type { SupabaseClient } from "@supabase/supabase-js"
import { evaluateLicenseReadiness } from "./license-readiness"

type Svc = SupabaseClient<any, any, any>

export interface AgentTransactableResult {
  /** True = clear to perform the license-dependent action. */
  transactable: boolean
  /** Human blocker titles (empty when transactable). */
  blockers: string[]
  /** A ready-to-return client message when NOT transactable (null when clear). */
  message: string | null
}

/**
 * Resolve whether the acting user (by auth user id) is clear to transact. Best-effort: any lookup
 * failure resolves to transactable (a compliance-data hiccup must never hard-block legitimate work — the
 * autonomous sweep + offer-time findings still surface the issue).
 */
export async function checkAgentTransactable(svc: Svc, agentUserId: string | null | undefined): Promise<AgentTransactableResult> {
  const clear: AgentTransactableResult = { transactable: true, blockers: [], message: null }
  if (!agentUserId) return clear
  try {
    const { data: agent } = await svc
      .from("agents")
      .select("license_expiry, ce_hours_required, ce_hours_completed, ce_cycle_end_date, ethics_due_date")
      .eq("user_id", agentUserId)
      .maybeSingle()
    if (!agent) return clear // not a licensed agent (broker admin / TC / support) → not the licensee
    const r = evaluateLicenseReadiness({
      licenseExpiry: (agent as any).license_expiry ?? null,
      ceHoursRequired: (agent as any).ce_hours_required ?? null,
      ceHoursCompleted: (agent as any).ce_hours_completed ?? null,
      ceCycleEndDate: (agent as any).ce_cycle_end_date ?? null,
      ethicsDueDate: (agent as any).ethics_due_date ?? null,
    })
    if (r.blockers.length === 0) return clear
    const titles = r.blockers.map((b) => b.title)
    return {
      transactable: false,
      blockers: titles,
      message: `You can't send documents for signature right now — ${titles.join("; ")}. Update your license & CE in Settings → Profile, then try again.`,
    }
  } catch {
    return clear // never hard-block on a data/lookup error
  }
}
