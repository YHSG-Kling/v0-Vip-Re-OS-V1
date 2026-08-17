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

  const [automationsResult, errorsResult] = await Promise.all([
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

  return (
    <AutomationsClient
      automations={automations}
      recentErrors={recentErrors}
      brokerageId={ctx.brokerageId}
      currentUserId={ctx.userId}
    />
  )
}
