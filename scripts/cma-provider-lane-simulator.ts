#!/usr/bin/env tsx
/**
 * scripts/cma-provider-lane-simulator.ts   (tsx scripts/cma-provider-lane-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CMA PROVIDER LANE — WHO SERVES WHICH SIDE, AND WHAT A PROVIDER'S OWN
 * ESTIMATE IS ALLOWED TO BECOME.
 *
 * OWNER, VERBATIM:
 *   "rentcast is how we make available mls info if the tenant doesn't have
 *    idxbroker setup and we use perplexity for under contract or pending
 *    property listings which rentcast doesn't hold. this comps searching was
 *    already established and then we use the current years state appraiser
 *    guidelines for adjustments. getting a cma is very complicated and rentcast
 *    does ovver an avm which can be argued but a possible baseline."
 *
 * Four claims live in that paragraph, and this proof stands over all four.
 *
 *   P1  SOURCING PRECEDENCE. A tenant who has connected their OWN IDX Broker
 *       account is not billed for the platform's RentCast — not for the active
 *       side and not for the sold side. The decision is made BEFORE the pull.
 *
 *   P2  PERPLEXITY NEVER REACHES THE CLOSED SET. The AI gap-fill exists for the
 *       pending/active sides RentCast structurally cannot serve. Closed sales
 *       are the ONLY input to the dollar range, so an AI-sourced sale price
 *       would not degrade the estimate — it would BECOME it. The proof feeds a
 *       gap-filler that RETURNS closed comps anyway and requires that none of
 *       them survive.
 *
 *   P3  THE AVM IS A BASELINE, NEVER THE ANSWER. RentCast's automated valuation
 *       is carried, labelled, and structurally separated from the value
 *       conclusion. It never becomes estimatedValueMid, it never becomes
 *       cma_reports.recommended_price, and an empty comp set is NOT rescued by
 *       an available AVM — a CMA with no closed sale still produces no range.
 *
 *   P4  A MISSING BASELINE READS AS MISSING. Refused, suppressed, unreachable or
 *       simply absent → `available: false`, `value: null`, and a plain sentence.
 *       Never 0, never a silently omitted line.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 * TWO LAYERS, and the first one is the one that matters.
 *
 *   BEHAVIOUR — the REAL `sourceCompsForCma` and `runAiCma` are executed. Only
 *   the lane's EDGES are stubbed (the RentCast client, the eligibility gate, the
 *   IDX client, the Perplexity finder, the rate table, the narrative model), so
 *   what is asserted is what the production functions actually do with a given
 *   provider state — not what their source text looks like. `server-only` is a
 *   build marker that throws outside a React Server Component, so it and the
 *   edge modules are redirected through `registerHooks` to stubs that dispatch
 *   via globalThis, which is what lets one cached module graph be re-aimed per
 *   scenario.
 *
 *   CONSTRUCT — a small number of facts a behaviour test cannot see: that
 *   `app/actions/ai-cma.ts` writes `recommended_price` from the comp-bounded
 *   pricing strategy and never from the AVM, and that the range computation
 *   never reads the baseline.
 *
 * ── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
 * Each control writes the real defect into the real file and re-runs the WHOLE
 * behaviour layer IN A CHILD PROCESS — a fresh module graph, because these are
 * runtime assertions and a patched file cannot be re-imported into a cached
 * one. The patch is verified to have applied (a find-string that silently stops
 * matching is theatre), the child is required to EXIT NON-ZERO, and the file is
 * restored and re-verified by sha256.
 *
 * ── WHAT THIS PROOF DELIBERATELY ONLY WARNS ABOUT ───────────────────────────
 * The owner said "the CURRENT YEARS state appraiser guidelines". The adjustment
 * math is deterministic and that IS asserted. The YEAR is not implemented at
 * all — see the findings printed at the end. Those are reported as ⚠ FINDINGS
 * rather than failures because the fix is a schema + seed decision outside this
 * lane, and a proof that fails for a defect nobody in this lane can fix teaches
 * the next reader to ignore it.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { registerHooks } from "node:module"
import { spawnSync } from "node:child_process"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const CHILD = process.env.CPL_SIM_CHILD === "1"
const ASSERT_ONLY = CHILD || process.argv.includes("--assert-only")

const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")
/** Comment-stripped source. Load-bearing: these files quote their own defects. */
const code = (p: string) => stripComments(raw(p))

const F = {
  comps: "lib/cma/comp-provider.ts",
  orch: "lib/cma/ai-cma-orchestrator.ts",
  readers: "lib/property/rentcast.ts",
  rates: "lib/cma/state-adjustment-rates.ts",
  action: "app/actions/ai-cma.ts",
}

let pass = 0
const failures: string[] = []
const findings: string[] = []
function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
  return ok
}
function finding(name: string, detail: string): void {
  findings.push(`${name} — ${detail}`)
  console.log(`  ⚠ FINDING ${name}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE INTERCEPTION — so the REAL comp sourcing and the REAL orchestrator run
// ─────────────────────────────────────────────────────────────────────────────
const STUBS: Record<string, string> = {
  "@/lib/property/rentcast":
    "export const getRentcastAvmAndComps = (...a) => globalThis.__CPL.getRentcastAvmAndComps(...a)",
  "@/lib/property/rentcast-eligibility":
    "export const resolveRentcastEligibility = (...a) => globalThis.__CPL.resolveRentcastEligibility(...a)",
  "@/lib/vendor-governance/usage-logger":
    "export const logVendorUsage = (...a) => globalThis.__CPL.logVendorUsage(...a)",
  "@/lib/idxbroker-client":
    "export const IDXBrokerClient = { forBrokerage: (...a) => globalThis.__CPL.idxForBrokerage(...a) }",
  "./perplexity-comp-finder":
    "export const findCompsViaPerplexity = (...a) => globalThis.__CPL.findCompsViaPerplexity(...a);" +
    "export const PERPLEXITY_COMP_SEARCH_COST_USD = 0.01",
  "@/lib/ai/models":
    "export const generateTextRouted = (...a) => globalThis.__CPL.generateTextRouted(...a)",
  "@/lib/supabase/service":
    "export const createServiceClient = (...a) => globalThis.__CPL.createServiceClient(...a)",
}

registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true }
    const stub = STUBS[spec]
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// THE WORLD each scenario configures
// ─────────────────────────────────────────────────────────────────────────────
const isoDaysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)

/** A RentCast comparable as lib/property/rentcast-normalize hands it over. */
function rcComp(over: Record<string, any> = {}): any {
  return {
    address: `${Math.round(Math.random() * 9000)} Provider Way`,
    sale_price: 600_000,
    square_feet: 2000,
    bedrooms: 3,
    bathrooms: 2,
    lot_size_acres: 0.25,
    year_built: 2005,
    days_on_market: 20,
    price_per_sqft: 300,
    correlation: 0.9,
    distance_miles: 0.4,
    listed_date: null,
    last_seen_date: null,
    removed_date: null,
    ...over,
  }
}

/** A ScoredComp as the Perplexity finder hands it over. */
function aiComp(status: "closed" | "pending" | "active", price: number): any {
  return {
    address: `${Math.round(Math.random() * 9000)} Web Search Blvd`,
    status,
    salePrice: price,
    saleDate: isoDaysAgo(30),
    sqftLiving: 2000, bedrooms: 3, fullBaths: 2, halfBaths: 0,
    garageSpaces: null, hasPool: null, isWaterfront: null, hasView: null,
    lotSizeAcres: null, yearBuilt: 2005, conditionGrade: null,
    basementFinished: null, isNewConstruction: null, isGated: null,
    daysOnMarket: 10, pricePerSqft: null, similarityScore: 0.5,
    citation: "https://example.com/listing", distanceMiles: null,
    sourceProvider: "perplexity",
    priceBasis: status === "closed" ? "closed_sale" : "list_price",
  }
}

// `effective_year` is part of every row because the rate reader now RESOLVES A
// VINTAGE: it selects the column and bounds the read with `.lte("effective_year",
// year)` taken from the CMA's own date. A fixture row with no year is a row the
// production resolver correctly refuses to quote as any year's guidance. See
// scripts/appraiser-guidelines-simulator.ts, which owns that behaviour.
const RATE_ROWS = [
  { state: "US", adjustment_type: "sqft_living", rate_basis: "pct_of_comp_price", typical_rate_low: 0.0001, typical_rate_mid: 0.0002, typical_rate_high: 0.0004, unit: "per sqft", notes: null, source: "US default", effective_year: 2024 },
  { state: "US", adjustment_type: "bedroom", rate_basis: "pct_of_comp_price", typical_rate_low: 0.01, typical_rate_mid: 0.02, typical_rate_high: 0.03, unit: "per bed", notes: null, source: "US default", effective_year: 2024 },
  { state: "US", adjustment_type: "time_market_trend", rate_basis: "pct_of_comp_price", typical_rate_low: 0.001, typical_rate_mid: 0.003, typical_rate_high: 0.006, unit: "per month", notes: null, source: "US default", effective_year: 2024 },
]

interface World {
  eligibility: any
  rentcast: { comps: any[]; avm: { value: number | null; rangeLow: number | null; rangeHigh: number | null }; avmAvailable: boolean; avmUnavailableReason: string | null }
  idxConfigured: boolean
  idxRows: any[]
  ai: any
  /** Spies. */
  rentcastCalls: any[]
  aiCalls: any[]
  ledger: any[]
}

let W: World

function eligible(): any {
  return {
    eligible: true, reason: "eligible",
    idx: { status: "not_connected" }, platformKeyPresent: true,
    budget: { checked: true, degraded: false },
    detail: "RentCast is eligible for this tenant.",
  }
}
function tenantHasIdx(): any {
  return {
    eligible: false, reason: "tenant_has_idx", idxOwnerType: "brokerage",
    idx: { status: "connected", ownerType: "brokerage" }, platformKeyPresent: true,
    budget: { checked: false, degraded: false },
    detail: "RentCast was not called: this tenant has connected their own IDX Broker credentials at brokerage scope.",
  }
}

function newWorld(over: Partial<World> = {}): World {
  return {
    eligibility: eligible(),
    rentcast: { comps: [], avm: { value: null, rangeLow: null, rangeHigh: null }, avmAvailable: false, avmUnavailableReason: "no_estimate" },
    idxConfigured: false,
    idxRows: [],
    ai: null,
    rentcastCalls: [], aiCalls: [], ledger: [],
    ...over,
  }
}

;(globalThis as any).__CPL = {
  resolveRentcastEligibility: async () => W.eligibility,
  getRentcastAvmAndComps: async (args: any) => {
    W.rentcastCalls.push(args)
    return { ...W.rentcast, eligibility: W.eligibility }
  },
  logVendorUsage: async (row: any) => { W.ledger.push(row); return null },
  idxForBrokerage: async () => ({
    isConfigured: () => W.idxConfigured,
    searchActiveListings: async () => W.idxRows,
  }),
  findCompsViaPerplexity: async (input: any) => {
    W.aiCalls.push(input)
    return W.ai ?? {
      closedComps: [], pendingComps: [], activeComps: [], citations: [],
      searchQuery: "", rawAnalysis: "", arvMode: false, droppedUnusableRows: 0,
    }
  },
  generateTextRouted: async () => ({ text: "NARRATIVE" }),
  createServiceClient: () => {
    // The rate read is `.select(…).in("state", […]).lte("effective_year", year)`;
    // the terminal call is the one that resolves.
    const q: any = {
      select: () => q,
      in: () => q,
      lte: async (_col: string, year: number) => ({
        data: RATE_ROWS.filter((r) => r.effective_year <= year),
        error: null,
      }),
    }
    return { from: () => q }
  },
}

const SUBJECT = {
  address: "1 Subject St", city: "Tampa", state: "FL", zip: "33601",
  propertyType: "single_family" as const,
  sqftLiving: 2000, bedrooms: 3, fullBaths: 2, halfBaths: 0, yearBuilt: 2005,
}

// ─────────────────────────────────────────────────────────────────────────────
// BEHAVIOUR LAYER
// ─────────────────────────────────────────────────────────────────────────────
async function behaviourLayer(): Promise<void> {
  const { sourceCompsForCma, PROVIDER_AVM_BASELINE_LABEL } = await import("../lib/cma/comp-provider")
  const { runAiCma } = await import("../lib/cma/ai-cma-orchestrator")

  const source = (over: any = {}) =>
    sourceCompsForCma({
      brokerageId: "b1", agentUserId: "u1", teamId: null,
      address: SUBJECT.address, city: SUBJECT.city, state: SUBJECT.state, zip: SUBJECT.zip,
      subject: SUBJECT, propertyType: SUBJECT.propertyType,
      systemSource: "ai_cma", contactId: "contact-42", ...over,
    })

  // ── P1 · PRECEDENCE — the tenant's own IDX beats the platform's RentCast ──
  console.log("\n[P1 · sourcing precedence — tenant IDX beats platform RentCast]")
  W = newWorld({
    eligibility: tenantHasIdx(),
    idxConfigured: true,
    idxRows: [
      { address: "10 IDX Ln", city: "Tampa", state: "FL", price: 610_000, bedrooms: 3, bathrooms: 2, squareFeet: 2000, yearBuilt: 2006, daysOnMarket: 5, status: "Active", mlsNumber: "M1" },
      { address: "12 IDX Ln", city: "Tampa", state: "FL", price: 625_000, bedrooms: 3, bathrooms: 2, squareFeet: 2050, yearBuilt: 2004, daysOnMarket: 9, status: "Active", mlsNumber: "M2" },
      { address: "14 IDX Ln", city: "Tampa", state: "FL", price: 640_000, bedrooms: 3, bathrooms: 2, squareFeet: 2100, yearBuilt: 2007, daysOnMarket: 2, status: "Pending", mlsNumber: "M3" },
    ],
  })
  let r = await source()
  check("P1a a tenant with their OWN IDX feed never has the RentCast pull issued at all",
    W.rentcastCalls.length === 0, `rentcast called ${W.rentcastCalls.length}×`)
  check("P1b the provenance names the DELIBERATE suppression, not a provider failure",
    r.provenance.rentcastEligibility === "tenant_has_idx" && r.provenance.tenantOwnsIdx === true
      && r.provenance.rentcastConfigured === false,
    JSON.stringify({ reason: r.provenance.rentcastEligibility, owns: r.provenance.tenantOwnsIdx }))
  check("P1c the active side is served by the tenant's IDX feed",
    r.provenance.activeProvider === "idxbroker" && r.activeComps.length === 2)
  check("P1d the closed side has NO provider — and the report says the 3-sale minimum cannot be met",
    r.closedComps.length === 0 && r.provenance.soldProvider === "none"
      && r.provenance.meetsRequiredMix === false
      && r.provenance.notes.some((n) => /DOES NOT MEET THE REQUIRED MIX/.test(n)))
  check("P1e no spend was booked against a provider that was never called",
    r.provenance.estimatedCostCents === 0, `cents=${r.provenance.estimatedCostCents}`)

  // ── P1f · precedence the other way — no tenant IDX → RentCast serves ──────
  W = newWorld({
    rentcast: {
      comps: [rcComp({ removed_date: isoDaysAgo(40) }), rcComp({ removed_date: isoDaysAgo(70) }), rcComp({ removed_date: isoDaysAgo(100) }),
              rcComp({ last_seen_date: isoDaysAgo(2), sale_price: 615_000 })],
      avm: { value: 612_000, rangeLow: 585_000, rangeHigh: 640_000 }, avmAvailable: true, avmUnavailableReason: null,
    },
  })
  r = await source()
  check("P1f with no tenant IDX, RentCast serves the closed side and the pull IS issued",
    W.rentcastCalls.length === 1 && r.provenance.soldProvider === "rentcast" && r.closedComps.length === 3)
  check("P1g the CMA lane is what the vendor ledger records — not the client's default lane",
    W.rentcastCalls[0]?.systemSource === "ai_cma", `systemSource=${W.rentcastCalls[0]?.systemSource}`)
  check("P1h the contact the CMA is for reaches the ledger, so a charge is traceable past the tenant",
    W.rentcastCalls[0]?.contactId === "contact-42", `contactId=${W.rentcastCalls[0]?.contactId}`)

  // ── P3/P4 · THE AVM BASELINE, when it is available ────────────────────────
  console.log("\n[P3 · the AVM is a labelled baseline, never the recommendation]")
  const avail = r.provenance.avmBaseline
  check("P3a the baseline is carried with its provider and its fixed non-conclusion label",
    avail.available === true && avail.value === 612_000 && avail.provider === "rentcast"
      && avail.kind === "provider_automated_estimate" && avail.label === PROVIDER_AVM_BASELINE_LABEL,
    JSON.stringify(avail))
  check("P3b the label itself says out loud that it is NOT the value conclusion or the list price",
    /not this analysis's value conclusion/i.test(avail.label) && /recommended list price/i.test(avail.label))
  check("P3c the provenance notes state the baseline's status in the report's own words",
    r.provenance.notes.some((n) => /BASELINE FOR COMPARISON ONLY/.test(n)))
  // The strongest available form of "the AVM is free": run the SAME world twice,
  // once with the baseline published and once without, and require the call
  // count and the booked spend to be identical. A second lookup — the obvious
  // way to implement this feature — would show up here as an extra call and an
  // extra 15 cents.
  const withAvmCalls = W.rentcastCalls.length
  const withAvmCents = r.provenance.estimatedCostCents
  const savedRentcast = W.rentcast
  W.rentcastCalls = []
  W.rentcast = { ...savedRentcast, avm: { value: null, rangeLow: null, rangeHigh: null }, avmAvailable: false, avmUnavailableReason: "no_estimate" }
  const noBaseline = await source()
  check("P3d reading the AVM costs NO second provider call and NO second charge",
    withAvmCalls === 1 && W.rentcastCalls.length === 1
      && withAvmCents === noBaseline.provenance.estimatedCostCents,
    `withAvm={calls:${withAvmCalls},cents:${withAvmCents}} without={calls:${W.rentcastCalls.length},cents:${noBaseline.provenance.estimatedCostCents}}`)
  W.rentcast = savedRentcast
  W.rentcastCalls = []

  const cma = await runAiCma({ mode: "standard", brokerageId: "b1", agentUserId: "u1", subject: SUBJECT })
  check("P3e runAiCma surfaces the baseline on its OWN field, separate from the range",
    cma.providerAvmBaseline.value === 612_000 && cma.providerAvmBaseline.available === true)
  check("P3f the value conclusion is derived from the COMPS and is not the AVM",
    cma.estimatedValueMid > 0 && cma.estimatedValueMid !== 612_000
      && cma.estimatedValueLow !== 612_000 && cma.estimatedValueHigh !== 612_000,
    `mid=${cma.estimatedValueMid}`)
  check("P3g the seller-facing disclaimers carry the baseline AND its non-conclusion status",
    cma.disclaimers.some((d) => /BASELINE FOR COMPARISON ONLY/.test(d) && /recommended list price/i.test(d)))

  // ── P3h · an available AVM does NOT rescue an empty closed set ────────────
  W = newWorld({
    rentcast: {
      comps: [], // provider served no comparable at all
      avm: { value: 750_000, rangeLow: 700_000, rangeHigh: 800_000 }, avmAvailable: true, avmUnavailableReason: null,
    },
  })
  const noComps = await runAiCma({ mode: "standard", brokerageId: "b1", subject: SUBJECT })
  check("P3h a CMA with NO closed comparable still produces NO range, even with an AVM in hand",
    noComps.estimatedValueMid === 0 && noComps.estimatedValueLow === 0 && noComps.estimatedValueHigh === 0
      && noComps.providerAvmBaseline.value === 750_000,
    `mid=${noComps.estimatedValueMid}`)
  check("P3i …and the caller's refusal condition (adjustedComps===0 || mid<=0) still fires",
    noComps.adjustedComps.length === 0)

  // ── P4 · a missing baseline reads as missing, never as zero ───────────────
  console.log("\n[P4 · a refused or absent baseline reads as absent — never 0, never silent]")
  W = newWorld({ eligibility: tenantHasIdx(), idxConfigured: true, idxRows: [] })
  r = await source()
  let b = r.provenance.avmBaseline
  check("P4a suppressed provider → available:false, value NULL (not 0), reason present",
    b.available === false && b.value === null && b.rangeLow === null && b.rangeHigh === null
      && typeof b.unavailableNote === "string" && b.unavailableNote.length > 0,
    JSON.stringify(b))
  check("P4b the reason names the DELIBERATE suppression rather than a provider outage",
    /IDX Broker credentials/i.test(b.unavailableNote ?? ""))
  check("P4c the absence is stated in the notes rather than silently omitted",
    r.provenance.notes.some((n) => /No provider AVM baseline is available/.test(n)))

  W = newWorld({
    rentcast: {
      comps: [rcComp({ removed_date: isoDaysAgo(30) }), rcComp({ removed_date: isoDaysAgo(60) }), rcComp({ removed_date: isoDaysAgo(90) })],
      avm: { value: null, rangeLow: null, rangeHigh: null }, avmAvailable: false, avmUnavailableReason: "no_estimate",
    },
  })
  const noAvm = await runAiCma({ mode: "standard", brokerageId: "b1", subject: SUBJECT })
  b = noAvm.providerAvmBaseline
  check("P4d provider answered with no estimate → still available:false / value NULL",
    b.available === false && b.value === null && /published no automated valuation/i.test(b.unavailableNote ?? ""))
  check("P4e the range is unaffected by the missing baseline",
    noAvm.estimatedValueMid > 0 && noAvm.adjustedComps.length === 3)
  check("P4f the disclaimers SAY there is no baseline instead of omitting the line",
    noAvm.disclaimers.some((d) => /No provider automated valuation \(AVM\) baseline is shown/.test(d)))

  W = newWorld({
    rentcast: {
      comps: [rcComp({ removed_date: isoDaysAgo(30) })],
      avm: { value: null, rangeLow: null, rangeHigh: null }, avmAvailable: false, avmUnavailableReason: "provider_error",
    },
  })
  r = await source()
  check("P4g a FAILED lookup is not reported as 'the property has no value'",
    r.provenance.avmBaseline.available === false
      && /lookup failure, not a statement/i.test(r.provenance.avmBaseline.unavailableNote ?? ""))

  // ── P2 · PERPLEXITY NEVER REACHES THE CLOSED SET ──────────────────────────
  console.log("\n[P2 · the AI gap-fill cannot reach the closed set — asserted against a finder that TRIES]")
  W = newWorld({
    rentcast: {
      comps: [rcComp({ removed_date: isoDaysAgo(30) })], // one closed, nothing live
      avm: { value: 600_000, rangeLow: null, rangeHigh: null }, avmAvailable: true, avmUnavailableReason: null,
    },
    // The finder RETURNS closed comps regardless of what it was asked for. This
    // is the adversarial case: the guard must be the caller's, not the finder's.
    ai: {
      closedComps: [aiComp("closed", 999_000), aiComp("closed", 998_000)],
      pendingComps: [aiComp("pending", 650_000)],
      activeComps: [aiComp("active", 640_000), aiComp("active", 645_000)],
      citations: ["https://example.com/a"],
      searchQuery: "", rawAnalysis: "", arvMode: false, droppedUnusableRows: 0,
    },
  })
  r = await source()
  check("P2a the gap-fill was actually attempted (otherwise the rest proves nothing)",
    r.provenance.aiGapFillAttempted === true && W.aiCalls.length === 1)
  check("P2b the finder was asked for ZERO closed comps",
    W.aiCalls[0]?.want?.closed === 0, JSON.stringify(W.aiCalls[0]?.want))
  check("P2c not one AI-sourced row reached the CLOSED set, though the finder offered two",
    r.closedComps.every((c) => c.sourceProvider !== "perplexity") && r.closedComps.length === 1)
  check("P2d 'sold' never appears on aiGapFilledSlots",
    !r.provenance.aiGapFilledSlots.includes("sold" as any)
      && r.provenance.aiGapFilledSlots.includes("active")
      && r.provenance.aiGapFilledSlots.includes("pending"))
  check("P2e the pending/active sides WERE filled — the gap-fill is live, not disabled",
    r.pendingComps.length === 1 && r.activeComps.length === 2
      && r.pendingComps[0].sourceProvider === "perplexity")
  check("P2f the closed-side refusal is stated as a REFUSAL, not left as an absence",
    r.provenance.notes.some((n) => /was NOT gap-filled by AI web search — deliberately/.test(n)))

  const gapCma = await runAiCma({ mode: "standard", brokerageId: "b1", subject: SUBJECT })
  check("P2g the range still rests only on the provider-verified closed sale",
    gapCma.adjustedComps.length === 1
      && gapCma.adjustedComps.every((a) => a.comp.sourceProvider === "rentcast"))
  check("P2h the disclaimers lead with the unverified rows rather than burying them",
    gapCma.disclaimers.slice(0, 3).some((d) => /NOT ALL COMPARABLES CAME FROM A DATA PROVIDER/.test(d)))

  // ── The adjustment stage is deterministic (owner: state appraiser rates) ──
  console.log("\n[E · the state appraiser rates are applied deterministically]")
  W = newWorld({
    rentcast: {
      comps: [rcComp({ removed_date: isoDaysAgo(30), sale_price: 600_000, square_feet: 1800 }),
              rcComp({ removed_date: isoDaysAgo(45), sale_price: 610_000, square_feet: 1900 }),
              rcComp({ removed_date: isoDaysAgo(60), sale_price: 620_000, square_feet: 2100 })],
      avm: { value: 601_000, rangeLow: null, rangeHigh: null }, avmAvailable: true, avmUnavailableReason: null,
    },
  })
  const a1 = await runAiCma({ mode: "standard", brokerageId: "b1", subject: SUBJECT })
  W.rentcastCalls = []
  const a2 = await runAiCma({ mode: "standard", brokerageId: "b1", subject: SUBJECT })
  check("E1 the same comps + the same rates produce the SAME adjusted prices (no model in the math)",
    JSON.stringify(a1.adjustedComps.map((a) => a.adjustedPrice)) ===
    JSON.stringify(a2.adjustedComps.map((a) => a.adjustedPrice))
      && a1.estimatedValueMid === a2.estimatedValueMid)
  check("E2 every adjustment line carries the rate it used and the basis it used it on",
    a1.adjustedComps.every((a) => a.adjustments.every((adj: any) =>
      typeof adj.rateUsed === "number" && typeof adj.rateBasis === "string" && typeof adj.amount === "number")))
  check("E3 the narrative model is told the figures are computed, not its to revise",
    /applied DETERMINISTICALLY/.test(raw(F.orch)))
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCT LAYER — the facts a behaviour test cannot see
// ─────────────────────────────────────────────────────────────────────────────
function constructLayer(): void {
  console.log("\n[construct · what the persistence lane is allowed to write]")
  const action = code(F.action)

  // The cma_reports insert payload, isolated so a mention elsewhere in the file
  // cannot pass for a binding.
  const insAt = action.indexOf('.from("cma_reports")')
  const payload = insAt === -1 ? "" : action.slice(insAt, insAt + 2500)
  const recLine = /recommended_price:\s*([^\n,]+)/.exec(payload)?.[1]?.trim() ?? ""
  check("C1 cma_reports.recommended_price is written from the comp-bounded pricing strategy",
    /pricingStrategy\./.test(recLine), `recommended_price: ${recLine || "(not found)"}`)
  check("C2 …and NOTHING in that insert payload binds a column to the AVM baseline",
    payload.length > 0 && !/avm/i.test(payload))
  check("C3 the price range columns are the comp-derived ones",
    /price_range_low:\s*pricingStrategy\./.test(payload) && /price_range_high:\s*pricingStrategy\./.test(payload))

  const orch = code(F.orch)
  // The range computation region: from the closed-comp adjustment through the
  // confidence score. The baseline must not be readable anywhere inside it.
  const from = orch.indexOf("const adjustedPrices")
  const to = orch.indexOf("const confidenceScore")
  const mathRegion = from !== -1 && to > from ? orch.slice(from, to + 400) : ""
  check("C4 the value range + confidence math never reads the AVM baseline",
    mathRegion.length > 0 && !/avmBaseline|providerAvmBaseline/.test(mathRegion))
  check("C5 estimatedValueLow/Mid/High are bound to the comp-derived low/mid/high",
    /estimatedValueLow:\s*Math\.round\(low\)/.test(orch) &&
    /estimatedValueMid:\s*Math\.round\(mid\)/.test(orch) &&
    /estimatedValueHigh:\s*Math\.round\(high\)/.test(orch))

  const comps = code(F.comps)
  check("C6 AI_GAP_FILL_SLOTS admits active + pending and excludes sold, as data",
    /AI_GAP_FILL_SLOTS[^=]*=\s*\[\s*"active"\s*,\s*"pending"\s*\]/.test(comps))
  check("C7 the gap-fill request hard-codes closed:0 rather than relying on the finder's default",
    /want:\s*PerplexityCompSlotRequest\s*=\s*\{\s*closed:\s*0\s*,/.test(comps))

  const readers = code(F.readers)
  // ONE pull site for the comps+AVM call: two would be two prices for one question.
  const compsLookups = (readers.match(/usageType:\s*"comps_lookup"/g) ?? []).length
  const avmComps = (readers.match(/endpoint:\s*"\/avm\/value\(comps\)"/g) ?? []).length
  check("C8 there is exactly ONE comps pull site, so the AVM cannot be billed twice",
    compsLookups === 1 && avmComps === 1, `comps_lookup=${compsLookups} endpoints=${avmComps}`)
  check("C9 getRentcastComps is a thin reader over the combined pull, not a second implementation",
    /export async function getRentcastComps[\s\S]{0,400}?getRentcastAvmAndComps\(params\)\)\.comps/.test(readers))
  check("C10 a parsed AVM figure is never allowed to be 0 — non-positive resolves to null",
    /function parseAvmValue[\s\S]{0,400}?v\s*>\s*0\s*\?\s*v\s*:\s*null/.test(readers))
}

// ─────────────────────────────────────────────────────────────────────────────
// FINDINGS — reported, deliberately not failed. See the header.
// ─────────────────────────────────────────────────────────────────────────────
function findingsLayer(): void {
  console.log("\n[findings · reported, not failed — the fix is outside this lane]")
  const rates = code(F.rates)
  const reader = rates.slice(rates.indexOf("export async function getStateAdjustmentRates"))

  if (!/effective_year/.test(reader)) {
    finding(
      "the 'current year' in 'current years state appraiser guidelines' is not resolved anywhere",
      "lib/cma/state-adjustment-rates.ts getStateAdjustmentRates selects and filters on `state` only. " +
      "`state_appraiser_adjustment_rates.effective_year` exists on the live table, every live row is 2024, " +
      "and the column is never read — so the rates in use are two years stale and nothing on the report says which vintage they are. " +
      "The table's UNIQUE (state, adjustment_type, rate_basis) also makes it impossible to seed a 2026 row alongside the 2024 one, " +
      "so the owner's requirement is currently unimplementable without a schema change.",
    )
  }
  if (/rateOverride\?:\s*number/.test(rates) && !/apply\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*\)/.test(rates)) {
    finding(
      "computeCompAdjustments accepts a rateOverride that no call site ever passes",
      "lib/cma/state-adjustment-rates.ts — `apply()` takes a 5th `rateOverride` parameter and every one of the " +
      "fourteen call sites passes four arguments, so `rate.mid` is always used. The typical_rate_low / _high columns " +
      "are loaded, formatted into the prompt, and never reach the math.",
    )
  }
  if (/Apply each within the low-high range based on comp similarity/.test(raw(F.rates))) {
    finding(
      "the prompt instructs the model to select a rate the model is not allowed to select",
      "lib/cma/state-adjustment-rates.ts formatRatesForPrompt tells the model 'Apply each within the low-high range " +
      "based on comp similarity', but the adjustments are already computed deterministically at rate.mid before the " +
      "model sees anything. A documented behaviour with no code behind it.",
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS — defect written in, the whole behaviour layer re-run in a
// CHILD process (fresh module graph), child required to exit non-zero.
// ─────────────────────────────────────────────────────────────────────────────
interface Control { file: string; find: string; replace: string }

function controlled(label: string, c: Control): void {
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)
  if (after === before) {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — PATCH DID NOT APPLY; proves nothing`)
    failures.push(`negative control did not apply: ${label}`)
    return
  }
  writeFileSync(join(ROOT, c.file), after)
  let wentRed = false
  try {
    const run = spawnSync("npx", ["tsx", "scripts/cma-provider-lane-simulator.ts", "--assert-only"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, CPL_SIM_CHILD: "1" },
    })
    wentRed = run.status !== 0
  } finally {
    writeFileSync(join(ROOT, c.file), before)
    if (sha(c.file) !== beforeSha) {
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      failures.push(`FAILED TO RESTORE ${c.file}`)
      return
    }
  }
  console.log(wentRed
    ? `  ✓ NEGATIVE CONTROL ${label} — went RED as required`
    : `  ✗ NEGATIVE CONTROL ${label} — STAYED GREEN with the defect present`)
  if (!wentRed) failures.push(`negative control stayed green: ${label}`)
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!CHILD) console.log("CMA PROVIDER LANE — precedence, the closed set, and the AVM baseline\n")

  await behaviourLayer()
  constructLayer()
  if (!CHILD) findingsLayer()

  if (!ASSERT_ONLY) {
    console.log("\nNEGATIVE CONTROLS")

    // 1. The headline: an AI web search admitted to the closed set.
    controlled("the AI gap-fill allowed to fill the CLOSED slot", {
      file: F.comps,
      find: `export const AI_GAP_FILL_SLOTS: readonly CompSlot[] = ["active", "pending"] as const`,
      replace: `export const AI_GAP_FILL_SLOTS: readonly CompSlot[] = ["active", "pending", "sold"] as const`,
    })

    // 2. The finder asked for closed comps — the request side of the same defect.
    controlled("the gap-fill request asking for closed comps", {
      file: F.comps,
      find: `const want: PerplexityCompSlotRequest = { closed: 0, active: wantActive, pending: wantPending }`,
      replace: `const want: PerplexityCompSlotRequest = { closed: 3, active: wantActive, pending: wantPending }`,
    })

    // 3. The AVM becomes the value conclusion — the failure this feature invites.
    controlled("the AVM baseline promoted into the value conclusion", {
      file: F.orch,
      find: `    estimatedValueMid: Math.round(mid),`,
      replace: `    estimatedValueMid: Math.round(sourced.provenance.avmBaseline.value ?? mid),`,
    })

    // 4. A missing baseline rendered as 0 instead of as missing.
    controlled("a missing AVM baseline defaulting to 0 instead of null", {
      file: F.comps,
      find: `    available: false,
    value: null,`,
      replace: `    available: false,
    value: 0 as any,`,
    })

    // 5. The eligibility gate bypassed — RentCast spent on a tenant who owns IDX.
    controlled("the RentCast pull issued without asking the eligibility gate", {
      file: F.comps,
      find: `  if (rentcastEligibility.eligible) {
    avmPull = await getRentcastAvmAndComps({`,
      replace: `  if (true) {
    avmPull = await getRentcastAvmAndComps({`,
    })

    // 6. The CMA's spend filed under a lane that did not spend.
    controlled("the CMA comp pull losing its vendor-ledger lane", {
      file: F.comps,
      find: `      systemSource: req.systemSource ?? DEFAULT_COMP_SYSTEM_SOURCE,
      contactId: req.contactId ?? null,`,
      replace: `      contactId: req.contactId ?? null,`,
    })

    // 7. The contact attribution dropped — an accepted parameter with no reader,
    //    which is the defect class this wave was sent to find.
    controlled("the CMA's contact attribution dropped before the ledger", {
      file: F.comps,
      find: `      contactId: req.contactId ?? null,
    })`,
      replace: `    })`,
    })

    // 8. The baseline's label stripped — a bare number on a seller's screen.
    controlled("the baseline label emptied so nothing marks it as a non-conclusion", {
      file: F.comps,
      find: `export const PROVIDER_AVM_BASELINE_LABEL =`,
      replace: `export const PROVIDER_AVM_BASELINE_LABEL: string = ""; const _UNUSED_LABEL =`,
    })
  }

  if (findings.length && !CHILD) {
    console.log(`\nFINDINGS (${findings.length}) — reported, not failed:`)
    for (const f of findings) console.log(`  ⚠ ${f}`)
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length} of ${pass + failures.length} assertions)`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log(
    `PASSED (${pass} assertions) — a tenant's own IDX feed outranks the platform's RentCast, ` +
    `no AI web search reaches the closed set the range is computed from, and the provider's AVM ` +
    `is a labelled baseline that never becomes the recommendation and never reads as zero when it is absent`,
  )
}

main().catch((e) => { console.error(e); process.exit(1) })
