// lib/commission/closing-verification.ts — THE CLOSING VERIFICATION: FIVE LAYERS, AND THE AGENT'S ATTESTATION
// (wave 145, lane 145C; owner rulings 6 and 7, 2026-10-27).
//
// Owner, verbatim (ruling 6): "…maybe go by the agent/team agreements and ask at closing if anything changed?"
// Ruling 7: at closing compare SIGNED AGREEMENTS → CURRENT EFFECTIVE TERMS → OFFER/COUNTER/ADDENDA → SETTLEMENT DOCUMENTS →
// WATERFALL; ask the agent / authorized parties whether any executed change is unrecorded; on yes, obtain the executed evidence
// and rerun. A conversational statement never overwrites an executed agreement or an immutable ledger entry.
//
// SURVIVORS (CLAUDE.md §1) — this module READS them and writes ONE thing:
//   1 signed agreements      lib/commission/agreement-terms.ts loadAgentAgreementAsOf (the executed agent agreement in force,
//                            m858), the deal's listing / buyer-broker agreements, the referral agreement (m860)
//   2 current effective terms the version in force + its governance (verified against the executed agreement?) and the
//                            client-agreement fees (lib/commission/client-agreement-fees.ts)
//   3 offer/counter/addenda  lib/offers/governing-terms.ts governingContractTerms (the ONE reader)
//   4 settlement documents   the closing-terms comparison rows lib/transactions/closing-compliance.ts writes
//                            (transaction_compliance_log closing_terms.*)
//   5 waterfall              the latest commission_calculations row (engine_inputs — which agreement version priced it, when)
// THE ONE WRITE: the attestation is a row in transaction_compliance_log — THE verdict survivor the compliance tab,
// canProceedToClosingPrep and runFinalComplianceCheck already read (check_type `closing_verification.unrecorded_changes`):
//   · asked     → status 'pending', BLOCKING (ensureClosingAttestationAsked — the CDA submit door asks it);
//   · "no"      → 'pass' with who / when / the five-layer digest it was given on (resolution_notes);
//   · "yes"     → 'fail', BLOCKING, the agent's description as the reason and the instruction: record the EXECUTED evidence
//                 (the addendum door, the agent-agreement amendment, the client-fee amendment, the referral agreement), then
//                 attest again. The answer itself changes NOTHING else — never a term, an agreement or a ledger row.
//   · an executed change recorded after a "no" RE-OPENS it (reopenClosingAttestation — called by the addendum consequences).
// Ledgered (LAW 5); a "yes" notifies the brokerage's admins.

import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import type { AgreementActor } from "@/lib/agreements/agent-agreements"
// the layer vocabulary and the pure evaluation live in ./closing-verification-core (no I/O); this module reads and writes
import { evaluateClosingVerification, type ClosingVerificationFacts, type VerificationLayer } from "./closing-verification-core"

type Db = { from: (t: string) => any }

export const CLOSING_ATTESTATION_CHECK_TYPE = "closing_verification.unrecorded_changes"
const ATTESTATION_LABEL = "Closing: no executed change (agreement, addendum, fee) is unrecorded — confirmed by the agent"

export const CLOSING_ATTESTATION_ANSWERS = ["no_unrecorded_change", "unrecorded_change_reported"] as const
export type ClosingAttestationAnswer = (typeof CLOSING_ATTESTATION_ANSWERS)[number]

// ─── The loader ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Build the five layers for one deal (tenant-pinned; every refused read becomes an `unreadable` layer, never "consistent"). */
export async function buildClosingVerification(
  db: Db,
  brokerageId: string,
  transactionId: string,
): Promise<{ ok: true; layers: VerificationLayer[]; digest: string; findingsCount: number } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no_tenant" }
  const { data: txn, error: tErr } = await db.from("transactions").select("id, agent_id, deal_type, listing_id, buyer_contact_id, contact_id, seller_contact_id, close_date, estimated_close_date, contract_date").eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (tErr) return { ok: false, error: `transaction_read_refused: ${tErr.message}` }
  if (!txn) return { ok: false, error: "transaction_not_found" }
  const t = txn as Record<string, any>

  const facts: ClosingVerificationFacts = {
    agentAgreement: null,
    clientAgreements: { readable: true, listing: [], buyer: [], dealType: (t.deal_type as string | null) ?? null },
    referral: { readable: true, applies: false, agreementOnRecord: false, detail: null },
    clientFees: { readable: true, available: true, findings: [], settling: 0 },
    contract: { readable: true, governingVersion: null, superseded: 0, latestExecutedAt: null, addenda: 0, reason: null },
    settlement: { readable: true, openFail: 0, openReview: 0, checked: 0 },
    waterfall: { readable: true, calculatedAt: null, versionId: null, asOf: null, governance: null },
  }

  // 1/2 · the agent agreement in force on the deal's date
  if (t.agent_id) {
    try {
      const { agreementAsOf, loadAgentAgreementAsOf } = await import("./agreement-terms")
      const asOf = agreementAsOf(t, new Date().toISOString().slice(0, 10))
      const a = await loadAgentAgreementAsOf(db as never, { brokerageId, agentId: t.agent_id, asOf })
      facts.agentAgreement = {
        readable: true, signedAgreementId: a.signedAgreement?.id ?? null, effectiveDate: a.signedAgreement?.effectiveDate ?? null, governance: a.governance ?? null,
        versionId: a.versionId, effectiveFrom: a.effectiveFrom, mismatches: a.signedFieldMismatches.length, findings: a.findings,
      }
    } catch (e) {
      facts.agentAgreement = { readable: false, signedAgreementId: null, effectiveDate: null, governance: null, versionId: null, effectiveFrom: null, mismatches: 0, findings: [e instanceof Error ? e.message : String(e)] }
    }
  }

  // 1 · client agreements
  if (t.listing_id) {
    const { data, error } = await db.from("listing_agreements").select("id, esign_status, fully_executed_at").eq("brokerage_id", brokerageId).eq("listing_id", t.listing_id)
    if (error) facts.clientAgreements.readable = false
    else facts.clientAgreements.listing = ((data ?? []) as Array<Record<string, any>>).map((r) => ({ id: String(r.id), executed: ["fully_signed", "fully_executed", "compliance_pending", "compliance_approved"].includes(String(r.esign_status ?? "")) || !!r.fully_executed_at }))
  }
  if (t.buyer_contact_id) {
    const { data, error } = await db.from("buyer_broker_agreements").select("id, status, signed_at").eq("brokerage_id", brokerageId).eq("buyer_contact_id", t.buyer_contact_id)
    if (error) facts.clientAgreements.readable = false
    else facts.clientAgreements.buyer = ((data ?? []) as Array<Record<string, any>>).map((r) => ({ id: String(r.id), executed: !!r.signed_at && r.status !== "draft" && r.status !== "pending_signature" }))
  }

  // 1 · the referral that pays on this deal (linked, else open for its contacts) and its executed agreement
  {
    const contactIds = [t.contact_id, t.buyer_contact_id, t.seller_contact_id].filter((x): x is string => typeof x === "string")
    const { data: linked, error: lErr } = await db.from("referrals").select("*").eq("brokerage_id", brokerageId).eq("transaction_id", transactionId)
    let rows = (linked ?? []) as Array<Record<string, any>>
    if (lErr) facts.referral.readable = false
    else if (rows.length === 0 && contactIds.length > 0) {
      const { data: open, error: oErr } = await db.from("referrals").select("*").eq("brokerage_id", brokerageId).in("referred_contact_id", contactIds).is("transaction_id", null)
      if (oErr) facts.referral.readable = false
      else rows = ((open ?? []) as Array<Record<string, any>>).filter((r) => r.status !== "lost" && (r.referring_agent_id || r.partner_id))
    }
    if (facts.referral.readable && rows.length > 0) {
      const r = rows[0]
      let partnerDoc = false
      if (r.partner_id) {
        const { data: p, error: pErr } = await db.from("referral_partners").select("*").eq("brokerage_id", brokerageId).eq("id", r.partner_id).maybeSingle()
        if (pErr) facts.referral.readable = false
        partnerDoc = !!(p as Record<string, unknown> | null)?.agreement_document_id
      }
      const own = !!r.referral_agreement_document_id
      facts.referral.applies = true
      facts.referral.agreementOnRecord = own || partnerDoc
      facts.referral.detail = own ? `executed referral agreement on record for referral ${r.id}` : partnerDoc ? `the referring partner's standing executed agreement is on record (referral ${r.id})` : `referral ${r.id} applies but no executed referral agreement is on record — the payout holds until it is`
    }
  }

  // 2 · client-agreement fees
  try {
    const { loadClientAgreementFeesForTransaction } = await import("./client-agreement-fees")
    const r = await loadClientAgreementFeesForTransaction(db, brokerageId, transactionId)
    if (!r.ok) facts.clientFees.readable = false
    else {
      facts.clientFees.available = r.available
      facts.clientFees.findings = r.resolution.findings
      facts.clientFees.settling = r.resolution.fees.filter((f) => f.settlesAsOwnLine).length
    }
  } catch { facts.clientFees.readable = false }

  // 3 · the governing contract terms
  try {
    const { governingContractTerms } = await import("@/lib/offers/governing-terms")
    const g = await governingContractTerms(db as never, brokerageId, { transactionId })
    if (!g.ok) { facts.contract.readable = false; facts.contract.reason = g.reason }
    else {
      const gv = g.governing.governingVersion
      facts.contract.governingVersion = gv ? `${gv.source} v${gv.versionNo}` : null
      // governing.conflicts is SUPERSESSION history (an earlier executed value a later one replaced — the rule working), not a
      // contradiction: it is reported as a fact; an undecidable contradiction is the closing comparison's own verdict (layer 4)
      facts.contract.superseded = (g.governing.conflicts ?? []).length
      const executed = g.governing.versions.filter((v) => v.status === "executed" && v.executedAt)
      facts.contract.latestExecutedAt = executed.map((v) => v.executedAt as string).sort().pop() ?? null
      facts.contract.addenda = executed.filter((v) => v.source === "addendum" || v.source === "amendment").length
    }
  } catch (e) { facts.contract.readable = false; facts.contract.reason = e instanceof Error ? e.message : String(e) }

  // 4 · the closing comparison rows
  {
    const { data, error } = await db.from("transaction_compliance_log").select("check_type, status").eq("brokerage_id", brokerageId).eq("transaction_id", transactionId)
    if (error) facts.settlement.readable = false
    else {
      const rows = ((data ?? []) as Array<{ check_type: string; status: string }>).filter((r) => r.check_type.startsWith("closing_terms."))
      facts.settlement.checked = rows.length
      facts.settlement.openFail = rows.filter((r) => r.status === "fail").length
      facts.settlement.openReview = rows.filter((r) => r.status === "needs_review").length
    }
  }

  // 5 · the waterfall that priced it
  {
    const { data, error } = await db.from("commission_calculations").select("calculated_at, engine_inputs").eq("brokerage_id", brokerageId).eq("transaction_id", transactionId).order("calculated_at", { ascending: false }).limit(1)
    if (error) facts.waterfall.readable = false
    else {
      const c = ((data ?? [])[0] ?? null) as { calculated_at?: string | null; engine_inputs?: Record<string, any> | null } | null
      if (c) {
        facts.waterfall.calculatedAt = c.calculated_at ?? null
        facts.waterfall.versionId = c.engine_inputs?.agreement?.version_id ?? null
        facts.waterfall.asOf = c.engine_inputs?.agreement?.as_of ?? null
        facts.waterfall.governance = c.engine_inputs?.agreement?.governance ?? null
      }
    }
  }

  return { ok: true, ...evaluateClosingVerification(facts) }
}

// ─── The attestation (the ONE write) ──────────────────────────────────────────────────────────────────────────────────

interface LogRow { id: string; status: string; is_blocking: boolean | null; resolution_notes: string | null; failure_reason: string | null }

async function readAttestationRow(db: Db, brokerageId: string, transactionId: string): Promise<{ ok: true; row: LogRow | null } | { ok: false; error: string }> {
  const { data, error } = await db.from("transaction_compliance_log").select("id, status, is_blocking, resolution_notes, failure_reason").eq("brokerage_id", brokerageId).eq("transaction_id", transactionId).eq("check_type", CLOSING_ATTESTATION_CHECK_TYPE).order("created_at", { ascending: false }).limit(1)
  if (error) return { ok: false, error: `attestation_read_refused: ${error.message}` }
  return { ok: true, row: ((data ?? [])[0] ?? null) as LogRow | null }
}

/** ASK: the attestation row exists, pending and BLOCKING, until the agent answers. Idempotent (an existing row is left alone). */
export async function ensureClosingAttestationAsked(db: Db, input: { brokerageId: string; transactionId: string }): Promise<{ ok: true; status: string; asked: boolean } | { ok: false; error: string }> {
  const cur = await readAttestationRow(db, input.brokerageId, input.transactionId)
  if (!cur.ok) return cur
  if (cur.row) return { ok: true, status: cur.row.status, asked: false }
  const { data, error } = await db.from("transaction_compliance_log").insert({
    brokerage_id: input.brokerageId, transaction_id: input.transactionId, check_type: CLOSING_ATTESTATION_CHECK_TYPE, check_label: ATTESTATION_LABEL,
    status: "pending", is_blocking: true,
    failure_reason: "Before the CDA is submitted, the agent confirms whether any executed change (an agreement amendment, a contract addendum, a fee change) has not been recorded yet.",
  }).select("id")
  if (error) return { ok: false, error: `attestation_ask_refused: ${error.message}` }
  if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "attestation_not_asked" }
  return { ok: true, status: "pending", asked: true }
}

/** RE-OPEN after an executed change was recorded: an earlier "nothing unrecorded" no longer covers it. Counted; never deletes. */
export async function reopenClosingAttestation(db: Db, input: { brokerageId: string; transactionId: string; why: string }): Promise<{ ok: true; reopened: boolean } | { ok: false; error: string }> {
  const cur = await readAttestationRow(db, input.brokerageId, input.transactionId)
  if (!cur.ok) return cur
  if (!cur.row || cur.row.status !== "pass") return { ok: true, reopened: false }
  const { data, error } = await db.from("transaction_compliance_log").update({
    status: "pending", is_blocking: true, failure_reason: `Attest again: ${input.why}.`.slice(0, 1000), updated_at: new Date().toISOString(),
  }).eq("id", cur.row.id).eq("brokerage_id", input.brokerageId).eq("status", "pass").select("id")
  if (error) return { ok: false, error: `attestation_reopen_refused: ${error.message}` }
  return { ok: true, reopened: ((data ?? []) as unknown[]).length === 1 }
}

/** PURE — may this actor answer for the deal? Its agent (any side), its transaction coordinator, or the tenant's staff roster. */
export function mayAttestClosing(actor: Pick<AgreementActor, "agentId" | "userId" | "userType">, deal: { agentIds: Array<string | null | undefined>; coordinatorUserId: string | null }): boolean {
  if (TENANT_ADMIN_USER_TYPES.has(String(actor.userType ?? "").toLowerCase()) || String(actor.userType ?? "").toLowerCase() === "compliance_officer") return true
  if (actor.agentId && deal.agentIds.includes(actor.agentId)) return true
  return !!deal.coordinatorUserId && deal.coordinatorUserId === actor.userId
}

/**
 * ANSWER the closing question. "no_unrecorded_change" → pass (who, when, the digest of the five layers it was given on);
 * "unrecorded_change_reported" → fail, BLOCKING, with the description and the instruction to record the executed evidence
 * through its own door — the statement itself changes no term, agreement or ledger row. Ledgered; a "yes" notifies the admins.
 */
export async function recordClosingAttestation(
  db: Db,
  actor: AgreementActor,
  input: { transactionId: string; answer: ClosingAttestationAnswer; description?: string | null },
): Promise<{ ok: true; status: "pass" | "fail"; digest: string } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!(CLOSING_ATTESTATION_ANSWERS as readonly string[]).includes(input.answer)) return { ok: false, error: "answer_invalid" }
  const description = String(input.description ?? "").trim()
  if (input.answer === "unrecorded_change_reported" && description.length < 10) return { ok: false, error: "description_required: say what changed and where the executed paper is (at least 10 characters)" }
  const { data: txn, error: tErr } = await db.from("transactions").select("id, agent_id, buyer_agent_id, seller_agent_id, coordinator_id").eq("id", input.transactionId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (tErr) return { ok: false, error: `transaction_read_refused: ${tErr.message}` }
  if (!txn) return { ok: false, error: "transaction_not_found" }
  const t = txn as Record<string, any>
  let coordinatorUserId: string | null = null
  if (t.coordinator_id) {
    const { data: tc, error: tcErr } = await db.from("transaction_coordinators").select("user_id").eq("id", t.coordinator_id).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (tcErr) return { ok: false, error: `coordinator_read_refused: ${tcErr.message}` }
    coordinatorUserId = (tc as { user_id?: string | null } | null)?.user_id ?? null
  }
  if (!mayAttestClosing(actor, { agentIds: [t.agent_id, t.buyer_agent_id, t.seller_agent_id], coordinatorUserId })) {
    return { ok: false, error: "forbidden: the deal's agent, its transaction coordinator or brokerage staff answer the closing question" }
  }
  const verification = await buildClosingVerification(db, actor.brokerageId, input.transactionId)
  if (!verification.ok) return verification
  const asked = await ensureClosingAttestationAsked(db, { brokerageId: actor.brokerageId, transactionId: input.transactionId })
  if (!asked.ok) return asked
  const cur = await readAttestationRow(db, actor.brokerageId, input.transactionId)
  if (!cur.ok) return cur
  if (!cur.row) return { ok: false, error: "attestation_missing" }

  const now = new Date().toISOString()
  const pass = input.answer === "no_unrecorded_change"
  const patch = pass
    ? { status: "pass", is_blocking: true, failure_reason: null, checked_at: now, checked_by: actor.userId, resolved_at: now, resolved_by: actor.userId,
        resolution_notes: `Attested: no executed change is unrecorded (layers digest ${verification.digest}; ${verification.findingsCount} open finding(s) shown at the time).` }
    : { status: "fail", is_blocking: true, checked_at: now, checked_by: actor.userId, resolved_at: null, resolved_by: null,
        failure_reason: `Reported unrecorded executed change: ${description.slice(0, 600)} — record the executed evidence (contract addendum / agreement amendment / client-fee amendment / referral agreement), then attest again. Nothing was changed by this answer.`,
        resolution_notes: `layers digest ${verification.digest}` }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const res = await withActionLedger<{ ok: boolean; error?: string }>(
    {
      brokerageId: actor.brokerageId, action: pass ? "closing.attestation.no_unrecorded_change" : "closing.attestation.unrecorded_change_reported",
      actor: { type: "user", userId: actor.userId, agentId: actor.agentId }, subject: { type: "transaction", id: input.transactionId, ref: cur.row.id },
      reasonCode: "HUMAN_REQUESTED", reasonDetail: (pass ? "closing attestation: no executed change unrecorded" : `closing attestation: ${description}`).slice(0, 500),
      riskClass: "LEGAL", systemSource: "closing_verification",
      detail: { answer: input.answer, description: description || null, digest: verification.digest, layers: verification.layers.map((l) => ({ key: l.key, status: l.status, findings: l.findings })) },
    },
    async () => {
      const { data, error } = await db.from("transaction_compliance_log").update({ ...patch, updated_at: now }).eq("id", cur.row!.id).eq("brokerage_id", actor.brokerageId).select("id")
      if (error) return { ok: false, error: `attestation_refused: ${error.message}` }
      if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "attestation_not_recorded" }
      return { ok: true }
    },
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: "recorded" } : { status: "failed", outcome: "refused", error: r.error ?? null }),
      replay: (claim) => ({ ok: false, error: `already ${claim.kind === "in_flight" ? "in flight" : "recorded"}` }),
    },
    { client: db as never },
  )
  if (!res.ok) return { ok: false, error: res.error ?? "attestation_not_recorded" }
  if (!pass) {
    try {
      const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
      await notifyBrokerageAdmins(db as never, actor.brokerageId, {
        type: "closing_unrecorded_change", title: "An executed change is not recorded yet — closing is held",
        body: `${description.slice(0, 300)} Obtain the executed evidence and record it; the closing verification reruns and the agent attests again.`,
        entityType: "transaction", entityId: input.transactionId, priority: "high",
      })
    } catch (e) {
      console.error("[closing-verification] admin notice failed:", e instanceof Error ? e.message : String(e))
    }
  }
  return { ok: true, status: pass ? "pass" : "fail", digest: verification.digest }
}

/** The attestation's current state, for the CDA submit gate (a refused read is a refusal — fail closed). */
export async function closingAttestationState(db: Db, input: { brokerageId: string; transactionId: string }): Promise<{ ok: true; status: string | null; reason: string | null } | { ok: false; error: string }> {
  const cur = await readAttestationRow(db, input.brokerageId, input.transactionId)
  if (!cur.ok) return cur
  return { ok: true, status: cur.row?.status ?? null, reason: cur.row?.failure_reason ?? null }
}
