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
// Re-anchored (wave 93, lane 93B2 — owner cost decision: "Versium first … People Data Labs only when
// Versium misses"): the demographics-after-match leg still follows a BatchData match (which is itself
// reached only after a Versium miss); a VERSIUM hit ends the chain without PeopleData.
const askRule = /const askPeopleData = route\.providers\.includes\('peopledata'\)\s*&& \(!batchDataFallback \|\| \(DEMOGRAPHICS_AFTER_CONTACT_MATCH && batchDataFallback\.via !== 'versium'\)\)/
check("PeopleData asked when the route names it — on a contact-point miss OR for demographics after a BatchData (non-Versium) match", askRule.test(orchSrc) && /askPeopleData\s*\?\s*await skipTraceWithPeopleData\(/.test(orchSrc))
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
// Lane 89B — the RULE, not the old literal: every PDL call that HAPPENED is booked. The one extra
// term the meter may carry is the SAME `skipPeopleData` flag that guards the call itself (a paid
// BatchData row skips both the call and its meter — a call that never happened books nothing).
check("every raw-path PeopleData call is booked (name/phone/email was unmetered anywhere)",
  // Wave 93 (93B2): the meter carries the SAME guard as the call — skipPeopleData and (new) versiumAnswered.
  /if \((?:!skipPeopleData && )?(?:!versiumAnswered && )?fields\.brokerageId && \(profileUrl \|\| hasNamePhoneEmail\)\)/.test(pp) && /usageType: profileUrl \? 'social_identity_resolve' : 'skip_trace'/.test(pp)
  && (!/!skipPeopleData && (?:!versiumAnswered && )?fields\.brokerageId/.test(pp) || /skipPeopleData(?: \|\| versiumAnswered)?\s*\?\s*\{ data: null \}\s*:\s*await skipTraceWithPeopleData\(/.test(pp)))
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

// ── D7 ──────────────────────────────────────────────────────────────────────
// Wave 93 (lane 93B3). Since 93B2 a Versium contact hit ends the chain without People Data Labs; the
// SAME Versium step now buys the demographic categories PDL used to supply and writes them onto the
// SAME profile vocabulary — so a Versium hit no longer loses the demographic profile.
console.log("\n[D7 · Versium hit → demographics filled on PDL's vocabulary, PDL NOT called (93B3)]")
{
  const { runVersiumContactLeg } = await import("../lib/ai-isa/property-lookup-rail")
  const { VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS, versiumDemographicCategoriesNeeded, peopleDataProfileToContactColumns } = await import("../lib/lead-pipeline/enrichment-column-map")
  const { VERSIUM_MATCH_CREDIT_USD } = await import("../lib/external/versium-client")
  const asked: string[] = []
  const booked: any[] = []
  let pdlCalls = 0
  const contactHit = async (output: string) => { asked.push(`contact:${output}`); return { ok: true, status: 200, data: { versium: { match_counts: { [output]: 1 }, results: [{ "Email Address": "ana@example.com" }] } } } }
  const demoCall = async (output: "demographic" | "financial") => {
    asked.push(`demographic:${output}`)
    const row = output === "demographic"
      ? { "Age Range": "35-44", Gender: "Female", "Marital Status": "Married", "Household Size": "4", "Presence of Children": "Yes", "Education Level": "Bachelor Degree", "Home Own/Rent": "Home Owner", "Home Market Value": "$425,000" }
      : { "Household Income": "$100,000 - $149,999", "Estimated Net Worth": "$250,000 - $499,999", "Credit Rating": "700-749" }
    return { ok: true, status: 200, data: { versium: { match_counts: { [output]: 1 }, results: [row] } } }
  }
  const meter = async (row: any) => { booked.push(row) }
  const id = { firstName: "Ana", lastName: "Owner", city: "Austin", state: "TX" }
  const v = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: contactHit as any, demographicCall: demoCall, meter })
  const p = v.demographicsProfile ?? {}
  // What the drain / raw path would do next: PeopleData is asked only on a contact-point MISS.
  if (!v.answered) pdlCalls++
  check("EXECUTED: a Versium contact HIT buys BOTH demographic categories through the SAME step (email, then demographic + financial)",
    v.answered && asked.join(",") === "contact:email,demographic:demographic,demographic:financial", asked.join(","))
  check("EXECUTED: the demographics land on PDL's vocabulary — age_range, gender, marital_status, household_size, children_count, education, home_owner_status, home_value, household_income, net_worth, credit_score_range",
    p.provider === "versium" && p.age_range === "35-44" && p.gender === "Female" && p.marital_status === "married" && p.household_size === 4
      && p.children_count === 1 && p.home_owner_status === "owner" && p.home_value === 425000 && p.household_income === "$100,000 - $149,999"
      && p.net_worth === "$250,000 - $499,999" && p.credit_score_range === "700-749" && p.household_financials?.sources?.credit_score_range === "versium"
      && p.household_financials?.credit_basis === "modeled_marketing_estimate", JSON.stringify(p))
  check("EXECUTED: every key it writes is a DEMOGRAPHIC_PROFILE_FIELDS key (no second vocabulary, §6) and the subset readers see it",
    Object.keys(p).filter((k) => !["provider", "captured_at", "household_financials", "field_provenance" /* provenance metadata (wave 96), not a demographic field */].includes(k)).every((k) => (DEMOGRAPHIC_PROFILE_FIELDS as readonly string[]).includes(k))
      && Object.keys(demographicsFromProfile(p)).length >= 10)
  const cols = peopleDataProfileToContactColumns(p, {})
  check("EXECUTED: the SAME contact-column mapper PDL uses writes it (age_range, gender, home_owner_status, marital_status, household_income, net_worth_range, credit_score_range) and stamps enrichment_source 'versium'",
    cols.age_range === "35-44" && cols.home_owner_status === "owner" && cols.marital_status === "married" && cols.net_worth_range === "$250,000 - $499,999"
      && cols.credit_score_range === "700-749" && cols.enrichment_source === "versium" && cohortFromEnrichment(p as any) !== "unknown", JSON.stringify(cols))
  check("EXECUTED: each category credit is its OWN ledger row (contact_append, demographic_append_demographic, demographic_append_financial), vendor versium",
    booked.map((b) => b.usageType).join(",") === "contact_append,demographic_append_demographic,demographic_append_financial"
      && booked.every((b) => b.vendorName === "versium" && b.cost === VERSIUM_MATCH_CREDIT_USD) && v.cost === Math.round(3 * VERSIUM_MATCH_CREDIT_USD * 100) / 100)
  check("POSITIVE CONTROL: PeopleData is NOT called after the Versium hit (0 calls), and the hit still carries a demographic profile", pdlCalls === 0 && v.demographicsProfile !== null)

  // Skip categories already filled.
  asked.length = 0; booked.length = 0
  const filled = { household_income: "$75,000", net_worth: "$100,000", credit_score_range: "650-699" }
  const v2 = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof", existingProfile: filled }, { call: contactHit as any, demographicCall: demoCall, meter })
  check("EXECUTED: a category whose fields are ALREADY filled is not re-bought (financial skipped; only the basic demographic credit is booked)",
    asked.join(",") === "contact:email,demographic:demographic" && booked.filter((b) => b.usageType.startsWith("demographic_append_")).length === 1
      && versiumDemographicCategoriesNeeded({ ...filled, ...Object.fromEntries(VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS.demographic.map((k) => [k, "x"])) }).length === 0 && v2.answered)

  // A miss buys no demographics (the chain continues to BatchData → PeopleData).
  asked.length = 0; booked.length = 0
  const miss = async (output: string) => { asked.push(`contact:${output}`); return { ok: true, status: 200, data: { versium: { match_counts: {}, results: [] } } } }
  const v3 = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: miss as any, demographicCall: demoCall, meter })
  check("EXECUTED: a Versium MISS buys no demographics ($0, no ledger row) — PeopleData's profile leg follows downstream as before",
    !v3.answered && v3.demographicsProfile === null && asked.join(",") === "contact:email" && booked.length === 0)
  // POSITIVE CONTROL: the 93B2 shape (hit, no demographic step) leaves the profile empty — the loss this fixes.
  const v4 = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof", existingProfile: Object.fromEntries([...VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS.demographic, ...VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS.financial].map((k) => [k, "known"])) }, { call: contactHit as any, demographicCall: demoCall, meter })
  check("POSITIVE CONTROL: with nothing left to buy the step returns NO profile — so the D7 fills above came from the Versium demographic step, not from the contact hit",
    v4.answered && v4.demographicsProfile === null)

  // Wiring: both paths write the Versium profile into the SAME places the PDL profile goes.
  const orchD7 = stripped("lib/lead-pipeline/enrichment-orchestrator.ts")
  check("the drain passes the person's existing profile, keeps the Versium profile, and writes it through the SAME lead/contact mappers + enrichment_profile",
    /existingProfile: \(entity\.enrichment_profile as Record<string, unknown> \| null\) \?\? null/.test(orchD7) && /versiumDemographics = v\.demographicsProfile/.test(orchD7)
      && /peopleDataProfileToLeadColumns\(demographicProfile\), enrichment_profile: demographicProfile/.test(orchD7)
      && /peopleDataProfileToContactColumns\(demographicProfile, \{ enrichedAt: new Date\(\)\.toISOString\(\) \}\), enrichment_profile: demographicProfile/.test(orchD7))
  const ppD7 = stripped("lib/lead-pipeline/pipeline-processor.ts")
  check("the raw path carries the Versium profile as peopleDataProfile (the field the lead insert + raw row read) and skips categories BatchData already sold",
    /\.\.\.\(versium\.demographicsProfile \? \{ peopleDataProfile: versium\.demographicsProfile \} : \{\}\)/.test(ppD7)
      && /knownDemographics: householdFinancialsFromBatchData\(rec\.raw_data\)/.test(ppD7) && /existingProfile: fields\.knownDemographics \?\? null/.test(ppD7))
}

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
console.log("  blind spots: the live PDL payload is not exercised (fixture follows docs.peopledatalabs.com field bundles); fields such as marital_status / household_income / home_value are NOT in PDL's person schema — since lane 85C the four household financials come from BatchData's demographic dataset + the Versium credit rung (proved in test:enrichment-one-rail Layer 8), home_value stays empty from PDL; the merge path of a post-enrichment duplicate still fills email/phone only")
console.log(`\n${"─".repeat(50)}\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ LEAD_DEMOGRAPHICS_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_DEMOGRAPHICS_PASS")
