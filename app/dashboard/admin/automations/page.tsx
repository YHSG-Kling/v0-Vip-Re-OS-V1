import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { AutomationsClient } from "./automations-client"

export const metadata = { title: "Workflow Automations | Admin" }

export default async function AutomationsPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard")

  // Gate: admin/broker only
  const allowedRoles = ["admin", "broker", "superadmin"]
  if (!allowedRoles.includes(ctx.userType)) redirect("/dashboard")

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
      .in("status", ["open", "failed"])
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
