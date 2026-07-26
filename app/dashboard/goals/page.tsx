import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getAgentGoals } from "@/app/actions/ai-agent-goals"
import { GoalsClient } from "./goals-client"

export const dynamic = "force-dynamic"

export default async function GoalsPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  // Incomplete/brokerage-less account → /dashboard self-heals the agent record and
  // re-routes ("contact your admin" was a dead end, and wrong for a solo agent).
  if (!ctx.agentId || !ctx.brokerageId) {
    redirect("/dashboard")
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
