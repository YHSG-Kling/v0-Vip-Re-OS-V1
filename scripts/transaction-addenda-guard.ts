/**
 * scripts/transaction-addenda-guard.ts — test:transaction-addenda (wave 151, lane 151K; directive 151K; pure + in-memory, no DB,
 * no network, no model). Run with `tsx --conditions=react-server` (the closing-compliance / closing-verification modules reach
 * `server-only` transitively — the same idiom as test:closing-compliance and test:agreement-governance).
 *
 * Owner (binding): "addenda can happen during the transaction"; "L6 finish — if the brokerage doesn't use CDAs (their settings),
 * then it can close without a CDA."
 *
 * WHAT IT HOLDS:
 *   A · VERSIONED ADDENDA WITH EVIDENCE AND PRECEDENCE — the ONE rule (resolveGoverningTerms) driven: a later executed addendum
 *       governs, originals and every superseding version are kept, SIGNED EFFECTIVE LANGUAGE orders two addenda, and every changed
 *       term carries where it was read (termEvidenceFor: the document's extraction with its page, the person's stated page / field,
 *       or an honest "unlocated"); a VERIFIED extraction that contradicts the typed term REFUSES the record (positive control).
 *   B · CONFLICT → ESCALATION — two executed addenda, same day, one term, two values → UNRESOLVED (no governing value), reported for
 *       review; POSITIVE CONTROL: the version-number fold would have invented a winner and the resolver disagrees with it; a later
 *       executed instrument settles it; a cross-source tie keeps its source rank. Driven through the recorder on the in-memory
 *       client: the consequences carry the review, the admins are told, and compliance files a BLOCKING conflict row — with no
 *       settlement statement on file.
 *   C · CHANGED-TERMS-ONLY RE-CHECKS — a contingency change re-checks no price line and leaves the document checks and the fault rows
 *       alone (positive control: the full run writes them); a changed period re-derives its deadline from the contract date; an
 *       executed closing-date change moves the CONTRACTUAL date through the governed writer with the document as reference —
 *       the actual date untouched.
 *   D · AN ADDENDUM IS NEVER A NEW TRANSACTION — driven (transactions count unchanged) and scanned (no insert into transactions on
 *       the addendum path; positive control).
 *   E · CDA ENABLED — the agent fills (CDA_FILL_RULE), the AI COACHES WITHOUT A NUMBER (filterCoachWords withholds a foreign figure,
 *       keeps the agent's own; the brief carries the hard rules and no engine amount; the door never writes the CDA, names no model,
 *       gates before the service client, is booked by feature), the broker signs and title delivery is tracked (survivors driven).
 *   F · CDA DISABLED — the brokerage CLOSES WITHOUT A CDA: resolveCdaMode never blocks; the smallest honest closing proof
 *       (noCdaClosingProof) reads settlement + receipt + compliance + holds; FUNDS ARE NEVER ASSERTED FROM A DATE; the funds-received
 *       gate and CLOSED / PAYOUT PENDING stand; `paid` is terminal; the closing question is asked INFORMATIONALLY at the no-CDA
 *       close (option b) and BLOCKING on the CDA path (positive control); the proof door writes nothing.
 *   G · CLOSING DATE — the contract's words read (on / on or before), contractual vs anticipated vs actual distinct, an earlier actual
 *       close under "on or before" needs no amendment, lender / title / attorney coordinated by the deal coordinator's list.
 *   H · REGISTRATION — package key, guard chain, m986 (stamp line, trigger on the versions table).
 *
 * WAVE 152 (lane 152E — owner: "compliance also need to compare terms besides reading documents"; "even though the brokerage doesnt
 * support a cda, compliance still needs to accurate along with the closing disclosure. that is not informational."):
 *   I · THE TERM LEDGER — per governed term: source document / version, signed effective instant, signatures, page / quote, prior and
 *       new value, authority; a proposal is pending and never governs; a tie is unresolved; the vocabulary now holds property,
 *       parties, repairs, holdbacks and special conditions (and never selects a non-offers column — held to the generated cache).
 *   J · THE COMPARISON PIPELINE — signed addendum moves the price → the deal record and compliance re-evaluated (dependent commission
 *       lines too); a settlement still showing the replaced price is SUPERSEDED; wrong commission / credit → CONTRADICTORY + hold +
 *       corrective request (assigned, responsible party named); the corrected statement clears EXACTLY its hold and its request;
 *       a replayed scan opens nothing twice; an unrelated deal is untouched.
 *   K · NOT INFORMATIONAL — a deal record that drifted from the executed contract holds the closing (formatting never does); the
 *       "on or before" early close is a MATCH (no fabricated amendment; positive control: a fixed "on" day); the CDA-disabled deal
 *       with a consistent statement continues; the pre-CDA gate refuses while a hold is open.
 *   L · THE EVIDENCE HOLD (owner decision "refuse or flag" — the safe default): an executed term never located on its signed page
 *       holds the closing; a confident agreeing reading clears it; a confident disagreeing one is a contradiction.
 *   M · THE OVERRIDE RULE — a computed check is never "passed" by a person; a waiver needs the override authority + a written reason
 *       and is ledgered; no batch carries a computed or blocking check (pure rule driven; the doors read by stripped source).
 *
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2); every code-token scan reads STRIPPED source. Blind spots at the end.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  resolveGoverningTerms, foldTermsByPrecedence, termEvidenceFor, GOVERNING_TERM_KEYS, TERM_VERSION_SOURCES, endOfDayInstant,
  NOT_OFFER_COLUMN_TERM_KEYS, buildTermLedger, canonicalTerms,
  type TermsVersion,
} from "../lib/offers/governing-terms-rule"
import { recordContractTermsVersion, governingContractTerms, contractTermLedger } from "../lib/offers/governing-terms"
import { afterExecutedContractChange } from "../lib/offers/governing-terms-consequences"
import { runClosingCompliance } from "../lib/transactions/closing-compliance"
import { compareClosingTerms, compareDealRecordTerms, decideComplianceCheckChange } from "../lib/transactions/closing-compliance-core"
import { evaluateFinalCompliance } from "../lib/transactions/final-compliance-check"
import { resolveCdaMode, CDA_FILL_RULE, noCdaClosingProof, NO_CDA_CLOSING_PROOF_RULE, cdaDeliveryRoute, cdaDeadlineVerdict, deliveryIdempotency } from "../lib/transactions/cda-closing-policy"
import { canBrokerSignCda } from "../lib/transactions/cda-signing-policy"
import { CDA_COACH_RULE, allowedFigureSet, filterCoachWords, buildCoachBrief } from "../lib/commission/cda-coach-rule"
import { payoutFundsGate } from "../lib/commission/ledger-sync"
import { lifetimeConversionVerdict, LIFETIME_HOLD_LABEL } from "../lib/kernel/lifetime-conversion"
import { ensureClosingAttestationAsked, CLOSING_ATTESTATION_CHECK_TYPE } from "../lib/commission/closing-verification"
import { resolveClosingDates, assessClosingDateChange } from "../lib/transactions/closing-dates"
import { readClosingDateWording } from "../lib/transactions/contract-terms"

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

const B = "11111111-1111-4111-8111-111111111111"
const U_ADMIN = "22222222-2222-4222-8222-222222222222", U_AGENT = "22222222-2222-4222-8222-222222222223", AG = "33333333-3333-4333-8333-333333333333"
const ROOT_OFFER = "44444444-4444-4444-8444-444444444444", TXN = "55555555-5555-4555-8555-555555555555"
const DOC_A = "66666666-6666-4666-8666-666666666661", DOC_B = "66666666-6666-4666-8666-666666666662", DOC_C = "66666666-6666-4666-8666-666666666663", DOC_CD = "66666666-6666-4666-8666-666666666664"
const both = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] }
const v = (over: Partial<TermsVersion>): TermsVersion => ({ versionNo: 1, source: "offer", status: "executed", offerId: null, documentId: null, executedAt: "2026-10-01T00:00:00Z", terms: {}, derived: false, ...over })
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

function seed() {
  return memSupabase({
    brokerages: [{ id: B, name: "Guard Brokerage", state: "TX", offers_cda: false, non_cda_payout_default: "check", commission_payout_timing: null }],
    users: [{ id: U_ADMIN, brokerage_id: B, user_type: "broker_owner", email: "owner@example.test" }, { id: U_AGENT, brokerage_id: B, user_type: "agent", email: "agent@example.test" }],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: B }],
    offers: [{ id: ROOT_OFFER, brokerage_id: B, agent_id: AG, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "accepted", esign_status: "fully_executed", buyer_signed_at: "2026-10-01T10:00:00Z", seller_signed_at: "2026-10-01T12:00:00Z", fully_signed_contract_received_at: "2026-10-01T12:00:00Z", transaction_id: TXN, offer_price: 500_000, earnest_money: 5_000, closing_date: "2026-12-15", inspection_period_days: 10, created_at: "2026-10-01T09:00:00Z" }],
    transactions: [{ id: TXN, brokerage_id: B, agent_id: AG, coordinator_id: null, status: "under_contract", stage: "UNDER_CONTRACT", offer_id: ROOT_OFFER, deal_type: "buyer", purchase_price: 500_000, earnest_money: 5_000, closing_cost_contribution: null, contract_date: "2026-10-01", close_date: "2026-12-15", estimated_close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract", contract_closing_amendment_ref: null, actual_close_date: null, inspection_period_days: 10, appraisal_contingency_days: null, financing_contingency_days: null, inspection_deadline: "2026-10-11", appraisal_deadline: null, financing_deadline: null, property_state: "TX", financing_type: "conventional", commission_finalized_at: null, compliance_passed_at: "2026-10-02T00:00:00Z", buyer_contact_id: null, seller_contact_id: null, contact_id: null, listing_id: null, buyer_agent_id: null, seller_agent_id: null, listing_offered_commission_percentage: null, updated_at: "2026-10-02T00:00:00Z" }],
    documents: [
      { id: DOC_A, brokerage_id: B, transaction_id: TXN, classification: "addendum", signature_completeness: both, extracted_fields: null },
      { id: DOC_B, brokerage_id: B, transaction_id: TXN, classification: "addendum", signature_completeness: both, extracted_fields: null },
      // no scan blob on the fixture documents: the closing comparison reads every signed document in the file as an instrument, and a
      // blob price here would be a second (low-confidence) governing price — the evidence test below seeds a LEDGER row instead
      { id: DOC_C, brokerage_id: B, transaction_id: TXN, classification: "addendum", signature_completeness: both, extracted_fields: null },
    ],
    document_field_extractions: [],
    contract_term_versions: [],
    transaction_compliance_log: [],
    notifications: [],
    closing_disclosure_agreement: [],
    commission_distributions: [],
    agent_action_ledger: [],
    lifecycle_events: [],
    transaction_coordinators: [],
    activities: [],
  }, { uuidIds: true, stampCreatedAt: true })
}

async function main() {
  section("A · versioned addenda with evidence and precedence")
  {
    const original = v({ versionNo: 1, source: "offer", terms: { offer_price: 500_000, closing_date: "2026-12-15", title_policy_payer: "seller" } })
    const add1 = v({ versionNo: 1, source: "addendum", terms: { offer_price: 490_000 }, executedAt: "2026-10-20T23:59:59.999Z", documentId: DOC_A })
    const g = resolveGoverningTerms([original, add1])
    check("a later executed addendum governs the term it changes; the untouched terms stay from the original; every version is kept", g.values.offer_price === 490_000 && g.values.title_policy_payer === "seller" && g.versions.length === 2 && g.conflicts.some((c) => c.key === "offer_price" && c.superseded.value === 500_000))
    // signed effective language: both executed 10/25; A effective 11/01, B effective 11/05 → B governs (the later effective instant)
    const effA = v({ versionNo: 1, source: "addendum", terms: { offer_price: 490_000 }, executedAt: "2026-10-25T23:59:59.999Z", effectiveAt: endOfDayInstant("2026-11-01"), documentId: DOC_A })
    const effB = v({ versionNo: 2, source: "addendum", terms: { offer_price: 495_000 }, executedAt: "2026-10-25T23:59:59.999Z", effectiveAt: endOfDayInstant("2026-11-05"), documentId: DOC_B })
    const ge = resolveGoverningTerms([original, effB, effA])
    check("SIGNED EFFECTIVE LANGUAGE orders two same-day addenda: the one effective later governs (495,000), nothing unresolved", ge.values.offer_price === 495_000 && ge.unresolved.length === 0)
    const geRev = resolveGoverningTerms([original, v({ ...effA, versionNo: 1, effectiveAt: endOfDayInstant("2026-11-05") }), v({ ...effB, versionNo: 2, effectiveAt: endOfDayInstant("2026-11-01") })])
    check("…and the effective instant, not the recording number, decides (addendum 1 effective later wins: 490,000)", geRev.values.offer_price === 490_000)
    // evidence
    const ev = termEvidenceFor({ terms: { offer_price: 480_000, closing_date: "2026-12-20", earnest_money: 7_500 }, extractions: [{ field_key: "price", field_value_json: { value: "480,000", page: 2 }, confidence: "high", verified_at: null }], scanFields: null, stated: { closing_date: { page: 3, field: "Paragraph 9" } } })
    check("per-term evidence: the document's extraction (field + page + agrees), the person's stated page / field, and an honest 'unlocated' for the rest",
      ev.ok && ev.termEvidence.offer_price?.source === "document_extraction" && ev.termEvidence.offer_price?.page === 2 && ev.termEvidence.offer_price?.agrees === true
      && ev.termEvidence.closing_date?.source === "person_reading" && ev.termEvidence.closing_date?.page === 3 && ev.termEvidence.earnest_money?.source === "person_reading_unlocated" && ev.unlocated.join() === "earnest_money")
    const contra = termEvidenceFor({ terms: { offer_price: 480_000 }, extractions: [{ field_key: "price", field_value_json: "475000", confidence: "high", verified_at: "2026-10-21T00:00:00Z" }] })
    check("POSITIVE CONTROL: a VERIFIED extraction that reads a different value than the typed term REFUSES the record by name", !contra.ok && /disagree/.test(contra.reason))
    const low = termEvidenceFor({ terms: { offer_price: 480_000 }, extractions: [{ field_key: "price", field_value_json: "475000", confidence: "low", verified_at: null }] })
    check("a LOW-confidence disagreement is recorded with agrees:false (a question for a person, not a refusal)", low.ok && low.termEvidence.offer_price?.agrees === false)
    const rec = code("lib/offers/governing-terms.ts")
    check("the recorder attaches the evidence to every executed addendum / amendment and reads the document's extraction ledger (stripped source)", /termEvidenceFor\(/.test(rec) && /document_field_extractions/.test(rec) && /term_evidence/.test(rec))
  }

  section("B · two conflicting executed addenda → escalation, never invented precedence")
  {
    const original = v({ versionNo: 1, source: "offer", terms: { offer_price: 500_000 } })
    const t = "2026-10-25T23:59:59.999Z"
    const a1 = v({ versionNo: 1, source: "addendum", terms: { offer_price: 490_000 }, executedAt: t, documentId: DOC_A })
    const a2 = v({ versionNo: 2, source: "addendum", terms: { offer_price: 495_000 }, executedAt: t, documentId: DOC_B })
    const g = resolveGoverningTerms([original, a1, a2])
    check("two addenda executed the same day on one term with two values and no effective language → UNRESOLVED: no governing value, both listed, reason said",
      g.unresolved.length === 1 && g.unresolved[0].key === "offer_price" && g.unresolved[0].reason === "same_effective_instant" && g.unresolved[0].versions.length === 2 && !("offer_price" in g.values) && !g.terms.offer_price)
    const rank = (s: string) => (TERM_VERSION_SOURCES as readonly string[]).indexOf(s)
    const naive = foldTermsByPrecedence([original, a1, a2], GOVERNING_TERM_KEYS, rank)
    check("POSITIVE CONTROL: the version-number fold INVENTS a winner (addendum 2 → 495,000) — the resolver refuses to, so an invented precedence is caught", naive.won.offer_price?.value === 495_000 && naive.unresolved.length === 0 && g.values.offer_price === undefined)
    const rev = resolveGoverningTerms([original, v({ ...a1, executedAt: "2026-10-20T23:59:59.999Z", effectiveAt: endOfDayInstant("2026-11-01") }), v({ ...a2, executedAt: "2026-10-25T23:59:59.999Z" })])
    check("the effective language and the signing order CONTRADICT each other (signed earlier, effective later) → unresolved with its reason", rev.unresolved.length === 1 && rev.unresolved[0].reason === "effective_order_contradicts_execution_order")
    const a3 = v({ versionNo: 3, source: "addendum", terms: { offer_price: 492_000 }, executedAt: "2026-10-30T23:59:59.999Z", documentId: DOC_C })
    const settled = resolveGoverningTerms([original, a1, a2, a3])
    check("a LATER executed instrument restating the term settles it (492,000), and the two disputed values are kept as superseded history", settled.unresolved.length === 0 && settled.values.offer_price === 492_000 && settled.conflicts.filter((c) => c.key === "offer_price").length >= 2)
    const cross = resolveGoverningTerms([original, v({ versionNo: 2, source: "counter", terms: { offer_price: 2 }, executedAt: t }), v({ versionNo: 1, source: "addendum", terms: { offer_price: 3 }, executedAt: t, documentId: DOC_A })])
    check("a CROSS-source tie (counter vs addendum at one instant) keeps its source rank — the addendum follows the counter (unchanged rule)", cross.values.offer_price === 3 && cross.unresolved.length === 0)

    // driven through the recorder and the consequences on the in-memory client
    const db = seed()
    const D = day(3)
    const r1 = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 490_000 }, documentId: DOC_A, executedAt: `${D}T23:59:59.999Z`, recordedBy: U_AGENT, evidence: { recorded_via: "guard", executed_on: D } }))
    const r2 = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 495_000 }, documentId: DOC_B, executedAt: `${D}T23:59:59.999Z`, recordedBy: U_AGENT, evidence: { recorded_via: "guard", executed_on: D } }))
    check("DRIVEN: the first addendum records and governs; the second (same day, same term, another value) records too — history is never refused, the record is complete", r1.ok && r2.ok && db.tables.contract_term_versions.filter((r) => r.source === "addendum" && r.status === "executed").length === 2)
    const c2 = r2.ok ? r2.consequences : undefined
    check("…its consequences carry the REVIEW (one unresolved term), and the escalation reached the admins (a critical contract_terms_conflict notice)",
      !!c2 && c2.review.unresolved.length === 1 && c2.review.unresolved[0].key === "offer_price" && c2.review.escalated === true && db.tables.notifications.some((n) => n.type === "contract_terms_conflict" && n.user_id === U_ADMIN))
    check("…the disputed price was NOT mirrored onto the deal (no governing value): purchase_price stays what the first addendum made it", db.tables.transactions[0].purchase_price === 490_000)
    const row = db.tables.transaction_compliance_log.find((r) => r.check_type === "closing_terms.purchase_price")
    check("…and compliance filed a BLOCKING review row for the contradiction WITHOUT a settlement statement on file", !!row && row.status === "needs_review" && row.is_blocking === true && /two executed instruments disagree/.test(String(row.failure_reason)))
    const after = await governingContractTerms(db as never, B, { transactionId: TXN })
    check("the ONE reader reports the contradiction to every consumer (closing verification, the CDA page, compliance read it)", after.ok && after.governing.unresolved.length === 1)
    const evRow = db.tables.contract_term_versions.find((r) => r.document_id === DOC_A)
    check("each recorded version carries per-term evidence (here honestly 'unlocated' — the fixture document has no extraction) and the consequences flag it for the person", !!evRow?.evidence?.term_evidence?.offer_price && evRow.evidence.term_evidence.offer_price.source === "person_reading_unlocated" && (r1.ok ? r1.consequences?.review.unlocatedEvidence.includes("offer_price") === true : false))
    // extraction evidence on the record, and the verified contradiction refused by the recorder itself
    const db2 = seed()
    db2.tables.document_field_extractions.push({ brokerage_id: B, document_id: DOC_C, field_key: "price", field_value_json: { value: 480000, page: 2 }, confidence: "high", verified_at: "2026-10-21T00:00:00Z" })
    const okEv = await quiet(() => recordContractTermsVersion(db2 as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 480_000 }, documentId: DOC_C, executedAt: `${D}T23:59:59.999Z`, recordedBy: U_AGENT }, { consequences: false }))
    const badEv = await quiet(() => recordContractTermsVersion(db2 as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "amendment", status: "executed", terms: { offer_price: 470_000 }, documentId: DOC_C, executedAt: `${D}T23:59:59.999Z`, recordedBy: U_AGENT }, { consequences: false }))
    const evC = db2.tables.contract_term_versions.find((r) => r.source === "addendum")?.evidence?.term_evidence?.offer_price
    check("DRIVEN: the document's VERIFIED extraction (page 2) becomes the term's evidence; a term that contradicts that extraction is REFUSED by the recorder", okEv.ok && evC?.source === "document_extraction" && evC.page === 2 && evC.agrees === true && !badEv.ok && /disagree/.test(badEv.reason))
  }

  section("C · changed-terms-only re-checks; deadlines re-derived; the closing date through the governed writer")
  {
    // a deal WITH a settlement statement whose price disagrees with the contract
    const db = seed()
    db.tables.documents.push({ id: DOC_CD, brokerage_id: B, transaction_id: TXN, classification: "closing_disclosure", classification_confidence: "high", signature_completeness: null, extracted_fields: { sales_price: "505000", earnest_money_deposit: "5000" }, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", metadata: null })
    db.tables.transaction_compliance_log.push({ id: "stale-fault", brokerage_id: B, transaction_id: TXN, check_type: "closing_terms.inputs", check_label: "stale fault", status: "fail", is_blocking: true, failure_reason: "old fault [sig:fault|x]", created_at: "2026-10-01T00:00:00Z" })
    const notify = async () => 0
    const audit = async () => {}
    const scoped = await quiet(() => runClosingCompliance(db as never, { transactionId: TXN, brokerageId: B, trigger: "contract_addendum", changedTerms: ["inspection_period_days"] }, { notify, audit }))
    const rows = () => db.tables.transaction_compliance_log
    check("a contingency-period addendum re-check writes NO price row, NO document row, NO participant row, and leaves the stale fault row as it was",
      scoped.ran && !rows().some((r) => r.check_type === "closing_terms.purchase_price") && !rows().some((r) => String(r.check_type).startsWith("closing_docs.")) && !rows().some((r) => String(r.check_type).startsWith("closing_participants.")) && rows().find((r) => r.id === "stale-fault")?.status === "fail")
    const priceScoped = await quiet(() => runClosingCompliance(db as never, { transactionId: TXN, brokerageId: B, trigger: "contract_addendum", changedTerms: ["offer_price"] }, { notify, audit }))
    check("a PRICE addendum re-check writes the price row (the statement's 505,000 vs the contract's 500,000 → fail, blocking) and still no earnest-money or document row",
      priceScoped.ran && rows().find((r) => r.check_type === "closing_terms.purchase_price")?.status === "fail" && !rows().some((r) => r.check_type === "closing_terms.earnest_money") && !rows().some((r) => String(r.check_type).startsWith("closing_docs.")))
    const full = await quiet(() => runClosingCompliance(db as never, { transactionId: TXN, brokerageId: B, trigger: "manual" }, { notify, audit }))
    check("POSITIVE CONTROL: the FULL run writes the earnest-money row and clears the stale fault row", full.ran && rows().some((r) => r.check_type === "closing_terms.earnest_money") && rows().find((r) => r.id === "stale-fault")?.status === "pass")
    const core = compareClosingTerms({}, {}, { purchase_price: { winner: { unit: "usd", value: 495_000, confidence: "record", source: "addendum 2" }, loser: { unit: "usd", value: 490_000, confidence: "record", source: "addendum 1" } } })
    check("the pure comparison files a conflict even when neither side states the term (the paper contradicts itself)", core.findings.length === 1 && core.findings[0].verdict === "conflict" && core.findings[0].blocking === true)

    // deadlines: a changed inspection period re-derives inspection_deadline from the contract date
    const db3 = seed()
    const stub = { runClosingCompliance: async () => ({ ran: true, openBlocking: 0, reason: null }) }
    const c = await quiet(() => afterExecutedContractChange(db3 as never, { brokerageId: B, transactionId: TXN, rootOfferId: ROOT_OFFER, versionNo: 1, source: "addendum", changedTerms: { inspection_period_days: 14 }, documentId: DOC_A, executedOn: day(2), recordedBy: U_AGENT }, stub))
    check("a changed contingency period mirrors onto the deal and re-derives its deadline date (contract 2026-10-01 + 14 → 2026-10-15); no money moved", db3.tables.transactions[0].inspection_period_days === 14 && db3.tables.transactions[0].inspection_deadline === "2026-10-15" && c.deadlines?.updated.includes("inspection_deadline") === true && !c.impact.moneyMoved)
    // closing date: through the governed writer, document as reference, actual untouched
    const db4 = seed()
    const cd = await quiet(() => afterExecutedContractChange(db4 as never, { brokerageId: B, transactionId: TXN, rootOfferId: ROOT_OFFER, versionNo: 1, source: "amendment", changedTerms: { closing_date: "2026-12-22" }, documentId: DOC_B, executedOn: day(2), recordedBy: U_AGENT }, stub))
    const t4 = db4.tables.transactions[0]
    check("an executed closing-date change moves the CONTRACTUAL date through applyClosingDateChange (source executed_amendment, the document as reference); the actual date stays null",
      cd.closingDate?.recorded === true && t4.contract_closing_date === "2026-12-22" && t4.contract_closing_source === "executed_amendment" && String(t4.contract_closing_amendment_ref) === `document:${DOC_B}` && t4.actual_close_date === null && t4.contract_closing_terms === "on_or_before")
    const db5 = seed()
    const noPerson = await quiet(() => afterExecutedContractChange(db5 as never, { brokerageId: B, transactionId: TXN, rootOfferId: ROOT_OFFER, versionNo: 1, source: "amendment", changedTerms: { closing_date: "2026-12-22" }, documentId: DOC_B, executedOn: day(2), recordedBy: null }, stub))
    check("POSITIVE CONTROL: without the recording person the closing date is NOT moved (a system never records a person's amendment) — said, not done", noPerson.closingDate?.recorded === false && db5.tables.transactions[0].contract_closing_date === "2026-12-15")
    const cons = code("lib/offers/governing-terms-consequences.ts")
    check("the runner hands compliance ONLY the changed terms and the unresolved set, and uses the executed_amendment kind (stripped source)", /changedTerms:\s*Object\.keys\(input\.changedTerms\)/.test(cons) && /kind:\s*"executed_amendment"/.test(cons) && /unresolved/.test(cons))
  }

  section("D · an addendum is never a new transaction")
  {
    const db = seed()
    const before = db.tables.transactions.length
    const r = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { earnest_money: 7_500 }, documentId: DOC_A, executedAt: `${day(2)}T23:59:59.999Z`, recordedBy: U_AGENT }))
    check("DRIVEN: recording an executed addendum on a deal leaves the transactions table at the same count", r.ok && db.tables.transactions.length === before)
    const INSERT_TX = /from\("transactions"\)\s*\.insert\(/
    const files = ["app/actions/buyer-offer/record-contract-addendum.ts", "lib/offers/governing-terms.ts", "lib/offers/governing-terms-consequences.ts", "lib/offers/governing-terms-rule.ts"]
    const hits = files.filter((p) => INSERT_TX.test(bare(p)))
    check("no file on the addendum path inserts a transaction (stripped source)", hits.length === 0, hits.join(", "))
    check("POSITIVE CONTROL: the finder recognises a specimen insert", INSERT_TX.test(`svc.from("transactions").insert({ id })`))
    check("the accepted-sequence rule reads offers rows only — a contract_term_versions row is never a chain member", !/contract_term_versions/.test(code("lib/offers/governing-terms-rule.ts").split("export function acceptedOfferSequence")[1] ?? "x"))
  }

  section("E · CDA enabled — the agent fills, the AI coaches without a number, the broker signs, title delivery is tracked")
  {
    check("CDA_FILL_RULE: agent fills, AI never fills; CDA_COACH_RULE: explains, proposes no number, fills nothing, figures only from the agent and the contract",
      CDA_FILL_RULE.agentFills && !CDA_FILL_RULE.aiFills && CDA_COACH_RULE.explainsArithmetic && !CDA_COACH_RULE.proposesNumbers && CDA_COACH_RULE.fillsCda === false && CDA_COACH_RULE.figuresOnlyFromAgentAndContract)
    const figures = { agentEntered: { grossCommission: 15_000, agentNet: 10_500, brokerageNet: 4_500 }, contract: { purchasePrice: 500_000, commissionPercentage: 3 } }
    const allowed = allowedFigureSet(figures)
    const f = filterCoachWords("Your gross of $15,000 is 3% of the $500,000 price. The referral fee of $1,500 comes off before the split. Your agent net should be $12,150. The cap counts the brokerage share.", allowed)
    check("THE FILTER withholds every sentence carrying a figure the agent did not enter and the contract does not state (the referral amount, the proposed net), keeps the rest",
      f.withheld === 2 && f.sentences.length === 4 && /15,000/.test(f.sentences[0]) && /withheld/.test(f.sentences[1]) && /withheld/.test(f.sentences[2]) && /cap counts/.test(f.sentences[3]))
    check("POSITIVE CONTROL: a sentence with only the agent's own figures passes untouched", filterCoachWords("Gross $15,000; agent net $10,500.", allowed).withheld === 0)
    const brief = buildCoachBrief({ structure: { referralApplies: true, capReached: false, teamSplitApplies: null, outstandingFeesExist: true, cdaMode: "cda" }, figures, discrepancies: [{ field: "agent_split", severity: "blocker" }] })
    check("THE BRIEF carries the hard rules (never propose a figure), the step order, the agent's own figures, the check's WORDS — and no expected figure",
      /NEVER propose/.test(brief.system) && /referral fee/.test(brief.prompt) && /agent split \(blocker\)/.test(brief.prompt) && /Do not state the expected figure/.test(brief.prompt) && !/expected:\s*\d/.test(brief.prompt))
    const steps = readdirSync(join(ROOT, "lib/commission/waterfall")).filter((x) => /^\d\d[a-z]?-.*\.ts$/.test(x) && !x.startsWith("11-")).map((x) => x.replace(/\.ts$/, "")).sort()
    // the step list is module-private (its one reader is buildCoachBrief): read it off the source, then hold it to the engine's step modules
    const listed = [...code("lib/commission/cda-coach-rule.ts").matchAll(/step:\s*"(\d\d[a-z]?-[a-z-]+)"/g)].map((m) => m[1])
    check("the coach's step order is the engine's step modules (every step 01–10 named once; 11 validates and persists)", JSON.stringify([...listed].sort()) === JSON.stringify(steps) && new Set(listed).size === listed.length, `${steps.join(",")} vs ${listed.join(",")}`)
    const door = code("app/actions/transactions/cda-coach.ts"), doorBare = bare("app/actions/transactions/cda-coach.ts")
    check("THE DOOR: every export async; the session gate (requireAuth) precedes the service client; the ONE AI entry point by feature; it never writes the CDA; it names no model",
      !/export (?!async function)/.test(door) && door.indexOf("requireAuth(") < door.indexOf("createServiceClient()") && /generateAIResponse\(/.test(door) && /feature:\s*COACH_FEATURE/.test(door)
      && !/from\("closing_disclosure_agreement"\)\s*\.(update|insert|upsert|delete)/.test(doorBare) && !/anthropic|openai|gpt-|claude-|sonnet|haiku|opus/i.test(doorBare))
    check("POSITIVE CONTROL: the CDA-write finder and the model-name finder each recognise a specimen", /from\("closing_disclosure_agreement"\)\s*\.(update|insert)/.test(`svc.from("closing_disclosure_agreement").update({ agent_net: 1 })`) && /anthropic|openai/i.test(`model: "openai/x"`))
    check("the coach is REACHABLE: the CDA page renders the coach card in CDA mode and the card calls the door", /CdaCoachCard/.test(code("app/dashboard/transactions/[id]/cda/page.tsx")) && /explainCdaArithmeticAction\(/.test(code("app/dashboard/transactions/[id]/cda/cda-coach-card.tsx")))
    // the broker signs; title delivery tracked (survivors)
    check("the broker signs: canBrokerSignCda admits a broker seat on an approved CDA and refuses the agent", canBrokerSignCda({ status: "approved", brokerSigned: false, role: "broker_owner" }).ok === true && canBrokerSignCda({ status: "approved", brokerSigned: false, role: "agent" }).ok === false)
    const route = cdaDeliveryRoute({ titlePortalUserId: "t1", titleEmail: "title@example.test" })
    const dedupe = deliveryIdempotency({ sentToTitleAt: "2026-12-10T00:00:00Z", recipient: "title@example.test" })
    const due = cdaDeadlineVerdict({ dueAt: new Date(Date.now() + 6 * 3_600_000).toISOString(), now: new Date(), sentToTitleAt: null, status: "approved", usesCda: true })
    check("title delivery tracked: the portal route when title is on the deal team, a recorded delivery is never repeated, an undelivered approved CDA escalates near the deadline", route.route === "portal" && dedupe.ok === false && due.state === "escalate" && due.escalates)
  }

  section("F · CDA disabled — the brokerage closes WITHOUT a CDA; the honest proof; the holds stand")
  {
    const no = resolveCdaMode({ offersCda: false, nonCdaPayoutDefault: "check" }), yes = resolveCdaMode({ offersCda: true })
    check("the ONE switch: CDA disabled → no CDA required and NOTHING blocks closing (and a CDA never blocks closing in CDA mode either)", !no.cdaRequired && no.blocksClosing === false && yes.blocksClosing === false && NO_CDA_CLOSING_PROOF_RULE.cdaNeverRequiredToClose)
    const closedNoReceipt = noCdaClosingProof({ cdaMode: no, transaction: { status: "closed", close_date: "2026-12-10", actual_close_date: "2026-12-10", compliance_passed_at: "2026-12-01T00:00:00Z" }, finalSettlement: { documentId: DOC_CD, uploadedAt: "2026-12-10T00:00:00Z", uploadedBy: "title-user", uploadedByType: "title" }, commissions: [{ id: "c1", status: "approved", deposit_received_at: null }], openBlockingCompliance: 0, lifetimeHoldOpen: true })
    check("FUNDS ARE NEVER ASSERTED FROM A DATE: a CLOSED deal with a closing date and no recorded receipt reads 'not received', payout held, CLOSED / PAYOUT PENDING open, the receipt named as missing",
      closedNoReceipt.closed && closedNoReceipt.fundsReceived === false && closedNoReceipt.payout.state === "held_funds_not_received" && closedNoReceipt.payout.lifetimeHold === "open" && closedNoReceipt.missing.some((m) => /receipt/.test(m)) && closedNoReceipt.blocksClosing === false)
    const complete = noCdaClosingProof({ cdaMode: no, transaction: { status: "closed", compliance_passed_at: "2026-12-01T00:00:00Z" }, finalSettlement: { documentId: DOC_CD, uploadedAt: "2026-12-10T00:00:00Z", uploadedBy: "title-user", uploadedByType: "title" }, commissions: [{ id: "c1", status: "approved", deposit_received_at: "2026-12-11T00:00:00Z", deposit_received_by: U_ADMIN }], openBlockingCompliance: 0, lifetimeHoldOpen: false })
    check("the smallest honest proof is COMPLETE when the final settlement record (with its actor), the brokerage's recorded receipt (who, when) and passed compliance are all on file — payout releasable under the approved disbursement",
      complete.missing.length === 0 && complete.fundsReceived && complete.receipt.by === U_ADMIN && complete.settlement.actor === "title:title-user" && complete.payout.state === "releasable_after_receipt")
    const open = noCdaClosingProof({ cdaMode: no, transaction: { status: "closed", compliance_passed_at: null }, finalSettlement: null, commissions: [], openBlockingCompliance: 2, lifetimeHoldOpen: false })
    check("…and says exactly what is missing: settlement, commission row, open blocking compliance", open.missing.length === 3 && open.compliance.status === "open_blocking")
    const inCda = noCdaClosingProof({ cdaMode: yes, transaction: { status: "closed" }, finalSettlement: null, commissions: [], openBlockingCompliance: 0, lifetimeHoldOpen: false })
    check("no artificial CDA: in CDA mode the reading says the CDA workflow is the proof; in no-CDA mode nothing requires a CDA row", inCda.missing.length === 1 && /CDA workflow/.test(inCda.missing[0]) && !/CDA/.test(open.missing.join(" ")))
    const gate = payoutFundsGate({ deposit_received_at: null }), gateAdv = payoutFundsGate({ deposit_received_at: null }, "wire confirmed by phone with title")
    check("the once-only payment holds stand: the funds-received gate refuses without a recorded receipt (an advance needs a stated reason), and `paid` is a terminal status (no transition out of it)",
      gate.ok === false && gateAdv.ok === true && /paid:\s*\[\]/.test(code("lib/kernel/financial.ts")))
    check("CLOSED / PAYOUT PENDING: the lifetime verdict holds a closed deal when the tenant requires a verified payout and none is recorded", lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: true }).label === LIFETIME_HOLD_LABEL)
    // the closing question: informational at the no-CDA close (option b), blocking on the CDA path (positive control)
    const db = seed()
    const info = await ensureClosingAttestationAsked(db as never, { brokerageId: B, transactionId: TXN, informational: true })
    const infoRow = db.tables.transaction_compliance_log.find((r) => r.check_type === CLOSING_ATTESTATION_CHECK_TYPE)
    const dbC = seed()
    await ensureClosingAttestationAsked(dbC as never, { brokerageId: B, transactionId: TXN })
    const cdaRow = dbC.tables.transaction_compliance_log.find((r) => r.check_type === CLOSING_ATTESTATION_CHECK_TYPE)
    check("the no-CDA close asks the closing question INFORMATIONALLY (pending, NOT blocking — option b); POSITIVE CONTROL: the CDA path's ask is blocking", info.ok && infoRow?.status === "pending" && infoRow?.is_blocking === false && cdaRow?.is_blocking === true)
    const sp = code("lib/transactions/stage-progression.ts")
    const i = sp.indexOf("closedWithoutCda) {")
    check("the gated close asks it only when the brokerage closed WITHOUT a CDA (finalizeCommissionAtClose's ONE switch), informational, non-blocking", i > 0 && /informational:\s*true/.test(sp.slice(i, i + 600)) && /finalized\.offersCda/.test(sp))
    const proofDoor = code("app/actions/transactions/closing-proof.ts"), proofBare = bare("app/actions/transactions/closing-proof.ts")
    check("THE PROOF DOOR: every export async; session actor + mayAttestClosing before the service client's reads; it WRITES NOTHING (no insert / update / upsert / delete)",
      !/export (?!async function)/.test(proofDoor) && proofDoor.indexOf("resolveSessionActor()") < proofDoor.indexOf("createServiceClient()") && /mayAttestClosing\(/.test(proofDoor) && !/\.(insert|update|upsert|delete)\(/.test(proofBare))
    check("POSITIVE CONTROL: the write finder recognises a specimen", /\.(insert|update)\(/.test(`db.from("x").update({})`))
    check("the proof is REACHABLE: the CDA page renders the closing-proof card in no-CDA mode and the card calls the door", /ClosingProofCard/.test(code("app/dashboard/transactions/[id]/cda/page.tsx")) && /getNoCdaClosingProofAction\(/.test(code("app/dashboard/transactions/[id]/cda/closing-proof-card.tsx")))
    check("no AI pre-fill anywhere on the no-CDA path (the proof rule, the door, the card name no model door)", !/generateAIResponse|bookedGenerateObject|runPipeline/.test(bare("lib/transactions/cda-closing-policy.ts") + proofBare + bare("app/dashboard/transactions/[id]/cda/closing-proof-card.tsx")))
  }

  section("G · closing date — contractual / anticipated / actual; on or before; early actual close without amendment")
  {
    const onOrBefore = readClosingDateWording("Closing Date: The closing shall occur on or before December 15, 2026 at the office of the title company.", { expectedDate: "2026-12-15" })
    const fixed = readClosingDateWording("The closing shall take place on December 15, 2026.", { expectedDate: "2026-12-15" })
    check("the executed contract's words are READ (no model): 'on or before' and a fixed 'on' day", onOrBefore.terms === "on_or_before" && fixed.terms === "on")
    const deal = { status: "under_contract", close_date: "2026-12-15", estimated_close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract", property_state: "TX", financing_type: "conventional" }
    const early = assessClosingDateChange(deal, { date: "2026-12-09", kind: "anticipated" })
    check("an earlier actual closing under 'on or before' is within the contract and needs NO executed amendment; lender (TRID), title / escrow and the CDA are coordinated", early.withinContract === true && early.requiresExecutedAmendment === false && early.coordinate.some((c) => /lender/.test(c)) && early.coordinate.some((c) => /title/.test(c)))
    check("POSITIVE CONTROL: a fixed 'on' day moved earlier needs every party's amendment", assessClosingDateChange({ ...deal, contract_closing_terms: "on" }, { date: "2026-12-09", kind: "anticipated" }).requiresExecutedAmendment === true)
    const closed = resolveClosingDates({ ...deal, status: "closed", actual_close_date: "2026-12-09", close_date: "2026-12-09", scheduled_closing_date: "2026-12-09" })
    check("the three dates stay DISTINCT facts: contractual on-or-before 12-15, actual 12-09 — and no amendment reference was invented", closed.contractual?.date === "2026-12-15" && closed.contractual?.terms === "on_or_before" && closed.actual?.date === "2026-12-09" && closed.contractual?.amendmentRef === null)
    const anticipated = resolveClosingDates({ ...deal, estimated_close_date: "2026-12-09" })
    check("an anticipated earlier day moves only the anticipated date (the contract's deadline and wording unchanged)", anticipated.anticipated?.date === "2026-12-09" && anticipated.contractual?.date === "2026-12-15" && anticipated.earlierClosing?.allowed === true)
  }

  section("H · registration")
  {
    const pkg = raw("package.json")
    // run under --conditions=react-server like its siblings (test:closing-compliance, test:agreement-governance): the closing
    // compliance and verification modules reach `server-only` transitively, which that condition resolves to an empty module
    // "runs it", not "ends with it": every lane appends its own proof after this one (CLAUDE.md §2 — never pin a waypoint).
    check("package.json carries test:transaction-addenda (under react-server) and the guard chain runs it", /"test:transaction-addenda":\s*"tsx --conditions=react-server scripts\/transaction-addenda-guard\.ts"/.test(pkg) && /npm run test:transaction-addenda(?= &&|")/.test(pkg))
    const mig = raw("supabase/migrations/m986-contract-term-versions-are-immutable-history.sql")
    const line1 = mig.split("\n")[0] ?? ""
    // The RULE, not the waypoint (CLAUDE.md §2): line 1 is ONE of the two honest stamps — the lane's "written, not applied" or the
    // integrator's "applied live" — never prose that claims both; the stamp line carries no migration token either way.
    const stamped = line1.startsWith("-- WRITTEN, NOT APPLIED (wave 151, lane 151K)") || /^-- ── APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP/.test(line1)
    check("m986 exists, its first line is exactly one honest stamp (lane or applied) with no migration token on it, and it puts the immutability trigger on contract_term_versions",
      mig.length > 0 && stamped && !/\bm\d{3}\b/.test(line1) && /CREATE TRIGGER contract_term_versions_immutable_trg/.test(mig) && /BEFORE UPDATE OR DELETE ON public\.contract_term_versions/.test(mig))
    check("POSITIVE CONTROL: a line 1 that is neither stamp is refused", !(["-- m986 — applied, trust me", ""].some((l) => l.startsWith("-- WRITTEN, NOT APPLIED (wave 151, lane 151K)") || /^-- ── APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP/.test(l))))
    check("the migration admits the one legitimate transition (executed → void, evidence only added) and refuses DELETE", /NEW\.status <> 'void'/.test(mig) && /NEW\.evidence @> OLD\.evidence/.test(mig) && /TG_OP = 'DELETE'/.test(mig))
  }

  // ═══ WAVE 152 (lane 152E) — compliance as a comparison and governed decision engine ═══
  const U_TC = "22222222-2222-4222-8222-222222222224", U_BROKER = U_ADMIN
  const TXN2 = "55555555-5555-4555-8555-555555555556", OFFER2 = "44444444-4444-4444-8444-444444444445"
  const DOC_HALF = "66666666-6666-4666-8666-666666666665"
  /** A CDA-DISABLED brokerage (offers_cda false — no CDA row anywhere), one executed contract, its TC, a consistent final statement,
   *  and an UNRELATED second deal with its own open row and request (to prove it is never touched). */
  const seed152 = (o: { statement?: Record<string, unknown>; wording?: string | null; txPrice?: unknown } = {}) => {
    const db = seed()
    const t = db.tables.transactions[0]
    Object.assign(t, { coordinator_id: U_TC, deal_type: "buyer", contract_closing_terms: o.wording === undefined ? "on_or_before" : o.wording, closing_cost_contribution: 3_000, purchase_price: o.txPrice ?? 500_000 })
    Object.assign(db.tables.offers[0], { closing_cost_contribution: 3_000, disclosed_buyer_commission_pct: 2.5 })
    db.tables.users.push({ id: U_TC, brokerage_id: B, user_type: "tc", email: "tc@example.test" })
    db.tables.documents.push({ id: DOC_CD, brokerage_id: B, transaction_id: TXN, classification: "closing_disclosure", classification_confidence: "high", signature_completeness: null, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z", metadata: null,
      extracted_fields: o.statement ?? { sales_price: "500000", earnest_money_deposit: "5000", seller_credit_to_buyer: "3000", commission_buyer_broker: "12500", closing_date: "2026-12-15" } })
    db.tables.offers.push({ id: OFFER2, brokerage_id: B, agent_id: AG, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "accepted", esign_status: "fully_executed", buyer_signed_at: "2026-10-02T10:00:00Z", seller_signed_at: "2026-10-02T12:00:00Z", fully_signed_contract_received_at: "2026-10-02T12:00:00Z", transaction_id: TXN2, offer_price: 300_000, created_at: "2026-10-02T09:00:00Z" })
    db.tables.transactions.push({ ...t, id: TXN2, offer_id: OFFER2, purchase_price: 300_000, coordinator_id: U_TC })
    db.tables.transaction_compliance_log.push({ id: "other-deal-row", brokerage_id: B, transaction_id: TXN2, check_type: "closing_terms.purchase_price", check_label: "other deal", status: "fail", is_blocking: true, failure_reason: "x [sig:mismatch|a|b]", created_at: "2026-11-01T00:00:00Z" })
    ;(db.tables.transaction_tasks ??= []).push({ id: "other-deal-task", brokerage_id: B, transaction_id: TXN2, title: "[Compliance correction] Purchase price matches the settlement", category: "compliance_correction", status: "pending" })
    return db
  }
  const stubs = { notify: async () => 0, audit: async () => {}, closingEntity: async () => "title_company" as string | null }
  const logOf = (db: ReturnType<typeof seed>, type: string, tx = TXN) => db.tables.transaction_compliance_log.find((r) => r.check_type === type && r.transaction_id === tx)
  const tasksOf = (db: ReturnType<typeof seed>, tx = TXN) => (db.tables.transaction_tasks ?? []).filter((r) => r.transaction_id === tx && r.category === "compliance_correction")
  const untouched = (db: ReturnType<typeof seed>) => logOf(db, "closing_terms.purchase_price", TXN2)?.status === "fail" && logOf(db, "closing_terms.purchase_price", TXN2)?.failure_reason === "x [sig:mismatch|a|b]" && (db.tables.transaction_tasks ?? []).find((r) => r.id === "other-deal-task")?.status === "pending"
  const stated = (page: number) => ({ offer_price: { page, field: "Paragraph 3", quote: "The Purchase Price is amended to $490,000." } })

  section("I · the term ledger — a read of every governed term, with its source, signatures, evidence and authority")
  {
    const db = seed152()
    const rec = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 490_000 }, documentId: DOC_A, executedAt: `${day(3)}T23:59:59.999Z`, recordedBy: U_AGENT, evidence: { recorded_via: "guard", effective_on: day(2), term_evidence_stated: stated(1) } }, { consequences: false }))
    const prop = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "proposed", terms: { offer_price: 470_000, repair_credit: 2_500 }, recordedBy: U_AGENT }, { consequences: false }))
    const L = await contractTermLedger(db as never, B, { transactionId: TXN })
    const price = L.ok ? L.ledger.rows.find((r) => r.key === "offer_price") : undefined
    check("THE LEDGER names, for the governing price: the executed addendum and its document, the SIGNED EFFECTIVE instant, both signatures, the page / field / quote, the PRIOR and NEW value, who recorded it and the authority in words",
      rec.ok && !!price && price.status === "governing" && price.value === 490_000 && price.priorValue === 500_000 && price.source?.kind === "addendum" && price.source.documentId === DOC_A
      && price.effectiveAt === endOfDayInstant(day(2)) && price.signatures?.missing.length === 0 && price.signatures?.signed.join() === "buyer,seller" && price.evidence?.source === "person_reading" && price.evidence.page === 1 && /amended to \$490,000/.test(String(price.evidence.quote))
      && price.recordedBy === U_AGENT && /signed by buyer and seller/.test(price.authority), JSON.stringify(price))
    check("a PROPOSED (unsigned) addendum is listed as pending beside the term and NEVER governs it; a term only a proposal names reads 'proposed only' with no value",
      prop.ok && price?.pending.some((p) => p.value === 470_000) === true && L.ok && L.ledger.rows.find((r) => r.key === "repair_credit")?.status === "proposed_only" && L.ledger.rows.find((r) => r.key === "repair_credit")?.value === null)
    check("…and the deal is not moved by the proposal: the transaction price is untouched (no consequences ran for a proposal)", db.tables.transactions[0].purchase_price === 500_000)
    check("the ledger carries the executed contract's closing wording and names every group no instrument states (never defaulted)", L.ok && L.ledger.closingWording === "on_or_before" && L.ledger.notStated.some((g) => g.group === "repairs_and_conditions"))
    // the pure ledger over a tie: no value, the contenders, the person who decides
    const t = "2026-10-25T23:59:59.999Z"
    const tied = buildTermLedger(resolveGoverningTerms([v({ terms: { offer_price: 500_000 } }), v({ versionNo: 1, source: "addendum", terms: { offer_price: 490_000 }, executedAt: t, documentId: DOC_A }), v({ versionNo: 2, source: "addendum", terms: { offer_price: 495_000 }, executedAt: t, documentId: DOC_B })]))
    const tr = tied.rows.find((r) => r.key === "offer_price")
    check("UNCERTAIN PRECEDENCE: two same-day executed addenda → the ledger row has NO value, lists both contenders and names the licensed professional / closing attorney — never a version-number winner", tr?.status === "unresolved" && tr.value === null && tr.unresolved?.length === 2 && /licensed professional or closing attorney/.test(tr.authority))
    // the vocabulary: property, parties, repairs, holdbacks, special conditions are governed terms now
    const ok152 = canonicalTerms({ repair_credit: 2_500, repair_holdback: 1_000, buyer_names: ["Ann Buyer"], seller_names: ["Sam Seller"], property_address: "1 Main St", special_conditions: "Seller to leave the washer." })
    check("an executed repair-credit / holdback / party / property / special-conditions term is IN the vocabulary (the recorder used to refuse it); POSITIVE CONTROL: an unknown key is still refused by name", ok152.unknownKeys.length === 0 && canonicalTerms({ repair_credit_typo: 1 }).unknownKeys.join() === "repair_credit_typo")
    const every = buildTermLedger(resolveGoverningTerms([v({ terms: Object.fromEntries(GOVERNING_TERM_KEYS.map((k) => [k, 1])) })]))
    check("every governed term belongs to exactly one ledger group (none falls to 'other')", every.rows.length === GOVERNING_TERM_KEYS.length && every.rows.every((r) => r.group !== "other"))
    // the RULE that keeps the ONE reader readable: every key it selects as an offers column IS a live offers column (generated cache)
    const snap = raw("scripts/schema-snapshot.ts")
    const offersCols = new Set((/\n\s*offers:\s*\[([^\]]*)\]/.exec(snap)?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean))
    const selected = GOVERNING_TERM_KEYS.filter((k) => !NOT_OFFER_COLUMN_TERM_KEYS.has(k))
    const absent = selected.filter((k) => !offersCols.has(k))
    check("every governed key the ONE reader selects from `offers` is a column in the generated schema cache (a recorded-only key can never become a refused 42703 read)", offersCols.size > 50 && absent.length === 0, absent.join(", "))
    check("POSITIVE CONTROL: the finder recognises a recorded-only key that would be selected as an offers column", !offersCols.has("repair_credit") && !offersCols.has("buyer_names"))
    const cons = await quiet(() => afterExecutedContractChange(seed() as never, { brokerageId: B, transactionId: null, rootOfferId: ROOT_OFFER, versionNo: 1, source: "addendum", changedTerms: { repair_credit: 2_500 }, documentId: DOC_A, executedOn: day(2), recordedBy: U_AGENT }))
    check("an executed repair credit reaches the money it moves (seller credit / seller net / settlement lines → the CDA and ledger paths follow)", cons.impact.moneyMoved && cons.impact.obligations.includes("seller_credit") && cons.impact.obligations.includes("settlement_lines"))
    // missing signatures block executed status
    db.tables.documents.push({ id: DOC_HALF, brokerage_id: B, transaction_id: TXN, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] }, extracted_fields: null })
    const half = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 480_000 }, documentId: DOC_HALF, executedAt: `${day(1)}T23:59:59.999Z`, recordedBy: U_AGENT }, { consequences: false }))
    const after = await contractTermLedger(db as never, B, { transactionId: TXN })
    check("MISSING SIGNATURES BLOCK EXECUTED STATUS: an addendum showing only the buyer's signature is refused by name, and the ledger's governing price is unchanged", !half.ok && /seller/.test(half.reason) && after.ok && after.ledger.rows.find((r) => r.key === "offer_price")?.value === 490_000)
  }

  section("J · the comparison pipeline — executed change → record + settlement re-evaluated → classified → hold + corrective request → exact clearing")
  {
    const db = seed152()
    const r = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 490_000 }, documentId: DOC_A, executedAt: `${day(3)}T23:59:59.999Z`, recordedBy: U_AGENT, evidence: { recorded_via: "guard", term_evidence_stated: stated(1) } }))
    const cons = r.ok ? r.consequences : undefined
    check("SIGNED ADDENDUM CHANGES THE PRICE → the deal record is moved to it (the mirror) and compliance re-evaluated", r.ok && db.tables.transactions[0].purchase_price === 490_000 && cons?.complianceReReview.ran === true)
    const priceRow = logOf(db, "closing_terms.purchase_price"), commRow = logOf(db, "closing_terms.commission_buyer_side"), recRow = logOf(db, "closing_terms.record.purchase_price")
    check("…the statement still shows the REPLACED $500,000 → a BLOCKING fail classified SUPERSEDED that tells the issuer to use the executed addendum (named in plain words)",
      priceRow?.status === "fail" && priceRow.is_blocking === true && /\$500,000\.00, the value REPLACED by the executed addendum 1/.test(String(priceRow.failure_reason)) && /Send the issuer[^.]*executed addendum 1/.test(String(priceRow.failure_reason)), String(priceRow?.failure_reason))
    const sup = compareClosingTerms({ purchase_price: { unit: "usd", value: 490_000, confidence: "record", source: "a1" } }, { purchase_price: { unit: "usd", value: 500_000, confidence: "high", source: "cd" } }, {}, { history: { purchase_price: [{ fact: { unit: "usd", value: 500_000, confidence: "record", source: "offer" }, supersededBy: "executed addendum 1" }] } })
    const contra = compareClosingTerms({ purchase_price: { unit: "usd", value: 490_000, confidence: "record", source: "a1" } }, { purchase_price: { unit: "usd", value: 505_000, confidence: "high", source: "cd" } }, {}, { history: { purchase_price: [{ fact: { unit: "usd", value: 500_000, confidence: "record", source: "offer" }, supersededBy: "executed addendum 1" }] } })
    check("the PURE classes: a statement showing a replaced value is SUPERSEDED; POSITIVE CONTROL: a value nobody ever signed is CONTRADICTORY (same verdict, same blocking)", sup.findings[0].classification === "superseded" && contra.findings[0].classification === "contradictory" && sup.findings[0].verdict === "mismatch" && sup.findings[0].blocking && contra.findings[0].blocking)
    check("…the DEPENDENT commission line is re-judged on the new price (2.5% of $490,000 = $12,250 vs the statement's $12,500 → blocking fail), and the deal record now agrees with the contract",
      commRow?.status === "fail" && commRow.is_blocking === true && /12,250/.test(String(commRow.failure_reason)) && recRow?.status === "pass")
    const tasks = tasksOf(db)
    check("…ONE corrective request per departure, assigned to the deal's TC, naming who corrects it (the statement's issuer) — not a viewer warning",
      tasks.length === 2 && tasks.every((t) => t.assigned_user_id === U_TC && t.status === "pending" && /Who corrects it: the issuer of the settlement statement/.test(String(t.description))) && tasks.some((t) => /Purchase price/.test(String(t.title))))
    check("…each request is LEDGERED by the Compliance Officer (compliance.correction_request.open, an idempotency key of the check and its values)",
      db.tables.agent_action_ledger.filter((l) => l.action === "compliance.correction_request.open").length === 2 && db.tables.agent_action_ledger.every((l) => l.action !== "compliance.correction_request.open" || (l.actor_manager_key === "compliance_officer" && String(l.idempotency_key).startsWith("compliance-correction:"))))
    // replay: the statement's scan delivered, then delivered AGAIN (a webhook / scanner retry)
    const first = await quiet(() => runClosingCompliance(db as never, { transactionId: TXN, brokerageId: B, trigger: "settlement_scanned" }, stubs))
    const ledgerBefore = db.tables.agent_action_ledger.length, logBefore = JSON.stringify(db.tables.transaction_compliance_log), tasksBefore = JSON.stringify(tasksOf(db))
    const replay = await quiet(() => runClosingCompliance(db as never, { transactionId: TXN, brokerageId: B, trigger: "settlement_scanned" }, stubs))
    check("NO DUPLICATE ACTION ON REPLAY: the same delivery again opens no request, writes no ledger row, changes no log row (and the first delivery did not re-open the two price-driven requests)",
      first.ran && replay.ran && replay.corrections.opened === 0 && replay.rows.inserted === 0 && replay.rows.updated === 0 && JSON.stringify(tasksOf(db)) === tasksBefore && db.tables.agent_action_ledger.length === ledgerBefore && JSON.stringify(db.tables.transaction_compliance_log) === logBefore
      && tasksOf(db).filter((t) => /Purchase price matches|Buyer-side commission/.test(String(t.title))).length === 2)
    // the corrected statement arrives — price fixed, commission still wrong
    db.tables.documents.find((d) => d.id === DOC_CD)!.extracted_fields = { sales_price: "490000", earnest_money_deposit: "5000", seller_credit_to_buyer: "3000", commission_buyer_broker: "12500", closing_date: "2026-12-15" }
    const fixed = await quiet(() => runClosingCompliance(db as never, { transactionId: TXN, brokerageId: B, trigger: "settlement_scanned" }, stubs))
    const priceTask = tasksOf(db).find((t) => /Purchase price/.test(String(t.title))), commTask = tasksOf(db).find((t) => /Buyer-side commission/.test(String(t.title)))
    check("CORRECT DOCUMENTS CLEAR THE EXACT HOLD: the price row passes and ITS request is completed; the commission row and its request stay open",
      fixed.ran && logOf(db, "closing_terms.purchase_price")?.status === "pass" && priceTask?.status === "completed" && logOf(db, "closing_terms.commission_buyer_side")?.status === "fail" && commTask?.status === "pending" && fixed.corrections.completed === 1)
    check("UNRELATED DEALS ARE UNTOUCHED: the other deal's open row and open request are exactly as they were", untouched(db))
    // wrong commission / credit on the statement of a deal whose contract never changed
    const w = seed152({ statement: { sales_price: "500000", earnest_money_deposit: "5000", seller_credit_to_buyer: "4000", commission_buyer_broker: "13000", closing_date: "2026-12-15" } })
    const wr = await quiet(() => runClosingCompliance(w as never, { transactionId: TXN, brokerageId: B, trigger: "settlement_scanned" }, stubs))
    const credit = wr.comparison?.findings.find((f) => f.term === "seller_credit"), comm = wr.comparison?.findings.find((f) => f.term === "commission_buyer_side")
    check("WRONG CREDIT / WRONG COMMISSION on the statement → CONTRADICTORY, blocking, each with its corrective request; the matching terms are MATCH",
      credit?.classification === "contradictory" && credit.blocking && comm?.classification === "contradictory" && comm.blocking && wr.comparison?.findings.find((f) => f.term === "purchase_price")?.classification === "match"
      && tasksOf(w).filter((t) => /Seller credit to buyer matches|Buyer-side commission matches/.test(String(t.title))).length === 2 && !tasksOf(w).some((t) => /Purchase price/.test(String(t.title))) && wr.openBlocking >= 2)
    check("…and the contradiction is never \"fixed\" by the engine: the signed terms and the statement are untouched (the request asks the issuer)", w.tables.offers[0].closing_cost_contribution === 3_000 && (w.tables.documents.find((d) => d.id === DOC_CD)!.extracted_fields as Record<string, unknown>).seller_credit_to_buyer === "4000")
    const pure = compareClosingTerms({ purchase_price: { unit: "usd", value: 1, confidence: "record", source: "c" } }, { purchase_price: { unit: "usd", value: 2, confidence: "low", source: "scan" } })
    check("a difference resting on a LOW-confidence reading is REQUIRES_HUMAN_INTERPRETATION (never an accusation); a term the statement omits is MISSING",
      pure.findings[0].classification === "requires_human_interpretation" && compareClosingTerms({ earnest_money: { unit: "usd", value: 1, confidence: "record", source: "c" } }, {}).findings[0].classification === "missing")
  }

  section("K · not informational — the deal record, the on-or-before close, the CDA-disabled deal, the pre-CDA gate")
  {
    const drift = seed152({ txPrice: 505_000 })
    const d = await quiet(() => runClosingCompliance(drift as never, { transactionId: TXN, brokerageId: B, trigger: "final_check" }, stubs))
    const rr = logOf(drift, "closing_terms.record.purchase_price")
    check("A DEAL RECORD THAT DRIFTED from the executed contract ($505,000 typed vs $500,000 signed) HOLDS the closing with a corrective request to the TC — the commission is priced from that record",
      d.ran && rr?.status === "fail" && rr.is_blocking === true && d.recordComparison.some((f) => f.term === "purchase_price" && f.classification === "contradictory") && tasksOf(drift).some((t) => /deal record/.test(String(t.title)) && /transaction coordinator/.test(String(t.description))))
    const fmt = seed152({ txPrice: "500000.00" })
    await quiet(() => runClosingCompliance(fmt as never, { transactionId: TXN, brokerageId: B, trigger: "final_check" }, stubs))
    check("A HARMLESS FORMATTING DIFFERENCE never blocks ('500000.00' on the record vs 500,000 signed → pass)", logOf(fmt, "closing_terms.record.purchase_price")?.status === "pass")
    check("POSITIVE CONTROL: the pure record comparison recognises the drift it was written for", compareDealRecordTerms({ purchase_price: { unit: "usd", value: 500_000, confidence: "record", source: "contract", instrumentId: "o1" } }, { purchase_price: { unit: "usd", value: 505_000, confidence: "record", source: "deal" } })[0]?.verdict === "mismatch"
      && compareDealRecordTerms({ purchase_price: { unit: "usd", value: 500_000, confidence: "record", source: "deal", instrumentId: "tx:1" } }, { purchase_price: { unit: "usd", value: 505_000, confidence: "record", source: "deal" } }).length === 0)
    // "on or before": an earlier statement date is the contract
    const early = seed152({ statement: { sales_price: "500000", earnest_money_deposit: "5000", seller_credit_to_buyer: "3000", commission_buyer_broker: "12500", closing_date: "2026-12-09" } })
    await quiet(() => runClosingCompliance(early as never, { transactionId: TXN, brokerageId: B, trigger: "settlement_scanned" }, stubs))
    check("'ON OR BEFORE' EARLY CLOSE fabricates no amendment: the statement's 12-09 under 'on or before 12-15' is a PASS, and no corrective request is opened for it",
      logOf(early, "closing_terms.closing_date")?.status === "pass" && !tasksOf(early).some((t) => /Closing date/.test(String(t.title))))
    const fixedDay = seed152({ wording: "on", statement: { sales_price: "500000", earnest_money_deposit: "5000", seller_credit_to_buyer: "3000", commission_buyer_broker: "12500", closing_date: "2026-12-09" } })
    await quiet(() => runClosingCompliance(fixedDay as never, { transactionId: TXN, brokerageId: B, trigger: "settlement_scanned" }, stubs))
    check("POSITIVE CONTROL: a FIXED 'on' day moved earlier is a departure (fail, with its corrective request) — the wording, not the direction, decides", logOf(fixedDay, "closing_terms.closing_date")?.status === "fail" && tasksOf(fixedDay).some((t) => /Closing date/.test(String(t.title))))
    // the CDA-disabled valid deal continues
    const ok = seed152()
    const okRun = await quiet(() => runClosingCompliance(ok as never, { transactionId: TXN, brokerageId: B, trigger: "final_check" }, stubs))
    const termRows = ok.tables.transaction_compliance_log.filter((x) => x.transaction_id === TXN && String(x.check_type).startsWith("closing_terms."))
    const termTasks = (db: ReturnType<typeof seed>) => tasksOf(db).filter((t) => /matches the (settlement|executed contract)|confirmed on the executed/.test(String(t.title)))
    check("A CDA-DISABLED brokerage (no CDA row) with a statement that agrees with the executed contract CONTINUES: every term row passes, no term hold, no term corrective request",
      resolveCdaMode({ offersCda: false }).blocksClosing === false && ok.tables.closing_disclosure_agreement.length === 0 && okRun.ran && termRows.length >= 5 && termRows.every((x) => x.status === "pass") && termTasks(ok).length === 0,
      JSON.stringify(termRows.filter((x) => x.status !== "pass").map((x) => `${x.check_type}:${x.status}`)))
    const termLines = (s: string[]) => s.filter((l) => /matches the (settlement|executed contract)|confirmed on the executed/.test(l))
    check("THE PRE-CDA GATE REFUSES while a term hold is open (the drifted record's blocking line reaches the final check) and the clean deal carries no term blocker",
      termLines(d.blockingSummary).length >= 1 && !evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0, closingFindings: termLines(d.blockingSummary) }).passed
      && termLines(okRun.blockingSummary).length === 0 && evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0, closingFindings: termLines(okRun.blockingSummary) }).passed)
  }

  section("L · the evidence hold — owner decision 'refuse or flag', the SAFE DEFAULT (hold + flag, never silently accept)")
  {
    const db = seed152()
    const r = await quiet(() => recordContractTermsVersion(db as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 490_000 }, documentId: DOC_A, executedAt: `${day(3)}T23:59:59.999Z`, recordedBy: U_AGENT }))
    const hold = logOf(db, "closing_terms.evidence.offer_price")
    check("an executed addendum term recorded with NO located reading is RECORDED (history is never refused) and HOLDS the closing on that term — blocking review row + its corrective request",
      r.ok && db.tables.contract_term_versions.some((x) => x.document_id === DOC_A) && hold?.status === "needs_review" && hold.is_blocking === true && /never noted/.test(String(hold.failure_reason)) && tasksOf(db).some((t) => /confirmed on the executed addendum 1/.test(String(t.title))))
    db.tables.document_field_extractions.push({ brokerage_id: B, document_id: DOC_A, field_key: "price", field_value_json: { value: 490000, page: 1 }, confidence: "high", verified_at: "2026-11-21T00:00:00Z" })
    const cleared = await quiet(() => runClosingCompliance(db as never, { transactionId: TXN, brokerageId: B, trigger: "final_check" }, stubs))
    check("a VERIFIED reading of the signed document that agrees CLEARS exactly that hold and settles its request", cleared.ran && logOf(db, "closing_terms.evidence.offer_price")?.status === "pass" && tasksOf(db).find((t) => /confirmed on the executed addendum 1/.test(String(t.title)))?.status === "completed")
    const db2 = seed152()
    await quiet(() => recordContractTermsVersion(db2 as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 490_000 }, documentId: DOC_A, executedAt: `${day(3)}T23:59:59.999Z`, recordedBy: U_AGENT }))
    db2.tables.document_field_extractions.push({ brokerage_id: B, document_id: DOC_A, field_key: "price", field_value_json: "480000", confidence: "high", verified_at: "2026-11-21T00:00:00Z" })
    await quiet(() => runClosingCompliance(db2 as never, { transactionId: TXN, brokerageId: B, trigger: "final_check" }, stubs))
    check("a confident reading that arrives LATER and DISAGREES is a contradiction (fail, blocking) — paper and recorded term disagree, nothing picks one", logOf(db2, "closing_terms.evidence.offer_price")?.status === "fail" && logOf(db2, "closing_terms.evidence.offer_price")?.is_blocking === true)
    const db3 = seed152()
    await quiet(() => recordContractTermsVersion(db3 as never, { brokerageId: B, rootOfferId: ROOT_OFFER, transactionId: TXN, source: "addendum", status: "executed", terms: { offer_price: 490_000 }, documentId: DOC_A, executedAt: `${day(3)}T23:59:59.999Z`, recordedBy: U_AGENT, evidence: { term_evidence_stated: stated(2) } }))
    check("POSITIVE CONTROL: the same addendum recorded WITH its page / field / quote opens no evidence hold", !logOf(db3, "closing_terms.evidence.offer_price"))
    const refusedLedger = seed152()
    const rf = await quiet(() => runClosingCompliance(refusedLedger as never, { transactionId: TXN, brokerageId: B, trigger: "final_check" }, { ...stubs, termLedger: async () => ({ ok: false as const, error: "simulated refusal" }) }))
    check("a term ledger that cannot be read is a BLOCKING fault row, never a silent pass (fail closed)", rf.ran && logOf(refusedLedger, "closing_terms.evidence_ledger")?.status === "fail" && logOf(refusedLedger, "closing_terms.evidence_ledger")?.is_blocking === true)
  }

  section("M · the override rule — authorized, reasoned, audited; never 'approve all'; never a false certification")
  {
    const base = { checkType: "closing_terms.purchase_price", isBlocking: true }
    check("a COMPUTED check is never marked 'pass' by a person — not even by the broker (it clears when the documents agree)", decideComplianceCheckChange({ ...base, toStatus: "pass", actorMayOverride: true, reason: "looks fine to me" }).ok === false)
    check("an AGENT (no override authority) cannot waive it, whatever the reason", decideComplianceCheckChange({ ...base, toStatus: "waived", actorMayOverride: false, reason: "the buyer said it is fine" }).ok === false)
    check("the broker cannot waive it WITHOUT a written reason (the one override floor)", decideComplianceCheckChange({ ...base, toStatus: "waived", actorMayOverride: true, reason: "ok" }).ok === false)
    const w = decideComplianceCheckChange({ ...base, toStatus: "waived", actorMayOverride: true, reason: "Title confirmed the corrected CD is in transit; closing tomorrow 9am." })
    check("…and CAN with the authority and a reason — the decision marks it an OVERRIDE (the door ledgers it)", w.ok && w.override === true)
    check("a non-blocking manual checklist item is still passed by the reviewer as before (no new friction where nothing is held)", (() => { const x = decideComplianceCheckChange({ checkType: "hoa_documents", isBlocking: false, toStatus: "pass", actorMayOverride: false }); return x.ok && !x.override })())
    check("NO 'APPROVE ALL': a batch refuses every computed check and every blocking check, and passes only non-blocking manual items",
      !decideComplianceCheckChange({ ...base, toStatus: "pass", actorMayOverride: true, batch: true }).ok && !decideComplianceCheckChange({ checkType: "earnest_money_receipt", isBlocking: true, toStatus: "pass", actorMayOverride: true, batch: true }).ok && decideComplianceCheckChange({ checkType: "hoa_documents", isBlocking: false, toStatus: "pass", actorMayOverride: false, batch: true }).ok)
    const door = code("app/actions/transaction-compliance.ts"), doorBare = bare("app/actions/transaction-compliance.ts")
    const upd = door.slice(door.indexOf("export async function updateComplianceCheck"), door.indexOf("export async function canProceedToClosingPrep"))
    const batch = door.slice(door.indexOf("export async function batchPassComplianceChecks"))
    check("THE DOORS (stripped source): the single update asks the rule BEFORE it writes and ledgers an override (compliance.check.override); the batch reads the rows, asks the rule per row with batch:true, and counts what it wrote",
      upd.indexOf("decideComplianceCheckChange(") > 0 && upd.indexOf("decideComplianceCheckChange(") < upd.indexOf(".update(updateData)") && /action:\s*"compliance\.check\.override"/.test(upd)
      && batch.indexOf("decideComplianceCheckChange(") > 0 && batch.indexOf("decideComplianceCheckChange(") < batch.indexOf(".update(") && /batch:\s*true/.test(batch) && /\.select\("id"\)/.test(batch.slice(batch.indexOf(".update("))))
    check("the override authority is DERIVED from the one tenant roster minus team_lead (never retyped) and is module-private", /new Set\(\[\.\.\.TENANT_ADMIN_USER_TYPES\]\.filter\(\(t\) => t !== "team_lead"\)\)/.test(door) && !/export const COMPLIANCE_OVERRIDE_USER_TYPES/.test(door) && !/"broker_owner"/.test(doorBare.slice(0, doorBare.indexOf("export async function"))))
    check("POSITIVE CONTROL: the order finder recognises a door that writes before it decides", (() => { const s = `x.update(updateData); decideComplianceCheckChange(`; return !(s.indexOf("decideComplianceCheckChange(") < s.indexOf(".update(updateData)")) })())
    check("the TC fast-action panel's 'pass all open checks' reports what the server actually passed (refused rows named back), never the selection size", /result\.updated/.test(code("app/dashboard/coordinator/components/tc-fast-action-panel.tsx")) && /result\.refused/.test(code("app/dashboard/coordinator/components/tc-fast-action-panel.tsx")))
  }

  console.log("\nBLIND SPOTS (wave 152, lane 152E): the settlement extractor states no party names or property address, so 'wrong parties' is compared")
  console.log("  on the ledger and the deal record only — not against the Closing Disclosure (outside-lane request to the document lane); a version")
  console.log("  recorded before per-term evidence existed (wave 151) carries no term_evidence and is never held; the corrective request is the TC's")
  console.log("  task — the platform does not message the title company itself; free-text terms (special conditions, possession) are listed, never")
  console.log("  compared by meaning; the override doors are proved by the pure rule + stripped source (a session cannot be minted here).")
  console.log("\nBLIND SPOTS: the model call itself is not driven (no network) — the coach's filter and brief are proved pure, the door by source; the live")
  console.log("  document_field_extractions rows' page shape (page / page_number) is assumed from the writer, not measured live; the attestation's informational")
  console.log("  ask is proved on the in-memory client (the live is_blocking column has no CHECK); m986's trigger is read from the file and its stamp line —")
  console.log("  the live immutability is the migration ledger's word; the listing-agreement rail still folds same-source ties by version number (outside this lane).")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(` FAILED: ${failures.join(" · ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
