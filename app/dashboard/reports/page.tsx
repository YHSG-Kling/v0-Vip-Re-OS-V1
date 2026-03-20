import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { ReportsClient } from "./reports-client"

export const dynamic = "force-dynamic"

export default async function ReportsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { agentId, brokerageId, role } = await getAgentContext()

  const today = new Date()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]

  return (
    <ReportsClient
      agentId={agentId}
      brokerageId={brokerageId}
      role={role || "agent"}
      userId={user.id}
      monthStart={monthStart}
    />
  )
}
