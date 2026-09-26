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
  /lookupPropertyByAddress\(/.test(railSrc) && rail.PROPERTY_LOOKUP_RUNG_COST_USD.public_records < rail.PROPERTY_LOOKUP_RUNG_COST_USD.rentcast)

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
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" FAILURES:")
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
