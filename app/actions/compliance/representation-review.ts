"use server"

/**
 * app/actions/compliance/representation-review.ts — WAVE 156 (lane 156B). THE HUMAN HALF OF THE EXECUTED-PACKET REVIEW.
 *
 * Owner (2026-11-25): "after the fully signed listing agreement is in, the compliance gate goes before creating a transaction"
 * — and a signature is not compliance. lib/kernel/compliance/representation-gate.ts compares what the executed paper says
 * against the record and returns allow / hold / refuse / needs_review. The model extracts and the comparator compares; neither
 * ACCEPTS a packet. These two doors are where a person with review authority does:
 *
 *   getRepresentationReviewAction   the current decision for one listing agreement / executed offer — every reason with its
 *                                   document and term, the evidence hash to approve, and whether THIS viewer may decide.
 *   recordRepresentationReview      approve (or hold, with a note) THAT evidence hash. A stale hash (the packet changed since it
 *                                   was opened) is refused; an approval is refused while any HOLD stands — a contradiction is
 *                                   repaired, never approved away. An approval continues ONLY the authorized downstream step:
 *                                   the listing's compliance loop (→ coming-soon prep) or the offer's submit-to-compliance
 *                                   (→ exactly one purchase transaction). Receipt: compliance_events + agent_action_ledger.
 *
 * Every export is a public endpoint (CLAUDE.md §4): the tenant comes from the SESSION, the subject is read pinned to it, the
 * authority is lib/auth/deal-work-ownership.ts `closingApproval` (compliance_officer, or the tenant admin roster minus team_lead /
 * compliance_officer) — the owning agent alone, a TC, a team lead, a vendor (lender, title, closing attorney) or a Contact never
 * holds it. Gate first, then the service client.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/

type Subject = { record: "listing_agreement" | "purchase_offer"; subjectId: string }

/** Module-private: the session actor admitted to THIS subject, and whether they hold review authority. */
async function gateSubject(input: Subject) {
  if (input?.record !== "listing_agreement" && input?.record !== "purchase_offer") return { ok: false as const, error: "Choose a listing agreement or an executed offer." }
  if (!UUID.test(String(input?.subjectId ?? ""))) return { ok: false as const, error: "Choose a listing or an offer." }
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { ok: false as const, error: "Sign in again to review this packet." }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const B = s.actor.brokerageId
  const table = input.record === "listing_agreement" ? "listings" : "offers"
  const { data: row, error } = await svc.from(table).select("id, agent_id, brokerage_id").eq("id", input.subjectId).eq("brokerage_id", B).maybeSingle()
  if (error) return { ok: false as const, error: "The packet couldn't be read just now. Try again shortly." }
  if (!row) return { ok: false as const, error: "This packet isn't in your account." }
  const [mine, grants] = await Promise.all([
    svc.from("agents").select("id").eq("user_id", s.actor.userId).eq("brokerage_id", B).maybeSingle(),
    svc.from("user_role_assignments").select("role, brokerage_id").eq("user_id", s.actor.userId),
  ])
  if (mine.error || grants.error) return { ok: false as const, error: "Your role on this packet couldn't be read just now. Try again shortly." }
  const grantedRoles = ((grants.data ?? []) as Array<{ role: string | null; brokerage_id: string | null }>).filter((g) => g.brokerage_id === B && g.role).map((g) => String(g.role))
  const isOwningAgent = !!(mine.data as { id?: string } | null)?.id && (mine.data as { id: string }).id === (row as { agent_id?: string | null }).agent_id
  const { mayReviewRepresentation } = await import("@/lib/kernel/compliance/representation-gate")
  const authority = mayReviewRepresentation({ sameTenant: true, userType: s.actor.userType ?? null, grantedRoles, isOwningAgent })
  // The owning agent may READ their own packet's review; only a reviewer decides it. Anyone else sees nothing.
  if (!authority.ok && !isOwningAgent) return { ok: false as const, error: "Only the packet's agent or your compliance team can see this review." }
  return { ok: true as const, svc, actor: s.actor, mayDecide: authority.ok, roles: authority.roles }
}

/** Module-private: the CURRENT decision for the subject, recomputed from the stored records (never from the caller). */
async function currentDecision(svc: any, brokerageId: string, input: Subject) {
  const rg = await import("@/lib/kernel/compliance/representation-gate")
  if (input.record === "listing_agreement") {
    const { assertListingActivationAllowed } = await import("@/lib/listings/listing-activation-gate")
    const gate = await assertListingActivationAllowed(svc, { brokerageId, listingId: input.subjectId, door: "compliance review", complianceReview: true })
    if (!gate.allowed && gate.detail.complianceState === "unknown") return { ok: false as const, error: gate.reason }
    return rg.loadAndDecideListingRepresentation(svc, { brokerageId, listingId: input.subjectId, gate })
  }
  const { governingOfferPacket } = await import("@/lib/offers/governing-terms")
  const gp = await governingOfferPacket(svc, brokerageId, input.subjectId)
  if (!gp.ok) return { ok: false as const, error: gp.reason }
  return rg.loadAndDecideOfferRepresentation(svc, { brokerageId, offerId: input.subjectId, packet: gp.packet, gate: { allowed: true, refusals: [] } })
}

/** The review a reviewer (or the packet's agent) opens: the verdict, every reason with its document, the hash to approve. */
export async function getRepresentationReviewAction(input: Subject) {
  const g = await gateSubject(input)
  if (!g.ok) return { success: false as const, error: g.error }
  const d = await currentDecision(g.svc, g.actor.brokerageId, input)
  if (!d.ok) return { success: false as const, error: `The review could not run: ${d.error}` }
  return { success: true as const, decision: d.decision, mayDecide: g.mayDecide }
}

/** A reviewer accepts (or holds) THIS evidence. Approval continues only the authorized downstream transition. */
export async function recordRepresentationReview(input: Subject & { decision: "approve" | "hold"; evidenceHash: string; note?: string }) {
  if (input?.decision !== "approve" && input?.decision !== "hold") return { success: false as const, error: "Choose approve or hold." }
  if (!HASH.test(String(input?.evidenceHash ?? ""))) return { success: false as const, error: "Open the current review before deciding it." }
  if (input.decision === "hold" && !String(input.note ?? "").trim()) return { success: false as const, error: "Say which form or term is wrong — a hold names the fix." }
  const g = await gateSubject(input)
  if (!g.ok) return { success: false as const, error: g.error }
  if (!g.mayDecide) return { success: false as const, error: "Only a compliance reviewer or an account admin can accept or hold a packet. The agent leads the deal; compliance decides the paperwork." }
  const B = g.actor.brokerageId
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({
    brokerageId: B, action: "compliance.representation.review", actor: { type: "user", userId: g.actor.userId, agentId: g.actor.agentId ?? null },
    subject: { type: input.record, id: input.subjectId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED",
    idempotencyKey: `${B}:${input.record}:${input.subjectId}:${input.evidenceHash}:${input.decision}`,
    detail: { decision: input.decision, evidence_hash: input.evidenceHash, roles: g.roles },
  }, async () => {
    const cur = await currentDecision(g.svc, B, input)
    if (!cur.ok) return { success: false, error: `The review could not run, so nothing was decided: ${cur.error}` }
    const d = cur.decision
    if (d.evidenceHash !== input.evidenceHash) return { success: false, error: "The packet changed since you opened it. Re-open the review and decide the current packet." }
    if (input.decision === "approve" && d.blockingReasons.some((r) => r.severity !== "review")) {
      return { success: false, error: `This packet has items to fix first — a hold is repaired, not approved: ${d.blockingReasons.filter((r) => r.severity !== "review").map((r) => r.message).join(" ")}` }
    }
    const { data, error } = await g.svc.from("compliance_events").insert({
      brokerage_id: B, gate_name: "representation_review", entity_type: input.record, entity_id: input.subjectId,
      allowed: input.decision === "approve", blocked_reason: input.decision === "hold" ? String(input.note).slice(0, 2000) : null,
      severity: input.decision === "hold" ? "high" : "info", actor_user_id: g.actor.userId, actor_role: g.roles[0] ?? "reviewer", violations: [],
      details: { kind: "human_review", decision: input.decision, evidence_hash: d.evidenceHash, version: d.version, note: input.note ?? null, reviewed_reasons: d.blockingReasons.map((r) => r.code) },
    }).select("id")
    if (error) return { success: false, error: `The review could not be recorded, so nothing continued: ${error.message}` }
    if (!data || data.length === 0) return { success: false, error: "The review record matched nothing, so nothing continued." }

    if (input.decision === "hold") {
      const { notifyComplianceFlag } = await import("@/lib/notifications/notify-helpers")
      await notifyComplianceFlag(g.svc as never, {
        brokerageId: B, agentUserId: g.actor.userId,
        flag: { type: "compliance.representation_held", severity: "high", title: "Compliance held the executed packet", body: String(input.note),
          entityType: input.record === "listing_agreement" ? "listing" : "offer", entityId: input.subjectId,
          documentId: d.blockingReasons.find((r) => r.documentId)?.documentId ?? d.evidence.documentIds[0] ?? null,
          offerId: input.record === "purchase_offer" ? input.subjectId : null },
      })
      return { success: true, decision: "hold", continued: null }
    }
    // APPROVED — continue ONLY the authorized downstream transition, through its own door (which re-runs every check).
    if (input.record === "listing_agreement") {
      const { runListingComplianceLoop } = await import("@/lib/listings/listing-compliance-loop")
      const turn = await runListingComplianceLoop(g.svc as never, { brokerageId: B, listingId: input.subjectId, trigger: "compliance_review_recorded", actorUserId: g.actor.userId })
      return { success: true, decision: "approve", continued: { listing: turn.outcome, stage: turn.stage, reason: turn.reason } }
    }
    const { submitOfferToCompliance } = await import("@/app/actions/buyer-offer/submit-to-compliance")
    const sub = await submitOfferToCompliance({ offerId: input.subjectId, userId: g.actor.userId })
    return { success: true, decision: "approve", continued: { transaction_id: sub.transaction_id ?? null, error: sub.success ? null : sub.error ?? null } }
  })
}
