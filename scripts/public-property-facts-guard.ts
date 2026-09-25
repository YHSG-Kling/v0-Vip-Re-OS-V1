/**
 * scripts/public-property-facts-guard.ts — `npm run test:public-property-facts` (wave 82 lane A)
 *
 * Owner verbatim (wave 82): "the calculator was giving the property facts so the calculator was
 * calculating the correct property taxes, etc for the property landing pages, etc. is there
 * another capability that takes the ai predictions place? you can't just remove a capability."
 *
 * Proves, with ZERO network (every rung injected):
 *   Layer 1 — the RentCast property-record reader is a WHITELIST: the documented record (WITH an
 *             owner block, a mailing address and a sale price) yields tax bill / year / assessed
 *             tax basis / HOA / structure, and NONE of the owner's identity. Positive control: the
 *             fixture really carries the owner's name.
 *   Layer 2 — the rail's `public_facts` purpose walks past a hit that lacks the tax bill, fills
 *             ONLY the gaps, stops once the bill arrives, and never reaches BatchData even under
 *             an allowing policy. Positive control: `conversation` still stops at the first hit.
 *   Layer 3 — toPublicPropertyFacts lets nothing out but the whitelist: a rung that smuggles an
 *             owner name and a valuation figure gets neither through. Positive control: the rung's
 *             raw facts DO carry both.
 *   Layer 4 — the payment survivor computes tax from the property's own bill (and says so), and
 *             from the labelled rate only when no bill exists.
 *   Layer 5 — the wiring (stripped source): calculators ride the public door, rate-limit BEFORE
 *             the lookup, resolve the tenant from a listing/session/agent slug (never a body), the
 *             listing page mounts the card, public_facts is not a BatchData purpose.
 *   Layer 6 — ai-predictions: every capability still exported (nothing was removed).
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))
const code = (p: string) => blankStrings(stripped(p))

const rail = await import("../lib/ai-isa/property-lookup-rail")
const { normalizeRentcastPropertyRecord } = await import("../lib/property/rentcast")
const { estimateMonthlyPayment } = await import("../lib/buyer-offers/affordability")
type Facts = import("../lib/ai-isa/property-lookup-rail").PropertyLookupFacts
type Rungs = import("../lib/ai-isa/property-lookup-rail").PropertyLookupRungs
type Policy = import("../lib/ai-isa/property-lookup-rail").PropertyLookupPolicy

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · RentCast property record → facts only (owner never mapped)]")
// The documented example record (developers.rentcast.io/reference/property-data, fetched 2026-09-25).
const RECORD = {
  id: "5500-Grand-Lake-Dr,-San-Antonio,-TX-78244", formattedAddress: "5500 Grand Lake Dr, San Antonio, TX 78244",
  addressLine1: "5500 Grand Lake Dr", city: "San Antonio", state: "TX", zipCode: "78244",
  propertyType: "Single Family", bedrooms: 3, bathrooms: 2, squareFootage: 1878, lotSize: 8850, yearBuilt: 1973,
  lastSaleDate: "2024-11-18T00:00:00.000Z", lastSalePrice: 270000, hoa: { fee: 175 },
  taxAssessments: { "2023": { year: 2023, value: 225790, land: 59380, improvements: 166410 }, "2024": { year: 2024, value: 216513, land: 59380, improvements: 157133 } },
  propertyTaxes: { "2023": { year: 2023, total: 4201 }, "2024": { year: 2024, total: 4065 } },
  owner: { names: ["Rolando Villarreal"], type: "Individual", mailingAddress: { formattedAddress: "PO Box 9, Somewhere, TX 78000" } },
  ownerOccupied: true,
}
const f = normalizeRentcastPropertyRecord(RECORD)
check("POSITIVE CONTROL: the fixture really carries the owner's name, mailing address and a sale price",
  JSON.stringify(RECORD).includes("Rolando Villarreal") && JSON.stringify(RECORD).includes("PO Box 9") && JSON.stringify(RECORD).includes("270000"))
check("the LATEST tax bill and its year arrive (2024: $4,065)", f.annualPropertyTax === 4065 && f.taxYear === 2024, JSON.stringify(f))
check("the latest assessed tax basis arrives (2024: $216,513) and the HOA fee ($175/mo)", f.assessedValue === 216513 && f.hoaMonthly === 175)
check("structure facts arrive (3 bd / 2 ba / 1,878 sf / 1973 / 8,850 sf lot)",
  f.bedrooms === 3 && f.bathrooms === 2 && f.squareFeet === 1878 && f.yearBuilt === 1973 && f.lotSizeSqft === 8850)
const fJson = JSON.stringify(f)
check("NO owner identity leaves the reader (name, mailing address, occupancy, sale price, sale date)",
  !/Rolando|Villarreal|PO Box|owner|mailing|270000|2024-11-18/i.test(fJson), fJson)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · public_facts walks on until the tax bill arrives; never BatchData]")
const ALLOW: Policy = { batchDataTier: "lean", batchDataOptedIn: true }
const base = (source: Facts["source"], extra: Partial<Facts> = {}): Facts => ({
  address: "123 Main St", city: "Austin", state: "TX", zip: "78701", beds: null, baths: null, sqft: null, yearBuilt: null,
  lotSize: null, propertyType: null, listingStatus: null, listPrice: null, estimatedValue: null, taxAssessedValue: null,
  annualPropertyTax: null, propertyTaxYear: null, hoaMonthly: null, mlsNumber: null, listingUrl: null, lat: null, lon: null,
  isEstimate: false, source, sourceNote: `fixture ${source}.`, ...extra,
})
const calls: string[] = []
const rungs: Rungs = {
  cache: async () => { calls.push("cache"); return base("cache", { beds: 3, baths: 2, sqft: 1800, listPrice: 425000, hoaMonthly: 60, listingStatus: "active" }) },
  tenant_idx: async () => { calls.push("tenant_idx"); return null },
  rentcast: async () => { calls.push("rentcast"); return base("rentcast", { beds: 4, annualPropertyTax: 6120, propertyTaxYear: 2025, taxAssessedValue: 390000, hoaMonthly: 999 }) },
  public_records: async () => { calls.push("public_records"); return base("public_records", { annualPropertyTax: 1 }) },
  batchdata: async () => { calls.push("batchdata"); return base("batchdata", { annualPropertyTax: 2, estimatedValue: 500000 }) },
}
const addr = { street: "123 Main St", city: "Austin", state: "TX", zip: "78701" }
const pub = await rail.lookupPublicPropertyFacts({ brokerageId: "b-1", address: addr }, { rungs, policy: ALLOW })
check("the ladder ran cache → tenant_idx → rentcast and STOPPED once the tax bill arrived (public_records / batchdata never called)",
  calls.join(",") === "cache,tenant_idx,rentcast", calls.join(","))
check("the tax bill + year + assessed basis came from the rung that had them (RentCast)",
  pub.facts?.annualPropertyTax === 6120 && pub.facts?.propertyTaxYear === 2025 && pub.facts?.assessedValueForTax === 390000)
check("gaps only: the FIRST rung's facts win (own listing beds 3, HOA $60, list price) — RentCast's beds 4 / HOA 999 did not overwrite",
  pub.facts?.beds === 3 && pub.facts?.hoaMonthly === 60 && pub.facts?.listPrice === 425000 && pub.facts?.source === "cache")
calls.length = 0
const noTax = await rail.lookupPublicPropertyFacts({ brokerageId: "b-1", address: addr }, {
  rungs: { ...rungs, rentcast: async () => { calls.push("rentcast"); return null }, public_records: async () => { calls.push("public_records"); return null } },
  policy: ALLOW,
})
check("no rung has a bill → every non-BatchData rung tried, BatchData NEVER (public_facts is not a BatchData purpose), facts still returned",
  calls.join(",") === "cache,tenant_idx,rentcast,public_records" && noTax.found && noTax.facts?.annualPropertyTax === null
  && noTax.skipped.some((s) => s.rung === "batchdata" && /public_facts/.test(s.reason)), `${calls.join(",")} ${JSON.stringify(noTax.skipped)}`)
check("public_facts is NOT in BATCHDATA_ELIGIBLE_PURPOSES and the ONE gate refuses it under an allowing policy",
  !rail.BATCHDATA_ELIGIBLE_PURPOSES.has("public_facts") && !rail.decideBatchDataAccess({ brokerageId: "b-1", purpose: "public_facts" }, ALLOW).allowed)
check("a tenant-less public lookup is refused (§4)",
  !(await rail.lookupPublicPropertyFacts({ brokerageId: "", address: addr }, { rungs, policy: ALLOW })).found)
calls.length = 0
await rail.lookupPropertyForConversation({ brokerageId: "b-1", purpose: "conversation", audience: "customer", address: addr }, { rungs, policy: ALLOW })
check("POSITIVE CONTROL: a `conversation` still short-circuits at the FIRST answer (the walk-on rule is purpose-scoped)",
  calls.join(",") === "cache", calls.join(","))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · the public projection is a whitelist]")
const smuggled = { ...base("rentcast", { annualPropertyTax: 5000, estimatedValue: 777777, taxAssessedValue: 300000 }), ownerName: "Jane Owner", ownerPhone: "5125550100" } as unknown as Facts
const raw = await rail.lookupPropertyForConversation({ brokerageId: "b-1", purpose: "public_facts", audience: "public", address: addr }, {
  rungs: { ...rungs, cache: async () => smuggled }, policy: ALLOW,
})
check("POSITIVE CONTROL: the rung's raw facts DO carry an owner name, an owner phone (smuggled) — the audience redaction alone keeps them",
  JSON.stringify(raw.facts).includes("Jane Owner") && JSON.stringify(raw.facts).includes("5125550100"))
check("the public audience strips the valuation figure even before projection", raw.facts?.estimatedValue === null)
const projected = rail.toPublicPropertyFacts(raw.facts!)
const allowedKeys = new Set<string>([...rail.PUBLIC_PROPERTY_FACT_FIELDS, "assessedValueForTax"])
const pj = JSON.stringify(projected)
check("toPublicPropertyFacts: every key is on the whitelist (no owner name, no phone, no estimatedValue)",
  Object.keys(projected).every((k) => allowedKeys.has(k)) && !/Jane Owner|5125550100|777777/.test(pj) && !("estimatedValue" in projected), pj)
check("the whitelist names no identity- or value-shaped field",
  !rail.PUBLIC_PROPERTY_FACT_FIELDS.some((k) => /owner|name|phone|email|estimated|value/i.test(k)))
check("the assessed value leaves ONLY under its labelled tax-basis name", projected.assessedValueForTax === 300000)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · the payment survivor computes tax from the property's own bill]")
const withBill = estimateMonthlyPayment({ price: 425000, annualPropertyTax: 6120, hoaMonthly: 60 })
const withRate = estimateMonthlyPayment({ price: 425000, propertyTaxRatePct: 1.1 })
check("with a county bill: tax line = bill / 12 ($510.00), basis county_tax_bill, HOA carried",
  withBill.propertyTax === 510 && withBill.taxBasis === "county_tax_bill" && withBill.hoa === 60, JSON.stringify(withBill))
check("without a bill: the labelled rate (1.1% of $425k / 12 = $389.58), basis rate_estimate",
  withRate.propertyTax === 389.58 && withRate.taxBasis === "rate_estimate", JSON.stringify(withRate))
check("a zero / negative bill is not a bill (falls back to the rate)", estimateMonthlyPayment({ price: 425000, annualPropertyTax: 0 }).taxBasis === "rate_estimate")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · wiring (stripped source)]")
const calc = code("app/actions/calculators.ts")
const calcStr = stripped("app/actions/calculators.ts")
check("POSITIVE CONTROL: a comment-only phrase is absent from stripped calculators.ts", !calcStr.includes("that was the regression"))
check("calculateHomeValue + getPublicPropertyFacts ride lookupPublicPropertyFacts (×2) and never the customer-conversation reach",
  (calcStr.match(/lookupPublicPropertyFacts\(\{/g) ?? []).length === 2 && !/lookupPropertyForConversation\(/.test(calcStr))
check("calculators.ts imports no BatchData module", !/batchdata/i.test(stripComments(calcStr)))
const gfn = calcStr.slice(calcStr.indexOf("export async function getPublicPropertyFacts"))
check("getPublicPropertyFacts rate-limits BEFORE resolving the tenant and BEFORE the lookup",
  gfn.indexOf('publicCalcRateVerdict("propertyFacts")') >= 0
  && gfn.indexOf('publicCalcRateVerdict("propertyFacts")') < gfn.indexOf("resolvePublicCalculatorTenant(")
  && gfn.indexOf("resolvePublicCalculatorTenant(") < gfn.indexOf("lookupPublicPropertyFacts("))
check("the tenant resolver is file-local (not a public endpoint) and reads listing → session → agent slug, never a body uuid",
  /\nasync function resolvePublicCalculatorTenant\(/.test(calc) && !/export async function resolvePublicCalculatorTenant/.test(calc)
  && /getListingBySlug\(/.test(calc) && /getAgentContext\(\)/.test(calc) && /getAgentBySlug\(/.test(calc)
  && !/brokerageId: input\.brokerageId/.test(calc))
check("a listing-opened lookup uses the LISTING's address (tenant.listing?.address first), so a visitor cannot aim a metered read under a tenant's name",
  /const street = tenant\.listing\?\.address \?\?/.test(calc))
check("calculatePropertyPayment feeds the property's own bill + HOA into estimateMonthlyPayment",
  /estimateMonthlyPayment\(\{[\s\S]{0,300}annualPropertyTax: facts\?\.annualPropertyTax[\s\S]{0,80}hoaMonthly: facts\?\.hoaMonthly/.test(calcStr))
check("the listing landing page mounts the payment card with the listing id (click-to-run, no spend on render)",
  /<PropertyPaymentCard listingSlug=\{listing\.id\} \/>/.test(stripped("app/listing/[slug]/page.tsx"))
  && /onClick=\{run\}/.test(stripped("app/components/listing-landing/PropertyPaymentCard.tsx")))
const railSrc = stripped("lib/ai-isa/property-lookup-rail.ts")
check("the RentCast rung reads the PROPERTY RECORD (tax/HOA) for public_facts, the listing search otherwise",
  /if \(req\.purpose === "public_facts"\)[\s\S]{0,400}getRentcastPropertyRecord\(/.test(railSrc) && /searchRentcastSaleListings\(/.test(railSrc))
check("the own-listing cache rung carries hoa_dues; the public-records rung carries the tax bill",
  /hoa_dues/.test(railSrc) && /annualPropertyTax: num\(r\.annualPropertyTax\)/.test(railSrc)
  && /"annualPropertyTax":/.test(read("lib/property/address-lookup.ts")))
check("getRentcastPropertyRecord is gated + metered like every RentCast reader",
  /export async function getRentcastPropertyRecord[\s\S]{0,300}gateRentcast\(params\)[\s\S]{0,400}meterCall\(\{/.test(stripped("lib/property/rentcast.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · ai-predictions — nothing was removed]")
const PRED_EXPORTS = [
  "predictLeadConversion", "getLeadPredictions", "batchPredictLeadConversions", "getTopConversionCandidates", "refreshStalePredictions",
  "enableAIPilot", "getActiveAutoPilotPlans", "toggleAutoPilot", "predictDealCloseProbability", "analyzeConversation",
  "getConversationIntelligence", "getAgentCoachingInsights", "aiPropertyMatchGenius", "massGenerateCMAs", "predictWinningOffer",
  "aiNegotiationAdvisor", "predictMarketShift", "findMarketArbitrage", "detectClientChurn", "optimizeShowingRoute",
  "findHiddenOpportunities", "mineSphereOfInfluence", "competitiveIntelligence",
]
const pred = stripped("app/actions/ai-predictions.ts")
const missing = PRED_EXPORTS.filter((n) => !new RegExp(`export async function ${n}\\(`).test(pred))
check(`all ${PRED_EXPORTS.length} ai-predictions capabilities are still exported (the wave-81 deletion was an unused variable)`, missing.length === 0, missing.join(","))
check("POSITIVE CONTROL: the export finder does flag a missing capability", !new RegExp(`export async function notARealPrediction\\(`).test(pred))
check("findMarketArbitrage still sweeps the IDX feed (its capability intact)", /export async function findMarketArbitrage[\s\S]{0,1200}searchActiveListings\(/.test(pred))

console.log("\n" + "─".repeat(60))
console.log(" blind spots: RentCast's live /properties payload and the Perplexity public-records answer are not exercised (no network); the fixture is RentCast's documented example.")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" FAILURES:")
  for (const x of failures) console.log(`   · ${x}`)
  process.exit(1)
}
