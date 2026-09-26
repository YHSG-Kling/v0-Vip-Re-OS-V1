/**
 * scripts/lead-demographics-guard.ts — `npm run test:lead-demographics`
 *
 * LANE 83A (wave 83, 2026-09-26). Owner verbatim: "we need the richer demographics for raw leads and
 * leads, etc" — reverse lane 81B's profile-skip (a BatchData-matched row bought no PeopleData
 * profile), and make the demographics land where persona / lead intelligence read them.
 *
 * No network. Layers:
 *   D1  PDL MAPPING reads the fields PDL's person schema actually has (birth_year/birth_date → age +
 *       cohort band, sex, inferred_salary, location_locality/region/metro/names, job_title_role/levels,
 *       interests) and the ENVELOPE likelihood; never fabricates a missing field.
 *   D2  THE ONE profile builder + the raw-row demographic subset (no contact points in it).
 *   D3  DRAIN: the profile is bought after a BatchData match (DEMOGRAPHICS_AFTER_CONTACT_MATCH), still
 *       only when the route names PeopleData; BatchData's lines lead the contact points; both legs'
 *       costs land on the queue row; PeopleData books on the platform ledger.
 *   D4  RAW PATH: every PeopleData call is booked; the lead insert carries the profile; the raw row
 *       carries the demographics.
 *   D5  READERS: the fields land where lead-action-plan / ghost-reengagement / personalize-outreach /
 *       the persona builder read them (cohortFromEnrichment on a built profile).
 *   D6  LEDGER CLOSURES: lead-intelligence acquisition spend → per-source ledger; the Perplexity
 *       gap-fill's grounding search is booked.
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2).
 */
import { readFileSync } from "fs"
import { stripComments, blankStrings } from "./strip-comments"
import { mapPeopleDataPerson, pdlAgeFromBirth, ageRangeForAge, PEOPLEDATA_MATCH_COST_USD, PEOPLEDATA_NO_MATCH_COST_USD } from "../lib/external/peopledata-client"
import { buildPeopleDataProfile, demographicsFromProfile, DEMOGRAPHIC_PROFILE_FIELDS, peopleDataProfileToLeadColumns } from "../lib/lead-pipeline/enrichment-column-map"
import { cohortFromEnrichment } from "../lib/ai-isa/adaptive-reengagement"
import { planSourceSpendBooking } from "../lib/lead-pipeline/source-cost-ledger"
import { BATCHDATA_SKIP_TRACE_COST_USD } from "../lib/external/batchdata-client"

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))
const code = (p: string) => blankStrings(stripped(p))
const NOW = new Date("2026-09-26T00:00:00Z")

console.log("\n[D0 · scanner — a tombstone is not a call site]")
check("POSITIVE CONTROL: stripComments drops a comment naming the old guard and keeps live code",
  !/!batchDataFallback && route/.test(stripComments(`// !batchDataFallback && route.providers was here\nconst a = 1`)) && /const a = 1/.test(stripComments(`// x\nconst a = 1`)))

// ── D1 ──────────────────────────────────────────────────────────────────────
console.log("\n[D1 · PDL mapping reads PDL's real schema]")
const pdlPerson = {
  id: "p1", full_name: "jane roe", first_name: "jane", last_name: "roe", sex: "female", birth_year: 1988,
  inferred_salary: "70,000-85,000", job_title: "nurse practitioner", job_title_role: "health", job_title_levels: ["senior"],
  job_start_date: "2024-03", industry: "hospital & health care", inferred_years_experience: 9, interests: ["hiking", "gardening"],
  location_locality: "austin", location_region: "texas", location_postal_code: "78701", location_metro: "austin, texas",
  location_names: ["austin, texas, united states", "denver, colorado, united states"], location_street_address: "1 main st",
  emails: [{ address: "jane@example.com" }], phone_numbers: ["+15125550100"],
}
const m = mapPeopleDataPerson(pdlPerson, { name: "Jane Roe", likelihood: 8 }, NOW)
check("birth_year → age (38 in 2026) + cohort band 35-44", m.age === 38 && m.ageRange === "35-44" && m.birthYear === 1988, `${m.age} ${m.ageRange}`)
check("sex → gender; location_locality/region → city/state; metro + location history kept", m.gender === "female" && m.city === "austin" && m.state === "texas" && m.metro === "austin, texas" && (m.locationHistory ?? []).length === 2)
check("inferred_salary kept as a PERSON salary band — never written as household income", m.inferredSalary === "70,000-85,000" && m.householdIncome === undefined)
check("job role/levels/start, interests, inferred_years_experience mapped", m.jobTitleRole === "health" && (m.jobTitleLevels ?? [])[0] === "senior" && m.jobStartDate === "2024-03" && (m.interests ?? []).length === 2 && m.yearsOfExperience === 9)
check("likelihood read from the ENVELOPE (confidence 0.8), not from inside the person", m.enrichmentConfidence === 0.8 && m.emailVerified === true)
check("POSITIVE CONTROL: the old in-person likelihood read yields NaN/0 — the envelope read is what makes confidence real",
  Number.isNaN((pdlPerson as any).likelihood / 10) && mapPeopleDataPerson(pdlPerson, {}, NOW).enrichmentConfidence === 0)
const bare = mapPeopleDataPerson({ id: "p2", full_name: "sam lee" }, { likelihood: 7 }, NOW)
check("POSITIVE CONTROL: a person with no birth/sex/salary gets NO fabricated demographics", bare.age === undefined && bare.ageRange === undefined && bare.gender === undefined && bare.inferredSalary === undefined)
check("legacy payload fields still map (a payload that DOES carry age/gender)", mapPeopleDataPerson({ age: 50, gender: "male" }, {}, NOW).ageRange === "45-54")
check("pdlAgeFromBirth reads birth_date too, refuses nonsense", pdlAgeFromBirth(undefined, "1990-06-01", NOW) === 36 && pdlAgeFromBirth(1850, null, NOW) === null && ageRangeForAge(17) === undefined)

// ── D2 ──────────────────────────────────────────────────────────────────────
console.log("\n[D2 · THE ONE profile builder]")
const profile = buildPeopleDataProfile(m as any, "2026-09-26T00:00:00Z")
check("profile carries the richer demographics (age, age_range, gender, job, salary band, interests, metro, history)",
  ["age", "age_range", "gender", "job_title", "inferred_salary", "interests", "metro", "location_history", "birth_year"].every((k) => profile[k] !== undefined))
check("empties are dropped (no null / [] keys)", Object.values(profile).every((v) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)))
const demo = demographicsFromProfile(profile)
check("the raw-row demographic subset has NO contact points (emails/phones stay on the lead only)", !("emails" in demo) && !("phones" in demo) && Object.keys(demo).every((k) => (DEMOGRAPHIC_PROFILE_FIELDS as readonly string[]).includes(k)) && demo.age === 38)
check("POSITIVE CONTROL: demographicsFromProfile of nothing is empty", Object.keys(demographicsFromProfile(null)).length === 0)
const orchSrc = stripped("lib/lead-pipeline/enrichment-orchestrator.ts")
check("the drain builds its profile through buildPeopleDataProfile (no second inline builder)",
  /buildPeopleDataProfile\(enriched\)/.test(orchSrc) && !/provider:\s*'peopledata',\s*\n\s*peopledata_id:/.test(orchSrc))
check("POSITIVE CONTROL: the old inline builder shape IS recognised", /provider:\s*'peopledata',\s*\n\s*peopledata_id:/.test(`const profile = {\n  provider: 'peopledata',\n  peopledata_id: x,`))

// ── D3 ──────────────────────────────────────────────────────────────────────
console.log("\n[D3 · drain: the 81B profile-skip is reversed]")
check("DEMOGRAPHICS_AFTER_CONTACT_MATCH = true", /export const DEMOGRAPHICS_AFTER_CONTACT_MATCH = true\b/.test(orchSrc))
const askRule = /const askPeopleData = route\.providers\.includes\('peopledata'\) && \(!batchDataFallback \|\| DEMOGRAPHICS_AFTER_CONTACT_MATCH\)/
check("PeopleData asked when the route names it — on a BatchData miss OR for demographics after a match", askRule.test(orchSrc) && /askPeopleData\s*\?\s*await skipTraceWithPeopleData\(/.test(orchSrc))
check("POSITIVE CONTROL: the 81B skip shape is NOT the rule", !askRule.test(`const { data: enriched, cost } = !batchDataFallback && route.providers.includes('peopledata') ? await skipTraceWithPeopleData({`))
check("PDL asked with BatchData's phone/email when the row had none (match rate)", /phone: \(entity\.phone \?\? batchDataFallback\?\.phones\[0\]\)/.test(orchSrc) && /email: \(entity\.email \?\? batchDataFallback\?\.emails\[0\]\)/.test(orchSrc))
check("BatchData's DNC-flagged lines LEAD the merged contact points; a reverse-leg email is never replaced",
  /enriched\.phones = Array\.from\(new Set\(\[\.\.\.batchDataFallback\.phones, \.\.\.\(enriched\.phones \?\? \[\]\)\]\)\)/.test(orchSrc) && /batchDataFallback\.via === 'reverse' && entity\.email/.test(orchSrc))
check("a PDL failure after a BatchData match keeps the match (falls through to the BatchData write)", /if \(batchDataFallback\) \{ console\.warn\([\s\S]{0,140}?\); return \{ data: null, cost: 0 \} \}\s*\n\s*throw e/.test(orchSrc))
check("the queue row carries BOTH legs' cost; the provider label names both", /enrichment_cost: cost \+ batchDataFallbackCost,\s*\n\s*enrichment_results: \{\s*\n\s*lane: plan\.label,\s*\n\s*person_enrichment: 'peopledata'/.test(orchSrc) && /`\$\{contactPointsProvider\}\+\$\{plan\.label\}`/.test(orchSrc))
check("PeopleData books on the PLATFORM ledger (meterVendorSpend, vendor peopledata) at the reported cost", /vendorName: 'peopledata',\s*\n\s*usageType: 'skip_trace',\s*\n\s*cost,/.test(orchSrc))
check("the persona builder gets the salary band only as a labelled fallback for household income", /enriched\.householdIncome \?\? \(enriched\.inferredSalary \? `\$\{enriched\.inferredSalary\} \(individual salary, inferred\)` : null\)/.test(orchSrc))

// ── D4 ──────────────────────────────────────────────────────────────────────
console.log("\n[D4 · raw path: raw leads and leads carry the demographics]")
const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
check("every raw-path PeopleData call is booked (name/phone/email was unmetered anywhere)",
  /if \(fields\.brokerageId && \(profileUrl \|\| hasNamePhoneEmail\)\)/.test(pp) && /usageType: profileUrl \? 'social_identity_resolve' : 'skip_trace'/.test(pp))
check("POSITIVE CONTROL: the old profile-only booking condition is recognised as narrower", !/hasNamePhoneEmail/.test(`if (profileUrl && fields.brokerageId) {`))
check("the enrichment result carries the built profile", /peopleDataProfile:\s*buildPeopleDataProfile\(data as any\)/.test(pp))
const ins = pp.slice(pp.indexOf(".from('leads')\n    .insert({"), pp.indexOf("raw_record_id:         rawRecordId"))
check("the lead INSERT carries enrichment_profile + the lead demographic columns from the profile",
  /enrichment_profile:\s*enriched\.peopleDataProfile/.test(ins) && /peopleDataProfileToLeadColumns\(enriched\.peopleDataProfile\)/.test(ins))
check("the RAW row carries the demographics (normalized_preview.demographics) and reads its write error",
  /demographics: demographicsFromProfile\(enriched\.peopleDataProfile\)/.test(pp) && /rawDemoError/.test(pp) && pp.indexOf("demographicsFromProfile(") < pp.indexOf("'post_enrichment', effectiveBrokerageId"))
check("lead columns from a profile: home_owner_status / life_events only when present", JSON.stringify(peopleDataProfileToLeadColumns({ home_owner_status: "owner" })) === JSON.stringify({ home_owner_status: "owner" }) && Object.keys(peopleDataProfileToLeadColumns({})).length === 0)

// ── D5 ──────────────────────────────────────────────────────────────────────
console.log("\n[D5 · readers read what is written]")
check("cohortFromEnrichment reads a built profile (age 38 → millennial)", cohortFromEnrichment(profile as any) === "millennial")
check("POSITIVE CONTROL: a profile with no age signal is 'unknown' (never guessed)", cohortFromEnrichment(buildPeopleDataProfile({ fullName: "x" } as any) as any) === "unknown")
const readers = ["lib/ai-isa/lead-action-plan.ts", "lib/ai-isa/ghost-reengagement.ts"].filter((p) => /cohortFromEnrichment\(lead\.enrichment_profile/.test(code(p)))
check(`lead readers take age/age_range from leads.enrichment_profile — the column the raw path now writes (${readers.length}/2)`, readers.length === 2)
check("personalize-outreach reads enrichment_profile household_income (the key the builder writes)", /ep\?\.household_income/.test(code("lib/ai-isa/personalize-outreach.ts")) && profile.household_income === undefined)

// ── D6 ──────────────────────────────────────────────────────────────────────
console.log("\n[D6 · ledger closures (82B lead-intelligence rows, 82A Perplexity grounding)]")
const li = code("app/actions/lead-intelligence.ts")
const liStr = stripped("app/actions/lead-intelligence.ts")
check("lead-intelligence's acquisition spend books through bookSourceSpend (per-source ledger)",
  (liStr.match(/bookSourceSpend\(\{/g) ?? []).length >= 6 && /bookSourceSpend\(/.test(li))
check("no acquisition row keeps a descriptive usage_type outside the SourceKey reconcile", !/usageType: "(external_behavior_\w+|nextdoor_chatter|google_intent)"/.test(liStr))
check("POSITIVE CONTROL: the old descriptive shape IS recognised", /usageType: "(external_behavior_\w+|nextdoor_chatter|google_intent)"/.test(`meterVendorSpend({ vendorName: "apify", usageType: "external_behavior_zillow" })`))
const pl = planSourceSpendBooking({ source: "external_behavior", cost: 0.5, brokerageId: "b", providerOverride: "batchdata" })
check("those rows resolve to a SourceKey usage_type with the provider that served them", pl.usageType === "external_behavior" && pl.vendorName === "batchdata" && !pl.vendorUnresolved
  && planSourceSpendBooking({ source: "nextdoor_intent", cost: 1, brokerageId: "b", providerOverride: "zenrows" }).usageType === "nextdoor_intent")
const px = stripped("lib/lead-pipeline/perplexity-enrichment.ts")
check("the Perplexity gap-fill books its grounding search under the provider that served it",
  /meterVendorSpend\(\{\s*\n\s*vendorName: grounding\.provider,/.test(px) && /grounding\.provider !== "none" && grounding\.cost > 0/.test(px) && px.indexOf("meterVendorSpend(") < px.indexOf("generateObjectRouted("))

// ── cost ────────────────────────────────────────────────────────────────────
console.log("\n[cost — derived from the constants, platform-paid]")
const perPerson = BATCHDATA_SKIP_TRACE_COST_USD + PEOPLEDATA_MATCH_COST_USD
check(`a fully-enriched address-bearing person costs BatchData $${BATCHDATA_SKIP_TRACE_COST_USD} + PeopleData $${PEOPLEDATA_MATCH_COST_USD} = $${perPerson.toFixed(2)}; a PDL miss is $${PEOPLEDATA_NO_MATCH_COST_USD}`,
  perPerson > BATCHDATA_SKIP_TRACE_COST_USD && PEOPLEDATA_NO_MATCH_COST_USD === 0)

// ── registration ────────────────────────────────────────────────────────────
console.log("\n[registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
const guard = pkg.scripts.guard ?? ""
check("package.json registers test:lead-demographics", pkg.scripts["test:lead-demographics"] === "tsx scripts/lead-demographics-guard.ts")
check("guard runs it AFTER test:scrapers (ordering only)", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:lead-demographics") > guard.indexOf("npm run test:scrapers"))
check("MAINTENANCE_DOMAINS owns it with coOwners", /lead_demographics:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:lead-demographics",\s*coOwners:/.test(read("lib/kernel/manager-registry.ts")))

console.log(`\n  denominators: ${DEMOGRAPHIC_PROFILE_FIELDS.length} demographic profile fields · 2 enrichment paths (drain + raw) · 6 lead-intelligence acquisition bookings · 1 Perplexity grounding booking`)
console.log("  blind spots: the live PDL payload is not exercised (fixture follows docs.peopledatalabs.com field bundles); fields such as marital_status / household_income / home_value are NOT in PDL's person schema and stay empty unless a payload carries them; the merge path of a post-enrichment duplicate still fills email/phone only")
console.log(`\n${"─".repeat(50)}\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ LEAD_DEMOGRAPHICS_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_DEMOGRAPHICS_PASS")
