#!/usr/bin/env tsx
/**
 * scripts/enrichment-one-rail-guard.ts   (npm run test:enrichment-one-rail)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 80B — owner verbatim (wave 80): "resolve enrichment duplicate for
 * listing intake and research assessorsearch before adding." Standing: "tools
 * for the ai agents should not be using batchdata tools if there are less
 * expensive tools to look up properties but the ai agents need to not be
 * salesy but also try to get them qualified… this goes for the platform ai
 * agents."
 *
 * Proves, with NO network and NO database:
 *   Layer 0 — strip-comments positive control (CLAUDE.md §2).
 *   Layer 1 — THE DUPLICATE IS GONE: lib/property/enrichment-chain.ts does not
 *             exist and nothing under app/ lib/ scripts/ imports it (stripped
 *             source; a fixture importing it IS flagged — positive control).
 *             Its Street View helpers live in lib/property/street-view.ts and
 *             both former callers import them from there.
 *   Layer 2 — THE SURVIVOR's listing_intake path (injected rungs / geocode /
 *             estimate): the estimate runs ONLY when every rung missed and ONLY
 *             for purpose listing_intake + audience staff; it carries facts
 *             only (never a value); the free geocode fills lat/lon; BatchData
 *             never runs for listing_intake even under an allowing policy; a
 *             throwing estimate is recorded, never thrown; a conversation gets
 *             "not found" (never a guess). splitOneLineAddress round-trips.
 *   Layer 3 — ONE BATCHDATA GATE: decideBatchDataAccess per purpose × policy
 *             (tenant-less skip trace refused; DNC never spend-refused;
 *             conversation / listing_intake / unknown refused); every
 *             production importer of lib/external/batchdata-* or
 *             lib/batchdata-client is (a) a transport / registry / probe file,
 *             (b) a frozen scraper-lane file, (c) a GATED caller whose
 *             resolveBatchDataAccess( precedes its reach, or (d) a published
 *             blind spot on a shrink-only list. A fixture that reaches without
 *             the gate IS flagged (positive control). Denominator printed.
 *   Layer 4 — ONE SOURCE VOCABULARY (§6): the old "osint"|"batchdata"|
 *             "ai_estimate" union and the EnrichSource name are absent from
 *             app/ lib/; the presentation builder types its source from the
 *             rail's PropertyLookupSource; AI_ESTIMATE_FACT_FIELDS names no
 *             value / rent / score field.
 *   Layer 5 — ASSESSORSEARCH: researched, NOT added — no env read and no
 *             connector for it anywhere (fixture flagged: control). The
 *             verdict (not cheaper than the public-records rung; internal-
 *             workflow licence) is in the lane notes and the registry entry.
 *   Layer 6 — PERSONA / PLATFORM REALISM (continues 79B): the customer bundle
 *             mounts the owner's five follow-ups + record_qualification; the
 *             widget capture routes create the person through captureContact
 *             / the contacts table; every persona surface hands
 *             buildQualificationPrompt to a ROUTED model call; the platform
 *             prospect bundle has the same shape (save / demo / callback /
 *             signup / human) and its chat route is routed.
 *   Layer 7 — registration: package.json script, guard ordering after
 *             test:scrapers (ordering only), MAINTENANCE_DOMAINS entry with
 *             coOwners (the prose names co-owners).
 *   Layer 8 — lane 85C, HOUSEHOLD FINANCIALS (marital status, household income,
 *             net worth, MODELED credit band) + contact-enrichment location:
 *             8a the ONE mapper, pure (BatchData / Versium readers, band-only
 *                credit with an exact-score positive control, one marital
 *                vocabulary, merge / carry-forward, live contacts columns);
 *             8b the writers (acquisition normalizer keeps the dataset, Step 6f
 *                names it, raw path merges it, the seller-signal probe captures
 *                it after the address refusal — run against a resolving double
 *                with a neighbour as positive control — the tenant-anchored
 *                persist, the paid rung asked only for a gap under the budget
 *                gate and booked as 'versium');
 *             8c contact enrichment sends city/state/ZIP (positive control: the
 *                pre-85C call is flagged) and maps through the survivor — no
 *                second PeopleData → column mapper anywhere (positive control);
 *             8d FCRA / display (REWRITTEN wave 86, lane 86A — owner: "add because most
 *                audience or info will be used from the contact card"): net worth + the
 *                credit band ARE on the agent contact card, labelled "modeled estimate",
 *                back-office seats only; THE MODELED-CREDIT FIREWALL — a comment-stripped
 *                census of app/ + lib/: the credit band is named ONLY by its allowlisted
 *                path (provider adapters → the one mapper → the paid rung → the contact
 *                columns → the card door → the card, + DSR erasure), none of which has an
 *                egress or model call; so it cannot reach outbound copy, eligibility,
 *                pricing, steering or a persona. POSITIVE CONTROLS: an outbound fixture
 *                reading the band, and the pre-86 persona pain-point line, ARE flagged; a
 *                tombstone naming the band is NOT.
 *   Layer 8e — wave 86 (lane 86A): VERSIUM IS THE CREDIT-BAND PROVIDER — the client per
 *             Versium's published API (x-versium-api-key, output[]=financial, US only,
 *             cfg_maxrecs=1, rcfg_max_time), billed per MATCH from the response's own
 *             match_counts (a billed match with none of our fields is still booked —
 *             positive control for the 85C understatement), status codes named, and a
 *             stubbed-fetch run (zero network) proving the request shape and the booking;
 *             contacts.enrichment_source means PROVIDER everywhere (§6) — no write of a
 *             trigger into it anywhere (positive control: the pre-86 line is flagged).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p)
  }
  return out
}
const CORPUS = [...walk("app"), ...walk("lib")]
const SCRIPTS = walk("scripts").filter((p) => p !== join("scripts", "enrichment-one-rail-guard.ts"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 0 · strip-comments positive control]")
const railSrc = stripped("lib/ai-isa/property-lookup-rail.ts")
check("a comment-only phrase is ABSENT from stripped property-lookup-rail.ts", !railSrc.includes("ONE GATE FOR EVERY BATCHDATA REACH"))
check("a real code token from the same file IS present", railSrc.includes("export async function resolveBatchDataAccess"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · the duplicate is gone and nothing imports it]")
const DUP = "lib/property/enrichment-chain.ts"
check(`${DUP} no longer exists`, !existsSync(DUP))
const DUP_IMPORT = /["']@\/lib\/property\/enrichment-chain["']/
const dupImporters = [...CORPUS, ...SCRIPTS].filter((p) => DUP_IMPORT.test(stripped(p)))
check(`no file under app/ lib/ scripts/ imports @/lib/property/enrichment-chain (denominator ${CORPUS.length + SCRIPTS.length} files)`, dupImporters.length === 0, dupImporters.join(", "))
check("POSITIVE CONTROL: the importer scan DOES flag a fixture (static and dynamic)",
  DUP_IMPORT.test(`import { enrichPropertyChain } from "@/lib/property/enrichment-chain"`) && DUP_IMPORT.test(`await import("@/lib/property/enrichment-chain")`))
const SV = "lib/property/street-view.ts"
const svSrc = stripped(SV)
check("the Street View / static-map helpers live in lib/property/street-view.ts (URL builders only — no fetch, no spend)",
  /export function getStreetViewImageUrl\(/.test(svSrc) && /export function getStaticMapImageUrl\(/.test(svSrc) && !/fetch\(/.test(svSrc))
for (const caller of ["lib/workflow/intelligence/listing-presentation-builder.ts", "app/actions/lead-intelligence.ts"]) {
  check(`${caller}: imports the helpers from @/lib/property/street-view`, /import\(["']@\/lib\/property\/street-view["']\)/.test(stripped(caller)))
}
const lpbSrc = stripped("lib/workflow/intelligence/listing-presentation-builder.ts")
check("listing-presentation-builder reaches the rail with purpose 'listing_intake', audience 'staff' and the SESSION tenant (input.brokerageId)",
  /lookupPropertyForConversation\(\{[\s\S]{0,120}brokerageId: input\.brokerageId,[\s\S]{0,60}purpose: "listing_intake",[\s\S]{0,40}audience: "staff"/.test(lpbSrc))
check("listing-presentation-builder never imports a BatchData module", !/@\/lib\/external\/batchdata-|@\/lib\/batchdata-client/.test(lpbSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · the survivor's listing_intake path (injected, zero network)]")
const rail = await import("../lib/ai-isa/property-lookup-rail")
const { lookupPropertyForConversation, isAiEstimateAllowed, splitOneLineAddress, formatFullAddress, PROPERTY_LOOKUP_RUNG_ORDER, AI_ESTIMATE_FACT_FIELDS } = rail
type Facts = import("../lib/ai-isa/property-lookup-rail").PropertyLookupFacts
type Rung = import("../lib/ai-isa/property-lookup-rail").PropertyLookupRung
type Purpose = import("../lib/ai-isa/property-lookup-rail").PropertyLookupPurpose
const facts = (source: Rung, extra: Partial<Facts> = {}): Facts => ({
  address: "123 Main St", city: "Austin", state: "TX", zip: "78701", beds: 3, baths: 2, sqft: 1800, yearBuilt: 1998, lotSize: null,
  propertyType: "single_family", listingStatus: null, listPrice: null, estimatedValue: 450000, taxAssessedValue: 390000, annualPropertyTax: null, propertyTaxYear: null, hoaMonthly: null,
  mlsNumber: null, listingUrl: null, lat: null, lon: null, isEstimate: false, source, sourceNote: "fixture", ...extra,
})
const calls: string[] = []
const rungs = (hits: Partial<Record<Rung, boolean>>) => Object.fromEntries(PROPERTY_LOOKUP_RUNG_ORDER.map((r) => [r, async () => { calls.push(r); return hits[r] ? facts(r) : null }])) as Record<Rung, () => Promise<Facts | null>>
const geocode = async () => { calls.push("geocode"); return { lat: 30.27, lon: -97.74 } }
const estimate = async () => { calls.push("estimate"); return { beds: 4, baths: 2.5, sqft: 2100, yearBuilt: 2004, lotSize: 0.2, propertyType: "single_family" } }
const req = (purpose: Purpose, audience: "customer" | "staff") =>
  ({ brokerageId: "b-1", purpose, audience, address: { street: "123 Main St", city: "Austin", state: "TX", zip: "78701" } })
const ALLOW = { batchDataTier: "lean" as const, batchDataOptedIn: true }

check("isAiEstimateAllowed: listing_intake+staff only", isAiEstimateAllowed("listing_intake", "staff") && !isAiEstimateAllowed("listing_intake", "customer") && !isAiEstimateAllowed("conversation", "staff") && !isAiEstimateAllowed("acquisition", "staff"))
{ // every rung misses → labelled facts-only estimate + geocode
  calls.length = 0
  const r = await lookupPropertyForConversation(req("listing_intake", "staff"), { rungs: rungs({}), geocode, estimate, policy: ALLOW })
  check("listing_intake: every rung missed → the AI estimate answers, flagged isEstimate, source 'ai_estimate', facts only (estimatedValue null), lat/lon from the free geocode",
    r.found && r.facts?.source === "ai_estimate" && r.facts.isEstimate === true && r.facts.beds === 4 && r.facts.estimatedValue === null && r.facts.taxAssessedValue === null && r.facts.lat === 30.27 && r.facts.lon === -97.74)
  check("…and BatchData was NOT tried for listing_intake even under an allowing policy (rungsTried stops at public_records; skipped names the purpose)",
    !calls.includes("batchdata") && r.rungsTried.join(",") === "cache,tenant_idx,rentcast,public_records" && r.skipped.some((s) => s.rung === "batchdata" && /listing_intake/.test(s.reason)))
  check("…estimate ran AFTER the whole ladder, geocode last", calls.join(",") === "cache,tenant_idx,rentcast,public_records,estimate,geocode")
}
{ // a real rung answers → no estimate; geocode still fills lat/lon
  calls.length = 0
  const r = await lookupPropertyForConversation(req("listing_intake", "staff"), { rungs: rungs({ cache: true }), geocode, estimate, policy: ALLOW })
  check("listing_intake: cache answers → estimate NEVER runs, isEstimate false, geocode fills lat/lon, staff keeps estimatedValue",
    r.found && r.facts?.source === "cache" && !calls.includes("estimate") && calls.includes("geocode") && r.facts.isEstimate === false && r.facts.lat === 30.27 && r.facts.estimatedValue === 450000)
}
{ // a conversation never gets a guess
  calls.length = 0
  const r = await lookupPropertyForConversation(req("conversation", "customer"), { rungs: rungs({}), geocode, estimate, policy: ALLOW })
  check("conversation: every rung missed → NOT found, no estimate, no geocode (a customer gets the value-review offer, never a guess)",
    !r.found && !calls.includes("estimate") && !calls.includes("geocode"))
  calls.length = 0
  const c = await lookupPropertyForConversation(req("listing_intake", "customer"), { rungs: rungs({}), geocode, estimate, policy: ALLOW })
  check("listing_intake with a CUSTOMER audience: no estimate either (audience gate)", !c.found && !calls.includes("estimate"))
}
{ // estimate throws → recorded, never thrown
  calls.length = 0
  const r = await lookupPropertyForConversation(req("listing_intake", "staff"), { rungs: rungs({}), geocode, estimate: async () => { throw new Error("model dark") }, policy: ALLOW })
  check("a throwing estimate is recorded as skipped ('ai estimate failed') and the lookup returns not-found rather than throwing", !r.found && r.skipped.some((s) => /ai estimate failed: model dark/.test(s.reason)))
  const e = await lookupPropertyForConversation(req("listing_intake", "staff"), { rungs: rungs({}), geocode, estimate: async () => ({ beds: null, baths: null, sqft: null, yearBuilt: null, lotSize: null, propertyType: null }), policy: ALLOW })
  check("an all-null estimate is NOT a finding (found=false) — an empty guess never renders as facts", !e.found)
}
check("AI_ESTIMATE_FACT_FIELDS carries physical facts only — no value / rent / walk / score field",
  AI_ESTIMATE_FACT_FIELDS.length === 6 && !AI_ESTIMATE_FACT_FIELDS.some((f) => /value|rent|walk|score|price/i.test(f)))
check("the production estimate is booked through generateObjectRouted with a feature AND the tenant (never the unbooked lib/ai/generate shim)",
  /generateObjectRouted\(\{[\s\S]{0,80}feature: "listing_intake_property_estimate",[\s\S]{0,40}brokerageId: req\.brokerageId/.test(railSrc) && !/@\/lib\/ai\/generate["']/.test(railSrc))
check("the production geocode rides the canonical Nominatim survivor (lib/external/nominatim-geocode.ts::geocodeOne) — no inline Nominatim call in the rail",
  /import\("@\/lib\/external\/nominatim-geocode"\)/.test(railSrc) && !/nominatim\.openstreetmap\.org/.test(railSrc))
{ // splitOneLineAddress
  const a = splitOneLineAddress("123 Main St, Austin, TX 78701")
  const b = splitOneLineAddress("9 Elm Ave, Apt 4, Springfield, IL")
  const c = splitOneLineAddress("77 Lone St")
  check("splitOneLineAddress: 'street, city, ST zip' → parts; multi-comma middle → city; a bare street stays the street; formatFullAddress round-trips",
    a.street === "123 Main St" && a.city === "Austin" && a.state === "TX" && a.zip === "78701" && formatFullAddress(a) === "123 Main St, Austin, TX, 78701"
    && b.city === "Apt 4, Springfield" && b.state === "IL" && b.zip === null && c.street === "77 Lone St" && !c.city)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · ONE BatchData gate — decision table + every production reach passes it]")
const { decideBatchDataAccess, resolveBatchDataAccess } = rail
const OFF = { batchDataTier: "off" as const, batchDataOptedIn: true }
const NO_OPT = { batchDataTier: "lean" as const, batchDataOptedIn: false }
type Policy = import("../lib/ai-isa/property-lookup-rail").PropertyLookupPolicy
const d = (purpose: Purpose, policy: Policy, brokerageId: string | null = "b-1") => decideBatchDataAccess({ brokerageId, purpose }, policy).allowed
check("acquisition: tier≠off AND opt-in → allowed; no opt-in → refused; tier off → refused; no tenant → refused",
  d("acquisition", ALLOW) && !d("acquisition", NO_OPT) && !d("acquisition", OFF) && !d("acquisition", ALLOW, null))
check("skip_trace: tier≠off → allowed WITHOUT the on-market opt-in; tier off → refused; no tenant → refused (§4)",
  d("skip_trace", ALLOW) && d("skip_trace", NO_OPT) && !d("skip_trace", OFF) && !d("skip_trace", ALLOW, null))
check("dnc: never refused by a spend policy — allowed under tier off, no opt-in and no tenant (compliance; the MCP wrapper reports unconfigured)",
  d("dnc", OFF, null) && d("dnc", NO_OPT, null) && decideBatchDataAccess({ purpose: "dnc" }, OFF).reason.includes("never refused"))
check("conversation / listing_intake / an unknown purpose → refused whatever the policy",
  !d("conversation", ALLOW) && !d("listing_intake", ALLOW) && !decideBatchDataAccess({ brokerageId: "b-1", purpose: "bulk_export" as Purpose }, ALLOW).allowed)
check("resolveBatchDataAccess honours an injected policy and reads none for dnc / ineligible purposes",
  (await resolveBatchDataAccess({ brokerageId: "b-1", purpose: "acquisition" }, { policy: NO_OPT })).allowed === false
  && (await resolveBatchDataAccess({ purpose: "dnc" })).allowed === true
  && (await resolveBatchDataAccess({ brokerageId: "b-1", purpose: "conversation" })).allowed === false)
check("the facts rung's own gate is unchanged (isBatchDataRungAllowed: acquisition needs tier + opt-in; listing_intake never)",
  rail.isBatchDataRungAllowed("acquisition", ALLOW) && !rail.isBatchDataRungAllowed("acquisition", NO_OPT) && !rail.isBatchDataRungAllowed("listing_intake", ALLOW))

// Source census: who imports BatchData, and does the reach pass the gate?
const BD_IMPORT = /["']@\/lib\/external\/batchdata-[a-z-]+["']|["']@\/lib\/batchdata-client["']|["']\.\/batchdata-[a-z-]+["']|["']@\/lib\/external["']/
// batchDataPreferMcp is generic — `batchDataPreferMcp<T>(` — so the reach token admits a type argument
// (the first run reported the rail and public-record-preload as NOT reaching: the finder was blind).
const BD_REACH = /callBatchDataMcp\(|batchDataPreferMcp(?:<[^(]*?>)?\(|skipTraceBatchDataV3Batch\(|enrichPropertyDatasetsBatchData\(|fetchIncrementalPropertySearch\(|checkDncStatus\(|checkTcpaStatus\(|verifyPhone\(|searchProperties\(|fetchMotivatedSellers\(|enrichPropertyWithBatchData\(|fetchBatchDataComps\(|investorBuybox\w+\(|verifyAddressBatchData\(|fetchBatchRankPropensity\(|lookupBatchDataPropertiesByIds\(|reverseSkipTraceBatchData\(|new BatchDataClient\(/
const GATE = /resolveBatchDataAccess\(/
const GATED = [
  "lib/lead-pipeline/enrichment-orchestrator.ts",
  "lib/buyer-search/investor-offmarket-runner.ts",
  "lib/compliance/phone-scrub-runner.ts",
  "lib/communication/tcpa-gate.ts",
  "lib/ai-isa/property-lookup-rail.ts", // the facts rung, behind isBatchDataRungAllowed
  // Lane 81B — the six former blind spots that still reach BatchData, now gated (purpose
  // "valuation" for the staff analytics lane, "acquisition" for the lead/investor lanes).
  "lib/cma/comp-provider.ts",
  "lib/avm/provider-chain.ts",
  "lib/agentic-os/deal-investigator.ts",
  "lib/offers/public-record-preload.ts",
  "app/actions/investor-buybox-preview.ts",
  "app/actions/lead-intelligence.ts",
  // Wave 82 lane A — the reverse skip trace wrapper (person-keyed, purpose "skip_trace").
  "lib/enrichment/reverse-skip-trace.ts",
]
// (a) transports / registries / probes / re-exports — they ARE the seam, not a caller.
const TRANSPORT = new Set([
  "lib/external/batchdata-client.ts", "lib/external/batchdata-mcp.ts", "lib/external/batchdata-ai-tools.ts",
  "lib/external/batchdata-batchrank.ts", "lib/external/batchdata-seller-signals.ts", "lib/external/index.ts", "lib/batchdata-client.ts",
  "lib/ai-isa/batchdata-isa-tools.ts", // persona DNC registry, tier-gated by its own registry (test:batchdata-isa-tools)
  "lib/platform/go-live-readiness.ts", // connectivity probe
  "app/api/admin/billing/batchdata-wallet/route.ts", // wallet balance read
  "app/api/internal/ai-chat/route.ts", // mounts the tier-gated registry, no direct reach
  "lib/cma/comp-supplement-cache.ts", // type-only import
])
// (b) scraper lanes — FROZEN (wave 80): reachability proven by vercel.json / cron-dispatch, not this proof.
const SCRAPER_LANE = new Set([
  "app/api/cron/lead-scraping/route.ts", "app/api/webhooks/batchdata-smart-search/route.ts",
  "lib/kernel/listings-batchdata-feed.ts", "lib/kernel/intent-campaign.ts", "lib/kernel/neighbor-farm.ts",
  "lib/lead-pipeline/pipeline-processor.ts",
  // (lane 84C: lib/lead-pipeline/promotion-address-verification.ts left this list — the file is
  // deleted with the wave-14 address anchor; its verifyAddressBatchData reach went with it.)
  "app/api/cron/permit-signal-scan/route.ts", // cron: permit → seller-signal scan
  "app/actions/admin/run-scrape-test.ts", "app/api/admin/scrape-test/route.ts", // admin dry-run of a scrape source
])
// (d) published blind spots — direct reaches not yet migrated. SHRINK-ONLY. Lane 81B struck all
// eight wave-80 entries: six are GATED above; app/actions/calculators.ts was repointed to the rail
// (a customer conversation) and app/actions/ai-predictions.ts's dead `new BatchDataClient()` was
// deleted, so neither imports BatchData any more (scripts/provider-cost-routing-guard.ts holds each).
const BLIND_SPOTS = new Set<string>([])
const importers = CORPUS.filter((p) => BD_IMPORT.test(stripped(p)) && (BD_REACH.test(blankStrings(stripped(p))) || /BatchData/.test(stripped(p))))
const gatedOk: string[] = [], gatedBad: string[] = [], unknown: string[] = []
for (const p of importers) {
  if (TRANSPORT.has(p) || SCRAPER_LANE.has(p) || BLIND_SPOTS.has(p)) continue
  if (GATED.includes(p)) {
    const src = blankStrings(stripped(p))
    // The rail DEFINES its BatchData rung as a function above the ladder loop and INVOKES it only
    // after isBatchDataRungAllowed — so for the rail the gate must precede the rung INVOCATION
    // (`rungs[rung](req)`), not the rung's definition. Every other gated file gates inline.
    const isRail = p === "lib/ai-isa/property-lookup-rail.ts"
    const gate = isRail ? /isBatchDataRungAllowed\(req\.purpose, policy\)/ : GATE
    const reach = isRail ? /rungs\[rung\]\(req\)/ : BD_REACH
    const gi = src.search(gate), ri = src.search(reach)
    const railShape = !isRail || (/batchdata: batchDataRung,/.test(src) && BD_REACH.test(src))
    if (gi >= 0 && ri >= 0 && gi < ri && railShape) gatedOk.push(p); else gatedBad.push(`${p} (gate@${gi} reach@${ri})`)
    continue
  }
  unknown.push(p)
}
console.log(`  denominator: ${CORPUS.length} files under app/ lib/ · ${importers.length} import a BatchData module · transport ${TRANSPORT.size} · scraper-lane ${SCRAPER_LANE.size} · gated ${GATED.length} · blind spots ${BLIND_SPOTS.size}`)
for (const b of BLIND_SPOTS) console.log(`     · blind spot (direct reach, not migrated): ${b}`)
check(`every GATED caller calls resolveBatchDataAccess( BEFORE its first BatchData reach in stripped+blanked source (${gatedOk.length}/${GATED.length})`, gatedBad.length === 0 && gatedOk.length === GATED.length, gatedBad.join("; "))
check("NO production file reaches BatchData outside the transport / scraper-lane / gated / published-blind-spot sets (shrink-only)", unknown.length === 0, unknown.join(", "))
const missingGated = GATED.filter((p) => !importers.includes(p))
check("every GATED file is still a real BatchData importer (a gate on a file that no longer reaches BatchData would be a stale claim)", missingGated.length === 0, missingGated.join(", "))
const staleBlind = [...BLIND_SPOTS].filter((p) => !importers.includes(p))
check("every published blind spot still reaches BatchData directly (a stale entry must be struck, not carried) — the list is EMPTY since lane 81B", staleBlind.length === 0 && BLIND_SPOTS.size === 0, staleBlind.join(", "))
check("POSITIVE CONTROL: a fixture that reaches BatchData with no gate IS flagged by the same predicates",
  (() => { const fx = `import { skipTraceBatchDataV3Batch } from "@/lib/external/batchdata-client"\nawait skipTraceBatchDataV3Batch([])`; return BD_IMPORT.test(fx) && BD_REACH.test(blankStrings(fx)) && !GATE.test(fx) })())
const orchSrc = blankStrings(stripped("lib/lead-pipeline/enrichment-orchestrator.ts"))
check("enrichment-orchestrator: the property-dataset step is purpose 'acquisition' and the V3 skip trace (FIRST provider since 81B) is purpose 'skip_trace' (two gates, two purposes)",
  (orchSrc.match(/resolveBatchDataAccess\(/g) ?? []).length === 2 && /purpose: 'acquisition'/.test(stripped("lib/lead-pipeline/enrichment-orchestrator.ts")) && /purpose: 'skip_trace'/.test(stripped("lib/lead-pipeline/enrichment-orchestrator.ts")))
check("investor-offmarket-runner: purpose 'acquisition'; phone-scrub-runner + tcpa-gate: purpose 'dnc' and a refusal DEFERS (never a fabricated verdict)",
  /purpose: "acquisition"/.test(stripped("lib/buyer-search/investor-offmarket-runner.ts"))
  && /resolveBatchDataAccess\(\{ purpose: "dnc" \}\)[\s\S]{0,40}if \(!access\.allowed\) return \{ deferred: true/.test(stripped("lib/compliance/phone-scrub-runner.ts"))
  && /purpose: "dnc"/.test(stripped("lib/communication/tcpa-gate.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · one source vocabulary]")
const OLD_UNION = /"osint"\s*\|\s*"batchdata"\s*\|\s*"ai_estimate"/
const oldUnionFiles = CORPUS.filter((p) => OLD_UNION.test(stripped(p)))
const enrichSourceFiles = CORPUS.filter((p) => /\bEnrichSource\b/.test(blankStrings(stripped(p))))
check("the old 'osint'|'batchdata'|'ai_estimate' union is spelled NOWHERE under app/ lib/", oldUnionFiles.length === 0, oldUnionFiles.join(", "))
check("the EnrichSource type name is gone from app/ lib/ code", enrichSourceFiles.length === 0, enrichSourceFiles.join(", "))
check("POSITIVE CONTROL: the union scan DOES flag the old spelling", OLD_UNION.test(`source: "osint" | "batchdata" | "ai_estimate"`))
check("the rail exports PropertyLookupSource = PropertyLookupRung | 'ai_estimate' and facts.source is typed with it",
  /export type PropertyLookupSource = PropertyLookupRung \| "ai_estimate"/.test(railSrc) && /source: PropertyLookupSource/.test(railSrc))
check("listing-presentation-builder types propertyEnrichment.source from the rail's PropertyLookupSource",
  /source:\s*import\("@\/lib\/ai-isa\/property-lookup-rail"\)\.PropertyLookupSource/.test(lpbSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · AssessorSearch researched, not added]")
const AS = /ASSESSORSEARCH|assessorsearch\.com|connector:\s*["']assessorsearch["']/
const asFiles = CORPUS.filter((p) => AS.test(stripped(p)) && p !== "lib/kernel/manager-registry.ts")
check("no env read, connector or host for AssessorSearch under app/ lib/ (the registry entry records the verdict in prose)", asFiles.length === 0, asFiles.join(", "))
check("POSITIVE CONTROL: the scan DOES flag a fixture env read", AS.test(`process.env.ASSESSORSEARCH_API_KEY`))
check("the rail's public-records rung is still the Perplexity Sonar reader (lib/property/address-lookup.ts) and its documented cost stays below RentCast's",
  /lookupPropertyByAddress\(/.test(railSrc) && rail.PROPERTY_LOOKUP_RUNG_COST_USD.public_records.usd < rail.PROPERTY_LOOKUP_RUNG_COST_USD.rentcast.usd)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · persona / platform realism — the tools exist and the ladders reach a ROUTED model]")
const { OWNER_FOLLOW_UP_OFFERS, buildQualificationPrompt, PERSONA_QUESTION_GUIDE } = await import("../lib/ai-isa/qualification-playbook")
const cct = stripped("lib/ai-isa/customer-context-tools.ts")
const mounted = [...cct.matchAll(/out\.([a-z_]+) = build/g)].map((m) => m[1])
check(`the customer bundle mounts every one of the owner's five follow-ups (${OWNER_FOLLOW_UP_OFFERS.join(", ")}) + record_qualification + lookup_property_facts`,
  OWNER_FOLLOW_UP_OFFERS.every((t) => mounted.includes(t)) && mounted.includes("record_qualification") && mounted.includes("lookup_property_facts"), mounted.join(","))
check("the widget creates the PERSON through the one capture survivor (captureContact in capture-lead; contacts in intake) — the ISA never invents a second writer",
  /captureContact\(/.test(stripped("app/api/widget/capture-lead/route.ts")) && /\.from\('contacts'\)/.test(stripped("app/api/widget/intake/route.ts")))
// A routed call is `xRouted(` or the injectable-dep spelling the voice engine uses:
// `deps.generateTextRouted ?? (await import("@/lib/ai/models")).generateTextRouted`.
const ROUTED = /\b(?:streamText|generateText|generateObject)Routed\b/
// Each surface: WHERE the ladder is rendered into the system prompt, and WHERE that prompt meets a routed
// model call (the same file, or the ONE engine that consumes the prompt builder — named, never assumed).
const SURFACES: Array<{ prompt: string; routed: string; via?: RegExp }> = [
  { prompt: "app/api/widget/message/route.ts", routed: "app/api/widget/message/route.ts" },
  { prompt: "app/api/did/custom-llm/route.ts", routed: "app/api/did/custom-llm/route.ts" },
  { prompt: "app/api/internal/ai-chat/route.ts", routed: "app/api/internal/ai-chat/route.ts" },
  { prompt: "app/api/portal/ai-chat/route.ts", routed: "app/api/portal/ai-chat/route.ts" },
  { prompt: "lib/voice/reception-brain.ts", routed: "lib/voice/twilio-voice.ts", via: /from ["']\.\/reception-brain["']/ },
  { prompt: "lib/voice/platform-reception.ts", routed: "lib/voice/twilio-voice.ts", via: /from ["']\.\/platform-reception["']/ },
  { prompt: "lib/voice/platform-reception.ts", routed: "app/api/platform/prospect-chat/route.ts", via: /buildPlatformReceptionPrompt\(/ },
]
for (const s of SURFACES) {
  const p = stripped(s.prompt), r = stripped(s.routed)
  check(`${s.prompt}: renders buildQualificationPrompt( → ${s.routed} meets a ROUTED model call${s.via ? " (consumer named in source)" : ""}`,
    /buildQualificationPrompt\(/.test(p) && ROUTED.test(r) && (!s.via || s.via.test(r)))
}
check("POSITIVE CONTROL: the routed scan does NOT accept a bare provider call", !ROUTED.test(`await generateText({ model })`) && ROUTED.test(`await generateTextRouted({ feature: "x" })`))
check("the seller ladder ends on the offer and the prompt the routed model reads names the home-value review as a CALLBACK with no number and the no-obligation listing appointment",
  (() => { const p = buildQualificationPrompt({ surface: "widget", persona: "seller" }); return /schedule_home_value_review/.test(p) && /book_listing_appointment/.test(p) && /never you|never the AI|AGENT states/i.test(p) && /no.obligation/i.test(p) })())
check("a customer prompt never tells the model to state a value and never carries a 30/60/90 timeline (buckets 1-3 / 3-6 / 6-12)",
  (["buyer", "seller", "investor", "renter", "relocation", "sphere"] as const).every((persona) => { const p = buildQualificationPrompt({ surface: "widget", persona }); return !/30\/60\/90|30-60-90/.test(p) && /1-3|3-6|6-12/.test(p) }))
const { PLATFORM_PROSPECT_TOOL_NAMES } = await import("../lib/platform/prospect-agent-tools")
check("the platform sales agent has the same shape: save_prospect (creates the prospect) + book_demo_appointment + schedule_prospect_callback + send_signup_link + request_human_handoff",
  ["save_prospect", "book_demo_appointment", "schedule_prospect_callback", "send_signup_link", "request_human_handoff"].every((t) => (PLATFORM_PROSPECT_TOOL_NAMES as readonly string[]).includes(t)))
check("the platform guide's ladder is rendered on platform_reception and the prospect-chat route is routed",
  buildQualificationPrompt({ surface: "platform_reception" }).includes("THE LADDER") && ROUTED.test(stripped("app/api/platform/prospect-chat/route.ts")))
check("denominator: six persona guides loaded", Object.keys(PERSONA_QUESTION_GUIDE).length === 6)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 7 · registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:enrichment-one-rail → this file", pkg.scripts["test:enrichment-one-rail"] === "tsx scripts/enrichment-one-rail-guard.ts")
const guardLine = pkg.scripts.guard ?? ""
check("the guard chain runs it AFTER test:scrapers (ordering only)",
  guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:enrichment-one-rail") > guardLine.indexOf("npm run test:scrapers"))
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
const dom = MAINTENANCE_DOMAINS.enrichment_one_rail
check("MAINTENANCE_DOMAINS.enrichment_one_rail names this proof under ai_isa with coOwners listing_concierge / data_steward / shopping_agent / compliance_officer (the prose names each)",
  dom?.proof === "test:enrichment-one-rail" && dom?.manager === "ai_isa" && [...(dom?.coOwners ?? [])].sort().join(",") === "compliance_officer,data_steward,listing_concierge,shopping_agent" && /AssessorSearch/i.test(dom?.what ?? ""))

// ─────────────────────────────────────────────────────────────────────────────
// Layer 8 — lane 85C (owner verbatim: "add marital status,household income, net worth or credit on
// enrichment and add location for contact enrichment."): the four HOUSEHOLD FINANCIALS ride the one
// rail through ONE mapper; contact enrichment merges onto that mapper and sends a location.
console.log("\n[Layer 8a · household financials — the ONE mapper, pure]")
const cmap = await import("../lib/lead-pipeline/enrichment-column-map")
const {
  HOUSEHOLD_FINANCIAL_FIELDS, DEMOGRAPHIC_PROFILE_FIELDS, MODELED_CREDIT_BASIS,
  householdFinancialsFromBatchData, householdFinancialsFromVersium, normalizeModeledCreditBand, normalizeMaritalStatus,
  mergeHouseholdFinancials, carryForwardHouseholdFinancials, householdFinancialContactColumns, missingHouseholdFinancials,
  peopleDataProfileToContactColumns, batchDataPropertyEnrichmentToLeadColumns, batchDataPropertyEnrichmentToContactColumns,
  buildPeopleDataProfile, demographicsFromProfile,
} = cmap
const { SCHEMA_SNAPSHOT } = await import("./schema-snapshot")
const BD_ROW = {
  address: { street: "1234 N Lamar Blvd", city: "Austin", state: "TX", zip: "78756" },
  owner: { firstName: "Ana", lastName: "Reyes" },
  demographics: { maritalStatus: "Inferred Married", income: "$100,000 - $149,999", netWorth: "$250,000 - $499,999", creditRating: "700-749" },
}
const VERSIUM_ROW = { "Marital Status": "Married", "Household Income": "$150,000-199,999", "Estimated Net Worth": "> $499,999", "Credit Rating": "700-749" }
const bdHf = householdFinancialsFromBatchData(BD_ROW)
check("BatchData demographic dataset → marital_status / household_income / net_worth (field names from list_property_dataset_fields)",
  bdHf.marital_status === "married" && bdHf.household_income === "$100,000 - $149,999" && bdHf.net_worth === "$250,000 - $499,999", JSON.stringify(bdHf))
check("BatchData NEVER produces a credit band (it sells none) — even a stray credit-looking field on the row is ignored", !("credit_score_range" in bdHf))
check("a row carrying the ALREADY-MAPPED block (raw_data from normalizeBatchDataProperty) reads the same, credit still refused",
  JSON.stringify(householdFinancialsFromBatchData({ householdFinancials: { ...bdHf, credit_score_range: "700-749" } })) === JSON.stringify(bdHf))
const vHf = householdFinancialsFromVersium(VERSIUM_ROW)
check("Versium financial append → all four, the credit band as a band", vHf.credit_score_range === "700-749" && vHf.net_worth === "> $499,999" && vHf.marital_status === "married" && vHf.household_income === "$150,000-199,999", JSON.stringify(vHf))
check("credit is a BAND: an exact score is bucketed, never stored (712 → 700-749; 805 → 800+; 520 → <550)",
  normalizeModeledCreditBand(712) === "700-749" && normalizeModeledCreditBand("805") === "800+" && normalizeModeledCreditBand("520") === "<550")
check("POSITIVE CONTROL: the bucketer changes an exact score (a no-op normalizer would store 712)", normalizeModeledCreditBand("712") !== "712")
check("band spellings normalize to one vocabulary; garbage / out-of-range → null",
  normalizeModeledCreditBand("700 to 749") === "700-749" && normalizeModeledCreditBand("> 799") === "800+" && normalizeModeledCreditBand("under 550") === "<550"
  && normalizeModeledCreditBand("EXCELLENT") === "excellent" && normalizeModeledCreditBand("999") === null && normalizeModeledCreditBand("abc") === null && normalizeModeledCreditBand(true) === null)
check("marital status: one vocabulary across word and list codes (M/A → married, S/B → single); unknown → null",
  normalizeMaritalStatus("M") === "married" && normalizeMaritalStatus("A") === "married" && normalizeMaritalStatus("B") === "single"
  && normalizeMaritalStatus("Never Married") === "single" && normalizeMaritalStatus("Divorced") === "divorced" && normalizeMaritalStatus("Unknown") === null)
const merged = mergeHouseholdFinancials({ provider: "peopledata", age: 41 }, vHf, "versium", { capturedAt: "2026-09-26T00:00:00Z" })
check("the ONE merge writes the reader keys at top level + provenance per field + the MODELED credit basis",
  HOUSEHOLD_FINANCIAL_FIELDS.every((f) => typeof merged[f] === "string") && merged.household_financials?.sources?.credit_score_range === "versium"
  && merged.household_financials?.credit_basis === MODELED_CREDIT_BASIS && merged.age === 41)
const kept = mergeHouseholdFinancials({ household_income: "$100,000 - $149,999" }, vHf, "versium", { prefer: "existing" })
check("prefer 'existing': the paid rung never overwrites a value the free rung already supplied", kept.household_income === "$100,000 - $149,999" && kept.credit_score_range === "700-749")
const carried = carryForwardHouseholdFinancials(buildPeopleDataProfile({ fullName: "Ana Reyes", age: 41 } as any), merged)
check("a wholesale profile REPLACEMENT (the drain) carries the older household financials + provenance forward",
  HOUSEHOLD_FINANCIAL_FIELDS.every((f) => carried[f] === merged[f]) && carried.household_financials?.sources?.credit_score_range === "versium")
check("POSITIVE CONTROL: without the carry, the rebuilt PDL profile has none of the four (PDL sells none)",
  HOUSEHOLD_FINANCIAL_FIELDS.every((f) => !(f in buildPeopleDataProfile({ fullName: "Ana Reyes", age: 41 } as any))))
const cols = householdFinancialContactColumns(merged)
check("contacts columns: marital_status / household_income / net_worth_range / credit_score_range — every one a LIVE contacts column (schema-snapshot)",
  JSON.stringify(Object.keys(cols).sort()) === JSON.stringify(["credit_score_range", "household_income", "marital_status", "net_worth_range"])
  && Object.keys(cols).every((c) => (SCHEMA_SNAPSHOT.contacts ?? []).includes(c)), JSON.stringify(cols))
{
  const viaContactMapper = peopleDataProfileToContactColumns(merged) as Record<string, unknown>
  check("the contact mapper (peopleDataProfileToContactColumns) emits the SAME four columns through the same function",
    Object.keys(cols).every((c) => viaContactMapper[c] === (cols as Record<string, string>)[c]))
}
check("the mapper never writes the agent-tracked credit_score_band (a different column, credit-copilot.ts)", !("credit_score_band" in peopleDataProfileToContactColumns(merged)))
check("RAW LEADS carry them: all four are DEMOGRAPHIC_PROFILE_FIELDS, so normalized_preview.demographics keeps them",
  HOUSEHOLD_FINANCIAL_FIELDS.every((f) => (DEMOGRAPHIC_PROFILE_FIELDS as readonly string[]).includes(f)) && demographicsFromProfile(merged).credit_score_range === "700-749")
const propE = { ok: true, equityPercent: 40, estimatedValue: 500000, mortgageBalance: 1, foreclosureStatus: null, lastDeedType: null, ownerOccupied: true, householdFinancials: bdHf }
const leadPatch = batchDataPropertyEnrichmentToLeadColumns(propE, { provider: "peopledata" }) as any
const contactPatch = batchDataPropertyEnrichmentToContactColumns(propE, null) as any
check("Step 6f property lookup: LEADS get them in enrichment_profile (no lead column); CONTACTS get the first-class columns",
  leadPatch.enrichment_profile?.marital_status === "married" && !("marital_status" in leadPatch) && contactPatch.net_worth_range === "$250,000 - $499,999" && contactPatch.marital_status === "married")
check("missingHouseholdFinancials names the gaps (drives the paid rung)", JSON.stringify(missingHouseholdFinancials({ ...bdHf })) === JSON.stringify(["credit_score_range"]))

console.log("\n[Layer 8b · writers — already-bought data first, the paid rung only for a gap]")
const bdc = await import("../lib/external/batchdata-client")
const normalized = bdc.normalizeBatchDataProperty(BD_ROW, "distressed")
check("acquisition pull: normalizeBatchDataProperty KEEPS the demographic dataset on the record (it used to drop it) → raw_data",
  normalized.householdFinancials?.marital_status === "married" && normalized.householdFinancials?.net_worth === "$250,000 - $499,999")
const bdcSrc = stripped("lib/external/batchdata-client.ts")
const enrichFn = bdcSrc.slice(bdcSrc.indexOf("export async function enrichPropertyDatasetsBatchData"), bdcSrc.indexOf("export interface BatchDataLookupResult"))
check("the drain's Step 6f lookup names \"demographic\" in the SAME request and maps it through the ONE mapper",
  /dataset: \[[^\]]*"demographic"[^\]]*\]/.test(enrichFn) && /householdFinancialsFromBatchData\(prop\)/.test(enrichFn))
const ppSrc = stripped("lib/lead-pipeline/pipeline-processor.ts")
check("raw path: pipeline-processor merges raw_data's household financials onto the demographic profile BEFORE the raw-row write and the lead insert",
  /householdFinancialsFromBatchData\(rec\.raw_data\)/.test(ppSrc) && ppSrc.indexOf("householdFinancialsFromBatchData(rec.raw_data)") < ppSrc.indexOf("demographics: demographicsFromProfile(enriched.peopleDataProfile)")
  && ppSrc.indexOf("householdFinancialsFromBatchData(rec.raw_data)") > ppSrc.indexOf("await enrichWithPeopleData({"))
const sigSrc = stripped("lib/external/batchdata-seller-signals.ts")
const probe = sigSrc.slice(sigSrc.indexOf("export async function ingestBatchDataSellerSignals"))
check("seller-signal probe: captures AFTER the exact-address refusal and BEFORE the no-signal continue",
  probe.indexOf("probesAddressMismatch++") < probe.indexOf("householdFinancialsFromBatchData(res.data)")
  && probe.indexOf("householdFinancialsFromBatchData(res.data)") < probe.indexOf("if (derived.length === 0)"))
check("both probe callers hand it the one writer (cron + lead-desk action)",
  /persistHouseholdFinancials: \(captures\) => persistHouseholdFinancialCaptures\(\{ supabase, brokerageId, captures \}\)/.test(stripped("app/api/cron/permit-signal-scan/route.ts"))
  && /persistHouseholdFinancials:[\s\S]{0,160}persistHouseholdFinancialCaptures\(\{ supabase, brokerageId: auth\.brokerageId, captures \}\)/.test(stripped("app/actions/lead-intelligence.ts")))
{
  // Run the probe against a double that RESOLVES (supabase-js shape) — one lead at the matching
  // address, one contact whose provider row is a NEIGHBOUR (positive control for the address refusal).
  const sig = await import("../lib/external/batchdata-seller-signals")
  const fake = (rows: Record<string, any[]>) => ({
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, is: () => q, not: () => q, limit: () => q,
        insert: (r: any) => ({ select: () => Promise.resolve({ data: (Array.isArray(r) ? r : [r]).map((_: unknown, i: number) => ({ id: `s${i}` })), error: null }) }),
        then: (res: any) => Promise.resolve({ data: rows[table] ?? [], count: 0, error: null }).then(res),
      }
      return q
    },
  })
  const got: any[] = []
  const r = await sig.ingestBatchDataSellerSignals({
    supabase: fake({ leads: [{ id: "lead-1", address: "1234 N Lamar Blvd", city: "Austin", state: "TX", zip_code: "78756" }], contacts: [{ id: "contact-1", address: "99 Other St", city: "Austin", state: "TX", zip_code: "78756" }] }),
    brokerageId: "b-1", dayIso: "2026-09-26",
    lookup: async () => ({ ok: true, status: 200, data: BD_ROW as any, error: null }),
    persistHouseholdFinancials: async (caps) => { got.push(...caps); return { written: caps.length, errors: [] } },
  })
  check("probe run: the matching lead's household is captured and handed to the writer; the NEIGHBOUR's is refused (positive control)",
    r.householdFinancialsCaptured === 1 && r.householdFinancialsWritten === 1 && got.length === 1 && got[0].entity === "lead" && got[0].id === "lead-1"
    && got[0].financials.marital_status === "married" && r.probesAddressMismatch === 1, JSON.stringify({ c: r.householdFinancialsCaptured, w: r.householdFinancialsWritten, m: r.probesAddressMismatch, e: r.errors }))
}
{
  const hfm = await import("../lib/enrichment/household-financials")
  // persist: tenant-anchored read + write, errors READ, zero-row update reported (CLAUDE.md §3).
  const calls: Array<{ table: string; op: string; filters: Record<string, unknown>; patch?: any }> = []
  const store: Record<string, any> = { "leads:lead-1": { id: "lead-1", enrichment_profile: { provider: "peopledata", age: 41 } }, "contacts:c-1": { id: "c-1", enrichment_profile: null } }
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      let op = "select", patch: any
      const q: any = {
        select: () => q,
        update: (p: any) => { op = "update"; patch = p; return q },
        eq: (c: string, v: unknown) => { filters[c] = v; return q },
        maybeSingle: () => { calls.push({ table, op, filters: { ...filters } }); return Promise.resolve({ data: store[`${table}:${filters.id}`] ?? null, error: null }) },
        then: (res: any) => { calls.push({ table, op, filters: { ...filters }, patch }); const hit = store[`${table}:${filters.id}`]; return Promise.resolve({ data: hit ? [{ id: hit.id }] : [], error: null }).then(res) },
      }
      return q
    },
  }
  const out = await hfm.persistHouseholdFinancialCaptures({ supabase: db, brokerageId: "b-1", captures: [
    { entity: "lead", id: "lead-1", financials: bdHf }, { entity: "contact", id: "c-1", financials: bdHf }, { entity: "contact", id: "gone", financials: bdHf },
  ] })
  const leadW = calls.find((c) => c.table === "leads" && c.op === "update"), conW = calls.find((c) => c.table === "contacts" && c.op === "update" && c.filters.id === "c-1")
  check("persist: lead → enrichment_profile only (prior keys kept); contact → the four-column mapper + enrichment_profile",
    leadW?.patch?.enrichment_profile?.marital_status === "married" && leadW?.patch?.enrichment_profile?.age === 41 && !("marital_status" in (leadW?.patch ?? {}))
    && conW?.patch?.net_worth_range === "$250,000 - $499,999" && conW?.patch?.enrichment_profile?.household_financials?.sources?.marital_status === "batchdata")
  check("persist: every read AND write is anchored on the caller's brokerage (§4)", calls.every((c) => c.filters.brokerage_id === "b-1"))
  check("persist: a record not found in this brokerage is REPORTED, never counted as written", out.written === 2 && out.errors.length === 1 && /not found in this brokerage/.test(out.errors[0]), JSON.stringify(out))

  // The paid rung, injected (zero network).
  const meters: any[] = []
  const deps = (over: Partial<import("../lib/enrichment/household-financials").AppendModeledCreditDeps> = {}) => ({
    append: async () => ({ data: vHf, cost: 0.05 }),
    checkBudget: async () => ({ allowed: true }),
    meter: async (p: any) => { meters.push(p) },
    ...over,
  })
  const complete = await hfm.appendModeledCredit({ profile: merged, identity: {}, brokerageId: "b-1", lane: "t", deps: deps() })
  check("paid rung: a profile with all four is NEVER asked (no spend)", !complete.asked && complete.skipped === "complete" && meters.length === 0)
  const maritalOnly = await hfm.appendModeledCredit({ profile: { household_income: "x", net_worth: "y", credit_score_range: "700-749" }, identity: {}, brokerageId: "b-1", lane: "t", deps: deps() })
  check("paid rung: a MARITAL-only gap is not asked (Versium's financial output does not return it)", !maritalOnly.asked && meters.length === 0)
  const refused = await hfm.appendModeledCredit({ profile: { ...bdHf }, identity: {}, brokerageId: "b-1", lane: "t", deps: deps({ checkBudget: async () => ({ allowed: false }) }) })
  check("paid rung: the vendor budget gate refuses BEFORE the call (no ask, no booking)", !refused.asked && refused.skipped === "budget" && meters.length === 0)
  const noTenant = await hfm.appendModeledCredit({ profile: { ...bdHf }, identity: {}, brokerageId: null, lane: "t", deps: deps() })
  check("paid rung: no tenant → no spend (never charged to nobody)", !noTenant.asked && noTenant.skipped === "no_brokerage")
  const filled = await hfm.appendModeledCredit({ profile: { ...bdHf }, identity: {}, brokerageId: "b-1", lane: "t", deps: deps() })
  check("paid rung: fills ONLY the gap (credit), keeps BatchData's income, books vendor 'versium' at the client's cost on the platform ledger",
    filled.asked && JSON.stringify(filled.filled) === JSON.stringify(["credit_score_range"]) && filled.profile.household_income === bdHf.household_income
    && meters.length === 1 && meters[0].vendorName === "versium" && meters[0].cost === 0.05 && filled.profile.household_financials?.credit_basis === MODELED_CREDIT_BASIS)
  const vc = await import("../lib/external/versium-client")
  const { VENDOR_PRICING: VP } = await import("../lib/vendor-governance/cost-normalizer")
  check("one price: VENDOR_PRICING.versium equals the client's per-match constant; a no-match is $0",
    VP.versium?.costPerUnit === vc.VERSIUM_FINANCIAL_MATCH_COST_USD && vc.VERSIUM_NO_MATCH_COST_USD === 0)
  check("Versium is asked only with an input shape it accepts (name+city/state, email, phone, postal); nothing else → no call",
    vc.versiumQueryFor({ firstName: "Ana", lastName: "Reyes", city: "Austin", state: "TX" })?.first === "Ana" && vc.versiumQueryFor({ firstName: "Ana", lastName: "Reyes" }) === null
    && vc.versiumQueryFor({ phone: "+1 (512) 555-0100" })?.phone === "5125550100")
  const noKey = await vc.appendVersiumFinancial({ email: "a@b.co" })
  check("fail closed: no VERSIUM_API_KEY → no network, $0, skipped 'unconfigured'", process.env.VERSIUM_API_KEY ? true : (noKey.skipped === "unconfigured" && noKey.cost === 0))
  const order = Object.values(hfm.HOUSEHOLD_FINANCIAL_SOURCES)
  check("provider order is data, CHEAPEST FIRST per field; the credit band has exactly one (modeled) source",
    order.every((list) => list.every((e, i) => i === 0 || list[i - 1].unitCostUsd <= e.unitCostUsd))
    && hfm.HOUSEHOLD_FINANCIAL_SOURCES.credit_score_range.length === 1 && hfm.HOUSEHOLD_FINANCIAL_SOURCES.credit_score_range[0].provider === "versium"
    && hfm.HOUSEHOLD_FINANCIAL_SOURCES.marital_status.every((e) => e.unitCostUsd === 0))
}
const orch = stripped("lib/lead-pipeline/enrichment-orchestrator.ts")
check("the drain carries prior household financials forward, then asks the paid rung, BEFORE the entity write",
  orch.indexOf("carryForwardHouseholdFinancials(profile,") > 0 && orch.indexOf("carryForwardHouseholdFinancials(profile,") < orch.indexOf("appendModeledCredit({")
  && orch.indexOf("appendModeledCredit({") < orch.indexOf("...peopleDataProfileToLeadColumns(profile),"))
check("the persona builder reads marital status / income / net worth from the PROFILE (the PDL object never carries them) — and NOT the credit band (wave 86: a persona feeds outbound copy)",
  /maritalStatus: profile\.marital_status/.test(orch) && /netWorth: profile\.net_worth/.test(orch) && /householdIncome: profile\.household_income/.test(orch)
  && !/credit_score_range|creditScoreRange/.test(orch))

console.log("\n[Layer 8c · contact enrichment — ONE mapper, and it sends a location]")
const cec = stripped("lib/enrichment/contact-enrichment-core.ts")
const cecEnrich = cec.slice(cec.indexOf("export async function enrichContactRecord"), cec.indexOf("export async function runLifeChangeCheck"))
check("the contact read selects the location it sends (city, state, zip_code) + the prior profile",
  /\.select\("[^"]*\bcity\b[^"]*\bstate\b[^"]*\bzip_code\b[^"]*enrichment_profile[^"]*"\)/.test(cecEnrich))
const SENDS_LOCATION = /peopleData\.enrich\(\{[\s\S]{0,400}city: \(contact\.city[\s\S]{0,120}state: \(contact\.state[\s\S]{0,120}postalCode: \(contact\.zip_code/
check("contact enrichment SENDS city / state / ZIP to PeopleData", SENDS_LOCATION.test(cecEnrich))
check("POSITIVE CONTROL: the pre-85C call (name/email/phone only) is flagged by the same predicate",
  !SENDS_LOCATION.test(`const personData = await peopleData.enrich({\n firstName: contact.first_name as string,\n lastName: contact.last_name as string,\n email: x, phone: y,\n })`))
const pdlc = stripped("lib/external/peopledata-client.ts")
const { pdlLocationFrom } = await import("../lib/external/peopledata-client")
check("the client turns them into PDL's qualifiers: location 'City, ST' + postal_code (SDK param) — and nothing when absent",
  pdlLocationFrom({ city: "Austin", state: "TX" }) === "Austin, TX" && pdlLocationFrom({ city: " ", state: null }) === undefined
  && /address: pdlLocationFrom\(data\)/.test(pdlc) && /postalCode: data\.postalCode/.test(pdlc) && /postalCode: params\.postalCode/.test(pdlc)
  && /postal_code: params\.postalCode/.test(stripped("lib/providers/peopledata/client.ts")))
check("contact enrichment maps through the survivor: buildPeopleDataProfile → peopleDataProfileToContactColumns (+ the carry and the paid rung)",
  /buildPeopleDataProfile\(personData\)/.test(cecEnrich) && /peopleDataProfileToContactColumns\(profile\)/.test(cecEnrich) && /appendModeledCredit\(\{/.test(cecEnrich) && /carryForwardHouseholdFinancials\(/.test(cecEnrich))
// NO SECOND MAPPER: a PDL person object's camelCase field written to a snake_case column outside the
// mapper. The receivers are the names a PDL result travels under in this repo. `occupation` is left
// out ON PURPOSE: it is also a PersonaFacts key (the orchestrator's persona facts read
// `occupation: enriched.currentTitle` — a reader's input, not a column write; the first run flagged it).
const SECOND_MAPPER = /\b(?:age_range|gender|marital_status|household_income|net_worth(?:_range)?|credit_score_range|home_owner_status|home_value_estimate|linkedin_url|facebook_url|twitter_url)\s*:\s*(?:personData|enriched|pdl\w*|person|peopleData\w*)\.(?:ageRange|gender|maritalStatus|householdIncome|netWorth|creditScoreRange|homeOwnerStatus|homeValue|linkedinUrl|facebookUrl|twitterUrl)\b/
const MAPPER_FILE = "lib/lead-pipeline/enrichment-column-map.ts"
const secondMappers = CORPUS.filter((p) => p !== MAPPER_FILE && SECOND_MAPPER.test(blankStrings(stripped(p))))
check(`NO second PeopleData → column mapper anywhere under app/ lib/ (denominator ${CORPUS.length} files; the one mapper excluded)`, secondMappers.length === 0, secondMappers.join(", "))
check("POSITIVE CONTROL: the deleted contact-enrichment literal IS flagged", SECOND_MAPPER.test(`enrichmentData = { marital_status: personData.maritalStatus, household_income: personData.householdIncome }`))
check("the only PDL field contact enrichment still reads directly is its own confidence column", !/personData\.(?!enrichmentConfidence\b)\w+/.test(blankStrings(cecEnrich)))

console.log("\n[Layer 8d · FCRA / display — the card SHOWS the modeled estimates; the credit band never reaches outbound / eligibility / pricing / steering]")
// THE RULE (owner, wave 86): "add because most audience or info will be used from the contact card" —
// net worth + the credit band sit on the agent contact card beside income + marital status, labelled
// "modeled estimate"; the credit band stays out of outbound copy, eligibility, pricing and steering.
const panel = stripped("app/crm/contacts/[contactId]/components/enrichment-panel.tsx")
const insights = stripped("app/actions/contact-enrichment.ts")
const insightsFn = insights.slice(insights.indexOf("export async function getContactInsights"))
const LABELLED_MODELED = (field: string) => new RegExp(`\\["${field}",\\s*"[^"]*\\(modeled estimate\\)"\\]`)
check("the agent contact card LISTS net worth + the credit band, each labelled '(modeled estimate)'",
  LABELLED_MODELED("net_worth_range").test(panel) && LABELLED_MODELED("credit_score_range").test(panel))
check("POSITIVE CONTROL: a card entry WITHOUT the modeled-estimate label fails the same predicate",
  !LABELLED_MODELED("credit_score_range").test(`["credit_score_range", "Credit score"]`))
check("they sit BESIDE household income + marital status (the next entries in the card's field list)",
  panel.indexOf('["household_income"') > panel.indexOf('["marital_status"') && panel.indexOf('["net_worth_range"') > panel.indexOf('["household_income"')
  && panel.indexOf('["credit_score_range"') > panel.indexOf('["net_worth_range"') && panel.indexOf('["credit_score_range"') < panel.indexOf('["home_owner_status"'))
check("the card states in words that they are modeled marketing estimates, never for eligibility / pricing / what to show",
  /modeled marketing estimates, not a credit report/.test(read("app/crm/contacts/[contactId]/components/enrichment-panel.tsx")) && /never to decide eligibility, pricing, or which homes to show/.test(read("app/crm/contacts/[contactId]/components/enrichment-panel.tsx")))
check("the card's door selects both columns and returns them ONLY to a back-office seat (§5 — lenders / vendors / contacts see no financials)",
  /net_worth_range, credit_score_range/.test(insightsFn) && /\.\.\.\(isCrmContactStaff\(ctx\.userType\) \? \{\s*net_worth_range: contact\.net_worth_range,\s*credit_score_range: contact\.credit_score_range,\s*\} : \{\}\)/.test(insightsFn))
{
  const { isCrmContactStaff } = await import("../lib/auth/crm-contact-staff")
  check("the seat gate admits back-office staff and refuses vendor / lender / contact / an unresolved seat",
    isCrmContactStaff("agent") && isCrmContactStaff("broker") && !isCrmContactStaff("vendor") && !isCrmContactStaff("lender") && !isCrmContactStaff("contact") && !isCrmContactStaff(""))
}

// THE MODELED-CREDIT FIREWALL — a census over comment-stripped source (a tombstone naming the band is
// not a reader, CLAUDE.md §2). THREE shapes of a read: (1) an identifier in CODE (string-blanked, so
// prose inside a registry string is not a reader — the first run flagged manager-registry.ts and
// cost-normalizer.ts's `notes` prose, both wrong); (2) a COLUMN-LIST string literal naming the column
// (`.select("id, credit_score_range")`, a column array) — identifiers, commas, colons, arrows only, so
// prose never matches; (3) Versium's own field accessed by key (`r["Credit Rating"]`).
const CREDIT_IDENT = /\bcredit_score_range\b|\bcreditScoreRange\b/
const STRING_LITERAL = /(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g
const COLUMN_LIST = /^.[\w\s,.*:>()-]*.$/
const bandIn = (strippedSrc: string): boolean =>
  CREDIT_IDENT.test(blankStrings(strippedSrc))
  || (strippedSrc.match(STRING_LITERAL) ?? []).some((lit) => CREDIT_IDENT.test(lit) && COLUMN_LIST.test(lit))
  || /\[\s*["']Credit Rating["']\s*\]/.test(strippedSrc)
const CREDIT_BAND = { test: bandIn }
const CREDIT_BAND_PATH: Readonly<Record<string, string>> = {
  "lib/external/peopledata-client.ts": "provider adapter — types PDL's own field",
  "lib/external/versium-client.ts": "provider adapter — the credit-band provider",
  "lib/lead-pipeline/enrichment-column-map.ts": "THE mapper (band-only normalizer, merge, contact columns)",
  "lib/enrichment/household-financials.ts": "the paid rung + the provider order",
  "lib/privacy/contact-pii-redaction.ts": "DSR erasure",
  "app/actions/contact-enrichment.ts": "the contact card's door (back-office seats only)",
  "app/crm/contacts/[contactId]/components/enrichment-panel.tsx": "the agent contact card (labelled modeled)",
}
const outsidePath = CORPUS.filter((p) => !(p in CREDIT_BAND_PATH) && CREDIT_BAND.test(stripped(p)))
check(`FIREWALL: nothing outside the band's allowlisted path names the credit band — no outbound copy, eligibility, pricing, steering or persona reader (denominator ${CORPUS.length} app/ lib/ files; ${Object.keys(CREDIT_BAND_PATH).length} allowlisted)`,
  outsidePath.length === 0, outsidePath.join(", "))
check("POSITIVE CONTROL on the REAL tree: the census predicate SEES the band's real readers (the card door's select, the card, the mapper, DSR erasure)",
  ["app/actions/contact-enrichment.ts", "app/crm/contacts/[contactId]/components/enrichment-panel.tsx", "lib/lead-pipeline/enrichment-column-map.ts", "lib/privacy/contact-pii-redaction.ts"]
    .every((p) => CREDIT_BAND.test(stripped(p))))
check("FIREWALL: every allowlisted file exists (a retired name cannot sit in the list reading as enforced)",
  Object.keys(CREDIT_BAND_PATH).every((p) => existsSync(p)))
const EGRESS_OR_MODEL = /@\/lib\/providers\/dispatch|\bdispatch(?:Email|Sms)\s*\(|\bgenerate(?:Text|Object)Routed\s*\(|@\/lib\/providers\/messaging/
const leakyPath = Object.keys(CREDIT_BAND_PATH).filter((p) => existsSync(p) && EGRESS_OR_MODEL.test(stripped(p)))
check("FIREWALL: no file on the band's path sends a message or calls a model (so the band cannot ride out through one)",
  leakyPath.length === 0, leakyPath.join(", "))
check("POSITIVE CONTROL: an outbound fixture that reads the band IS flagged by the census predicate, and a sender IS flagged by the egress predicate",
  CREDIT_BAND.test(`const band = contact.credit_score_range\nawait dispatchEmail({ to, body: band })`) && EGRESS_OR_MODEL.test(`await dispatchEmail({ to, body })`))
check("POSITIVE CONTROL: the pre-86 persona pain-point line (a band → 'credit_qualification_risk' → the open-house invitation prompt) IS flagged",
  CREDIT_BAND.test(stripComments(`if (isSubprimeCreditRange(f.creditScoreRange)) pains.push("credit_qualification_risk")\n`)))
check("POSITIVE CONTROL: a tombstone comment naming the band is NOT a reader",
  !CREDIT_BAND.test(stripComments(`// TOMBSTONE: creditScoreRange / credit_score_range left the persona facts\n`)))
check("POSITIVE CONTROL: a column-list read (.select / a column array) and Versium's keyed field ARE readers; registry PROSE naming the column is NOT",
  CREDIT_BAND.test(`await svc.from("contacts").select("id, first_name, credit_score_range").eq("id", id)`)
  && CREDIT_BAND.test(`const COLS = ["household_income", "credit_score_range"]`)
  && CREDIT_BAND.test(`const band = row["Credit Rating"]`)
  && !CREDIT_BAND.test(`const what = "the band (credit_score_range) never reaches outbound copy — FCRA"`))
const SENTINELS = ["lib/contacts/persona-builder.ts", "lib/ai-isa/personalize-outreach.ts", "app/actions/open-house-automation.ts",
  "lib/lead-pipeline/canonical-lead-eligibility.ts", "lib/lead-pipeline/enrichment-orchestrator.ts", "lib/ai-isa/email-generator.ts"]
check(`the high-risk surfaces are IN the census and clean (persona, outreach, open-house invite, lead gate, drain, ISA email): ${SENTINELS.length} named`,
  SENTINELS.every((p) => CORPUS.includes(p) && !CREDIT_BAND.test(stripped(p))), SENTINELS.filter((p) => !CORPUS.includes(p)).join(", "))
const outreach = stripped("lib/ai-isa/personalize-outreach.ts")
check("outbound copy (personalize-outreach) never reads net worth or the credit band", !/net_worth|credit_score/.test(outreach))
const { CONTACT_PII_NULL_COLUMNS } = await import("../lib/privacy/contact-pii-redaction")
check("right-to-be-forgotten erases all four household columns", ["marital_status", "household_income", "net_worth_range", "credit_score_range"].every((c) => (CONTACT_PII_NULL_COLUMNS as readonly string[]).includes(c)))
check("READERS exist for every write: the card reads net worth + the credit band; persona-builder reads net worth (never the band); contact-creator maps a lead's profile onto the contact",
  /isHighNetWorthRange\(f\.netWorth\)/.test(stripped("lib/contacts/persona-builder.ts")) && !CREDIT_BAND.test(stripped("lib/contacts/persona-builder.ts"))
  && /\["credit_score_range"/.test(panel) && /\["net_worth_range"/.test(panel)
  && /peopleDataProfileToContactColumns\(data\.lead\.enrichment_profile/.test(stripped("lib/contact-promotion/contact-creator.ts")))
console.log(`  firewall: ${CORPUS.length} app/ lib/ files scanned; ${Object.keys(CREDIT_BAND_PATH).length} on the band's path (${Object.values(CREDIT_BAND_PATH).join("; ")})`)
console.log("  firewall blind spots: a WHOLE-ROW read (select('*') / an embed) that is then stringified into a prompt carries every column without naming one — the census cannot see it; the named sentinels were read by hand for that shape (open-house-automation reads the persona row, whose facts no longer carry the band). The enrichment_profile jsonb carries the band too (household_financials); a reader that JSON.stringify's the whole profile into outbound copy would leak it — engage-contact.ts hands it to email-generator.ts, which reads only `age` (checked above as a sentinel).")

console.log("\n[Layer 8e · Versium, finalized — the credit-band provider; contacts.enrichment_source = PROVIDER]")
{
  const vc = await import("../lib/external/versium-client")
  // Versium's published "Demographic Output Sample" (financial output), trimmed to the fields that matter.
  const SAMPLE = { versium: { version: "2.0", match_counts: { financial: 1 }, num_matches: 1, num_results: 1, results: [{
    "Individual Level Match": "Yes", "Home Own or Rent": "Own", "Household Income": "$150,000-199,999",
    "Estimated Net Worth": "> $499,999", "Credit Rating": "700-749", "Home Value": "$500,000-749,999" }] } }
  const parsed = vc.parseVersiumFinancialResponse(SAMPLE)
  check("the published sample parses: band '700-749', income + net worth kept, individual-level match, 1 credit",
    parsed.data?.credit_score_range === "700-749" && parsed.data?.household_income === "$150,000-199,999" && parsed.data?.net_worth === "> $499,999"
    && parsed.matchLevel === "individual" && parsed.credits === 1, JSON.stringify(parsed))
  const none = vc.parseVersiumFinancialResponse({ versium: { match_counts: {}, num_matches: 0, results: [] } })
  check("a no-match is free: no data, 0 credits", none.data === null && none.credits === 0 && none.matchLevel === null)
  const billedEmpty = vc.parseVersiumFinancialResponse({ versium: { match_counts: { financial: 1 }, results: [{ "Individual Level Match": "No", "Home Value": "$300,000-349,999" }] } })
  check("POSITIVE CONTROL (the 85C understatement): a BILLED match carrying none of our fields is still 1 credit (household match), not $0",
    billedEmpty.data === null && billedEmpty.credits === 1 && billedEmpty.matchLevel === "household")
  check("inputs follow the API: ZIP+4 → 5-digit, a malformed email is not sent, US only",
    vc.versiumQueryFor({ firstName: "Ana", lastName: "Reyes", zip: "78756-1234" })?.zip === "78756" && vc.versiumQueryFor({ email: "not-an-email" }) === null
    && vc.versiumQueryFor({ email: "ana@example.com" })?.country === "US")
  check("the documented status codes are named for what the operator must do (402 credits, 403 no API access, 401 key, 429 rate)",
    /credits exhausted/.test(vc.versiumStatusProblem(402)) && /no API access/.test(vc.versiumStatusProblem(403)) && /VERSIUM_API_KEY/.test(vc.versiumStatusProblem(401)) && /rate limit/.test(vc.versiumStatusProblem(429)))
  check("one price: the financial match cost IS one match credit, and VENDOR_PRICING.versium mirrors it",
    vc.VERSIUM_FINANCIAL_MATCH_COST_USD === vc.VERSIUM_MATCH_CREDIT_USD && (await import("../lib/vendor-governance/cost-normalizer")).VENDOR_PRICING.versium?.costPerUnit === vc.VERSIUM_MATCH_CREDIT_USD)
  // Stubbed fetch (ZERO network): the request the client actually builds, and what it books.
  const realFetch = globalThis.fetch
  const priorKey = process.env.VERSIUM_API_KEY
  const seen: { url: string; headers: Record<string, string> }[] = []
  try {
    process.env.VERSIUM_API_KEY = "test-key-86a"
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), headers: init?.headers ?? {} })
      return new Response(JSON.stringify(SAMPLE), { status: 200, headers: { "content-type": "application/json" } })
    }) as any
    const r = await vc.appendVersiumFinancial({ firstName: "Ana", lastName: "Reyes", city: "Austin", state: "TX" })
    const u = seen[0] ? new URL(seen[0].url) : null
    check("stubbed run: GET https://api.versium.com/v2/demographic with output[]=financial, cfg_maxrecs=1, rcfg_max_time, country=US",
      !!u && u.origin + u.pathname === "https://api.versium.com/v2/demographic" && u.searchParams.get("output[]") === "financial"
      && u.searchParams.get("cfg_maxrecs") === "1" && !!u.searchParams.get("rcfg_max_time") && u.searchParams.get("country") === "US", seen[0]?.url)
    check("stubbed run: the key rides the x-versium-api-key header (never the query string)",
      seen[0]?.headers["x-versium-api-key"] === "test-key-86a" && !(seen[0]?.url ?? "").includes("test-key-86a"))
    check("stubbed run: a match books exactly one credit ($0.05) and returns the band",
      r.cost === 0.05 && r.credits === 1 && r.data?.credit_score_range === "700-749" && r.matchLevel === "individual", JSON.stringify(r))
    globalThis.fetch = (async () => new Response(JSON.stringify({ versium: { errors: ["Insufficient credits"] } }), { status: 402 })) as any
    const broke = await vc.appendVersiumFinancial({ email: "ana@example.com" })
    check("stubbed run: a 402 (credits exhausted) books $0 and says what to do", broke.cost === 0 && broke.data === null && /credits exhausted/.test(broke.error ?? ""), JSON.stringify(broke))
  } finally {
    globalThis.fetch = realFetch
    if (priorKey === undefined) delete process.env.VERSIUM_API_KEY; else process.env.VERSIUM_API_KEY = priorKey
  }
  const setupDoc = read("lib/external/versium-client.ts")
  check("the owner's setup is documented at the client (credit package — pay-as-you-go has no API; Manage API Keys; VERSIUM_API_KEY) and the key is in .env.example",
    /OWNER SETUP/.test(setupDoc) && /CREDIT PACKAGE/.test(setupDoc) && /Manage API Keys/.test(setupDoc) && /^VERSIUM_API_KEY=/m.test(read(".env.example")))
}
{
  const ecm = await import("../lib/lead-pipeline/enrichment-column-map")
  const { VENDOR_PRICING } = await import("../lib/vendor-governance/cost-normalizer")
  check("ONE provider vocabulary: every ENRICHMENT_PROVIDERS name is a ledger vendor key (VENDOR_PRICING)",
    ecm.ENRICHMENT_PROVIDERS.every((v) => v in VENDOR_PRICING), ecm.ENRICHMENT_PROVIDERS.filter((v) => !(v in VENDOR_PRICING)).join(", "))
  check("the mapper writes a PROVIDER into contacts.enrichment_source — never a trigger",
    ecm.peopleDataProfileToContactColumns({ provider: "versium" }).enrichment_source === "versium"
    && ecm.peopleDataProfileToContactColumns({ provider: "auto" }).enrichment_source === "peopledata"
    && ecm.enrichmentProviderOf("manual") === null && ecm.enrichmentProviderOf(" BatchData ") === "batchdata")
  const TRIGGER_INTO_SOURCE = /\benrichment_source\s*:\s*(?:params\.(?:source|trigger)|options\.\w+|["'](?:auto|manual|import|contact_intake|deal_ended|ghl_sync)["'])/
  const triggerWriters = CORPUS.filter((p) => TRIGGER_INTO_SOURCE.test(stripped(p)))
  check(`no file writes a TRIGGER into contacts.enrichment_source (denominator ${CORPUS.length} app/ lib/ files)`, triggerWriters.length === 0, triggerWriters.join(", "))
  check("POSITIVE CONTROL: the pre-86 contact-enrichment line IS flagged; its tombstone comment is NOT",
    TRIGGER_INTO_SOURCE.test(`      enrichment_source: params.source ?? "auto",`) && !TRIGGER_INTO_SOURCE.test(stripComments(`// enrichment_source: params.source ?? "auto" was the trigger\n`)))
  check("contact enrichment writes the provider that answered (PDL via the mapper, else the paid rung), and the trigger rides the ledger metadata",
    /enrichment_source: enrichmentProvider/.test(cecEnrich) && /paidRungProvider = "versium"/.test(cecEnrich)
    && /trigger: params\.trigger \?\? "auto"/.test(cecEnrich) && /export type EnrichmentTrigger\s*=/.test(cec) && !/\bEnrichmentSource\b/.test(cec))
}
console.log(`  denominators: ${HOUSEHOLD_FINANCIAL_FIELDS.length} household fields · 3 writers (seller-signal probe, drain Step 6f + paid rung, raw acquisition path) + contact enrichment · 1 mapper`)
console.log("  blind spots: live BatchData demographic VALUE formats and Versium's live payload are not exercised (fixtures follow the providers' published samples); no VERSIUM_API_KEY exists yet, so the credit band stays empty until the owner buys credits")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" FAILURES:")
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
