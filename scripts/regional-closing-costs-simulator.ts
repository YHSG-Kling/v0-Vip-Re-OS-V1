#!/usr/bin/env tsx
/**
 * scripts/regional-closing-costs-simulator.ts   (npm run test:regional-closing-costs)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves REGION-DERIVED CLOSING COSTS (owner: "closing costs are derived by
 * REGION estimates — or if there is a better way AI can determine the most
 * accurate buyer closing costs"):
 *
 * PURE:    lib/offers/regional-closing-costs — 50 states + DC of REAL published
 *          conventions (transfer tax + customary payer, title pricing
 *          convention, settlement/attorney model, recording bands, property-tax
 *          bands), every figure labeled "regional estimate — {state}".
 * FLOOR:   the deterministic regional model is the floor — applyAiRefinements
 *          clamps every AI adjustment within [0.5×, 1.5×] of the band, refuses
 *          lender-fact + pending lines, and requires a stated reason.
 * HONESTY: lender facts beat the region; pending-lender lines carry the state
 *          CONVENTION as a labeled note, never a fabricated dollar figure; the
 *          lender's Loan Estimate stays the named authority (TRID).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ALL_REGION_CODES,
  getRegionalConventions,
  normalizeStateCode,
  regionalLabel,
  buyerShareFactor,
  taxEscrowMonths,
  applyAiRefinements,
} from "../lib/offers/regional-closing-costs"
import { estimateBuyerClosingCosts } from "../lib/offers/buyer-closing-costs"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function coverageLayer() {
  console.log("\n[coverage — all 50 states + DC, sane published-convention bands]")
  check("51 regions (50 states + DC)", ALL_REGION_CODES.length === 51 && ALL_REGION_CODES.includes("DC"))
  check("every region resolves with sane bands (transfer 0–4.5%, title low≤high, tax band sane, positive fee bands)",
    ALL_REGION_CODES.every((code) => {
      const c = getRegionalConventions(code)!
      return !!c && c.stateName.length > 2
        && c.transferTaxPct >= 0 && c.transferTaxPct <= 4.5
        && c.ownerTitleLowPct >= 0 && c.ownerTitleHighPct >= c.ownerTitleLowPct && c.ownerTitleHighPct <= 1
        && c.propertyTaxLowPct > 0 && c.propertyTaxHighPct >= c.propertyTaxLowPct && c.propertyTaxHighPct <= 3
        && c.settlementFeeLow > 0 && c.settlementFeeHigh >= c.settlementFeeLow
        && c.recordingFeeLow > 0 && c.recordingFeeHigh >= c.recordingFeeLow
        && c.transferTaxNote.length > 5 && c.titleNote.length > 5
    }))
  check("normalization: code, lowercase, full name, garbage",
    normalizeStateCode("CA") === "CA" && normalizeStateCode("tx") === "TX"
    && normalizeStateCode("California") === "CA" && normalizeStateCode("district of columbia") === "DC"
    && normalizeStateCode("Narnia") === null && normalizeStateCode("") === null && normalizeStateCode(null) === null)

  // Spot checks of REAL published conventions — the honesty anchor.
  const tx = getRegionalConventions("TX")!, de = getRegionalConventions("DE")!, wa = getRegionalConventions("WA")!
  const ia = getRegionalConventions("IA")!, ga = getRegionalConventions("GA")!, ca = getRegionalConventions("CA")!
  const tn = getRegionalConventions("TN")!, vt = getRegionalConventions("VT")!
  check("TX: no transfer tax + promulgated title (TDI) + seller customarily pays owner's policy",
    tx.transferTaxPct === 0 && tx.titleConvention === "regulated_promulgated" && tx.ownerTitlePayer === "seller")
  check("DE: 4% transfer customarily split; attorney closing state",
    de.transferTaxPct === 4 && de.transferTaxPayer === "split" && de.attorneyClosing)
  check("WA: seller-paid graduated REET (≥1%); escrow-company closings",
    wa.transferTaxPct >= 1 && wa.transferTaxPayer === "seller" && wa.settlementModel === "escrow_company")
  check("IA: private title insurance barred — state Title Guaranty flat fee",
    ia.titleConvention === "state_title_guaranty" && ia.ownerTitleHighPct <= 0.1)
  check("GA: attorney-closing state; nominal seller-paid transfer tax",
    ga.attorneyClosing && ga.transferTaxPct === 0.1 && ga.transferTaxPayer === "seller")
  check("CA: escrow state; owner's-policy payer VARIES north/south; note names county doc tax + city add-ons",
    ca.settlementModel === "escrow_company" && ca.ownerTitlePayer === "varies" && /county documentary/.test(ca.transferTaxNote))
  check("TN + VT: the two buyer-pays-transfer-tax conventions are encoded as buyer-paid",
    tn.transferTaxPayer === "buyer" && vt.transferTaxPayer === "buyer")
  check("buyer share factors: buyer=1, split=0.5, seller=0, varies=0–0.5 (honest width, not a faked custom)",
    buyerShareFactor("buyer").low === 1 && buyerShareFactor("split").high === 0.5
    && buyerShareFactor("seller").high === 0 && buyerShareFactor("varies").low === 0 && buyerShareFactor("varies").high === 0.5)
  check("escrow months: heavy-tax states front-load a bigger cushion (IL 3–6) than light-tax (HI 2–4)",
    taxEscrowMonths(getRegionalConventions("IL")!).high === 6 && taxEscrowMonths(getRegionalConventions("HI")!).high === 4)
}

function estimateLayer() {
  console.log("\n[estimator integration — labels on every regional line, lender facts win, pending stays honest]")
  const est = estimateBuyerClosingCosts({ purchasePrice: 500_000, loanAmount: 400_000, sellerCredit: 5_000, interestRatePct: 6.5, loanSourceNote: "per your lender's loan terms on file (Acme)", state: "TX" })
  check("state resolves: regionState=TX, regionLabel names Texas conventions",
    est.regionState === "TX" && est.regionLabel === "regional estimate — Texas conventions")
  check("every regional line carries the sourceLabel 'regional estimate — Texas conventions'",
    est.lines.filter((l) => l.source === "regional_estimate").length >= 3
    && est.lines.filter((l) => l.source === "regional_estimate").every((l) => l.sourceLabel === "regional estimate — Texas conventions"))
  check("LENDER-FACT PRECEDENCE: prepaid interest + lender fees ride the real record, labeled with its provenance",
    est.lines.find((l) => l.label.startsWith("Prepaid interest"))!.source === "lender_fact"
    && est.lines.find((l) => l.label.startsWith("Prepaid interest"))!.note!.includes("6.5%")
    && est.lines.find((l) => l.label.startsWith("Lender fees"))!.sourceLabel!.includes("Acme"))
  const ownerTitle = est.lines.find((l) => l.label === "Owner's title insurance")!
  check("TX owner's title: customarily SELLER-paid → buyer band 0 with the convention stated (contract controls)",
    ownerTitle.low === 0 && ownerTitle.high === 0 && /SELLER-paid in Texas/.test(ownerTitle.note ?? ""))
  check("TX recording & transfer: no transfer tax → recording band only",
    est.lines.find((l) => l.label === "Recording & transfer charges")!.high <= 250)
  check("disclaimer names the region AND keeps the Loan Estimate as the authority (TRID)",
    est.disclaimer.includes("Texas closing conventions") && est.disclaimer.includes("Loan Estimate is the authority")
    && est.disclaimer.includes("Closing Disclosure"))

  // Delaware split transfer tax actually lands on the buyer side.
  const de = estimateBuyerClosingCosts({ purchasePrice: 400_000, loanAmount: 300_000, sellerCredit: 0, state: "Delaware" })
  const deTransfer = de.lines.find((l) => l.label === "Recording & transfer charges")!
  check("DE (full name input): buyer's half of the 4% transfer tax ≈ $8k lands in the line",
    de.regionState === "DE" && deTransfer.low >= 8000 && deTransfer.high >= 8000 && /split 50\/50/.test(deTransfer.note ?? ""))

  // Attorney-state settlement line renames itself honestly.
  const ma = estimateBuyerClosingCosts({ purchasePrice: 600_000, loanAmount: 480_000, sellerCredit: 0, state: "MA" })
  check("MA: settlement line is the closing ATTORNEY fee and says it's an attorney-closing state",
    ma.lines.some((l) => l.label === "Settlement / closing attorney fee" && /attorney-closing state/.test(l.note ?? "")))

  // PENDING stays pending — but now carries the regional CONVENTION as a note.
  const pending = estimateBuyerClosingCosts({ purchasePrice: 500_000, loanAmount: null, sellerCredit: 0, state: "FL" })
  const pendingTitle = pending.lines.find((l) => l.label === "Lender's title insurance")!
  check("pending lender's title: still pending + excluded from totals, note carries the FL convention (labeled), never a dollar invention",
    pendingTitle.pending === true && pendingTitle.low === 0 && pendingTitle.high === 0
    && /pending your lender's terms/.test(pendingTitle.note ?? "")
    && /regional estimate — Florida conventions/.test(pendingTitle.note ?? ""))
  check("pending lines excluded from totals; estimable lines still total (owner's title, transfer, escrow, settlement)",
    pending.totalLow === pending.lines.reduce((s, l) => s + (l.pending ? 0 : l.low), 0) && pending.totalLow > 0)
  check("regional property-tax band drives the escrow cushion when no county figure is on file",
    /Florida effective property tax/.test(pending.lines.find((l) => l.label.startsWith("Tax & insurance escrow"))!.note ?? ""))

  // Unknown state → honest generic fallback, no regional labels anywhere.
  const generic = estimateBuyerClosingCosts({ purchasePrice: 500_000, loanAmount: 400_000, sellerCredit: 5_000 })
  check("no state → generic industry bands, no regional labels, regionState null (never a guessed state)",
    generic.regionState === null && generic.regionLabel === null
    && generic.lines.every((l) => l.source !== "regional_estimate")
    && generic.lines.length >= 9 && generic.netLow === generic.totalLow - 5000)
  const cash = estimateBuyerClosingCosts({ purchasePrice: 500_000, loanAmount: 0, sellerCredit: 0, state: "CA" })
  check("cash + region: lender lines gone, regional lines remain labeled",
    cash.isCash && cash.lines.every((l) => !l.label.includes("Lender"))
    && cash.lines.some((l) => l.source === "regional_estimate"))
}

function aiBoundsLayer() {
  console.log("\n[AI refinement — the deterministic regional model is the floor]")
  const conv = getRegionalConventions("CA")!
  const est = estimateBuyerClosingCosts({ purchasePrice: 800_000, loanAmount: 640_000, sellerCredit: 0, interestRatePct: 6.25, loanSourceNote: "per your lender's loan terms on file", state: "CA" })
  const settle = est.lines.find((l) => l.label === "Settlement / escrow fee")!

  const inBounds = applyAiRefinements(est.lines, [
    { label: "Settlement / escrow fee", low: settle.low + 100, high: settle.high + 200, reason: "Bay Area escrow fees run to the top of the band" },
  ], conv)
  const refined = inBounds.lines.find((l) => l.label === "Settlement / escrow fee")!
  check("in-bounds adjustment applies, relabels the line ai_refined, and carries the stated reason",
    inBounds.applied.length === 1 && refined.source === "ai_refined"
    && refined.low === settle.low + 100 && refined.high === settle.high + 200
    && /AI-refined within the California regional band — Bay Area/.test(refined.sourceLabel ?? ""))

  const outOfBounds = applyAiRefinements(est.lines, [
    { label: "Settlement / escrow fee", low: 10, high: settle.high * 10, reason: "wild guess" },
  ], conv)
  const clamped = outOfBounds.lines.find((l) => l.label === "Settlement / escrow fee")!
  check("out-of-bounds adjustment is CLAMPED into [0.5×low, 1.5×high] — the floor holds",
    clamped.low === Math.floor(settle.low * 0.5) && clamped.high === Math.ceil(settle.high * 1.5))

  const lenderLine = est.lines.find((l) => l.label.startsWith("Prepaid interest"))!
  const refusals = applyAiRefinements(est.lines, [
    { label: "Prepaid interest (~15 days)", low: 1, high: 2, reason: "trust me" },
    { label: "Settlement / escrow fee", low: 500, high: 900, reason: "   " },
    { label: "Nonexistent line", low: 1, high: 2, reason: "x" },
    { label: "Appraisal", low: -50, high: 20, reason: "negative" },
  ], conv)
  check("refusals: lender-fact untouchable, empty reason refused, unknown line refused, insane range refused — nothing applied",
    refusals.applied.length === 0 && refusals.rejected.length === 4
    && refusals.rejected.some((r) => /lender-fact/.test(r.why))
    && refusals.rejected.some((r) => /no reason stated/.test(r.why))
    && refusals.lines.find((l) => l.label.startsWith("Prepaid interest"))!.low === lenderLine.low)

  const pendingEst = estimateBuyerClosingCosts({ purchasePrice: 500_000, loanAmount: null, sellerCredit: 0, state: "CA" })
  const pendingRefusal = applyAiRefinements(pendingEst.lines, [
    { label: "Lender fees (origination + underwriting)", low: 2000, high: 4000, reason: "typical" },
  ], conv)
  check("pending lines are untouchable — AI cannot invent dollars where the loan terms aren't on file",
    pendingRefusal.applied.length === 0 && /pending the lender's terms/.test(pendingRefusal.rejected[0]?.why ?? ""))
}

function wiringLayer() {
  console.log("\n[wiring — action sources the region, surfaces carry the labels, LTV re-sources hold]")
  const action = src("app/actions/buyer-closing-costs.ts")
  check("action resolves region property_state → brokerage state fallback, and passes it to the estimator",
    /property_state/.test(action) && /\(brokerage as any\)\?\.state/.test(action) && /state,\s*\n\s*\}\)/.test(action))
  check("action's AI pass is OPT-IN (refineWithAi), bounded via applyAiRefinements, gateway-routed (generateObjectRouted), deterministic floor on failure",
    /refineWithAi/.test(action) && /applyAiRefinements/.test(action)
    && /generateObjectRouted/.test(action) && /deterministic floor holds/.test(action))
  const card = src("app/components/portal/buyer-closing-costs-card.tsx")
  check("portal card renders per-line provenance (sourceBadge), the regional authority line, and the user-initiated AI refine",
    /sourceBadge/.test(card) && /Loan Estimate is the authority/.test(card) && /Sharpen this estimate with AI/.test(card))
  const push = src("lib/transactions/stage-progression.ts")
  check("closing-prep push copy carries the labels: lender terms where real, labeled regional estimate otherwise, Loan Estimate the authority",
    /labeled regional estimate/.test(push) && /Loan Estimate is the authority/.test(push) && /property_state/.test(push))
  const refi = src("app/components/portal/lifetime/RefinanceIndicatorCard.tsx")
  check("RefinanceIndicatorCard re-sources the REAL loan from transaction_lenders; 80% LTV only as the labeled fallback",
    /transaction_lenders/.test(refi) && /loan_amount, interest_rate, loan_term_years, lender_name/.test(refi)
    && /estimated — no loan record on file/.test(refi) && /per your loan record on file/.test(refi))
  check("RefinanceIndicatorCard never fabricates the original rate (record or caller override, else monitoring state)",
    /estimatedOriginalRate \?\? recordRate/.test(refi) && /market_rate_snapshots/.test(refi))
  check("lifetime home passes the closed transaction id so the card can re-source",
    /transactionId=\{transaction\.id\}/.test(src("app/portal/[contactId]/lifetime-home.tsx")))
  const scan = src("lib/wealth-advisor/scan-opportunities.ts")
  check("wealth scan re-sources equity from the prior transaction's transaction_lenders row (real amortization) with provenance in signals",
    /transaction_lenders/.test(scan) && /loanSource: LoanFigureSource|loanSource,/.test(scan)
    && /lender_record/.test(scan) && /estimated_80_ltv/.test(scan)
    && /estimated — no loan record on file/.test(scan))
  check("wealth scan narrative prompt carries the loan-figure provenance so AI copy stays estimate-framed",
    /Loan-figure provenance/.test(scan) && /loanSourceLabel/.test(scan))
  check("regional model is pure code (no tables, no supabase import) — conventions, not drifting data",
    !/supabase|createServiceClient|from\(/.test(src("lib/offers/regional-closing-costs.ts")))
  check("sim registered in package.json", src("package.json").includes("test:regional-closing-costs"))
}

function main() {
  coverageLayer()
  estimateLayer()
  aiBoundsLayer()
  wiringLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ REGIONAL_CLOSING_COSTS_FAIL"); process.exit(1) }
  console.log(" ✅ REGIONAL_CLOSING_COSTS_PASS — region-derived, provenance-labeled, lender facts win, AI bounded by the deterministic floor")
}
main()
