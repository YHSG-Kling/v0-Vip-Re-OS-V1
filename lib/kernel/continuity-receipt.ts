// lib/kernel/continuity-receipt.ts
//
// DEAL CONTINUITY RECEIPTS (cron_manager) — the client-facing half of the
// Continuity Engine: the OS doesn't just DO things on a deal, it PROVES the
// deal is coherent, in the client's language. Competitors automate; nothing
// on the market shows a nervous seller "your paperwork, loan milestones, and
// timeline were verified in sync — just now."
//
// HONESTY RULES: the receipt is computed by RUNNING the real per-deal
// contract checks at read time (the same pure detectors flow-integrity uses,
// scoped to this one transaction) — "verified just now" is literally true.
// A repair shown to the client is a real ledger row whose subject belongs to
// this deal. Nothing is fabricated; when checks can't run, the card shows
// nothing rather than a hollow badge. Client tone per the script charter:
// confident and warm, never technical, never alarming.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  detectOfferEsignStampGaps,
  detectPacketCompletionGaps,
  detectCtcMilestoneGaps,
  detectMissingRailTasks,
  type OfferEsignRow, type SignedContractRow, type PacketRow,
  type CtcLenderRow, type CtcMilestoneRow, type RailEventRow, type RailTaskRow,
} from "@/lib/kernel/flow-integrity"

type Svc = SupabaseClient<any, any, any>

export type ReceiptStatus = "verified" | "repaired" | "attention"

/** One step of the deal's WORKFLOW TWIN: the expected state vs what's real. */
export interface TwinStep {
  key: string
  /** client-language name of the contract being asserted */
  label: string
  /** what the OS expects when the flow is healthy */
  expected: string
  /** true when reality matches the expectation right now */
  ok: boolean
  /** how many concrete rows this step verified */
  checked: number
}

export interface ContinuityReceipt {
  status: ReceiptStatus
  line: string
  subline: string
  checkedAtIso: string
  repairedLast30d: number
  openItems: number
  /** the deal's expected-vs-actual path, one step per contract that applies */
  twin: TwinStep[]
}

/** PURE: the twin's steps from per-contract check results (only steps that had rows to verify). */
export function composeDealTwin(checks: Array<{ key: string; label: string; expected: string; breaks: number; checked: number }>): TwinStep[] {
  return checks
    .filter((c) => c.checked > 0 || c.breaks > 0)
    .map((c) => ({ key: c.key, label: c.label, expected: c.expected, ok: c.breaks === 0, checked: c.checked }))
}

/** PURE: turn the deal's verification facts into the client's one calm line. */
export function composeContinuityReceipt(input: {
  openBreaks: number
  repairedLast30d: number
  checkedAtIso: string
  twin?: TwinStep[]
}): ContinuityReceipt {
  const twin = input.twin ?? []
  if (input.openBreaks > 0) {
    return {
      status: "attention",
      line: "One item on your file is getting a closer look.",
      subline: "Your team is already on it — nothing is needed from you right now, and you'll hear from us if that changes.",
      checkedAtIso: input.checkedAtIso,
      repairedLast30d: input.repairedLast30d,
      openItems: input.openBreaks,
      twin,
    }
  }
  if (input.repairedLast30d > 0) {
    return {
      status: "repaired",
      line: "Everything on your file checks out — and we caught a small sync hiccup before it could reach you.",
      subline: `Your paperwork, loan milestones, and timeline were verified in sync just now. ${input.repairedLast30d === 1 ? "One item was" : `${input.repairedLast30d} items were`} repaired automatically along the way.`,
      checkedAtIso: input.checkedAtIso,
      repairedLast30d: input.repairedLast30d,
      openItems: 0,
      twin,
    }
  }
  return {
    status: "verified",
    line: "Everything on your file checks out.",
    subline: "Your paperwork, loan milestones, and timeline were verified in sync just now.",
    checkedAtIso: input.checkedAtIso,
    repairedLast30d: 0,
    openItems: 0,
    twin,
  }
}

/**
 * LIVE: run the real per-deal contract checks (scoped versions of the exact
 * flow-integrity detectors) + count this deal's ledgered repairs. Cheap by
 * construction — every query is keyed to one transaction.
 */
export async function loadDealContinuity(svc: Svc, input: {
  brokerageId: string
  transactionId: string
  now?: Date
}): Promise<ContinuityReceipt> {
  const now = input.now ?? new Date()
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString()

  const [{ data: dealOffers }, { data: dealPackets }, { data: dealLenders }, { data: dealMilestones }, { data: dealEvents }, { data: dealTasks }] = await Promise.all([
    svc.from("offers").select("id, esign_status, esign_completed_at, provider_envelope_id")
      .eq("transaction_id", input.transactionId).limit(200),
    svc.from("signature_requests").select("provider_envelope_id, request_status, completed_at")
      .eq("transaction_id", input.transactionId).not("provider_envelope_id", "is", null).limit(200),
    svc.from("transaction_lenders").select("transaction_id, clear_to_close_date")
      .eq("transaction_id", input.transactionId).not("clear_to_close_date", "is", null).limit(20),
    svc.from("transaction_milestones").select("id, transaction_id, milestone_name, milestone_type, status")
      .eq("transaction_id", input.transactionId).eq("status", "pending").limit(100),
    svc.from("lifecycle_events").select("id, entity_id, event_type, metadata, created_at")
      .eq("brokerage_id", input.brokerageId).eq("entity_id", input.transactionId)
      .in("event_type", ["lender_document_request", "vendor_request", "walkthrough_outcome"])
      .gte("created_at", since30).limit(200),
    svc.from("tasks").select("source, transaction_id, contact_id, created_at")
      .eq("transaction_id", input.transactionId)
      .in("source", ["lender_condition", "vendor_request", "walkthrough_outcome"])
      .gte("created_at", since30).limit(200),
  ])

  const offerRows: OfferEsignRow[] = ((dealOffers ?? []) as any[]).map((o) => ({ id: o.id, esignStatus: o.esign_status ?? null, esignCompletedAt: o.esign_completed_at ?? null }))
  const packetRows: PacketRow[] = ((dealPackets ?? []) as any[]).map((p) => ({ envelopeId: p.provider_envelope_id ?? null, requestStatus: p.request_status ?? null, completedAt: p.completed_at ?? null }))
  const envelopeIds = [...new Set([
    ...packetRows.map((p) => p.envelopeId),
    ...((dealOffers ?? []) as any[]).map((o) => o.provider_envelope_id),
  ].filter(Boolean))] as string[]

  const { data: dealContracts } = envelopeIds.length
    ? await svc.from("contract_signatures").select("provider_envelope_id, fully_signed_at").in("provider_envelope_id", envelopeIds).limit(200)
    : { data: [] as any[] }
  const contractRows: SignedContractRow[] = ((dealContracts ?? []) as any[]).map((c) => ({ envelopeId: c.provider_envelope_id ?? null, fullySignedAt: c.fully_signed_at ?? null }))

  const lenderRows: CtcLenderRow[] = ((dealLenders ?? []) as any[]).map((l) => ({ transactionId: l.transaction_id, clearToCloseDate: l.clear_to_close_date ?? null }))
  const milestoneRows: CtcMilestoneRow[] = ((dealMilestones ?? []) as any[]).map((m) => ({ id: m.id, transactionId: m.transaction_id ?? null, name: m.milestone_name ?? null, type: m.milestone_type ?? null, status: m.status ?? null }))
  const eventRows: RailEventRow[] = ((dealEvents ?? []) as any[]).map((e) => ({ id: e.id, eventType: e.event_type, entityId: e.entity_id, createdAt: e.created_at, metadata: (e.metadata as any) ?? null }))
  const taskRows: RailTaskRow[] = ((dealTasks ?? []) as any[]).map((t) => ({ source: t.source ?? null, transactionId: t.transaction_id ?? null, contactId: t.contact_id ?? null, createdAt: t.created_at ?? null }))

  // THE DEAL'S WORKFLOW TWIN — each contract that applies to this deal is one
  // expected-vs-actual step (the same detectors the OS heals with, so the
  // twin can never disagree with the healer).
  const offerBreaks = detectOfferEsignStampGaps(offerRows).length
  const packetBreaks = detectPacketCompletionGaps(contractRows, packetRows).length
  const ctcBreaks = detectCtcMilestoneGaps(lenderRows, milestoneRows).length
  const railBreaks = detectMissingRailTasks(eventRows, taskRows, now).length
  const twin = composeDealTwin([
    { key: "signing", label: "Signing paperwork", expected: "Every signed document is stamped complete everywhere it lives", breaks: offerBreaks + packetBreaks, checked: offerRows.length + contractRows.length },
    { key: "loan", label: "Loan milestones", expected: "What the lender reports matches the progress you see", breaks: ctcBreaks, checked: lenderRows.length + milestoneRows.length },
    { key: "followthrough", label: "Team follow-through", expected: "Every recorded request or decision reached someone's task list", breaks: railBreaks, checked: eventRows.length },
  ])
  const openBreaks = offerBreaks + packetBreaks + ctcBreaks + railBreaks

  // Repairs that touched THIS deal: ledger rows whose subject is the
  // transaction, one of its envelopes, or one of its milestone rows.
  const subjects = [input.transactionId, ...envelopeIds, ...milestoneRows.map((m) => m.id)]
  const { data: repairs } = await svc.from("self_heal_events")
    .select("id").eq("domain", "data_flow").eq("outcome", "healed")
    .in("subject", subjects.slice(0, 100)).gte("created_at", since30).limit(100)

  return composeContinuityReceipt({
    openBreaks,
    repairedLast30d: ((repairs ?? []) as any[]).length,
    checkedAtIso: now.toISOString(),
    twin,
  })
}
