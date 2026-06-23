import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getManagerTrustScorecard, getLearnedAdjustmentsForBrokerage } from "@/app/actions/admin/manager-evals"
import { ManagerTrustClient } from "./manager-trust-client"

export const dynamic = "force-dynamic"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

export default async function ManagerTrustPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ADMIN_ROLES.has(ctx.userType)) redirect("/dashboard")

  const res = await getManagerTrustScorecard()
  if (!res.ok) {
    return <div className="p-6 text-red-600">Failed to load manager trust: {res.error}</div>
  }
  const learnedRes = await getLearnedAdjustmentsForBrokerage()
  const learned = learnedRes.ok ? learnedRes.rows : []
  return <ManagerTrustClient managers={res.managers} team={res.team} learned={learned} />
}
