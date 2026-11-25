"use server"

/**
 * app/actions/governing-terms.ts — THE CONFIRM DOOR for a deal's proposed governing terms (wave 156, lane 156E).
 *
 * A model reads a contract; it does not rewrite the deal. app/actions/ai-contract-review.ts applyContractExtraction records
 * the extracted terms as a PROPOSAL (lib/documents/governing-terms-proposal.ts). A term reaches the deal only here:
 *   1. THE DEAL DESK FIRST (lib/transactions/role-guard.ts requireDealDesk) — the session's seat must WORK this deal. A client,
 *      a vendor, an ISA, an agent off the deal is refused before anything is read or written. Tenant and deal are the desk's.
 *   2. PER FIELD — the person names each term they accept and each they dismiss; nothing is accepted by default.
 *   3. IDEMPOTENT — a term already decided is skipped; confirming the same thing twice changes the deal once.
 *   4. COUNTED — the deal update is pinned to deal + tenant and must touch exactly one row.
 *   5. A RECEIPT — one agent_action_ledger row (ledgerSessionAction) naming who confirmed, which fields were accepted and
 *      dismissed, and the source (the document id, or the pasted text's hash).
 * Both exports are public endpoints (CLAUDE.md §4) and both ask the desk first.
 */

import type { GoverningTermField, GoverningTermsProposal } from "@/lib/documents/governing-terms-proposal"

export interface ProposedTermView {
  proposalId: string
  source: GoverningTermsProposal["source"]
  proposedAt: string
  field: GoverningTermField
  label: string
  proposed: string | number
  current: string | number | null
}

const LABEL: Record<GoverningTermField, string> = {
  purchase_price: "Purchase price", close_date: "Closing date", property_address: "Property address",
  inspection_deadline: "Inspection deadline", appraisal_deadline: "Appraisal deadline", financing_deadline: "Financing deadline",
}

/** The deal's UNDECIDED proposed terms beside the deal's current values — for a seat that works the deal. */
export async function loadProposedGoverningTermsAction(transactionId: string): Promise<{ success: true; terms: ProposedTermView[] } | { success: false; error: string }> {
  const { requireDealDesk } = await import("@/lib/transactions/role-guard")
  const desk = await requireDealDesk(transactionId)
  if (!desk.ok) return { success: false, error: desk.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { readGoverningTermsProposals, GOVERNING_TERM_FIELDS } = await import("@/lib/documents/governing-terms-proposal")
  const cur = await readGoverningTermsProposals(svc, desk.transactionId, desk.brokerageId)
  if (!cur.ok) return { success: false, error: cur.error }
  const { data: ms, error: msErr } = await svc.from("transaction_milestones").select("milestone_name, target_date").eq("transaction_id", desk.transactionId)
  if (msErr) return { success: false, error: `Could not read the deal's milestones: ${msErr.message}` }
  const dueOf = new Map(((ms ?? []) as Array<{ milestone_name: string; target_date: string | null }>).map((m) => [m.milestone_name, m.target_date]))
  const terms: ProposedTermView[] = []
  for (const p of cur.proposals) {
    for (const [f, v] of Object.entries(p.fields ?? {}) as Array<[GoverningTermField, string | number]>) {
      if (p.decisions?.[f] || !(f in GOVERNING_TERM_FIELDS)) continue
      const spec = GOVERNING_TERM_FIELDS[f]
      const current = spec.deal ? ((cur.deal[spec.deal] as string | number | null) ?? null) : (dueOf.get(spec.milestone as string) ?? null)
      terms.push({ proposalId: p.id, source: p.source, proposedAt: p.proposed_at, field: f, label: LABEL[f], proposed: v, current })
    }
  }
  return { success: true, terms }
}

/** Accept and / or dismiss named fields of ONE proposal. Desk first; see the header for the five rules. */
export async function confirmGoverningTermsAction(input: {
  transactionId: string
  proposalId: string
  accept?: string[]
  dismiss?: string[]
}): Promise<{ success: true; applied: string[]; dismissed: string[]; skipped: string[] } | { success: false; error: string }> {
  const { requireDealDesk } = await import("@/lib/transactions/role-guard")
  const desk = await requireDealDesk(input?.transactionId)
  if (!desk.ok) return { success: false, error: desk.error }
  const accept = Array.isArray(input.accept) ? input.accept.map(String) : []
  const dismiss = Array.isArray(input.dismiss) ? input.dismiss.map(String) : []
  if (accept.length + dismiss.length === 0) return { success: false, error: "Name at least one term to accept or dismiss" }
  if (typeof input.proposalId !== "string" || !input.proposalId) return { success: false, error: "Proposal not found" }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { applyGoverningTermsDecisions, readGoverningTermsProposals } = await import("@/lib/documents/governing-terms-proposal")
  // The proposal's SOURCE is read first, so the receipt names the document (or the pasted text's hash) the terms came from.
  const cur = await readGoverningTermsProposals(svc, desk.transactionId, desk.brokerageId)
  if (!cur.ok) return { success: false, error: cur.error }
  const proposal = cur.proposals.find((p) => p.id === input.proposalId)
  if (!proposal) return { success: false, error: "That proposal is not on this deal" }
  const src = proposal.source
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({
    brokerageId: desk.brokerageId, action: "transaction.governing_terms.confirm",
    actor: { type: "user", userId: desk.userId, agentId: desk.agentId },
    subject: { type: "transaction", id: desk.transactionId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED",
    detail: {
      proposal_id: input.proposalId, accepted: accept, dismissed: dismiss, confirmed_by_user_id: desk.userId,
      source_kind: src.kind, source_document_id: src.kind === "client_document" ? src.document_id : null, source_sha256: src.kind === "pasted_contract_text" ? src.sha256 : null,
    },
  }, async () => {
    const result = await applyGoverningTermsDecisions(svc, { transactionId: desk.transactionId, brokerageId: desk.brokerageId, proposalId: input.proposalId, accept, dismiss, by: desk.userId })
    return result.ok ? { success: true as const, applied: result.applied, dismissed: result.dismissed, skipped: result.skipped } : { success: false as const, error: result.error }
  })
  const out = r as { success?: boolean; error?: string; applied?: string[]; dismissed?: string[]; skipped?: string[] }
  if (!out || out.success !== true) return { success: false, error: out?.error ?? "The terms were not confirmed" }
  if (out.applied?.length) {
    const { revalidatePath } = await import("next/cache")
    revalidatePath(`/dashboard/transactions/${desk.transactionId}`)
  }
  return { success: true, applied: out.applied ?? [], dismissed: out.dismissed ?? [], skipped: out.skipped ?? [] }
}

/** wave 156 (156R): the review status of the executed offer packet that governs a deal, as the deal page shows it. */
export interface DealPacketReviewStatus { offerId: string; state: "approved" | "held" | "under_review"; holdCount: number; href: string }

/**
 * THE REVIEW, REACHABLE FROM THE DEAL (wave 156, lane 156R). The executed-packet review (lane 156B, lib/kernel/compliance/
 * representation-gate.ts) lives at /dashboard/compliance/queue/review/purchase_offer/<offer>; the deal page showed nothing of it.
 * This read answers, for a seat the DEAL DESK admits (requireDealDesk — a vendor, a Contact, an off-deal agent is refused and the
 * page renders nothing): the deal's offer packet is approved / held (with the number of reasons) / under review. It RECOMPUTES the
 * decision from the stored records (never a cached flag), as the packet was reviewed (asReviewed: the deal's own existence is not a
 * reason). It decides nothing — Approve stays on the review screen, behind its own authority. A deal without an offer has no packet
 * here (status null).
 */
export async function loadDealPacketReviewStatusAction(transactionId: string): Promise<{ success: true; status: DealPacketReviewStatus | null } | { success: false; error: string }> {
  const { requireDealDesk } = await import("@/lib/transactions/role-guard")
  const desk = await requireDealDesk(transactionId)
  if (!desk.ok) return { success: false, error: desk.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: tx, error } = await svc.from("transactions").select("id, offer_id").eq("id", desk.transactionId).eq("brokerage_id", desk.brokerageId).maybeSingle()
  if (error) return { success: false, error: `The deal's offer couldn't be read: ${error.message}` }
  const offerId = (tx as { offer_id?: string | null } | null)?.offer_id ?? null
  if (!offerId) return { success: true, status: null }
  // THE CONTRACT IS THE ACCEPTED SEQUENCE'S HEAD — resolved by the SAME rule lane 156B's creation gate uses (governingOfferPacket →
  // acceptedOfferSequence). When the deal's offer is an earlier instrument that a later executed counter superseded, the rule refuses
  // with `later_execution` and NAMES that one instrument: the packet is read from it (no second resolver).
  const { governingOfferPacket } = await import("@/lib/offers/governing-terms")
  let gp = await governingOfferPacket(svc as never, desk.brokerageId, offerId)
  if (!gp.ok && gp.kind === "refused" && gp.code === "later_execution" && gp.offerIds.length === 1) gp = await governingOfferPacket(svc as never, desk.brokerageId, gp.offerIds[0])
  if (!gp.ok) return { success: false, error: `The offer packet couldn't be read: ${gp.reason}` }
  const packet = gp.packet
  const { loadAndDecideOfferRepresentation } = await import("@/lib/kernel/compliance/representation-gate")
  // An approval is recorded under the offer id the reviewer opened (the evidence hash names it). Any id of the SAME accepted
  // sequence may carry it, so each is asked — the head first; the head's decision is the one whose holds the line shows.
  const subjects = [...new Set([packet.headOfferId, offerId, ...packet.sequence])]
  let head: { blockingReasons: Array<{ severity: string }>; verdict: string } | null = null
  let approved = false
  for (const subject of subjects) {
    const d = await loadAndDecideOfferRepresentation(svc as never, { brokerageId: desk.brokerageId, offerId: subject, packet, gate: { allowed: true, refusals: [] }, asReviewed: true })
    if (!d.ok) return { success: false, error: `The packet review couldn't run: ${d.error}` }
    if (subject === packet.headOfferId) head = d.decision
    if (d.decision.verdict === "allow") approved = true
  }
  const holdCount = (head?.blockingReasons ?? []).filter((r) => r.severity !== "review").length
  const state = holdCount > 0 ? "held" : approved ? "approved" : "under_review"
  const reviewId = packet.headOfferId
  return { success: true, status: { offerId: reviewId, state, holdCount, href: `/dashboard/compliance/queue/review/purchase_offer/${reviewId}` } }
}
