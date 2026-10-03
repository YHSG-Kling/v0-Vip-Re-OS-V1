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
 *   Layer 10 — (wave 99, lane 99C, OWNER LAW 3 "agents request capabilities, not vendors") the AVM
 *             chain is the property_valuation CAPABILITY in the SAME table: RentCast primary,
 *             BatchData backup (an OWNER-ORDERED capability — the one exception to cheapest-first,
 *             carrying its ruling); routeCapability skips a `failing` provider and changes nothing
 *             when all are healthy; no caller under app/ lib/ asks the RentCast AVM vendor directly.
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
const { CONTACT_PROVIDER_ROUTES, resolveContactProviderRoute, OWNER_ORDERED_CAPABILITIES } = rail
type Capability = keyof typeof CONTACT_PROVIDER_ROUTES
const caps = Object.keys(CONTACT_PROVIDER_ROUTES) as Capability[]
// Wave 82 lane A: + reverse_contact (person-keyed BatchData REVERSE skip trace, PeopleData on a miss).
// Wave 99 (lane 99C): + property_valuation (the AVM chain as a capability — Layer 10).
check("eight capabilities are routed (owner_contact, reverse_contact, person_profile, dnc_tcpa, email_validation, property_facts, motivated_seller_list, property_valuation)",
  caps.sort().join(",") === "dnc_tcpa,email_validation,motivated_seller_list,owner_contact,person_profile,property_facts,property_valuation,reverse_contact")
const rc = CONTACT_PROVIDER_ROUTES.reverse_contact
// Re-anchored (wave 93, lane 93B2 — owner cost decision: "Versium first for owner/person email+phone
// append, People Data Labs only when Versium misses"): Versium (an EXISTING vendor) leads both overlap
// capabilities at its own transport constant; BatchData and PeopleData keep their constants and order.
const vs = await import("../lib/external/versium-client")
check("reverse_contact overlaps like owner_contact: VERSIUM FIRST, then BatchData at the SAME skip-trace constant (no second spelling), PeopleData on a miss",
  rc.length === 3 && rc[0].provider === "versium" && rc[1].provider === "batchdata" && rc[2].provider === "peopledata"
  && rc[0].unitCostUsd === vs.VERSIUM_MATCH_CREDIT_USD && rc[1].unitCostUsd === bd.BATCHDATA_SKIP_TRACE_COST_USD && rc[2].unitCostUsd === pdl.PEOPLEDATA_MATCH_COST_USD)
for (const cap of caps) {
  const list = CONTACT_PROVIDER_ROUTES[cap]
  const sorted = list.every((e, i) => i === 0 || list[i - 1].unitCostUsd <= e.unitCostUsd)
  // Wave 99: an OWNER-ORDERED capability is exempt from cheapest-first ONLY by carrying its ruling (Layer 10).
  const ruling = OWNER_ORDERED_CAPABILITIES.get(cap)
  check(ruling
    ? `${cap}: providers are ordered by OWNER RULING, not price (${list.map((e) => `${e.provider} $${e.unitCostUsd}`).join(" → ")}) — ${ruling}`
    : `${cap}: providers are ordered cheapest-first (${list.map((e) => `${e.provider} $${e.unitCostUsd}`).join(" → ")})`,
    list.length > 0 && (sorted || (typeof ruling === "string" && /owner/i.test(ruling))) && list.every((e) => e.unitCostUsd > 0))
}
check("the cheapest-first exemption is NARROW: only property_valuation is owner-ordered (every other capability stays cost-sorted)",
  [...OWNER_ORDERED_CAPABILITIES.keys()].join(",") === "property_valuation")
const oc = CONTACT_PROVIDER_ROUTES.owner_contact
check("owner_contact is THE overlap: three providers, VERSIUM FIRST ($0.05/matched output) < BatchData $0.07/match < PeopleData $0.25/match",
  oc.length === 3 && oc[0].provider === "versium" && oc[1].provider === "batchdata" && oc[2].provider === "peopledata"
  && oc[0].unitCostUsd < oc[1].unitCostUsd && oc[1].unitCostUsd < oc[2].unitCostUsd)
check("owner_contact costs ARE the transport constants (VERSIUM_MATCH_CREDIT_USD, BATCHDATA_SKIP_TRACE_COST_USD, PEOPLEDATA_MATCH_COST_USD) — no second spelling",
  oc[0].unitCostUsd === vs.VERSIUM_MATCH_CREDIT_USD && oc[1].unitCostUsd === bd.BATCHDATA_SKIP_TRACE_COST_USD && oc[2].unitCostUsd === pdl.PEOPLEDATA_MATCH_COST_USD)
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
check("name + property address → versium, then batchdata, then peopledata (fallbacks only)", route({ hasName: true, hasPropertyAddress: true }) === "versium,batchdata,peopledata")
check("property address alone → versium, then batchdata (PeopleData has nothing to be asked with)", route({ hasPropertyAddress: true }) === "versium,batchdata")
check("email/phone without an address → Versium, then BatchData REVERSE skip trace, then PeopleData (wave 82 lane A + 93B2)",
  route({ hasEmailOrPhone: true }) === "versium,batchdata,peopledata"
  && resolveContactProviderRoute({ hasName: true, hasPropertyAddress: false, hasEmailOrPhone: true, hasProfileUrl: false }).capability === "reverse_contact")
check("a property address still routes the V3 (property-keyed) shape, even with a phone on the record",
  resolveContactProviderRoute({ hasName: true, hasPropertyAddress: true, hasEmailOrPhone: true, hasProfileUrl: false }).capability === "owner_contact")
check("name alone (no phone/email/address/location) → peopledata only (a bare name is not a Versium input)", route({ hasName: true }) === "peopledata")
check("name + location (city+state or ZIP) → versium, then peopledata (Versium's name + geography input)", route({ hasName: true, hasLocation: true }) === "versium,peopledata")
check("social profile URL alone → peopledata", route({ hasProfileUrl: true }) === "peopledata")
check("no identifier at all → refused (empty route, reason given)", route({}) === "" && /no identifier/.test(resolveContactProviderRoute({ hasName: false, hasPropertyAddress: false, hasEmailOrPhone: false, hasProfileUrl: false }).reason))
check("the reason names the prices it chose between", /\$0\.07/.test(resolveContactProviderRoute({ hasName: true, hasPropertyAddress: true, hasEmailOrPhone: false, hasProfileUrl: false }).reason))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2b · VERSIUM FIRST — executed; PeopleData only after a Versium miss (wave 93, lane 93B2)]")
{
  const { runVersiumContactLeg } = rail
  const asked: string[] = []
  const booked: any[] = []
  const hit = async (output: string) => { asked.push(output); return { ok: true, status: 200, data: { versium: { match_counts: { [output]: 1 }, results: [output === "email" ? { "Email Address": "owner@example.com" } : { Phone: "5125550142" }] } } } }
  const miss = async (output: string) => { asked.push(output); return { ok: true, status: 200, data: { versium: { match_counts: {}, results: [] } } } }
  const meter = async (m: any) => { booked.push(m) }
  // Wave 97 (97C): the leg now asks the vendor budget gate first — a stub that allows, so these
  // executions never reach the live ledger (the gate's own refusals are proved below).
  const allowBudget = async () => ({ allowed: true })
  const id = { firstName: "Ana", lastName: "Owner", address: "1 Main St", city: "Austin", state: "TX", zip: "78701" }
  const leadHit = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: hit as any, meter, checkBudget: allowBudget })
  check("EXECUTED: a LEAD asks Versium for the EMAIL only (leads get email + direct mail — a phone is never bought for a lead)",
    leadHit.answered && asked.join(",") === "email" && leadHit.emails[0] === "owner@example.com" && leadHit.phones.length === 0)
  check("EXECUTED: the hit is booked as vendor versium, usage contact_append, answered_by versium, at the transport's credit price",
    booked.length === 1 && booked[0].vendorName === "versium" && booked[0].usageType === "contact_append" && booked[0].metadata.answered_by === "versium" && booked[0].cost === vs.VERSIUM_MATCH_CREDIT_USD)
  asked.length = 0; booked.length = 0
  const contactHit = await runVersiumContactLeg({ brokerageId: "b-1", stage: "contact", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: hit as any, meter, checkBudget: allowBudget })
  check("EXECUTED: a CONTACT asks email, then phone (two matched outputs, two credits)", contactHit.answered && asked.join(",") === "email,phone" && contactHit.cost === 2 * vs.VERSIUM_MATCH_CREDIT_USD)
  asked.length = 0; booked.length = 0
  const missed = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: miss as any, meter, checkBudget: allowBudget })
  check("EXECUTED: a Versium MISS is free — not answered, $0, nothing booked (the chain continues)", !missed.answered && missed.cost === 0 && booked.length === 0)
  const nothing = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: true, hasPhone: false, systemSource: "proof" }, { call: hit as any, meter, checkBudget: allowBudget })
  check("EXECUTED: a lead that already HAS an email asks Versium nothing ($0)", nothing.skipped === "nothing_to_append" && nothing.cost === 0)
  const prevKey = process.env.VERSIUM_API_KEY
  delete process.env.VERSIUM_API_KEY
  const unconfigured = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { meter, checkBudget: allowBudget })
  if (prevKey !== undefined) process.env.VERSIUM_API_KEY = prevKey
  check("EXECUTED: Versium UNCONFIGURED → skipped 'unconfigured', no request, and the chain runs as today", unconfigured.skipped === "unconfigured" && !unconfigured.answered)

  // Wave 97 (lane 97C): the contact leg runs THE SAME vendor budget gate the financial rung runs
  // (checkVendorBudget), BEFORE the paid call, with the worst-case bill; a null tenant is refused.
  asked.length = 0; booked.length = 0
  const budgetAsks: any[] = []
  const deny = async (p: any) => { budgetAsks.push(p); return { allowed: false } }
  const allowB = async (p: any) => { budgetAsks.push(p); return { allowed: true } }
  const overBudget = await runVersiumContactLeg({ brokerageId: "b-1", stage: "contact", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: hit as any, meter, checkBudget: deny })
  check("EXECUTED: an over-budget tenant → skipped 'budget', Versium NOT asked, nothing booked, and the gate was asked for the worst case (2 outputs × one credit)",
    overBudget.skipped === "budget" && asked.length === 0 && booked.length === 0 && budgetAsks[0]?.brokerageId === "b-1" && budgetAsks[0]?.addCost === 2 * vs.VERSIUM_MATCH_CREDIT_USD)
  const noTenant = await runVersiumContactLeg({ brokerageId: null, stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: hit as any, meter, checkBudget: allowB })
  check("EXECUTED: a null tenant → skipped 'no_brokerage' (no budget to check, no ledger row to book — fail closed), Versium NOT asked",
    noTenant.skipped === "no_brokerage" && asked.length === 0)
  const throwing = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: hit as any, meter, checkBudget: async () => { throw new Error("gate down") } })
  check("EXECUTED: a budget gate that cannot run REFUSES (budget_unavailable), Versium NOT asked", /^budget_unavailable/.test(throwing.skipped ?? "") && asked.length === 0)
  const allowedLeg = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: hit as any, meter, checkBudget: allowB })
  check("POSITIVE CONTROL: the same call with the gate ALLOWING asks Versium and answers (the gate discriminates, it does not strip)",
    allowedLeg.answered && asked.join(",") === "email")
  const railSrc = stripped("lib/ai-isa/property-lookup-rail.ts"), hfSrc = stripped("lib/enrichment/household-financials.ts")
  const GATE = /import\("@\/lib\/vendor-governance\/budget-gate"\)\)\.checkVendorBudget\(p\)/
  check("the contact leg and the financial rung default to the SAME gate function (budget-gate.ts::checkVendorBudget), asked before appendVersiumContact",
    GATE.test(railSrc) && GATE.test(hfSrc) && railSrc.indexOf("checkVendorBudget(p)") < railSrc.indexOf("await appendVersiumContact("))

  // The two enrichment paths: PeopleData is reached ONLY after a Versium miss.
  const orchS = stripped("lib/lead-pipeline/enrichment-orchestrator.ts")
  const iV = orchS.indexOf("await runVersiumContactLeg("), iB = orchS.indexOf("skipTraceBatchDataV3Batch("), iP = orchS.indexOf("await skipTraceWithPeopleData(")
  check("the drain runs the Versium leg FIRST (when the route names it), then BatchData, then PeopleData — source order",
    iV > -1 && iB > iV && iP > iB && /if \((?:contactPointLegs && )?route\.providers\[0\] === 'versium'\) \{\s*const v = await runVersiumContactLeg\(/.test(orchS)
    && /if \(v\.answered\) batchDataFallback = \{ phones: v\.phones, emails: v\.emails, via: 'versium' \}/.test(orchS))
  const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
  const iVr = pp.indexOf("runVersiumContactLeg("), iPr = pp.indexOf("await skipTraceWithPeopleData(")
  check("the raw-record promotion runs the SAME Versium leg BEFORE PeopleData, and a Versium answer skips PeopleData and its meter",
    iVr > -1 && iPr > iVr && /const enrichmentResult = skipPeopleData \|\| versiumAnswered\s*\?\s*\{ data: null \}/.test(pp)
    && /if \(!skipPeopleData && !versiumAnswered && fields\.brokerageId/.test(pp))
  // POSITIVE CONTROL — replay the decision on both outcomes: PeopleData is called only after a miss.
  const pdlCalledAfter = (versiumAnswered: boolean, demographicsRuling: boolean) => {
    const via = versiumAnswered ? "versium" : null
    const batchDataFallback = via ? { via } : null
    return !batchDataFallback || (demographicsRuling && batchDataFallback.via !== "versium")
  }
  check("POSITIVE CONTROL: PeopleData is called after a Versium MISS and NOT after a Versium HIT (even under the demographics ruling)",
    pdlCalledAfter(false, true) === true && pdlCalledAfter(true, true) === false && pdlCalledAfter(true, false) === false)
  const oldGuard = (versiumAnswered: boolean) => { const batchDataFallback = versiumAnswered ? { via: "versium" } : null; return !batchDataFallback || true }
  check("POSITIVE CONTROL: the pre-93B2 guard (!match || DEMOGRAPHICS_AFTER_CONTACT_MATCH) WOULD call PeopleData after a Versium hit — the finder flags that shape",
    oldGuard(true) === true && !/\(!batchDataFallback \|\| DEMOGRAPHICS_AFTER_CONTACT_MATCH\)/.test(orchS))
}

// Wave 96 (lane 96B — owner blueprint: "Versium behind OUR normalized capability contract, never raw
// vendor shapes leaking; provenance per field; credentials centralized, never in agent context").
console.log("\n[Layer 2c · VERSIUM CONTRACT — normalized results, provenance, credentials in the adapter only, refusals reported (wave 96, lane 96B)]")
{
  // The vendor's own field names: a returned object carrying any of these is a raw-shape leak.
  const RAW_VERSIUM_KEY = /"(Individual Level Match|Age Range|Household Income|Estimated Net Worth|Credit Rating|Email Address|Home Own\/Rent|match_counts|num_matches)"|"versium"\s*:\s*\{/
  const leaks = (o: unknown) => RAW_VERSIUM_KEY.test(JSON.stringify(o ?? null))
  const demoRow = { "Individual Level Match": "Yes", "Age Range": "35-44", Gender: "Female", "Household Income": "$100,000 - $149,999" }
  const demoCall = async (output: string) => ({ ok: true, status: 200, data: { versium: { match_counts: { [output]: 1 }, results: [demoRow] } } })
  check("POSITIVE CONTROL: the raw-shape finder flags a raw Versium row and a raw response body", leaks(demoRow) && leaks({ versium: { results: [] } }))
  const demo = await vs.appendVersiumDemographics({ email: "ana@example.com" }, ["demographic"], { call: demoCall as any })
  check("EXECUTED: the demographic append returns OUR profile (provider versium, captured_at), not the vendor's rows — no raw key, no `results` field",
    demo.profile?.provider === "versium" && typeof demo.profile?.captured_at === "string" && demo.profile?.age_range === "35-44" && !("results" in demo) && !leaks(demo),
    JSON.stringify(demo).slice(0, 200))
  check("EXECUTED: the demographic result carries provenance (source versium, capability person.enrich_demographics, retrievedAt, matchConfidence individual)",
    demo.provenance?.source === "versium" && demo.provenance?.capability === "person.enrich_demographics" && !Number.isNaN(Date.parse(demo.provenance?.retrievedAt ?? "")) && demo.provenance?.matchConfidence === "individual")
  const contactCall = async (output: string) => ({ ok: true, status: 200, data: { versium: { match_counts: { [output]: 1 }, results: [output === "email" ? { "Email Address": "ana@example.com" } : { Phone: "5125550100" }] } } })
  const c = await vs.appendVersiumContact({ email: null, firstName: "Ana", lastName: "Owner", zip: "78701" }, ["email", "phone"], { call: contactCall as any })
  check("EXECUTED: the contact append returns normalized points + provenance per field (no level in the contact output → matchConfidence null, never invented)",
    c.emails[0] === "ana@example.com" && c.phones[0] === "5125550100" && c.provenance.email?.capability === "person.enrich_contact" && c.provenance.phone?.source === "versium"
      && c.provenance.email?.matchConfidence === null && !leaks(c))
  // Refusals: a 429 / timeout is READ and reported, books nothing, and is never a match.
  const refused = await vs.appendVersiumContact({ email: null, firstName: "Ana", lastName: "Owner", zip: "78701" }, ["email"], { call: (async () => ({ ok: false, status: 429, data: null, error: "rate limited" })) as any })
  const timedOut = await vs.appendVersiumContact({ email: null, firstName: "Ana", lastName: "Owner", zip: "78701" }, ["email"], { call: (async () => ({ ok: false, status: null, data: null })) as any })
  check("EXECUTED: a 429 and a timeout are reported by name, cost $0, no match",
    /429/.test(refused.error ?? "") && refused.cost === 0 && !refused.matched && /timeout/.test(timedOut.error ?? "") && timedOut.cost === 0)
  // Retry only where idempotent: Versium is GET-only and the connector gateway retries GET alone.
  const gw = stripped("lib/agentic-os/connector-gateway.ts")
  const methods = stripped("lib/external/versium-client.ts").match(/method: "(\w+)"/g) ?? []
  check(`retry is bounded and GET-only (idempotent) in the ONE egress the adapter uses; the adapter issues GETs only (${methods.length} request sites)`,
    /if \(method !== "GET"\) return attempt\(\)/.test(gw) && methods.length >= 3 && methods.every((m) => m === 'method: "GET"'))
  // The leg: provenance rides the profile; every booking names the capability; an unbooked spend is reported.
  const booked2: any[] = [], warned: string[] = []
  const origWarn = console.warn
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")) }
  const leg = await rail.runVersiumContactLeg(
    { brokerageId: "b-1", stage: "lead", identity: { firstName: "Ana", lastName: "Owner", zip: "78701" }, hasEmail: false, hasPhone: false, systemSource: "proof" },
    { call: contactCall as any, demographicCall: demoCall as any, meter: async (m: any) => { booked2.push(m); return false }, checkBudget: async () => ({ allowed: true }) },
  )
  console.warn = origWarn
  check("EXECUTED: the leg returns fieldProvenance (email + demographics) and writes it INTO the profile as field_provenance; no raw key leaks",
    leg.fieldProvenance.email?.source === "versium" && leg.fieldProvenance.demographics?.capability === "person.enrich_demographics"
      && leg.demographicsProfile?.field_provenance?.email?.source === "versium" && !leaks(leg))
  check("EXECUTED: every Versium ledger booking names provider + capability + cost",
    booked2.length >= 2 && booked2.every((b) => b.vendorName === "versium" && typeof b.metadata?.capability === "string" && b.metadata.capability.startsWith("person.") && b.cost > 0))
  check("EXECUTED: a booking the ledger REFUSED (meter → false) is reported, not swallowed", warned.some((w) => /NOT booked/.test(w)), `warnings: ${warned.length}`)
  check("the leg reads OUR profile from the adapter (demo.profile), never the vendor rows (demo.results / buildVersiumDemographicProfile in the rail)",
    /demographicsProfile = demo\.profile/.test(code("lib/ai-isa/property-lookup-rail.ts")) && !/demo\.results|buildVersiumDemographicProfile\(/.test(code("lib/ai-isa/property-lookup-rail.ts")))
  check("POSITIVE CONTROL: the raw-read finder flags the pre-96 rail shape", /demo\.results|buildVersiumDemographicProfile\(/.test("demographicsProfile = buildVersiumDemographicProfile(demo.results)"))
  // Credentials: read in the adapter only — never in a tool, an agent prompt, or another module.
  const KEY_READ = /process\.env\.VERSIUM_API_KEY|process\.env\[\s*["']VERSIUM_API_KEY["']\s*\]/
  const keyReaders = CORPUS.filter((p) => KEY_READ.test(stripped(p)))
  check(`VERSIUM_API_KEY is read in exactly one module — the adapter (readers: ${keyReaders.join(", ") || "none"}; corpus ${CORPUS.length} app/lib files)`,
    keyReaders.length === 1 && keyReaders[0].endsWith("lib/external/versium-client.ts"))
  check("POSITIVE CONTROL: the key-read finder flags a non-adapter read", KEY_READ.test("if (!params.deps?.append && !process.env.VERSIUM_API_KEY) return"))
  // Gap-only: the drain passes what is held; the orchestrator writes provenance where the value lands.
  const orchP = code("lib/lead-pipeline/enrichment-orchestrator.ts")
  check("the drain writes the Versium provenance into enrichment_profile.field_provenance beside the stored values",
    /versiumFieldProvenance = v\.fieldProvenance/.test(orchP) && /field_provenance: \{/.test(orchP) && /enrichment_profile: provenanceProfile/.test(orchP))
  console.log("  blind spots: Versium's live contact-output field names are UNRESOLVED (no paid call); the raw-key list is the documented API's names; enrichment_profile.field_provenance has no reader yet (the contact card does not show it); demographics are not refreshed by age (wave 92: recency only where data is time-sensitive).")
}

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
// Re-anchored (wave 93, lane 93B2): PeopleData is asked ONLY AFTER A VERSIUM MISS — never after a
// Versium hit; the lane-83A demographics leg still follows a BatchData match (reached only after a
// Versium miss). BatchData runs only when no earlier leg (Versium) answered.
check("the PeopleData call is guarded on the route naming it, and on a contact-point miss OR the demographics ruling after a NON-Versium match (lane 83A + 93B2)",
  /const askPeopleData = route\.providers\.includes\('peopledata'\)\s*&& \(!batchDataFallback \|\| \(DEMOGRAPHICS_AFTER_CONTACT_MATCH && batchDataFallback\.via !== 'versium'\)\)/.test(orchStr)
  && /askPeopleData\s*\?\s*await skipTraceWithPeopleData\(/.test(orchStr))
check("the BatchData leg runs only when no earlier leg answered and the route names it, and declares purpose 'skip_trace'",
  /!batchDataFallback && (?:contactPointLegs && )?route\.providers\.includes\('batchdata'\)[\s\S]{0,120}resolveBatchDataAccess\(\{ brokerageId, purpose: 'skip_trace' \}\)/.test(orchStr))
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
// Re-anchored wave 92 (lane 92B): "valuation" LEFT the carve-out — property reads are RentCast's
// (owner 2026-10-01: "batchdata is to be used more for scrapping leads"). The gate REFUSES it under
// every policy, so a regression cannot quietly reopen the reach.
check("BATCHDATA_ELIGIBLE_PURPOSES = acquisition / skip_trace / dnc (LEAD work only)", [...BATCHDATA_ELIGIBLE_PURPOSES].sort().join(",") === "acquisition,dnc,skip_trace")
check("valuation: REFUSED under every policy (allowing, no opt-in, off, tenant-less)",
  !d("valuation", ALLOW) && !d("valuation", NO_OPT) && !d("valuation", OFF) && !d("valuation", ALLOW, null))
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
  // Wave 92 (lane 92B): the four valuation files moved to RentCast — no BatchData reach at all.
  { file: "lib/cma/comp-provider.ts", expect: "no_reach" },
  { file: "lib/avm/provider-chain.ts", expect: "no_reach" },
  { file: "lib/agentic-os/deal-investigator.ts", expect: "no_reach" },
  { file: "lib/offers/public-record-preload.ts", expect: "no_reach" },
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
check("lib/kernel/offer-net-sheet.ts hands the listing's OWN tenant to the preload (RentCast is metered per tenant; a tenant-less read is refused)",
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
console.log("\n[Layer 10 · the AVM chain is the property_valuation CAPABILITY on the same router (wave 99, 99C, LAW 3)]")
{
  const rcMod = await import("../lib/property/rentcast")
  const pv = CONTACT_PROVIDER_ROUTES.property_valuation
  check("property_valuation: RentCast PRIMARY, BatchData the BACKUP — exactly two providers, in the owner's order",
    pv.length === 2 && pv[0].provider === "rentcast" && pv[1].provider === "batchdata")
  check("property_valuation costs ARE the transport constants (RENTCAST_USD_PER_REQUEST, BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD — what fetchBatchDataPropertyFallback books) — no second spelling",
    pv[0].unitCostUsd === rcMod.RENTCAST_USD_PER_REQUEST && pv[1].unitCostUsd === bd.BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD)
  check("the rail's RentCast rung cost and the property_valuation entry are ONE value (the rung table reads the same constant)",
    rail.PROPERTY_LOOKUP_RUNG_COST_USD.rentcast.usd === pv[0].unitCostUsd)
  const H = (routeAround: boolean) => ({ state: routeAround ? "failing" : "healthy", routeAround, reason: "proof" })
  const healthy = rail.routeCapability("property_valuation", { rentcast: H(false), batchdata: H(false) })
  const noEvidence = rail.routeCapability("property_valuation", {})
  check("routeCapability: all providers healthy (or no evidence) → the table order, nothing skipped (behaviour unchanged)",
    healthy.providers.join(",") === "rentcast,batchdata" && healthy.skipped.length === 0 && noEvidence.providers.join(",") === "rentcast,batchdata")
  const failingRc = rail.routeCapability("property_valuation", { rentcast: H(true), batchdata: H(false) })
  check("routeCapability: a FAILING RentCast is skipped with a provider_failing reason; BatchData stays on the route (POSITIVE CONTROL for the healthy case above)",
    failingRc.providers.join(",") === "batchdata" && failingRc.skipped.length === 1 && failingRc.skipped[0].provider === "rentcast" && /provider_failing/.test(failingRc.skipped[0].reason))
  const excluded = rail.routeCapability("property_valuation", { rentcast: H(false) }, new Set(["batchdata"]))
  check("routeCapability: a caller exclusion (AI-agent surfaces keep BatchData out) is honoured and said",
    excluded.providers.join(",") === "rentcast" && excluded.skipped.some((x) => x.provider === "batchdata" && /excluded/.test(x.reason)))
  check("routeCapability is generic over the ONE table: owner_contact with a failing Versium routes BatchData → PeopleData",
    rail.routeCapability("owner_contact", { versium: H(true) }).providers.join(",") === "batchdata,peopledata")
  // No caller asks the vendor: a direct getRentcastAVM( outside its own client and the capability.
  const AVM_VENDOR_CALL = /\bgetRentcastAVM\s*\(/
  const AVM_ALLOWED = new Set(["lib/property/rentcast.ts", "lib/avm/provider-chain.ts"])
  const direct = CORPUS.filter((p) => !AVM_ALLOWED.has(p) && AVM_VENDOR_CALL.test(code(p)))
  check(`no caller under app/ lib/ asks the RentCast AVM vendor directly — every AVM request rides the capability (scanned ${CORPUS.length} files; allowed: ${[...AVM_ALLOWED].join(", ")})`,
    direct.length === 0, direct.join(", "))
  check("POSITIVE CONTROL: a direct vendor call IS flagged; the same token in a comment or a string is NOT",
    AVM_VENDOR_CALL.test(blankStrings(stripComments("const a = await getRentcastAVM({ brokerageId, address })")))
    && !AVM_VENDOR_CALL.test(blankStrings(stripComments("// getRentcastAVM(x) was here\nconst s = \"getRentcastAVM(\"\n"))))
  const chain = code("lib/avm/provider-chain.ts")
  check("WIRED: getCurrentAvm asks the capability (requestPropertyValuation) — the inline RentCast/BatchData tiers are gone",
    /export async function getCurrentAvm[\s\S]{0,1600}?requestPropertyValuation\(/.test(chain)
    && !/export async function getCurrentAvm[\s\S]{0,2400}?tryRentcast\(req\)/.test(chain))
  check("WIRED: the capability reads provider health (loadProviderHealth) and routes with routeCapability over CONTACT_PROVIDER_ROUTES.property_valuation",
    /loadProviderHealth\(/.test(chain) && /routeCapability\(/.test(chain) && /CONTACT_PROVIDER_ROUTES\.property_valuation/.test(chain))
}

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
