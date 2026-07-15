// lib/kernel/flow-integrity.ts
//
// FLOW-INTEGRITY ASSERTIONS + SELF-HEAL (cron_manager, agenticapi model) —
// the OS proves its OWN surface-to-surface wiring: "data entered surface A;
// did it actually arrive at surface B?" — and REPAIRS the break itself when
// the repair is proven safe. The connectivity fabric watches EXTERNAL
// connectors; this watches INTERNAL data flow, so no cross-surface handoff
// breaks silently.
//
// DESIGN HONESTY (investigated, not assumed): lifecycle_events.processed is
// audit-only in this schema (event types never flip it), so a naive
// "unprocessed backlog" would flag legitimate audit rows — that's noise, not a
// signal. Instead this asserts CONCRETE, per-row cross-surface CONTRACTS where
// BOTH ends are verifiable, so a finding is a real break with zero false
// positives. THE CONTRACT LIBRARY (each verified against the live schema AND
// the emitting rail before admission):
//
//   • PACKET COMPLETION — contract_signatures fully_signed, packet still open.
//   • OFFER E-SIGN STAMP — offers fully_signed, esign_completed_at never set.
//   • DOCUMENT SIGNED STAMP — envelope completed, deal-file doc not 'signed'.
//   • LEGAL-NAME WRITEBACK — trusted parties_signed scan, contact names empty.
//   • DECISION / LENDER / VENDOR / WALKTHROUGH TASK — the ledger event landed
//     but the agent task half of the dual-write rail never did.
//   • WALKTHROUGH SHAKY — major_issues recorded, deal_shaky never flipped
//     (guarded: a later deal_shaky_cleared event means a HUMAN cleared it —
//     never fought).
//   • CTC MILESTONE — lender recorded clear-to-close, milestone still pending.
//   • LISTING-AGREEMENT STAGE — agreement fully signed, listing stage stuck
//     (ESCALATE-only: the stage machine fires automations, a human confirms).
//
// Tiers + the earned-autonomy ratchet live in self-heal-ledger.ts
// (seed_safe heals silently; probation heals AND reports until it earns
// silence via the ledger; escalate routes to a human). Pure detectors
// (testable); the runner rides the deal-health-scan cron.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const FLOW_LOOKBACK_DAYS = 14
/** Events younger than this are never asserted — the emitting rail may still be in flight. */
export const FLOW_GRACE_MINUTES = 15

export type FlowKind =
  | "packet_completion"
  | "offer_esign_stamp"
  | "document_signed_stamp"
  | "legal_name_writeback"
  | "decision_task_missing"
  | "lender_condition_task_missing"
  | "vendor_request_task_missing"
  | "walkthrough_task_missing"
  | "walkthrough_shaky_gap"
  | "ctc_milestone_gap"
  | "listing_agreement_stage_gap"

export interface FlowBreak {
  flow: FlowKind
  key: string
  detail: string
  /** What the remediation runner needs (ids + the ledger event's facts). */
  ctx?: Record<string, any>
}

// ── Contract 1: packet completion ───────────────────────────────────────────

export interface SignedContractRow { envelopeId: string | null; fullySignedAt: string | null }
export interface PacketRow { envelopeId: string | null; requestStatus: string | null; completedAt: string | null }

/**
 * PURE: a contract is fully signed (both tables share provider_envelope_id),
 * but its packet never completed → the completion handoff broke. Only a
 * signed contract WITH a still-open packet counts; missing/absent packets
 * (email-only providers, no packet recorded) are NOT a break.
 */
export function detectPacketCompletionGaps(contracts: SignedContractRow[], packets: PacketRow[]): FlowBreak[] {
  const openByEnvelope = new Map<string, PacketRow>()
  for (const p of packets) {
    if (!p.envelopeId) continue
    // "still open" = pending/sent and not completed.
    if ((p.requestStatus === "pending" || p.requestStatus === "sent") && !p.completedAt) {
      openByEnvelope.set(p.envelopeId, p)
    }
  }
  const out: FlowBreak[] = []
  for (const c of contracts) {
    if (!c.envelopeId || !c.fullySignedAt) continue // only fully-signed contracts assert
    if (openByEnvelope.has(c.envelopeId)) {
      out.push({
        flow: "packet_completion",
        key: c.envelopeId,
        detail: `Envelope ${c.envelopeId} is fully signed but its signature packet never completed — the portal Sign button will linger on a signed document. Re-run completion for this envelope.`,
      })
    }
  }
  return out
}

// ── Contract 2: offer e-sign stamp ──────────────────────────────────────────

export interface OfferEsignRow { id: string; esignStatus: string | null; esignCompletedAt: string | null }

/** PURE: an offer marked fully_signed whose completion timestamp never landed. */
export function detectOfferEsignStampGaps(offers: OfferEsignRow[]): FlowBreak[] {
  const out: FlowBreak[] = []
  for (const o of offers) {
    if (o.esignStatus !== "fully_signed" || o.esignCompletedAt) continue
    out.push({
      flow: "offer_esign_stamp",
      key: o.id,
      detail: `Offer ${o.id} is fully signed but esign_completed_at was never stamped — downstream reads see a deal still in signing.`,
    })
  }
  return out
}

// ── Contract 3: document signed stamp ───────────────────────────────────────

export interface FlowDocumentRow { id: string; status: string | null; envelopeId: string | null }

/** PURE: the envelope completed but the deal-file document row never flipped to signed. */
export function detectDocumentSignedGaps(docs: FlowDocumentRow[], completedEnvelopes: Set<string>): FlowBreak[] {
  const out: FlowBreak[] = []
  for (const d of docs) {
    if (!d.envelopeId || d.status === "signed") continue
    if (!completedEnvelopes.has(d.envelopeId)) continue
    out.push({
      flow: "document_signed_stamp",
      key: d.id,
      detail: `Envelope ${d.envelopeId} completed but deal-file document ${d.id} never flipped to signed — the executed contract reads as unsigned in the deal file.`,
      ctx: { documentId: d.id, envelopeId: d.envelopeId },
    })
  }
  return out
}

// ── Contracts 4–7: ledger event landed, the task half of the rail didn't ───

export interface RailEventRow {
  id: string
  eventType: string
  /** offers rail: offer id · transaction rails: transaction id */
  entityId: string
  createdAt: string
  metadata: Record<string, any> | null
}
export interface RailTaskRow { source: string | null; transactionId: string | null; contactId: string | null; createdAt: string | null }

export const RAIL_TASK_CONTRACTS = [
  { eventType: "client_offer_decision", taskSource: "client_offer_decision", flow: "decision_task_missing" as FlowKind, matchBy: "contact" as const },
  { eventType: "lender_document_request", taskSource: "lender_condition", flow: "lender_condition_task_missing" as FlowKind, matchBy: "transaction" as const },
  { eventType: "vendor_request", taskSource: "vendor_request", flow: "vendor_request_task_missing" as FlowKind, matchBy: "transaction" as const },
  { eventType: "walkthrough_outcome", taskSource: "walkthrough_outcome", flow: "walkthrough_task_missing" as FlowKind, matchBy: "transaction" as const },
] as const

/**
 * PURE: each decision/lender/vendor/walkthrough rail writes the ledger event
 * AND the agent task as separate best-effort writes — the event landing with
 * no matching task means the client/vendor/lender acted and the agent never
 * saw it. Grace-windowed (an in-flight rail is never asserted); a task counts
 * as the match when its source matches and it anchors to the same
 * transaction (or, for offer decisions, the same contact) at/after the event.
 */
export function detectMissingRailTasks(events: RailEventRow[], tasks: RailTaskRow[], now: Date): FlowBreak[] {
  const graceCutoff = now.getTime() - FLOW_GRACE_MINUTES * 60_000
  const out: FlowBreak[] = []
  for (const contract of RAIL_TASK_CONTRACTS) {
    for (const e of events) {
      if (e.eventType !== contract.eventType) continue
      const eventAt = Date.parse(e.createdAt)
      if (!Number.isFinite(eventAt) || eventAt > graceCutoff) continue // still in flight
      const anchor = contract.matchBy === "contact" ? (e.metadata?.contact_id ?? null) : e.entityId
      if (!anchor) continue // no verifiable anchor → cannot assert (honest skip)
      const matched = tasks.some((t) => {
        if (t.source !== contract.taskSource) return false
        const tAnchor = contract.matchBy === "contact" ? t.contactId : t.transactionId
        if (tAnchor !== anchor) return false
        const tAt = t.createdAt ? Date.parse(t.createdAt) : NaN
        return Number.isFinite(tAt) && tAt >= eventAt - 60_000 // same rail run or later
      })
      if (matched) continue
      out.push({
        flow: contract.flow,
        key: e.id,
        detail: `Ledger event ${contract.eventType} (${e.id}) landed but its ${contract.taskSource} task never reached the agent's list — the person acted and nobody was told.`,
        ctx: { eventId: e.id, entityId: e.entityId, eventCreatedAt: e.createdAt, metadata: e.metadata ?? {} },
      })
    }
  }
  return out
}

// ── Contract 8: walkthrough major issues must flag the deal shaky ───────────

/**
 * PURE: a major_issues walkthrough MUST suspend file autonomy (deal_shaky).
 * Guarded against fighting a human: a later deal_shaky_cleared event on the
 * same transaction means someone deliberately cleared it — not a break.
 */
export function detectWalkthroughShakyGaps(
  walkthroughEvents: RailEventRow[],
  clearedEvents: Array<{ entityId: string; createdAt: string }>,
  shakyByTx: Map<string, boolean>,
  now: Date,
): FlowBreak[] {
  const graceCutoff = now.getTime() - FLOW_GRACE_MINUTES * 60_000
  const out: FlowBreak[] = []
  for (const e of walkthroughEvents) {
    if (e.eventType !== "walkthrough_outcome" || e.metadata?.outcome !== "major_issues") continue
    const eventAt = Date.parse(e.createdAt)
    if (!Number.isFinite(eventAt) || eventAt > graceCutoff) continue
    if (!shakyByTx.has(e.entityId)) continue // transaction not found → cannot assert
    if (shakyByTx.get(e.entityId)) continue // flag is set — contract holds
    const clearedAfter = clearedEvents.some((c) => c.entityId === e.entityId && Date.parse(c.createdAt) > eventAt)
    if (clearedAfter) continue // a human cleared it deliberately — never fought
    out.push({
      flow: "walkthrough_shaky_gap",
      key: e.entityId,
      detail: `Walkthrough on transaction ${e.entityId} recorded MAJOR issues but the deal never got its shaky flag — file autonomy stayed live on a wobbling deal.`,
      ctx: { transactionId: e.entityId, eventCreatedAt: e.createdAt },
    })
  }
  return out
}

// ── Contract 9: lender clear-to-close must complete the milestone ───────────

export interface CtcLenderRow { transactionId: string; clearToCloseDate: string | null }
export interface CtcMilestoneRow { id: string; transactionId: string | null; name: string | null; type: string | null; status: string | null }

/**
 * PURE: the lender recorded clear-to-close but the client-facing milestone
 * still says pending. Only a PRESENT pending CTC milestone is a break — a
 * deal without the milestone row was never promised one (zero false positives).
 */
export function detectCtcMilestoneGaps(lenders: CtcLenderRow[], milestones: CtcMilestoneRow[]): FlowBreak[] {
  const ctcByTx = new Map<string, string>()
  for (const l of lenders) {
    if (l.clearToCloseDate) ctcByTx.set(l.transactionId, l.clearToCloseDate)
  }
  const out: FlowBreak[] = []
  for (const m of milestones) {
    if (!m.transactionId || m.status !== "pending") continue
    const isCtc = m.name === "clear_to_close_received" || m.type === "clear_to_close"
    if (!isCtc) continue
    const ctcDate = ctcByTx.get(m.transactionId)
    if (!ctcDate) continue
    out.push({
      flow: "ctc_milestone_gap",
      key: m.id,
      detail: `Lender recorded clear-to-close (${ctcDate}) on transaction ${m.transactionId} but the client-facing milestone still shows pending — the client is watching a stale progress bar at the most nervous moment of the deal.`,
      ctx: { milestoneId: m.id, transactionId: m.transactionId, ctcDate },
    })
  }
  return out
}

// ── Contract 10: signed listing agreement must advance the listing ──────────

export interface AgreementStageRow { id: string; listingId: string | null }

/**
 * PURE: the webhook flips the agreement to fully_signed then advances the
 * listing stage machine — a listing still sitting at LISTING_AGREEMENT_INITIATED
 * under a fully signed agreement means the second half never ran. ESCALATE-only:
 * the stage transition fires kernel automations, so a human confirms it.
 */
export function detectListingAgreementStageGaps(
  agreements: AgreementStageRow[],
  stageByListing: Map<string, string | null>,
): FlowBreak[] {
  const out: FlowBreak[] = []
  for (const a of agreements) {
    if (!a.listingId) continue
    if (stageByListing.get(a.listingId) !== "LISTING_AGREEMENT_INITIATED") continue
    out.push({
      flow: "listing_agreement_stage_gap",
      key: a.id,
      detail: `Listing agreement ${a.id} is fully signed but listing ${a.listingId} never advanced past agreement-initiated — the coming-soon rail never started for a signed client.`,
      ctx: { agreementId: a.id, listingId: a.listingId },
    })
  }
  return out
}

// ── Contract 11: trusted scan parties must reach the contact record ─────────

export interface LegalNameCandidate {
  documentId: string
  transactionId: string | null
  /** trusted (verified or high-confidence) parties_signed values */
  parties: string[]
  contacts: Array<{ id: string; firstName: string | null; lastName: string | null; legalFirst: string | null; legalLast: string | null }>
}

/**
 * PURE: a trusted signed-contract scan carries a party that MATCHES a deal
 * contact whose legal names are still empty — the scan→contact writeback
 * never landed. Uses the writeback's own match discipline (both first AND
 * last name must appear in the party string), so only a fillable gap flags.
 */
export function detectLegalNameGaps(
  candidates: LegalNameCandidate[],
  partyMatches: (party: string, contact: { firstName: string | null; lastName: string | null }) => boolean,
): FlowBreak[] {
  const out: FlowBreak[] = []
  for (const c of candidates) {
    if (!c.transactionId || c.parties.length === 0) continue
    for (const contact of c.contacts) {
      if (contact.legalFirst || contact.legalLast) continue // already written — contract holds
      const party = c.parties.find((p) => partyMatches(p, { firstName: contact.firstName, lastName: contact.lastName }))
      if (!party) continue // no matching party → nothing was droppable (honest skip)
      out.push({
        flow: "legal_name_writeback",
        key: `${c.documentId}:${contact.id}`,
        detail: `Trusted contract scan ${c.documentId} names a party matching contact ${contact.id}, but the contact's legal name was never written back — the deal file knows a fact the contact record doesn't.`,
        ctx: { documentId: c.documentId, transactionId: c.transactionId, contactId: contact.id },
      })
      break // one break per document is enough to trigger the (whole-document) writeback re-run
    }
  }
  return out
}

// ── The runner: detect → classify (ratchet) → heal / report / escalate ─────

export interface FlowIntegrityResult { scanned: number; breaks: number; healed: number; notified: number; reported: number }

/** Re-run the exact remediation each contract's rail would have performed. Guarded + idempotent. */
async function runRemediation(svc: Svc, brk: FlowBreak, action: string, brokerageId: string): Promise<"healed" | "failed" | "escalated"> {
  const now2 = new Date().toISOString()
  try {
    switch (action) {
      case "complete_packet": {
        const { error } = await svc.from("signature_requests")
          .update({ request_status: "completed", completed_at: now2 })
          .eq("provider_envelope_id", brk.key).is("completed_at", null)
        return error ? "failed" : "healed"
      }
      case "stamp_offer_esign": {
        const { error } = await svc.from("offers")
          .update({ esign_completed_at: now2 })
          .eq("id", brk.key).is("esign_completed_at", null)
        return error ? "failed" : "healed"
      }
      case "stamp_document_signed": {
        const { data: docRow } = await svc.from("documents").select("id, status, metadata").eq("id", brk.ctx?.documentId).maybeSingle()
        if (!docRow || (docRow as any).status === "signed") return "healed" // resolved meanwhile — idempotent
        const meta = ((docRow as any).metadata as Record<string, unknown>) ?? {}
        const { error } = await svc.from("documents")
          .update({ status: "signed", metadata: { ...meta, signed_at: now2, signed_via: "flow_integrity_self_heal", signed_envelope_id: brk.ctx?.envelopeId ?? null } })
          .eq("id", (docRow as any).id) // idempotence via the status check above; re-stamping signed is harmless
        return error ? "failed" : "healed"
      }
      case "rerun_legal_name_writeback": {
        const { writebackLegalNames } = await import("@/lib/documents/contact-legal-writeback")
        const r = await writebackLegalNames(svc, {
          documentId: String(brk.ctx?.documentId ?? ""),
          transactionId: (brk.ctx?.transactionId as string | null) ?? null,
          brokerageId,
        })
        return r ? "healed" : "failed" // filled 0 = someone beat us to it; the writeback is additive-only either way
      }
      case "recreate_decision_task": {
        const meta = (brk.ctx?.metadata ?? {}) as Record<string, any>
        const offerId = String(brk.ctx?.entityId ?? "")
        const { data: offer } = await svc.from("offers")
          .select("id, agent_id, brokerage_id, offer_price, transaction_id, listing:listings(agent_id, address)")
          .eq("id", offerId).maybeSingle()
        if (!offer) return "escalated"
        const listing: any = Array.isArray((offer as any).listing) ? (offer as any).listing[0] : (offer as any).listing
        const assignee = (offer as any).agent_id ?? listing?.agent_id ?? null
        if (!assignee) return "escalated" // same honest refusal the original rail makes
        const decision = String(meta.decision ?? "decide")
        const side = meta.side === "seller" ? "Seller" : "Buyer"
        const price = (offer as any).offer_price ? `$${Number((offer as any).offer_price).toLocaleString("en-US")}` : "the offer"
        const where = listing?.address ? ` on ${listing.address}` : ""
        const { error } = await svc.from("tasks").insert({
          brokerage_id: brokerageId,
          transaction_id: (offer as any).transaction_id ?? null,
          contact_id: meta.contact_id ?? null,
          assigned_to_agent_id: assignee,
          title: `${side} recorded an offer decision (${decision}) — ${price}${where}`,
          description: `The ${side.toLowerCase()} recorded this decision on their portal and the task never reached your list — the OS restored it. Confirm with them and execute; nothing is final until the paperwork is signed.`,
          due_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
          assignee_type: "agent",
          source: "client_offer_decision",
          status: "pending",
        })
        return error ? "failed" : "healed"
      }
      case "recreate_lender_task": {
        const meta = (brk.ctx?.metadata ?? {}) as Record<string, any>
        const txId = String(brk.ctx?.entityId ?? "")
        const { data: tx } = await svc.from("transactions")
          .select("agent_id, buyer_contact_id, contact_id, property_address").eq("id", txId).maybeSingle()
        const assignee = (tx as any)?.agent_id ?? null
        if (!assignee) return "escalated"
        const conditions = Array.isArray(meta.conditions) ? meta.conditions.map(String).slice(0, 6) : []
        const { error } = await svc.from("tasks").insert({
          brokerage_id: brokerageId,
          transaction_id: txId,
          contact_id: (tx as any)?.buyer_contact_id ?? (tx as any)?.contact_id ?? null,
          assigned_to_agent_id: assignee,
          title: `Lender needs documents from the buyer${conditions.length ? ` — ${conditions.length} item${conditions.length === 1 ? "" : "s"}` : ""}`,
          description: `${meta.lender ?? "The lender"} posted loan conditions${(tx as any)?.property_address ? ` on ${(tx as any).property_address}` : ""}${conditions.length ? `: ${conditions.join("; ")}` : ""}. This task never reached your list — the OS restored it. Collect from the buyer and upload to the deal file.`,
          due_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
          assignee_type: "agent",
          source: "lender_condition",
          status: "pending",
        })
        return error ? "failed" : "healed"
      }
      case "recreate_vendor_task": {
        const meta = (brk.ctx?.metadata ?? {}) as Record<string, any>
        const txId = String(brk.ctx?.entityId ?? "")
        const { data: tx } = await svc.from("transactions")
          .select("agent_id, buyer_contact_id, contact_id, property_address").eq("id", txId).maybeSingle()
        const assignee = (tx as any)?.agent_id ?? null
        if (!assignee) return "escalated"
        const neededBy = typeof meta.needed_by === "string" && /^\d{4}-\d{2}-\d{2}/.test(meta.needed_by) ? meta.needed_by.slice(0, 10) : null
        const { error } = await svc.from("tasks").insert({
          brokerage_id: brokerageId,
          transaction_id: txId,
          contact_id: (tx as any)?.buyer_contact_id ?? (tx as any)?.contact_id ?? null,
          assigned_to_agent_id: assignee,
          title: `${meta.vendor ?? "A vendor"} filed a ${String(meta.request_type ?? "request").replace(/_/g, " ")}${(tx as any)?.property_address ? ` — ${(tx as any).property_address}` : ""}`,
          description: `${meta.vendor ?? "A vendor"}${meta.category ? ` (${meta.category})` : ""} filed this on the deal and the task never reached your list — the OS restored it.${meta.details ? ` Details: ${String(meta.details).slice(0, 300)}` : ""}`,
          due_date: neededBy ?? new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
          assignee_type: "agent",
          source: "vendor_request",
          status: "pending",
        })
        return error ? "failed" : "healed"
      }
      case "recreate_walkthrough_tasks": {
        const meta = (brk.ctx?.metadata ?? {}) as Record<string, any>
        const txId = String(brk.ctx?.entityId ?? "")
        const outcome = meta.outcome
        if (outcome !== "all_good" && outcome !== "minor_issues" && outcome !== "major_issues") return "escalated"
        const { data: tx } = await svc.from("transactions")
          .select("agent_id, buyer_contact_id, contact_id").eq("id", txId).maybeSingle()
        const assignee = (tx as any)?.agent_id ?? null
        if (!assignee) return "escalated"
        const contactId = (tx as any)?.buyer_contact_id ?? (tx as any)?.contact_id ?? null
        let addressAs = "Hey there"
        if (contactId) {
          const { data: contact } = await svc.from("contacts").select("first_name").eq("id", contactId).maybeSingle()
          if ((contact as any)?.first_name) addressAs = (contact as any).first_name
        }
        const { composeWalkthroughFollowUp } = await import("@/lib/transactions/walkthrough-outcome")
        const plan = composeWalkthroughFollowUp(outcome, addressAs)
        let created = 0
        for (const t of plan.agentTasks) {
          const { error } = await svc.from("tasks").insert({
            brokerage_id: brokerageId,
            transaction_id: txId,
            assigned_to_agent_id: assignee,
            title: t.title,
            description: `Walkthrough outcome: ${String(outcome).replace(/_/g, " ")}. This follow-up never reached your list — the OS restored it. Client line (send it): "${plan.clientLine}"`,
            due_date: new Date(Date.now() + t.dueDays * 86_400_000).toISOString().slice(0, 10),
            assignee_type: "agent",
            source: "walkthrough_outcome",
            status: "pending",
          })
          if (!error) created++
        }
        return created > 0 ? "healed" : "failed"
      }
      case "reflag_shaky": {
        const { error } = await svc.from("transactions")
          .update({ deal_shaky: true })
          .eq("id", brk.ctx?.transactionId ?? brk.key).eq("deal_shaky", false)
        return error ? "failed" : "healed"
      }
      case "complete_ctc_milestone": {
        const { error } = await svc.from("transaction_milestones")
          .update({ status: "completed", completed_at: now2 })
          .eq("id", brk.ctx?.milestoneId ?? brk.key).eq("status", "pending")
        return error ? "failed" : "healed"
      }
      default:
        return "escalated"
    }
  } catch {
    return "failed"
  }
}

/** Assert every cross-surface contract for one brokerage; heal what's proven, report probation heals, escalate the rest. */
export async function runFlowIntegrity(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<FlowIntegrityResult> {
  const out: FlowIntegrityResult = { scanned: 0, breaks: 0, healed: 0, notified: 0, reported: 0 }
  const since = new Date(now.getTime() - FLOW_LOOKBACK_DAYS * 86_400_000).toISOString()
  const RAIL_EVENT_TYPES = ["client_offer_decision", "lender_document_request", "vendor_request", "walkthrough_outcome", "deal_shaky_cleared"]
  const RAIL_TASK_SOURCES = ["client_offer_decision", "lender_condition", "vendor_request", "walkthrough_outcome"]

  const [
    { data: contracts }, { data: packets }, { data: offers }, { data: unsignedDocs },
    { data: railEvents }, { data: railTasks }, { data: ctcLenders }, { data: agreements },
    { data: trustedScans },
  ] = await Promise.all([
    svc.from("contract_signatures")
      .select("provider_envelope_id, fully_signed_at")
      .eq("brokerage_id", brokerageId).not("fully_signed_at", "is", null).gte("created_at", since).limit(2000),
    svc.from("signature_requests")
      .select("provider_envelope_id, request_status, completed_at")
      .eq("brokerage_id", brokerageId).not("provider_envelope_id", "is", null).gte("created_at", since).limit(2000),
    svc.from("offers")
      .select("id, esign_status, esign_completed_at")
      .eq("brokerage_id", brokerageId).eq("esign_status", "fully_signed").is("esign_completed_at", null).gte("created_at", since).limit(2000),
    svc.from("documents")
      .select("id, status, metadata")
      .eq("brokerage_id", brokerageId).not("metadata->>signature_request_id", "is", null)
      .or("status.is.null,status.neq.signed") // NULL status is also "not signed" — a bare neq would drop those rows
      .gte("created_at", since).limit(2000),
    svc.from("lifecycle_events")
      .select("id, entity_id, event_type, metadata, created_at")
      .eq("brokerage_id", brokerageId).in("event_type", RAIL_EVENT_TYPES).gte("created_at", since).limit(2000),
    svc.from("tasks")
      .select("source, transaction_id, contact_id, created_at")
      .eq("brokerage_id", brokerageId).in("source", RAIL_TASK_SOURCES).gte("created_at", since).limit(2000),
    svc.from("transaction_lenders")
      .select("transaction_id, clear_to_close_date")
      .eq("brokerage_id", brokerageId).not("clear_to_close_date", "is", null).gte("updated_at", since).limit(1000),
    svc.from("listing_agreements")
      .select("id, listing_id")
      .eq("brokerage_id", brokerageId).eq("esign_status", "fully_signed").gte("created_at", since).limit(1000),
    svc.from("document_field_extractions")
      .select("document_id, field_value_json, confidence, verified_at")
      .eq("brokerage_id", brokerageId).eq("field_key", "parties_signed").gte("created_at", since).limit(500),
  ])

  const contractRows: SignedContractRow[] = ((contracts ?? []) as any[]).map((c) => ({ envelopeId: c.provider_envelope_id ?? null, fullySignedAt: c.fully_signed_at ?? null }))
  const packetRows: PacketRow[] = ((packets ?? []) as any[]).map((p) => ({ envelopeId: p.provider_envelope_id ?? null, requestStatus: p.request_status ?? null, completedAt: p.completed_at ?? null }))
  const offerRows: OfferEsignRow[] = ((offers ?? []) as any[]).map((o) => ({ id: o.id, esignStatus: o.esign_status ?? null, esignCompletedAt: o.esign_completed_at ?? null }))
  const docRows: FlowDocumentRow[] = ((unsignedDocs ?? []) as any[]).map((d) => ({ id: d.id, status: d.status ?? null, envelopeId: (d.metadata as any)?.signature_request_id ?? null }))
  const completedEnvelopes = new Set(packetRows.filter((p) => p.envelopeId && (p.completedAt || p.requestStatus === "completed")).map((p) => p.envelopeId as string))
  const eventRows: RailEventRow[] = ((railEvents ?? []) as any[]).map((e) => ({ id: e.id, eventType: e.event_type, entityId: e.entity_id, createdAt: e.created_at, metadata: (e.metadata as any) ?? null }))
  const taskRows: RailTaskRow[] = ((railTasks ?? []) as any[]).map((t) => ({ source: t.source ?? null, transactionId: t.transaction_id ?? null, contactId: t.contact_id ?? null, createdAt: t.created_at ?? null }))
  const railOnly = eventRows.filter((e) => e.eventType !== "deal_shaky_cleared")
  const clearedRows = eventRows.filter((e) => e.eventType === "deal_shaky_cleared").map((e) => ({ entityId: e.entityId, createdAt: e.createdAt }))
  const lenderRows: CtcLenderRow[] = ((ctcLenders ?? []) as any[]).map((l) => ({ transactionId: l.transaction_id, clearToCloseDate: l.clear_to_close_date ?? null }))
  const agreementRows: AgreementStageRow[] = ((agreements ?? []) as any[]).map((a) => ({ id: a.id, listingId: a.listing_id ?? null }))

  // Second-hop fetches only where a first-hop row demands them (bounded).
  const walkthroughTxIds = [...new Set(railOnly.filter((e) => e.eventType === "walkthrough_outcome" && e.metadata?.outcome === "major_issues").map((e) => e.entityId))]
  const ctcTxIds = [...new Set(lenderRows.map((l) => l.transactionId))]
  const agreementListingIds = [...new Set(agreementRows.map((a) => a.listingId).filter(Boolean))] as string[]
  const trustedScanRows = ((trustedScans ?? []) as any[]).filter((f) => f.verified_at != null || f.confidence === "high")
  const scanDocIds = [...new Set(trustedScanRows.map((f) => f.document_id))]

  const [{ data: shakyTxs }, { data: ctcMilestones }, { data: agreementListings }, { data: scanDocs }] = await Promise.all([
    walkthroughTxIds.length
      ? svc.from("transactions").select("id, deal_shaky").in("id", walkthroughTxIds)
      : Promise.resolve({ data: [] } as any),
    ctcTxIds.length
      ? svc.from("transaction_milestones").select("id, transaction_id, milestone_name, milestone_type, status").in("transaction_id", ctcTxIds).eq("status", "pending").limit(2000)
      : Promise.resolve({ data: [] } as any),
    agreementListingIds.length
      ? svc.from("listings").select("id, lifecycle_stage").in("id", agreementListingIds)
      : Promise.resolve({ data: [] } as any),
    scanDocIds.length
      ? svc.from("documents").select("id, transaction_id").in("id", scanDocIds).not("transaction_id", "is", null)
      : Promise.resolve({ data: [] } as any),
  ])

  const shakyByTx = new Map<string, boolean>(((shakyTxs ?? []) as any[]).map((t) => [t.id, !!t.deal_shaky]))
  const milestoneRows: CtcMilestoneRow[] = ((ctcMilestones ?? []) as any[]).map((m) => ({ id: m.id, transactionId: m.transaction_id ?? null, name: m.milestone_name ?? null, type: m.milestone_type ?? null, status: m.status ?? null }))
  const stageByListing = new Map<string, string | null>(((agreementListings ?? []) as any[]).map((l) => [l.id, l.lifecycle_stage ?? null]))

  // Legal-name candidates: trusted scan → its transaction's contacts.
  const txByScanDoc = new Map<string, string>(((scanDocs ?? []) as any[]).map((d) => [d.id, d.transaction_id]))
  const scanTxIds = [...new Set([...txByScanDoc.values()])]
  let legalNameCandidates: LegalNameCandidate[] = []
  if (scanTxIds.length) {
    const { data: scanTxs } = await svc.from("transactions")
      .select("id, buyer_contact_id, contact_id, seller_contact_id").in("id", scanTxIds)
    const contactIdsByTx = new Map<string, string[]>()
    const allContactIds = new Set<string>()
    for (const t of ((scanTxs ?? []) as any[])) {
      const ids = [...new Set([t.buyer_contact_id, t.contact_id, t.seller_contact_id].filter(Boolean))] as string[]
      contactIdsByTx.set(t.id, ids)
      for (const id of ids) allContactIds.add(id)
    }
    const { data: contactRows } = allContactIds.size
      ? await svc.from("contacts").select("id, first_name, last_name, legal_first_name, legal_last_name").in("id", [...allContactIds]).eq("brokerage_id", brokerageId)
      : { data: [] as any[] }
    const contactById = new Map(((contactRows ?? []) as any[]).map((c) => [c.id, c]))
    legalNameCandidates = trustedScanRows.map((f) => {
      const txId = txByScanDoc.get(f.document_id) ?? null
      let parties: string[] = []
      try {
        const parsed = typeof f.field_value_json === "string" ? JSON.parse(f.field_value_json) : f.field_value_json
        parties = (Array.isArray(parsed) ? parsed : [parsed]).map((x: any) => String(x ?? "")).filter(Boolean)
      } catch {
        if (typeof f.field_value_json === "string" && f.field_value_json.trim()) parties = [f.field_value_json.trim()]
      }
      const contacts = (txId ? (contactIdsByTx.get(txId) ?? []) : [])
        .map((id) => contactById.get(id)).filter(Boolean)
        .map((c: any) => ({ id: c.id, firstName: c.first_name ?? null, lastName: c.last_name ?? null, legalFirst: c.legal_first_name ?? null, legalLast: c.legal_last_name ?? null }))
      return { documentId: f.document_id, transactionId: txId, parties, contacts }
    })
  }

  out.scanned = contractRows.length + offerRows.length + docRows.length + railOnly.length + lenderRows.length + agreementRows.length + legalNameCandidates.length

  const { partyMatchesContact } = await import("@/lib/documents/contact-legal-writeback")
  const breaks: FlowBreak[] = [
    ...detectPacketCompletionGaps(contractRows, packetRows),
    ...detectOfferEsignStampGaps(offerRows),
    ...detectDocumentSignedGaps(docRows, completedEnvelopes),
    ...detectMissingRailTasks(railOnly, taskRows, now),
    ...detectWalkthroughShakyGaps(railOnly, clearedRows, shakyByTx, now),
    ...detectCtcMilestoneGaps(lenderRows, milestoneRows),
    ...detectListingAgreementStageGaps(agreementRows, stageByListing),
    ...detectLegalNameGaps(legalNameCandidates, partyMatchesContact),
  ]
  out.breaks = breaks.length
  if (breaks.length === 0) return out

  // SELF-HEAL with the earned-autonomy ratchet (owner: data flows self-heal
  // like connectors). seed_safe heals silently; probation heals AND reports
  // until the ledger shows it EARNED silence; escalate reaches a human.
  const { classifyFlowRemediation, loadFlowActionStats, recordSelfHeal, FLOW_CONTRACTS, EARNED_AUTONOMY_HEALS } = await import("@/lib/kernel/self-heal-ledger")
  const stats = await loadFlowActionStats(svc)
  const escalated: FlowBreak[] = []
  const probationHealed = new Map<string, number>() // flow → heals to report this scan
  for (const brk of breaks) {
    const decision = classifyFlowRemediation(brk.flow, stats[FLOW_CONTRACTS[brk.flow]?.action ?? ""])
    if (decision.safe && decision.action) {
      const outcome = await runRemediation(svc, brk, decision.action, brokerageId)
      if (outcome === "healed") out.healed++
      await recordSelfHeal(svc, {
        brokerageId, domain: "data_flow", subject: brk.key, action: decision.action,
        outcome: outcome === "escalated" ? "escalated" : outcome,
        detail: { flow: brk.flow, tier: decision.tier, reason: outcome === "escalated" ? "remediation preconditions unresolvable (e.g. no assignable agent) — routed to a human" : decision.reason },
      })
      if (outcome === "healed" && decision.notify) probationHealed.set(brk.flow, (probationHealed.get(brk.flow) ?? 0) + 1)
      if (outcome !== "healed") escalated.push(brk)
    } else {
      escalated.push(brk)
      await recordSelfHeal(svc, {
        brokerageId, domain: "data_flow", subject: brk.key, action: "none",
        outcome: "escalated", detail: { flow: brk.flow, tier: decision.tier, reason: decision.reason },
      })
    }
  }

  const { data: owners } = (escalated.length || probationHealed.size)
    ? await svc.from("users").select("id").eq("brokerage_id", brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(3)
    : { data: [] as any[] }
  const ownerRows = ((owners ?? []) as Array<{ id: string }>)

  // PROBATION REPORTS: the fix already ran; the broker hears about it until
  // the action earns silence. One report per flow per day (never a spam rail).
  for (const [flow, count] of probationHealed) {
    const day = now.toISOString().slice(0, 10)
    const tag = `[SELF_HEAL_PROBATION:${brokerageId}:${flow}:${day}]`
    const { data: dup } = await svc.from("notifications").select("id").ilike("body", `%${tag}%`).limit(1).maybeSingle()
    if (dup) continue
    const contract = FLOW_CONTRACTS[flow]
    const soFar = stats[contract?.action ?? ""]?.healed ?? 0
    for (const u of ownerRows) {
      const { error } = await svc.from("notifications").insert({
        brokerage_id: brokerageId, user_id: u.id, type: "self_heal_report",
        title: "Your OS fixed a data-flow break — reporting while this repair earns autonomy",
        body: `Auto-fixed ${count === 1 ? "" : `${count}× `}${contract?.describes ?? flow}. Nothing needed from you — this repair type reports every fix until it earns full autonomy (${EARNED_AUTONOMY_HEALS} clean repairs, zero failures; ${Math.min(soFar + count, EARNED_AUTONOMY_HEALS)}/${EARNED_AUTONOMY_HEALS} so far). ${tag}`.slice(0, 480),
        priority: "medium", channel: "in_app", is_read: false,
      })
      if (!error) out.reported++
    }
  }

  // ESCALATIONS: only what could NOT self-heal reaches a human (deduped per flow).
  if (escalated.length === 0) return out
  const byFlow = new Map<FlowKind, FlowBreak[]>()
  for (const brk of escalated) byFlow.set(brk.flow, [...(byFlow.get(brk.flow) ?? []), brk])
  for (const [flow, flowBreaks] of byFlow) {
    const tag = `[FLOW_INTEGRITY:${brokerageId}:${flow}]`
    const { data: dup } = await svc.from("notifications").select("id").ilike("body", `%${tag}%`).limit(1).maybeSingle()
    if (dup) continue
    const contract = FLOW_CONTRACTS[flow]
    for (const u of ownerRows) {
      const { error } = await svc.from("notifications").insert({
        brokerage_id: brokerageId, user_id: u.id, type: "flow_integrity",
        title: "A data flow couldn't finish its handoff",
        body: `${flowBreaks.length}× ${contract?.describes ?? flow} — the OS couldn't repair this one safely, so a person needs to look. ${flowBreaks[0]?.detail ?? ""} ${tag}`.slice(0, 480),
        priority: "high", channel: "in_app", is_read: false,
      })
      if (!error) out.notified++
    }
  }
  return out
}

/** Autonomous: every brokerage (rides the deal-health-scan cron). */
export async function runFlowIntegrityAll(svc: Svc): Promise<{ brokerages: number; breaks: number; healed: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(1000)
  let breaks = 0, healed = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runFlowIntegrity(svc, b.id).catch(() => null)
    if (r) { breaks += r.breaks; healed += r.healed }
  }
  return { brokerages: (brokerages ?? []).length, breaks, healed }
}
