#!/usr/bin/env tsx
/**
 * scripts/external-signal-lanes-simulator.ts   (npm run test:external-signal-lanes)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROOF FOR THREE CAPABILITIES THAT WERE BUILT AND LEFT UNCONNECTED.
 *
 *   1. extractFromHtml   → ZenrowsClient.scrapeNextdoor (lib/external/nextdoor-extract.ts)
 *   2. recentPermits     → /api/cron/permit-signal-scan (lib/external/permit-signals.ts)
 *   3. validateVendorPlan → /vendor/plans (app/actions/vendors/vendor-plans.ts)
 *
 * Layer 1 (pure): the extraction/scoring/matching/validation cores, with real assertions.
 * Layer 2 (wiring): the cron is registered AND owned; the action file exists; the page is
 *   nav-linked; the validator's rules match the live CHECK constraints named in its header.
 * Layer 3 (live, best-effort): one bounded Socrata call proving recentPermits returns the
 *   adapter's structured shape and never throws. Asserted on SHAPE, not on a vendor's uptime.
 *
 * Run: npx tsx scripts/external-signal-lanes-simulator.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  scoreNextdoorPost, normalizeExtractedPosts, regexFallbackPosts,
  NEXTDOOR_POST_SCHEMA, NEXTDOOR_EXTRACT_INSTRUCTIONS,
} from "../lib/external/nextdoor-extract"
import {
  normalizeStreetAddress, readPermitAddress, readPermitId, readPermitValuation,
  readPermitEventDate, readPermitDescription, readViolationStatus,
  classifyPermitStrength, classifyViolationStrength,
  matchPermitsToLeads, buildPermitSignalRow, permitDedupeKey, ingestPermitSignals, signalTypeForKind,
  detectedViaForDataset,
  PERMIT_SIGNAL_TYPE, VIOLATION_SIGNAL_TYPE, SOCRATA_SIGNAL_TYPES, PERMIT_DETECTED_VIA,
  ARCGIS_DETECTED_VIA,
} from "../lib/external/permit-signals"
import {
  getMarketDatasets, listQueryablePermitDatasets, listQueryableDatasets, classifyMarketCoverage,
  isQueryableDataset, providerOf,
  MARKETS,
} from "../lib/external/socrata-market-registry"
import { recentPermits, isSoqlFieldName, isIsoCalendarDay } from "../lib/external/socrata-client"
import {
  parseArcgisResponse, arcgisDateToIsoDay, isArcgisFieldName, buildArcgisDateWhere,
  isArcgisLayerUrl, recentArcgisPermits, arcgisFeatureQuery,
} from "../lib/external/arcgis-permits"
import { SELLER_SIGNAL_STRENGTHS } from "../lib/lead-governance/seller-signal-strength"
import { stripComments } from "./strip-comments"
import { validateVendorPlan, VENDOR_PLAN_BILLING_CYCLES, VENDOR_PLAN_STATUSES } from "../lib/vendors/vendor-validators"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { CRON_MANAGER, MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

console.log("══════════════════════════════════════════════════")
console.log(" External signal lanes — extractFromHtml · recentPermits · validateVendorPlan")
console.log("══════════════════════════════════════════════════")

// ═══════════════════════════════════════════════════════════════════════════
// 1 · extractFromHtml → Nextdoor
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[1 · extractFromHtml lane — the schema, and what the model may NOT author]")

check("the schema asks for the exact fields the two live consumers read",
  ["post_id", "author_name", "content", "neighborhood", "url", "posted_at"]
    .every((f) => NEXTDOOR_POST_SCHEMA.includes(f)))
check("the schema does NOT ask the model for a score, a type, or a keyword list",
  !/relevance|score|matched_keywords|classif/i.test(NEXTDOOR_POST_SCHEMA))
check("the instructions forbid inferring, scoring and summarizing",
  /do not infer/i.test(NEXTDOOR_EXTRACT_INSTRUCTIONS) && /do not summarize/i.test(NEXTDOOR_EXTRACT_INSTRUCTIONS))

const sellPost = "Hi neighbors — we are thinking of selling our house this spring, any recommendations for a realtor?"
const s1 = scoreNextdoorPost(sellPost)
const s2 = scoreNextdoorPost(sellPost)
check("scoring is deterministic (same text → identical result)", JSON.stringify(s1) === JSON.stringify(s2))
check("a selling declaration types as selling_intent and scores above the consumers' 70 gate",
  s1.type === "selling_intent" && s1.relevance_score > 70, `type=${s1.type} score=${s1.relevance_score}`)
const noise = scoreNextdoorPost("Lost cat near the park, orange tabby, answers to Mango.")
check("an unrelated post scores 0 and types general — a post can genuinely FAIL the gate",
  noise.relevance_score === 0 && noise.type === "general")
check("caller keywords add to the match set", scoreNextdoorPost("we need a bigger yard", ["bigger yard"]).matched_keywords.includes("bigger yard"))
check("score is capped at 100", scoreNextdoorPost(SELL_SPAM()).relevance_score <= 100)

const normalized = normalizeExtractedPosts([
  { post_id: "p1", author_name: "Dana R", content: sellPost, neighborhood: "Hyde Park", url: "https://nextdoor.com/p/1", relevance_score: 99, type: "selling_intent" },
  { post_id: "p2", author_name: "No Text", content: "   " },
  { nonsense: true },
], { sourceUrl: "https://nextdoor.com/search" })
check("a record with no readable content is DROPPED, not patched into a plausible post", normalized.length === 1)
check("extracted facts survive verbatim",
  normalized[0].post_id === "p1" && normalized[0].author_name === "Dana R" && normalized[0].neighborhood === "Hyde Park")
check("a model-authored relevance_score is IGNORED and recomputed",
  normalized[0].relevance_score !== 99 && normalized[0].relevance_score === s1.relevance_score)
check("llm-path records are stamped llm_schema", normalized[0].extraction === "llm_schema")
check("a record with no url falls back to the page it came from",
  normalizeExtractedPosts([{ content: sellPost }], { sourceUrl: "https://nextdoor.com/search" })[0].url === "https://nextdoor.com/search")

const fallback = regexFallbackPosts(
  `<div class="post-body">${sellPost} plus enough words to clear the length floor for the block scan</div>`,
  { sourceUrl: "https://nextdoor.com/search" },
)
check("the regex fallback still recovers text", fallback.length === 1 && fallback[0].content.includes("selling our house"))
check("…but withholds the score (null, never 0) and says it is degraded",
  fallback[0].relevance_score === null && fallback[0].extraction === "regex_fallback")

const zen = src("lib/external/zenrows-client.ts")
check("scrapeNextdoor calls extractFromHtml", zen.includes("llm-html-extractor") && zen.includes("extractFromHtml"))
check("…and keeps the regex path as the named fallback", zen.includes("regexFallbackPosts"))
check("…and a failed scrape reports an error instead of an empty neighborhood",
  /success: false[\s\S]{0,200}error:/.test(zen))
check("the extractor itself still routes through the AI Gateway, never a provider SDK",
  src("lib/external/llm-html-extractor.ts").includes("gatewayChat"))

// ═══════════════════════════════════════════════════════════════════════════
// 2 · recentPermits → motivated_seller_signals
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[2 · permit lane — address normalization, exact-only matching, honest skips]")

check("suffix + directional + unit all normalize to one key",
  normalizeStreetAddress("1234 N. Lamar Boulevard, Apt 5B") === normalizeStreetAddress("1234 north lamar blvd #5b"),
  `${normalizeStreetAddress("1234 N. Lamar Boulevard, Apt 5B")} vs ${normalizeStreetAddress("1234 north lamar blvd #5b")}`)
check("the city/state tail is dropped before comparison",
  normalizeStreetAddress("55 Oak St, Austin, TX 78701") === normalizeStreetAddress("55 OAK STREET"))
check("an address with no house number yields an empty key (never matchable)",
  normalizeStreetAddress("Lamar Boulevard") === "" && normalizeStreetAddress("") === "" && normalizeStreetAddress(null) === "")
check("two different houses do NOT collide",
  normalizeStreetAddress("1234 Oak St") !== normalizeStreetAddress("1235 Oak St"))

check("address is read across portal-specific column names",
  readPermitAddress({ original_address1: "1234 Oak St" }) === "1234 Oak St"
  && readPermitAddress({ street_address: "9 Elm Ave" }) === "9 Elm Ave"
  && readPermitAddress({ nothing_useful: 1 }) === null)

// THE REAL SHAPES OF THE REGISTERED PORTALS, pinned offline.
// The live block at the bottom of this file caught that NONE of these three publishes a
// single address column — every row of every one of them read as null, so the sweep counted
// three of the largest markets in the country as "nothing happening" rather than "cannot
// read". These rows are verbatim field names and values from one live row of each dataset.
// They are asserted here, with no network, so the regression cannot hide behind a portal
// being unreachable from wherever this happens to run.
check("COMPOSITE ADDRESS — the three registered portals that split it across columns",
  // Chicago ydr8-5enu: number · direction · name
  readPermitAddress({ street_number: "7529", street_direction: "N", street_name: "CLARK ST" }) === "7529 N CLARK ST"
  // San Francisco i98e-djp9: number · name · suffix
  && readPermitAddress({ street_number: "930", street_name: "Sutter", street_suffix: "St" }) === "930 Sutter St"
  // New York ipu4-2q9a: house__ · name (the suffix is inside the name)
  && readPermitAddress({ house__: "60", street_name: "BAY 34 ST" }) === "60 BAY 34 ST"
  // A street with no house number names a BLOCK. Refused — matching a seller signal onto a
  // block is the fuzzy match this lane exists to not make.
  && readPermitAddress({ street_name: "CLARK ST", street_direction: "N" }) === null
  // A single column still wins over the parts when a portal publishes both.
  && readPermitAddress({ address: "1 Main St", street_number: "2", street_name: "Other Rd" }) === "1 Main St")

check("permit id is read across portal-specific column names",
  readPermitId({ permit_number: "2026-123" }) === "2026-123" && readPermitId({}) === null
  // Socrata renders a trailing '#' in a column label as '_', which is where Chicago's
  // "PERMIT#" → permit_ and NYC's job__ both come from. Chicago's was unreadable, so the
  // per-(permit, lead) uniqueness m490 added had no handle to dedupe on.
  && readPermitId({ permit_: "101046020" }) === "101046020"
  && readPermitId({ job__: "340733647" }) === "340733647")
check("valuation parses currency text and refuses junk (never 0-as-unknown)",
  readPermitValuation({ estimated_cost: "$125,000" }) === 125000 && readPermitValuation({ estimated_cost: "n/a" }) === null)

check("demolition is the only 'strong' permit", classifyPermitStrength({ description: "DEMOLITION of single family", valuation: null }) === "strong")
check("pre-listing work is 'moderate'", classifyPermitStrength({ description: "Kitchen remodel", valuation: null }) === "moderate")
check("routine maintenance is 'weak'", classifyPermitStrength({ description: "Water heater replacement", valuation: 900 }) === "weak")
check("a six-figure job lifts an unrecognized permit to moderate", classifyPermitStrength({ description: "misc", valuation: 250_000 }) === "moderate")

const leads = [
  { id: "lead-a", address: "1234 N Lamar Blvd" },
  { id: "lead-b", address: "1234 N Lamar Blvd" }, // same house, two lead records
  { id: "lead-c", address: null },
  { id: "lead-d", address: "Lamar Boulevard" },   // unusable key
]
const permits = [
  { original_address1: "1234 north lamar boulevard apt 2", permit_number: "P-1", description: "Kitchen remodel" },
  { original_address1: "999 Nowhere Ln", permit_number: "P-2", description: "Reroof" },
  { permit_number: "P-3", description: "Demolition" }, // no address at all
  { original_address1: "Lamar Boulevard", permit_number: "P-4" }, // unusable key
]
const outcome = matchPermitsToLeads(permits, leads)
check("both leads at one address get the signal (never a silent tie-break)",
  outcome.matches.length === 2 && new Set(outcome.matches.map((m) => m.leadId)).size === 2)
check("a permit with no readable address is counted, not matched", outcome.skippedNoAddress === 2, `got ${outcome.skippedNoAddress}`)
check("a permit at an address nobody owns is counted, not fuzzy-matched", outcome.skippedNoLeadMatch === 1)
check("an unusable key on BOTH sides never collides (lead-d never matches P-4)",
  !outcome.matches.some((m) => m.leadId === "lead-d"))

const dataset = getMarketDatasets({ state: "TX", city: "Austin" }).find((d) => d.kind === "permits")!
const row = buildPermitSignalRow({ match: outcome.matches[0], brokerageId: "brok-1", dataset })
check("the signal row carries every live motivated_seller_signals column",
  ["lead_id", "brokerage_id", "signal_type", "signal_strength", "detected_via", "signal_details"]
    .every((k) => k in row))
check("it is filed as permit_activity / socrata", row.signal_type === PERMIT_SIGNAL_TYPE && row.detected_via === PERMIT_DETECTED_VIA)
check("it is tenant-stamped", row.brokerage_id === "brok-1")
check("signal_details carries the dedupe key m490's unique index is built on",
  typeof (row.signal_details as any).dedupe_key === "string" && (row.signal_details as any).dedupe_key.length > 0)
check("the dedupe key is stable across runs",
  permitDedupeKey(outcome.matches[0], dataset) === permitDedupeKey(outcome.matches[0], dataset))
check("the dedupe key separates two leads at the same address",
  permitDedupeKey(outcome.matches[0], dataset) !== permitDedupeKey(outcome.matches[1], dataset))

const permitSrc = src("lib/external/permit-signals.ts")
check("the ingest writes the CANONICAL signal table, never the retired twin",
  permitSrc.includes('.from("motivated_seller_signals")')
  && !permitSrc.includes('.from("lead_motivated_seller_signals")'))
check("the ingest never creates a lead or a contact (a permit is an address, not a person)",
  !/\.from\("(leads|contacts)"\)[\s\S]{0,120}\.insert/.test(permitSrc))
check("every read destructures error and reports it",
  (permitSrc.match(/error:\s*\w+Error/g) ?? []).length >= 3 && permitSrc.includes("read refused"))
check("the lead read is tenant-scoped", /\.from\("leads"\)[\s\S]{0,200}\.eq\("brokerage_id"/.test(permitSrc))
check("a duplicate (23505) is absorbed as already-recorded, other errors are reported", permitSrc.includes('"23505"'))

// ─────────────────────────────────────────────────────────────────────────────
// 2b · THE REGISTRY ITSELF. Every claim below was read off a LIVE row on 2026-08-19 and is
// pinned here with no network, because the failures it guards against are invisible failures:
// a wrong dateColumn is an HTTP 400 the sweep swallows into `errors`, and a TEXT dateColumn is
// an HTTP 200 with `[]` that swallows a whole city into "nothing happened today".
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2b · the market registry — every query bound proved against a real row]")

const permitSpec = (state: string, city: string) =>
  getMarketDatasets({ state, city }).find((d) => d.kind === "permits")

check("AUSTIN's query bound is `issue_date` — NOT `issued_date`, which is not a column there and " +
  "answered HTTP 400 every day",
  permitSpec("TX", "Austin")?.dateColumn === "issue_date",
  `got ${permitSpec("TX", "Austin")?.dateColumn}`)
check("SEATTLE's query bound is `issueddate` (no underscore) — the same daily HTTP 400",
  permitSpec("WA", "Seattle")?.dateColumn === "issueddate",
  `got ${permitSpec("WA", "Seattle")?.dateColumn}`)
check("CHICAGO and SAN FRANCISCO keep the bounds that were already right",
  permitSpec("IL", "Chicago")?.dateColumn === "issue_date"
  && permitSpec("CA", "San Francisco")?.dateColumn === "filed_date")

// ── NEW YORK, THE FIFTH FAILURE SHAPE: BOUND VALID, SELECTIVITY ZERO ─────────
// Two waves of correct-but-insufficient reasoning live in this one market.
//   Wave 1: `issuance_date` is TEXT "06/17/2020"; `$where=issuance_date >= '2026-08-12'` compares
//           STRINGS, every month begins '0' or '1', so it is always < '2026…' and NYC returned a
//           200 with [] forever. True. Fixed by bounding on `dobrundate` instead.
//   Wave 2: nobody measured what that bound EXCLUDES. Counted live 2026-08-20 —
//             count(*)                      3,989,981
//             dobrundate >= '2026-08-13'    3,897,421   (97.7%: DOB re-runs the table weekly)
//             issuance_date like '%/2026'       4,940   (0.12%: every 2026 permit there is)
//           A 1000-row page off a 3.9M-row match is a lottery ticket, so the well-formed query
//           yields ~0 real permits while the market reports `covered`. THAT is the failure.
// New York is now served by DOB NOW, whose date column is the event's own and a Calendar date.
const nycLive = permitSpec("NY", "New York")
check("NEW YORK is now served by DOB NOW (rbx6-tga4), bound on `issued_date` — the EVENT date, " +
  "so no re-publish window is needed at all",
  nycLive?.datasetId === "rbx6-tga4" && nycLive?.dateColumn === "issued_date"
  && nycLive?.eventDateColumn === undefined && nycLive?.verifiedOn === "2026-08-20",
  `got ${nycLive?.datasetId} dateColumn=${nycLive?.dateColumn}`)
check("…and its live row reads end to end — house_no · street_name · job_filing_number · " +
  "estimated_job_costs · work_type (NONE of which were readable before 2026-08-20)",
  readPermitAddress({ house_no: "315", street_name: "WEST 29 STREET" }) === "315 WEST 29 STREET"
  && readPermitId({ job_filing_number: "M01301984-S1" }) === "M01301984-S1"
  && readPermitValuation({ estimated_job_costs: "8000" }) === 8000
  && (readPermitDescription({ work_type: "General Construction", job_description: "EXTERIOR RESTORATION" }) ?? "")
    .includes("General Construction")
  && readPermitEventDate({ issued_date: "2026-08-17T00:00:00.000" }, "issued_date") === "2026-08-17")

const nycBis = getMarketDatasets({ state: "NY", city: "New York" })
  .find((d) => d.datasetId === "ipu4-2q9a")
check("…and the BIS-era feed is marked UNAVAILABLE with the COUNTS that prove the bound is not a " +
  "bound — 'well-formed' is not the same claim as 'selective'",
  [/3,897,421/, /3,989,981/, /4,940/].every((re) => re.test(nycBis?.unavailable ?? "")),
  `unavailable=${nycBis?.unavailable ?? "(unset)"}`)
check("…and it no longer registers a dateColumn, so nothing can accidentally query it again",
  nycBis?.dateColumn === undefined)
// The BIS lesson is not deleted with the entry: the mdy re-filter it taught is still the mechanism
// any future re-publish-bounded dataset would use, and readPermitEventDate still refuses 2-digit
// years. Those assertions live in section 2c and are unchanged.
check("NEW YORK's HPD violations feed is untouched by the permits repair",
  getMarketDatasets({ state: "NY", city: "New York" })
    .find((d) => d.kind === "code_violations")?.dateColumn === "novissueddate")

check("every dataset the sweep will actually query has been checked against a live row",
  listQueryablePermitDatasets().every((d) => !!d.verifiedOn),
  listQueryablePermitDatasets().filter((d) => !d.verifiedOn).map((d) => d.datasetId).join(", "))
check("no dataset is BOTH marked unavailable and offered as queryable",
  listQueryablePermitDatasets().every((d) => !d.unavailable))
// DALLAS — the fourth failure shape, found 2026-08-20: COLUMNS RIGHT, FEED DEAD. Last wave read a
// live row, confirmed street_address / permit_number / work_description / value, and registered it
// as merely "un-boundable" because issued_date is TEXT 'MM/DD/YY'. Verifying a ROW proves the
// columns; it does not prove the FEED. `$order=issued_date DESC` returns issued_date "12/31/19",
// the Socrata catalog reports data_updated_at 2020-08-30, and the dataset's own description opens
// "ATTENTION: This permit data set is historical and no longer updated." Fixing the date column
// would have bought a perfectly-formed query returning 2020 permits forever.
check("DALLAS is marked UNAVAILABLE (frozen feed), not merely un-boundable — verifying a row " +
  "proves the columns, never the freshness",
  !!permitSpec("TX", "Dallas")?.unavailable
  && /2020-08-30|historical/i.test(permitSpec("TX", "Dallas")?.unavailable ?? ""),
  `unavailable=${permitSpec("TX", "Dallas")?.unavailable ?? "(unset)"}`)
check("…and it still registers no query bound, because issued_date is TEXT 'MM/DD/YY' — a " +
  "two-digit year that cannot be compared OR parsed",
  permitSpec("TX", "Dallas")?.dateColumn === undefined)

// The markets whose HOST is not a Socrata portal (Phoenix is CKAN, Atlanta and Miami are ArcGIS
// Hub, Denver's id 404s), retired Los Angeles, and frozen Dallas. Registered, so the market is not
// silently missing; marked, so it is never queried into a daily failure.
//
// This looks for the first permits dataset THAT IS MARKED, not simply the first permits dataset:
// a market can now hold both a retired feed and its live successor (Los Angeles and New York both
// do), and asserting on position instead of on the property would have started passing for the
// wrong reason the moment a replacement was registered ahead of the corpse.
const deadPermitSpec = (state: string, city: string) =>
  getMarketDatasets({ state, city }).find((d) => d.kind === "permits" && !!d.unavailable)
const deadMarkets: Array<[string, string]> = [
  ["AZ", "Phoenix"], ["GA", "Atlanta"], ["FL", "Miami"], ["CO", "Denver"], ["CA", "Los Angeles"],
  ["TX", "Dallas"], ["NY", "New York"],
]
check("the seven permit datasets that cannot serve are MARKED with a stated reason, not deleted",
  deadMarkets.every(([s, c]) => {
    const d = deadPermitSpec(s, c)
    return !!d?.unavailable && d.unavailable.length > 10
  }),
  deadMarkets.filter(([s, c]) => !deadPermitSpec(s, c)).map(([s, c]) => `${s}:${c}`).join(", "))
check("…and a marked dataset is never ALSO offered as queryable, in any market that holds both",
  listQueryableDatasets().every((d) => !d.unavailable))

// ── LOS ANGELES: 'stale' WAS HALF AN ANSWER. LADBS MOVED. ────────────────────
// Last wave measured that yv23-pmwf stopped (data_updated_at 2023-05-22), marked it, and left the
// second-largest city in the country dark. Re-probed 2026-08-20: the id is now absent from the
// Socrata catalog outright, its published view xnhu-aczu stops at max(issue_date) 2023-05-19 —
// and a catalog search on data.lacity.org for "building permit" returns a LIVE successor with
// $where=issue_date >= '2026-08-13' → 502 rows, max 2026-08-15. "This feed is dead" and "this
// market is unreadable" are different sentences, and only the first one was ever proved.
const laLive = permitSpec("CA", "Los Angeles")
check("LOS ANGELES is served again by pi9x-tg5x, bound on `issue_date` and row-verified",
  laLive?.datasetId === "pi9x-tg5x" && laLive?.dateColumn === "issue_date"
  && laLive?.verifiedOn === "2026-08-20" && !laLive?.unavailable,
  `got ${laLive?.datasetId} dateColumn=${laLive?.dateColumn}`)
check("…and its live row reads end to end — primary_address · permit_nbr · valuation · work_desc",
  readPermitAddress({ primary_address: "7006 W GREELEY ST" }) === "7006 W GREELEY ST"
  && readPermitId({ permit_nbr: "23016-10000-02499" }) === "23016-10000-02499"
  && readPermitValuation({ valuation: "10000" }) === 10000
  && (readPermitDescription({ work_desc: "ADDITION TO (E) SINGLE FMAILY DWELLING PER WFPP." }) ?? "")
    .includes("ADDITION")
  && readPermitEventDate({ issue_date: "2026-08-15T00:00:00.000" }, "issue_date") === "2026-08-15")
check("…and the retired feed is kept, marked with WHERE the data went, not deleted",
  /pi9x-tg5x/.test(deadPermitSpec("CA", "Los Angeles")?.unavailable ?? "")
  && /2023-05-19/.test(deadPermitSpec("CA", "Los Angeles")?.unavailable ?? ""))
check("…so Los Angeles and New York both read as COVERED again, from the successor feed",
  classifyMarketCoverage({ state: "CA", city: "Los Angeles" }).status === "covered"
  && classifyMarketCoverage({ state: "NY", city: "New York" }).status === "covered")
check("…and each still reports its dead sibling's reason in `reasons`, so the repair is visible",
  classifyMarketCoverage({ state: "CA", city: "Los Angeles" }).reasons.some((r) => /retired/.test(r))
  && classifyMarketCoverage({ state: "NY", city: "New York" }).reasons.some((r) => /unboundable in practice/.test(r)))

// A widened description list can only ever move a permit UP the conservative ladder — never down,
// and never past the one rule that matters (only demolition reads strong). Pinned, because the
// next person to add a portal's work-text column needs to know that is the invariant.
check("reading MORE work text never weakens a verdict and never invents a 'strong' one",
  classifyPermitStrength({ description: readPermitDescription({ work_type: "Plumbing" }), valuation: null }) === "weak"
  && classifyPermitStrength({ description: readPermitDescription({ work_type: "General Construction", job_description: "KITCHEN REMODEL" }), valuation: null }) === "moderate"
  && classifyPermitStrength({ description: readPermitDescription({ work_desc: "DEMOLITION OF SFD" }), valuation: null }) === "strong")

// MONTGOMERY COUNTY, MARYLAND — added 2026-08-20 off a live row, not a document.
// `$where=issueddate >= '2026-08-01'` returned permitno "1167770" · issueddate
// "2026-08-18T12:08:57.000" · stno "7721" · stname "POLARA" · suffix "PL" · city "ROCKVILLE"
// · declaredvaluation "8263" · worktype "ALTER". Every field this lane reads is asserted here
// with the portal's real names, so the "readers do not cover this portal" failure that made
// Chicago/SF/NYC report every row as skippedNoAddress cannot recur silently for this one.
const mont = permitSpec("MD", "Rockville")
check("MONTGOMERY COUNTY MD is registered, bound on `issueddate`, and row-verified",
  mont?.host === "data.montgomerycountymd.gov" && mont?.datasetId === "m88u-pqki"
  && mont?.dateColumn === "issueddate" && mont?.verifiedOn === "2026-08-20",
  `got ${mont?.host}/${mont?.datasetId} dateColumn=${mont?.dateColumn}`)
check("…and the readers actually read its live row (stno · stname · suffix · permitno · " +
  "declaredvaluation)",
  readPermitAddress({ stno: "7721", stname: "POLARA", suffix: "PL" }) === "7721 POLARA PL"
  && readPermitId({ permitno: "1167770" }) === "1167770"
  && readPermitValuation({ declaredvaluation: "8263" }) === 8263
  && readPermitEventDate({ issueddate: "2026-08-18T12:08:57.000" }, "issueddate") === "2026-08-18")
check("…and the county's ONE dataset is registered under every city in it, deduped by host/id " +
  "so a tenant farming three of them queries it once",
  ["Rockville", "Silver Spring", "Bethesda", "Gaithersburg", "Germantown", "Takoma Park"]
    .every((c) => permitSpec("MD", c)?.datasetId === "m88u-pqki"))
check("every registered market still resolves (marking a dataset never un-registers the market)",
  Object.values(MARKETS).every((m) => getMarketDatasets({ state: m.state, city: m.city }).length > 0))

console.log("\n[2c · event date — the guard against a portal that re-publishes its history]")
check("MM/DD/YYYY is parsed to a comparable ISO day",
  readPermitEventDate({ issuance_date: "06/17/2020" }, "issuance_date", "mdy") === "2020-06-17"
  && readPermitEventDate({ issuance_date: "8/4/1998" }, "issuance_date", "mdy") === "1998-08-04")
check("a TWO-digit year is REFUSED, never guessed into a century (this is Dallas's shape)",
  readPermitEventDate({ issued_date: "03/13/20" }, "issued_date", "mdy") === null)
check("a floating timestamp reads as its calendar day, and an absent column reads null",
  readPermitEventDate({ dobrundate: "2026-08-14T00:00:00.000" }, "dobrundate") === "2026-08-14"
  && readPermitEventDate({}, "dobrundate") === null)

// Three real NYC-shaped rows, one in-window, one a 1998 permit DOB re-published this week, one
// an application that was never issued and so carries no issuance_date at all.
const nycLeads = [{ id: "lead-ny", address: "60 BAY 34 ST" }, { id: "lead-ny2", address: "4 METROTECH CENTER" }]
const nycRows = [
  { house__: "60", street_name: "BAY 34 ST", job__: "340733647", issuance_date: "08/15/2026", dobrundate: "2026-08-15T00:00:00.000", job_type: "A2" },
  { house__: "4", street_name: "METROTECH CENTER", job__: "300771412", issuance_date: "08/14/1998", dobrundate: "2026-08-14T00:00:00.000" },
  { house__: "60", street_name: "BAY 34 ST", job__: "420665587", dobrundate: "2026-08-10T00:00:00.000" },
]
const windowed = matchPermitsToLeads(nycRows, nycLeads, { column: "issuance_date", format: "mdy", sinceIso: "2026-08-12" })
check("only the permit issued INSIDE the window becomes a signal",
  windowed.matches.length === 1 && windowed.matches[0].permitId === "340733647",
  `matched ${windowed.matches.map((m) => m.permitId).join(",")}`)
check("a 1998 permit re-published this week is counted as out-of-window, not filed as a fresh signal",
  windowed.skippedOutsideWindow === 1)
check("a row with NO issuance_date is counted separately — 'cannot read' is never 'not recent'",
  windowed.skippedNoEventDate === 1)
check("with no window declared, every fetched row is still considered (Chicago/SF/Austin/Seattle)",
  matchPermitsToLeads(nycRows, nycLeads).matches.length === 3)

console.log("\n[2d · LA's column names, recorded so the entry works the day LADBS resumes publishing]")
check("LA's house number is `address_start` and its permit id is `pcis_permit`",
  readPermitAddress({ address_start: "1234", street_direction: "N", street_name: "SPRING", street_suffix: "ST" })
    === "1234 N SPRING ST"
  && readPermitId({ pcis_permit: "20WL-12345" }) === "20WL-12345")

console.log("\n[2e · an unavailable dataset is COUNTED, and never queried]")
{
  // ── SUBJECT MOVED, RULE INTACT (2026-08-20) ───────────────────────────────
  // This block used to name FOUR markets — Phoenix, Atlanta, Miami, Denver — as wholly
  // unavailable. MIAMI IS NOW COVERED: its permits were always live on Miami-Dade's ArcGIS
  // FeatureServer and the registry's own `unavailable` reason said only that an adapter was
  // missing (see section 2i). Leaving Miami in this list would assert that a market this OS can
  // now read is unreadable — a green test certifying the gap it was written to catch, which is
  // worse than a red one. So the SUBJECT is corrected and the RULE it expressed is unchanged:
  // a dataset the registry marks broken is COUNTED and REPORTED, never quietly queried.
  //
  // Phoenix (CKAN), Atlanta (retired ArcGIS Hub) and Denver (wrong host) stay. Note that Atlanta
  // and Denver are now unavailable for a DIFFERENT reason than before: the adapter exists, so
  // what they lack is a verified live layer, not a client. That is a data task, not a code one.
  //
  // Every one of these markets is marked unavailable, so `datasets` comes out empty and the ingest
  // returns before it touches supabase or the network. The stub proves it: any call throws.
  const forbidden: any = { from: () => { throw new Error("the ingest touched the database for a market it cannot query") } }
  const r = await ingestPermitSignals({
    supabase: forbidden,
    brokerageId: "brok-x",
    territories: [
      { brokerage_id: "brok-x", state: "AZ", city: "Phoenix" },
      { brokerage_id: "brok-x", state: "GA", city: "Atlanta" },
      { brokerage_id: "brok-x", state: "CO", city: "Denver" },
    ],
    sinceIso: "2026-08-12",
  })
  check("three dead portals are reported as three unavailable datasets, not as three quiet markets",
    r.datasetsUnavailable === 3 && r.datasetsQueried === 0,
    `unavailable=${r.datasetsUnavailable} queried=${r.datasetsQueried}`)
  check("…each with the registry's stated reason attached", r.unavailableReasons.length === 3
    && r.unavailableReasons.every((x) => /CKAN|ArcGIS|404/.test(x)))
  // The repoint, asserted from the OTHER side: Miami must NOT be reportable as unavailable now.
  check("…and MIAMI is no longer among them — a repointed market must leave the dead list",
    !r.unavailableReasons.some((x) => /Miami-Dade/.test(x))
    && classifyMarketCoverage({ state: "FL", city: "Miami" }).status === "covered")
  check("…and none of them is miscounted as an unregistered market or a missing date column",
    r.marketsUnregistered === 0 && r.datasetsSkippedNoDateColumn === 0)
  check("a territory in no registered market is still counted as unregistered",
    (await ingestPermitSignals({
      supabase: forbidden, brokerageId: "brok-x", sinceIso: "2026-08-12",
      territories: [{ brokerage_id: "brok-x", state: "MT", city: "Bozeman" }],
    })).marketsUnregistered === 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2f · COVERAGE — the gap taxonomy the owner ruling requires
// "all markets from the active tenant territories for motivational sellers."
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2f · territory → market coverage — every gap NAMED, never a silent zero]")

check("a covered market says so, and hands back the datasets that will be queried",
  classifyMarketCoverage({ state: "IL", city: "Chicago" }).status === "covered"
  && classifyMarketCoverage({ state: "IL", city: "Chicago" }).queryable.length > 0)
check("an UNREGISTERED market is named, not counted — this is the loudest gap",
  classifyMarketCoverage({ state: "MT", city: "Bozeman" }).status === "unregistered"
  && classifyMarketCoverage({ state: "MT", city: "Bozeman" }).market === "MT:Bozeman")

// THE LIVE TENANTS OF THIS OS ARE IN THE FLORIDA PANHANDLE — brokerages `VIP Premier Realty`
// (Pensacola FL) and `Your Brokerage` (Pace FL), read from the live project 2026-08-20. Neither
// market is registered and NEITHER CAN BE: the Socrata catalog returns zero datasets for
// q=Pensacola and zero for q=Escambia. Before this pass those tenants would have been served a
// clean "0 signals" forever. Now they are named. This assertion exists so that stays true.
check("PENSACOLA and PACE FL — where this OS's only two tenants actually are — come back as " +
  "UNREGISTERED BY NAME, never as a quiet market",
  classifyMarketCoverage({ state: "FL", city: "Pensacola" }).status === "unregistered"
  && classifyMarketCoverage({ state: "FL", city: "Pace" }).status === "unregistered")
check("a market registered but wholly unavailable is `unavailable`, WITH the reasons attached",
  classifyMarketCoverage({ state: "AZ", city: "Phoenix" }).status === "unavailable"
  && classifyMarketCoverage({ state: "AZ", city: "Phoenix" }).reasons.some((r) => /CKAN/.test(r)))
check("…and Dallas, whose only two datasets are a frozen feed and a nonexistent id, likewise",
  classifyMarketCoverage({ state: "TX", city: "Dallas" }).status === "unavailable")
check("the four statuses are distinct verdicts, not one boolean",
  new Set(
    [["IL", "Chicago"], ["MT", "Bozeman"], ["AZ", "Phoenix"]]
      .map(([s, c]) => classifyMarketCoverage({ state: s, city: c }).status),
  ).size === 3)

{
  // The end-to-end proof: a tenant whose territories are one covered market, one dead market and
  // one nobody ever registered. Every one of the three must come back named.
  const forbidden: any = { from: () => { throw new Error("touched the database before coverage was decided") } }
  const r = await ingestPermitSignals({
    supabase: forbidden, brokerageId: "brok-cov", sinceIso: "2026-08-13",
    territories: [
      { brokerage_id: "brok-cov", state: "FL", city: "Pensacola" },
      { brokerage_id: "brok-cov", state: "AZ", city: "Phoenix" },
      { brokerage_id: "brok-cov", state: "TX", city: "Dallas" },
    ],
  })
  check("every active territory gets a verdict, one per market",
    r.coverage.length === 3 && r.coverage.every((c) => !!c.market && !!c.status),
    r.coverage.map((c) => `${c.market}=${c.status}`).join(" "))
  check("…and every one that produced nothing is in market_gaps BY NAME",
    r.marketGaps.length === 3
    && r.marketGaps.some((g) => g.startsWith("FL:Pensacola") && g.includes("unregistered")),
    r.marketGaps.join(" | "))
  check("a duplicate territory row for one city does not double-report the market",
    (await ingestPermitSignals({
      supabase: forbidden, brokerageId: "brok-cov", sinceIso: "2026-08-13",
      territories: [
        { brokerage_id: "brok-cov", state: "FL", city: "Pensacola" },
        { brokerage_id: "brok-cov", state: "FL", city: "pensacola" },
      ],
    })).coverage.length === 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2g · CODE VIOLATIONS — registered since day one, ingested since today
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2g · code violations — the registered datasets the ingest used to throw away]")

const violationSpec = (state: string, city: string) =>
  getMarketDatasets({ state, city }).find((d) => d.kind === "code_violations")

// Chicago 22u3-xenr, live row 2026-08-20 (`$order=violation_date DESC`).
check("CHICAGO's violations dataset is bound on `violation_date` and row-verified",
  violationSpec("IL", "Chicago")?.dateColumn === "violation_date"
  && violationSpec("IL", "Chicago")?.verifiedOn === "2026-08-20")
check("…and its live row reads end to end (address · violation_description · violation_status)",
  readPermitAddress({ address: "3830 W 63RD ST" }) === "3830 W 63RD ST"
  && (readPermitDescription({ violation_description: "REPAIR DOOR, INT." }) ?? "").includes("REPAIR DOOR")
  && readViolationStatus({ violation_status: "OPEN" }) === "OPEN"
  && readPermitEventDate({ violation_date: "2026-08-18T00:00:00.000" }, "violation_date") === "2026-08-18")

// NYC HPD wvxf-dwi5, live row 2026-08-20 via `$where=novissueddate > '2026-08-01'` — which RETURNS
// ROWS, so unlike its permit sibling ipu4-2q9a this dataset's bound really is a Calendar date.
const nycViol = violationSpec("NY", "New York")
check("NEW YORK's HPD violations bind on `novissueddate` — the day the notice was ISSUED to the " +
  "owner, which is when the pressure starts, not the inspection date",
  nycViol?.dateColumn === "novissueddate" && nycViol?.verifiedOn === "2026-08-20",
  `got ${nycViol?.dateColumn}`)
check("…and its composite address + violationid are readable (they were not, before today)",
  readPermitAddress({ housenumber: "116", streetname: "LENOX ROAD" }) === "116 LENOX ROAD"
  && readPermitId({ violationid: "19075125" }) === "19075125"
  && readPermitEventDate({ novissueddate: "2026-08-03T00:00:00.000" }, "novissueddate") === "2026-08-03")

// The two ids that never existed. `ids=skuc-86g2` and `ids=9ahz-iyrm` against the Socrata catalog
// both return zero results (2026-08-20), and both 404 on fetch — written from documentation, like
// the date columns last wave undid.
check("SEATTLE's and DALLAS's violation dataset ids DO NOT EXIST and are marked so, not queried",
  ["skuc-86g2", "9ahz-iyrm"].every((id) => {
    const d = [violationSpec("WA", "Seattle"), violationSpec("TX", "Dallas")].find((x) => x?.datasetId === id)
    return !!d?.unavailable && /absent from the Socrata catalog/i.test(d.unavailable)
  }))

// Coverage is what the sweep can READ, and both kinds now count toward it. Every dataset offered
// as queryable — permits and violations alike — has been checked against a live row.
check("every dataset the sweep will query, of EITHER kind, is row-verified and not marked broken",
  listQueryableDatasets().every((d) => !!d.verifiedOn && !d.unavailable)
  && listQueryableDatasets("code_violations").length === 2
  && listQueryableDatasets().length > listQueryablePermitDatasets().length,
  `permits=${listQueryablePermitDatasets().length} all=${listQueryableDatasets().length} ` +
  `unverified=${listQueryableDatasets().filter((d) => !d.verifiedOn).map((d) => d.datasetId).join(",")}`)

check("a violation is filed under its OWN signal_type, never merged into permit_activity",
  signalTypeForKind("code_violations") === VIOLATION_SIGNAL_TYPE
  && signalTypeForKind("permits") === PERMIT_SIGNAL_TYPE
  // Widened to string BEFORE comparing. Both constants are literal-typed, so TS
  // resolves `!==` at compile time and reports the comparison as unintentional —
  // which is exactly backwards: this assertion exists to catch someone LATER
  // collapsing the two literals into one, and it can only do that at runtime.
  && (VIOLATION_SIGNAL_TYPE as string) !== (PERMIT_SIGNAL_TYPE as string)
  && SOCRATA_SIGNAL_TYPES.length === 2)

// STRENGTH STAYS CONSERVATIVE. The lane's rule is "only demolition reads strong" — that belongs to
// the LANE, not to permits, so a violation ordering a structure razed reads strong and nothing else
// does. An OPEN violation is moderate; a COMPLIED one is weak, because it is evidence the owner
// FIXED the problem, which is close to the opposite of distress.
check("only demolition language reads 'strong' for a violation too",
  classifyViolationStrength({ description: "DEMOLITION of unsafe structure ordered", status: "OPEN" }) === "strong")
check("an OPEN violation is 'moderate' — real and unresolved, but most of them are one handrail",
  classifyViolationStrength({ description: "REPAIR DOOR, INT.", status: "OPEN" }) === "moderate"
  && classifyViolationStrength({ description: "FIRE ESCAPE DEFECTIVE", status: "Open" }) === "moderate")
check("a COMPLIED / Close violation is 'weak' — the owner fixed it; that is not distress",
  classifyViolationStrength({ description: "REPAIR DOOR, INT.", status: "COMPLIED" }) === "weak"
  && classifyViolationStrength({ description: "FIRE ESCAPE DEFECTIVE", status: "Close" }) === "weak")
check("'Close' must not be read as 'Open' by a substring search — the two vocabularies overlap",
  classifyViolationStrength({ description: "x", status: "Close" }) !== "moderate")
check("an unreadable status is 'weak', never assumed open",
  classifyViolationStrength({ description: "x", status: null }) === "weak"
  && classifyViolationStrength({ description: "x", status: "NO ENTRY" }) === "weak")

// Chicago's violations feed publishes NO case number — only a bare `id`, which is a ROW id. Keying
// on it would file a fresh signal every time the portal republished. Keying on address alone would
// collapse every violation a property ever collects into ONE signal, destroying the accrual that
// makes violations predictive in the first place. The event DATE is the third answer: stable across
// re-reads, and different for different citations.
{
  const chi = violationSpec("IL", "Chicago")!
  const rows = [
    { address: "1234 N LAMAR BLVD", violation_description: "REPAIR DOOR, INT.", violation_status: "OPEN", violation_date: "2026-08-18T00:00:00.000", id: "7530910" },
    { address: "1234 N LAMAR BLVD", violation_description: "PORCH DEFECTIVE", violation_status: "OPEN", violation_date: "2026-08-14T00:00:00.000", id: "7530777" },
    { address: "1234 N LAMAR BLVD", violation_description: "REPAIR DOOR, INT.", violation_status: "OPEN", violation_date: "2026-08-18T00:00:00.000", id: "7530910" },
  ]
  const out = matchPermitsToLeads(rows, [{ id: "lead-chi", address: "1234 N Lamar Blvd" }], undefined,
    { dateColumn: "violation_date", kind: "code_violations" })
  check("a bare row `id` is NOT accepted as a record handle (it moves when the portal republishes)",
    out.matches.every((m) => m.permitId === null))
  const keys = out.matches.map((m) => permitDedupeKey(m, chi))
  check("two violations at one address on DIFFERENT days are two signals (accrual survives)",
    new Set(keys).size === 2, keys.join(" | "))
  check("…and the same violation seen twice in one window is still one",
    keys[0] === keys[2])
  const row = buildPermitSignalRow({ match: out.matches[0], brokerageId: "brok-1", dataset: chi })
  check("the violation row is filed as code_violation / socrata with its status recorded",
    row.signal_type === VIOLATION_SIGNAL_TYPE && row.detected_via === PERMIT_DETECTED_VIA
    && (row.signal_details as any).violation_status === "OPEN"
    && (row.signal_details as any).dataset_kind === "code_violations")
  check("…and its reason sentence is a FIXED string about a violation, not a permit",
    /code violation/i.test(String((row.signal_details as any).reason)))
}

check("the ingest reads back BOTH signal types for idempotency — an .eq here would re-file every " +
  "violation daily, and lead scoring COUNTS signals",
  /\.in\("signal_type", SOCRATA_SIGNAL_TYPES\)/.test(permitSrc))
check("the ingest no longer discards every non-permit dataset it is handed",
  permitSrc.includes("classifyMarketCoverage")
  && !/^\s*if \(spec\.kind !== "permits"\) continue/m.test(permitSrc))

const m499 = src("supabase/migrations/m499-a-second-signal-type-swept-daily-had-no-uniqueness-rule-at-all.sql")
check("m499 exists and widens the uniqueness rule to BOTH signal types",
  m499.includes("code_violation") && m499.includes("permit_activity")
  && /CREATE UNIQUE INDEX[\s\S]{0,400}signal_type IN \('permit_activity', 'code_violation'\)/.test(m499))
check("…and retires m490's narrower index rather than leaving two rules in force",
  m499.includes("DROP INDEX IF EXISTS public.motivated_seller_signals_permit_dedupe"))
check("…creating the new index BEFORE dropping the old (no window with no guarantee)",
  m499.indexOf("CREATE UNIQUE INDEX") < m499.indexOf("DROP INDEX"))

// ─────────────────────────────────────────────────────────────────────────────
// 2h · the SoQL interpolation guard
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2h · recentPermits interpolates into $where — the guard for when config is editable]")

check("real portal field names pass, INCLUDING the trailing-underscore ones Socrata generates",
  ["issue_date", "issueddate", "dobrundate", "novissueddate", "permit_", "job__", "violation_date"]
    .every(isSoqlFieldName))
check("anything that is not a field name is REFUSED, not escaped",
  ["issue_date' OR 1=1 --", "issue_date, count(*)", "ISSUE_DATE", "", "a b", "1abc", "date)"]
    .every((v) => !isSoqlFieldName(v)))
check("only a bare YYYY-MM-DD is accepted as the bound",
  isIsoCalendarDay("2026-08-20")
  && !isIsoCalendarDay("2026-08-20T00:00:00.000")
  && !isIsoCalendarDay("2026-08-20' OR '1'='1")
  && !isIsoCalendarDay(""))
{
  // The refusal rides the adapter's own envelope, so the sweep counts it exactly like an outage.
  const bad = await recentPermits({
    host: "data.cityofchicago.org", datasetId: "ydr8-5enu",
    sinceIso: "2026-08-01", permitDateColumn: "issue_date' OR 1=1 --", limit: 1,
  })
  check("a bad date column returns ok:false with a stated reason and never reaches the network",
    bad.ok === false && /not a Socrata field name/.test(bad.error ?? ""))
  const badDate = await recentPermits({
    host: "data.cityofchicago.org", datasetId: "ydr8-5enu",
    sinceIso: "2026-08-01'; DROP TABLE leads; --", permitDateColumn: "issue_date", limit: 1,
  })
  check("…and so does a bad date bound",
    badDate.ok === false && /calendar day/.test(badDate.error ?? ""))
}

const cronPath = "/api/cron/permit-signal-scan"
check("the cron route file exists", existsSync(join(root, "app/api/cron/permit-signal-scan/route.ts")))
check("the route is gated the way its neighbours are (verifyCronAuth)",
  src("app/api/cron/permit-signal-scan/route.ts").includes("verifyCronAuth"))
check("the route uses the ACTIVE-subscriber territory resolver, not fixed geography",
  src("app/api/cron/permit-signal-scan/route.ts").includes("resolveActiveScrapeTerritories"))
check("the route reports the registry's broken datasets instead of absorbing them into a 0",
  src("app/api/cron/permit-signal-scan/route.ts").includes("unavailable_datasets")
  && src("app/api/cron/permit-signal-scan/route.ts").includes("datasets_unavailable"))
check("the route reports a verdict for EVERY active territory, and names the gaps — the owner " +
  "ruling is 'all markets from the active tenant territories', not 'all registered markets'",
  src("app/api/cron/permit-signal-scan/route.ts").includes("market_coverage")
  && src("app/api/cron/permit-signal-scan/route.ts").includes("market_gaps")
  && /marketGaps[\s\S]{0,200}reasons/.test(src("app/api/cron/permit-signal-scan/route.ts")))
check("…and reports the two window skips separately from the address skips",
  src("app/api/cron/permit-signal-scan/route.ts").includes("skipped_outside_window")
  && src("app/api/cron/permit-signal-scan/route.ts").includes("skipped_no_event_date"))
check("the cron is registered in the single-heartbeat dispatcher", CRON_REGISTRY.some((c) => c.path === cronPath))
check("the cron has an accountable manager", cronPath in CRON_MANAGER && CRON_MANAGER[cronPath] in MANAGERS)

// ─────────────────────────────────────────────────────────────────────────────
// 2i · THE SECOND PROVIDER — ArcGIS, where a failure is an HTTP 200
// ─────────────────────────────────────────────────────────────────────────────
//
// THE FIXTURES BELOW ARE RECORDED, NOT INVENTED. Every one was read live from Miami-Dade's
// FeatureServer on 2026-08-20 and pasted verbatim, so this section runs with NO NETWORK and
// still asserts against the bytes a real portal sends:
//
//   .../miamidade_permit_data/FeatureServer/0/query?where=<...>&f=json
//
// The whole point of the section is the pair of states that this lane has now mistaken for one
// another five separate times, arriving on a new provider where the mistake is the DEFAULT:
// ArcGIS answers its own errors with HTTP 200 and an `error` object in the body. A caller that
// trusts the status code reads a deleted layer, a renamed column and a genuinely quiet week as
// the same thing — zero permits.
console.log("\n[2i · ArcGIS provider — a dead layer and a quiet week are BOTH HTTP 200]")

// ── the four recorded payloads ──────────────────────────────────────────────
/** Live page, 2026-08-20: `where=PermitIssuedDate >= DATE '2026-08-13'`, ordered DESC. */
const ARCGIS_LIVE_PAGE = {
  objectIdFieldName: "ObjectId",
  uniqueIdField: { name: "ObjectId", isSystemMaintained: true },
  globalIdFieldName: "GlobalID",
  exceededTransferLimit: true,
  features: [
    { attributes: {
      PermitNumber: "2026065888", PermitIssuedDate: "2026-08-18", PropertyAddress: "2960 SW 109 CT",
      PermitType: "ELEC", ApplicationTypeDescription: "ALTER - EXTERIOR",
      DetailDescriptionComments: "ELEC PANEL", EstimatedValue: "1800",
      ResidentialCommercial: "R", ProposedUseDescription: "SINGLE FAM RES-CLUST-ZERO LOT-TOWN HOUSE" } },
    { attributes: {
      PermitNumber: "2026065887", PermitIssuedDate: "2026-08-18", PropertyAddress: "19602 SW 136 AVE",
      PermitType: "BLDG", ApplicationTypeDescription: "FENCE NOMASONRY",
      DetailDescriptionComments: "DURA FENCE", EstimatedValue: "3500",
      ResidentialCommercial: "R", ProposedUseDescription: "SINGLE FAM RES-CLUST-ZERO LOT-TOWN HOUSE" } },
    { attributes: {
      PermitNumber: "2026065886", PermitIssuedDate: "2026-08-18", PropertyAddress: "5280 NW 77 CT",
      PermitType: "MBLD", ApplicationTypeDescription: "RE-ROOF/REPAIR",
      DetailDescriptionComments: "REROOF", EstimatedValue: "51000",
      ResidentialCommercial: "C", ProposedUseDescription: "WAREHOUSE/STORAGE" } },
  ],
}
/** A window with nothing in it: `where=PermitIssuedDate >= DATE '2099-01-01'`. HTTP 200. */
const ARCGIS_EMPTY = {
  objectIdFieldName: "ObjectId",
  uniqueIdField: { name: "ObjectId", isSystemMaintained: true },
  globalIdFieldName: "GlobalID",
  features: [],
}
/** A column that does not exist: `where=NoSuchField >= DATE '2026-08-13'`. ALSO HTTP 200. */
const ARCGIS_INVALID_FIELD = {
  error: { code: 400, message: "Cannot perform query. Invalid query parameters.",
           details: ["'Invalid field: NoSuchField' parameter is invalid"] },
}
/** A layer that does not exist: `/FeatureServer/99/query`. ALSO HTTP 200. */
const ARCGIS_INVALID_URL = { error: { code: 400, message: "Invalid URL", details: ["Invalid URL"] } }

// ── THE CORE ASSERTION OF THIS WHOLE LANE ───────────────────────────────────
{
  const live = parseArcgisResponse(ARCGIS_LIVE_PAGE, ["PermitIssuedDate"])
  const empty = parseArcgisResponse(ARCGIS_EMPTY, ["PermitIssuedDate"])
  const badField = parseArcgisResponse(ARCGIS_INVALID_FIELD, ["PermitIssuedDate"])
  const badLayer = parseArcgisResponse(ARCGIS_INVALID_URL, ["PermitIssuedDate"])

  check("A DATASET RETURNING ZERO ROWS IS DISTINGUISHABLE FROM ONE THAT FAILED — the defect " +
    "this lane keeps re-learning, on the provider where both are HTTP 200",
    empty.ok === true && empty.rows.length === 0
    && badField.ok === false && badLayer.ok === false,
    `empty=${empty.ok}/${empty.rows.length} badField=${badField.ok} badLayer=${badLayer.ok}`)
  check("…and the refusals carry the PORTAL'S OWN WORDS, so the operator sees why without a portal",
    /Invalid field: NoSuchField/.test(badField.error ?? "")
    && /Invalid URL/.test(badLayer.error ?? ""),
    `${badField.error} | ${badLayer.error}`)
  check("an empty result states NO error — 'quiet' is a real, reportable answer, not a soft failure",
    empty.error === null && badField.error !== null && badLayer.error !== null)

  // NEGATIVE CONTROL. A body that is neither an error nor a feature collection (an HTML error
  // page, a redirect, a schema-only response) must ALSO not read as an empty market.
  check("NEGATIVE CONTROL — a payload with no `features` array is UNREADABLE, never zero rows",
    [{ foo: "bar" }, {}, "<html>502</html>", null, 42].every((p) => {
      const r = parseArcgisResponse(p, [])
      return r.ok === false && r.rows.length === 0 && !!r.error
    }))
  // NEGATIVE CONTROL. The three intents must occupy three distinct (ok, rows, error?) states —
  // if any two collapse, the distinction above is decorative.
  check("NEGATIVE CONTROL — served-empty, refused and served-with-rows are THREE distinct states",
    new Set([live, empty, badField].map((r) => `${r.ok}:${r.rows.length > 0}:${r.error !== null}`)).size === 3)

  check("the live page's three rows parse, and the page cap is REPORTED rather than passed off " +
    "as a complete window",
    live.rows.length === 3 && live.exceededTransferLimit === true)

  // The existing readers must cover this portal with NO ArcGIS-specific branch — that is what
  // makes a second provider one `if` in the fetch loop instead of a second lane.
  const row = live.rows[0]
  check("the SHARED readers read an ArcGIS row end to end (address · id · date · value · work)",
    readPermitAddress(row) === "2960 SW 109 CT"
    && readPermitId(row) === "2026065888"
    && readPermitEventDate(row, "PermitIssuedDate") === "2026-08-18"
    && readPermitValuation(row) === 1800
    && (readPermitDescription(row) ?? "").includes("ELEC PANEL"),
    `addr=${readPermitAddress(row)} id=${readPermitId(row)} val=${readPermitValuation(row)}`)
  check("…and the address normalizes to a matchable key",
    normalizeStreetAddress(readPermitAddress(row)) === "2960 SW 109 CT")

  // Strength on a REAL row, not a crafted one. The re-roof is the interesting case: `readPermit
  // Description` has to reach DetailDescriptionComments/ApplicationTypeDescription for "roof" to
  // be visible at all, so this asserts the reader and the classifier together.
  const reroof = live.rows[2]
  check("a real RE-ROOF permit classifies `moderate` — pre-listing work, read through the " +
    "ArcGIS description columns",
    classifyPermitStrength({
      description: readPermitDescription(reroof), valuation: readPermitValuation(reroof),
    }) === "moderate")
  check("…and a fence permit does NOT — routine work stays `weak` on either provider",
    classifyPermitStrength({
      description: readPermitDescription(live.rows[1]), valuation: readPermitValuation(live.rows[1]),
    }) === "weak")
  // The lane's vocabulary ceiling, restated on the new provider: a permit is a fact about a
  // STRUCTURE, so no ArcGIS row may ever reach the top of the ladder either.
  check("no ArcGIS row can produce `urgent` — the ceiling belongs to the LANE, not the provider",
    live.rows.every((r) => classifyPermitStrength({
      description: readPermitDescription(r), valuation: readPermitValuation(r),
    }) !== ("urgent" as string))
    && SELLER_SIGNAL_STRENGTHS.includes("urgent" as never))
}

// ── date normalisation: two wire shapes, one downstream vocabulary ──────────
check("an esriFieldTypeDateOnly STRING passes through as the calendar day it already is",
  arcgisDateToIsoDay("2026-08-18") === "2026-08-18")
check("an esriFieldTypeDate EPOCH-MILLIS number becomes the same shape readPermitEventDate parses",
  arcgisDateToIsoDay(Date.UTC(2026, 7, 18)) === "2026-08-18")
check("NEGATIVE CONTROL — garbage is REFUSED with null, never coerced into a plausible day",
  [null, undefined, "", "not a date", {}, [], true, 0, -1].every((v) => arcgisDateToIsoDay(v) === null))
{
  // A real epoch row, normalised by the parser and then read by the SHARED reader — proving the
  // two halves agree rather than each being right on its own.
  const epochRow = parseArcgisResponse(
    { features: [{ attributes: { PermitNumber: "X1", PermitIssuedDate: Date.UTC(2026, 7, 14),
                                 PropertyAddress: "1 MAIN ST" } }] },
    ["PermitIssuedDate"],
  )
  check("an epoch-millis date survives parse → readPermitEventDate with no ArcGIS-aware reader",
    readPermitEventDate(epochRow.rows[0], "PermitIssuedDate") === "2026-08-14")
  // An UNPARSEABLE date must leave the original value alone, so permit-signals can still tell
  // "column absent" from "column present and unreadable" (skippedNoEventDate).
  const junk = parseArcgisResponse(
    { features: [{ attributes: { PermitIssuedDate: "later today" } }] }, ["PermitIssuedDate"])
  check("…and an unreadable date is LEFT IN PLACE, so 'absent' stays distinct from 'unparseable'",
    junk.rows[0].PermitIssuedDate === "later today"
    && readPermitEventDate(junk.rows[0], "PermitIssuedDate") === null)
}

// ── the interpolation guard, ArcGIS dialect ─────────────────────────────────
check("CamelCase ArcGIS field names pass — the Socrata whitelist would refuse every one of them",
  ["PermitIssuedDate", "PermitNumber", "PropertyAddress", "ObjectId"].every(isArcgisFieldName)
  && !isSoqlFieldName("PermitIssuedDate"))
check("NEGATIVE CONTROL — an ArcGIS `where` is real SQL, so injection shapes are REFUSED",
  ["PermitIssuedDate' OR 1=1 --", "1) OR (1=1", "a b", "", "1abc", "Permit;DROP"]
    .every((v) => !isArcgisFieldName(v)))
check("the date bound is built only from two whitelisted halves, and is null otherwise",
  buildArcgisDateWhere({ field: "PermitIssuedDate", sinceIso: "2026-08-13" })
    === "PermitIssuedDate >= DATE '2026-08-13'"
  && buildArcgisDateWhere({ field: "Bad Field", sinceIso: "2026-08-13" }) === null
  && buildArcgisDateWhere({ field: "PermitIssuedDate", sinceIso: "2026-08-13' OR '1'='1" }) === null)
check("only an https FeatureServer LAYER url is accepted — a service ROOT has no /query endpoint",
  isArcgisLayerUrl("https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0")
  && !isArcgisLayerUrl("https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer")
  && !isArcgisLayerUrl("http://services.arcgis.com/x/FeatureServer/0")
  && !isArcgisLayerUrl(""))
{
  // Both refusals happen BEFORE any request leaves, exactly like recentPermits'.
  const badField = await recentArcgisPermits({
    serviceUrl: "https://services.arcgis.com/x/arcgis/rest/services/y/FeatureServer/0",
    dateField: "PermitIssuedDate' OR 1=1 --", sinceIso: "2026-08-13",
  })
  const badDate = await recentArcgisPermits({
    serviceUrl: "https://services.arcgis.com/x/arcgis/rest/services/y/FeatureServer/0",
    dateField: "PermitIssuedDate", sinceIso: "2026-08-13'; DROP TABLE leads; --",
  })
  const badUrl = await arcgisFeatureQuery({ serviceUrl: "https://evil.example/x", where: "1=1" })
  check("a bad field, a bad bound and a bad layer url all refuse in the adapter's own envelope " +
    "and never reach the network",
    badField.ok === false && /not an ArcGIS field name/.test(badField.error ?? "")
    && badDate.ok === false && /calendar day/.test(badDate.error ?? "")
    && badUrl.ok === false && /FeatureServer layer URL/.test(badUrl.error ?? ""))
}

// ── the registry repoint ────────────────────────────────────────────────────
{
  const miami = classifyMarketCoverage({ state: "FL", city: "Miami" })
  const arc = miami.queryable.find((d) => providerOf(d) === "arcgis")
  check("MIAMI — marked `unavailable` for wanting an adapter that now exists — is COVERED",
    miami.status === "covered" && !!arc,
    `status=${miami.status} queryable=${miami.queryable.length}`)
  check("…by Miami-Dade's FeatureServer, bound on a row-verified event date",
    arc?.dateColumn === "PermitIssuedDate" && arc?.verifiedOn === "2026-08-20"
    && isArcgisLayerUrl(arc?.serviceUrl))
  check("…and the retired City-of-Miami Socrata id is KEPT and marked, not deleted",
    miami.reasons.some((r) => /ucp7-fqyk|ArcGIS Hub site/.test(r)))

  // NEGATIVE CONTROL — the descriptor gap a second provider introduces. An arcgis spec with no
  // serviceUrl has a dateColumn and no `unavailable`, so the OLD predicate would have called it
  // queryable and then refused it on every run forever.
  check("NEGATIVE CONTROL — an ArcGIS dataset with NO serviceUrl is NOT queryable",
    isQueryableDataset({ host: "h", datasetId: "d", kind: "permits", label: "l",
                         provider: "arcgis", dateColumn: "PermitIssuedDate" }) === false
    && isQueryableDataset({ host: "h", datasetId: "d", kind: "permits", label: "l",
                            provider: "arcgis", dateColumn: "PermitIssuedDate",
                            serviceUrl: "https://x.example/arcgis/rest/services/y/FeatureServer/0" }) === true)
  check("…and a Socrata entry is unaffected — absent `provider` still means socrata",
    providerOf({ host: "h", datasetId: "d", kind: "permits", label: "l" }) === "socrata"
    && isQueryableDataset({ host: "h", datasetId: "d", kind: "permits", label: "l",
                            dateColumn: "issue_date" }) === true)

  // Provenance. `detected_via` names where a fact came from; stamping an ArcGIS row "socrata"
  // would send anyone tracing a bad signal to a portal that never served it.
  check("an ArcGIS row is stamped detected_via `arcgis`, a Socrata row `socrata`",
    detectedViaForDataset(arc as any) === ARCGIS_DETECTED_VIA
    && detectedViaForDataset({ host: "h", datasetId: "d", kind: "permits", label: "l" } as any)
       === PERMIT_DETECTED_VIA
    && ARCGIS_DETECTED_VIA !== (PERMIT_DETECTED_VIA as string))
  {
    // End to end on the recorded row: an ArcGIS permit becomes a legal motivated_seller_signals
    // row, with a strength inside the ONE vocabulary m500's CHECK constraint enforces.
    const parsed = parseArcgisResponse(ARCGIS_LIVE_PAGE, ["PermitIssuedDate"])
    const outcome = matchPermitsToLeads(
      parsed.rows,
      [{ id: "lead-mia", address: "2960 SW 109 Court" }],
      undefined,
      { dateColumn: "PermitIssuedDate", kind: "permits" },
    )
    check("a recorded ArcGIS permit matches a lead on the SHARED normalizer (suffix expanded)",
      outcome.matches.length === 1 && outcome.matches[0].leadId === "lead-mia",
      `matches=${outcome.matches.length} skippedNoLeadMatch=${outcome.skippedNoLeadMatch}`)
    const built = buildPermitSignalRow({
      match: outcome.matches[0], brokerageId: "brok-mia", dataset: arc as any,
    })
    check("…and builds a signal row whose strength is inside the ONE governed vocabulary (m500)",
      SELLER_SIGNAL_STRENGTHS.includes(built.signal_strength as never)
      && built.signal_type === PERMIT_SIGNAL_TYPE
      && built.detected_via === ARCGIS_DETECTED_VIA)
    check("…whose dedupe_key is keyed on the STABLE AGOL item id, so a re-host cannot re-file it",
      String(built.signal_details.dedupe_key).startsWith("6db5f56e886446df88313ca279e59120|p:2026065888"))
    check("…and which carries NO owner or contractor field, though the layer publishes both",
      !JSON.stringify(built.signal_details).match(/OwnerName|ContractorName|ContractorPhone/i))
  }
}

// ── the per-dataset verdict reaches the operator ────────────────────────────
{
  // Comments stripped before scanning: this section's own prose names every symbol it greps for,
  // so an un-stripped scan would pass on the documentation rather than on the code.
  const ingestSrc = stripComments(src("lib/external/permit-signals.ts"))
  const routeSrc = stripComments(src("app/api/cron/permit-signal-scan/route.ts"))
  check("the ingest records a probe per QUERIED dataset, not just a sum of rows",
    /datasetHealth\.push\(/.test(ingestSrc) && /rows:\s*res\.ok\s*\?/.test(ingestSrc))
  check("…the probe's `ok` is the ADAPTER's verdict, so a 200-with-an-error-body counts as failed",
    /ok:\s*res\.ok/.test(ingestSrc))
  check("…and the cron surfaces it, naming the datasets that served NOTHING",
    /dataset_health/.test(routeSrc) && /datasets_silent/.test(routeSrc)
    && /h\.ok\s*&&\s*h\.rows\s*===\s*0/.test(routeSrc))
  check("a truncated page is reported rather than passed off as a complete window",
    /truncated/.test(ingestSrc) && /page cap reached/.test(ingestSrc))
  check("the ingest branches on provider in exactly one place — one lane, two adapters",
    (ingestSrc.match(/recentArcgisPermits\(/g) ?? []).length === 1
    && (ingestSrc.match(/recentPermits</g) ?? []).length === 1)
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · validateVendorPlan → the vendor plan catalogue
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[3 · vendor plan catalogue — every live CHECK, both drift directions]")

const good = { name: "Starter", price_per_month: 49, billing_cycle: "monthly" }
check("a valid plan passes clean", validateVendorPlan(good).length === 0, validateVendorPlan(good).join("; "))
check("a nameless plan is refused (name NOT NULL)", validateVendorPlan({ ...good, name: "  " }).length === 1)
check("a missing price is refused (price_per_month NOT NULL)",
  validateVendorPlan({ name: "X", billing_cycle: "monthly" }).some((e) => /required/i.test(e)))
check("DRIFT FIX (too strict): price_per_month = 0 is ACCEPTED — the live CHECK is >= 0",
  validateVendorPlan({ ...good, price_per_month: 0 }).length === 0)
check("a negative price is refused", validateVendorPlan({ ...good, price_per_month: -1 }).length === 1)
check("a non-numeric price is refused", validateVendorPlan({ ...good, price_per_month: "free" }).length === 1)
check("DRIFT FIX (too permissive): max_credits_per_month = 0 is REFUSED — the live CHECK is NULL OR > 0",
  validateVendorPlan({ ...good, max_credits_per_month: 0 }).length === 1)
check("max_credits_per_month null/absent is fine (unlimited)",
  validateVendorPlan({ ...good, max_credits_per_month: null }).length === 0 && validateVendorPlan(good).length === 0)
check("max_credits_per_month must be a whole number", validateVendorPlan({ ...good, max_credits_per_month: 2.5 }).length === 1)
check("price_per_credit >= 0 when set", validateVendorPlan({ ...good, price_per_credit: -0.01 }).length === 1 && validateVendorPlan({ ...good, price_per_credit: 0 }).length === 0)
check("trial_days >= 0 when set (0 is legal — no trial)",
  validateVendorPlan({ ...good, trial_days: -1 }).length === 1 && validateVendorPlan({ ...good, trial_days: 0 }).length === 0)
check("billing_cycle is EXACTLY the live list",
  VENDOR_PLAN_BILLING_CYCLES.join(",") === "monthly,annual"
  && validateVendorPlan({ ...good, billing_cycle: "weekly" }).length === 1
  && validateVendorPlan({ ...good, billing_cycle: "annual" }).length === 0)
check("status is EXACTLY the live list",
  VENDOR_PLAN_STATUSES.join(",") === "active,archived"
  && validateVendorPlan({ ...good, status: "draft" }).length === 1
  && validateVendorPlan({ ...good, status: "archived" }).length === 0)

const planAction = src("app/actions/vendors/vendor-plans.ts")
check("the writer exists and runs the validator", planAction.includes("validateVendorPlan"))
check("every export is an async Server Action",
  planAction.split("\n").filter((l) => /^export\s+(const|function|class|let|var|enum)\s/.test(l)).length === 0)
// ── DIRECTION CORRECTED (m497) ─────────────────────────────────────────────
// Three assertions here USED TO PIN THE WRONG DIRECTION and are rewritten, not
// deleted. This lane built the catalogue as A VENDOR'S OWN PRICE LIST that
// brokerages subscribed to monthly. Owner ruling, verbatim: "vendor packages are
// for brokerages to charge the vendor on a subscription to the platform. vendors
// do bill the brokerages for jobs but not a monthly subscription." So money runs
// VENDOR → BROKERAGE for a package and BROKERAGE → VENDOR only PER JOB. A green
// test asserting the old ownership predicate would certify the inversion, which
// is worse than a red one. The RULE each assertion expressed survives; only its
// subject moved. Full direction coverage lives in
// scripts/vendor-package-direction-simulator.ts.
check("ownership is on the WRITE itself, not a prior read — now keyed on the SELLING BROKERAGE",
  (planAction.match(/\.eq\("brokerage_id", actor\.brokerageId\)/g) ?? []).length >= 4)
check("delete refuses an ENROLLED package BY NAME before the FK can raise 23503",
  planAction.includes("vendor_subscriptions") && /cannot\s+`?\s*\+?\s*`?be deleted|cannot \$\{|cannot be deleted/i.test(planAction))
check("archiving is offered as the retirement path", planAction.includes("setVendorPlanStatusAction") && planAction.includes("archived"))
check("the surface exists", existsSync(join(root, "app/vendor/plans/page.tsx")) && existsSync(join(root, "app/vendor/plans/plans-client.tsx")))
check("the surface is NAV-LINKED (never a page nothing points at)",
  src("app/config/navigation-config.ts").includes("'/vendor/plans'"))
// The AUTHORING client moved with the direction: the seller (brokerage) writes
// the package, so the shared validator now runs on the brokerage panel.
// /vendor/plans is the PAYER's read-only view and correctly has no validator.
check("the authoring client runs the same validator the server does",
  src("app/dashboard/vendors/vendor-plan-catalogue-panel.tsx").includes("validateVendorPlan"))

// The catalogue's OTHER half. vendor_plans' enrolled-vendor count and its delete gate both read
// vendor_subscriptions, and a read whose table has no writer is not a measurement — "0
// enrolled" would be a structural certainty and the delete gate could never fire.
const subAction = src("app/actions/vendors/vendor-plan-subscriptions.ts")
check("vendor_subscriptions has a real writer (the read is a measurement, not a certainty)",
  /\.from\("vendor_subscriptions"\)[\s\S]{0,400}\.insert/.test(subAction))
check("the brokerage comes from the write seam, never from the caller",
  subAction.includes("resolveWriteContext") && !/params[^\n]*brokerageId/.test(subAction))
check("every vendor_subscriptions read AND write is tenant-pinned",
  (subAction.match(/\.eq\("brokerage_id", ctx\.brokerageId\)/g) ?? []).length >= 4)
check("only an ACTIVE plan may be subscribed to (the line the browse policy draws)",
  subAction.includes('plan.status !== "active"'))
check("a repeat ENROLMENT is a sentence, not a 23505 from the UNIQUE index",
  subAction.includes("already enrolled in this package"))
check("cancel KEEPS the row (credits used are the invoice basis) — it never deletes",
  subAction.includes('status: "canceled"') && !/\.from\("vendor_subscriptions"\)[\s\S]{0,200}\.delete\(/.test(subAction))
check("the brokerage-side surface exists and is mounted on the nav-linked vendors page",
  existsSync(join(root, "app/dashboard/vendors/vendor-plan-catalogue-panel.tsx"))
  && src("app/dashboard/vendors/page.tsx").includes("VendorPlanCataloguePanel"))
check("no fabricated charge — the subscription is an entitlement record and says so",
  subAction.includes("stripe_") === false || /not a Stripe subscription/i.test(subAction))

// ═══════════════════════════════════════════════════════════════════════════
// ownership
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[ownership]")
const domain = MAINTENANCE_DOMAINS["external_signal_lanes"]
check("this proof has an accountable manager", !!domain && domain.manager in MANAGERS)
check("…and the domain names THIS script", domain?.proof === "test:external-signal-lanes")

// ═══════════════════════════════════════════════════════════════════════════
// live (best-effort, shape-asserted)
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[live · recentPermits against a registered dataset — shape, not uptime]")
{
  const spec = getMarketDatasets({ state: "IL", city: "Chicago" }).find((d) => d.kind === "permits" && d.dateColumn)
  if (!spec) {
    check("a registered Chicago permit dataset with a dateColumn exists", false)
  } else {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const res = await recentPermits<Record<string, unknown>>({
      host: spec.host, datasetId: spec.datasetId, sinceIso: since,
      permitDateColumn: spec.dateColumn as string, limit: 5,
    })
    check("recentPermits returns the adapter's structured shape and never throws",
      typeof res.ok === "boolean" && Array.isArray(res.data))
    check("ok=true implies rows, ok=false implies a stated error",
      res.ok ? Array.isArray(res.data) : typeof res.error === "string")
    if (res.ok && res.data.length > 0) {
      const withAddr = res.data.filter((r) => !!normalizeStreetAddress(readPermitAddress(r)))
      console.log(`      · live: ${res.data.length} permits, ${withAddr.length} with a usable address key`)
      // WHEN THIS FAILS IT MUST SAY WHY. The first time it did, it reported only that zero rows
      // yielded a key — true, and useless: the cause was that the portal splits the address
      // across columns no reader knew. Printing the row's actual field names turns the next
      // failure into the fix, instead of another round trip to a portal CI can reach and a
      // developer often cannot.
      if (withAddr.length === 0) {
        console.log(`      · UNREADABLE — this portal's row exposes: ${Object.keys(res.data[0]).sort().join(", ")}`)
      }
      check("at least one live permit row yields a usable address key (the readers cover this portal)",
        withAddr.length > 0)
    } else {
      console.log(`      · live call unavailable (${res.error ?? "no rows"}) — shape assertions still ran`)
    }
  }
}

function SELL_SPAM() {
  return "selling my house selling our house thinking of selling for sale by owner fsbo need to sell downsizing " +
    "looking to buy house hunting relocating moving away recommend a realtor any recommendations"
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ EXTERNAL_SIGNAL_LANES_FAIL")
  process.exit(1)
}
console.log(" ✅ All three lanes are connected end to end — consumer, cadence, surface.")
console.log(" EXTERNAL_SIGNAL_LANES_PASS")
