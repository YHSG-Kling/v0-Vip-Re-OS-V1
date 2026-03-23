import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { redirect } from "next/navigation"
import { AutomationsClient } from "./automations-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Workflow Automations | Admin",
  description: "Create and manage workflow automations for your brokerage",
}

export default async function AutomationsPage() {
  const ctx = await getAgentContext()
  if (!ctx) redirect("/login")

  const allowedRoles = ["admin", "broker", "superadmin"]
  if (!allowedRoles.some((r) => ctx.roles.includes(r))) {
    redirect("/dashboard")
  }

  const supabase = await createClient()

  // Load existing automations for this brokerage
  const { data: automations } = await supabase
    .from("workflow_automations")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })

  // Load recent unresolved workflow errors
  const { data: recentErrors } = await supabase
    .from("automation_errors")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .neq("status", "resolved")
    .order("created_at", { ascending: false })
    .limit(20)

  return (
    <AutomationsClient
      automations={automations ?? []}
      recentErrors={recentErrors ?? []}
      brokerageId={ctx.brokerageId ?? ""}
      currentUserId={ctx.userId ?? ""}
    />
  )
}
