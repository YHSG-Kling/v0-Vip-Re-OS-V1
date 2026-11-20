"use server"

/**
 * /dashboard/campaigns/roi — the ROI reader's one write: DECLINE A RECOMMENDATION, WITH WHY (wave 155, lane 155J — directive J4:
 * "Audit when suggested content was rejected and why, so the OS avoids proposing the same low-value action").
 *
 * SURVIVORS, not a new store (LAW 1 / LAW 2):
 *   · the record ...... THE proposal kernel — lib/kernel/improvement-proposals.ts proposeImprovement (subject kind `allocation`,
 *                       "a marketing budget recommendation a human approves"; proposer `human`) then decideProposal(reject) with
 *                       the person's reason as decision_reason. improvement_proposals already audits both steps.
 *   · the reader ...... lib/intelligence/roi-ledger.ts loadRoiOutcomeLedger reads the REJECTED rows back
 *                       (applyDeclinedRecommendations) and stops proposing that (kind, campaign); the page lists them with why.
 *   · the evidence .... withActionLedger action `marketing.recommendation.decline` (domain.entity.action), idempotent per
 *                       (subject, day) — a double click records one decline.
 * AUTHORITY (§4): tenant and seat from the SESSION, never the body; only the tenant admin roster decides a proposal
 * (decideProposal refuses anyone else — TENANT_ADMIN_USER_TYPES, spread, never copied). A campaign id must be this tenant's.
 * Nothing here changes spend, a campaign or another tenant: it only records that a person said "not useful" and why.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { roiRecommendationSubjectKey, type RoiOutcomeLedger } from "@/lib/intelligence/roi-ledger"

type RecommendationKind = RoiOutcomeLedger["recommendations"][number]["kind"]
const KINDS: readonly RecommendationKind[] = ["review_reduce", "record_spend", "finalize_commission", "repair_attribution", "repeat_what_worked"]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function declineRoiRecommendation(input: { kind: string; campaignId: string | null; reason: string }): Promise<{ ok: true; proposalId: string } | { ok: false; error: string }> {
  const kind = String(input?.kind ?? "") as RecommendationKind
  if (!KINDS.includes(kind)) return { ok: false, error: "That recommendation is not one this report makes." }
  const campaignId = input?.campaignId == null || input.campaignId === "" ? null : String(input.campaignId)
  if (campaignId && !UUID.test(campaignId)) return { ok: false, error: "That campaign is not valid." }
  const reason = String(input?.reason ?? "").trim().slice(0, 500)
  if (reason.length < 3) return { ok: false, error: "Say briefly why it is not useful, so it is not suggested again for the same reason." }

  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth?.user?.id
  if (!userId) return { ok: false, error: "Sign in to decline a recommendation." }
  const svc = createServiceClient()
  const { data: me, error: meErr } = await svc.from("users").select("id, brokerage_id, user_type").eq("id", userId).maybeSingle()
  if (meErr || !me?.brokerage_id) return { ok: false, error: "We couldn't confirm your workspace. Try again in a moment." }
  const brokerageId = String(me.brokerage_id)
  const userType = String(me.user_type ?? "")
  if (!TENANT_ADMIN_USER_TYPES.has(userType)) return { ok: false, error: "Recommendations are decided by your brokerage's leadership, team lead or compliance officer." }
  if (campaignId) {
    const { data: camp, error: campErr } = await svc.from("marketing_campaigns").select("id").eq("id", campaignId).eq("brokerage_id", brokerageId).maybeSingle()
    if (campErr) return { ok: false, error: "We couldn't read that campaign. Try again in a moment." }
    if (!camp) return { ok: false, error: "That campaign is not in your workspace." }
  }

  const subjectKey = roiRecommendationSubjectKey(kind, campaignId)
  const [{ proposeImprovement, decideProposal }, { withActionLedger }] = await Promise.all([import("@/lib/kernel/improvement-proposals"), import("@/lib/kernel/action-ledger")])
  const decline = async (): Promise<{ ok: true; proposalId: string } | { ok: false; error: string }> => {
    const p = await proposeImprovement(svc, {
      brokerageId, subjectKind: "allocation", subjectKey, proposer: "human",
      proposedChange: { kind, campaign_id: campaignId, source: "roi_reader", summary: `ROI recommendation ${kind}${campaignId ? ` for campaign ${campaignId}` : ""}` },
      evidenceRefs: campaignId ? [`marketing_campaigns:${campaignId}`] : [],
    })
    if (!p.ok) return { ok: false, error: p.error }
    const d = await decideProposal(svc, { brokerageId, id: p.id, decision: "reject", actor: { type: "user", userId, isTenantAdmin: true, userType }, reason })
    return d.ok ? { ok: true, proposalId: p.id } : { ok: false, error: d.error }
  }
  let replayed = false
  const res = await withActionLedger<{ ok: true; proposalId: string } | { ok: false; error: string }>(
    {
      brokerageId,
      action: "marketing.recommendation.decline",
      actor: { type: "user", userId },
      subject: { type: "marketing_campaign", id: campaignId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: reason,
      idempotencyKey: `marketing.recommendation.decline:${subjectKey}:${new Date().toISOString().slice(0, 10)}`,
      riskClass: "READ",
      systemSource: "roi_reader",
      detail: { kind, subject_key: subjectKey },
    },
    decline,
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: "recommendation_declined" } : { status: "failed", outcome: "decline_refused", error: r.error }),
      // A REPLAY (same subject, same day) is already recorded; a REFUSED or unknown claim is NOT — it is said, never read as done.
      replay: (claim) => {
        if (claim.kind === "replay") { replayed = true; return { ok: false as const, error: "__replay__" } }
        return { ok: false as const, error: claim.kind === "refused" ? `The decline could not be recorded (${claim.error}). Try again.` : "A decline for this is already in progress — refresh in a moment." }
      },
    },
    { client: svc as any },
  )
  // A replay is the same person's same decline today — already recorded; say so rather than writing it twice.
  if (!res.ok && replayed) return { ok: false, error: "Already declined today — it will not be suggested again." }
  return res
}
