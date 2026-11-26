"use server"

/**
 * app/actions/compliance/representation-review.ts — WAVE 156 (lane 156B). THE HUMAN HALF OF THE EXECUTED-PACKET REVIEW.
 *
 * Owner (2026-11-25): "after the fully signed listing agreement is in, the compliance gate goes before creating a transaction"
 * — and a signature is not compliance. lib/kernel/compliance/representation-gate.ts compares what the executed paper says
 * against the record and returns allow / hold / refuse / needs_review. The model extracts and the comparator compares; neither
 * ACCEPTS a packet. These doors are where a person with review authority does — rendered on the compliance queue
 * (app/dashboard/compliance/queue) and on the listing (app/dashboard/listings/[id]/compliance-review):
 *
 *   listRepresentationReviewQueueAction  the packets waiting on review or repair — every one for a reviewer; their own for an
 *                                        agent; their assigned ones for a coordinator.
 *   getRepresentationReviewAction        one packet: the compared terms side by side, every reason with its form, field and repair,
 *                                        the link to the real executed document, the hash to approve, and whether THIS viewer may
 *                                        decide.
 *   recordRepresentationReview           approve (or hold, with a note) THAT evidence hash. A stale hash is refused; an approval is
 *                                        refused while any HOLD stands. An approval continues ONLY the authorized next step.
 *   attestRepresentationTerms            the reviewer's field-by-field reading of an executed document the scan could not read
 *                                        (failed / empty / low-confidence) — recorded under the reviewer's own identity; the
 *                                        comparison then runs on the attested terms and a contradiction still holds.
 *
 * Every export is a public endpoint (CLAUDE.md §4): the tenant comes from the SESSION, the subject is read pinned to it, the
 * authority is lib/auth/deal-work-ownership.ts `closingApproval` (compliance_officer, or the tenant admin roster minus team_lead /
 * compliance_officer; a tenant principal — the solo owner — holds it). The owning agent alone, a TC, a team lead, a vendor (lender,
 * title, closing attorney) or a Contact never decides. Gate first, then the service client.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/

type RecordKind = "listing_agreement" | "purchase_offer"
type Subject = { record: RecordKind; subjectId: string }

/** Module-private: the session seat — who they are, and whether they hold review authority in this tenant. */
async function sessionSeat() {
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { ok: false as const, error: "Sign in again to review this packet." }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const B = s.actor.brokerageId
  const [mine, grants] = await Promise.all([
    svc.from("agents").select("id").eq("user_id", s.actor.userId).eq("brokerage_id", B).maybeSingle(),
    svc.from("user_role_assignments").select("role, brokerage_id").eq("user_id", s.actor.userId),
  ])
  if (mine.error || grants.error) return { ok: false as const, error: "Your role couldn't be read just now. Try again shortly." }
  const grantedRoles = ((grants.data ?? []) as Array<{ role: string | null; brokerage_id: string | null }>).filter((g) => g.brokerage_id === B && g.role).map((g) => String(g.role))
  const myAgentId = ((mine.data ?? null) as { id?: string } | null)?.id ?? null
  const { mayReviewRepresentation, isSoloTierPrincipal } = await import("@/lib/kernel/compliance/representation-gate")
  // wave 156 (156R): the solo-tier principal (TIER PARITY — a solo subscriber IS their own broker) reviews their own packets. Fail closed.
  const solo = await isSoloTierPrincipal(svc, { brokerageId: B, userType: s.actor.userType ?? null })
  if (!solo.ok) return { ok: false as const, error: "Your account's plan couldn't be read just now. Try again shortly." }
  const authority = mayReviewRepresentation({ sameTenant: true, userType: s.actor.userType ?? null, grantedRoles, isOwningAgent: false, isTenantPrincipal: s.actor.isTenantPrincipal === true || solo.isSolo })
  const isTc = String(s.actor.userType ?? "").toLowerCase() === "tc" || grantedRoles.includes("tc")
  return { ok: true as const, svc, actor: s.actor, myAgentId, mayDecide: authority.ok, roles: authority.roles, isTc, isSolo: solo.isSolo }
}

/** Module-private: the session actor admitted to THIS subject (reviewer, its agent, its assigned / a tenant coordinator). */
async function gateSubject(input: Subject) {
  if (input?.record !== "listing_agreement" && input?.record !== "purchase_offer") return { ok: false as const, error: "Choose a listing agreement or an executed offer." }
  if (!UUID.test(String(input?.subjectId ?? ""))) return { ok: false as const, error: "Choose a listing or an offer." }
  const seat = await sessionSeat()
  if (!seat.ok) return seat
  const B = seat.actor.brokerageId
  const table = input.record === "listing_agreement" ? "listings" : "offers"
  const cols = input.record === "listing_agreement" ? "id, agent_id, brokerage_id, seller_contact_id" : "id, agent_id, brokerage_id, contact_id"
  const { data: row, error } = await seat.svc.from(table).select(cols).eq("id", input.subjectId).eq("brokerage_id", B).maybeSingle()
  if (error) return { ok: false as const, error: "The packet couldn't be read just now. Try again shortly." }
  if (!row) return { ok: false as const, error: "This packet isn't in your account." }
  const r = row as { agent_id?: string | null; seller_contact_id?: string | null; contact_id?: string | null }
  const isOwningAgent = !!seat.myAgentId && seat.myAgentId === r.agent_id
  // The owning agent and the coordinators READ the review (status and reasons); only a reviewer decides it. Anyone else sees nothing.
  if (!seat.mayDecide && !isOwningAgent && !seat.isTc) return { ok: false as const, error: "Only the packet's agent, its coordinator or your compliance team can see this review." }
  return { ok: true as const, svc: seat.svc, actor: seat.actor, mayDecide: seat.mayDecide, roles: seat.roles, contactId: r.seller_contact_id ?? r.contact_id ?? null }
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

/** The packets waiting on review or repair, scoped to the viewer. An empty list is a real empty queue; a failed read says so. */
export async function listRepresentationReviewQueueAction() {
  const seat = await sessionSeat()
  if (!seat.ok) return { success: false as const, error: seat.error, items: [] }
  const B = seat.actor.brokerageId
  const OPEN = new Set(["awaiting_review", "blocked", "revoked"])
  const [ls, os] = await Promise.all([
    seat.svc.from("listings").select("id, address, city, agent_id, seller_contact_id, lifecycle_stage, metadata").eq("brokerage_id", B).limit(1000),
    seat.svc.from("offers").select("id, property_address, agent_id, contact_id, metadata").eq("brokerage_id", B).limit(1000),
  ])
  if (ls.error || os.error) return { success: false as const, error: "The review queue could not be loaded, so this is not an empty queue.", items: [] }
  type Row = { id: string; agent_id: string | null; metadata: any; address?: string | null; city?: string | null; property_address?: string | null; seller_contact_id?: string | null; contact_id?: string | null }
  const gateOf = (r: Row) => (r.metadata && typeof r.metadata === "object" ? r.metadata.compliance_gate : null) as { state?: string; verdict?: string; blockers?: string[]; checked_at?: string } | null
  const candidates = [
    ...((ls.data ?? []) as Row[]).map((r) => ({ record: "listing_agreement" as const, r, title: [r.address, r.city].filter(Boolean).join(", ") || "Listing", contactId: r.seller_contact_id ?? null })),
    ...((os.data ?? []) as Row[]).map((r) => ({ record: "purchase_offer" as const, r, title: r.property_address || "Executed offer", contactId: r.contact_id ?? null })),
  ].filter((c) => OPEN.has(String(gateOf(c.r)?.state)))
  // Scope: a reviewer sees the tenant's queue; an agent their own packets; a coordinator the packets assigned to them.
  let assigned = new Set<string>()
  if (!seat.mayDecide && seat.isTc) {
    const ids = [...new Set(candidates.map((c) => c.contactId).filter((x): x is string => !!x))]
    if (ids.length) {
      const { data, error } = await seat.svc.from("contacts").select("id, tc_user_id").eq("brokerage_id", B).in("id", ids)
      if (error) return { success: false as const, error: "The review queue could not be loaded, so this is not an empty queue.", items: [] }
      assigned = new Set(((data ?? []) as Array<{ id: string; tc_user_id: string | null }>).filter((c) => c.tc_user_id === seat.actor.userId).map((c) => c.id))
    }
  }
  const visible = candidates.filter((c) => seat.mayDecide || (!!seat.myAgentId && c.r.agent_id === seat.myAgentId) || (!!c.contactId && assigned.has(c.contactId)))
  return {
    success: true as const, mayDecide: seat.mayDecide,
    items: visible.map((c) => { const g = gateOf(c.r)!; return { record: c.record, subjectId: c.r.id, title: c.title, state: String(g.state), verdict: g.verdict ? String(g.verdict) : "hold", blockers: Array.isArray(g.blockers) ? g.blockers.slice(0, 12) : [], checkedAt: g.checked_at ?? null } }),
  }
}

/** The review a reviewer (or the packet's agent / coordinator) opens: verdict, compared terms, reasons, documents, hash to approve. */
export async function getRepresentationReviewAction(input: Subject) {
  const g = await gateSubject(input)
  if (!g.ok) return { success: false as const, error: g.error }
  const d = await currentDecision(g.svc, g.actor.brokerageId, input)
  if (!d.ok) return { success: false as const, error: `The review could not run: ${d.error}` }
  const { documentOpenHref } = await import("@/lib/storage/signed-doc-url")
  const { ATTESTABLE_TERMS, REPAIR_PATHS, REPRESENTATION_REVIEWER_AUTHORITY } = await import("@/lib/kernel/compliance/representation-gate")
  const documents = (d.decision.evidence.documents ?? []).map((doc) => ({ ...doc, openHref: documentOpenHref(doc.storageUrl) }))
  // The screen renders each reason's repair FROM the repair table and says who may approve FROM the authority constant —
  // one source for both, never a second spelling on the client.
  const repairs = Object.fromEntries([...new Set(d.decision.blockingReasons.map((r) => r.code))].map((code) => [code, REPAIR_PATHS[code]]))
  const ROLE_LABEL: Record<string, string> = { compliance_reviewer: "a compliance officer", tenant_admin: "an account admin (broker, broker owner, broker admin, admin — or a solo agent who owns the account)" }
  const whoMayApprove = `Approval: ${REPRESENTATION_REVIEWER_AUTHORITY.roles.map((r) => ROLE_LABEL[r] ?? r).join(" or ")}. Never: ${REPRESENTATION_REVIEWER_AUTHORITY.never.join(", ")}.`
  return { success: true as const, decision: { ...d.decision, evidence: { ...d.decision.evidence, documents } }, mayDecide: g.mayDecide, attestableTerms: [...ATTESTABLE_TERMS[input.record]], repairs, whoMayApprove }
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
      const { resolveAssignedCoordinators } = await import("@/lib/kernel/compliance/representation-gate")
      const assigned = await resolveAssignedCoordinators(g.svc, { brokerageId: B, contactIds: [g.contactId] })
      await notifyComplianceFlag(g.svc as never, {
        brokerageId: B, agentUserId: g.actor.userId, assignedCoordinatorUserIds: assigned.userIds,
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
    // Through the offer's own loop (round 3): the ONE chokepoint creates the transaction AND the packet walks
    // compliance_approved → fully_executed on the ladder, exactly as an approval-free pass used to.
    const { runOfferComplianceLoop } = await import("@/lib/transactions/offer-compliance-loop")
    const turn = await runOfferComplianceLoop(g.svc as never, { brokerageId: B, offerId: input.subjectId, trigger: "compliance_review_recorded", actorUserId: g.actor.userId })
    return { success: true, decision: "approve", continued: { offer: turn.outcome, transaction_id: turn.transactionId ?? null, error: turn.outcome === "advanced" ? null : turn.reason ?? null } }
  })
}

/**
 * The reviewer's FIELD-BY-FIELD ATTESTATION of one executed document (round 2): the repair for a scan that failed, came back empty
 * or read with low confidence. The reviewer records the terms THEY read on the executed paper, under their own identity and review
 * authority; the comparison then runs on those terms (a contradiction with the record still holds), and any approval binds to the
 * resulting evidence hash. Only the comparator's own keys are accepted (ATTESTABLE_TERMS). No model path calls this.
 */
export async function attestRepresentationTerms(input: Subject & { documentId: string; terms: Record<string, string | number | null>; signersConfirmed?: boolean }) {
  if (!UUID.test(String(input?.documentId ?? ""))) return { success: false as const, error: "Choose the executed document you read." }
  const g = await gateSubject(input)
  if (!g.ok) return { success: false as const, error: g.error }
  if (!g.mayDecide) return { success: false as const, error: "Only a compliance reviewer or an account admin can attest the terms of an executed document." }
  const { ATTESTABLE_TERMS, REPRESENTATION_REVIEW_GATE } = await import("@/lib/kernel/compliance/representation-gate")
  const allowed = new Set(ATTESTABLE_TERMS[input.record])
  const terms: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(input.terms ?? {})) {
    if (!allowed.has(k)) return { success: false as const, error: `"${k}" is not a term this review compares.` }
    if (v === null || v === undefined || (typeof v === "string" && !v.trim())) continue
    if (typeof v !== "string" && typeof v !== "number") return { success: false as const, error: `"${k}" must be text or a number.` }
    terms[k] = typeof v === "string" ? v.trim().slice(0, 500) : v
  }
  if (Object.keys(terms).length === 0) return { success: false as const, error: "Record at least one term you read on the executed document." }
  const B = g.actor.brokerageId
  // The document must be THIS packet's executed paper, in this tenant.
  const docQ = g.svc.from("documents").select("id, listing_id, metadata").eq("id", input.documentId).eq("brokerage_id", B)
  const { data: doc, error: docErr } = await docQ.maybeSingle()
  if (docErr) return { success: false as const, error: "The document couldn't be read just now. Try again shortly." }
  const d0 = doc as { listing_id?: string | null; metadata?: any } | null
  const onFile = !!d0 && (input.record === "listing_agreement" ? d0.listing_id === input.subjectId : d0.metadata?.linked_offer_id === input.subjectId)
  if (!onFile) return { success: false as const, error: "That document is not on this packet's file." }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({
    brokerageId: B, action: "compliance.representation.attest", actor: { type: "user", userId: g.actor.userId, agentId: g.actor.agentId ?? null },
    subject: { type: "document", id: input.documentId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED",
    detail: { record: input.record, subject_id: input.subjectId, terms: Object.keys(terms), signers_confirmed: input.signersConfirmed === true },
  }, async () => {
    const { data, error } = await g.svc.from("compliance_events").insert({
      brokerage_id: B, gate_name: REPRESENTATION_REVIEW_GATE, entity_type: input.record, entity_id: input.subjectId, allowed: false,
      actor_user_id: g.actor.userId, actor_role: g.roles[0] ?? "reviewer", severity: "info", violations: [],
      details: { kind: "attestation", document_id: input.documentId, terms, signers_confirmed: input.signersConfirmed === true },
    }).select("id")
    if (error) return { success: false, error: `The attestation could not be recorded: ${error.message}` }
    if (!data || data.length === 0) return { success: false, error: "The attestation record matched nothing." }
    const cur = await currentDecision(g.svc, B, input)
    if (!cur.ok) return { success: true, decision: null, error: `Recorded; the review could not re-run: ${cur.error}` }
    return { success: true, decision: cur.decision }
  })
}

/**
 * wave 156 (lane 156R) — MAY THIS SEAT OPEN THE "EXECUTED PACKETS TO REVIEW" SECTION when the compliance dashboard's own role gate
 * (app/actions/compliance/dashboard.ts ACCESS_ROLES) refuses it? Exactly one case: the SOLO-TIER PRINCIPAL (isSoloTierPrincipal — a
 * seat whose canonical role is `agent` on a stored plan_tier = 'solo_agent' account). It opens the packet-review section only, never
 * the rest of the compliance dashboard, and it is no new role. A plain agent in a brokerage is refused; a refused read refuses.
 */
export async function packetReviewSectionAdmissionAction(): Promise<{ admitted: boolean; error?: string }> {
  const seat = await sessionSeat()
  if (!seat.ok) return { admitted: false, error: seat.error }
  return { admitted: seat.isSolo === true && seat.mayDecide }
}
