// lib/offers/governing-terms-consequences.ts — WHAT AN EXECUTED ADDENDUM / AMENDMENT SETS IN MOTION
// (wave 145, lane 145C; owner ruling 8, 2026-10-27; cross-lane contract C7).
//
// Owner, verbatim: "There can be executed addendums after the transaction has been created which can change a term/price etc."
// Required: new executed addendum · effective date · modified terms · affected financial obligations · revised authoritative
// contract terms · broker/TC notification · compliance re-review · settlement reconciliation · CDA correction. Versioned
// governing terms + approved ledger adjustments; never silently mutate signed documents; never freeze terms so no legitimate
// change can be recorded.
//
// SURVIVORS (CLAUDE.md §1; contract C7 names them):
//   · THE VERSIONED RECORD: contract_term_versions (m797) written ONLY through lib/offers/governing-terms.ts
//     recordContractTermsVersion (an executed version needs a stored document showing both parties' signatures). The door is
//     app/actions/buyer-offer/record-contract-addendum.ts. THIS module runs right after that recorder lands an EXECUTED
//     addendum / amendment — it never writes the version itself and never edits a signed document.
//   · the operational transaction row (transactions.purchase_price / closing_cost_contribution / earnest_money — the columns the
//     commission engine and the deal surfaces read) is brought into line with the governing terms by a counted, ledgered update
//     (the executed instrument is the authority; the row is its mirror). A date term is NOT mirrored: the TC confirms the schedule.
//   · compliance re-review: lib/transactions/closing-compliance.ts runClosingCompliance (trigger 'contract_addendum'), and the
//     closing attestation is re-opened (lib/commission/closing-verification.ts) — an earlier "nothing unrecorded" no longer
//     covers this change.
//   · settlement reconciliation: the posted commission is NEVER re-written here. When the money changed and the deal is
//     already posted / finalized, the finance admins are told the ledger correction path
//     (lib/kernel/financial.ts correctCommissionDistribution); otherwise the next calculation prices the governing terms.
//   · CDA correction: lib/commission/cda-correction.ts reopenCdaForCorrection.
//   · notification: the brokerage's admins + the deal's transaction coordinator + the deal's agent.
//   · evidence: one withActionLedger row naming the version, the document, the changed terms and every consequence; a
//     KernelEvent.COMMISSION_UPDATED (audit) when money moved.
//
// Every step is independent and best-effort AFTER the version is recorded (a recorded executed change is never undone because
// a notice failed); every step's outcome is RETURNED, so the door can show what happened and what still needs a human.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { UnresolvedTermConflict } from "./governing-terms-rule"

type Svc = SupabaseClient<any, any, any>

/** The financial obligations a governing term drives (what a change to it reaches). */
export type FinancialObligation =
  | "gross_commission" | "seller_net" | "settlement_lines" | "cda" | "cap_contribution" | "referral_fee"
  | "seller_credit" | "earnest_money_deposit" | "agreement_as_of_date" | "closing_schedule" | "title_settlement" | "contract_deadlines"

const TERM_OBLIGATIONS: Readonly<Record<string, readonly FinancialObligation[]>> = {
  offer_price: ["gross_commission", "seller_net", "settlement_lines", "cda", "cap_contribution", "referral_fee"],
  purchase_price: ["gross_commission", "seller_net", "settlement_lines", "cda", "cap_contribution", "referral_fee"],
  buyer_agent_commission_pct: ["gross_commission", "settlement_lines", "cda", "cap_contribution"],
  buyer_agent_commission_flat: ["gross_commission", "settlement_lines", "cda", "cap_contribution"],
  commission_payer: ["settlement_lines", "cda"],
  closing_cost_contribution: ["seller_credit", "seller_net", "settlement_lines"],
  earnest_money: ["earnest_money_deposit", "settlement_lines"],
  // the deal's DATE decides which agent agreement and which cap cycle price it (lib/commission/agreement-terms.ts agreementAsOf)
  closing_date: ["closing_schedule", "agreement_as_of_date", "cap_contribution"],
  title_policy_payer: ["title_settlement", "settlement_lines"],
  title_company: ["title_settlement"],
  // WAVE 152 (lane 152E): the governed terms the vocabulary gained. A repair credit comes out of the seller's proceeds (money —
  // the CDA / ledger path follows); a holdback is escrowed by the settlement agent; the property and the parties are what the
  // title commitment and the Closing Disclosure must name (a wrong party is a settlement correction, not money).
  repair_credit: ["seller_credit", "seller_net", "settlement_lines"],
  repair_holdback: ["settlement_lines", "title_settlement"],
  property_address: ["title_settlement", "settlement_lines"],
  buyer_names: ["title_settlement", "settlement_lines"],
  seller_names: ["title_settlement", "settlement_lines"],
  // (a contingency PERIOD is a non-financial term: financialImpactOf lists it under nonFinancialTerms + contract_deadlines, and
  //  wave 151 (lane 151K) re-derives its deadline date below — "updated price / credits / deadlines")
}

/** The governing term keys that move money already posted / authorised (a CDA re-open and a ledger reconciliation follow). */
const MONEY_OBLIGATIONS = new Set<FinancialObligation>(["gross_commission", "seller_net", "cda", "cap_contribution", "referral_fee", "seller_credit"])

/**
 * governing term → the transaction column that mirrors it. Money terms, and (wave 151, lane 151K) the NUMERIC contract-term
 * columns an offer, a counter and the transaction all carry under the same name (lib/transactions/contract-terms.ts
 * CONTRACT_TERM_COLUMNS) — the contingency PERIODS among them re-derive the deal's deadline dates below. The closing DATE is
 * not mirrored here: it moves ONLY through the governed closing-date writer (lib/transactions/closing-dates.ts
 * applyClosingDateChange, kind executed_amendment, the executed document as its reference).
 */
const TRANSACTION_MIRROR: Readonly<Record<string, string>> = {
  offer_price: "purchase_price",
  closing_cost_contribution: "closing_cost_contribution",
  earnest_money: "earnest_money",
  inspection_period_days: "inspection_period_days",
  appraisal_contingency_days: "appraisal_contingency_days",
  financing_contingency_days: "financing_contingency_days",
  due_diligence_fee: "due_diligence_fee",
  down_payment_amount: "down_payment_amount",
  down_payment_percent: "down_payment_percent",
  escalation_cap: "escalation_cap",
  appraisal_gap: "appraisal_gap",
}

/** The contingency-period terms whose change re-derives a deadline date column (the offer bridge's one arithmetic). */
const DEADLINE_PERIOD_TERMS = ["inspection_period_days", "appraisal_contingency_days", "financing_contingency_days"] as const

export interface FinancialImpact {
  obligations: FinancialObligation[]
  moneyMoved: boolean
  /** Changed terms with no financial reach (contingency days, possession …) — the deadlines rail reads them. */
  nonFinancialTerms: string[]
}

/** PURE — which financial obligations a set of changed governing terms reaches. */
// module-private: afterExecutedContractChange returns it as `impact` (proved there — scripts/agreement-governance-guard.ts §F)
function financialImpactOf(changedTerms: Record<string, unknown>): FinancialImpact {
  const obligations = new Set<FinancialObligation>()
  const nonFinancialTerms: string[] = []
  for (const k of Object.keys(changedTerms)) {
    const o = TERM_OBLIGATIONS[k]
    if (o) o.forEach((x) => obligations.add(x))
    else { nonFinancialTerms.push(k); obligations.add("contract_deadlines") }
  }
  const list = [...obligations].sort()
  return { obligations: list, moneyMoved: list.some((o) => MONEY_OBLIGATIONS.has(o)), nonFinancialTerms }
}

export interface ExecutedChangeInput {
  brokerageId: string
  transactionId: string | null
  rootOfferId: string | null
  versionNo: number
  source: "addendum" | "amendment"
  /** ONLY the terms the executed instrument changes (canonical keys; an explicit null strikes a term). */
  changedTerms: Record<string, unknown>
  documentId: string
  executedOn: string
  /** The date the change takes effect, when the instrument states one apart from its execution. */
  effectiveOn?: string | null
  /** users.id of the person who recorded it. */
  recordedBy: string | null
  /**
   * WAVE 151 (lane 151K): the changed terms this instrument and another executed instrument of the same source now contradict
   * each other on with nothing signed to order them (the ONE reader's `unresolved`, filtered to this instrument's terms). Each
   * one is ESCALATED for review — a blocking compliance row and a notice — never resolved here.
   */
  unresolved?: UnresolvedTermConflict[]
  /** WAVE 151 (lane 151K): changed terms recorded without a page / field / quote and without a document extraction naming them. */
  termEvidenceUnlocated?: string[]
  /** WAVE 151 (lane 151K): the ONE reader refused after the record — said, so "no conflict" is never read off a refused read. */
  governingReadFault?: string | null
}

export interface ExecutedChangeConsequences {
  impact: FinancialImpact
  transactionMirror: { updated: string[]; skipped: string | null }
  notified: number
  complianceReReview: { ran: boolean; openBlocking: number; reason: string | null }
  closingAttestationReopened: boolean
  settlement: { status: "no_transaction" | "nothing_posted" | "recalculate_before_posting" | "ledger_correction_required" | "no_money_change"; detail: string }
  cda: { outcome: string; resendToTitle: boolean; detail: string } | null
  /**
   * WAVE 151 (lane 151K): an executed instrument that moves the CLOSING DATE moves the contract's deadline through the governed
   * writer (closing-dates.ts applyClosingDateChange, kind executed_amendment, the document as reference) — contractual, anticipated
   * and actual stay distinct facts. null = the instrument did not change the closing date.
   */
  closingDate: { recorded: boolean; detail: string } | null
  /** WAVE 151 (lane 151K): a changed contingency PERIOD re-derives its deadline date on the deal (the offer bridge's arithmetic). */
  deadlines: { updated: string[]; detail: string } | null
  /** WAVE 151 (lane 151K): the review a person owes — the unresolved contradictions, and the terms recorded without located evidence. */
  review: { unresolved: UnresolvedTermConflict[]; escalated: boolean; unlocatedEvidence: string[] }
  errors: string[]
}

/** Deps a proof can replace (each defaults to the real survivor). */
export interface ConsequenceDeps {
  runClosingCompliance?: (svc: Svc, input: { transactionId: string; brokerageId: string; trigger: "contract_addendum"; actorUserId?: string | null; changedTerms?: string[]; unresolved?: UnresolvedTermConflict[] }) => Promise<{ ran: boolean; openBlocking: number; reason: string | null }>
}

/**
 * Run every consequence of ONE executed addendum / amendment that recordContractTermsVersion just recorded. Never throws.
 */
export async function afterExecutedContractChange(svc: Svc, input: ExecutedChangeInput, deps: ConsequenceDeps = {}): Promise<ExecutedChangeConsequences> {
  const impact = financialImpactOf(input.changedTerms)
  const unresolved = input.unresolved ?? []
  const out: ExecutedChangeConsequences = {
    impact, transactionMirror: { updated: [], skipped: null }, notified: 0, complianceReReview: { ran: false, openBlocking: 0, reason: null },
    closingAttestationReopened: false, settlement: { status: "no_transaction", detail: "the contract has not become a transaction yet — the transaction is created on the governing terms" }, cda: null,
    closingDate: null, deadlines: null, review: { unresolved, escalated: false, unlocatedEvidence: [...(input.termEvidenceUnlocated ?? [])] }, errors: [],
  }
  const label = `${input.source} ${input.versionNo} (executed ${input.executedOn}${input.effectiveOn && input.effectiveOn !== input.executedOn ? `, effective ${input.effectiveOn}` : ""})`
  const changed = Object.keys(input.changedTerms).join(", ")
  // WAVE 151 (lane 151K): a term two executed instruments contradict each other on has NO governing value — it is not mirrored
  // onto the deal, not re-derived, not priced; it waits for the person the escalation below reaches.
  const disputed = new Set(unresolved.map((u) => u.key as string))
  if (input.governingReadFault) out.errors.push(`the governing terms could not be re-read after the record (${input.governingReadFault}) — whether this instrument contradicts another executed one is NOT known; review the chain`)
  for (const k of out.review.unlocatedEvidence) out.errors.push(`${k} was recorded without a page / field reference on the executed document and no extraction of the document names it — add where it was read (the version stands; the evidence is the person's reading)`)
  let tx: Record<string, any> | null = null

  if (input.transactionId) {
    // 1 · the operational row mirrors the governing money terms (counted, tenant-pinned, before-values kept for the ledger)
    try {
      const { data, error } = await svc.from("transactions").select("id, agent_id, coordinator_id, purchase_price, closing_cost_contribution, earnest_money, commission_finalized_at, contract_date, inspection_period_days, appraisal_contingency_days, financing_contingency_days, due_diligence_fee, down_payment_amount, down_payment_percent, escalation_cap, appraisal_gap, inspection_deadline, appraisal_deadline, financing_deadline").eq("id", input.transactionId).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (error) throw new Error(`transaction read refused: ${error.message}`)
      tx = (data ?? null) as Record<string, any> | null
      if (!tx) out.transactionMirror.skipped = "the transaction is not in this brokerage"
      else {
        const patch: Record<string, unknown> = {}
        for (const [term, column] of Object.entries(TRANSACTION_MIRROR)) {
          if (!(term in input.changedTerms) || disputed.has(term)) continue
          const v = input.changedTerms[term]
          const n = v === null ? null : Number(v)
          if (n !== null && !Number.isFinite(n)) continue
          if (n === (tx[column] === null || tx[column] === undefined ? null : Number(tx[column]))) continue
          patch[column] = n
        }
        // WAVE 151 (lane 151K — "updated … deadlines"): a changed contingency PERIOD re-derives its deadline DATE from the contract
        // date through the offer bridge's one arithmetic (deriveContractDeadlines); a period nobody changed keeps its date.
        const periodsChanged = DEADLINE_PERIOD_TERMS.filter((t) => t in input.changedTerms && !disputed.has(t))
        if (periodsChanged.length > 0) {
          const { deriveContractDeadlines } = await import("@/lib/transactions/offer-bridge")
          const days = (t: (typeof DEADLINE_PERIOD_TERMS)[number]) => { const v = t in input.changedTerms ? input.changedTerms[t] : tx![t]; const n = v === null || v === undefined ? null : Number(v); return n !== null && Number.isFinite(n) ? n : null }
          const d = deriveContractDeadlines({ contractDate: tx.contract_date ?? null, inspectionPeriodDays: days("inspection_period_days"), appraisalContingencyDays: days("appraisal_contingency_days"), financingContingencyDays: days("financing_contingency_days") })
          const dates: Record<(typeof DEADLINE_PERIOD_TERMS)[number], [string, string | null]> = { inspection_period_days: ["inspection_deadline", d.inspectionDeadline], appraisal_contingency_days: ["appraisal_deadline", d.appraisalDeadline], financing_contingency_days: ["financing_deadline", d.financingDeadline] }
          const moved: string[] = []
          for (const t of periodsChanged) { const [col, date] = dates[t]; if (date && date !== tx[col]) { patch[col] = date; moved.push(col) } }
          out.deadlines = { updated: moved, detail: tx.contract_date ? (moved.length ? `${moved.join(", ")} re-derived from the contract date ${String(tx.contract_date).slice(0, 10)} and the executed period(s)` : "the executed period(s) leave the deadline date(s) as they are") : "the deal has no contract date, so the changed period(s) cannot be turned into a deadline date — the TC confirms the dates" }
        }
        if (Object.keys(patch).length > 0) {
          const { data: upd, error: uErr } = await svc.from("transactions").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", input.transactionId).eq("brokerage_id", input.brokerageId).select("id")
          if (uErr) throw new Error(`transaction mirror refused: ${uErr.message}`)
          if (((upd ?? []) as unknown[]).length !== 1) throw new Error("transaction mirror matched no row")
          out.transactionMirror.updated = Object.keys(patch)
        }
        // WAVE 151 (lane 151K — closing date): an executed instrument that moves the closing date moves the CONTRACTUAL date through
        // the ONE governed writer, with the executed document as its reference (contractual / anticipated / actual stay distinct;
        // the TC may still re-propose the anticipated day). A disputed closing date moves nothing. A system cannot record a person's
        // amendment: without the recording person it is said, not done.
        if ("closing_date" in input.changedTerms) {
          if (disputed.has("closing_date")) out.closingDate = { recorded: false, detail: "two executed instruments contradict each other on the closing date — nothing moves until a person resolves it" }
          else if (!input.recordedBy) out.closingDate = { recorded: false, detail: `the executed ${input.source} moves the contract closing date to ${String(input.changedTerms.closing_date)} — record it on the deal's closing dates (no recording person was given)` }
          else {
            const { applyClosingDateChange } = await import("@/lib/transactions/closing-dates")
            const { withActionLedger } = await import("@/lib/kernel/action-ledger")
            const r = await applyClosingDateChange(svc as never, {
              brokerageId: input.brokerageId, transactionId: input.transactionId, actorUserId: input.recordedBy, kind: "executed_amendment",
              date: input.changedTerms.closing_date === null ? null : String(input.changedTerms.closing_date), evidenceRef: `document:${input.documentId}`,
              reason: `Executed ${label} changes the closing date (document ${input.documentId}).`,
            }, { ledger: withActionLedger })
            out.closingDate = r.ok ? { recorded: true, detail: `contract closing date now ${String(input.changedTerms.closing_date)} by the executed ${input.source} (document ${input.documentId}); the TC confirms the anticipated day with lender and title` } : { recorded: false, detail: r.error }
            if (!r.ok) out.errors.push(`closing date not moved: ${r.error}`)
          }
        }
      }
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e))
    }

    // 2 · compliance re-review — ONLY for the changed terms (wave 151, lane 151K: a contingency change does not re-judge the price
    //     lines) — plus every unresolved contradiction filed as a blocking review row; the closing attestation re-opens
    try {
      const run = deps.runClosingCompliance ?? (async (s, i) => { const { runClosingCompliance } = await import("@/lib/transactions/closing-compliance"); return runClosingCompliance(s, i) })
      const r = await run(svc, { transactionId: input.transactionId, brokerageId: input.brokerageId, trigger: "contract_addendum", actorUserId: input.recordedBy, changedTerms: Object.keys(input.changedTerms), unresolved })
      out.complianceReReview = { ran: r.ran, openBlocking: r.openBlocking, reason: r.reason }
    } catch (e) {
      out.errors.push(`compliance re-review failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      const { reopenClosingAttestation } = await import("@/lib/commission/closing-verification")
      const r = await reopenClosingAttestation(svc as never, { brokerageId: input.brokerageId, transactionId: input.transactionId, why: `the executed ${label} changed ${changed} after the attestation` })
      out.closingAttestationReopened = r.ok && r.reopened
      if (!r.ok) out.errors.push(r.error)
    } catch (e) {
      out.errors.push(`closing attestation not re-opened: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 3 · settlement reconciliation — read, never re-write, the posted money
    if (!impact.moneyMoved) {
      out.settlement = { status: "no_money_change", detail: `the executed ${input.source} changes ${changed} — no posted or authorised money moves` }
    } else {
      try {
        const { data: posted, error: pErr } = await svc.from("commission_distributions").select("id, status").eq("brokerage_id", input.brokerageId).eq("transaction_id", input.transactionId)
        if (pErr) throw new Error(`posted commission read refused: ${pErr.message}`)
        const live = ((posted ?? []) as Array<{ status?: string | null }>).filter((r) => r.status !== "voided")
        if (live.length > 0 || tx?.commission_finalized_at) {
          out.settlement = { status: "ledger_correction_required", detail: `the commission is already ${tx?.commission_finalized_at ? "finalized" : "posted"} (${live.length} live ledger entr${live.length === 1 ? "y" : "ies"}) on the superseded terms — a finance admin corrects it through the ledger correction path (approved adjustments; the posted rows are never re-written)` }
        } else {
          out.settlement = { status: "recalculate_before_posting", detail: "nothing is posted yet — the next commission calculation prices the governing terms" }
        }
      } catch (e) {
        out.errors.push(e instanceof Error ? e.message : String(e))
      }
      // 4 · the CDA follows the contract
      try {
        const { reopenCdaForCorrection } = await import("@/lib/commission/cda-correction")
        if (input.recordedBy) {
          const r = await reopenCdaForCorrection(svc as never, { brokerageId: input.brokerageId, transactionId: input.transactionId, reason: `the executed ${label} changed ${changed} (document ${input.documentId})`, actedBy: input.recordedBy, source: "contract_addendum" })
          if (r.ok) out.cda = { outcome: r.result.outcome, resendToTitle: r.result.resendToTitle, detail: r.result.detail }
          else out.errors.push(`CDA correction: ${r.error}`)
        } else {
          out.errors.push("CDA correction needs the person who recorded the change (none given) — a compliance officer re-opens it")
        }
      } catch (e) {
        out.errors.push(`CDA correction failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // 5 · broker / TC / agent notification — and (wave 151, lane 151K) the ESCALATION of every unresolved contradiction: two executed
  //     instruments disagree on a term and nothing signed orders them; a person reviews, nothing here picks one.
  try {
    const conflictLines = unresolved.map((u) => `${u.key}: ${u.versions.map((v) => `${v.source} ${v.versionNo} says ${JSON.stringify(v.value)}${v.effectiveAt ? ` (effective ${v.effectiveAt.slice(0, 10)})` : ""}`).join(" vs ")} — ${u.reason === "same_effective_instant" ? "both take effect at the same instant" : "the effective language and the signing order contradict each other"}`)
    const title = unresolved.length ? `Executed ${input.source} recorded — REVIEW NEEDED: ${unresolved.map((u) => u.key).join(", ")} contradicted by another executed instrument` : `Executed ${input.source} recorded — ${changed}`
    const body = `${label[0].toUpperCase()}${label.slice(1)} changes ${changed}. Affected: ${impact.obligations.join(", ") || "none"}. ${out.settlement.detail}.${out.cda ? ` CDA: ${out.cda.outcome}${out.cda.resendToTitle ? " — re-send the corrected CDA to the closing agent" : ""}.` : ""}${out.closingDate ? ` Closing date: ${out.closingDate.detail}.` : ""}${conflictLines.length ? ` CONFLICT — no governing value until a person reviews: ${conflictLines.join("; ")}. Obtain the instrument that settles it (or a later executed one restating the term) and record it.` : ""}`
    const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
    out.notified += await notifyBrokerageAdmins(svc, input.brokerageId, { type: unresolved.length ? "contract_terms_conflict" : "contract_change_executed", title: title.slice(0, 200), body, entityType: input.transactionId ? "transaction" : "offer", entityId: (input.transactionId ?? input.rootOfferId) as string, priority: unresolved.length ? "critical" : "high" })
    out.review.escalated = unresolved.length > 0 && (out.notified > 0 || out.complianceReReview.ran)
    const userIds = new Set<string>()
    if (tx?.coordinator_id) {
      const { data: tc, error: tcErr } = await svc.from("transaction_coordinators").select("user_id").eq("id", tx.coordinator_id).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (tcErr) out.errors.push(`coordinator read refused: ${tcErr.message}`)
      const u = (tc as { user_id?: string | null } | null)?.user_id
      if (u) userIds.add(u)
    }
    if (tx?.agent_id) {
      const { data: ag, error: agErr } = await svc.from("agents").select("user_id").eq("id", tx.agent_id).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (agErr) out.errors.push(`agent read refused: ${agErr.message}`)
      const u = (ag as { user_id?: string | null } | null)?.user_id
      if (u) userIds.add(u)
    }
    if (input.recordedBy) userIds.delete(input.recordedBy)
    if (userIds.size > 0) {
      const { error: nErr } = await svc.from("notifications").insert([...userIds].map((user_id) => ({ user_id, brokerage_id: input.brokerageId, type: unresolved.length ? "contract_terms_conflict" : "contract_change_executed", title: title.slice(0, 200), body: body.slice(0, 480), entity_type: "transaction", entity_id: input.transactionId, priority: unresolved.length ? "critical" : "high", channel: "in_app", is_read: false })))
      if (nErr) out.errors.push(`deal-team notice not written: ${nErr.message}`)
      else out.notified += userIds.size
    }
  } catch (e) {
    out.errors.push(`notification failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 6 · evidence (LAW 5) + the commission audit event when money moved
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    await withActionLedger<{ ok: true }>(
      {
        brokerageId: input.brokerageId,
        action: "contract.executed_change.consequences",
        actor: { type: "user", userId: input.recordedBy, agentId: null },
        subject: { type: input.transactionId ? "transaction" : "offer", id: input.transactionId ?? input.rootOfferId, ref: input.documentId },
        reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `executed ${label}: ${changed}`.slice(0, 500),
        riskClass: impact.moneyMoved ? "FINANCIAL" : "LEGAL",
        systemSource: "contract_change",
        idempotencyKey: `contract-change:${input.brokerageId}:${input.rootOfferId ?? input.transactionId}:${input.source}:${input.versionNo}`,
        detail: { version_no: input.versionNo, source: input.source, document_id: input.documentId, executed_on: input.executedOn, effective_on: input.effectiveOn ?? null, changed_terms: input.changedTerms, consequences: { ...out } },
      },
      async () => ({ ok: true as const }),
      { settle: () => ({ status: "executed", outcome: "recorded" }), replay: () => ({ ok: true as const }) },
      { client: svc as never },
    )
    if (impact.moneyMoved && input.transactionId) {
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      const { KernelEvent } = await import("@/lib/kernel/events")
      await emitKernelEvent({
        event: KernelEvent.COMMISSION_UPDATED, brokerageId: input.brokerageId, entityType: "transaction", entityId: input.transactionId, transactionId: input.transactionId,
        actorUserId: input.recordedBy, auditOnly: true, client: svc,
        metadata: { change: "contract_executed_change", source: input.source, version_no: input.versionNo, changed_terms: Object.keys(input.changedTerms), settlement: out.settlement.status, cda: out.cda?.outcome ?? null },
        dedupeKey: `contract-change:${input.rootOfferId ?? input.transactionId}:${input.source}:${input.versionNo}`, dedupeWindowSec: 7 * 86_400,
      })
    }
  } catch (e) {
    out.errors.push(`evidence not written: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}
