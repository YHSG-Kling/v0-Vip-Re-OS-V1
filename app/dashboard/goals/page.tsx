import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getAgentGoals } from "@/app/actions/ai-agent-goals"
import { GoalsClient } from "./goals-client"

export const dynamic = "force-dynamic"

export default async function GoalsPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.agentId || !ctx.brokerageId) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Agent profile not found. Contact your admin.
      </div>
    )
  }

  const { data: goals } = await getAgentGoals({
    agentId: ctx.agentId,
    brokerageId: ctx.brokerageId,
  })

  return (
    <GoalsClient
      agentId={ctx.agentId}
      brokerageId={ctx.brokerageId}
      initialGoals={goals ?? []}
      year={new Date().getFullYear()}
    />
  )
}
