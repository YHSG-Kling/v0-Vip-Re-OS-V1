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
import { join } from "path"
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
  const v = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: contactHit as any, demographicCall: demoCall, meter, checkBudget: async () => ({ allowed: true }) })
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
  const v2 = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof", existingProfile: filled }, { call: contactHit as any, demographicCall: demoCall, meter, checkBudget: async () => ({ allowed: true }) })
  check("EXECUTED: a category whose fields are ALREADY filled is not re-bought (financial skipped; only the basic demographic credit is booked)",
    asked.join(",") === "contact:email,demographic:demographic" && booked.filter((b) => b.usageType.startsWith("demographic_append_")).length === 1
      && versiumDemographicCategoriesNeeded({ ...filled, ...Object.fromEntries(VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS.demographic.map((k) => [k, "x"])) }).length === 0 && v2.answered)

  // A miss buys no demographics (the chain continues to BatchData → PeopleData).
  asked.length = 0; booked.length = 0
  const miss = async (output: string) => { asked.push(`contact:${output}`); return { ok: true, status: 200, data: { versium: { match_counts: {}, results: [] } } } }
  const v3 = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof" }, { call: miss as any, demographicCall: demoCall, meter, checkBudget: async () => ({ allowed: true }) })
  check("EXECUTED: a Versium MISS buys no demographics ($0, no ledger row) — PeopleData's profile leg follows downstream as before",
    !v3.answered && v3.demographicsProfile === null && asked.join(",") === "contact:email" && booked.length === 0)
  // POSITIVE CONTROL: the 93B2 shape (hit, no demographic step) leaves the profile empty — the loss this fixes.
  const v4 = await runVersiumContactLeg({ brokerageId: "b-1", stage: "lead", identity: id, hasEmail: false, hasPhone: false, systemSource: "proof", existingProfile: Object.fromEntries([...VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS.demographic, ...VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS.financial].map((k) => [k, "known"])) }, { call: contactHit as any, demographicCall: demoCall, meter, checkBudget: async () => ({ allowed: true }) })
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
  // Wave 97 (lane 97C — 96B open item): an EMAIL-ONLY Versium hit on the raw path still carries its
  // provenance (no demographic profile bought → a provenance-only profile), and the lead row names Versium.
  check("the raw path writes field_provenance on an EMAIL-ONLY hit too (provenance-only profile when no demographics were bought) and names Versium as enrichment_provider",
    /!versium\.demographicsProfile && Object\.keys\(versium\.fieldProvenance\)\.length > 0\s*\?\s*\{ peopleDataProfile: \{ provider: 'versium', field_provenance: versium\.fieldProvenance \} \}/.test(ppD7)
      // Wave 100 (100C): the provider column now reads THE provider vocabulary (a Versium profile names
      // versium; a provenance-only profile names no provider) — the rule, not the 97C ternary spelling.
      && /enrichment_provider: enrichmentProviderOf\(enriched\.peopleDataProfile\.provider\)/.test(ppD7))
  check("POSITIVE CONTROL: the email-only finder rejects the 96B shape (provenance only when demographics were bought)",
    !/!versium\.demographicsProfile && Object\.keys\(versium\.fieldProvenance\)/.test("...(versium.demographicsProfile ? { peopleDataProfile: versium.demographicsProfile } : {}),"))
}

// ── field_provenance READER (wave 97, lane 97C) ─────────────────────────────
console.log("\n[provenance reader — field_provenance + household_financials.sources read back for the contact card]")
{
  const { fieldProvenanceForDisplay } = await import("../lib/lead-pipeline/enrichment-column-map")
  const profile = {
    provider: "versium",
    household_financials: { sources: { marital_status: "batchdata", household_income: "batchdata", net_worth: "versium", credit_score_range: "versium" }, captured_at: "2026-10-01T12:00:00.000Z" },
    field_provenance: { email: { source: "versium", capability: "person.enrich_contact", retrievedAt: "2026-10-01T12:00:00.000Z", matchConfidence: null }, demographics: { source: "versium", capability: "person.enrich_demographics", retrievedAt: "2026-10-02T08:00:00.000Z", matchConfidence: "individual" } },
  }
  const staff = fieldProvenanceForDisplay(profile, { includeFinancials: true })
  const nonStaff = fieldProvenanceForDisplay(profile, { includeFinancials: false })
  check("EXECUTED: staff read source + retrieved date per field — email, demographics, and the four household fields under their CONTACT column names",
    staff.email?.source === "versium" && staff.email?.retrievedAt === "2026-10-01T12:00:00.000Z" && staff.demographics?.matchConfidence === "individual"
      && staff.net_worth_range?.source === "versium" && staff.household_income?.source === "batchdata" && staff.marital_status?.retrievedAt === "2026-10-01T12:00:00.000Z")
  check("EXECUTED: includeFinancials:false drops income / net worth / credit-band provenance (§5) and keeps the rest (positive control: the staff call above keeps them)",
    !nonStaff.household_income && !nonStaff.net_worth_range && !nonStaff.credit_score_range && nonStaff.marital_status?.source === "batchdata" && nonStaff.email?.source === "versium")
  check("EXECUTED: a malformed or empty blob reads as no provenance, never a throw",
    Object.keys(fieldProvenanceForDisplay(null, { includeFinancials: true })).length === 0
      && Object.keys(fieldProvenanceForDisplay({ field_provenance: { email: "versium", phone: { retrievedAt: "x" } } } as any, { includeFinancials: true })).length === 0)
  const act = stripped("app/actions/contact-enrichment.ts")
  const panel = stripped("app/crm/contacts/[contactId]/components/enrichment-panel.tsx")
  check("the contact card reads it: getContactInsights selects enrichment_profile, returns provenance for CRM staff only, and the panel renders source + date beside the value",
    /property_records, enrichment_profile"/.test(act) && /const provenance = contact && staff\s*\?\s*fieldProvenanceForDisplay\(/.test(act)
      && /setProvenance\(res\.provenance \?\? \{\}\)/.test(panel) && /fieldProvenance\(key\)/.test(panel) && /via \$\{p\.source\} · \$\{when\}/.test(panel))
}

// ── UNIVERSAL FIELD PROVENANCE (wave 100, lane 100C — OWNER LAW 2) ──────────
// ONE shape (the Versium adapter's: source / capability / retrievedAt / matchConfidence, + purpose / actor)
// written by ONE pure writer (stampFieldProvenance) at every chokepoint that sets an identity / contact /
// property field on a contact or lead, and read back by the ONE reader for staff.
console.log("\n[universal field provenance — one writer, every chokepoint, read for staff]")
{
  const M = await import("../lib/lead-pipeline/enrichment-column-map")
  const s = M.stampFieldProvenance(["email", "", "phone"], { source: "batchdata_skip_trace", capability: "person.skip_trace", purpose: "skip_trace", retrievedAt: "2026-10-03T00:00:00.000Z", matchConfidence: 0.82 })
  check("EXECUTED: the writer stamps every named field in THE shape (source, capability, retrievedAt, matchConfidence as text, purpose, actor) and drops a blank name",
    Object.keys(s).join(",") === "email,phone" && s.email.source === "batchdata_skip_trace" && s.email.capability === "person.skip_trace"
      && s.email.retrievedAt === "2026-10-03T00:00:00.000Z" && s.email.matchConfidence === "0.82" && s.email.purpose === "skip_trace" && s.email.actor === null)
  const merged = M.withFieldProvenance({ a: 1 }, { email: { source: "staff" }, phone: { source: "old" } } as any, { phone: { source: "new" } } as any)
  check("EXECUTED: withFieldProvenance merges layers in order — a prior stamp the new layer does not carry SURVIVES, a later layer wins per field",
    merged.a === 1 && merged.field_provenance.email.source === "staff" && merged.field_provenance.phone.source === "new")
  check("POSITIVE CONTROL: with no layer content no field_provenance key is invented",
    !("field_provenance" in M.withFieldProvenance({ a: 1 }, null, {})))
  // PDL — stamps exactly the mapped CONTACT columns it fills (the reader's keys), never a contact point.
  const pdl = M.buildPeopleDataProfile({ ageRange: "35-44", gender: "female", currentTitle: "Nurse", linkedinUrl: "https://linkedin.com/in/x", emails: ["a@b.co"], enrichmentConfidence: 0.9 }, "2026-10-03T00:00:00.000Z")
  const pdlKeys = Object.keys(pdl.field_provenance ?? {}).sort().join(",")
  check(`EXECUTED: buildPeopleDataProfile stamps the contact columns it maps (${pdlKeys}) as peopledata with its likelihood, and NOT email (the writer that lands it stamps it)`,
    pdlKeys === "age_range,gender,linkedin_url,occupation" && pdl.field_provenance.gender.source === "peopledata" && pdl.field_provenance.gender.matchConfidence === "0.9" && !pdl.field_provenance.email)
  check("POSITIVE CONTROL: an empty PDL match carries no provenance block",
    !("field_provenance" in M.buildPeopleDataProfile({}, "2026-10-03T00:00:00.000Z")))
  // BatchData property datasets — both tables, keyed by the contact column (lead estimated_value → home_value_estimate).
  const bd = { ok: true, equityPercent: 40, estimatedValue: 500000, mortgageBalance: null, foreclosureStatus: null, lastDeedType: null, ownerOccupied: null }
  const leadPatch = M.batchDataPropertyEnrichmentToLeadColumns(bd, { field_provenance: { email: { source: "staff", capability: "contact.manual_edit", retrievedAt: "x", matchConfidence: null } } })
  const contactPatch = M.batchDataPropertyEnrichmentToContactColumns(bd, null, { field_provenance: { email: { source: "staff", capability: "contact.manual_edit", retrievedAt: "x", matchConfidence: null } } })
  check("EXECUTED: BatchData property values are stamped on BOTH tables (equity_estimate + home_value_estimate) and the prior staff stamp survives",
    (leadPatch.enrichment_profile as any).field_provenance.home_value_estimate.source === "batchdata" && (leadPatch.enrichment_profile as any).field_provenance.email.source === "staff"
      && (contactPatch.enrichment_profile as any).field_provenance.equity_estimate.purpose === "valuation" && (contactPatch.enrichment_profile as any).field_provenance.email.source === "staff")
  check("POSITIVE CONTROL: the contact mapper called WITHOUT a profile (the pre-100C call shape) writes no enrichment_profile — the stamp exists only because the caller passed one",
    !("enrichment_profile" in M.batchDataPropertyEnrichmentToContactColumns(bd, null)))
  // Reader — new fields + financial filter across EVERY writer's keys (§5).
  const prof = { field_provenance: { ...s, home_value_estimate: M.fieldProvenanceStamp({ source: "rentcast", capability: "property.avm", purpose: "valuation" }), first_name: M.fieldProvenanceStamp({ source: "staff", capability: "contact.manual_edit", purpose: "staff_edit", actor: "u-1" }) } }
  const staffRead = M.fieldProvenanceForDisplay(prof, { includeFinancials: true })
  const otherRead = M.fieldProvenanceForDisplay(prof, { includeFinancials: false })
  check("EXECUTED: the reader returns capability / purpose / actor (staff edit names its actor)",
    staffRead.first_name?.actor === "u-1" && staffRead.first_name?.purpose === "staff_edit" && staffRead.email?.capability === "person.skip_trace")
  check("EXECUTED: includeFinancials:false drops a field_provenance FINANCIAL key whichever writer stamped it (home_value_estimate) and keeps identity keys; staff keep it (positive control)",
    !otherRead.home_value_estimate && otherRead.first_name?.source === "staff" && staffRead.home_value_estimate?.source === "rentcast")
  // Versium survivor — built through the one writer, shape unchanged.
  const vc = stripped("lib/external/versium-client.ts")
  check("the Versium adapter (the survivor shape) builds its stamps through THE ONE writer (fieldProvenanceStamp) and VersiumProvenance extends FieldProvenance",
    /interface VersiumProvenance extends FieldProvenance/.test(vc) && (vc.match(/fieldProvenanceStamp\(\{ source: "versium"/g) ?? []).length === 2)
  // Chokepoint wiring — every writer named by the owner calls the one writer / the one door.
  const wire: Array<[string, string, RegExp]> = [
    ["enrichment drain (PDL + skip-trace legs, prior stamps carried)", "lib/lead-pipeline/enrichment-orchestrator.ts", /profile\.field_provenance = withFieldProvenance\(\s*null,\s*fieldProvenanceOf\(entity\.enrichment_profile[\s\S]{0,400}contactPointProvenance\(batchDataFallback, entity\)/],
    ["enrichment drain BatchData-only leg", "lib/lead-pipeline/enrichment-orchestrator.ts", /\.\.\.contactPointProvenance\(batchDataFallback, entity\)/],
    ["enrichment drain Step 6f contact property stamps", "lib/lead-pipeline/enrichment-orchestrator.ts", /batchDataPropertyEnrichmentToContactColumns\(propEnrichment, [^\n]*, profile\)/],
    ["raw-record promotion (record source / PDL / Versium / email-seek / Perplexity)", "lib/lead-pipeline/pipeline-processor.ts", /stampFieldProvenance\(fromRecord, \{ source: acquiredFrom[\s\S]{0,900}stampFieldProvenance\(gapFilled, \{ source: 'perplexity'/],
    ["contact card Enrich now (PDL + OSINT, prior carried)", "lib/enrichment/contact-enrichment-core.ts", /withFieldProvenance\(\{ \.\.\.priorProfile, \.\.\.\(profile \?\? \{\}\) \}, fieldProvenanceOf\(priorProfile\), fieldProvenanceOf\(profile\), osintProvenance\)/],
    ["Exa / ZenRows life events", "lib/enrichment/contact-enrichment-core.ts", /stampFieldProvenance\(\["life_events"\], \{\s*source: mentions\.ran \? "exa" : "zenrows"/],
    ["staff edits (source staff + actor)", "lib/kernel/crm.ts", /stampFieldProvenance\(typed, \{ source: "staff", capability: "contact\.manual_edit", purpose: "staff_edit", actor: params\.actorUserId/],
    ["contact self-edits (source contact + actor)", "app/actions/portal-settings.ts", /stampFieldProvenance\(typed, \{ source: "contact", capability: "contact\.self_edit", purpose: "self_service", actor: access\.userId \}\)/],
    ["AVM value from the home-value form", "app/actions/home-value.ts", /persistFieldProvenance\(supabase, \{ table: "contacts"[\s\S]{0,120}stampFieldProvenance\(\["home_value_estimate"\]/],
    ["AVM chain refresh (RentCast / BatchData tier)", "lib/wealth-advisor/scan-opportunities.ts", /stampFieldProvenance\(\["home_value_estimate"\], \{\s*source: fresh\.source/],
    // Wave 102 (102D) — the 101C still-open NON-STAFF identity writers.
    ["open-house kiosk sign-in: new contact stamped inline (source kiosk)", "app/api/open-house/attend/route.ts", /enrichment_profile: withFieldProvenance\(\{\}, stampFieldProvenance\(\["first_name", "last_name", "email", \.\.\.\(phone \? \["phone"\] : \[\]\)\], KIOSK_PROVENANCE\)\)/],
    ["open-house kiosk sign-in: returning attendee through the one door", "app/api/open-house/attend/route.ts", /persistFieldProvenance\(supabase, \{ table: "contacts", id: contactId, brokerageId: event\.brokerage_id \},\s*stampFieldProvenance\(\["first_name", "last_name", \.\.\.\(phone \? \["phone"\] : \[\]\)\], KIOSK_PROVENANCE\)\)/],
    ["AI-stated address (source ai_tool, actor = ISA system user via lib/auth/isa-actor.ts)", "lib/ai-isa/customer-context-tools.ts", /getIsaSystemUserIdCached\(svc, target\.brokerageId\)[\s\S]{0,80}persistFieldProvenance\(svc, target, stampFieldProvenance\(\["address"\], \{ source: "ai_tool", capability: `ai_isa\.\$\{toolName\}`, purpose: "self_service"/],
    ["AI-stated address: both tools stamp (home-value review + record_qualification)", "lib/ai-isa/customer-context-tools.ts", /stampAiStatedAddress\(svc, \{ table: "contacts", id: ctx\.contactId, brokerageId: ctx\.brokerageId \}, "schedule_home_value_review"\)[\s\S]*stampAiStatedAddress\(svc, \{ table, id, brokerageId: ctx\.brokerageId \}, "record_qualification"\)/],
    ["offer-intake placeholder buyer name (source inbound_email, confidence low)", "lib/inbound-mail/offer-intake.ts", /enrichment_profile: withFieldProvenance\(\{\}, stampFieldProvenance\(\["first_name", "last_name"\], \{\s*source: "inbound_email", capability: "offer_intake\.buyer_name", purpose: "acquisition",\s*matchConfidence: named\.first \? "medium" : "low"/],
  ]
  for (const [what, file, re] of wire) check(`WIRED: ${what} — ${file}`, re.test(stripped(file)))
  check("POSITIVE CONTROL: the wiring finder rejects the pre-100C self-edit spread (no stamp)",
    !wire[7][2].test(`const payload = { ...updates, updated_at: now }`))
  const store = stripped("lib/enrichment/field-provenance-store.ts")
  check("the one persistence door is tenant-anchored on read AND write, COUNTS the update, and merges the prior block first",
    (store.match(/\.eq\("brokerage_id", target\.brokerageId\)/g) ?? []).length === 2 && /withFieldProvenance\(prior, fieldProvenanceOf\(prior\), stamps\)/.test(store)
      && /written\.length === 0/.test(store))
  const pset = code("app/actions/portal-settings.ts")
  check("the self-edit write takes only declared fields (no body spread into the contacts update)",
    !/\{\s*\.\.\.updates,\s*updated_at/.test(pset) && /for \(const k of SELF_EDITABLE_PROFILE_FIELDS\)/.test(pset))
  // ── WAVE 101C — the universal-provenance REMAINDER: staff edits outside updateContactRecord.
  const merge = stripped("lib/services/contact-management.service.ts")
  const mergeWire = /if \(!primary\.phone && duplicate\.phone\)[\s\S]{0,700}persistFieldProvenance\(supabase, \{ table: "contacts", id: params\.primaryContactId, brokerageId: primary\.brokerage_id \}[\s\S]{0,200}stampFieldProvenance\(\["phone"\], \{ source: "staff", capability: "contact\.merge", purpose: "staff_edit"/
  check("WIRED: a staff MERGE that takes the duplicate's phone stamps it through THE ONE writer + THE door (source staff, the session user) — lib/services/contact-management.service.ts mergeContacts",
    mergeWire.test(merge) && merge.indexOf("persistFieldProvenance(") > merge.indexOf("if (mergeError)"))
  check("POSITIVE CONTROL: the merge-wire finder rejects the pre-101C merge (value written, no stamp)",
    !mergeWire.test(`const merged = { phone: primary.phone || duplicate.phone }; await supabase.from("contacts").update(merged)`))
  // THE CENSUS — every contacts .update/.upsert whose LITERAL payload names an identity / contact-point
  // field is NAMED with its provenance status. A new unnamed writer fails. Variable payloads are a
  // published blind spot (their keys are not visible to a source scan).
  const IDENTITY_KEY = /\b(first_name|last_name|email|phone|mailing_address|address|city|state|zip_code|legal_first_name|legal_last_name)\s*:/
  const CONTACT_IDENTITY_WRITERS: Record<string, string> = {
    "lib/lead-pipeline/enrichment-orchestrator.ts": "STAMPED — the enrichment drain (withFieldProvenance, lane 100C)",
    "lib/documents/contact-legal-writeback.ts": "OWN PROVENANCE COLUMN — legal_name_source='document_scan' (+ verified_at), read by twin-provenance",
    "app/api/open-house/attend/route.ts": "NOT STAFF — the attendee typed it at the kiosk (contact self-capture); open: stamp as source 'contact'",
    "lib/ai-isa/customer-context-tools.ts": "NOT STAFF — the AI's customer-context tool sets address from the conversation; open: stamp as the AI's capability",
    "lib/inbound-mail/offer-intake.ts": "NOT STAFF — the inbound-offer email names a placeholder buyer contact (system); open",
  }
  const { readdirSync, statSync } = await import("node:fs")
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(process.cwd(), dir))) {
      const rel = `${dir}/${e}`
      if (e === "node_modules" || e.startsWith(".")) continue
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out)
      else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
    }
    return out
  }
  const literalIdentityWriters = (src: string): number => {
    let n = 0
    for (const m of src.matchAll(/\.from\(\s*["']contacts["']\s*\)\s*\.(?:update|upsert)\(\s*\{/g)) {
      let d = 0, e = m.index! + m[0].length - 1
      for (; e < src.length; e++) { if (src[e] === "{") d++; else if (src[e] === "}") { d--; if (!d) break } }
      if (IDENTITY_KEY.test(src.slice(m.index!, e))) n++
    }
    return n
  }
  const writers = [...walk("app"), ...walk("lib")].filter((rel) => literalIdentityWriters(stripped(rel)) > 0)
  const unnamed = writers.filter((rel) => !(rel in CONTACT_IDENTITY_WRITERS))
  console.log(`  · census: ${writers.length} module(s) write a contacts identity / contact-point field through a LITERAL payload; updateContactRecord (staff) and portal-settings (self) stamp through variable payloads and are wired above. Blind spot: variable payloads (.update(updates)) are not classified by key`)
  check("CENSUS: every literal-payload contacts identity writer is NAMED with its provenance status (stamped / own column / not-staff-open)", unnamed.length === 0, unnamed.join(", "))
  check("CENSUS POSITIVE CONTROL: the finder sees a staff identity write and ignores a non-identity one",
    literalIdentityWriters(`await s.from("contacts").update({ email: e, updated_at: now })`) === 1 && literalIdentityWriters(`await s.from("contacts").update({ tags: t })`) === 0)
  const panel100 = stripped("app/crm/contacts/[contactId]/components/enrichment-panel.tsx")
  check("the card lists every OTHER stamped field under Field sources (not only the inline FIELD_LABELS)",
    /const otherSources = Object\.entries\(provenance\)\.filter/.test(panel100) && /otherSources\.map\(/.test(panel100))
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
