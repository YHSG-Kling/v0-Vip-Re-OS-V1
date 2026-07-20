#!/usr/bin/env tsx
/**
 * scripts/seller-closing-costs-simulator.ts   (npm run test:seller-closing-costs)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the SELLER CLOSING-COST side (owner round 36: "closing costs is for
 * seller side and another closing costs for buyer side"):
 *
 * COMPLEMENT: sellerShareFactor is the exact complement of buyerShareFactor on
 *             every payer, across ALL 51 regions' transfer + owner-title payers
 *             — the two sides can never double-claim or drop a cost.
 * HONESTY:    commission is NEVER an assumed percentage (records only, with
 *             provenance, else pending); the mortgage payoff is honestly
 *             "payoff pending", never $0; regional lines carry "regional
 *             estimate — {state} conventions"; the SETTLEMENT STATEMENT is the
 *             named authority.
 * KEEP-ONE:   the net sheet stays the canonical seller-money surface — this
 *             module supplies its CLOSING-COST section (flat default replaced
 *             by the labeled regional band midpoint, manual override preserved)
 *             in the kernel runner, the interactive sheet, and the portal
 *             calculator.
 * ACCURACY:   the round-34 flywheel extends to the sale side — seller-line
 *             deltas off the settlement statement (side discriminator via
 *             migration 1105, REPORT-ONLY), and the prediction-accuracy
 *             closing_costs rail gains an additive buyer/seller breakdown.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ALL_REGION_CODES,
  getRegionalConventions,
  buyerShareFactor,
  sellerShareFactor,
  type CustomaryPayer,
} from "../lib/offers/regional-closing-costs"
import {
  estimateSellerClosingCosts,
  resolveSellerCommission,
  disclosedBuyerAgentCommissionNote,
  deriveNetSheetClosingCostSection,
} from "../lib/offers/seller-closing-costs"
import {
  parseSellerSettlementFigures,
  mapSellerAccuracyLines,
  summarizeAccuracyObservations,
  SELLER_ACCURACY_LINE_LABELS,
  type AccuracyLine,
} from "../lib/offers/closing-cost-accuracy"
import { summarizeClosingCostRows } from "../lib/analytics/prediction-accuracy"
import { decideNetSheetPolicy, defaultProvenance } from "../lib/offers/net-sheet-calc"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function complementLayer() {
  console.log("\n[complement — seller shares are the exact complement of buyer shares, all 51 regions]")
  const payers: CustomaryPayer[] = ["buyer", "seller", "split", "varies", "none"]
  check("payer table: seller=1, buyer=0, split=0.5, varies=0.5–1 (honest width), none=0 for BOTH sides",
    sellerShareFactor("seller").low === 1 && sellerShareFactor("seller").high === 1
    && sellerShareFactor("buyer").low === 0 && sellerShareFactor("buyer").high === 0
    && sellerShareFactor("split").low === 0.5 && sellerShareFactor("split").high === 0.5
    && sellerShareFactor("varies").low === 0.5 && sellerShareFactor("varies").high === 1
    && sellerShareFactor("none").low === 0 && sellerShareFactor("none").high === 0
    && buyerShareFactor("none").low === 0 && buyerShareFactor("none").high === 0)
  check("complement identity on every payer except 'none' (sellerLow = 1 − buyerHigh, sellerHigh = 1 − buyerLow)",
    payers.filter((p) => p !== "none").every((p) => {
      const b = buyerShareFactor(p), s = sellerShareFactor(p)
      return s.low + b.high === 1 && s.high + b.low === 1
    }))
  check("all 51 regions: transfer-tax AND owner-title payers complement (no cost double-claimed or dropped)",
    ALL_REGION_CODES.length === 51 && ALL_REGION_CODES.every((code) => {
      const c = getRegionalConventions(code)!
      return [c.transferTaxPayer, c.ownerTitlePayer].every((p) => {
        const b = buyerShareFactor(p), s = sellerShareFactor(p)
        return p === "none"
          ? b.low === 0 && b.high === 0 && s.low === 0 && s.high === 0
          : s.low + b.high === 1 && s.high + b.low === 1
      })
    }))
}

function estimatorLayer() {
  console.log("\n[estimator — deal facts with provenance, regional labels, pending stays honest]")
  const tx = estimateSellerClosingCosts({
    salePrice: 500_000,
    state: "TX",
    commission: { kind: "rate", rateDecimal: 0.055, sourceNote: "per the listing agreement rate on file" },
    mortgagePayoff: null,
    buyerClosingCredit: 5_000,
  })
  check("TX: region resolves with the regional label", tx.regionState === "TX" && tx.regionLabel === "regional estimate — Texas conventions")
  const commission = tx.lines.find((l) => l.label === "Real estate commission")!
  check("commission is a DEAL FACT from the record: 5.5% of $500k = $27,500, provenance on the line",
    commission.source === "deal_fact" && commission.low === 27_500 && commission.high === 27_500
    && /per the listing agreement rate on file/.test(commission.sourceLabel ?? ""))
  const payoff = tx.lines.find((l) => l.label === "Mortgage payoff")!
  check("payoff pending — excluded from totals, note says a $0 placeholder would overstate the net",
    payoff.pending === true && payoff.low === 0 && /payoff pending/.test(payoff.note ?? "") && /overstate/.test(payoff.note ?? "")
    && tx.payoffKnown === false)
  const ownerTitle = tx.lines.find((l) => l.label === "Owner's title insurance (seller share)")!
  check("TX owner's title: SELLER-customary → full band lands on the seller ($2,500–$3,500)",
    ownerTitle.low === 2_500 && ownerTitle.high === 3_500 && ownerTitle.source === "regional_estimate")
  const transfer = tx.lines.find((l) => l.label === "Transfer / deed tax (seller share)")!
  check("TX transfer: no transfer tax → 0 band, still labeled", transfer.low === 0 && transfer.high === 0 && transfer.sourceLabel === tx.regionLabel)
  check("every regional line carries 'regional estimate — Texas conventions'",
    tx.lines.filter((l) => l.source === "regional_estimate").length >= 4
    && tx.lines.filter((l) => l.source === "regional_estimate").every((l) => l.sourceLabel === "regional estimate — Texas conventions"))
  const credit = tx.lines.find((l) => l.label === "Buyer closing-cost credit")!
  check("buyer credit is a deal fact per the accepted offer", credit.source === "deal_fact" && credit.low === 5_000)
  const proration = tx.lines.find((l) => l.label === "Property-tax proration")!
  check("property-tax proration is a NOTE (pending, no invented dollars), names the state band",
    proration.pending === true && proration.low === 0 && /paid-through status/.test(proration.note ?? "") && /Texas effective property tax/.test(proration.note ?? ""))
  check("totals exclude pending lines and reconcile to the non-pending sum",
    tx.totalLow === tx.lines.reduce((s, l) => s + (l.pending ? 0 : l.low), 0)
    && tx.totalHigh === tx.lines.reduce((s, l) => s + (l.pending ? 0 : l.high), 0) && tx.totalLow > 27_500)
  check("disclaimer: the SETTLEMENT STATEMENT is the named authority + pending payoff called out",
    /settlement statement/.test(tx.disclaimer) && /the settlement statement is the authority/.test(tx.disclaimer)
    && /payoff/.test(tx.disclaimer) && /excluded from the totals, not zero/.test(tx.disclaimer))

  // Commission NEVER assumed: no record → pending, excluded, says so.
  const noCommission = estimateSellerClosingCosts({ salePrice: 500_000, state: "TX", commission: null })
  const pendingCommission = noCommission.lines.find((l) => l.label === "Real estate commission")!
  check("no commission record → PENDING (never an assumed %), excluded from totals, disclaimer names it",
    noCommission.commissionKnown === false && pendingCommission.pending === true && pendingCommission.low === 0
    && /NEVER assumed/.test(pendingCommission.note ?? "")
    && /a rate is never assumed/.test(noCommission.disclaimer)
    && noCommission.totalLow === noCommission.lines.reduce((s, l) => s + (l.pending ? 0 : l.low), 0))

  // Payoff as a real record rides with provenance.
  const withPayoff = estimateSellerClosingCosts({
    salePrice: 500_000, state: "TX",
    commission: { kind: "amount", amount: 25_000, sourceNote: "per the transaction's commission record" },
    mortgagePayoff: { amount: 210_000, sourceNote: "per the payoff statement on file" },
  })
  const realPayoff = withPayoff.lines.find((l) => l.label === "Mortgage payoff")!
  check("real payoff record → deal_fact line with its provenance, included in totals",
    withPayoff.payoffKnown && realPayoff.source === "deal_fact" && realPayoff.low === 210_000
    && /per the payoff statement on file/.test(realPayoff.sourceLabel ?? "") && withPayoff.totalLow >= 235_000)

  // DE split transfer: the seller's half of 4% on $400k ≈ $8k.
  const de = estimateSellerClosingCosts({ salePrice: 400_000, state: "Delaware", commission: null })
  const deTransfer = de.lines.find((l) => l.label === "Transfer / deed tax (seller share)")!
  check("DE (full-name input): seller's half of the 4% transfer tax = $8,000", de.regionState === "DE" && deTransfer.low === 8_000 && deTransfer.high === 8_000)

  // TN: one of the two buyer-pays-transfer conventions — seller band 0 with the honest note.
  const tn = estimateSellerClosingCosts({ salePrice: 400_000, state: "TN", commission: null })
  const tnTransfer = tn.lines.find((l) => l.label === "Transfer / deed tax (seller share)")!
  check("TN: buyer-paid transfer convention → seller band 0 and the note SAYS buyer-paid",
    tnTransfer.low === 0 && tnTransfer.high === 0 && /BUYER-paid in Tennessee/.test(tnTransfer.note ?? ""))

  // CA 'varies' owner-title custom → honestly wide seller band (0.5–1×).
  const ca = estimateSellerClosingCosts({ salePrice: 500_000, state: "CA", commission: null })
  const caTitle = ca.lines.find((l) => l.label === "Owner's title insurance (seller share)")!
  check("CA owner-title 'varies' → seller band spans half-to-full (honest width, no faked custom)",
    caTitle.low === 500 && caTitle.high === 2_250)

  // Attorney state renames the settlement line honestly.
  const ma = estimateSellerClosingCosts({ salePrice: 600_000, state: "MA", commission: null })
  check("MA: seller's closing ATTORNEY fee line, says it's an attorney-closing state",
    ma.lines.some((l) => l.label === "Seller's closing attorney fee" && /attorney-closing state/.test(l.note ?? "")))

  // Unknown state → generic industry bands, no regional labels anywhere.
  const generic = estimateSellerClosingCosts({ salePrice: 500_000, commission: null })
  check("no state → generic bands, regionState null, zero regional labels (never a guessed state)",
    generic.regionState === null && generic.regionLabel === null
    && generic.lines.every((l) => l.source !== "regional_estimate"))

  // Commission resolution hierarchy — records only.
  check("resolveSellerCommission: recorded amount beats listing rate beats tx rate; nothing → null (pending)",
    resolveSellerCommission({ transactionCommissionAmount: 24_000, listingCommissionRatePct: 5 })!.kind === "amount"
    && (resolveSellerCommission({ listingCommissionRatePct: 5.5 }) as any).rateDecimal === 0.055
    && /listing agreement/.test(resolveSellerCommission({ listingCommissionRatePct: 5.5 })!.sourceNote)
    && (resolveSellerCommission({ transactionCommissionPct: 6 }) as any).rateDecimal === 0.06
    && resolveSellerCommission({}) === null
    && resolveSellerCommission({ listingCommissionRatePct: 0 }) === null)
  check("post-NAR disclosed buyer-agent share: seller-payer disclosure → note; buyer-payer/no figure → null",
    /2\.5%, seller-paid/.test(disclosedBuyerAgentCommissionNote({ disclosed_buyer_commission_pct: 2.5, disclosed_commission_payer: "seller" }) ?? "")
    && /\$5,000, seller-paid/.test(disclosedBuyerAgentCommissionNote({ disclosed_buyer_commission_flat: 5_000, disclosed_commission_payer: "seller" }) ?? "")
    && disclosedBuyerAgentCommissionNote({ disclosed_buyer_commission_pct: 2.5, disclosed_commission_payer: "buyer" }) === null
    && disclosedBuyerAgentCommissionNote({ disclosed_commission_payer: "seller" }) === null)
}

function netSheetKeepOneLayer() {
  console.log("\n[net-sheet keep-one — the closing-cost section feeds the canonical seller surface]")
  const section = deriveNetSheetClosingCostSection(500_000, "TX")!
  check("section: REGIONAL lines only — no commission, no payoff, no pending proration (the net sheet's own inputs)",
    !!section && section.lines.every((l) => l.source === "regional_estimate" && !l.pending)
    && !section.lines.some((l) => l.label === "Real estate commission" || l.label === "Mortgage payoff" || l.label === "Buyer closing-cost credit"))
  check("section band sums its lines; midpoint is the band midpoint; the regional label rides along",
    section.low === section.lines.reduce((s, l) => s + l.low, 0)
    && section.high === section.lines.reduce((s, l) => s + l.high, 0)
    && section.midpoint === Math.round((section.low + section.high) / 2)
    && section.regionLabel === "regional estimate — Texas conventions" && section.high > section.low)
  check("unknown state / bad price → null (the flat default stands, honestly unlabeled)",
    deriveNetSheetClosingCostSection(500_000, "Narnia") === null
    && deriveNetSheetClosingCostSection(null, "TX") === null
    && deriveNetSheetClosingCostSection(0, "TX") === null)

  // The provenance stays on the disclose-first list — a regional band is a LABELED estimate, not a fact.
  const prov = defaultProvenance()
  ;(prov as any).otherProratedFees = "regional_estimate"
  ;(prov as any).mortgagePayoff = "confirmed"
  const verdict = decideNetSheetPolicy(prov)
  check("net-sheet policy: regional_estimate lines stay on the needs-confirmation (disclose) list",
    verdict.needsConfirmation.includes("otherProratedFees"))

  const runner = src("lib/kernel/offer-net-sheet.ts")
  check("kernel runner derives the section (state known) into otherProratedFees with regional_estimate provenance; costsResolver still wins",
    /deriveNetSheetClosingCostSection/.test(runner)
    && /provenance\.otherProratedFees = "regional_estimate"/.test(runner)
    && /!opts\.costsResolver/.test(runner))
  const calc = src("lib/offers/net-sheet-calc.ts")
  check("net-sheet-calc: regional_estimate is a first-class CostLineSource and disclose-listed",
    /"regional_estimate"/.test(calc) && /prov\[k\] === "default" \|\| prov\[k\] === "regional_estimate"/.test(calc))
  const sheet = src("app/components/features/offers/interactive-net-sheet.tsx")
  check("interactive net sheet renders the section with its regional label + settlement-statement authority; field stays editable",
    /closingCostSection/.test(sheet) && /regionLabel/.test(sheet)
    && /settlement\s+statement is the authority/.test(sheet) && /Edit the field to override/.test(sheet))
  const dash = src("app/dashboard/listings/[id]/offers/page.tsx")
  check("agent offers page derives the section from the listing's state and mounts it (midpoint default)",
    /deriveNetSheetClosingCostSection/.test(dash) && /closingCostSection=\{closingCostSection\}/.test(dash)
    && /netSheetCosts\.otherProratedFees = closingCostSection\.midpoint/.test(dash))
  const portal = src("app/components/portal/NetSheetCalculator.tsx")
  check("portal calculator: closing-costs default derives from the regional band; MANUAL OVERRIDE preserved; provenance rendered",
    /deriveNetSheetClosingCostSection/.test(portal) && /closingCostsOverridden/.test(portal)
    && /regionLabel/.test(portal) && /settlement statement is\s*(?:\n\s*)?the authority/.test(portal))
  check("seller portal offers page passes the listing's state (no new page — mounted on the existing net surface)",
    /state=\{listing\.state \?\? null\}/.test(src("app/portal/[contactId]/offers/page.tsx")))
}

function accuracyLayer() {
  console.log("\n[accuracy — seller-line deltas off the settlement statement, side-discriminated ledger]")
  check("parseSellerSettlementFigures: tolerant money parse, absent stays null, negatives refused",
    (() => {
      const f = parseSellerSettlementFigures({
        commission: "$27,500", mortgage_payoff: 210000, title_fees: "3,000",
        transfer_taxes: 500, seller_net: "251,000", junk: "n/a",
      })
      const neg = parseSellerSettlementFigures({ commission: -5 })
      return f.commission === 27_500 && f.mortgagePayoff === 210_000 && f.titleEscrow === 3_000
        && f.transferTax === 500 && f.netToSeller === 251_000
        && neg.commission === null && parseSellerSettlementFigures(null).commission === null
    })())

  const est = estimateSellerClosingCosts({
    salePrice: 500_000, state: "TX",
    commission: { kind: "rate", rateDecimal: 0.055, sourceNote: "per the listing agreement rate on file" },
    mortgagePayoff: null,
  })
  const lines = mapSellerAccuracyLines(est.lines, {
    commission: 27_500, mortgagePayoff: 210_000, titleEscrow: 3_000, transferTax: 500, netToSeller: null,
  })
  check("clean mappings only: commission graded (in band), title+settlement graded as the SUMMED band, PENDING payoff NOT graded, zero-band TX transfer NOT graded",
    lines.length === 2
    && lines.some((l) => l.key === "commission" && l.withinBand && l.deltaFromMid === 0)
    && lines.some((l) => l.key === "seller_title_settlement" && l.withinBand
        && l.estimateLow === 2_500 + 180 && l.estimateHigh === 3_500 + 700)
    && !lines.some((l) => l.key === "mortgage_payoff") && !lines.some((l) => l.key === "seller_transfer_tax"))
  const missLines = mapSellerAccuracyLines(est.lines, {
    commission: null, mortgagePayoff: null, titleEscrow: 10_000, transferTax: null, netToSeller: 250_000,
  })
  check("absent actuals are NOT graded (never a fabricated $0 delta); an out-of-band actual grades honestly false; netToSeller is never a line (the reconciliation rail owns it)",
    missLines.length === 1 && missLines[0].key === "seller_title_settlement" && missLines[0].withinBand === false)

  const report = summarizeAccuracyObservations([
    { state: "TX", lines: lines as AccuracyLine[] },
    { state: "TX", lines: missLines as AccuracyLine[] },
  ])
  check("per-state report carries the SELLER keys with seller labels (ungraded keys never appear)",
    report.length === 1 && report[0].observationCount === 2
    && report[0].lines.some((l) => l.key === "commission" && l.label === SELLER_ACCURACY_LINE_LABELS.commission)
    && report[0].lines.some((l) => l.key === "seller_title_settlement")
    && !report[0].lines.some((l) => l.key === "mortgage_payoff"))

  const acc = src("lib/offers/closing-cost-accuracy.ts")
  check("seller recorder: CLOSED-only, SALE-side gate, records-only commission, side:'seller' upsert on (transaction_id,document_id,side)",
    /recordSellerClosingCostAccuracy/.test(acc) && /not a sale-side transaction/.test(acc)
    && /resolveSellerCommission/.test(acc) && /side: "seller"/.test(acc)
    && /onConflict: "transaction_id,document_id,side"/.test(acc)
    && /migration 1105/.test(acc))
  check("buyer writer keeps working both sides of migration 1105: side:'buyer' + 3-col conflict, legacy 2-col fallback",
    /side: "buyer"/.test(acc) && /onConflict: "transaction_id,document_id" \}/.test(acc))
  check("combined entrypoint grades BOTH sides (existing hook wiring unchanged); seller failure never blocks the buyer path",
    /const buyer = await recordBuyerClosingCostAccuracy/.test(acc) && /seller = await recordSellerClosingCostAccuracy/.test(acc))

  const mig = src("scripts/1105-closing-cost-accuracy-side.sql")
  check("migration 1105 (REPORT-ONLY, not applied): side column defaulting 'buyer', CHECK buyer/seller, unique (transaction_id, document_id, side)",
    /ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'buyer'/.test(mig)
    && /CHECK \(side IN \('buyer', 'seller'\)\)/.test(mig)
    && /\(transaction_id, document_id, side\)/.test(mig)
    && /REPORT-ONLY/.test(mig))

  // Prediction-accuracy rail: additive buyer/seller breakdown, shape unchanged.
  const buyerLine: AccuracyLine = { key: "owner_title", label: "Owner's title insurance", estimateLow: 1000, estimateHigh: 2000, actual: 1500, deltaFromMid: 0, withinBand: true }
  const rail = summarizeClosingCostRows([
    { state: "TX", lines: [buyerLine], created_at: "2026-07-01T00:00:00Z" },                 // pre-1105 row: no side → buyer
    { state: "TX", lines: lines as AccuracyLine[], created_at: "2026-07-02T00:00:00Z", side: "seller" },
  ])
  check("closing_costs rail: existing shape intact (available, withinRate, per-state breakdown) + additive sideBreakdown buyer/seller",
    rail.available && rail.rail === "closing_costs" && rail.observations === 2
    && Array.isArray(rail.breakdown) && rail.breakdown!.some((b) => b.group === "TX")
    && Array.isArray(rail.sideBreakdown)
    && rail.sideBreakdown!.some((b) => b.group === "buyer" && b.observations === 1)
    && rail.sideBreakdown!.some((b) => b.group === "seller" && b.observations === 1 && b.withinRate === 1))
  check("side-less rows are buyer-side by construction (never guessed as seller)",
    summarizeClosingCostRows([{ state: "TX", lines: [buyerLine], created_at: null }]).sideBreakdown!.every((b) => b.group === "buyer"))
  const pa = src("lib/analytics/prediction-accuracy.ts")
  check("adapter survives a pre-1105 ledger: selects side, falls back to the legacy select instead of going dark",
    /state, lines, created_at, side/.test(pa) && /buildQuery\(false\)/.test(pa))
}

function main() {
  complementLayer()
  estimatorLayer()
  netSheetKeepOneLayer()
  accuracyLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SELLER_CLOSING_COSTS_FAIL"); process.exit(1) }
  console.log(" ✅ SELLER_CLOSING_COSTS_PASS — seller shares complement buyer shares, commission never assumed, payoff honest-pending, net-sheet keep-one, settlement statement the authority")
}
main()
