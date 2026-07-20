import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import {
  getManagerTrustScorecard, getLearnedAdjustmentsForBrokerage,
  getCrossManagerReferrals, getStandingReviews, getTeamworkMetrics,
} from "@/app/actions/admin/manager-evals"
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
  // CROSS-MANAGEMENT (round 34): referral lifecycle + standing reviews on the governance surface.
  // TEAMWORK (round 35): the referral + deliberation ledgers rolled up for the compact card.
  const [referralsRes, reviewsRes, teamworkRes] = await Promise.all([
    getCrossManagerReferrals(), getStandingReviews(), getTeamworkMetrics(),
  ])
  const referrals = referralsRes.ok ? referralsRes.referrals : []
  const standingReviews = reviewsRes.ok ? reviewsRes.reviews : []
  const teamwork = teamworkRes.ok ? teamworkRes.metrics : null
  return (
    <ManagerTrustClient
      managers={res.managers}
      team={res.team}
      learned={learned}
      referrals={referrals}
      standingReviews={standingReviews}
      teamwork={teamwork}
    />
  )
}
