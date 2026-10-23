import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { getAgentGoals } from "@/app/actions/ai-agent-goals"
import { GoalsClient } from "./goals-client"

export const dynamic = "force-dynamic"

export default async function GoalsPage() {
  // Heal an incomplete account IN PLACE (don't bounce off the page you're on).
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.agentId || !ctx.brokerageId) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Finishing your account setup — refresh in a moment to view your goals.
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
