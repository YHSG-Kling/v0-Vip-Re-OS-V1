import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import { AutomationsClient } from "./automations-client"

export const metadata = { title: "Workflow Automations | Admin" }

export default async function AutomationsPage() {
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard")

  // TRUE ADMIN GATE (operational: automations/assignment rules) — repointed to
  // the ONE tenant roster. 'superadmin' was dead: 0 live rows store that
  // users.user_type.
  if (!isAdminOrBroker({ user_type: ctx.userType })) redirect("/dashboard")

  const service = createServiceClient()

  const [automationsResult, errorsResult, runsResult] = await Promise.all([
    service
      .from("workflow_automations")
      .select("*")
      .eq("brokerage_id", ctx.brokerageId)
      .order("created_at", { ascending: false }),
    // Automation errors come from the canonical automation_errors table (the
    // retired Engine A's workflow_executions never recorded any).
    service
      .from("automation_errors")
      .select("id, workflow_name, error_message, severity, status, context_json, created_at, resolved_at")
      .eq("brokerage_id", ctx.brokerageId)
      // automation_errors.status ∈ (open, investigating, resolved, dismissed).
      // This asked for 'failed', which the CHECK does not admit — dead weight
      // that hid the fact 'investigating' rows were being filtered out too.
      .in("status", ["open", "investigating"])
      .order("created_at", { ascending: false })
      .limit(50),
    // ── THE RUN LEDGER — the read half that was never built ─────────────────
    // `workflow_automations.execution_count` counts attempts and says nothing
    // about any of them, so this page could report "fired 43 times" over 43 runs
    // that may each have refused every action they were asked to take.
    // `automation_logs` is the per-run record; its writer
    // (app/actions/assistant.ts:handleAutomationTriggered) was fully built, gated
    // and called by NOBODY, and nothing anywhere read the table — a whole pair
    // with neither end connected. lib/kernel/manager-registry.ts:463 named this
    // page, through the service-client-after-gate pattern, as where it belongs.
    // Both ends are wired now: app/actions/multi-persona.ts:executeWorkflow calls
    // the writer, and this reads it.
    //
    // SERVICE CLIENT AFTER THE GATE, tenant-scoped in the query — the same shape
    // as the two reads above, and the reason is on the registry entry: platform
    // staff hold no tenant brokerage_id, so a session-client read would resolve
    // to zero rows AFTER the admin gate above had already said yes.
    service
      .from("automation_logs")
      .select("id, automation_id, user_id, trigger_type, result, executed_at")
      .eq("brokerage_id", ctx.brokerageId)
      .order("executed_at", { ascending: false })
      .limit(50),
  ])

  const automations = automationsResult.data ?? []

  const recentErrors = (errorsResult.data ?? []).map((e: any) => ({
    id: e.id,
    workflow_name: e.workflow_name ?? "Unknown workflow",
    error_message: e.error_message ?? "Unknown error",
    severity: (e.severity ?? "high") as "critical" | "high" | "medium" | "low",
    status: e.status ?? "open",
    context_json: e.context_json ?? undefined,
    created_at: e.created_at ?? new Date().toISOString(),
    resolved_at: e.resolved_at ?? null,
  }))

  // The automation's NAME lives on workflow_automations, not on the log row, so it
  // is joined here rather than denormalised into the ledger — one source for a
  // name that an operator can rename at any time.
  const nameById = new Map<string, string>(
    automations.map((a: any) => [String(a.id), String(a.workflow_name ?? "Unnamed automation")]),
  )

  // WHO fired each run. `automation_logs.user_id` is the actor, and a run ledger
  // that cannot say who triggered a run is only half a ledger — an operator
  // looking at a refused milestone update needs to know whose click caused it.
  // Resolved here, tenant-scoped, rather than denormalised into the log row.
  const runActorIds = [...new Set((runsResult.data ?? []).map((r: any) => r.user_id).filter(Boolean).map(String))]
  const actorNames = new Map<string, string>()
  if (runActorIds.length > 0) {
    const { data: actors } = await service
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", runActorIds)
      .eq("brokerage_id", ctx.brokerageId)
    for (const a of actors ?? []) {
      const name = [a.first_name, a.last_name].filter(Boolean).join(" ").trim()
      actorNames.set(String(a.id), name || String(a.email ?? "Unknown user"))
    }
  }

  const recentRuns = (runsResult.data ?? []).map((r: any) => {
    const result = (r.result ?? {}) as Record<string, any>
    return {
      id: String(r.id),
      automation_id: r.automation_id ? String(r.automation_id) : null,
      // Prefer the live name; fall back to the one recorded at run time, which is
      // the only name left for an automation that has since been deleted.
      workflow_name:
        (r.automation_id && nameById.get(String(r.automation_id))) ||
        (typeof result.workflow_name === "string" ? result.workflow_name : null) ||
        "Deleted automation",
      trigger_type: r.trigger_type ?? "unknown",
      // An actor id with no name is a user outside this brokerage (or deleted) —
      // said plainly rather than rendered as a bare uuid or silently blanked.
      actor: r.user_id ? (actorNames.get(String(r.user_id)) ?? "User outside this brokerage") : "Unattributed",
      actions_total: Number(result.actions_total ?? 0),
      actions_done: Number(result.actions_done ?? 0),
      actions_refused: Number(result.actions_refused ?? 0),
      actions_skipped: Number(result.actions_skipped ?? 0),
      outcomes: Array.isArray(result.outcomes) ? result.outcomes : [],
      executed_at: r.executed_at ?? new Date().toISOString(),
    }
  })

  return (
    <AutomationsClient
      automations={automations}
      recentErrors={recentErrors}
      recentRuns={recentRuns}
      brokerageId={ctx.brokerageId}
      currentUserId={ctx.userId}
    />
  )
}
