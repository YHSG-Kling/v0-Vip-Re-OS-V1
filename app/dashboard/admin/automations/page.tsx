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
    service
      .from("workflow_executions")
      .select("id, workflow_name, error_message, status, started_at")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("status", "failed")
      .order("started_at", { ascending: false })
      .limit(50),
  ])

  const automations = automationsResult.data ?? []

  // Map workflow_executions failed rows to the AutomationError shape
  const recentErrors = (errorsResult.data ?? []).map((e) => ({
    id: e.id,
    workflow_name: e.workflow_name ?? "Unknown workflow",
    error_message: e.error_message ?? "Unknown error",
    severity: "high" as const,
    status: "open",
    context_json: undefined,
    created_at: e.started_at ?? new Date().toISOString(),
    resolved_at: null,
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
