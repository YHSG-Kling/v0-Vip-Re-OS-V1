/**
 * scripts/cda-effective-terms-guard.ts — test:cda-effective-terms (wave 150, lane 150XY / directive 150Y + canary 14;
 * pure + in-memory, no DB, no network, no model).
 *
 * WHAT IT HOLDS:
 *   A · CDA ONLY WHEN THE TENANT USES IT — resolveCdaMode over brokerages.offers_cda (true / false / undeclared) driven; a missing
 *       CDA never blocks closing; the payout gate needs a CDA brokerage for closing-time release.
 *   B · AGENT-FILLED — CDA_FILL_RULE (agent fills, AI never fills, AI may explain); the template never pre-fills money from a model.
 *   C · EXECUTED ADDENDA SUPERSEDE TERMS BEFORE CLOSING — resolveGoverningTerms driven: an executed addendum replaces the price, a
 *       PROPOSED one never governs, the original is preserved; a version is executed only with both signatures (recorder text).
 *   D · COMPLIANCE + PAYOUTS RE-READ EFFECTIVE TERMS — the consequence runner's impact driven (price → gross commission, CDA, cap,
 *       referral, seller net; a contingency-days change moves no money); closing compliance, the closing verification and the CDA
 *       page read the ONE reader; the transaction row the commission engine prices is mirrored from executed terms.
 *   E · CANARY 14 — "on or before" + an earlier lender/title day: no executed amendment, anticipated moves, the contract date and
 *       the actual date stay separate facts; a fixed "on" day moved needs one; the closing_date term reaches the agreement-as-of date.
 *   F · THE MONEY CHAIN — caps/anniversary, referral, team split, revenue share, fees are waterfall steps; HUD/CD figures compared
 *       (never fabricated as $0); title vs attorney by state; seller-vs-agent concessions follow the offer chain onto the deal.
 *   G · CLOSED → LIFETIME MONOTONICITY — the verdict ladder (not closed / records pending / payout pending / lifetime) driven.
 *   H · CLOSING ATTESTATION WITHOUT A CDA IS AN OWNER DECISION — the attestation is asked ONLY on the CDA path today; nothing in
 *       this lane invented a non-CDA closing gate (census with a positive control).
 *
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2). Blind spots printed at the end.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { resolveCdaMode, resolvePayoutTiming, CDA_FILL_RULE, comparePreliminaryStatementFigures } from "../lib/transactions/cda-closing-policy"
import { resolveGoverningTerms, type TermsVersion } from "../lib/offers/governing-terms-rule"
import { afterExecutedContractChange } from "../lib/offers/governing-terms-consequences"
import { resolveClosingDates, assessClosingDateChange } from "../lib/transactions/closing-dates"
import { closingStateNote } from "../lib/state-forms/closing-participants"
import { lifetimeConversionVerdict } from "../lib/kernel/lifetime-conversion"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await f() } finally { console.error = e; console.warn = w } }

const B = "11111111-1111-4111-8111-111111111111"
const v = (over: Partial<TermsVersion>): TermsVersion => ({ versionNo: 1, source: "offer", status: "executed", offerId: null, documentId: null, executedAt: "2026-10-01T00:00:00Z", terms: {}, derived: false, ...over })

async function main() {
  section("A · a CDA only when the tenant uses one")
  {
    const yes = resolveCdaMode({ offersCda: true }), no = resolveCdaMode({ offersCda: false, nonCdaPayoutDefault: "check" }), undeclared = resolveCdaMode({ offersCda: null })
    check("offers_cda true → CDA mode; false → no CDA (payout default kept); undeclared → no CDA (never manufactured)",
      yes.mode === "cda" && yes.cdaRequired && no.mode === "no_cda" && no.payoutMethodDefault === "check" && undeclared.mode === "no_cda" && undeclared.reason === "cda_not_declared")
    check("a missing CDA never blocks closing in either mode", yes.blocksClosing === false && no.blocksClosing === false)
    const t = resolvePayoutTiming({ offersCda: false, payoutTiming: "at_closing_per_cda" })
    check("closing-time payout without a CDA brokerage falls back to the brokerage-receipt gate, with the finding said", t.timing === "after_brokerage_receipt" && !!t.finding)
    const readers = ["lib/transactions/stage-progression.ts", "lib/transactions/closing-orchestration.ts", "lib/transactions/cda-delivery-reaper.ts", "lib/commission/reconcile-tracking.ts"].filter((p) => /resolveCdaMode\(/.test(code(p)))
    check("every closing reader asks the ONE switch (resolveCdaMode)", readers.length === 4, readers.join(", "))
  }

  section("B · the agent fills the CDA; AI only explains")
  {
    check("CDA_FILL_RULE: agent fills, AI never fills, AI may explain figures", CDA_FILL_RULE.agentFills === true && CDA_FILL_RULE.aiFills === false && CDA_FILL_RULE.aiMayExplainFigures === true)
    const MODEL = /from\s+["']@\/lib\/ai\/|anthropic|openai|generateText/i
    const cdaFiles = ["lib/transactions/cda-template-fields.ts", "lib/transactions/cda-pdf-fill.ts", "lib/transactions/cda-closing-policy.ts", "lib/commission/cda-discrepancy.ts"]
    const hits = cdaFiles.filter((p) => MODEL.test(code(p)))
    check("no model in the CDA fill / template / policy / discrepancy code", hits.length === 0, hits.join(", "))
    check("POSITIVE CONTROL: the model finder recognises a specimen", MODEL.test(`import { generateText } from "ai"`))
  }

  section("C · executed addenda supersede terms before closing — originals preserved")
  {
    const original = v({ versionNo: 1, source: "offer", terms: { offer_price: 500_000, closing_date: "2026-12-15", title_policy_payer: "seller" }, executedAt: "2026-10-01T00:00:00Z" })
    const addendum = v({ versionNo: 1, source: "addendum", terms: { offer_price: 490_000 }, executedAt: "2026-10-20T00:00:00Z", documentId: "doc-add-1" })
    const proposed = v({ versionNo: 2, source: "addendum", status: "proposed", terms: { offer_price: 480_000 }, executedAt: null })
    const g = resolveGoverningTerms([original, addendum, proposed])
    check("the EXECUTED addendum governs the price (490,000); untouched terms stay from the original", g.values.offer_price === 490_000 && g.values.title_policy_payer === "seller" && g.values.closing_date === "2026-12-15")
    check("the superseded original value is preserved as a conflict record, and every version is kept", g.conflicts.some((c) => c.key === "offer_price" && c.superseded.value === 500_000 && c.governing.value === 490_000) && g.versions.length === 3)
    check("a PROPOSED addendum never governs — it is reported as pending", g.pending.length === 1 && g.values.offer_price !== 480_000)
    check("the governing version is the addendum", g.governingVersion?.source === "addendum")
    const rec = code("lib/offers/governing-terms.ts")
    check("an executed version needs a stored document showing BOTH signatures (the recorder refuses otherwise)", /signaturesPresent\([\s\S]{0,120}?\["buyer", "seller"\]\)/.test(rec) && /an executed version needs the executed document/.test(rec))
  }

  section("D · compliance and payouts re-read the EFFECTIVE terms")
  {
    const impact = async (changedTerms: Record<string, unknown>) => (await quiet(() => afterExecutedContractChange(memSupabase({}) as never, { brokerageId: B, transactionId: null, rootOfferId: "root-1", versionNo: 2, source: "addendum", changedTerms, documentId: "doc-1", executedOn: "2026-10-20", recordedBy: null }))).impact
    const price = await impact({ offer_price: 490_000 })
    const days = await impact({ inspection_period_days: 12 })
    const date = await impact({ closing_date: "2026-12-08" })
    check("a price change reaches gross commission, CDA, cap contribution, referral fee and seller net", price.moneyMoved && ["gross_commission", "cda", "cap_contribution", "referral_fee", "seller_net"].every((o) => price.obligations.includes(o as never)))
    check("a contingency-days change moves no money (the deadlines rail reads it)", !days.moneyMoved && days.nonFinancialTerms.includes("inspection_period_days"))
    check("a closing-date change reaches the agreement-as-of date and the cap cycle (which agreement and cap year price the deal)", date.obligations.includes("agreement_as_of_date" as never) && date.obligations.includes("cap_contribution" as never))
    const cons = code("lib/offers/governing-terms-consequences.ts")
    check("the runner mirrors executed money terms onto the transaction row the engine prices, re-runs compliance, reopens the attestation and the CDA",
      /offer_price:\s*"purchase_price"/.test(cons) && /runClosingCompliance/.test(cons) && /reopenClosingAttestation/.test(cons) && /reopenCdaForCorrection/.test(cons))
    const readers = ["lib/commission/closing-verification.ts", "app/actions/cda-portal.ts", "lib/transactions/closing-compliance.ts"].filter((p) => /governingContractTerms\(/.test(code(p)))
    check("closing verification, the CDA page and closing compliance call the ONE reader (governingContractTerms)", readers.length === 3, readers.join(", "))
    check("the recorder runs the consequences for every EXECUTED addendum / amendment", /afterExecutedContractChange\(/.test(code("lib/offers/governing-terms.ts")))
  }

  section("E · canary 14 — 'on or before', earlier closing, actual tracked separately")
  {
    const deal = { status: "under_contract", close_date: "2026-12-15", estimated_close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract", property_state: "CA", financing_type: "conventional" }
    const early = assessClosingDateChange(deal, { date: "2026-12-08", kind: "anticipated" })
    check("an earlier lender/title day under 'on or before' is within the contract and needs NO executed amendment", early.direction === "earlier" && early.withinContract === true && early.requiresExecutedAmendment === false)
    check("...and the lender (TRID CD ≥ 3 business days), title/escrow and the CDA are named to coordinate", early.coordinate.some((c) => /TRID/.test(c)) && early.coordinate.some((c) => /CDA/.test(c)))
    const fixed = assessClosingDateChange({ ...deal, contract_closing_terms: "on" }, { date: "2026-12-08", kind: "anticipated" })
    check("POSITIVE CONTROL: a fixed 'on' day moved earlier DOES need an amendment", fixed.requiresExecutedAmendment === true)
    const unread = assessClosingDateChange({ ...deal, contract_closing_terms: null }, { date: "2026-12-08", kind: "anticipated" })
    check("an unread wording is 'unknown' — never a default amendment demand", unread.requiresExecutedAmendment === "unknown")
    const closed = resolveClosingDates({ ...deal, status: "closed", actual_close_date: "2026-12-09", close_date: "2026-12-09" })
    check("actual is its own fact: closed on 12-09 while the contract still says on or before 12-15", closed.actual?.date === "2026-12-09" && closed.contractual?.date === "2026-12-15" && closed.contractual?.terms === "on_or_before")
  }

  section("F · the money chain — caps, referral, team, revenue share, fees, HUD/CD, title/attorney, concessions")
  {
    const steps = readdirSync(join(ROOT, "lib/commission/waterfall")).filter((f) => f.endsWith(".ts"))
    const need = ["03b-referral-deduction.ts", "07-apply-cap.ts", "08-team-split.ts", "09-revenue-share.ts", "10-fees.ts"]
    check("the waterfall carries referral, cap, team split, revenue share and fees as ordered steps", need.every((s) => steps.includes(s)), steps.join(","))
    check("cap anniversary basis is a declared vocabulary (lib/commission/cap-resolver.ts)", /export const CAP_ANNIVERSARY_BASES/.test(code("lib/commission/cap-resolver.ts")) && /export function resolveAnniversaryWindow/.test(code("lib/commission/cap-resolver.ts")))
    const cmp = comparePreliminaryStatementFigures({ sales_price: 490_000, gross_commission: 15_000 }, { sales_price: 490_000, gross_commission: 14_700, agent_net: 10_000 })
    check("HUD/CD: a $300 / 2% gross gap is a discrepancy; a figure the statement lacks is UNVERIFIABLE, never $0",
      cmp.discrepancies.some((d) => d.field === "gross_commission" && d.severity === "warning") && cmp.unverifiable.includes("agent_net") && !cmp.discrepancies.some((d) => d.field === "agent_net"))
    const ny = closingStateNote("NY"), ca = closingStateNote("CA")
    check("who conducts the closing comes from the state (attorney vs title/escrow), never assumed", ny.conductedBy.startsWith("attorney") && ca.conductedBy === "title_or_escrow_typically")
    check("seller-vs-agent concessions requested on the offer chain follow it onto the deal at promotion", /anchorOfferConcessionsToTransaction\(/.test(code("lib/offers/governing-terms.ts")) && existsSync(join(ROOT, "lib/commission/agent-concession.ts")))
  }

  section("G · closed → lifetime monotonicity")
  {
    const not = lifetimeConversionVerdict({ closed: false, requiredRecordsComplete: true, payoutVerified: true, requirePayoutVerified: false })
    const rec = lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: false, payoutVerified: true, requirePayoutVerified: false })
    const pay = lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: true })
    const life = lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: false })
    check("not closed → no conversion; records pending → hold; payout pending (when the tenant requires it) → hold; otherwise LIFETIME",
      not.action === "not_closed" && rec.action === "hold_records" && pay.action === "hold_payout_pending" && life.action === "convert")
    const DEMOTE = /\.update\(\{[^}]*lifecycle_state:\s*["'](lead|prospect|active)["'][^}]*\}\)[\s\S]{0,120}["']lifetime/
    const kernel = code("lib/kernel/lifetime-conversion.ts")
    check("the ONE lifetime writer only promotes (no demotion from lifetime in the module); POSITIVE CONTROL on a specimen",
      !DEMOTE.test(kernel) && /export async function promoteDealContactsToLifetime/.test(kernel) && DEMOTE.test(`.update({ lifecycle_state: "lead" }).eq("lifecycle_state", "lifetime")`))
  }

  section("H · closing attestation WITHOUT a CDA — asked informationally at the no-CDA close (option b), never a closing gate")
  {
    // WAVE 151 (lane 151K; OWNER-SQL §L L6.2 option (b)): the question is asked on exactly TWO paths — the CDA submit door (blocking,
    // the CDA is held on it) and the no-CDA gated close (informational: is_blocking false, the close is never held). Option (c), a
    // blocking ask for no-CDA brokerages, stays an owner decision — so a THIRD caller, or a blocking ask at the close, is the defect.
    const SITE = /ensureClosingAttestationAsked\(/
    const roots = ["app", "lib"]
    const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${d}/${e.name}`)) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : [])
    const callers = roots.flatMap(walk).filter((p) => p !== "lib/commission/closing-verification.ts" && SITE.test(code(p))).sort()
    check("the attestation is ASKED on exactly two paths: the CDA submit door and the no-CDA gated close — no third caller", callers.join(",") === "app/actions/cda-portal.ts,lib/transactions/stage-progression.ts", callers.join(", "))
    const sp = code("lib/transactions/stage-progression.ts"), portal = code("app/actions/cda-portal.ts")
    const spCall = sp.slice(sp.indexOf("ensureClosingAttestationAsked(supabase"), sp.indexOf("ensureClosingAttestationAsked(supabase") + 220)
    check("the no-CDA close asks it INFORMATIONALLY (informational: true, under the closed-without-CDA branch); the CDA door asks it BLOCKING (no informational flag)", /informational:\s*true/.test(spCall) && /closedWithoutCda\)/.test(sp) && !/informational/.test(portal))
    check("the writer makes an informational ask a NON-blocking row and a default ask a blocking one", /is_blocking:\s*!informational/.test(code("lib/commission/closing-verification.ts")))
    check("POSITIVE CONTROL: the census finder recognises a call", SITE.test(`await ensureClosingAttestationAsked(svc, { brokerageId, transactionId })`))
  }

  console.log("\nBLIND SPOTS: the consequence runner is driven with no transaction (impact only); its writes on a live deal are held by")
  console.log("  test:agreement-governance §F; the AI split COACH has no model door yet (deterministic comparison only — lane notes, Still open);")
  console.log("  commission-off-agent-display is held by its own existing proofs, not re-scanned here; state rules are as sourced, not verified true.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(` FAILED: ${failures.join(" · ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
