import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import {
  getManagerTrustScorecard, getLearnedAdjustmentsForBrokerage,
  getCrossManagerReferrals, getStandingReviews, getTeamworkMetrics,
} from "@/app/actions/admin/manager-evals"
import { composeTeamArgumentMap } from "@/lib/managers/team-argument-map"
import { reaperCoverage } from "@/lib/intelligence/reaper-net"
import { ManagerTrustClient, type OwnedProofSeat } from "./manager-trust-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { MAINTENANCE_DOMAINS, MANAGERS, resolveMaintenanceManager, type ManagerKey } from "@/lib/kernel/manager-registry"

/**
 * OWNED PROOFS — every maintenance/burn domain in the registry, grouped by the manager
 * that resolveMaintenanceManager holds ACCOUNTABLE for it, with the proof (npm script)
 * that keeps it green. Pure registry data, computed server-side so the surface can never
 * drift from the law. resolveMaintenanceManager had no product reader before this — the
 * ownership simulator was the only caller — so maintenance ownership was enforced in a
 * test and shown nowhere a broker could see it.
 */
function composeOwnedProofs(): OwnedProofSeat[] {
  const byManager = new Map<ManagerKey, OwnedProofSeat>()
  for (const key of Object.keys(MANAGERS) as ManagerKey[]) {
    byManager.set(key, { key, label: MANAGERS[key].label, accent: MANAGERS[key].accent, domains: [], proofs: [] })
  }
  for (const domain of Object.keys(MAINTENANCE_DOMAINS)) {
    const mgr = resolveMaintenanceManager(domain)
    const seat = byManager.get(mgr.key)
    if (!seat) continue
    const proof = MAINTENANCE_DOMAINS[domain].proof
    seat.domains.push({ domain, proof })
    if (!seat.proofs.includes(proof)) seat.proofs.push(proof)
  }
  return Array.from(byManager.values())
    .map((s) => ({ ...s, proofs: s.proofs.sort(), domains: s.domains.sort((a, b) => a.domain.localeCompare(b.domain)) }))
    .sort((a, b) => b.domains.length - a.domains.length)
}

export const dynamic = "force-dynamic"

export default async function ManagerTrustPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!isAdminOrBroker({ user_type: ctx.userType })) redirect("/dashboard")

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
  // ACCURACY GATE (round 36): per-domain accuracy-driven-autonomy verdicts — the exact
  // policy dispatch enforces for an 'autonomous' posture, shown with its measured reason.
  let accuracyGates: Awaited<ReturnType<typeof import("@/lib/managers/accuracy-gate").loadAccuracyGateReport>> = []
  // HOLD TELEMETRY (round 37): sends actually HELD by the accuracy gate, rolled up
  // per manager/domain from the self-heal ledger (the same rows the Exception
  // Center folds). null ⇒ the ledger couldn't be read — rendered as unavailable.
  let accuracyHolds: Awaited<ReturnType<typeof import("@/lib/managers/accuracy-gate").loadAccuracyHoldRollup>> = null
  if (ctx.brokerageId) {
    try {
      const { loadAccuracyGateReport, loadAccuracyHoldRollup } = await import("@/lib/managers/accuracy-gate")
      ;[accuracyGates, accuracyHolds] = await Promise.all([
        loadAccuracyGateReport(ctx.brokerageId),
        loadAccuracyHoldRollup(ctx.brokerageId, 30),
      ])
    } catch { accuracyGates = []; accuracyHolds = null }
  }
  // THE TEAM ARGUMENT MAP (round 41): who argues with whom — derived PURELY from the
  // registry (collaborations + emitters + loaders), computed server-side and handed to
  // the client as plain data so the surface can never drift from the law.
  const teamMap = composeTeamArgumentMap()
  const ownedProofs = composeOwnedProofs()
  // REAPER COVERAGE — the honest "how much of the team is reaped" map
  // (lib/intelligence/reaper-net.ts:reaperCoverage): which managers have a dedicated
  // reaper in the net, which are covered by a predictor → handler chain instead, and
  // which are covered by NOTHING. Pure registry data (no I/O), same idiom as the
  // argument map above; it had no product reader before this — only test:reaper-net —
  // so the coverage gaps were enforced in a proof and shown nowhere a broker could see.
  const reaper = reaperCoverage()
  return (
    <ManagerTrustClient
      managers={res.managers}
      team={res.team}
      teamMap={teamMap}
      ownedProofs={ownedProofs}
      reaperCoverage={reaper}
      learned={learned}
      referrals={referrals}
      standingReviews={standingReviews}
      teamwork={teamwork}
      accuracyGates={accuracyGates}
      accuracyHolds={accuracyHolds}
    />
  )
}
