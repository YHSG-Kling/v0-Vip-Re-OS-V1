#!/usr/bin/env tsx
/**
 * scripts/versium-capability-matrix-guard.ts   (npm run test:versium-capability-matrix) — wave 143, lane 143D.
 * ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * VERSIUM, EVERY PRODUCT, ONE ROUTE TABLE — AND THE LOOK-ALIKE RESEARCH THAT READS WHAT IT BUYS.
 * Owner (wave 143): "Use ALL Versium features including online behaviour; Vercel AI Gateway is the AI route; Versium as an
 * AI tool; consider Versium for lead-acquisition steps. Do NOT restrict look-alike research — research what customers have
 * in common, then create content to attract look-alikes and feed lead acquisition (research ≠ ad targeting; targeting /
 * outbound keep their legal / privacy / platform checks)." No database, no network: every vendor call is an injected
 * seam carrying the vendor's DOCUMENTED response shape (api-documentation.versium.com, read 2026-10-23), every table is
 * scripts/in-memory-supabase.ts, and the service env is scrubbed so nothing can reach the live project.
 *
 *  A. THE MATRIX — every product has an id, a status, a docs URL on a Versium host; every capability a product names is a
 *     row of CONTACT_PROVIDER_ROUTES that names versium, and every route that names versium is a product (both directions);
 *     WIRED products have a caller whose stripped source names the symbol; credit keys exist in VERSIUM_CREDIT_WEIGHTS.
 *     POSITIVE CONTROLS: a planted matrix with a phantom caller, a phantom capability and an unrouted capability is caught.
 *  B. THE BILLS — the published weights (full_demographic 3, B2B2C business_email 2, crosswalk once) are what the adapter
 *     books; the pre-flight worst case asks for the same number; a billed match whose row carries none of the documented
 *     names is `b2b2c_schema_drift`, never read as free; a no-match is $0.
 *  C. THE B2B2C CONTRACT — the result-row field names are the documented ones (EmailAddrJSONB2B …), a landline is dropped.
 *  D. THE AUDIENCE ESTIMATE — free, geography + housing facts only, repeated keys on the path, NO preview; every vendor
 *     filter that names a protected characteristic is refused by name and the call is never made.
 *  E. THE RESEARCH (pure) — the whole picture (distribution + coverage), person traits SHOWN but never DRIVING a brief or an
 *     acquisition input, protected values dropped, no `targeting`, a 3-customer seed (below the ad MIN_SEED) still researched.
 *  F. THE RESEARCH RUN over the in-memory database — consent exclusions, tenant isolation, a refused read is an error not an
 *     empty seed, the bounded gap-only online-presence pass (live-deal suppression, budget stop, off switch), briefs in
 *     content_topic_bank, INACTIVE keywords, one ledgered action per week, idempotent re-runs, columns that exist.
 *  G. THE AD DRAFT carries no research block (research ≠ targeting).
 *  H. THE STORE — indicators persist tenant-anchored, gap-only, with provenance, read back through the allow-list.
 *  I. THE MCP VERDICT is data, re-proved against the live server's OAuth metadata, and the scanner's colleague rule.
 * BLIND SPOTS (published): no Versium credential exists in this environment, so NO live Versium call is made — every
 * response is the vendor's documented sample re-typed (the b2b2c-output-sample page carries Cloudflare-obfuscated
 * e-mails, so addresses here are fixtures); the credit WEIGHTS are read from the vendor's own conversion table, not
 * measured on an invoice; Predictive Scores' weight is unpublished and stays WAITING_EXTERNAL; the research is not run
 * against real customers (the live database has 0 closed deals); `after()` is proved outside a request scope only (the
 * request-scope path is Next's); content_topic_bank / lead_scraping_keywords RLS is not exercised by the fake.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  VERSIUM_PRODUCT_MATRIX, versiumProductsByStatus, VERSIUM_CREDIT_WEIGHTS, VERSIUM_MATCH_CREDIT_USD, VERSIUM_REACH_MCP,
  appendVersiumB2B2C, appendVersiumRealEstateIndicators, estimateVersiumAudience, versiumB2B2CWorstCaseCredits,
  type VersiumProduct, type VersiumAudienceFilters,
} from "../lib/external/versium-client"
import {
  CONTACT_PROVIDER_ROUTES, FREE_CAPABILITIES, runVersiumBusinessIdentityLeg, runVersiumOnlinePresenceLeg, runVersiumAudienceEstimateLeg,
} from "../lib/ai-isa/property-lookup-rail"
import {
  researchLookalikeDenominators, composeResearchBriefs, composeAcquisitionInputs, lookalikeSeedProfile,
  LOOKALIKE_RESEARCH_ATTRIBUTES, LOOKALIKE_PROTECTED_CATEGORIES, LOOKALIKE_AD_POLICY, RESEARCH_MIN_SEED,
} from "../lib/kernel/lookalike-research"
import {
  runLookalikeResearch, runLookalikeAudience, LOOKALIKE_SEED_CONTACT_COLUMNS, LOOKALIKE_SEED_DEAL_COLUMNS, LOOKALIKE_RESEARCH_ENRICH_MAX_PER_RUN, MIN_SEED,
} from "../lib/kernel/lookalike-audience"
import { persistRealEstateIndicators, realEstateIndicatorsFromProfile, REAL_ESTATE_INDICATORS_KEY } from "../lib/enrichment/online-presence-store"
import { isExistingTenantMember } from "../lib/contacts/card-classifier"
import { KEYWORD_SOURCE_KEYS, KEYWORD_TYPE_INTENT } from "../lib/lead-pipeline/scrape-keywords"

// NO LIVE PROJECT, NO LIVE VENDOR.
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
delete process.env.VERSIUM_API_KEY

let pass = 0, fail = 0
const failures: string[] = []
const ok = (c: unknown, m: string, extra?: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; failures.push(m); console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`) } }
const ROOT = process.cwd()
const readSrc = (p: string) => readFileSync(join(ROOT, p), "utf8")
const strippedSrc = (p: string) => stripComments(readSrc(p))
const round2 = (n: number) => Math.round(n * 100) / 100

/** A healthy-provider fixture in the shape the rail's seam takes (connector-gateway.ts loadProviderHealth). */
const healthy = async () => ({ state: "healthy", routeAround: false, reason: "guard fixture — the vendor is not in a cool-down" })
const B = "b0000000-0000-4000-8000-000000000001", OTHER = "b0000000-0000-4000-8000-000000000002"
const U = (n: number, p = "c") => `${p}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n━━━ A · the product matrix against the ONE route table ━━━")
type RouteMap = Readonly<Record<string, ReadonlyArray<{ provider: string; unitCostUsd: number }>>>
/** PURE — every fault of a matrix against a route table and a source reader. The positive controls below plant each fault. */
function matrixFaults(matrix: readonly VersiumProduct[], routes: RouteMap, stripped: (file: string) => string | null, free: ReadonlySet<string>): string[] {
  const faults: string[] = []
  const ids = new Set<string>()
  const STATUSES = new Set(["WIRED", "WIRED_143D", "POLICY_GATED", "OWNER_DECISION", "WAITING_EXTERNAL", "NOT_ROUTED_SURVIVOR", "NOT_BUILT_NO_CALLER", "NOT_APPLICABLE"])
  for (const p of matrix) {
    if (ids.has(p.id)) faults.push(`${p.id}: duplicate id`)
    ids.add(p.id)
    if (!STATUSES.has(p.status)) faults.push(`${p.id}: status ${p.status} is not in the vocabulary`)
    if (!/^https:\/\/(api-documentation\.versium\.com|versium\.com|reach-help\.versium\.com)\//.test(p.docs)) faults.push(`${p.id}: docs URL is not an official Versium host (${p.docs})`)
    if (p.note.trim().length < 40) faults.push(`${p.id}: no published reason (note shorter than 40 chars)`)
    for (const k of p.creditKeys ?? []) if (!(k in VERSIUM_CREDIT_WEIGHTS)) faults.push(`${p.id}: credit key ${k} is not in VERSIUM_CREDIT_WEIGHTS`)
    for (const cap of [p.capability, ...(p.alsoCapabilities ?? [])].filter((c): c is string => !!c)) {
      const route = routes[cap]
      if (!route) faults.push(`${p.id}: capability ${cap} is not a row of CONTACT_PROVIDER_ROUTES`)
      else if (p.status === "NOT_ROUTED_SURVIVOR") { if (route.some((e) => e.provider === "versium")) faults.push(`${p.id}: NOT_ROUTED_SURVIVOR but capability ${cap} names versium (then it is routed — change the status)`) }
      else if (!route.some((e) => e.provider === "versium")) faults.push(`${p.id}: capability ${cap} does not name versium`)
    }
    const wired = p.status === "WIRED" || p.status === "WIRED_143D"
    if (wired) {
      if (!p.capability) faults.push(`${p.id}: WIRED with no capability`)
      if (!p.caller) faults.push(`${p.id}: WIRED with no caller`)
      else {
        const src = stripped(p.caller.file)
        if (src === null) faults.push(`${p.id}: caller file ${p.caller.file} does not exist`)
        else if (!new RegExp(`\\b${p.caller.symbol}\\b`).test(src)) faults.push(`${p.id}: caller ${p.caller.file} never names ${p.caller.symbol} (stripped source)`)
      }
      if (p.creditKeys === null && !(p.capability && free.has(p.capability))) faults.push(`${p.id}: WIRED paid product with no credit keys`)
    } else if (p.caller) faults.push(`${p.id}: ${p.status} but names a caller (a not-wired product has none)`)
    if (p.status === "NOT_APPLICABLE" || p.status === "WAITING_EXTERNAL" || p.status === "OWNER_DECISION") { /* reason lives in note, checked above */ }
  }
  // the reverse direction: every route row that names versium is a product
  for (const [cap, entries] of Object.entries(routes)) {
    if (entries.some((e) => e.provider === "versium") && !matrix.some((p) => p.status !== "NOT_ROUTED_SURVIVOR" && (p.capability === cap || (p.alsoCapabilities ?? []).includes(cap)))) faults.push(`route ${cap} names versium but no product serves it`)
  }
  return faults
}
const stripFile = (file: string) => (existsSync(join(ROOT, file)) ? strippedSrc(file) : null)
{
  const faults = matrixFaults(VERSIUM_PRODUCT_MATRIX, CONTACT_PROVIDER_ROUTES as unknown as RouteMap, stripFile, new Set(FREE_CAPABILITIES.keys()))
  ok(faults.length === 0, `the matrix is consistent with the ONE route table (${VERSIUM_PRODUCT_MATRIX.length} products, ${faults.length} faults)`, faults.join(" | "))
  const planted: VersiumProduct[] = [
    { ...VERSIUM_PRODUCT_MATRIX[0], id: "planted_phantom_caller", caller: { file: "lib/external/versium-client.ts", symbol: "thisSymbolDoesNotExistAnywhere" } },
    { ...VERSIUM_PRODUCT_MATRIX[0], id: "planted_phantom_capability", capability: "no_such_capability" },
    { ...VERSIUM_PRODUCT_MATRIX[0], id: "planted_wrong_provider", capability: "person_profile" },
    { ...VERSIUM_PRODUCT_MATRIX[0], id: "planted_notwired_with_caller", status: "NOT_BUILT_NO_CALLER" as const },
    { ...VERSIUM_PRODUCT_MATRIX[0], id: "planted_bad_docs", docs: "https://example.com/docs" },
  ]
  const f = matrixFaults(planted, CONTACT_PROVIDER_ROUTES as unknown as RouteMap, stripFile, new Set())
  ok(["phantom_caller", "phantom_capability", "wrong_provider", "notwired_with_caller", "bad_docs"].every((k) => f.some((x) => x.startsWith(`planted_${k}:`))), "POSITIVE CONTROL: a phantom caller, a phantom capability, a provider off the route, a not-wired product with a caller and a non-Versium docs host are each caught", f.join(" | "))
  const unrouted = matrixFaults(VERSIUM_PRODUCT_MATRIX.filter((p) => p.capability !== "audience_estimate"), CONTACT_PROVIDER_ROUTES as unknown as RouteMap, stripFile, new Set(FREE_CAPABILITIES.keys()))
  ok(unrouted.some((x) => x.startsWith("route audience_estimate names versium")), "POSITIVE CONTROL: a versium route row with no product behind it is caught (the reverse direction)")
  const survivorLie = matrixFaults([{ ...VERSIUM_PRODUCT_MATRIX[0], id: "planted_survivor_lie", status: "NOT_ROUTED_SURVIVOR" as const, caller: null, capability: "owner_contact" }], CONTACT_PROVIDER_ROUTES as unknown as RouteMap, stripFile, new Set())
  ok(survivorLie.some((x) => /NOT_ROUTED_SURVIVOR but capability owner_contact names versium/.test(x)), "POSITIVE CONTROL: a product declared NOT_ROUTED_SURVIVOR whose capability DOES name versium is caught")
  // The product list covers the vendor's own index (api-documentation.versium.com/llms.txt, read 2026-10-23): Contact Append,
  // Demographic Append (+ Full Demographic Insights), Online Audience Append, Firmographic, C2B, B2B2C, IP-to-Domain,
  // HEM-to-Business-Domain, ABM list, B2C ListGen (+ Estimates), B2B Persona list, Predictive Scores, Suppression Lists,
  // Data Prep, Dedupe, Email Validation, the bulk job API — plus the REACH MCP and the (non-existent) SDK.
  const EXPECTED = ["contact_append", "demographic_append", "property_facts", "full_demographic", "b2b2c_append", "b2c_listgen_estimate", "b2c_listgen_job", "bulk_append_jobs", "online_audience_append", "predictive_scores", "email_validation", "b2b_append_family", "visitor_to_company", "abm_persona_listgen", "dataprep_dedupe", "suppression_lists", "reach_mcp", "sdk"]
  const have = new Set(VERSIUM_PRODUCT_MATRIX.map((p) => p.id))
  ok(EXPECTED.every((id) => have.has(id)) && have.size === VERSIUM_PRODUCT_MATRIX.length, `every product family in the vendor's published index is a matrix row (${EXPECTED.length} expected, ${have.size} present)`, EXPECTED.filter((id) => !have.has(id)).join(","))
  const byStatus = (s: Parameters<typeof versiumProductsByStatus>[0]) => versiumProductsByStatus(s).map((p) => p.id)
  ok(byStatus("WAITING_EXTERNAL").includes("predictive_scores") && byStatus("WAITING_EXTERNAL").includes("reach_mcp") && byStatus("OWNER_DECISION").includes("b2c_listgen_job") && byStatus("POLICY_GATED").includes("online_audience_append"),
    `the blocked products are named with their reason: waiting ${byStatus("WAITING_EXTERNAL").join(", ")}; owner decision ${byStatus("OWNER_DECISION").join(", ")}; policy-gated ${byStatus("POLICY_GATED").join(", ")}`)
  ok(!versiumProductsByStatus("WAITING_EXTERNAL").some((p) => p.capability !== null), "a product waiting on a credential / price / person is mapped to NO capability (nothing routes to a rail that cannot run)")
  ok(/online behaviour|Online Presence Indicator/i.test(VERSIUM_PRODUCT_MATRIX.find((p) => p.id === "full_demographic")?.name ?? "") && VERSIUM_PRODUCT_MATRIX.find((p) => p.id === "full_demographic")?.status === "WIRED_143D", "online behaviour (the Online Presence Indicator — Real Estate) is a WIRED product with a stored result and a reader")
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n━━━ B · the bills: published credit weights, booked and pre-flighted ━━━")
const USD = VERSIUM_MATCH_CREDIT_USD
{
  ok(VERSIUM_CREDIT_WEIGHTS.full_demographic === 3 && VERSIUM_CREDIT_WEIGHTS.b2b2c_business_email === 2 && VERSIUM_CREDIT_WEIGHTS.b2b2c_crosswalk === 1 && VERSIUM_CREDIT_WEIGHTS.email_validation === 0.5,
    "the weights are the vendor's published table (Match Credits Value Conversion Table, 2026-10-23): full demographic 3, B2B2C business e-mail 2, crosswalk 1, e-mail validation 0.5")
  const fullRow = { "Online Presence Indicator - Real Estate": "Yes", "Investing Real Estate": "Yes", "Home Own or Rent": "Own", "Length of Residence": "15+ Years", "Ethnicity": "X", "Religion": "Y", "Presence of Children": "Yes", "Online Purchasing Indicator": "No" }
  const matched = await appendVersiumRealEstateIndicators({ email: "pat@example.test" }, { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { full_demographic: 1 }, num_results: 1, results: [fullRow] } } }) })
  ok(matched.credits === 3 && matched.cost === round2(3 * USD), `one matched full_demographic record books 3 credits = $${matched.cost} (it booked 1 credit = $${USD} before 143D)`)
  ok(matched.indicators?.onlinePresenceRealEstate === true && matched.indicators?.investingRealEstate === true && matched.indicators?.homeOwnRent === "owner" && matched.indicators?.lengthOfResidence === "15+ Years", "the allow-listed indicators are mapped")
  ok(!JSON.stringify(matched).match(/Ethnicity|Religion|Children|"X"|"Y"/), "…and every protected field of the SAME row (ethnicity, religion, children) never leaves the adapter")
  const none = await appendVersiumRealEstateIndicators({ email: "pat@example.test" }, { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { full_demographic: 0 }, num_results: 0, results: [] } } }) })
  ok(none.credits === 0 && none.cost === 0, "a no-match books $0")

  // B2B2C — the documented response, re-typed (field names and counts are the vendor's; addresses are fixtures)
  const docResponse = (extra: Record<string, unknown> = {}) => ({
    versium: {
      version: "2.0",
      match_counts: { business_email: 1, consumer_mobile: 1, consumer_email: 1, consumer_address: 1, crosswalk: 1 },
      num_matches: 5, num_results: 1,
      results: [{
        EmailAddrJSONB2B: [{ EmailAddr: "Jane.Doe@acme-realty.test" }],
        PhoneJSONB2C: [{ Phone: "5551234567", LineType: "Mobile", Carrier: "CELLCO PARTNERSHIP DBA VERIZON WIRELESS - NE", CarrierParent: "Verizon" }],
        EmailAddrJSONB2C: [{ EmailAddr: "jane.doe@homemail.test" }],
        AddressB2C: "123 MAIN ST", CityB2C: "LINCOLN", StateB2C: "NE", ZipB2C: "68507", CountryB2C: "US",
        ...extra,
      }],
    },
  })
  const asked: string[] = []
  const r = await appendVersiumB2B2C({ firstName: "Jane", lastName: "Doe", city: "Lincoln", state: "NE" }, ["business_email", "consumer_mobile", "consumer_email", "consumer_address"], { call: async (output) => { asked.push(output); return { ok: true, status: 200, data: docResponse() } } })
  ok(r.businessEmails[0] === "jane.doe@acme-realty.test" && r.consumerEmails[0] === "jane.doe@homemail.test" && r.consumerMobiles[0] === "5551234567" && r.consumerAddress?.address === "123 MAIN ST" && r.consumerAddress?.zip === "68507",
    "THE DOCUMENTED FIELD NAMES parse: EmailAddrJSONB2B, EmailAddrJSONB2C, PhoneJSONB2C.Phone, AddressB2C/CityB2C/StateB2C/ZipB2C (the 142D parser read guessed names and parsed none of them)")
  ok(r.provenance.consumer_email?.capability === "person.enrich_business_identity", "…and each answered output carries provenance")
  // each request returned the all-outputs sample (counts 2+1+1+1+1 = 6 credits); 4 requests → 24 credits is the fixture's doing; assert the per-request math on ONE request
  const one = await appendVersiumB2B2C({ linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, ["business_email"], { call: async () => ({ ok: true, status: 200, data: docResponse() }) })
  ok(one.credits === 2 + 1 + 1 + 1 + 1 && one.cost === round2(6 * USD), `a response counting business_email 1 + mobile 1 + e-mail 1 + address 1 + crosswalk 1 bills Σ count × weight = 6 credits ($${one.cost}) — not "5 matches"`)
  const bizOnly = await appendVersiumB2B2C({ linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, ["business_email"], { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { business_email: 1, crosswalk: 0 }, num_results: 1, results: [{ EmailAddrJSONB2B: [{ EmailAddr: "jane@acme-realty.test" }] }] } } }) })
  ok(bizOnly.credits === 2 && bizOnly.cost === round2(2 * USD) && bizOnly.businessEmails.length === 1, "a business_email-only request bills 2 credits and NO crosswalk")
  const consumerOnly = await appendVersiumB2B2C({ linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, ["consumer_email"], { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { consumer_email: 1, crosswalk: 1 }, num_results: 1, results: [{ EmailAddrJSONB2C: [{ EmailAddr: "jane@homemail.test" }] }] } } }) })
  ok(consumerOnly.credits === 2 && consumerOnly.consumerEmails[0] === "jane@homemail.test", "a consumer_email request bills 1 + the crosswalk 1 = 2 credits (the scanner's default ask)")
  const noMatch = await appendVersiumB2B2C({ linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, ["consumer_email"], { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { consumer_email: 0, crosswalk: 0 }, num_matches: 0, num_results: 0, results: [] } } }) })
  ok(noMatch.credits === 0 && noMatch.cost === 0 && !noMatch.matched && !noMatch.error, "the documented zero-result response bills $0 and is not an error")
  // drift: billed, but the row uses a name the documentation does not
  const drift = await appendVersiumB2B2C({ linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, ["consumer_email"], { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { consumer_email: 1, crosswalk: 1 }, num_results: 1, results: [{ "Consumer Email": "jane@homemail.test" }] } } }) })
  ok(!drift.matched && drift.credits === 2 && drift.cost === round2(2 * USD) && /b2b2c_schema_drift/.test(drift.error ?? ""), "POSITIVE CONTROL: a BILLED match whose row uses an undocumented name is `b2b2c_schema_drift` and is still BOOKED ($0.10) — never read as free, never as 'no match'")
  const landline = await appendVersiumB2B2C({ linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, ["consumer_mobile"], { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { consumer_mobile: 1, crosswalk: 1 }, num_results: 1, results: [{ PhoneJSONB2C: [{ Phone: "5559876543", LineType: "Landline" }] }] } } }) })
  ok(landline.consumerMobiles.length === 0 && landline.credits === 2, "a non-mobile line is dropped (defence in depth over the vendor's 'mobile only'), while the vendor's charge is still booked")
  const refused = await appendVersiumB2B2C({ linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, ["consumer_email"], { call: async () => ({ ok: false, status: 400, data: null, error: "API group not enabled" }) })
  ok(refused.credits === 0 && /400/.test(refused.error ?? ""), "a refused call (a key without B2B2C access answers 400) bills nothing and says why")

  // pre-flight worst case == the number the bill will use
  ok(versiumB2B2CWorstCaseCredits(["business_email"]) === 2 && versiumB2B2CWorstCaseCredits(["consumer_email"]) === 2 && versiumB2B2CWorstCaseCredits(["consumer_email", "consumer_mobile"]) === 4 && versiumB2B2CWorstCaseCredits(["business_email", "consumer_address"]) === 4,
    "the worst case per request = the output's weight + the crosswalk for any consumer output (e-mail+mobile = two requests = 4)")
  const seen: number[] = []
  const budget = async (p: { brokerageId: string; addCost: number }) => { seen.push(p.addCost); return { allowed: false } }
  await runVersiumBusinessIdentityLeg({ brokerageId: B, identity: { linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, outputs: ["business_email"], systemSource: "guard" }, { call: async () => ({ ok: true, status: 200, data: {} }), checkBudget: budget, providerHealth: healthy })
  await runVersiumOnlinePresenceLeg({ brokerageId: B, identity: { email: "pat@example.test" }, systemSource: "guard" }, { call: async () => ({ ok: true, status: 200, data: {} }), checkBudget: budget, providerHealth: healthy })
  ok(seen[0] === round2(2 * USD) && seen[1] === round2(3 * USD), `the budget gate is asked for the REAL worst case BEFORE any credit is spent: business_email $${seen[0]} (2 credits; the old (1 + outputs) formula said 2 as well but for a different reason — it was 1 credit short on every multi-output ask), online presence $${seen[1]} (3 credits; the old ask was $${USD})`)
  const seenMulti: number[] = []
  await runVersiumBusinessIdentityLeg({ brokerageId: B, identity: { linkedinUrl: "https://www.linkedin.com/in/jane-doe-test" }, outputs: ["consumer_email", "consumer_mobile", "business_email"], systemSource: "guard" }, { call: async () => ({ ok: true, status: 200, data: {} }), checkBudget: async (p) => { seenMulti.push(p.addCost); return { allowed: false } }, providerHealth: healthy })
  ok(seenMulti[0] === round2(versiumB2B2CWorstCaseCredits(["consumer_email", "consumer_mobile", "business_email"]) * USD) && seenMulti[0] === round2(6 * USD), `a three-output ask is gated at 6 credits ($${seenMulti[0]}) — two consumer requests each re-pay the crosswalk; the old formula asked 4`)
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n━━━ D · the audience estimate: free, geography + housing facts, never a protected filter ━━━")
const ESTIMATE_DOC = { versium: { version: "2.0", query_id: "x", query_time: 0.3, results: { estimated_record_count: 20121, estimated_records_available: 20121, estimated_match_credits: 20121, estimated_time: "1-2 Minutes", estimated_time_in_seconds: 120, preview: [["First Name", "Last Name", "Email Address"], ["Mayank", "K******", "m******@gmail.com"]] } } }
{
  const calls: Array<{ path: string; query: Record<string, string> }> = []
  const filters: VersiumAudienceFilters = { zips: ["98052", "98033", "bad"], ownRent: ["H"], lengthOfResidenceYears: { min: 10, max: 20 }, householdIncomeBand: "O", requiredFields: ["address", "email"] }
  const est = await estimateVersiumAudience(filters, { call: async (path, query) => { calls.push({ path, query }); return { ok: true, status: 200, data: ESTIMATE_DOC } }, brokerageId: B })
  const c = calls[0]
  ok(est.estimatedRecords === 20121 && est.availableRecords === 20121 && est.estimatedMatchCredits === 20121 && est.cost === 0, "the documented estimate response parses (record count, available, estimated match credits) and costs $0")
  ok(!!c && c.path.startsWith("b2cListGen/estimate?") && c.path.includes("required_fields[]=address") && c.path.includes("required_fields[]=email") && c.path.includes("d_zip[]=98052&d_zip[]=98033") && !c.path.includes("bad") && c.path.includes("d_ownrent[]=H"),
    "REPEATED keys ride the path's query string exactly as the vendor documents them (d_zip[]=…&d_zip[]=…), a malformed ZIP is dropped", c?.path)
  ok(c?.query.d_lor === "10-20" && c?.query.d_esthhldincome === "O-O", "a lone band letter is sent as the vendor's range form (d_esthhldincome=O-O); length of residence as 10-20")
  ok(!/rcfg_show_preview/.test(JSON.stringify(c)) && !JSON.stringify(est).includes("Mayank"), "NO preview is requested and the masked sample rows the vendor may send are never returned (a count, never a person)")
  // refusals — the vendor's protected / proxy filters, each planted by its real parameter name
  const PROTECTED = ["d_gender", "d_ethnicgroup", "d_language", "d_religion", "d_presence_of_children", "d_num_children", "d_hhld_size", "d_singleparent", "d_senior_hhld", "d_youngadult_hhld", "d_workingwoman", "d_hhldveteran", "d_military_history", "d_maritalstatus", "d_education", "d_occupation"]
  let called = 0
  const refusals: string[] = []
  for (const name of [...PROTECTED, "gender", "ethnicity", "religion", "presenceOfChildren", "seniorHousehold", "politicalParty"]) {
    const r = await estimateVersiumAudience({ zips: ["98052"], [name]: "Y" } as unknown as VersiumAudienceFilters, { call: async () => { called++; return { ok: true, status: 200, data: ESTIMATE_DOC } } })
    if (r.skipped === "refused_filter" && r.refused.includes(name) && r.estimatedRecords === null) refusals.push(name)
  }
  ok(refusals.length === PROTECTED.length + 6 && called === 0, `all ${PROTECTED.length} protected-characteristic / proxy filters of the vendor's own filter page (+6 camel-case spellings) are REFUSED BY NAME and the vendor is never called`, `${refusals.length} refused, ${called} calls`)
  const noGeo = await estimateVersiumAudience({ ownRent: ["H"] }, { call: async () => { called++; return { ok: true, status: 200, data: ESTIMATE_DOC } } })
  ok(noGeo.skipped === "no_geography" && called === 0, "a nationwide estimate (no geography) is not asked")
  const unconfigured = await estimateVersiumAudience({ zips: ["98052"] })
  ok(unconfigured.skipped === "unconfigured" && unconfigured.estimatedRecords === null, "no VERSIUM_API_KEY and no injected call → skipped 'unconfigured', no network")
  const failed = await estimateVersiumAudience({ zips: ["98052"] }, { call: async () => ({ ok: false, status: 402, data: null, error: "credits" }) })
  ok(failed.estimatedRecords === null && /402/.test(failed.error ?? ""), "a vendor refusal is reported with its documented meaning (402), not a number")
  // the rail leg: capability routing, tenant, health
  const leg = await runVersiumAudienceEstimateLeg({ brokerageId: B, filters: { zips: ["98052"] } }, { call: async () => ({ ok: true, status: 200, data: ESTIMATE_DOC }), providerHealth: healthy })
  ok(leg.answered && leg.cost === 0 && leg.estimate?.estimatedRecords === 20121, "the capability leg answers through routeCapability('audience_estimate') at $0")
  ok((await runVersiumAudienceEstimateLeg({ brokerageId: null, filters: { zips: ["98052"] } }, { call: async () => ({ ok: true, status: 200, data: ESTIMATE_DOC }) })).skipped === "no_brokerage", "no tenant → no read (the log row is tenant-attributed)")
  const failing = await runVersiumAudienceEstimateLeg({ brokerageId: B, filters: { zips: ["98052"] } }, { call: async () => ({ ok: true, status: 200, data: ESTIMATE_DOC }), providerHealth: async () => ({ state: "failing", routeAround: true, reason: "5xx burst" }) })
  ok(!failing.answered && /provider_failing/.test(failing.skipped ?? ""), "a Versium in a failing cool-down is routed around (provider_failing)")
  ok(FREE_CAPABILITIES.has("audience_estimate") && CONTACT_PROVIDER_ROUTES.audience_estimate.every((e) => e.unitCostUsd === 0 && e.provider === "versium"), "audience_estimate is the documented-free capability on the ONE route table")
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n━━━ E · the research, pure: the whole picture, people SHOWN but never DRIVING ━━━")
type Seed = Record<string, unknown>
const cust = (o: Partial<Seed> & { city?: string }) => ({ city: "Austin", zip: "78701", property_type: "single family", price_band: "$400k–$500k", side: "buyer", financing_type: "conventional", home_owner_status: "owner", household_income: "$150k–$250k", occupation: "Engineer", lead_source: "zillow", ...o });
{
  const seed8: Seed[] = [
    cust({}), cust({ zip: "78702", occupation: "Teacher" }), cust({ occupation: "Religious clergy" }), cust({ side: "seller", financing_type: "va", occupation: "Retired" }),
    cust({ city: "Round Rock", zip: "78664", property_type: "townhome", price_band: "$300k–$400k", occupation: "Nurse" }), cust({ online_presence_real_estate: true, investing_real_estate: true, home_improvement_interest: true }),
    cust({ online_presence_real_estate: true, investing_real_estate: true, home_improvement_interest: true, length_of_residence: "15+ yrs" }), cust({ online_presence_real_estate: false }),
  ]
  const research = researchLookalikeDenominators(seed8)
  ok(!!research && research.targeting === null && research.use === LOOKALIKE_AD_POLICY.research_use && research.seedCount === 8, "a research result is NEVER a targeting spec (targeting: null) and names its use (content briefs + acquisition inputs)")
  ok(!!research && research.withheld.categories === LOOKALIKE_PROTECTED_CATEGORIES && LOOKALIKE_PROTECTED_CATEGORIES.length >= 10, "…and publishes what it never reads (age, gender, race/ethnicity, religion, national origin, familial status, disability, marital status, veteran status, political, modeled credit)")
  const dist = (a: string) => research?.distribution.find((d) => d.attribute === a)
  ok(!!dist("occupation") && !!dist("household_income") && !!dist("lead_source") && !!dist("city") && !!dist("online_presence_real_estate"), "THE WHOLE PICTURE is returned — person traits (occupation, income) and the lead source are SHOWN, not hidden behind the brief rules")
  ok((dist("online_presence_real_estate")?.coverage ?? 1) < 1 && (dist("city")?.coverage ?? 0) === 1, "coverage is published beside every attribute (online presence is known for 3 of 8 — a thin pattern reads as thin, not absent)")
  ok(research?.denominators.some((d) => d.attribute === "city" && d.value === "Austin" && d.share === round2(7 / 8)) === true, "the common denominators are the values at or above 40% of the seed (Austin 7 of 8)")
  const occupationValues = JSON.stringify(dist("occupation")?.top ?? [])
  ok(!/Religious|Retired|clergy/i.test(occupationValues) && (research?.withheld.valuesDropped ?? 0) >= 2, "free-text values naming a protected class or a proxy (\"Religious clergy\", \"Retired\") are DROPPED from the picture and counted, not echoed", occupationValues)
  const registryKeys = LOOKALIKE_RESEARCH_ATTRIBUTES
  const PROTECTED_KEY = /age|dob|birth|gender|sex|ethnic|race|religio|language|national|familial|children|marital|disab|veteran|party|politic/i
  ok(registryKeys.every((k) => !PROTECTED_KEY.test(k)), `no research attribute is a protected characteristic (${registryKeys.length} attributes read)`)
  ok(["age_range", "gender", "ethnicity", "religion", "preferred_language", "familial_status", "marital_status", "disability_status", "veteran_status", "party_affiliation", "credit_score_range"].filter((k) => !PROTECTED_KEY.test(k)).join() === "credit_score_range", "POSITIVE CONTROL: the protected-key matcher DOES recognise age, gender, ethnicity, religion, language, familial/marital/disability/veteran/party keys (only the modeled-credit key is firewalled by omission, not by regex)")
  // the seed floor: a 3-customer seed is researched although it is below the AD seed minimum
  ok(RESEARCH_MIN_SEED < MIN_SEED && researchLookalikeDenominators(seed8.slice(0, RESEARCH_MIN_SEED)) !== null && researchLookalikeDenominators(seed8.slice(0, RESEARCH_MIN_SEED - 1)) === null, `the research floor is ${RESEARCH_MIN_SEED} (a lower floor than the ad draft's ${MIN_SEED}): ${RESEARCH_MIN_SEED} customers are researched, ${RESEARCH_MIN_SEED - 1} are not (a "common denominator" of two people is two people)`)
  const briefs = composeResearchBriefs(research!)
  ok(briefs.length >= 3 && briefs.every((b) => b.key.startsWith("lookalike:") && b.title.length > 10 && b.valueAngle.length > 20), `briefs are composed from the picture (${briefs.length}): ${briefs.map((b) => b.title).join(" | ")}`)
  // "single family" is a PROPERTY TYPE, not a familial status — it is removed before the person-trait finder reads the text (and the finder is proved below to catch a real familial reference).
  const bannedInBrief = /engineer|teacher|nurse|doctor|income|\$150k|\$250k|retired|religio|clergy|famil|child|senior|veteran|\bva\b|military|young|wealth|rich/i
  const personText = (s: string) => s.replace(/single[- ]family/gi, "")
  ok(briefs.every((b) => !bannedInBrief.test(personText(b.title)) && !bannedInBrief.test(personText(b.attributes.join(" ")))), "NO brief names a person trait: no occupation, income, family, age, religion, veteran / VA — briefs describe the HOME and the MOMENT")
  ok(bannedInBrief.test(personText("Great for families with children")) && bannedInBrief.test(personText("Homes for retired veterans")) && !bannedInBrief.test(personText("Single Family homes in Austin")), "POSITIVE CONTROL: the person-trait finder DOES catch a familial / age / veteran reference and does not accuse the property type 'single family'")
  ok(briefs.every((b) => b.attributes.every((a) => !/^(occupation|household_income|business_owner|lead_source|online_purchasing)=/.test(a))), "…and no brief is DERIVED from a person / channel attribute (occupation, household_income, business_owner, lead_source, online_purchasing)")
  // positive control: a fixture with VA as the DOMINANT financing still produces no VA brief
  const vaSeed = [cust({ financing_type: "va" }), cust({ financing_type: "va", zip: "78702" }), cust({ financing_type: "va", zip: "78703" })]
  const vaBriefs = composeResearchBriefs(researchLookalikeDenominators(vaSeed)!)
  ok(!vaBriefs.some((b) => /financing|\bva\b/i.test(b.key + b.title)), "POSITIVE CONTROL: with VA as the DOMINANT financing (100%) no financing brief is composed")
  ok(!briefs.some((b) => b.key.includes("investing")), "a behaviour signal under the 40% line (investing 2 of 8) shapes NO brief — it stays in the picture")
  const behaviourSeed = [cust({ investing_real_estate: true, home_improvement_interest: true, online_presence_real_estate: true }), cust({ investing_real_estate: true, home_improvement_interest: true, online_presence_real_estate: true, zip: "78702" }), cust({ investing_real_estate: true, home_improvement_interest: true, online_presence_real_estate: true, zip: "78703" }), cust({})]
  const behaviourBriefs = composeResearchBriefs(researchLookalikeDenominators(behaviourSeed)!)
  ok(["investing", "renovation", "online-research"].every((k) => behaviourBriefs.some((b) => b.key.includes(k) && b.attributes.some((a) => /_(real_estate|interest)=yes$/.test(a)))), "behaviour signals at or over the line (investing, home improvement, online real-estate activity — the stored Versium indicators) DO drive briefs: investing, renovation, online-research", JSON.stringify(behaviourBriefs.map((b) => b.key)))
  const again = composeResearchBriefs(researchLookalikeDenominators(seed8)!)
  ok(JSON.stringify(again.map((b) => b.key)) === JSON.stringify(briefs.map((b) => b.key)), "brief keys are stable across runs (the idempotency sentinel)")

  const acq = composeAcquisitionInputs(research!)
  ok(acq.territories.some((t) => t.kind === "zip" && t.value === "78701") && acq.territories.every((t) => t.count >= 2), "territories are the ZIPs / cities where at least two customers cluster")
  ok(acq.intents.some((i) => i.intent === "buyer") && acq.keywords.length > 0 && acq.keywords.every((k) => k.keyword.includes("{city}")), "acquisition keywords are public-intent search terms carrying the territory placeholder (the resolver renders {city} per market)")
  const allowedTypes = new Set(CHECK_VOCABULARIES.lead_scraping_keywords.keyword_type)
  ok(acq.keywords.length > 0 && acq.keywords.every((k) => allowedTypes.has(k.keyword_type) && !!KEYWORD_TYPE_INTENT[k.keyword_type]), `every staged keyword_type is in the LIVE CHECK vocabulary and maps to an acquisition intent (${[...allowedTypes].join(", ")})`)
  ok(!acq.keywords.some((k) => bannedInBrief.test(personText(k.keyword))), "no acquisition keyword names a person trait")
  ok(!!acq.estimateFilters && (acq.estimateFilters.zips?.length ?? 0) <= 10 && Object.keys(acq.estimateFilters).every((k) => ["zips", "requiredFields", "ownRent", "lengthOfResidenceYears"].includes(k)), "the estimate filter set is ZIPs + tenure + length of residence only (no income, no person trait)", JSON.stringify(acq.estimateFilters))
  ok(acq.sourceMix[0]?.source === "zillow", "the lead-source mix of the customers is shown (informational — the source-conversion loop owns channel allocation)")
  // seller-heavy, investor, LoR parse
  const sellerSeed = [cust({ side: "seller", length_of_residence: "10-15 yrs" }), cust({ side: "seller", length_of_residence: "10-15 yrs" }), cust({ side: "seller", zip: "78703" })]
  const sa = composeAcquisitionInputs(researchLookalikeDenominators(sellerSeed)!)
  ok(sa.keywords.some((k) => k.keyword_type === "motivated_seller") && sa.estimateFilters?.lengthOfResidenceYears?.min === 10, "a seller-heavy picture stages a seller-intent keyword and a length-of-residence estimate filter")
  // seed profile mapping, row by row
  const prof = lookalikeSeedProfile({
    contact: { property_type: "Single_Family", home_owner_status: "Owner", household_income: 175000, occupation: "Engineer", source: "Zillow_Lead", city: "Austin", enrichment_profile: { [REAL_ESTATE_INDICATORS_KEY]: { provider: "versium", onlinePresenceRealEstate: true, investingRealEstate: false, lengthOfResidence: "15+ Years", religion: "SHOULD-NOT-SURVIVE" } } },
    deal: { property_city: "Austin", property_zip: "78701-1234", purchase_price: 455000, financing_type: "CONVENTIONAL" }, side: "buyer",
  })
  ok(prof.price_band === "$400k–$500k" && prof.zip === "78701" && prof.household_income === "$150k–$250k" && prof.property_type === "single family" && prof.lead_source === "zillow lead" && prof.online_presence_real_estate === true && prof.length_of_residence === "15+ Years",
    "the seed profile bands money (no figure leaves), normalises, and reads the stored indicators", JSON.stringify(prof))
  ok(!JSON.stringify(prof).includes("SHOULD-NOT-SURVIVE") && Object.keys(prof).every((k) => registryKeys.includes(k)), "…and only registry attributes can exist in a profile (a foreign key in the stored blob is dropped)")
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n━━━ F · the research run over the in-memory database ━━━")
{
  const NOW = new Date("2026-10-26T12:00:00Z") // a Monday
  const ctc = (n: number, over: Row = {}): Row => ({ id: U(n), brokerage_id: B, first_name: `Casey${n}`, last_name: "Fixture", email: `casey${n}@example.test`, phone: null, city: "Austin", property_type: "single_family", home_owner_status: "owner", household_income: 160000, occupation: "Engineer", source: "zillow", enrichment_profile: null, deleted_at: null, privacy_anonymized_at: null, opted_out_at: null, ...over })
  const tx = (n: number, contact: number, side: "buyer" | "seller", over: Row = {}): Row => ({ id: U(n, "d"), brokerage_id: B, status: "closed", deleted_at: null, [side === "buyer" ? "buyer_contact_id" : "seller_contact_id"]: U(contact), purchase_price: 450000, financing_type: "conventional", property_city: "Austin", property_state: "TX", property_zip: "78701", close_date: `2026-0${(n % 8) + 1}-15`, ...over })
  const baseSeed = (): Record<string, Row[]> => ({
    contacts: [
      ctc(1), ctc(2), ctc(3, { household_income: 200000 }), ctc(4, { property_type: "townhome" }), ctc(5), ctc(6, { occupation: "Religious clergy" }),
      ctc(7, { deleted_at: "2026-01-01T00:00:00Z" }), ctc(8, { opted_out_at: "2026-02-01T00:00:00Z" }), ctc(9, { privacy_anonymized_at: "2026-03-01T00:00:00Z" }),
      ctc(10, { brokerage_id: OTHER }), ctc(11),
    ],
    transactions: [
      tx(1, 1, "buyer"), tx(2, 2, "buyer"), tx(3, 3, "buyer", { property_zip: "78702" }), tx(4, 4, "buyer", { property_city: "Round Rock", property_zip: "78664", purchase_price: 350000 }),
      tx(5, 5, "seller"), tx(6, 6, "seller", { property_zip: "78702", financing_type: "va" }),
      tx(7, 7, "buyer"), tx(8, 8, "buyer"), tx(9, 9, "buyer"),
      { ...tx(10, 10, "buyer"), brokerage_id: OTHER },
      tx(11, 11, "buyer", { status: "active" }),
    ],
    content_topic_bank: [], lead_scraping_keywords: [], agent_action_ledger: [],
  })
  const mem = (seed: Record<string, Row[]>, o: Parameters<typeof memSupabase>[1] = {}) => memSupabase(seed, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] }, ...o })
  const indicators = (n: number) => ({ onlinePresenceRealEstate: true, investingRealEstate: n % 2 === 0, residentialPropertiesOwned: null, homeOwnRent: "owner" as const, lengthOfResidence: "15+ Years", homeSalesTransaction: null, businessOwner: null, homeImprovementInterest: true, onlinePurchasing: null, mortgagePurchaseDate: null, refinanceDate: null })
  const asks: string[] = []
  const stampOf = { source: "versium" as const, capability: "person.enrich_online_presence" as const, retrievedAt: NOW.toISOString(), matchConfidence: null, purpose: "enrichment" as const }
  const okLeg = async (req: { brokerageId: string | null; identity: { email?: string | null } }) => { asks.push(String(req.identity.email)); const n = Number(String(req.identity.email).match(/casey(\d+)/)?.[1] ?? 0); return { answered: true, indicators: indicators(n), cost: round2(3 * USD), skipped: null, provenance: stampOf } }
  const estimate = { answered: true, estimate: { estimatedRecords: 4321, availableRecords: 4300, estimatedMatchCredits: 4321, cost: 0 as const, refused: [] }, cost: 0 as const, skipped: null }
  const noLive = async () => ({ suppressed: new Set<string>(), degraded: false })

  // F1 — a refused read is an error, not an empty seed; and a FAILED run is ledgered `failed` and re-claimed by the next attempt
  {
    const refusal = { refuse: { transactions: "RLS said no" } as Record<string, string> }
    const svc = mem(baseSeed(), refusal)
    const run = await runLookalikeResearch(B, { now: NOW }, svc as never, { leg: okLeg as never, estimateLeg: (async () => estimate) as never, suppressed: noLive })
    ok(run.skipped === "seed_unreadable" && run.errors.some((e) => /RLS said no/.test(e)) && svc.tables.content_topic_bank.length === 0 && svc.tables.lead_scraping_keywords.length === 0 && asks.length === 0,
      "a REFUSED transactions read is `seed_unreadable` with the vendor's reason — not a thin seed, not 'no customers' — and nothing is staged or bought")
    ok((svc.tables.agent_action_ledger as Row[]).length === 1 && (svc.tables.agent_action_ledger as Row[])[0].status === "failed" && /RLS said no/.test((svc.tables.agent_action_ledger as Row[])[0].error ?? ""), "…and the ledger row says `failed` with the reason (who/what/why/what happened)")
    // the live column has DEFAULT 1 (m687 `attempts integer NOT NULL DEFAULT 1`); the in-memory fake has no column defaults, so model it
    for (const row of svc.tables.agent_action_ledger as Row[]) row.attempts ??= 1
    delete refusal.refuse.transactions // the database recovers
    const retry = await runLookalikeResearch(B, { now: NOW, enrich: false }, svc as never, { estimateLeg: (async () => estimate) as never, suppressed: noLive })
    ok(retry.seedCount === 6 && retry.briefs.staged > 0 && (svc.tables.agent_action_ledger as Row[]).length === 1 && (svc.tables.agent_action_ledger as Row[])[0].status === "executed" && (svc.tables.agent_action_ledger as Row[])[0].attempts === 2, "a FAILED run is re-claimed by the next attempt in the same week (attempts 2, now executed) — a transient refusal does not cost the tenant its week")
  }
  // F2 — the full run
  const svc = mem(baseSeed())
  const run = await runLookalikeResearch(B, { now: NOW, enrich: { maxContacts: 4 } }, svc as never, { leg: okLeg as never, estimateLeg: (async () => estimate) as never, suppressed: async (ids) => ({ suppressed: new Set(ids.filter((i) => i === U(2))), degraded: false }) })
  ok(run.seedCount === 6, `the seed is the tenant's CONSENTED closed customers: 6 of 11 contacts (excluded: deleted, anonymized, opted-out, another tenant's, and one whose deal is not closed)`, `seedCount=${run.seedCount}`)
  ok(run.enrichment.asked === 4 && run.enrichment.answered === 4 && run.enrichment.persisted === 4 && run.enrichment.costUsd === round2(4 * 3 * USD), `the online-presence pass is BOUNDED (cap 4 → asked ${run.enrichment.asked}) and priced at the published 3 credits each ($${run.enrichment.costUsd})`)
  ok(!asks.includes("casey2@example.test"), "a contact the live-deal suppression names is NEVER asked (the owner's rule, fail-closed)")
  const stored = (svc.tables.contacts as Row[]).filter((c) => c.brokerage_id === B && realEstateIndicatorsFromProfile(c.enrichment_profile))
  ok(stored.length === 4 && stored.every((c) => c.enrichment_profile.field_provenance?.[REAL_ESTATE_INDICATORS_KEY]?.source === "versium" && c.enrichment_profile.field_provenance[REAL_ESTATE_INDICATORS_KEY].capability === "person.enrich_online_presence"), "the answers are PERSISTED on the contact (enrichment_profile.real_estate_indicators) WITH provenance in the one shape")
  ok(!(svc.tables.contacts as Row[]).some((c) => c.brokerage_id === OTHER && c.enrichment_profile), "…and no other tenant's contact was touched")
  ok(run.research?.distribution.find((d) => d.attribute === "online_presence_real_estate")?.top[0]?.value === "yes", "THE LOOP IS CLOSED: what the pass stored is what the research now reads (online presence 'yes')")
  ok(run.briefs.composed >= 3 && run.briefs.staged === run.briefs.composed, `briefs staged: ${run.briefs.staged}/${run.briefs.composed}`)
  const topics = svc.tables.content_topic_bank as Row[]
  ok(topics.length === run.briefs.staged && topics.every((t) => t.brokerage_id === B && t.status === "fresh" && t.categories[0] === "customer_lookalike_research" && typeof t.raw_data.lookalike_research_key === "string" && Date.parse(t.expires_at) > NOW.getTime() + 25 * 86_400_000), "briefs land in content_topic_bank as FRESH, tenant-scoped, 30-day topics with an idempotency key — the rows pickTopics and every generator already read")
  ok(topics.every((t) => /never the person/.test(t.raw_data.fair_housing) && t.raw_data.audience_estimate?.estimated_records === 4321), "each brief carries its fair-housing note and the free Versium audience-size read of the research territory")
  const kws = svc.tables.lead_scraping_keywords as Row[]
  ok(kws.length === run.keywords.staged && kws.length > 0 && kws.every((k) => k.is_active === false && k.brokerage_id === B && k.sources.length === KEYWORD_SOURCE_KEYS.length && new Set(CHECK_VOCABULARIES.lead_scraping_keywords.keyword_type).has(k.keyword_type)), "acquisition inputs are STAGED INACTIVE (a human enables them in the existing scraping config), tenant-scoped, on every keyword-reading source, with a live CHECK-valid keyword_type")
  const ledger = (svc.tables.agent_action_ledger as Row[])
  ok(ledger.length === 1 && ledger[0].action === "ads.lookalike_research.stage" && ledger[0].status === "executed" && ledger[0].reason_code === "CAMPAIGN_STEP" && ledger[0].actor_type === "manager" && ledger[0].actor_manager_key === "ads_manager" && ledger[0].brokerage_id === B && /^seed=6;briefs=\d+;keywords=\d+;asked=4;estimate=4321/.test(ledger[0].outcome),
    "the run is ONE ledgered action (who: ads_manager · why: CAMPAIGN_STEP · what: seed / briefs / keywords / asked / estimate · executed) — LAW 5 evidence", JSON.stringify(ledger[0]))
  ok(ledger[0].provider === "versium" && Math.abs(Number(ledger[0].cost_usd) - round2(4 * 3 * USD)) < 1e-9, `…and it carries what it COST: provider versium, $${ledger[0].cost_usd} = 4 asks × 3 credits (the leg books the same spend to the vendor ledger)`)
  // idempotency — the weekly claim is taken BEFORE anything is read or bought
  const before = { topics: topics.length, kws: kws.length, ledger: ledger.length, asks: asks.length }
  const rerun = await runLookalikeResearch(B, { now: NOW, enrich: { maxContacts: 4 } }, svc as never, { leg: okLeg as never, estimateLeg: (async () => estimate) as never, suppressed: async (ids) => ({ suppressed: new Set(ids.filter((i) => i === U(2))), degraded: false }) })
  ok(rerun.skipped?.startsWith("already_ran_this_week") === true && asks.length === before.asks && (svc.tables.content_topic_bank as Row[]).length === before.topics && (svc.tables.lead_scraping_keywords as Row[]).length === before.kws && (svc.tables.agent_action_ledger as Row[]).length === before.ledger,
    "a second run in the same ISO week REPLAYS the claim: no read, nothing staged twice, NO second batch of indicators bought — the weekly spend cap is really weekly")
  const nextWeek = await runLookalikeResearch(B, { now: new Date(NOW.getTime() + 7 * 86_400_000), enrich: { maxContacts: 4 } }, svc as never, { leg: okLeg as never, estimateLeg: (async () => estimate) as never, suppressed: async (ids) => ({ suppressed: new Set(ids.filter((i) => i === U(2))), degraded: false }) })
  ok(nextWeek.enrichment.asked === 1 && asks.length - before.asks === 1 && (svc.tables.agent_action_ledger as Row[]).length === before.ledger + 1, "the NEXT week is a new claim, and the online-presence pass is GAP-ONLY: the 4 contacts that already have indicators are not asked again, only the 1 remaining non-suppressed contact is", `asked=${nextWeek.enrichment.asked} newAsks=${asks.length - before.asks}`)
  ok((svc.tables.content_topic_bank as Row[]).length >= before.topics && (svc.tables.content_topic_bank as Row[]).filter((t) => t.raw_data.lookalike_research_key === (svc.tables.content_topic_bank as Row[])[0].raw_data.lookalike_research_key).length === 1, "…and the briefs of the first week, still FRESH and unexpired, are not staged a second time (keyed dedupe)")
  const noEnrich = await runLookalikeResearch(B, { now: new Date(NOW.getTime() + 14 * 86_400_000), enrich: false }, svc as never, { estimateLeg: (async () => estimate) as never })
  ok(noEnrich.enrichment.skipped === "disabled" && noEnrich.enrichment.asked === 0, "`enrich: false` spends nothing")
  const off = await runLookalikeResearch(B, { now: NOW, enrich: { maxContacts: 0 } }, mem(baseSeed()) as never, { leg: (async () => { throw new Error("must not be called") }) as never, estimateLeg: (async () => estimate) as never })
  ok(off.enrichment.skipped === "disabled" && off.enrichment.asked === 0, "maxContacts 0 is the OFF switch (the owner can zero the spend)")
  ok(LOOKALIKE_RESEARCH_ENRICH_MAX_PER_RUN > 0 && LOOKALIKE_RESEARCH_ENRICH_MAX_PER_RUN <= 25, `the default spend cap is small and bounded (${LOOKALIKE_RESEARCH_ENRICH_MAX_PER_RUN} contacts per tenant per week ≈ $${round2(LOOKALIKE_RESEARCH_ENRICH_MAX_PER_RUN * 3 * USD)} at the credit-package ceiling, budget-gated per call)`)
  // budget stop: the first refusal ends the pass
  let budgetAsks = 0
  const budgetRun = await runLookalikeResearch(B, { now: NOW, enrich: { maxContacts: 6 } }, mem(baseSeed()) as never, { leg: (async () => { budgetAsks++; return { answered: false, indicators: null, cost: 0, skipped: "budget", provenance: null } }) as never, estimateLeg: (async () => estimate) as never, suppressed: noLive })
  ok(budgetAsks === 1 && budgetRun.enrichment.skipped === "budget", "POSITIVE CONTROL: the first budget refusal ENDS the pass (1 ask, not 6) — it does not hammer a gate that said no")
  const degraded = await runLookalikeResearch(B, { now: NOW, enrich: { maxContacts: 6 } }, mem(baseSeed()) as never, { leg: (async () => { throw new Error("must not be called for a suppressed contact") }) as never, estimateLeg: (async () => estimate) as never, suppressed: async (ids) => ({ suppressed: new Set(ids), degraded: true }) })
  ok(degraded.enrichment.asked === 0 && degraded.enrichment.skipped === "live_deal_check_degraded", "POSITIVE CONTROL: when the live-deal check cannot run, EVERY contact is treated as suppressed — nothing is bought (fail closed)")
  // the live-deal check is asked about a bounded WINDOW of candidates, never the whole book (a thousand uuids in one `.in()` would blow
  // the gateway's URL limit, and the check reads an unreadable answer as "suppress everyone")
  {
    const many = baseSeed()
    for (let n = 20; n < 50; n++) { many.contacts.push(ctc(n)); many.transactions.push(tx(n + 100, n, "buyer")) }
    let windowIds = -1
    await runLookalikeResearch(B, { now: NOW, enrich: { maxContacts: 2 } }, mem(many) as never, { leg: okLeg as never, estimateLeg: (async () => estimate) as never, suppressed: async (ids) => { windowIds = ids.length; return { suppressed: new Set(), degraded: false } } })
    ok(windowIds === 10, `with 36 seed members and a cap of 2, the live-deal check sees a window of ${windowIds} ids (max(cap × 3, 10)), not all 36`)
    // the window ROTATES by ISO week: a no-match is free but asked again every run, so a fixed window would starve everyone behind it
    const seen = new Set<string>(), windows: string[][] = []
    for (let w = 0; w < 4; w++) {
      await runLookalikeResearch(B, { now: new Date(NOW.getTime() + w * 7 * 86_400_000), enrich: { maxContacts: 2 } }, mem(many) as never, { leg: (async () => ({ answered: false, indicators: null, cost: 0, skipped: null, provenance: null })) as never, estimateLeg: (async () => estimate) as never, suppressed: async (ids) => { windows.push([...ids]); ids.forEach((i) => seen.add(i)); return { suppressed: new Set(), degraded: false } } })
    }
    ok(windows.length === 4 && new Set(windows.map((x) => x.join())).size === 4 && seen.size === 36, `the candidate window rotates week to week (4 distinct windows) and four weeks cover all 36 members (${seen.size})`)
  }
  // thin seed
  const thin = await runLookalikeResearch(B, { now: NOW }, mem({ ...baseSeed(), transactions: baseSeed().transactions.slice(0, 2) }) as never, { leg: okLeg as never, estimateLeg: (async () => estimate) as never, suppressed: noLive })
  ok(thin.skipped?.startsWith("seed too thin") === true && thin.briefs.staged === 0, "a seed below the research floor stages nothing")
  // columns exist (PGRST204 refuses the WHOLE row)
  const cols = (t: string) => new Set(SCHEMA_SNAPSHOT[t] ?? [])
  const sel = (s: string) => s.split(",").map((x) => x.trim())
  ok(sel(LOOKALIKE_SEED_CONTACT_COLUMNS).every((c) => cols("contacts").has(c)) && sel(LOOKALIKE_SEED_DEAL_COLUMNS).every((c) => cols("transactions").has(c)), "every column the seed reads exists in the live schema snapshot (contacts, transactions)")
  const written = (t: string) => [...new Set(svc.writes.filter((w) => w.table === t && w.op === "insert").flatMap((w) => Object.keys(w.payload)))]
  ok(written("content_topic_bank").every((c) => cols("content_topic_bank").has(c)) && written("lead_scraping_keywords").every((c) => cols("lead_scraping_keywords").has(c)) && written("agent_action_ledger").every((c) => cols("agent_action_ledger").has(c)), "every column the run WRITES exists in the live schema snapshot (content_topic_bank, lead_scraping_keywords, agent_action_ledger)", `${written("content_topic_bank").concat(written("lead_scraping_keywords")).filter((c) => !cols("content_topic_bank").has(c) && !cols("lead_scraping_keywords").has(c)).join(",")}`)
  ok(!JSON.stringify(topics.concat(kws)).match(/Religious|clergy|Engineer|160000|200000/), "no person trait (occupation, income, a religious-occupation value) reached a staged topic or keyword")

  // G — the ad draft carries the LOCATION seed only; research is its own capability
  const adSeed = {
    transactions: [1, 2, 3, 4, 5].map((n) => ({ id: U(n, "e"), brokerage_id: B, status: "closed", buyer_contact_id: U(n), listing_id: U(n, "f") })),
    listings: [1, 2, 3, 4, 5].map((n) => ({ id: U(n, "f"), brokerage_id: B, city: n % 2 ? "Austin" : "Round Rock" })),
    ad_campaigns: [] as Row[],
  }
  const adSvc = mem(adSeed)
  const ad = await runLookalikeAudience(B, { now: NOW }, adSvc as never)
  const draft = (adSvc.tables.ad_campaigns as Row[])[0]
  ok(ad.staged && draft?.status === "draft" && draft.targeting_config.seed_source === "closing_table" && draft.targeting_config.lookalike_model === "not_available_for_housing", "the AD DRAFT is staged from the closing table as before (draft, location seed, no platform look-alike model)")
  ok(!("research" in draft.targeting_config) && Object.keys(draft.targeting_config).sort().join() === "audience,locations,lookalike_model,policy,seed_count,seed_source", "…and its targeting_config carries NO research block (the 142D `targeting_config.research` moved out: research ≠ targeting)", Object.keys(draft.targeting_config).join())
  const adThin = await runLookalikeAudience(B, { now: NOW }, mem({ transactions: baseSeed().transactions.slice(0, 4), listings: [], ad_campaigns: [] }) as never)
  ok(!adThin.staged && /seed too thin/.test(adThin.reason ?? "") && run.seedCount < MIN_SEED + 5 && run.seedCount >= RESEARCH_MIN_SEED, "a seed too thin for an ad is still researched (the two capabilities have independent floors)")
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n━━━ H · the indicator store: tenant-anchored, gap-only, provenance, allow-listed reads ━━━")
{
  const svc = memSupabase({ contacts: [{ id: U(1), brokerage_id: B, enrichment_profile: { household_financials: { keep: true }, field_provenance: { phone: { source: "staff" } } } }, { id: U(2), brokerage_id: OTHER, enrichment_profile: null }] })
  const ind = { onlinePresenceRealEstate: true, investingRealEstate: null, residentialPropertiesOwned: null, homeOwnRent: "owner" as const, lengthOfResidence: null, homeSalesTransaction: null, businessOwner: null, homeImprovementInterest: null, onlinePurchasing: null, mortgagePurchaseDate: null, refinanceDate: null }
  const prov = { source: "versium", capability: "person.enrich_online_presence", retrievedAt: "2026-10-26T00:00:00Z", matchConfidence: null, purpose: "enrichment" as const }
  const w = await persistRealEstateIndicators(svc as never, { contactId: U(1), brokerageId: B }, ind, prov)
  const row = (svc.tables.contacts as Row[])[0]
  ok(w.ok && w.wrote && row.enrichment_profile.household_financials.keep === true && row.enrichment_profile.field_provenance.phone.source === "staff" && row.enrichment_profile.field_provenance[REAL_ESTATE_INDICATORS_KEY].source === "versium", "the block is merged beside the existing profile blocks and provenance entries (nothing is overwritten)")
  const again = await persistRealEstateIndicators(svc as never, { contactId: U(1), brokerageId: B }, { ...ind, onlinePresenceRealEstate: false }, prov)
  ok(again.ok && !again.wrote && realEstateIndicatorsFromProfile(row.enrichment_profile)?.onlinePresenceRealEstate === true, "gap-only: an existing block is left alone unless `refresh` is asked")
  const wrong = await persistRealEstateIndicators(svc as never, { contactId: U(2), brokerageId: B }, ind, prov)
  ok(!wrong.ok && /not found in this tenant/.test(wrong.error ?? "") && (svc.tables.contacts as Row[])[1].enrichment_profile === null, "POSITIVE CONTROL: a contact of ANOTHER tenant is not found and not written (the tenant anchor is on the read AND the update)")
  const refusing = memSupabase({ contacts: [{ id: U(1), brokerage_id: B, enrichment_profile: null }] }, { refuse: { contacts: "RLS" } })
  const rr = await persistRealEstateIndicators(refusing as never, { contactId: U(1), brokerageId: B }, ind, prov)
  ok(!rr.ok && /RLS/.test(rr.error ?? ""), "a refused read is returned as an error (never 'wrote nothing, fine')")
  const tampered = realEstateIndicatorsFromProfile({ [REAL_ESTATE_INDICATORS_KEY]: { onlinePresenceRealEstate: true, religion: "x", ethnicity: "y", homeOwnRent: "squatter" } })
  ok(tampered?.onlinePresenceRealEstate === true && tampered.homeOwnRent === null && !JSON.stringify(tampered).match(/religion|ethnicity|"x"|"y"/), "the reader is an allow-list: a foreign or protected key in a stored blob is dropped, an unknown tenure is null")
  ok(realEstateIndicatorsFromProfile({ [REAL_ESTATE_INDICATORS_KEY]: { provider: "versium", captured_at: "2026-01-01" } }) === null && realEstateIndicatorsFromProfile(null) === null, "an empty block / a null profile reads as absent")
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n━━━ I · the MCP verdict (data, re-proved against the live server), the scanner's colleague rule, source rules ━━━")
{
  ok(VERSIUM_REACH_MCP.status === "WAITING_EXTERNAL" && VERSIUM_REACH_MCP.wired === false && VERSIUM_REACH_MCP.oauth.clientCredentialsGrant === false && VERSIUM_REACH_MCP.oauth.grantTypes.join() === "authorization_code,refresh_token" && VERSIUM_REACH_MCP.oauth.pkce === "S256" && VERSIUM_REACH_MCP.waitingOn.length >= 3,
    "the REACH MCP is WAITING_EXTERNAL with its exact reason as data: OAuth authorization-code + PKCE only (no client_credentials grant), an unauthenticated initialize is a 401 Bearer challenge, three named dependencies")
  ok(/authorization_endpoint|oauth\/authorize/.test(JSON.stringify(VERSIUM_REACH_MCP)) && VERSIUM_REACH_MCP.reverifiedAt === "2026-10-23" && /batchdata-mcp/.test(VERSIUM_REACH_MCP.wiringPattern), "…with the live endpoints, the date it was re-proved, and the survivor pattern to reuse if it is ever wired")
  const adapters = await import("../lib/kernel/provider-adapters")
  const versium = adapters.deriveProviderAdapters().adapters.find((a: { provider: string }) => a.provider === "versium")
  ok(!!versium && adapters.validateProviderAdapter(versium).length === 0 && versium.capabilities.includes("audience_estimate") && /WAITING_EXTERNAL/.test(versium.api.urlNote ?? ""), "the provider adapter certification READS the matrix + MCP verdict (valid, declares audience_estimate, says WAITING_EXTERNAL)")
  const sources = ["lib/external/versium-client.ts", "lib/ai-isa/property-lookup-rail.ts", "lib/kernel/lookalike-audience.ts", "lib/enrichment/online-presence-store.ts"].map((f) => strippedSrc(f))
  ok(/process\.env\.VERSIUM_API_KEY/.test(sources[0]), "POSITIVE CONTROL: the credential finder DOES see the adapter's own read")
  ok(!/process\.env\.VERSIUM/.test(sources[1] + sources[2] + sources[3]), "the rail, the research and the store never read the Versium credential (the adapter does — LAW 3, principle 5)")

  // brokerage affiliation: the scanner's colleague rule (pure)
  ok(isExistingTenantMember("agent", "u1", "agent") && isExistingTenantMember("agent", "u1", "team_lead") && isExistingTenantMember("agent", "u1", "broker_owner") && isExistingTenantMember("agent", "u1", "isa") && isExistingTenantMember("agent", "u1", "tc"), "an AGENT card whose email/phone is already an INTERNAL seat of this tenant (agent, team_lead, broker_owner, isa, tc) is a colleague — not filed as a recruit")
  ok(!isExistingTenantMember("agent", "u1", "contact") && !isExistingTenantMember("agent", "u1", "vendor") && !isExistingTenantMember("agent", null, "agent") && !isExistingTenantMember("agent", "u1", null), "…but a matched portal CONTACT, a VENDOR seat, no match, or a typeless user row does not suppress the recruit")
  ok(!isExistingTenantMember("contact", "u1", "agent") && !isExistingTenantMember("vendor", "u1", "agent") && !isExistingTenantMember("sphere", "u1", "agent"), "POSITIVE CONTROL: only the 'agent' class is affected — a contact, vendor or sphere card is never re-routed by it")
  const card = strippedSrc("app/actions/business-card/business-card-actions.ts")
  ok(/const firstMatch = async/.test(card) && /\.limit\(1\)/.test(card) && /identity lookup refused/.test(card) && !/\)\.maybeSingle\(\)\s*\n\s*if \(matchedUser\)/.test(card), "the three identity lookups use .limit(1) and READ their error (a duplicate email is no longer a PGRST116 'no match', a refusal is said)")
  ok(/if \(existingMember\) \{[\s\S]{0,1200}routed_entity_type: "none"[\s\S]{0,2500}return \{ \.\.\.resultBase/.test(card) && !/auth\.admin\.createUser|from\("users"\)\.insert|from\('users'\)\.insert/.test(card), "an existing colleague is filed as nothing (`none`) with the user named in extracted_data; the scanner never creates a user / agent account anywhere")
  ok(/subjectType: PreScanChoice/.test(card) && /resolvePreScanChoice\(params\.subjectType, params\.target\)/.test(card) && /if \(!pick\) throw new Error\(PRE_SCAN_CHOICE_REQUIRED\)/.test(card), "the type (vendor / contact / agent) is REQUIRED before the scan and fails closed without it (142D, preserved)")
  const ui = strippedSrc("app/dashboard/agent/business-cards/page.tsx")
  ok(/subjectType/.test(ui.slice(ui.indexOf("uploadBusinessCard(") - 100, ui.indexOf("uploadBusinessCard(") + 700)) || /subjectType/.test(ui), "the scan page passes the chosen type to uploadBusinessCard (the picker precedes the scan)")
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log(" FAILURES:"); for (const f of failures) console.log("   - " + f); process.exit(1) }
console.log(" ✅ Versium capability matrix + look-alike research verified")
