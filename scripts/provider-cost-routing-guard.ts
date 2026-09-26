#!/usr/bin/env tsx
/**
 * scripts/provider-cost-routing-guard.ts   (npm run test:provider-cost-routing)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 81B — owner verbatim (wave 81): "make sure that peoplesearch and batchdata
 * don't overlap and if they do then search which one is cheaper, then use that
 * one. those capabilities and scraping acquisition are platform paid."
 *
 * Proves, with NO network and NO database:
 *   Layer 0 — strip-comments positive control (CLAUDE.md §2).
 *   Layer 1 — THE PRICE TABLE IS DATA AND CHEAPEST-FIRST: every capability in
 *             lib/ai-isa/property-lookup-rail.ts::CONTACT_PROVIDER_ROUTES is sorted
 *             ascending by unit cost; owner_contact (the ONE overlap) puts the
 *             cheaper provider first; every unit cost IS the constant the transport
 *             books (no second spelling); non-overlapping capabilities name exactly
 *             one provider; VENDOR_PRICING.peopledata agrees with the client's
 *             matched price; a PDL no-match books $0.
 *   Layer 2 — resolveContactProviderRoute picks the order from the RECORD (address
 *             → BatchData first, PeopleData only as fallback; no address →
 *             PeopleData; nothing → refused).
 *   Layer 3 — THE DRAIN OBEYS THE ROUTE (stripped+blanked source): the BatchData
 *             skip trace precedes the PeopleData call, the PeopleData call is
 *             guarded on a BatchData miss, the gate precedes the reach, and both
 *             providers book through meterVendorSpend at the reported cost.
 *   Layer 4 — ONE GATE: `valuation` decided by the same decideBatchDataAccess; the
 *             eight wave-80 blind spots are gone (gated, repointed to the rail, or a
 *             deleted dead instantiation); no second resolver/route table exists.
 *   Layer 5 — PLATFORM-PAID: every PeopleData / BatchData / scraper booking lands on
 *             vendor_usage_tracking (meterVendorSpend / trackVendorUsageService /
 *             logVendorUsage) and no such file writes a TENANT meter
 *             (usage_events / usage_logs / usage_counters / meter_readings); the
 *             tenant rollup (lib/finance/usage-metering.ts) and the AI overage
 *             (lib/billing/ai-overage.ts) never read vendor_usage_tracking.
 *   Layer 6 — ai-listing-intake's enrichment is FACTS ONLY through the rail (no
 *             estimatedValue / estimatedRent / walkScore prompt) — 80B's open item.
 *   Layer 7 — ONE NAME for the billed-pull opt-in (BATCHDATA_BILLED_PULL_OPT_IN);
 *             the rail's policy read spells no literal.
 *   Layer 8 — the frozen "peoplesearch" scrape (lib/osint-client.ts) still returns
 *             no structured person record — the audit verdict stays true.
 *   Layer 9 — registration (package.json, guard ordering, MAINTENANCE_DOMAINS).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
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
const code = (p: string) => blankStrings(stripped(p))

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

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 0 · strip-comments positive control]")
const RAIL = "lib/ai-isa/property-lookup-rail.ts"
const railSrc = stripped(RAIL)
check("a comment-only phrase is ABSENT from stripped property-lookup-rail.ts", !railSrc.includes("PROVIDER CHOICE — PEOPLESEARCH vs BATCHDATA"))
check("a real code token from the same file IS present", railSrc.includes("export function resolveContactProviderRoute"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · the price table is data, cheapest first, one spelling per cost]")
const rail = await import("../lib/ai-isa/property-lookup-rail")
const bd = await import("../lib/external/batchdata-client")
const pdl = await import("../lib/external/peopledata-client")
const aiTools = await import("../lib/external/batchdata-ai-tools")
const { VENDOR_PRICING } = await import("../lib/vendor-governance/cost-normalizer")
const { CONTACT_PROVIDER_ROUTES, resolveContactProviderRoute } = rail
type Capability = keyof typeof CONTACT_PROVIDER_ROUTES
const caps = Object.keys(CONTACT_PROVIDER_ROUTES) as Capability[]
// Wave 82 lane A: + reverse_contact (person-keyed BatchData REVERSE skip trace, PeopleData on a miss).
check("seven capabilities are routed (owner_contact, reverse_contact, person_profile, dnc_tcpa, email_validation, property_facts, motivated_seller_list)",
  caps.sort().join(",") === "dnc_tcpa,email_validation,motivated_seller_list,owner_contact,person_profile,property_facts,reverse_contact")
const rc = CONTACT_PROVIDER_ROUTES.reverse_contact
check("reverse_contact overlaps like owner_contact: BatchData FIRST at the SAME skip-trace constant (no second spelling), PeopleData on a miss",
  rc.length === 2 && rc[0].provider === "batchdata" && rc[1].provider === "peopledata"
  && rc[0].unitCostUsd === bd.BATCHDATA_SKIP_TRACE_COST_USD && rc[1].unitCostUsd === pdl.PEOPLEDATA_MATCH_COST_USD)
for (const cap of caps) {
  const list = CONTACT_PROVIDER_ROUTES[cap]
  const sorted = list.every((e, i) => i === 0 || list[i - 1].unitCostUsd <= e.unitCostUsd)
  check(`${cap}: providers are ordered cheapest-first (${list.map((e) => `${e.provider} $${e.unitCostUsd}`).join(" → ")})`, list.length > 0 && sorted && list.every((e) => e.unitCostUsd > 0))
}
const oc = CONTACT_PROVIDER_ROUTES.owner_contact
check("owner_contact is THE overlap: two providers, BatchData FIRST because $0.07/match < PeopleData $0.25/match",
  oc.length === 2 && oc[0].provider === "batchdata" && oc[1].provider === "peopledata" && oc[0].unitCostUsd < oc[1].unitCostUsd)
check("owner_contact costs ARE the transport constants (BATCHDATA_SKIP_TRACE_COST_USD, PEOPLEDATA_MATCH_COST_USD) — no second spelling",
  oc[0].unitCostUsd === bd.BATCHDATA_SKIP_TRACE_COST_USD && oc[1].unitCostUsd === pdl.PEOPLEDATA_MATCH_COST_USD)
check("dnc_tcpa / property_facts book MCP_TOOL_CALL_COST_USD; email_validation books PEOPLEDATA_EMAIL_VALIDATE_COST_USD; motivated_seller_list books BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD",
  CONTACT_PROVIDER_ROUTES.dnc_tcpa[0].unitCostUsd === aiTools.MCP_TOOL_CALL_COST_USD
  && CONTACT_PROVIDER_ROUTES.property_facts[0].unitCostUsd === aiTools.MCP_TOOL_CALL_COST_USD
  && CONTACT_PROVIDER_ROUTES.email_validation[0].unitCostUsd === pdl.PEOPLEDATA_EMAIL_VALIDATE_COST_USD
  && CONTACT_PROVIDER_ROUTES.motivated_seller_list[0].unitCostUsd === bd.BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD)
for (const cap of ["person_profile", "dnc_tcpa", "email_validation", "property_facts", "motivated_seller_list"] as const) {
  check(`${cap}: does NOT overlap — exactly one provider (${CONTACT_PROVIDER_ROUTES[cap][0].provider})`, CONTACT_PROVIDER_ROUTES[cap].length === 1)
}
check("person_profile / email_validation are PeopleData-only; dnc_tcpa / property_facts / motivated_seller_list are BatchData-only",
  CONTACT_PROVIDER_ROUTES.person_profile[0].provider === "peopledata" && CONTACT_PROVIDER_ROUTES.email_validation[0].provider === "peopledata"
  && CONTACT_PROVIDER_ROUTES.dnc_tcpa[0].provider === "batchdata" && CONTACT_PROVIDER_ROUTES.property_facts[0].provider === "batchdata" && CONTACT_PROVIDER_ROUTES.motivated_seller_list[0].provider === "batchdata")
check("BatchData skip trace is priced at the published pay-per-match floor ($0.07, batchdata.io 2026-04) — never below it",
  bd.BATCHDATA_SKIP_TRACE_COST_USD >= 0.07)
check("PeopleData: a no-match books $0 (PDL charges per successful match) and VENDOR_PRICING.peopledata equals the client's matched price",
  pdl.PEOPLEDATA_NO_MATCH_COST_USD === 0 && VENDOR_PRICING.peopledata.costPerUnit === pdl.PEOPLEDATA_MATCH_COST_USD)
check("POSITIVE CONTROL: the ordering predicate DOES reject a dearer-first list",
  !([{ unitCostUsd: 0.25 }, { unitCostUsd: 0.07 }] as const).every((e, i, l) => i === 0 || l[i - 1].unitCostUsd <= e.unitCostUsd))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · resolveContactProviderRoute — the order comes from the record]")
const route = (i: Partial<Parameters<typeof resolveContactProviderRoute>[0]>) =>
  resolveContactProviderRoute({ hasName: false, hasPropertyAddress: false, hasEmailOrPhone: false, hasProfileUrl: false, ...i }).providers.join(",")
check("name + property address → batchdata, then peopledata (fallback only)", route({ hasName: true, hasPropertyAddress: true }) === "batchdata,peopledata")
check("property address alone → batchdata only (PeopleData has nothing to be asked with)", route({ hasPropertyAddress: true }) === "batchdata")
check("email/phone without an address → BatchData REVERSE skip trace, then PeopleData (wave 82 lane A)",
  route({ hasEmailOrPhone: true }) === "batchdata,peopledata"
  && resolveContactProviderRoute({ hasName: true, hasPropertyAddress: false, hasEmailOrPhone: true, hasProfileUrl: false }).capability === "reverse_contact")
check("a property address still routes the V3 (property-keyed) shape, even with a phone on the record",
  resolveContactProviderRoute({ hasName: true, hasPropertyAddress: true, hasEmailOrPhone: true, hasProfileUrl: false }).capability === "owner_contact")
check("name alone (no phone/email/address) → peopledata only", route({ hasName: true }) === "peopledata")
check("social profile URL alone → peopledata", route({ hasProfileUrl: true }) === "peopledata")
check("no identifier at all → refused (empty route, reason given)", route({}) === "" && /no identifier/.test(resolveContactProviderRoute({ hasName: false, hasPropertyAddress: false, hasEmailOrPhone: false, hasProfileUrl: false }).reason))
check("the reason names the prices it chose between", /\$0\.07/.test(resolveContactProviderRoute({ hasName: true, hasPropertyAddress: true, hasEmailOrPhone: false, hasProfileUrl: false }).reason))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · the enrichment drain obeys the route]")
const ORCH = "lib/lead-pipeline/enrichment-orchestrator.ts"
const orch = code(ORCH)
const orchStr = stripped(ORCH)
const iRoute = orch.indexOf("resolveContactProviderRoute("), iGate = orch.indexOf("resolveBatchDataAccess("), iBd = orch.indexOf("skipTraceBatchDataV3Batch("), iPdl = orch.indexOf("skipTraceWithPeopleData(")
check("route resolved, then the gate, then the BatchData skip trace, then (and only then) PeopleData — in that source order",
  iRoute >= 0 && iGate > iRoute && iBd > iGate && iPdl > iBd, `route@${iRoute} gate@${iGate} batchdata@${iBd} peopledata@${iPdl}`)
// Lane 83A (owner, wave 83: "we need the richer demographics for raw leads and leads") — the 81B
// profile-skip is REVERSED: PeopleData is still asked only when the route names it, and on a
// BatchData miss OR (DEMOGRAPHICS_AFTER_CONTACT_MATCH) for the demographic profile after a match.
// The rule, not the old spelling: the call sits behind askPeopleData, which requires the route.
check("the PeopleData call is guarded on the route naming it, and on a BatchData miss OR the demographics ruling (lane 83A)",
  /const askPeopleData = route\.providers\.includes\('peopledata'\) && \(!batchDataFallback \|\| DEMOGRAPHICS_AFTER_CONTACT_MATCH\)/.test(orchStr)
  && /askPeopleData\s*\?\s*await skipTraceWithPeopleData\(/.test(orchStr))
check("the BatchData leg runs only when the route puts it FIRST (route.providers[0] === 'batchdata') and declares purpose 'skip_trace'",
  /route\.providers\[0\] === 'batchdata'[\s\S]{0,120}resolveBatchDataAccess\(\{ brokerageId, purpose: 'skip_trace' \}\)/.test(orchStr))
const meterPdl = (orchStr.match(/vendorName: 'peopledata'/g) ?? []).length, meterBd = (orchStr.match(/vendorName: 'batchdata'/g) ?? []).length
const trackCalls = (orch.match(/trackVendorUsageService\(\{/g) ?? []).length
check(`both providers book through meterVendorSpend at the REPORTED cost (peopledata ×${meterPdl}, batchdata ×${meterBd}); the only trackVendorUsageService left is the $0 osint_free lane (×${trackCalls})`,
  meterPdl === 2 && meterBd === 2 && trackCalls === 1 && /vendor: 'osint_free'/.test(orchStr) && !/vendor: 'peopledata'|vendor: 'batchdata'/.test(orchStr))
check("the old label 'batchdata_skip_trace_fallback' is gone (BatchData is first, not a fallback) and nothing under app/ lib/ reads it",
  !CORPUS.some((p) => /batchdata_skip_trace_fallback/.test(stripped(p))))
check("POSITIVE CONTROL: the order predicate DOES flag the pre-81B shape (PeopleData before BatchData)",
  (() => { const fx = "await skipTraceWithPeopleData({})\nawait resolveBatchDataAccess({})\nawait skipTraceBatchDataV3Batch([])"; return !(fx.indexOf("skipTraceBatchDataV3Batch(") < fx.indexOf("skipTraceWithPeopleData(")) })())

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · ONE gate — valuation joins the carve-out; the eight blind spots are closed; no second resolver]")
const { decideBatchDataAccess, BATCHDATA_ELIGIBLE_PURPOSES } = rail
type Policy = import("../lib/ai-isa/property-lookup-rail").PropertyLookupPolicy
type Purpose = import("../lib/ai-isa/property-lookup-rail").PropertyLookupPurpose
const ALLOW: Policy = { batchDataTier: "lean", batchDataOptedIn: true }
const NO_OPT: Policy = { batchDataTier: "lean", batchDataOptedIn: false }
const OFF: Policy = { batchDataTier: "off", batchDataOptedIn: true }
const d = (purpose: Purpose, policy: Policy, brokerageId: string | null = "b-1") => decideBatchDataAccess({ brokerageId, purpose }, policy).allowed
check("BATCHDATA_ELIGIBLE_PURPOSES = acquisition / skip_trace / dnc / valuation", [...BATCHDATA_ELIGIBLE_PURPOSES].sort().join(",") === "acquisition,dnc,skip_trace,valuation")
check("valuation: tier≠off → allowed WITHOUT the on-market opt-in; tier off → refused; no tenant → refused (§4)",
  d("valuation", ALLOW) && d("valuation", NO_OPT) && !d("valuation", OFF) && !d("valuation", ALLOW, null))
check("acquisition still needs the opt-in; conversation / listing_intake still never reach BatchData",
  d("acquisition", ALLOW) && !d("acquisition", NO_OPT) && !d("conversation", ALLOW) && !d("listing_intake", ALLOW))
// The eight wave-80 blind spots: each is now GATED (resolveBatchDataAccess( before its first reach)
// or no longer reaches BatchData at all (repointed to the rail / dead instantiation deleted).
// `searchProperties(` is also an IDX Broker client method — a bare token there accused
// calculators.ts / ai-predictions.ts of reaching BatchData through their IDX search (the
// first run: 2 false findings, a blind finder). The lookbehind excludes an idx receiver.
const BD_REACH = /callBatchDataMcp\(|batchDataPreferMcp(?:<[^(]*?>)?\(|skipTraceBatchDataV3Batch\(|enrichPropertyDatasetsBatchData\(|fetchIncrementalPropertySearch\(|checkDncStatus\(|checkTcpaStatus\(|verifyPhone\(|(?<![Ii]dx\w*\.)searchProperties\(|fetchMotivatedSellers\(|enrichPropertyWithBatchData\(|fetchBatchDataComps\(|investorBuybox\w+\(|verifyAddressBatchData\(|fetchBatchRankPropensity\(|lookupBatchDataPropertiesByIds\(|new BatchDataClient\(|comparableProperty\w+\(/
const GATE = /resolveBatchDataAccess\(/
const FORMER_BLIND_SPOTS: Array<{ file: string; expect: "gated" | "no_reach"; purpose?: string }> = [
  { file: "lib/cma/comp-provider.ts", expect: "gated", purpose: "valuation" },
  { file: "lib/avm/provider-chain.ts", expect: "gated", purpose: "valuation" },
  { file: "lib/agentic-os/deal-investigator.ts", expect: "gated", purpose: "valuation" },
  { file: "lib/offers/public-record-preload.ts", expect: "gated", purpose: "valuation" },
  { file: "app/actions/investor-buybox-preview.ts", expect: "gated", purpose: "acquisition" },
  { file: "app/actions/lead-intelligence.ts", expect: "gated", purpose: "acquisition" },
  { file: "app/actions/calculators.ts", expect: "no_reach" },   // repointed to the rail (customer audience)
  { file: "app/actions/ai-predictions.ts", expect: "no_reach" }, // dead `new BatchDataClient()` deleted
]
for (const b of FORMER_BLIND_SPOTS) {
  const src = code(b.file)
  const gi = src.search(GATE), ri = src.search(BD_REACH)
  if (b.expect === "gated") {
    check(`${b.file}: resolveBatchDataAccess( precedes its first BatchData reach and declares purpose "${b.purpose}"`,
      gi >= 0 && ri >= 0 && gi < ri && new RegExp(`purpose: "${b.purpose}"`).test(stripped(b.file)), `gate@${gi} reach@${ri}`)
  } else {
    check(`${b.file}: no longer reaches BatchData at all (no reach token, no bare BatchDataClient)`, ri < 0 && !/BatchDataClient/.test(src), `reach@${ri}`)
  }
}
// Re-anchored wave 82 lane A: the calculators ride the rail's PUBLIC door (purpose public_facts,
// whitelist projection) — the owner's ruling restored the tax/HOA facts 81B's customer-conversation
// reach had stripped. scripts/public-property-facts-guard.ts proves the whitelist.
check("app/actions/calculators.ts rides the rail's PUBLIC facts door (lookupPublicPropertyFacts — facts only) — never a raw BatchData row to a public visitor",
  /lookupPublicPropertyFacts\(\{[\s\S]{0,40}brokerageId,/.test(stripped("app/actions/calculators.ts"))
  && !/lookupPropertyForConversation\(/.test(stripped("app/actions/calculators.ts")))
check("lib/kernel/offer-net-sheet.ts hands the listing's OWN tenant to the preload (the gate refuses a tenant-less reach)",
  /preloadPublicRecordCosts\([\s\S]{0,400}brokerageId: \(lst as any\)\.brokerage_id/.test(stripped("lib/kernel/offer-net-sheet.ts")))
const DEF_RESOLVER = /function decideBatchDataAccess\(|function resolveBatchDataAccess\(|CONTACT_PROVIDER_ROUTES\s*[:=]|function resolveContactProviderRoute\(/
const resolverFiles = CORPUS.filter((p) => DEF_RESOLVER.test(code(p)))
check("no second resolver / route table anywhere under app/ lib/ (only the rail defines them)", resolverFiles.length === 1 && resolverFiles[0] === RAIL, resolverFiles.join(", "))
check("POSITIVE CONTROL: a fixture reaching BatchData without the gate IS flagged; a second route table IS flagged",
  (() => { const fx = `const x = await enrichPropertyWithBatchData(a)`; const fy = `export const CONTACT_PROVIDER_ROUTES = {}`; return BD_REACH.test(blankStrings(fx)) && !GATE.test(fx) && DEF_RESOLVER.test(fy) })())

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · PLATFORM-PAID — provider + scraper spend lands on vendor_usage_tracking, never a tenant meter]")
// A BOOKING names the vendor in the `vendorName:` shape (meterVendorSpend / logVendorUsage /
// lib/vendor-tracking.ts::trackVendorUsage) or as `vendor:` inside a trackVendorUsageService
// call. A registry row `{ vendor: "peopledata", tier: … }` (lib/agentic-os/vendor-capability-
// registry.ts) is DATA, not spend — the first run counted it as an unbooked booking.
const VENDORS = "peopledata|batchdata|zenrows|apify|apify_social|osint|osint_free|tavily|exa|zyte"
const PROVIDER_VENDOR = new RegExp(`vendorName:\\s*["'](?:${VENDORS})["']|trackVendorUsageService\\(\\{[\\s\\S]{0,120}?vendor:\\s*["'](?:${VENDORS})["']`)
const BOOKER = /meterVendorSpend\(|trackVendorUsageService\(|logVendorUsage\(|trackVendorUsage\(/
// TABLE NAMES ARE STRING LITERALS — this predicate runs on comment-STRIPPED source, never on
// blanked strings (the first run blanked them and the tenant-meter check reported zero blind).
const TENANT_METER_WRITE = /\.from\(["'](?:usage_events|usage_logs|usage_counters|meter_readings)["']\)\s*\.(?:insert|upsert|update)\(|increment_ai_usage_monthly/
const bookers = CORPUS.filter((p) => PROVIDER_VENDOR.test(stripped(p)))
const unbooked = bookers.filter((p) => !BOOKER.test(code(p)) && p !== "lib/vendor-governance/cost-normalizer.ts" && p !== "lib/vendor-governance/meter-vendor.ts")
const tenantMetered = bookers.filter((p) => TENANT_METER_WRITE.test(stripped(p)))
console.log(`  denominator: ${CORPUS.length} files under app/ lib/ · ${bookers.length} name a provider/scraper vendor in a booking`)
check(`every file that names a provider/scraper vendor books through the platform ledger (meterVendorSpend / trackVendorUsageService / logVendorUsage / trackVendorUsage) — ${bookers.length - unbooked.length}/${bookers.length}`,
  unbooked.length === 0, unbooked.join(", "))
check("NO file that books provider/scraper spend writes a TENANT meter (usage_events / usage_logs / usage_counters / meter_readings / increment_ai_usage_monthly)",
  tenantMetered.length === 0, tenantMetered.join(", "))
check("the four bookers all land on vendor_usage_tracking: usage-logger.ts (meterVendorSpend / trackVendorUsageService / logVendorUsage) and lib/vendor-tracking.ts (trackVendorUsage) write it and nothing tenant-metered",
  /\.from\(['"]vendor_usage_tracking['"]\)/.test(stripped("lib/vendor-governance/usage-logger.ts")) && !TENANT_METER_WRITE.test(stripped("lib/vendor-governance/usage-logger.ts"))
  && /\.from\(['"]vendor_usage_tracking['"]\)/.test(stripped("lib/vendor-tracking.ts")) && !TENANT_METER_WRITE.test(stripped("lib/vendor-tracking.ts"))
  && /\blogVendorUsage\b/.test(code("lib/vendor-governance/meter-vendor.ts")) && /logVendorUsage\(/.test(code("lib/vendor-governance/track-vendor-usage.ts")))
const metering = stripped("lib/finance/usage-metering.ts")
check("the tenant usage rollup (lib/finance/usage-metering.ts) folds usage_events + usage_logs + ai_tool_usage into meter_readings and NEVER reads vendor_usage_tracking",
  /from\("usage_events"\)/.test(metering) && /from\("usage_logs"\)/.test(metering) && /from\("ai_tool_usage"\)/.test(metering) && /from\("meter_readings"\)/.test(metering) && !/vendor_usage_tracking/.test(metering))
const overage = stripped("lib/billing/ai-overage.ts")
check("the AI overage (lib/billing/ai-overage.ts) derives from usage_counters only — vendor_usage_tracking never reaches an invoice item",
  /from\("usage_counters"\)/.test(overage) && !/vendor_usage_tracking/.test(overage))
const cron = stripped("app/api/cron/lead-scraping/route.ts")
// Re-anchored lane 82B: the cron now books PER SOURCE through source-cost-ledger.ts::bookSourceSpend,
// which is itself a meterVendorSpend call — assert the RULE (the cron's bookings reach the ONE
// gateway), not the spelling of the call site.
check("scraping acquisition (app/api/cron/lead-scraping/route.ts) books through meterVendorSpend (directly or via bookSourceSpend → meterVendorSpend) and writes no tenant meter",
  (cron.match(/\b(?:meterVendorSpend|bookSourceSpend)\(/g) ?? []).length >= 3
  && /\bmeterVendorSpend\(/.test(code("lib/lead-pipeline/source-cost-ledger.ts"))
  && !TENANT_METER_WRITE.test(cron) && !TENANT_METER_WRITE.test(stripped("lib/lead-pipeline/source-cost-ledger.ts")))
check("the BatchData platform-wide tier cap sums vendor_usage_tracking for vendor 'batchdata' — the SAME ledger these bookings land on",
  /vendor_usage_tracking/.test(stripped("lib/ai-isa/persona-tool-policy.ts")) && /"vendor_name", "batchdata"/.test(stripped("lib/ai-isa/persona-tool-policy.ts")))
check("POSITIVE CONTROL: a fixture booking BatchData into usage_events IS flagged; a bare vendor literal with no booker IS flagged",
  (() => { const fx = `await svc.from("usage_events").insert({ vendorName: "batchdata" })`; return PROVIDER_VENDOR.test(fx) && TENANT_METER_WRITE.test(stripComments(fx)) && !BOOKER.test(fx) })())

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · ai-listing-intake enrichment is FACTS ONLY through the rail (80B open item)]")
const intake = stripped("app/actions/ai-listing-intake.ts")
const fnStart = intake.indexOf("export async function aiEnrichPropertyData")
const fnEnd = intake.indexOf("export async function", fnStart + 10)
const fn = intake.slice(fnStart, fnEnd)
check("aiEnrichPropertyData exists and calls the rail with purpose 'listing_intake' / audience 'staff' and the SESSION tenant",
  fnStart >= 0 && /lookupPropertyForConversation\(\{[\s\S]{0,80}brokerageId: ctx\.brokerageId,[\s\S]{0,40}purpose: "listing_intake",[\s\S]{0,40}audience: "staff"/.test(fn))
const VALUE_FIELDS = /estimatedValue|estimatedRent|walkScore|floodZone|schoolDistrict/
check("…and names NO value / rent / score / district field, runs NO private model prompt (generateObject) and books NO side ledger entry (logAIUsage)",
  !VALUE_FIELDS.test(fn) && !/generateObject\(/.test(fn) && !/logAIUsage\(/.test(fn))
check("POSITIVE CONTROL: the value-field finder DOES flag the old prompt", VALUE_FIELDS.test(`"estimatedValue": number,\n  "estimatedRent": number`))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 7 · one name for the billed-pull opt-in]")
const lso = await import("../lib/buyer-search/listing-source-order")
check("listing-source-order exports BATCHDATA_BILLED_PULL_OPT_IN = the stored 'batchdata_on_market' spelling (the concept has ONE code-side name)",
  lso.BATCHDATA_BILLED_PULL_OPT_IN === "batchdata_on_market")
check("the rail reads the opt-in through the constant — the literal is spelled NOWHERE in its code (only in prose)",
  /includes\(BATCHDATA_BILLED_PULL_OPT_IN\)/.test(railSrc) && !/["'`]batchdata_on_market["'`]/.test(railSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 8 · the frozen 'peoplesearch' scrape returns no structured person record (audit verdict)]")
const osint = stripped("lib/osint-client.ts")
const pubRecStart = osint.indexOf("private parsePublicRecordsHtml("), pubRecEnd = osint.indexOf("private parseCourtRecordsHtml(")
const pubRec = osint.slice(pubRecStart, pubRecEnd)
check("lib/osint-client.ts: parsePublicRecordsHtml (the truepeoplesearch/whitepages page reader) pushes NO structured record — only keyword life_events — and parsePropertyRecordsHtml returns { properties: [] }; the rail names no such provider",
  pubRecStart >= 0 && pubRecEnd > pubRecStart && !/records\.push\(/.test(pubRec) && /life_events\.push\(/.test(pubRec) && /return \{ properties: \[\] \}/.test(osint) && !/truepeoplesearch|osint-client/.test(railSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 9 · registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:provider-cost-routing → this file", pkg.scripts["test:provider-cost-routing"] === "tsx scripts/provider-cost-routing-guard.ts")
const guardLine = pkg.scripts.guard ?? ""
check("the guard chain runs it AFTER test:scrapers (ordering only)",
  guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:provider-cost-routing") > guardLine.indexOf("npm run test:scrapers"))
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
const dom = MAINTENANCE_DOMAINS.provider_cost_routing
check("MAINTENANCE_DOMAINS.provider_cost_routing names this proof under ai_isa with coOwners data_steward / finance_manager / compliance_officer (the prose names each)",
  dom?.proof === "test:provider-cost-routing" && dom?.manager === "ai_isa" && [...(dom?.coOwners ?? [])].sort().join(",") === "compliance_officer,data_steward,finance_manager" && /platform/i.test(dom?.what ?? ""))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" FAILURES:")
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
