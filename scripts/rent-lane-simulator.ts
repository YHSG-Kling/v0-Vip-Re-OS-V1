#!/usr/bin/env tsx
/**
 * scripts/rent-lane-simulator.ts   (tsx scripts/rent-lane-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RENT LANE — WHERE A MONTHLY RENT COMES FROM, AND WHAT IS ALLOWED TO STAND
 * IN FOR ONE WHEN NOTHING DOES.
 *
 * Three surfaces showed a renter or an investor a monthly rent. None of them had
 * asked a data provider, and the one function that could have — RentCast's
 * long-term rental search — had ZERO consumers anywhere in the tree.
 *
 *   R1  NO MODEL AUTHORS A RENT. lib/property/property-evaluation.ts asked an
 *       LLM for `estimatedMonthlyRent` and a `rentComps[]` array — street
 *       addresses AND dollar rents — and rendered them on an agent-branded
 *       public page under "Investor Metrics". Same defect class the CMA lane had
 *       just removed. The proof feeds the model a response that still CONTAINS a
 *       rent and three rental comps, and requires that none of them survive.
 *
 *   R2  NO ARITHMETIC AUTHORS A RENT EITHER. app/actions/smart-insights.ts
 *       computed `price * 0.0085`, with `price` itself defaulting to `500000`
 *       when the record had none — so a property with no price displayed a
 *       confident "$4,250/mo" derived from nothing, and cap rate, cash-on-cash
 *       and five-year cash flow were all computed from it. That expression must
 *       appear NOWHERE in the tree, and the price default must be gone with it.
 *
 *   R3  A RENT SEARCH REACHES THE RENTAL ENDPOINT. lib/property/
 *       external-listings-search.ts routed every query — buy or rent — into
 *       `searchRentcastSaleListings`. The proof runs the REAL router and the
 *       REAL RentCast client and asserts the HTTP path is
 *       `/listings/rental/long-term`, never `/listings/sale`.
 *
 *   R4  PRECEDENCE AND METERING, per the rules the CMA lane established. A
 *       tenant who connected their own IDX Broker feed never has the platform's
 *       RentCast pull issued — decided BEFORE anything is spent. Every provider
 *       call lands on the vendor ledger with a TRUTHFUL `systemSource`, never
 *       the hard-coded `buyer_search` that had been filed for six unrelated
 *       lanes.
 *
 *   R5  MISSING READS AS MISSING. Suppressed, unreachable, no locality, no
 *       listings, too few listings → `available: false`, `monthlyRent: null`, a
 *       plain sentence. Never 0, never a substituted figure, never a silently
 *       omitted line — and every rent-DERIVED figure (cap rate, cash-on-cash,
 *       cash flow) goes null with it rather than standing on a removed guess.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 * TWO LAYERS, and the first one is the one that matters.
 *
 *   BEHAVIOUR — the REAL `estimateMonthlyRentFromComps`, the REAL
 *   `searchRentcastRentalListings`, the REAL `searchExternalListings`, the REAL
 *   `evaluatePropertyValue` and the REAL `generateSmartInsights` are executed.
 *   Only the lane's EDGES are stubbed (the HTTP connector gateway, the vendor
 *   ledger, the eligibility gate, the IDX client, the Supabase clients, the two
 *   model callers), so what is asserted is what the production functions
 *   actually do — not what their source text looks like. The stubs dispatch via
 *   globalThis, which is what lets one cached module graph be re-aimed per
 *   scenario.
 *
 *   CONSTRUCT — the small number of facts a behaviour test cannot see: that
 *   `price * 0.0085` exists nowhere in the tree, that the evaluation PROMPT no
 *   longer asks for a rent, and that the renderers name the source.
 *
 * ── COMMENT BLANKING ────────────────────────────────────────────────────────
 * Every construct scan runs over `blankComments()` from scripts/strip-comments.
 * Load-bearing: the fixes in this lane QUOTE the defects they removed —
 * `price * 0.0085` and `|| 500000` both appear verbatim in explanatory comments
 * in the files that no longer do them — so a raw-source scan would accuse the
 * fix of being the bug. `blankComments` (not `stripComments`) is used where a
 * character offset matters; both preserve line numbers.
 *
 * ── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
 * A check that cannot fail proves nothing. Each control writes the REAL defect
 * back into the REAL file and re-runs the whole proof IN A CHILD PROCESS — a
 * fresh module graph, because these are runtime assertions and a patched file
 * cannot be re-imported into a cached one. The patch is verified to have applied
 * (a find-string that silently stops matching is theatre), the child is required
 * to EXIT NON-ZERO, and the file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { registerHooks } from "node:module"
import { spawnSync } from "node:child_process"
import { blankComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
const CHILD = process.env.RENT_SIM_CHILD === "1"
const ASSERT_ONLY = CHILD || process.argv.includes("--assert-only")

const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")
/** Comment-BLANKED source. See the header — the fixes quote the defects. */
const code = (p: string) => blankComments(raw(p))
/**
 * Comment-blanked AND string-masked — the form the TREE-WIDE scan for the
 * fabricated expression runs over.
 *
 * Both maskings are load-bearing and for the same reason: this lane's fix quotes
 * the defect it removed. `price * 0.0085` appears in an explanatory COMMENT in
 * app/actions/smart-insights.ts (which no longer does it) and in a negative-
 * control STRING in this very file (whose job is to write it back and prove the
 * proof goes red). A scan over raw source would accuse both — the fix and its
 * own proof — which is exactly the false-accusation failure scripts/
 * strip-comments.ts exists to stop. The defect being hunted was live CODE, so
 * masking comments and string CONTENTS costs the scan nothing.
 */
const scannable = (p: string) => blankStrings(raw(p))

const F = {
  rent: "lib/property/rent-estimate.ts",
  readers: "lib/property/rentcast.ts",
  router: "lib/property/external-listings-search.ts",
  evaluation: "lib/property/property-evaluation.ts",
  insights: "app/actions/smart-insights.ts",
  action: "app/actions/property-evaluation.ts",
  portalUi: "app/portal/[contactId]/properties/[propertyId]/PropertyDetailIntelligenceClient.tsx",
  homeValueUi: "app/home-value/[agentSlug]/home-value-client.tsx",
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
// MODULE INTERCEPTION — so the REAL rent lane runs against controllable edges
// ─────────────────────────────────────────────────────────────────────────────
const STUBS: Record<string, string> = {
  // The HTTP edge. Everything above it — the gate, the query builder, the range
  // syntax, the row mapper, the median — is the real code.
  "@/lib/agentic-os/connector-gateway":
    "export const callConnector = (...a) => globalThis.__RENT.callConnector(...a)",
  "@/lib/vendor-governance/usage-logger":
    "export const logVendorUsage = (...a) => globalThis.__RENT.logVendorUsage(...a)",
  // Both `lib/property/rentcast.ts` and `lib/property/rent-estimate.ts` import
  // the gate by this relative specifier, so one stub aims both.
  "./rentcast-eligibility":
    "export const resolveRentcastEligibility = (...a) => globalThis.__RENT.resolveRentcastEligibility(...a);" +
    "export const rentcastBudgetBlocked = async () => ({ blocked: false, degraded: false });" +
    "export const RENTCAST_ELIGIBILITY_REASONS = []",
  "@/lib/idxbroker-client":
    "export const IDXBrokerClient = { forBrokerage: (...a) => globalThis.__RENT.idxForBrokerage(...a) };" +
    "export const NormalizedIdxListing = undefined",
  "@/lib/supabase/service":
    "export const createServiceClient = (...a) => globalThis.__RENT.createServiceClient(...a)",
  "@/lib/supabase/server":
    "export const createClient = (...a) => globalThis.__RENT.createServerClient(...a)",
  "@/lib/ai/models":
    "export const generateTextRouted = (...a) => globalThis.__RENT.generateTextRouted(...a)",
  "@/lib/ai/gateway-chat":
    "export const gatewayChatJSON = (...a) => globalThis.__RENT.gatewayChatJSON(...a)",
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
interface HttpCall { path: string; query: Record<string, string> }
interface LedgerRow { vendorName: string; usageType: string; systemSource: string; metadata: any; brokerageId: string }

interface World {
  eligibility: any
  /** Rows the connector gateway answers with, keyed by path fragment. */
  rentalRows: any[]
  saleRows: any[]
  httpOk: boolean
  httpStatus: number
  idxConfigured: boolean
  idxRows: any[]
  /** What the evaluation model returns — deliberately still carrying a rent. */
  modelJson: any
  /** Spies. */
  http: HttpCall[]
  ledger: LedgerRow[]
  upserts: any[]
  contactBrokerageId: string | null
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
function noPlatformKey(): any {
  return {
    eligible: false, reason: "no_platform_key",
    idx: { status: "not_connected" }, platformKeyPresent: false,
    budget: { checked: false, degraded: false },
    detail: "RentCast was not called: the platform RentCast key is not configured.",
  }
}

/** A RentCast rental row as the API publishes it. `price` IS the monthly rent. */
function rentalRow(rent: number, over: Record<string, any> = {}): any {
  return {
    id: `rc_${rent}_${Math.round(Math.random() * 1e6)}`,
    formattedAddress: `${Math.round(Math.random() * 9000)} Lease Lane, Austin, TX`,
    city: "Austin", state: "TX", zipCode: "78704",
    price: rent, bedrooms: 3, bathrooms: 2, squareFootage: 1600,
    yearBuilt: 2004, propertyType: "Single Family", daysOnMarket: 14,
    status: "Active", photos: [], mlsNumber: null, mlsName: null,
    ...over,
  }
}

function resetWorld(over: Partial<World> = {}): void {
  W = {
    eligibility: eligible(),
    rentalRows: [rentalRow(2200), rentalRow(2400), rentalRow(2600), rentalRow(3000)],
    saleRows: [],
    httpOk: true,
    httpStatus: 200,
    idxConfigured: false,
    idxRows: [],
    modelJson: null,
    http: [],
    ledger: [],
    upserts: [],
    contactBrokerageId: "brok-1",
    ...over,
  }
}

// The dispatcher every stub calls into.
;(globalThis as any).__RENT = {
  callConnector: async (req: any) => {
    W.http.push({ path: req.path, query: { ...(req.query ?? {}) } })
    const rows = req.path.includes("/listings/rental") ? W.rentalRows : W.saleRows
    return { ok: W.httpOk, status: W.httpStatus, data: W.httpOk ? rows : null }
  },
  logVendorUsage: async (e: any) => { W.ledger.push(e); return { success: true } },
  resolveRentcastEligibility: async () => W.eligibility,
  idxForBrokerage: async () => ({
    isConfigured: () => W.idxConfigured,
    searchActiveListings: async () => W.idxRows,
  }),
  createServiceClient: () => ({ from: () => { throw new Error("service client not expected here") } }),
  createServerClient: async () => makeSupabaseMock(),
  generateTextRouted: async () => ({ text: JSON.stringify(W.modelJson) }),
  // The school / neighbourhood / match-score blocks are not this lane's subject.
  // Answered with an empty object so they take their normal path quietly instead
  // of filling the proof's output with their own error handling.
  gatewayChatJSON: async () => ({ ok: true, data: {} }),
}

/**
 * The smallest Supabase mock that answers what generateSmartInsights actually
 * asks: the cached-insight read, the contact's brokerage read, and the upsert.
 * Every terminal resolves `{ data, error }` — the shape supabase-js RESOLVES
 * rather than throws, which is the shape the production code must destructure.
 */
function makeSupabaseMock(): any {
  const q = (table: string) => {
    const state: any = { table, cols: null }
    const chain: any = {
      select: (c: string) => { state.cols = c; return chain },
      eq: () => chain, gt: () => chain, is: () => chain, limit: () => chain,
      order: () => chain,
      upsert: (row: any) => { W.upserts.push({ table, row }); return chain },
      single: async () => terminal(state),
      maybeSingle: async () => terminal(state),
    }
    return chain
  }
  const terminal = async (state: any) => {
    if (state.table === "contacts") {
      return { data: { brokerage_id: W.contactBrokerageId }, error: null }
    }
    if (state.table === "contact_property_insights") {
      // First call is the "already cached?" read; make it a clean miss so the
      // generation path runs. The upsert's .select().single() lands here too and
      // is allowed to answer with the row it was handed.
      const last = W.upserts[W.upserts.length - 1]
      return last ? { data: last.row, error: null } : { data: null, error: null }
    }
    return { data: null, error: null }
  }
  return { from: (t: string) => q(t) }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PROOF
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  process.env.RENTCAST_API_KEY = process.env.RENTCAST_API_KEY || "test-platform-key"

  const { estimateMonthlyRentFromComps, MIN_RENT_COMPS, PROVIDER_RENT_LABEL } = await import(
    "../lib/property/rent-estimate"
  )
  const { searchExternalListings } = await import("../lib/property/external-listings-search")
  const { evaluatePropertyValue } = await import("../lib/property/property-evaluation")
  const { generateSmartInsights } = await import("../app/actions/smart-insights")

  console.log("\nTHE RENT LANE — one provider-sourced rent, or an honest absence\n")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("1. THE RENTAL ENDPOINT — a rent search never reaches the for-sale portal")
  // ───────────────────────────────────────────────────────────────────────────
  {
    resetWorld()
    const est = await estimateMonthlyRentFromComps({
      brokerageId: "brok-1", city: "Austin", state: "TX", zip: "78704",
      bedrooms: 3, systemSource: "rent_lane_proof",
    })
    const paths = W.http.map((c) => c.path)
    check("the pull reached /listings/rental/long-term", paths.includes("/listings/rental/long-term"), paths.join(","))
    check("the pull did NOT reach /listings/sale", !paths.some((p) => p.startsWith("/listings/sale")), paths.join(","))
    check("exactly one provider call was issued", W.http.length === 1, String(W.http.length))
    check("a rent was produced", est.available && est.monthlyRent != null, JSON.stringify(est.monthlyRent))
    // 2200/2400/2600/3000 → median of the middle pair = 2500.
    check("the rent is the MEDIAN of the provider rows, not an average or a guess", est.monthlyRent === 2500, String(est.monthlyRent))
    check("the range is the observed min/max", est.rangeLow === 2200 && est.rangeHigh === 3000)
    check("every row the median was taken over is carried for checking", est.comps.length === 4)
    check("the figure is labelled at the source", est.label === PROVIDER_RENT_LABEL && est.label.length > 40)
    check(
      "the label says these are ASKING rents, not an appraisal",
      /asking/i.test(est.label) && /not an appraisal/i.test(est.label),
    )
    check("the result is discriminated so a bare number cannot be mistaken for a conclusion",
      est.kind === "provider_sourced_rent_comps")

    // The bedroom RANGE form — the bug a prior lane fixed inside the orphan, now
    // reachable because it finally has a consumer. `3` alone means EXACTLY 3.
    const q = W.http[0]?.query ?? {}
    check("the bedroom filter uses RentCast's range form, not a bare exact match",
      q.bedrooms === "3:3", JSON.stringify(q.bedrooms))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n2. METERING — the ledger records the lane that actually spent")
  // ───────────────────────────────────────────────────────────────────────────
  {
    resetWorld()
    await estimateMonthlyRentFromComps({
      brokerageId: "brok-1", contactId: "contact-9", city: "Austin", state: "TX",
      bedrooms: 3, systemSource: "portal_investment_snapshot",
    })
    check("the provider call landed on the vendor ledger", W.ledger.length === 1, String(W.ledger.length))
    const row = W.ledger[0]
    check("it is filed against rentcast", row?.vendorName === "rentcast")
    check("the systemSource is the CALLER'S lane", row?.systemSource === "portal_investment_snapshot", row?.systemSource)
    check("the systemSource is NOT the old hard-coded buyer_search", row?.systemSource !== "buyer_search")
    check("the ledger row names the rental endpoint", row?.metadata?.endpoint === "/listings/rental/long-term")
    check("the contact the spend was for is attributable", row?.metadata?.contact_id === "contact-9")
    check("the tenant the spend is billed to is on the row", row?.brokerageId === "brok-1")

    // A DIFFERENT lane must produce a DIFFERENT ledger row. Six readers once
    // hard-coded one lane, so proving the value is merely non-empty is not enough.
    resetWorld()
    await estimateMonthlyRentFromComps({
      brokerageId: "brok-1", city: "Austin", state: "TX", bedrooms: 3,
      systemSource: "home_value_investor_report",
    })
    check("a second lane files under its OWN name", W.ledger[0]?.systemSource === "home_value_investor_report")
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n3. PRECEDENCE — an IDX-connected tenant is never billed for RentCast")
  // ───────────────────────────────────────────────────────────────────────────
  {
    resetWorld({ eligibility: tenantHasIdx() })
    const est = await estimateMonthlyRentFromComps({
      brokerageId: "brok-idx", city: "Austin", state: "TX", bedrooms: 3,
      systemSource: "rent_lane_proof",
    })
    check("NO provider call was issued", W.http.length === 0, String(W.http.length))
    check("NOTHING was metered", W.ledger.length === 0, String(W.ledger.length))
    check("no rent is reported", est.available === false && est.monthlyRent === null)
    check("the reason is the RULING, not an outage", est.eligibilityReason === "tenant_has_idx")
    check("the note says the suppression was DELIBERATE",
      /DELIBERATE/.test(est.unavailableNote ?? ""), est.unavailableNote ?? "")
    check("the note says the IDX feed cannot serve rentals either",
      /no rental listings|carries no rental/i.test(est.unavailableNote ?? ""))

    // And the router agrees — one decision, not two opinions.
    resetWorld({ eligibility: tenantHasIdx(), idxConfigured: true })
    const routed = await searchExternalListings({
      brokerageId: "brok-idx", city: "Austin", state: "TX", listingType: "rental",
    })
    check("the router issued no rental provider call for an IDX tenant", W.http.length === 0)
    check("the router reports no provider rather than a for-sale substitute", routed.source === "none")
    check("the router echoes back that a RENTAL search was asked for", routed.listingType === "rental")
    check("the router explains why in words", (routed.error ?? "").length > 80)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n4. THE ROUTER — sale and rental reach different portals")
  // ───────────────────────────────────────────────────────────────────────────
  {
    resetWorld()
    const rental = await searchExternalListings({
      brokerageId: "brok-1", city: "Austin", state: "TX", listingType: "rental", limit: 10,
    })
    check("a rental search reached the RENTAL endpoint",
      W.http.some((c) => c.path === "/listings/rental/long-term"), W.http.map((c) => c.path).join(","))
    check("a rental search never reached the SALE endpoint",
      !W.http.some((c) => c.path.startsWith("/listings/sale")))
    check("the rental rows come back", rental.listings.length === 4)
    check("every row says its price is a MONTHLY RENT",
      rental.listings.every((l: any) => l.listingType === "rental"))
    check("the rental search is metered as a RENTER's search, not a buyer's",
      W.ledger[0]?.systemSource === "renter_search", W.ledger[0]?.systemSource)

    resetWorld({ saleRows: [rentalRow(650_000)] })
    const sale = await searchExternalListings({ brokerageId: "brok-1", city: "Austin", state: "TX" })
    check("a search with no listingType still reaches the SALE endpoint (no caller changed meaning)",
      W.http.some((c) => c.path === "/listings/sale"))
    check("it never reaches the rental endpoint",
      !W.http.some((c) => c.path.includes("/listings/rental")))
    check("its rows say sale", sale.listings.every((l: any) => l.listingType === "sale"))
    check("the default result echoes listingType sale", sale.listingType === "sale")
    check("a sale search is still metered as buyer_search", W.ledger[0]?.systemSource === "buyer_search")
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n5. MISSING READS AS MISSING — never 0, never a substitute, never silent")
  // ───────────────────────────────────────────────────────────────────────────
  {
    const cases: Array<[string, () => void, string]> = [
      ["no tenant to meter against", () => resetWorld(), "no_tenant"],
      ["the platform key is unset", () => resetWorld({ eligibility: noPlatformKey() }), "not_eligible"],
      ["the provider call failed", () => resetWorld({ httpOk: false, httpStatus: 503 }), "provider_error"],
      ["the provider published nothing", () => resetWorld({ rentalRows: [] }), "no_listings"],
      ["only one listing exists", () => resetWorld({ rentalRows: [rentalRow(2200)] }), "too_few_listings"],
      ["rows carry no rent at all", () => resetWorld({ rentalRows: [rentalRow(0, { price: null }), rentalRow(0, { price: null })] }), "no_listings"],
    ]
    for (const [name, setup, reason] of cases) {
      setup()
      const est = await estimateMonthlyRentFromComps({
        // The first case deliberately has no tenant.
        brokerageId: reason === "no_tenant" ? null : "brok-1",
        city: "Austin", state: "TX", bedrooms: 3, systemSource: "rent_lane_proof",
      })
      check(`${name} → available:false`, est.available === false)
      check(`${name} → monthlyRent is NULL, not 0`, est.monthlyRent === null && (est.monthlyRent as any) !== 0)
      check(`${name} → the reason is named (${reason})`, est.unavailableReason === reason, String(est.unavailableReason))
      check(`${name} → a plain sentence says why`, (est.unavailableNote ?? "").length > 30)
      check(`${name} → no rent comps are implied`, est.comps.length === 0 && est.sampleSize === 0)
    }

    // No locality is its own case: there is nothing to search, and widening to
    // "anywhere" would print a national median as this neighbourhood's rent.
    resetWorld()
    const noWhere = await estimateMonthlyRentFromComps({
      brokerageId: "brok-1", bedrooms: 3, systemSource: "rent_lane_proof",
    })
    check("no city/state and no ZIP → no lookup issued at all", W.http.length === 0)
    check("no city/state and no ZIP → reads as missing", noWhere.unavailableReason === "no_locality")

    check("the one-listing floor is a named constant, not a magic number", MIN_RENT_COMPS === 2)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n6. NO MODEL AUTHORS A RENT — the evaluation engine")
  // ───────────────────────────────────────────────────────────────────────────
  {
    // The model is fed a response that STILL carries a rent and three rental
    // comps — exactly what it used to be asked for. None of it may survive.
    const MODEL_RENT = 9999
    resetWorld({
      modelJson: {
        city: "Austin", state: "TX", zip: "78704", beds: 3, baths: 2, sqft: 1600,
        propertyType: "single_family",
        estimatedValue: 600_000, valueRangeLow: 570_000, valueRangeHigh: 630_000,
        confidenceLevel: "high",
        comparables: [
          { address: "1 A St", salePrice: 590_000, saleDate: "2025-06-01", adjustments: {}, adjustedSalePrice: 592_000 },
          { address: "2 B St", salePrice: 610_000, saleDate: "2025-05-01", adjustments: {}, adjustedSalePrice: 608_000 },
        ],
        investor: {
          estimatedMonthlyRent: MODEL_RENT,
          capRate: 42, grossYield: 40, cashOnCashReturn: 39, dscr: 9,
          arv: 700_000, estimatedRehab: 50_000,
          rentComps: [
            { address: "MODEL INVENTED 1", monthlyRent: MODEL_RENT, sqft: 1600, beds: 3 },
            { address: "MODEL INVENTED 2", monthlyRent: MODEL_RENT, sqft: 1500, beds: 3 },
            { address: "MODEL INVENTED 3", monthlyRent: MODEL_RENT, sqft: 1700, beds: 3 },
          ],
        },
        stateSpecificDisclosures: [], sources: [],
      },
    })
    const ev = await evaluatePropertyValue({
      address: "100 Subject Rd", city: "Austin", state: "TX", zip: "78704",
      audience: "investor", brokerageId: "brok-1", systemSource: "rent_lane_proof",
    })
    const inv = ev.investor!
    check("investor metrics are present", inv != null)
    check("the model's rent did NOT become the reported rent", inv.estimatedMonthlyRent !== MODEL_RENT)
    check("the reported rent is the PROVIDER's median", inv.estimatedMonthlyRent === 2500, String(inv.estimatedMonthlyRent))
    check("the model's rental comps did not survive",
      !inv.rentComps.some((r) => r.address.includes("MODEL INVENTED")),
      JSON.stringify(inv.rentComps.map((r) => r.address)))
    check("the rent comps are the provider's published listings", inv.rentComps.length === 4)
    check("the model's cap rate did not survive", inv.capRate !== 42, String(inv.capRate))
    check("the model's gross yield did not survive", inv.grossYield !== 40)
    check("the model's cash-on-cash did not survive", inv.cashOnCashReturn !== 39)
    check("the model's DSCR did not survive", inv.dscr !== 9)
    check("the ratios are computed and present", inv.capRate != null && inv.grossYield != null && inv.dscr != null)
    // 2500/mo → 30,000/yr; 35% expenses → NOI 19,500; /600,000 = 3.25%.
    check("the cap rate is arithmetic over the provider rent and the value estimate",
      inv.capRate === 3.25, String(inv.capRate))
    check("gross yield is annual provider rent over value", inv.grossYield === 5, String(inv.grossYield))
    check("the rent source rides along, labelled", inv.rentSource.available && inv.rentSource.label.length > 40)
    check("the derivation of the ratios is stated", /assumption/i.test(inv.derivationNote))
    check("the citation names the rental listings that were actually used",
      /RentCast/.test(ev.disclosures.dataSourceCitation), ev.disclosures.dataSourceCitation)

    // With no provider rent, every rent-derived figure must go with it.
    resetWorld({ modelJson: W?.modelJson ?? null })
    W.modelJson = {
      estimatedValue: 600_000, confidenceLevel: "high",
      comparables: [
        { address: "1 A St", salePrice: 590_000, saleDate: "2025-06-01", adjustments: {}, adjustedSalePrice: 592_000 },
        { address: "2 B St", salePrice: 610_000, saleDate: "2025-05-01", adjustments: {}, adjustedSalePrice: 608_000 },
      ],
      investor: { estimatedMonthlyRent: MODEL_RENT, capRate: 42, arv: 700_000, estimatedRehab: 50_000, rentComps: [] },
    }
    W.eligibility = tenantHasIdx()
    const suppressed = await evaluatePropertyValue({
      address: "100 Subject Rd", city: "Austin", state: "TX",
      audience: "investor", brokerageId: "brok-idx", systemSource: "rent_lane_proof",
    })
    const s = suppressed.investor!
    check("suppressed provider → the investor block still EXISTS (not silently dropped)", s != null)
    check("suppressed provider → rent is null, not the model's and not 0", s.estimatedMonthlyRent === null)
    check("suppressed provider → cap rate is null, not computed from a substitute", s.capRate === null)
    check("suppressed provider → gross yield, cash-on-cash and DSCR are null too",
      s.grossYield === null && s.cashOnCashReturn === null && s.dscr === null)
    check("suppressed provider → no rental comps are implied", s.rentComps.length === 0)
    check("suppressed provider → a plain sentence says why", (s.rentSource.unavailableNote ?? "").length > 40)
    check("suppressed provider → the citation stops claiming rental market data",
      !/rental market data/.test(suppressed.disclosures.dataSourceCitation))

    // A homeowner report must not spend the tenant's rental budget at all.
    resetWorld()
    W.modelJson = { estimatedValue: 600_000, confidenceLevel: "high", comparables: [] }
    await evaluatePropertyValue({
      address: "100 Subject Rd", city: "Austin", state: "TX",
      audience: "homeowner", brokerageId: "brok-1",
    })
    check("a homeowner valuation issues no rental pull", W.http.length === 0, String(W.http.length))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n7. THE BUYER PORTAL — no fabricated rent, and no fabricated price behind it")
  // ───────────────────────────────────────────────────────────────────────────
  {
    resetWorld()
    const withPrice = await generateSmartInsights(
      "prop-1",
      { price: 600_000, sqft: 1600, city: "Austin", state: "TX", zip: "78704", bedrooms: 3 },
      "contact-1",
      {},
    )
    const invA = (withPrice as any)?.investment_insights
    check("the portal issued a REAL rental pull", W.http.some((c) => c.path === "/listings/rental/long-term"))
    check("the portal's rent is the provider median", invA?.rentalAnalysis?.estimatedMonthlyRent === 2500,
      String(invA?.rentalAnalysis?.estimatedMonthlyRent))
    // The fabricated value for a $600k home was 600000 * 0.0085 = 5100.
    check("the portal's rent is NOT price * 0.0085", invA?.rentalAnalysis?.estimatedMonthlyRent !== 5100)
    check("the portal names the rent's source for the renderer",
      /RentCast/.test(invA?.rentalAnalysis?.rentSourceCaption ?? ""), invA?.rentalAnalysis?.rentSourceCaption)
    check("returns are computed from the provider rent", invA?.returns?.capRate != null)
    check("the portal's spend is filed under the portal's lane, not buyer_search",
      W.ledger[0]?.systemSource === "portal_investment_snapshot", W.ledger[0]?.systemSource)
    check("the insight row is written against a tenant", W.upserts[0]?.row?.brokerage_id === "brok-1")
    check("the tenant came from the CONTACT, not from the caller's arguments",
      W.upserts[0]?.row?.brokerage_id === W.contactBrokerageId)

    // THE HEADLINE CASE: a property with NO price. It used to display a
    // confident "$4,250/mo" from a hard-coded $500,000.
    resetWorld()
    const noPrice = await generateSmartInsights(
      "prop-2", { city: "Austin", state: "TX", zip: "78704", bedrooms: 3 }, "contact-1", {},
    )
    const invB = (noPrice as any)?.investment_insights
    check("no price → price reads as null, not 500000", invB?.price === null, String(invB?.price))
    check("no price → the fabricated $4,250 is gone", invB?.rentalAnalysis?.estimatedMonthlyRent !== 4250)
    check("no price → returns are absent, not computed against a default",
      invB?.returns === null, JSON.stringify(invB?.returns))
    check("no price → the appreciation projection is absent too", invB?.appreciation === null)
    check("no price → meetsGoals and the recommendation are withheld",
      invB?.meetsGoals === null && invB?.recommendation === null)
    check("no price → a sentence names what was missing",
      /no list price/i.test(invB?.unavailableNote ?? ""), invB?.unavailableNote)
    check("no price → the PROVIDER rent still stands (it never needed the price)",
      invB?.rentalAnalysis?.estimatedMonthlyRent === 2500)

    // No provider rent AND a price: the price-derived half survives, the
    // rent-derived half does not.
    resetWorld({ rentalRows: [] })
    const noRent = await generateSmartInsights(
      "prop-3", { price: 600_000, sqft: 1600, city: "Austin", state: "TX" }, "contact-1", {},
    )
    const invC = (noRent as any)?.investment_insights
    check("no provider rent → rent is null, never 0", invC?.rentalAnalysis?.estimatedMonthlyRent === null)
    check("no provider rent → returns are null", invC?.returns === null)
    check("no provider rent → price-per-sqft still stands", invC?.rentalAnalysis?.pricePerSqft === 375)
    check("no provider rent → the appreciation projection still stands", invC?.appreciation != null)
    check("no provider rent → the reason is carried to the renderer",
      (invC?.rentSource?.unavailableNote ?? "").length > 30)

    // With no tenant on the contact there is nobody to bill — and nothing is
    // invented in place of the rent.
    resetWorld({ contactBrokerageId: null })
    const noTenant = await generateSmartInsights(
      "prop-4", { price: 600_000, sqft: 1600, city: "Austin", state: "TX" }, "contact-1", {},
    )
    const invD = (noTenant as any)?.investment_insights
    check("no tenant → no provider call was issued", W.http.length === 0)
    check("no tenant → nothing was metered", W.ledger.length === 0)
    check("no tenant → rent reads as missing", invD?.rentalAnalysis?.estimatedMonthlyRent === null)
    check("no tenant → returns are null", invD?.returns === null)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n8. CONSTRUCT — facts a behaviour run cannot observe (comment-blanked)")
  // ───────────────────────────────────────────────────────────────────────────
  {
    // THE ASSERTION THE LANE WAS SENT TO MAKE: the fabricated rent expression
    // appears NOWHERE in the tree. Scanned over blanked comments, because the
    // fix quotes the defect in its own explanation.
    const FABRICATED = /\*\s*0\.0085|0\.0085\s*\*/
    const tsFiles = collectSources()
    const offenders = tsFiles.filter((f) => FABRICATED.test(scannable(f)))
    check("`price * 0.0085` appears NOWHERE in the tree (comments blanked, strings masked)",
      offenders.length === 0, offenders.join(", "))
    // The scanner has to be able to SEE the defect, or its silence means nothing.
    check("...and that scan can actually detect the expression as live code",
      FABRICATED.test(blankStrings("const x = price * 0.0085")))
    check("...and masking removes a COMMENTED one",
      !FABRICATED.test(blankStrings("// it used to be price * 0.0085\nconst x = 1")))
    check("...and masking removes a QUOTED one (this proof's own negative control)",
      !FABRICATED.test(blankStrings(`const find = "price * 0.0085"`)))

    const insights = code(F.insights)
    check("the $500,000 price default is gone from the portal insights",
      !/\|\|\s*500000|\?\?\s*500000/.test(insights))
    check("the 2000-sqft default is gone too", !/\|\|\s*2000\b|\?\?\s*2000\b/.test(insights))
    check("the portal asks the rent provider", /estimateMonthlyRentFromComps/.test(insights))
    check("the portal resolves its tenant from the contacts table",
      /from\("contacts"\)[\s\S]{0,80}brokerage_id/.test(insights))
    check("the portal does not accept a brokerage id as an argument",
      !/brokerageId\s*[?:]\s*string/.test(insights.split("async function generateInvestmentInsights")[0] ?? ""))

    const evaluation = code(F.evaluation)
    check("the evaluation PROMPT no longer asks for a monthly rent",
      !/"estimatedMonthlyRent":\s*<int\|null>/.test(evaluation))
    check("the evaluation PROMPT no longer asks for rental comparables",
      !/"rentComps":\s*\[/.test(evaluation))
    check("the evaluation PROMPT no longer asks for the four rent-derived ratios",
      !/"capRate":\s*<number\|null>/.test(evaluation) && !/"dscr":\s*<number\|null>/.test(evaluation))
    check("the prompt tells the model in words not to estimate a rent",
      /DO NOT ESTIMATE RENT/.test(evaluation))
    check("the assembler never reads a rent off the model's response",
      !/parsed[\s\S]{0,40}investor[\s\S]{0,20}\.estimatedMonthlyRent/.test(evaluation))
    check("the assembler never reads rentComps off the model's response",
      !/parsed[\s\S]{0,40}investor[\s\S]{0,20}\.rentComps/.test(evaluation))
    check("the evaluation engine imports the provider rent reader",
      /estimateMonthlyRentFromComps/.test(evaluation))

    const router = code(F.router)
    check("the router imports the RENTAL reader", /searchRentcastRentalListings/.test(router))
    check("the router still imports the SALE reader", /searchRentcastSaleListings/.test(router))
    check("the router does not hard-code buyer_search for a rental search",
      /RENTAL_SYSTEM_SOURCE\s*=\s*"renter_search"/.test(router))

    const rent = code(F.rent)
    check("the rent module gates on eligibility before it spends",
      rent.indexOf("resolveRentcastEligibility") < rent.indexOf("searchRentcastRentalListings("),
      "the pull must not precede the gate")
    check("the rent module requires a systemSource rather than defaulting one",
      /systemSource:\s*string\b/.test(rent) && !/systemSource\?\s*:/.test(rent))
    check("there is no branch producing available:true with a null rent",
      !/available:\s*true[\s\S]{0,120}monthlyRent:\s*null/.test(rent))

    // The public endpoint must not take a tenant from the browser.
    const action = code(F.action)
    check("the public evaluation endpoint resolves the tenant server-side",
      /from\("agents"\)/.test(action) && /brokerage_id/.test(action))
    check("the public evaluation endpoint accepts no brokerageId parameter",
      !/brokerageId\?\s*:/.test(action.split("export async function evaluatePropertyAction")[1] ?? ""))
    check("its agent read checks the refused-read path",
      /const \{ data, error \}/.test(action) && /if \(error\)/.test(action))

    // THE RENDERERS NAME THE SOURCE.
    const portalUi = code(F.portalUi)
    check("the portal renderer shows the rent's source caption",
      /rentSourceCaption/.test(portalUi))
    check("the portal renderer prints the unavailability reason rather than a bare dash",
      /unavailableNote/.test(portalUi))
    check("the portal's investment card is no longer gated on `returns` (which now goes null)",
      !/\{investment\?\.returns && \(/.test(portalUi))

    const hvUi = code(F.homeValueUi)
    check("the home-value renderer names RentCast as the rent source", /RentCast/.test(hvUi))
    check("the home-value renderer shows the unavailability note", /unavailableNote/.test(hvUi))
    check("the home-value renderer shows the derivation of the ratios", /derivationNote/.test(hvUi))
    check("the home-value page passes an agent id so the tenant can be resolved",
      /agentId:\s*branding\.agentId/.test(hvUi))

    // THE ORPHAN HAS CONSUMERS. The whole reason this lane exists.
    const consumers = tsFiles.filter(
      (f) => f !== F.readers && !f.startsWith("scripts/") && /searchRentcastRentalListings/.test(code(f)),
    )
    check("searchRentcastRentalListings now has real consumers in the app tree",
      consumers.length >= 2, consumers.join(", ") || "none")
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FINDINGS — reported, not failed. Outside this lane's write scope.
  // ───────────────────────────────────────────────────────────────────────────
  if (!CHILD) {
    finding(
      "appreciation rate is a hard-coded 4.5%",
      "app/actions/smart-insights.ts still projects five-year value from a constant 4.5%/yr with no provider behind it. It is now LABELLED as an assumption on `assumptions`, but it is still a number nobody measured. Fixing it needs a market-appreciation source decision, which is not the rent lane's to make.",
    )
    finding(
      "ARV and rehab budget are still model-authored",
      "lib/property/property-evaluation.ts still asks the LLM for `arv` and `estimatedRehab` and renders both as dollars. Same defect class as the rent was — a generative model authoring money on a client-facing page — but it is a VALUATION figure, not a rent, and belongs to whichever lane owns the LLM valuation engine. They no longer default to 0 when absent.",
    )
    finding(
      "lib/buyer-search/external-match.ts writes ext.price into saved_properties.list_price",
      "Correct today because that path never asks for rentals, but ExternalListing now carries `listingType` and that writer ignores it. If anyone routes a rental search through runExternalMarketWatchForBuyer, a monthly rent lands in a column named list_price.",
    )
    finding(
      "no caller can yet SAY it wants a rental",
      "`listingType` is wired end to end and defaults to sale, but nothing upstream sets it: lib/buyer-search/intent-parser.ts has no rent-vs-buy intent and contacts has no column for one. The rental portal is reachable and proven; the product still has no place a renter declares themselves.",
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // NEGATIVE CONTROLS — re-introduce each defect, require the proof to go red
  // ───────────────────────────────────────────────────────────────────────────
  if (!ASSERT_ONLY) {
    console.log("\n9. NEGATIVE CONTROLS — each defect written back must turn this proof red")
    const controlled = (name: string, patch: { file: string; find: string; replace: string }) => {
      const before = raw(patch.file)
      const beforeSha = sha(patch.file)
      if (!before.includes(patch.find)) {
        check(`control "${name}" could be applied`, false, "find-string no longer present in the source")
        return
      }
      writeFileSync(join(ROOT, patch.file), before.replace(patch.find, patch.replace), "utf8")
      const applied = raw(patch.file).includes(patch.replace)
      let red = false
      try {
        if (applied) {
          const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/rent-lane-simulator.ts"], {
            cwd: ROOT, env: { ...process.env, RENT_SIM_CHILD: "1" }, encoding: "utf8", timeout: 240_000,
          })
          red = r.status !== 0
        }
      } finally {
        writeFileSync(join(ROOT, patch.file), before, "utf8")
      }
      check(`control "${name}" was actually applied`, applied)
      check(`control "${name}" turns the proof RED`, red)
      check(`control "${name}" left the file byte-identical afterwards`, sha(patch.file) === beforeSha)
    }

    // 1. The fabricated rent, restored exactly as it was.
    controlled("the fabricated price * 0.0085 rent", {
      file: F.insights,
      find: "  const estimatedMonthlyRent = rentSource.monthlyRent",
      replace: "  const estimatedMonthlyRent = price != null ? Math.round(price * 0.0085) : rentSource.monthlyRent",
    })

    // 2. The $500,000 price default behind it.
    controlled("the hard-coded $500,000 price default", {
      file: F.insights,
      find: "  const rawPrice = propertyData.price ?? propertyData.listPrice ?? null",
      replace: "  const rawPrice = propertyData.price ?? propertyData.listPrice ?? 500000",
    })

    // 3. The model re-authoring the rent.
    controlled("the model's rent promoted back into the report", {
      file: F.evaluation,
      find: "    estimatedMonthlyRent: rent,",
      replace: "    estimatedMonthlyRent: modelInvestor?.estimatedMonthlyRent ?? rent,",
    })

    // 4. The model re-authoring the rental comparables.
    controlled("the model's rental comparables promoted back into the report", {
      file: F.evaluation,
      find: `    rentComps: source.comps.map((c) => ({`,
      replace: `    rentComps: (Array.isArray(modelInvestor?.rentComps) ? modelInvestor.rentComps : source.comps).map((c: any) => ({`,
    })

    // 5. The rent search routed back into the for-sale portal.
    controlled("a rental search routed into the for-sale endpoint", {
      file: F.router,
      find: `      listingType === "rental"
        ? await searchRentcastRentalListings({ ...caller, filters })
        : await searchRentcastSaleListings({ ...caller, filters })`,
      replace: `      await searchRentcastSaleListings({ ...caller, filters })`,
    })

    // 6. The eligibility gate bypassed — RentCast spent on a tenant who owns IDX.
    controlled("the rental pull issued without asking the eligibility gate", {
      file: F.rent,
      find: "  if (!eligibility.eligible) {",
      replace: "  if (false) {",
    })

    // 7. A missing rent rendered as 0 instead of as missing.
    controlled("a missing rent defaulting to 0 instead of null", {
      file: F.rent,
      find: `    available: false,
    monthlyRent: null,`,
      replace: `    available: false,
    monthlyRent: 0 as any,`,
    })

    // 8. The rental spend filed under a lane that did not spend.
    controlled("the rental pull losing its vendor-ledger lane", {
      file: F.rent,
      find: "    systemSource: req.systemSource,",
      replace: `    systemSource: "buyer_search",`,
    })

    // 9. The rent-derived ratios standing on nothing after the rent went away.
    controlled("cap rate surviving a missing rent", {
      file: F.evaluation,
      find: "  if (rent != null && value != null) {",
      replace: "  if (value != null) {",
    })

    // 10. The portal's returns block computed against a substituted rent.
    controlled("the portal computing returns without a provider rent", {
      file: F.insights,
      find: "  if (estimatedMonthlyRent == null || price == null) {",
      replace: "  if (false) {",
    })
  }

  if (findings.length && !CHILD) {
    console.log(`\nFINDINGS (${findings.length}) — reported, not failed:`)
    for (const f of findings) console.log(`  ⚠ ${f}`)
  }

  console.log("")
  console.log(` RESULT: ${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" ❌ RENT_LANE_FAIL")
    process.exit(1)
  }
  console.log(
    " ✅ RENT_LANE_PASS — every rent figure comes from published rental listings, a rent search" +
    " reaches the rental endpoint, an IDX tenant is never billed for it, the spend names its own lane," +
    " and a rent nobody could source reads as missing rather than as zero, a model's guess, or a" +
    " fraction of the price",
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Source collection for the tree-wide scan
// ─────────────────────────────────────────────────────────────────────────────
function collectSources(): string[] {
  const SKIP = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", ".vercel"])
  const out: string[] = []
  const walk = (rel: string) => {
    let entries: string[]
    try { entries = readdirSync(rel ? join(ROOT, rel) : ROOT) } catch { return }
    for (const e of entries) {
      if (SKIP.has(e)) continue
      const r = rel ? `${rel}/${e}` : e
      let st
      try { st = statSync(join(ROOT, r)) } catch { continue }
      if (st.isDirectory()) walk(r)
      else if (/\.(ts|tsx)$/.test(e)) out.push(r)
    }
  }
  walk("")
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
