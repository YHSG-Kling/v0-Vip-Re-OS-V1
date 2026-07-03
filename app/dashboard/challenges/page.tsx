import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getChallenges } from "@/app/actions/challenges"
import { ChallengesClient } from "./challenges-client"

export const dynamic = "force-dynamic"

const ADMIN_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "superadmin"])

export default async function ChallengesPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  const { challenges } = await getChallenges()
  const isAdmin = ADMIN_ROLES.has(ctx.role)

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Challenges</h1>
        <p className="text-muted-foreground mt-1">
          Time-boxed team competitions. Live standings, prize points on the shared ledger, winners crowned automatically.
        </p>
      </div>
      <ChallengesClient challenges={challenges} isAdmin={isAdmin} currentAgentId={ctx.agentId} />
    </div>
  )
}
