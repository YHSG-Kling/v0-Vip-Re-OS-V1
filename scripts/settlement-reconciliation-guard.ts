/**
 * scripts/settlement-reconciliation-guard.ts (npm run test:settlement-reconciliation) — WAVE 152, LANE 152G.
 *
 * LIVE CONTRACT-TO-SETTLEMENT RECONCILIATION AND A CORRECT FINAL CLOSING DISCLOSURE. Owner (verbatim, 2026-11-11): "anytime there
 * is a change at closing to transaction, the final closing desclosure has to be correct. evn though the brokerage doesnt support a
 * cda, compliance still needs to accurate along with the closing disclosure. that is not informational."
 *
 * Drives the REAL survivors on scripts/in-memory-supabase.ts (SIMULATED — no database, no provider, no model):
 *   lib/transactions/closing-compliance.ts runClosingCompliance (152E's comparison; its tail now reconciles),
 *   lib/offers/closing-cost-accuracy.ts reconcileClosingSettlement + closingSettlementGate (the I/O + the close hold),
 *   lib/transactions/cda-closing-policy.ts reconcileSettlement / settlementReconciliationForViewer (the pure rule),
 *   lib/offers/governing-terms.ts recordContractTermsVersion (an executed / a proposed addendum, with its consequences),
 *   lib/commission/closing-verification.ts (the closing question — asked and answered for real).
 * The directive's ten critical cases (152G "Critical test cases"), each with an ADVERSE case and a POSITIVE CONTROL, then the wiring
 * (stripped source — CLAUDE.md §2: a tombstone is not a call site). Blind spots are printed at the end.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemOptions } from "./in-memory-supabase"
import { runClosingCompliance } from "../lib/transactions/closing-compliance"
import { reconcileClosingSettlement, closingSettlementGate } from "../lib/offers/closing-cost-accuracy"
import { reconcileSettlement, settlementReconciliationForViewer, SETTLEMENT_ITEM_CATALOG, SETTLEMENT_READINESS_STATES, resolveCdaMode } from "../lib/transactions/cda-closing-policy"
import { recordContractTermsVersion } from "../lib/offers/governing-terms"
import { ensureClosingAttestationAsked, closingAttestationState, recordClosingAttestation, mayAttestClosing, CLOSING_ATTESTATION_CHECK_TYPE } from "../lib/commission/closing-verification"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
const bare = (p: string) => blankStrings(stripComments(raw(p)))
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const e = console.error, w = console.warn, l = console.log; console.error = () => {}; console.warn = () => {}; console.log = () => {}; try { return await f() } finally { console.error = e; console.warn = w; console.log = l } }

const B = "11111111-1111-4111-8111-111111111111", B_OTHER = "11111111-1111-4111-8111-11111111111f"
const U_ADMIN = "22222222-2222-4222-8222-222222222222", U_AGENT = "22222222-2222-4222-8222-222222222223", U_TC = "22222222-2222-4222-8222-222222222224", U_VENDOR = "22222222-2222-4222-8222-222222222225"
const AG = "33333333-3333-4333-8333-333333333333", AG_OTHER = "33333333-3333-4333-8333-333333333334", TC_ID = "77777777-7777-4777-8777-777777777771"
const ROOT_OFFER = "44444444-4444-4444-8444-444444444444", TXN = "55555555-5555-4555-8555-555555555555"
const DOC_CD = "66666666-6666-4666-8666-666666666664", DOC_CD2 = "66666666-6666-4666-8666-666666666665", DOC_CD3 = "66666666-6666-4666-8666-666666666666"
const DOC_ADD = "66666666-6666-4666-8666-666666666661", DOC_ADD2 = "66666666-6666-4666-8666-666666666662", DOC_PROP = "66666666-6666-4666-8666-666666666663"
const both = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] }
/** A revised statement is received AFTER the seeded one (2026-11-20) — fixtures never use "now" for document order. */
const REVISED_AT = "2026-11-28T00:00:00Z"
const CONSISTENT_CD = { sales_price: "500000", earnest_money_deposit: "5000", commission_buyer_broker: "12500", closing_date: "2026-12-15", cash_to_close: "103250.00", loan_amount: "400000" }
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

interface SeedOpts { offersCda?: boolean | null; statement?: Record<string, unknown> | null; financing?: string; stage?: string; status?: string; extra?: Record<string, Array<Record<string, any>>>; mem?: MemOptions }
function seed(o: SeedOpts = {}) {
  const tables: Record<string, Array<Record<string, any>>> = {
    brokerages: [{ id: B, name: "Guard Brokerage", state: "TX", offers_cda: o.offersCda === undefined ? false : o.offersCda, non_cda_payout_default: "check", commission_payout_timing: null }],
    users: [{ id: U_ADMIN, brokerage_id: B, user_type: "broker_owner" }, { id: U_AGENT, brokerage_id: B, user_type: "agent" }, { id: U_TC, brokerage_id: B, user_type: "tc" }, { id: U_VENDOR, brokerage_id: B, user_type: "vendor" }],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: B }],
    transaction_coordinators: [{ id: TC_ID, brokerage_id: B, user_id: U_TC }],
    offers: [{ id: ROOT_OFFER, brokerage_id: B, agent_id: AG, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "accepted", esign_status: "fully_executed", buyer_signed_at: "2026-10-01T10:00:00Z", seller_signed_at: "2026-10-01T12:00:00Z", fully_signed_contract_received_at: "2026-10-01T12:00:00Z", transaction_id: TXN, offer_price: 500_000, earnest_money: 5_000, closing_date: "2026-12-15", disclosed_buyer_commission_pct: 2.5, closing_cost_contribution: null, created_at: "2026-10-01T09:00:00Z" }],
    transactions: [{ id: TXN, brokerage_id: B, agent_id: AG, coordinator_id: TC_ID, status: o.status ?? "under_contract", stage: o.stage ?? "CLOSING_PREP", offer_id: ROOT_OFFER, deal_type: "buyer", purchase_price: 500_000, earnest_money: 5_000, closing_cost_contribution: null, contract_date: "2026-10-01", close_date: "2026-12-15", estimated_close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract", property_state: "TX", financing_type: o.financing ?? "conventional", loan_amount: o.financing === "cash" ? null : 400_000, commission_finalized_at: null, compliance_passed_at: "2026-10-02T00:00:00Z", buyer_contact_id: null, seller_contact_id: null, contact_id: null, listing_id: null, buyer_agent_id: null, seller_agent_id: null, listing_offered_commission_percentage: null, updated_at: "2026-10-02T00:00:00Z" }],
    documents: [
      { id: DOC_ADD, brokerage_id: B, transaction_id: TXN, classification: "addendum", signature_completeness: both, extracted_fields: null, created_at: "2026-11-01T00:00:00Z" },
      { id: DOC_ADD2, brokerage_id: B, transaction_id: TXN, classification: "addendum", signature_completeness: both, extracted_fields: null, created_at: "2026-11-02T00:00:00Z" },
      ...(o.statement === null ? [] : [{ id: DOC_CD, brokerage_id: B, transaction_id: TXN, classification: "closing_disclosure", classification_confidence: "high", signature_completeness: null, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z", metadata: null, extracted_fields: o.statement ?? CONSISTENT_CD }]),
    ],
    document_field_extractions: [], contract_term_versions: [], transaction_compliance_log: [], notifications: [], closing_disclosure_agreement: [],
    commission_distributions: [], agent_commissions: [], agent_action_ledger: [], lifecycle_events: [], activities: [], transaction_tasks: [], policy_decisions: [], trid_timeline: [], transaction_documents: [],
  }
  for (const [k, rows] of Object.entries(o.extra ?? {})) tables[k] = [...(tables[k] ?? []), ...rows]
  return memSupabase(tables, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] }, ...(o.mem ?? {}) })
}
type Db = ReturnType<typeof seed>
const stubs = { notify: async () => 0, audit: async () => {}, closingEntity: async () => "title_company" as string | null }
const run = (db: Db, trigger: "settlement_scanned" | "final_check" | "manual" = "settlement_scanned") => quiet(() => runClosingCompliance(db as never, { transactionId: TXN, brokerageId: B, trigger }, stubs))
const gate = (db: Db) => quiet(() => closingSettlementGate(db as never, { transactionId: TXN, brokerageId: B }, {
  askClosingQuestion: async () => { const a = await ensureClosingAttestationAsked(db as never, { brokerageId: B, transactionId: TXN }); return a.ok ? closingAttestationState(db as never, { brokerageId: B, transactionId: TXN }) : a },
  runClosingCompliance: (s, i) => runClosingCompliance(s as never, i, stubs),
}))
const snaps = (db: Db) => db.tables.policy_decisions.filter((r) => r.target_type === "settlement_reconciliation" && r.transaction_id === TXN)
const latestSnap = (db: Db) => snaps(db).slice(-1)[0]
const reconTasks = (db: Db) => db.tables.transaction_tasks.filter((t) => t.transaction_id === TXN && t.category === "compliance_correction" && /settlement —/.test(String(t.title)))
const openTasks = (db: Db) => reconTasks(db).filter((t) => t.status === "pending" || t.status === "in_progress")
const attest = (db: Db) => db.tables.transaction_compliance_log.find((r) => r.check_type === CLOSING_ATTESTATION_CHECK_TYPE && r.transaction_id === TXN)
const answerNo = (db: Db) => quiet(() => recordClosingAttestation(db as never, { userId: U_TC, agentId: null, brokerageId: B, userType: "tc" }, { transactionId: TXN, answer: "no_unrecorded_change" }))
const addCd = (db: Db, id: string, at: string, fields: Record<string, unknown>) => db.tables.documents.push({ id, brokerage_id: B, transaction_id: TXN, classification: "closing_disclosure", classification_confidence: "high", signature_completeness: null, created_at: at, updated_at: at, metadata: null, extracted_fields: fields })
const executed = (db: Db, docId: string, terms: Record<string, unknown>, stated: Record<string, unknown>, daysAgo = 2) => quiet(() => recordContractTermsVersion(db as never, {
  brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms, documentId: docId, executedAt: `${day(daysAgo)}T23:59:59.999Z`, recordedBy: U_AGENT,
  evidence: { recorded_via: "guard", term_evidence_stated: stated },
}))

type ReconIn = Parameters<typeof reconcileSettlement>[0]
const baseIn = (over: Partial<ReconIn> = {}): ReconIn => ({
  closing: { financing: "financed", tridTracked: true, closed: false, commissionFinalized: false }, findings: [], otherOpenBlocking: [], waivedTerms: [],
  statement: { documentId: "d1", classification: "closing_disclosure", stage: "unlabeled", receivedAt: "2026-11-25T00:00:00Z", versions: 1 },
  figures: {}, priorCdFigures: null, dealRecord: { loanAmount: null }, trid: { cdDeliveredDate: "2026-11-20" },
  cdaMode: "no_cda", cdaRail: { finalAttached: false, preliminaryReviewed: false, correctionRequestedAt: null, correctionRoute: null }, unreadStatementOnFile: false, openCorrectionTasks: 0, readFault: null, ...over,
})
const fig = (value: number | string | boolean) => ({ value, confidence: "high" })

async function main() {
  section("A · THE PURE RULE — bases, states, the TRID branch, the record, never a fabricated figure")
  {
    check("every catalog item names one of the three bases; exact, extracted-estimate AND authoritative items are all published (the boundary is stated, not implied)",
      SETTLEMENT_ITEM_CATALOG.every((c) => ["exact", "extracted_estimate", "authoritative_required"].includes(c.basis)) && ["exact", "extracted_estimate", "authoritative_required"].every((b) => SETTLEMENT_ITEM_CATALOG.some((c) => c.basis === b)))
    check("the four readiness states are ONE vocabulary: ready / needs_review / awaiting_revised_document / compliance_blocked", SETTLEMENT_READINESS_STATES.join() === "ready,needs_review,awaiting_revised_document,compliance_blocked")
    const issuer = reconcileSettlement(baseIn({ figures: { cashToClose: fig("103,250.00") } }))
    const cash = issuer.items.find((i) => i.key === "issuer.cash_to_close")
    check("the issuer's figure is LISTED as the issuer's (authoritative, never computed); a figure not read is UNRESOLVED and names the issuer — never a fabricated $0",
      cash?.status === "issuer_value" && cash.basis === "authoritative_required" && cash.documentSays === "$103,250.00" && issuer.items.find((i) => i.key === "issuer.total_closing_costs")?.status === "not_on_file" && issuer.items.find((i) => i.key === "issuer.total_closing_costs")?.documentSays === null)
    const noApr = reconcileSettlement(baseIn({ priorCdFigures: { loanProduct: fig("30-year fixed") }, figures: { loanProduct: fig("30-year fixed") } }))
    check("APR is NEVER reconstructed: two CDs that do not both state it → escalate to the lender (no wait invented, none waived)", noApr.trid.path === "escalate_to_lender" && /APR/.test(noApr.trid.detail))
    check("POSITIVE CONTROL: the same CDs stating both APRs within tolerance decide it (corrected CD, no new wait)",
      reconcileSettlement(baseIn({ priorCdFigures: { apr: fig("6.500"), loanProduct: fig("30-year fixed"), prepaymentPenalty: fig("no") }, figures: { apr: fig("6.550"), loanProduct: fig("30-year fixed"), prepaymentPenalty: fig("no") } })).trid.path === "corrected_cd_no_new_wait")
    const none = reconcileSettlement(baseIn({ statement: null, closing: { financing: "financed", tridTracked: true, closed: false, commissionFinalized: false } }))
    check("no statement on file → AWAITING a closing document, naming the LENDER for a TRID loan (it issues the borrower's CD)", none.state === "awaiting_revised_document" && /lender/.test(String(none.items.find((i) => i.key === "record")?.responsible)) && !none.record.finalOnFile)
    const fault = reconcileSettlement(baseIn({ readFault: "the compliance log could not be read: denied" }))
    check("a READ FAULT is compliance-blocked — 'nobody checked' never reads as reconciled", fault.state === "compliance_blocked" && fault.blockers.length > 0)
    const prelim = reconcileSettlement(baseIn({ statement: { documentId: "p1", classification: "preliminary_closing_statement", stage: "preliminary", receivedAt: "2026-11-25T00:00:00Z", versions: 1 } }))
    check("a PRELIMINARY statement is judged on its figures (ready here) but is not the final record — finalOnFile false (the close gate requires the final)", prelim.state === "ready" && !prelim.record.finalOnFile)
  }

  section("B · CASE 7 — CDA DISABLED: compliance and settlement still compared; no CDA mandatory; the closing question is BLOCKING before the close")
  {
    const db = seed()
    const out = await run(db)
    const rec = out.reconciliation?.reconciliation
    check("the consistent final Closing Disclosure reconciles READY at the tail of the ONE closing check (152E compare → reconcile), final record on file", out.ran && rec?.state === "ready" && rec.record.finalOnFile === true, JSON.stringify(rec?.blockers))
    check("…recorded as VERSION 1 on the policy ledger (green, target settlement_reconciliation, document = the CD), ledgered once (compliance.settlement_reconciliation.snapshot)",
      snaps(db).length === 1 && latestSnap(db)?.decision === "green" && latestSnap(db)?.document_id === DOC_CD && latestSnap(db)?.evidence_json?.version === 1 && db.tables.agent_action_ledger.filter((r) => r.action === "compliance.settlement_reconciliation.snapshot").length === 1)
    check("no CDA is created or required (no closing_disclosure_agreement row; resolveCdaMode never blocks a close)", db.tables.closing_disclosure_agreement.length === 0 && resolveCdaMode({ offersCda: false }).blocksClosing === false)
    const g1 = await gate(db)
    const row = attest(db)
    check("THE CLOSE HOLDS on the closing question: the gate asked it as a BLOCKING pending row (owner: 'that is not informational') and refuses until it is answered",
      g1.blockers.length === 1 && /Closing question/.test(g1.blockers[0]) && row?.status === "pending" && row?.is_blocking === true, g1.blockers.join(" | "))
    const ans = await answerNo(db)
    const g2 = await gate(db)
    check("…answered 'no' by the deal's transaction coordinator → the gate opens (settlement READY + final on file + the question answered)", ans.ok && g2.blockers.length === 0, g2.blockers.join(" | "))
    check("POSITIVE CONTROL (adverse): an agent who is not on the deal, and a vendor seat, may not answer the closing question",
      !mayAttestClosing({ userId: "x", agentId: AG_OTHER, userType: "agent" }, { agentIds: [AG], coordinatorUserId: U_TC }) && !mayAttestClosing({ userId: U_VENDOR, agentId: null, userType: "vendor" }, { agentIds: [AG], coordinatorUserId: U_TC }) && mayAttestClosing({ userId: U_TC, agentId: null, userType: "tc" }, { agentIds: [AG], coordinatorUserId: U_TC }))
    const legacy = seed({ extra: { transaction_compliance_log: [{ id: "legacy-ask", brokerage_id: B, transaction_id: TXN, check_type: CLOSING_ATTESTATION_CHECK_TYPE, check_label: "x", status: "pending", is_blocking: false, failure_reason: "informational", created_at: "2026-11-01T00:00:00Z" }] } })
    await quiet(() => ensureClosingAttestationAsked(legacy as never, { brokerageId: B, transactionId: TXN }))
    check("an unanswered row an earlier INFORMATIONAL ask left non-blocking is made BLOCKING (counted), never left to read as optional", legacy.tables.transaction_compliance_log.find((r) => r.id === "legacy-ask")?.is_blocking === true)
  }

  section("C · CASE 1 — a signed $10,000 credit addendum; the title document is missing the credit → discrepancy + correction request; the old CD is not final-reconciled")
  {
    const db = seed()
    await run(db)
    await answerNo(db)
    const add = await executed(db, DOC_ADD, { closing_cost_contribution: 10_000 }, { closing_cost_contribution: { page: 1, field: "Paragraph 4", quote: "Seller shall credit Buyer $10,000.00 at closing." } })
    const rec = (await run(db)).reconciliation?.reconciliation
    const item = rec?.items.find((i) => i.key === "term.seller_credit")
    check("the executed addendum governs the credit (both signatures, located evidence) and the deal record follows it", add.ok && db.tables.transactions[0].closing_cost_contribution === 10_000)
    check("the reconciliation finds it MISSING on the latest document: contract says $10,000.00, the document does not show it → AWAITING A REVISED CLOSING DOCUMENT, blocking, the issuer named",
      rec?.state === "awaiting_revised_document" && item?.status === "missing_on_document" && item.contractSays === "$10,000.00" && item.documentSays === null && item.blocking && /lender|title/.test(String(item.responsible)), JSON.stringify(item))
    const vers = snaps(db)
    check("the old CD is NOT final-reconciled: the version-1 GREEN snapshot is kept (history never overwritten) and the LATEST is a newer non-green version that supersedes it",
      vers.length >= 2 && vers[0].decision === "green" && vers[0].evidence_json.version === 1 && latestSnap(db).decision !== "green" && latestSnap(db).evidence_json.supersedes === vers[0].evidence_json.fingerprint)
    const task = openTasks(db).find((t) => /Seller credit/.test(String(t.title)))
    check("ONE corrective request is open (transaction task, ledgered), naming who corrects it and what differs — assigned to the deal's TC", !!task && /\$10,000\.00/.test(String(task.description)) && /(lender|title)/i.test(String(task.description)), JSON.stringify(openTasks(db).map((t) => t.title)))
    const g = await gate(db)
    check("THE CLOSE HOLDS on it (no CDA brokerage — not informational)", g.blockers.some((b) => /Seller credit/.test(b) && /AWAITING|Awaiting/i.test(b)), g.blockers.join(" | "))
    addCd(db, DOC_CD2, REVISED_AT, { ...CONSISTENT_CD, seller_credit_to_buyer: "10000" })
    const fixed = (await run(db)).reconciliation?.reconciliation
    check("the revised statement from the issuer is read and compared → READY again (a NEW green version — A → B → A is recorded, not swallowed by idempotency) and EXACTLY its corrective request settles",
      fixed?.state === "ready" && latestSnap(db).decision === "green" && snaps(db).length === vers.length + 1 && !openTasks(db).some((t) => /Seller credit/.test(String(t.title))), JSON.stringify(fixed?.blockers))
  }

  section("C2 · a REVISED statement that DROPS a line is read as the latest — never back-filled from the version it superseded")
  {
    const db = seed({ statement: { ...CONSISTENT_CD, seller_credit_to_buyer: "10000" } })
    await executed(db, DOC_ADD, { closing_cost_contribution: 10_000 }, { closing_cost_contribution: { page: 1, field: "Paragraph 4", quote: "Seller shall credit Buyer $10,000.00 at closing." } })
    const v1 = (await run(db)).reconciliation?.reconciliation
    addCd(db, DOC_CD2, REVISED_AT, { ...CONSISTENT_CD })
    const v2 = (await run(db)).reconciliation?.reconciliation
    check("CORRECTED (152E's settlement read): the revised Closing Disclosure no longer shows the $10,000 credit → MISSING on the latest document (it used to 'agree' through the superseded version)",
      v1?.items.find((i) => i.key === "term.seller_credit")?.status === "agrees" && v2?.items.find((i) => i.key === "term.seller_credit")?.status === "missing_on_document" && v2.state === "awaiting_revised_document", JSON.stringify(v2?.items.find((i) => i.key === "term.seller_credit")))
    const comp = seed({ statement: { sales_price: "500000", earnest_money_deposit: "5000", closing_date: "2026-12-15" } })
    comp.tables.documents.push({ id: DOC_CD3, brokerage_id: B, transaction_id: TXN, classification: "preliminary_closing_statement", classification_confidence: "high", signature_completeness: null, created_at: "2026-11-18T00:00:00Z", updated_at: "2026-11-18T00:00:00Z", metadata: null, extracted_fields: { commission_buyer_broker: "12500", seller_proceeds: "88000" } })
    const c = (await run(comp)).reconciliation?.reconciliation
    check("POSITIVE CONTROL: a DIFFERENT document (the seller's statement) still supplies the commission line the buyer's CD does not print", c?.items.find((i) => i.key === "term.commission_buyer_side")?.status === "agrees", JSON.stringify(c?.items.find((i) => i.key === "term.commission_buyer_side")))
  }

  section("D · CASE 2 — a LATE PRICE CHANGE: contract, final settlement, commission, payout and lender/title revision re-evaluated")
  {
    const db = seed({ extra: { agent_commissions: [{ id: "ac-1", brokerage_id: B, transaction_id: TXN, status: "approved", gross_commission: 12_500 }] } })
    await run(db); await answerNo(db)
    const add = await executed(db, DOC_ADD, { offer_price: 490_000 }, { offer_price: { page: 1, field: "Paragraph 3", quote: "The Purchase Price is amended to $490,000." } })
    const rec = (await run(db)).reconciliation?.reconciliation
    const price = rec?.items.find((i) => i.key === "term.purchase_price"), comm = rec?.items.find((i) => i.key === "term.commission_buyer_side")
    check("the executed price addendum moves the deal ($490,000) and the reconciliation shows the statement still at the REPLACED $500,000 (blocking, send the issuer the executed addendum)",
      add.ok && db.tables.transactions[0].purchase_price === 490_000 && price?.status === "differs" && price.blocking && /\$500,000\.00/.test(String(price.documentSays)) && /executed instrument/.test(String(price.action)))
    check("…the DEPENDENT commission line is re-judged on the new price (staff-only line, blocking)", comm?.status === "differs" && comm.blocking && comm.staffOnly)
    const g = await gate(db)
    check("the close HOLDS (the price / commission lines are named by the compliance gate; the settlement hold still refuses on its own)", g.blockers.length > 0 && rec?.state === "awaiting_revised_document", g.blockers.join(" | "))
    check("the PAYOUT is untouched: no write to agent_commissions or commission_distributions anywhere in the change", !db.writes.some((w) => w.table === "agent_commissions" || w.table === "commission_distributions"))
    addCd(db, DOC_CD3, REVISED_AT, { ...CONSISTENT_CD, sales_price: "490000", commission_buyer_broker: "12250" })
    const after = (await run(db)).reconciliation?.reconciliation
    check("the lender / title revision is read and compared → READY; versions kept (≥ 3)", after?.state === "ready" && snaps(db).length >= 3, JSON.stringify(after?.blockers))
  }

  section("E · CASE 3 — a PROPOSED unsigned price change: preview only, no governance or financial overwrite")
  {
    const db = seed()
    await run(db)
    const before = { snaps: snaps(db).length, price: db.tables.transactions[0].purchase_price, tasks: reconTasks(db).length }
    db.tables.documents.push({ id: DOC_PROP, brokerage_id: B, transaction_id: TXN, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] }, extracted_fields: null })
    const prop = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "proposed", terms: { offer_price: 470_000 }, recordedBy: U_AGENT }))
    await run(db)
    check("the proposal is recorded as PROPOSED; the deal price, the reconciliation snapshot and the corrective requests are untouched (nothing governs until executed)",
      prop.ok && db.tables.transactions[0].purchase_price === before.price && snaps(db).length === before.snaps && reconTasks(db).length === before.tasks && latestSnap(db).decision === "green")
    const bad = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 470_000 }, documentId: DOC_PROP, executedAt: `${day(1)}T23:59:59.999Z`, recordedBy: U_AGENT }))
    check("ADVERSE: the same change claimed EXECUTED on a buyer-only signed document is refused — the price never moves", !bad.ok && db.tables.transactions[0].purchase_price === before.price)
  }

  section("F · CASES 4 + 5 — TRID: APR / loan product / prepayment penalty → a new three-business-day wait; an ordinary fee revision → corrected CD, NO new wait")
  {
    const tridDb = (cur: Record<string, string>, delivered = "2026-11-20") => {
      const db = seed({ extra: { trid_timeline: [{ id: "trid-1", brokerage_id: B, transaction_id: TXN, closing_disclosure_delivered_date: delivered, scheduled_close_date: "2026-12-15", compliance_status: "in_progress" }] } })
      addCd(db, DOC_CD2, "2026-11-25T00:00:00Z", { ...CONSISTENT_CD, total_closing_costs: "9100" })
      const L = (doc: string, k: string, v: string) => db.tables.document_field_extractions.push({ id: `${doc}-${k}`, brokerage_id: B, document_id: doc, field_key: k, field_value_json: v, confidence: "high", verified_at: null })
      L(DOC_CD, "apr", "6.500"); L(DOC_CD, "loan_product", "30-year fixed"); L(DOC_CD, "prepayment_penalty", "no")
      for (const [k, v] of Object.entries(cur)) L(DOC_CD2, k, v)
      return db
    }
    const aprUp = tridDb({ apr: "6.900", loan_product: "30-year fixed", prepayment_penalty: "no" })
    const r1 = (await run(aprUp)).reconciliation?.reconciliation
    const w = r1?.items.find((i) => i.key === "trid.waiting_period")
    check("CASE 4: the revised CD raised the APR beyond 1/8 point → NEW three-business-day waiting period; the delivery on file predates the revised CD → blocking, the LENDER owns it (12 CFR 1026.19(f)(2)(ii))",
      r1?.trid.path === "new_waiting_period" && r1.trid.triggers.includes("apr_inaccurate") && w?.blocking === true && /lender/.test(String(w.responsible)) && r1.state === "awaiting_revised_document", JSON.stringify(r1?.trid))
    const g = await gate(aprUp)
    check("…and the close HOLDS on it", g.blockers.some((b) => /waiting period/i.test(b)), g.blockers.join(" | "))
    aprUp.tables.trid_timeline[0].closing_disclosure_delivered_date = "2026-11-25"
    const r1b = (await run(aprUp)).reconciliation?.reconciliation
    check("…recording the revised CD's delivery clears the settlement hold (the stage gate's TRID step then counts the three business days from it)", r1b?.items.find((i) => i.key === "trid.waiting_period")?.blocking === false && r1b.state === "ready", JSON.stringify(r1b?.blockers))
    const prod = (await run(tridDb({ apr: "6.500", loan_product: "5/1 ARM", prepayment_penalty: "no" }))).reconciliation?.reconciliation
    const pp = (await run(tridDb({ apr: "6.500", loan_product: "30-year fixed", prepayment_penalty: "yes" }))).reconciliation?.reconciliation
    check("a LOAN PRODUCT change and an ADDED PREPAYMENT PENALTY each restart the wait", prod?.trid.triggers.includes("loan_product_changed") === true && pp?.trid.triggers.includes("prepayment_penalty_added") === true)
    const fee = (await run(tridDb({ apr: "6.550", loan_product: "30-year fixed", prepayment_penalty: "no" }))).reconciliation?.reconciliation
    check("CASE 5: an ordinary fee revision (closing costs changed, APR within tolerance) → corrected CD, NO new wait invented, nothing held for TRID",
      fee?.trid.path === "corrected_cd_no_new_wait" && !fee.items.some((i) => i.key.startsWith("trid.") && i.blocking) && fee.state === "ready", JSON.stringify(fee?.trid))
    const irregular = (await run(tridDb({ apr: "6.700", loan_product: "30-year fixed", prepayment_penalty: "no" }))).reconciliation?.reconciliation
    const down = (await run(tridDb({ apr: "6.200", loan_product: "30-year fixed", prepayment_penalty: "no" }))).reconciliation?.reconciliation
    check("UNCERTAIN cases are ESCALATED to the lender, never decided: +0.2 point (irregular-transaction band) and a decrease beyond 1/8 (may still be accurate, 1026.22(a)(4))",
      irregular?.trid.path === "escalate_to_lender" && down?.trid.path === "escalate_to_lender" && /lender/i.test(String(irregular.items.find((i) => i.key === "trid.revision")?.responsible)))
  }

  section("G · CASE 6 — a CASH closing: the settlement statement is the record — no fake borrower CD, no TRID")
  {
    const db = seed({ financing: "cash", statement: { sales_price: "500000", earnest_money_deposit: "5000", commission_buyer_broker: "12500", closing_date: "2026-12-15" } })
    const rec = (await run(db)).reconciliation?.reconciliation
    check("record kind = settlement statement, issued by the title company / settlement agent or closing attorney; TRID not applicable",
      rec?.record.kind === "settlement_statement" && /title company/.test(String(rec.record.issuer)) && rec.trid.path === "not_applicable" && rec.state === "ready")
    check("no borrower-CD item is demanded (no cash-to-close / loan-amount / TRID-coverage line) — POSITIVE CONTROL: the financed deal lists them",
      !rec?.items.some((i) => i.key === "issuer.cash_to_close" || i.key === "issuer.loan_amount" || i.key === "trid_coverage") && !!(await run(seed())).reconciliation?.reconciliation?.items.some((i) => i.key === "issuer.cash_to_close"))
  }

  section("H · CASE 8 — a POST-CLOSING corrected statement: reconciled and routed to finance; no duplicate payout, no mutable paid ledger")
  {
    const db = seed({ stage: "CLOSED", status: "closed", extra: { agent_commissions: [{ id: "ac-1", brokerage_id: B, transaction_id: TXN, status: "paid", paid_at: "2026-12-16T00:00:00Z" }], commission_distributions: [{ id: "cd-1", brokerage_id: B, transaction_id: TXN, status: "paid", amount: 9_000 }] } })
    db.tables.transactions[0].commission_finalized_at = "2026-12-15T00:00:00Z"
    await run(db)
    const paidBefore = JSON.stringify([db.tables.agent_commissions, db.tables.commission_distributions])
    addCd(db, DOC_CD2, REVISED_AT, { ...CONSISTENT_CD, sales_price: "495000" })
    const rec = (await run(db)).reconciliation?.reconciliation
    const corr = rec?.items.find((i) => i.key === "post_closing.correction")
    check("the corrected statement is compared and a correction is routed to the brokerage's FINANCE admin (ledger correction path — the paid entry is never re-written); nothing 'holds' a closed deal",
      !!corr && /finance/.test(String(corr.responsible)) && /never re-written/.test(String(corr.action)) && !rec!.items.some((i) => i.blocking), JSON.stringify(rec?.items.filter((i) => i.blocking)))
    check("ONE finance task is opened for it", openTasks(db).filter((t) => /Corrected statement after closing/.test(String(t.title))).length === 1)
    const tasksBefore = reconTasks(db).length, snapsBefore = snaps(db).length
    await run(db)
    check("the paid ledger is byte-identical (no write to agent_commissions / commission_distributions); a replayed scan opens nothing and records nothing twice",
      JSON.stringify([db.tables.agent_commissions, db.tables.commission_distributions]) === paidBefore && !db.writes.some((wr) => wr.table === "agent_commissions" || wr.table === "commission_distributions") && reconTasks(db).length === tasksBefore && snaps(db).length === snapsBefore)
  }

  section("I · CASE 9 — ROLE PRIVACY: an agent sees only what is authorized; title / lender read their own portals; an unrelated seat cannot read")
  {
    const full = reconcileSettlement(baseIn({
      findings: [{ term: "commission_buyer_side", label: "Buyer-side commission", verdict: "match", classification: "match", governing: "$12,500.00", settlement: "$12,500.00", blocking: false }],
      figures: { cashToClose: fig("103250"), loanAmount: fig("400000"), sellerProceeds: fig("88000") },
    }))
    const buyer = settlementReconciliationForViewer(full, { side: "buyer", staff: false })
    const seller = settlementReconciliationForViewer(full, { side: "seller", staff: false })
    const staff = settlementReconciliationForViewer(full, { side: "both", staff: true })
    check("a buyer-side agent never receives the seller's proceeds; a seller-side agent never the borrower's cash to close / loan amount; what is withheld is COUNTED",
      !buyer.items.some((i) => i.key === "issuer.seller_proceeds") && buyer.withheld >= 1 && !seller.items.some((i) => i.key === "issuer.cash_to_close" || i.key === "issuer.loan_amount") && seller.withheld >= 2)
    check("commission values reach brokerage STAFF only (an agent's view blanks them — commission is off agent-facing display); POSITIVE CONTROL: staff see every line and every value",
      buyer.items.find((i) => i.key === "term.commission_buyer_side")?.contractSays === null && staff.items.find((i) => i.key === "term.commission_buyer_side")?.contractSays === "$12,500.00" && staff.withheld === 0 && staff.items.length === full.items.length)
    const door = code("app/actions/transactions/closing-proof.ts"), doorBare = bare("app/actions/transactions/closing-proof.ts")
    const fn = door.slice(door.indexOf("export async function getSettlementReconciliationAction"))
    check("THE READ DOOR: session actor first, then the deal roster (mayAttestClosing) BEFORE the policy-ledger read, tenant-pinned, redacted per viewer; the file writes nothing",
      fn.indexOf("resolveSessionActor()") >= 0 && fn.indexOf("resolveSessionActor()") < fn.indexOf("createServiceClient()") && fn.indexOf("mayAttestClosing(") < fn.indexOf("\"policy_decisions\"".replace(/"/g, "")) && /\.from\("policy_decisions"\)[^\n]*\.eq\("brokerage_id", brokerageId\)/.test(fn) && /settlementReconciliationForViewer\(/.test(fn) && !/\.(insert|update|upsert|delete)\(/.test(doorBare) && !/export (?!async function)/.test(door))
    check("POSITIVE CONTROL: the write finder recognises a specimen; an unrelated agent and a vendor seat are outside the roster the door admits",
      /\.(insert|update)\(/.test(`db.from("x").update({})`) && !mayAttestClosing({ userId: "u", agentId: AG_OTHER, userType: "agent" }, { agentIds: [AG], coordinatorUserId: null }) && !mayAttestClosing({ userId: U_VENDOR, agentId: null, userType: "vendor" }, { agentIds: [AG], coordinatorUserId: null }))
    const other = seed()
    const crossTenant = await quiet(() => reconcileClosingSettlement(other as never, { transactionId: TXN, brokerageId: B_OTHER, trigger: "manual", comparison: null, readFault: null }))
    check("another tenant's session reads NOTHING: the reconciler is tenant-pinned (the deal reads as absent; no snapshot is written for it)", !crossTenant.ok && crossTenant.error === "transaction_not_found" && other.tables.policy_decisions.length === 0)
  }

  section("J · CASE 10 — IDEMPOTENT RETRY: one discrepancy, one actionable case — never repeated spam")
  {
    const db = seed({ statement: { ...CONSISTENT_CD } })
    await executed(db, DOC_ADD, { closing_cost_contribution: 10_000 }, { closing_cost_contribution: { page: 1, field: "Paragraph 4", quote: "Seller shall credit Buyer $10,000.00 at closing." } })
    await run(db)
    const s1 = snaps(db).length, t1 = reconTasks(db).length, l1 = db.tables.agent_action_ledger.length
    await run(db); await run(db, "final_check")
    check("the same scan replayed twice (and the final check) writes NO new snapshot, opens NO second request and claims nothing new", snaps(db).length === s1 && reconTasks(db).length === t1 && db.tables.agent_action_ledger.length === l1, `${s1}/${snaps(db).length} ${t1}/${reconTasks(db).length} ${l1}/${db.tables.agent_action_ledger.length}`)
    check("…exactly ONE open request for the missing credit", openTasks(db).filter((t) => /Seller credit/.test(String(t.title))).length === 1)
    // two callbacks landing at the same instant with the same inputs: the ledger claim admits one snapshot
    const race = seed()
    const comparison = (await run(race)).comparison
    race.tables.documents.find((d) => d.id === DOC_CD)!.extracted_fields = { ...CONSISTENT_CD, sales_price: "505000" }
    const before = snaps(race).length
    const both2 = await quiet(() => Promise.all([0, 1].map(() => reconcileClosingSettlement(race as never, { transactionId: TXN, brokerageId: B, trigger: "settlement_scanned", comparison: comparison ? { findings: comparison.findings.map((f) => f.term === "purchase_price" ? { ...f, verdict: "mismatch" as const, classification: "contradictory", settlement: "$505,000.00", blocking: true } : f) } : null, readFault: null }))))
    check("RACE: two identical callbacks at once → exactly ONE new snapshot (the second is a replay) — POSITIVE CONTROL: the first one did record", snaps(race).length === before + 1 && both2.filter((r) => r.snapshot.recorded).length === 1 && both2.filter((r) => r.snapshot.replay).length === 1, JSON.stringify(both2.map((r) => r.snapshot)))
    // an EXACT swing: the same statement's figures change and change back — the return to the first state is a NEW version
    const swing = seed()
    await run(swing)
    const cd = swing.tables.documents.find((d) => d.id === DOC_CD)!
    cd.extracted_fields = { ...CONSISTENT_CD, sales_price: "505000" }
    await run(swing)
    cd.extracted_fields = { ...CONSISTENT_CD }
    await run(swing)
    const sv = snaps(swing)
    check("A → B → A on the SAME document records THREE versions and the latest is the current state again (idempotency never swallows a real return)",
      sv.length === 3 && sv[0].evidence_json.fingerprint === sv[2].evidence_json.fingerprint && sv[1].evidence_json.fingerprint !== sv[0].evidence_json.fingerprint && sv[2].decision === "green", JSON.stringify(sv.map((s) => [s.evidence_json.version, s.decision])))
  }

  section("K · FAIL CLOSED — a refused read holds the close; it never reads as reconciled")
  {
    const refusedLedger = seed({ mem: { refuse: { policy_decisions: "permission denied for table policy_decisions" } } })
    const r = (await run(refusedLedger)).reconciliation
    check("the previous reconciliation cannot be read → COMPLIANCE BLOCKED and no snapshot written over an unread history", r?.reconciliation?.state === "compliance_blocked" && !r.snapshot.recorded && refusedLedger.tables.policy_decisions.length === 0)
    const refusedLog = seed({ mem: { refuse: { transaction_compliance_log: "permission denied for table transaction_compliance_log" } } })
    const g = await gate(refusedLog)
    check("the compliance log cannot be read → the close is REFUSED (the check could not run — nothing was verified)", g.blockers.some((b) => /could not run|could not be read/.test(b)), g.blockers.join(" | "))
  }

  section("L · THE CDA SIDE (coordinated with lane 152H's mode / effective policy) — enabling or disabling a CDA never bypasses the record")
  {
    const cdaDb = seed({ offersCda: true })
    await executed(cdaDb, DOC_ADD, { closing_cost_contribution: 10_000 }, { closing_cost_contribution: { page: 1, field: "Paragraph 4", quote: "Seller shall credit Buyer $10,000.00 at closing." } })
    const g = await gate(cdaDb)
    check("a CDA brokerage with the same missing $10,000 credit is held too (the record must be correct in both modes)", g.cdaMode === "cda" && g.blockers.some((b) => /Seller credit/.test(b)), g.blockers.join(" | "))
    check("…and the gate does NOT ask the closing question in CDA mode (the CDA submit door asks it) — POSITIVE CONTROL: the no-CDA deal in B was asked", !attest(cdaDb))
    const reviewed = seed({ offersCda: true, statement: null, extra: { closing_disclosure_agreement: [{ id: "cda-1", brokerage_id: B, transaction_id: TXN, final_cd_document_id: "td-final", preliminary_cd_document_id: "td-pre", field_values: { preliminary_statement: { status: "reviewed", version: 1, document_id: "td-pre", received_at: "2026-11-18T00:00:00Z", items: [], history: [] } }, updated_at: "2026-11-21T00:00:00Z" }] } })
    const rr = (await run(reviewed, "final_check")).reconciliation?.reconciliation
    check("CDA mode with the statement only on the CDA rail: a person's review in the CDA workflow is SAID (not re-claimed) and the attached final counts as on file", rr?.items.find((i) => i.key === "record")?.status === "advisory" && rr.record.finalOnFile === true, JSON.stringify(rr?.items.find((i) => i.key === "record")))
    const requested = seed({ offersCda: true, extra: { closing_disclosure_agreement: [{ id: "cda-2", brokerage_id: B, transaction_id: TXN, final_cd_document_id: null, preliminary_cd_document_id: null, field_values: { preliminary_statement: { status: "correction_requested", version: 1, requested_at: "2026-11-22T00:00:00Z", delivery: { route: "portal", recipient: "title", message_id: null, at: "2026-11-22T00:00:00Z" }, items: [], history: [] } }, updated_at: "2026-11-22T00:00:00Z" }] } })
    const rq = (await run(requested)).reconciliation?.reconciliation
    check("MONITOR: a correction requested from title (portal) with no newer statement read since → AWAITING the revision, request status 'requested'", rq?.state === "awaiting_revised_document" && rq.request.status === "requested" && !!rq.items.find((i) => i.key === "record.correction_requested")?.blocking)
    const unread = seed({ statement: null, extra: { transaction_documents: [{ id: "td-1", brokerage_id: B, transaction_id: TXN, doc_type: "final_settlement_statement", status: "uploaded" }] } })
    const ur = (await run(unread, "final_check")).reconciliation?.reconciliation
    check("WITHOUT a CDA, a statement uploaded but never READ holds the close (needs review) and the TC gets ONE request to put it through the reader — POSITIVE CONTROL: CDA mode with a human review does not",
      ur?.state === "needs_review" && ur.items.find((i) => i.key === "record")?.blocking === true && openTasks(unread).length === 1)
  }

  section("M · WIRING — the trigger matrix runs through EXISTING events; the close gate; no informational ask (stripped source)")
  {
    const cc = code("lib/transactions/closing-compliance.ts")
    const tail = cc.slice(cc.indexOf("export async function runClosingCompliance"))
    check("THE ONE closing check's tail reconciles AFTER the corrective requests and BEFORE the audit, and returns the result (every trigger of the check reconciles)",
      tail.indexOf("requestCorrections)(svc, tx") > 0 && tail.indexOf("defaultReconciler)(svc") > tail.indexOf("requestCorrections)(svc, tx") && tail.indexOf("defaultReconciler)(svc") < tail.indexOf("auditClosingRun)(tx") && /\n\s*reconciliation,\n\s*\}/.test(tail))
    const triggers = ["lib/documents/scan-uploaded-document.ts", "lib/offers/governing-terms-consequences.ts", "lib/transactions/final-compliance-check.ts"].filter((p) => /runClosingCompliance\(/.test(code(p)))
    check("the existing triggers reach that check: a statement / CD scanned, an executed addendum, the pre-CDA final check (no polling engine)", triggers.length === 3, triggers.join(", "))
    const sp = code("lib/transactions/stage-progression.ts")
    const can = sp.slice(sp.indexOf("export async function canAdvanceStage"), sp.indexOf("export async function advanceStage"))
    check("canAdvanceStage's CLOSED target runs the settlement hold BEFORE the compliance gate reads its rows (step 9)", can.indexOf("closingSettlementGate(") > 0 && can.indexOf("closingSettlementGate(") < can.indexOf("canProceedToClosingPrep(transactionId"))
    check("the closing question is ASKED only in stage-progression (beside the CDA submit door) and never INFORMATIONALLY any more; POSITIVE CONTROL: the finder sees a specimen",
      /ensureClosingAttestationAsked\(supabase/.test(can) && !/informational:\s*true/.test(sp) && !/ensureClosingAttestationAsked\(/.test(code("lib/offers/closing-cost-accuracy.ts")) && /informational:\s*true/.test(`ensureClosingAttestationAsked(db, { informational: true })`))
    check("the attestation writer has no informational branch (every ask is blocking)", !/is_blocking:\s*!informational/.test(code("lib/commission/closing-verification.ts")) && /is_blocking:\s*true/.test(code("lib/commission/closing-verification.ts")))
    const page = code("app/dashboard/transactions/[id]/cda/page.tsx")
    check("the deal's closing page shows the reconciliation in BOTH modes (not inside the no-CDA conditional)", /<SettlementReconciliationCard transactionId=\{id\} \/>/.test(page) && !/no_cda"\s*\?\s*<SettlementReconciliationCard/.test(page))
    const fc = code("lib/transactions/final-compliance-check.ts")
    check("the pre-CDA final check holds the CDA on a statement missing an executed money term / an unverified reading (the broker never approves on unreconciled figures)", /missing_on_document/.test(fc) && /unverified_reading/.test(fc) && /closing\.reconciliation/.test(fc))
    const trid = code("lib/compliance/trid-disclosure-clock-runner.ts")
    check("CORRECTED: the TRID clock's bell crosses agents.id → users.id before it writes notifications.user_id (CLAUDE.md §3)", trid.indexOf(`.from("agents").select("user_id")`) > 0 && trid.indexOf(`.from("agents").select("user_id")`) < trid.indexOf(`from("notifications").insert`))
    check("POSITIVE CONTROL: the order finder fails a specimen that writes the bell first", (() => { const s = `svc.from("notifications").insert({}); svc.from("agents").select("user_id")`; return !(s.indexOf(`.from("agents").select("user_id")`) < s.indexOf(`from("notifications").insert`)) })())
    const reg = code("lib/kernel/manager-registry.ts")
    check("the capability has an owning EXISTING manager and its proof key (compliance_officer · test:settlement-reconciliation)", /settlement_reconciliation:\s*\{\s*manager:\s*"compliance_officer",\s*proof:\s*"test:settlement-reconciliation"/.test(reg))
  }

  console.log("\nCRITICAL CASES (directive 152G): 1 → C · 2 → D · 3 → E · 4 → F · 5 → F · 6 → G · 7 → B (+L) · 8 → H · 9 → I · 10 → J")
  console.log("BLIND SPOTS: SIMULATED on scripts/in-memory-supabase.ts — no database, no provider, no model, no browser. The scanner does not")
  console.log("  extract apr / loan_product / prepayment_penalty today (they are read when stated; otherwise the TRID branch escalates to the lender —")
  console.log("  outside-lane request in the lane notes). canAdvanceStage itself is not driven (createServiceClient + session); its CLOSED branch is")
  console.log("  held by the stripped-source order scan and closingSettlementGate is driven directly. State title / closing-attorney rules are not")
  console.log("  modelled (escalated). A statement only on the transaction-documents rail is never READ by this check (it holds a no-CDA close).")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(`FAILED: ${failures.join(" | ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
