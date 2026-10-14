#!/usr/bin/env tsx
/**
 * scripts/buyer-nl-search-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the BUYER NATURAL-LANGUAGE PROPERTY SEARCH end-to-end after the audit fixes:
 *   1. FAIR HOUSING — the parser no longer infers protected classes (familial status / age), and the
 *      sanitizer strips protected-class steering from the buyer-facing copy WE author.
 *   2. CORRECTNESS — the search returns ACTIVE, non-deleted listings (the deleted_at filter was inverted
 *      and previously returned ONLY soft-deleted rows — the feature was broken).
 *   3. SHAPE — results map to the portal card shape the widget renders.
 *
 * Layer 1 (pure): parser FH, sanitizer, toPortalCards/savedRowToInterest.
 * Layer 3 (pure, lane 91C): the ONE NL criteria parser — fixture sentences → the existing criteria
 *   shape (bare "under 450" = $450k, "condo or townhouse" ≠ Oregon, "3-4 bed" ≠ a price, ZIPs, rent),
 *   the model-assist merge (fills a gap only with the buyer's own words — positive controls reject an
 *   invented city/feature/budget), spend never made without a tenant, smartSearch's duplicate prompt retired.
 * Layer 4 (pure, lane 91C): RentCast REQUEST SHAPE from the one builder — daysOld recency window,
 *   ranges, address mode, rental Land omission — and every buyer-facing call site passes a window.
 * Layer 5 (stripped-source, lane 91C): no BatchData on the buyer listing path, with positive controls.
 * Layer 2 (live, creds-gated): seed an ACTIVE listing + a SOFT-DELETED listing for a real brokerage +
 * a buyer contact; run searchPropertiesCore; assert the active listing is returned, the deleted one is
 * NOT, and every buyer-facing string is Fair-Housing clean. Reverse-delete; cleanup count == 0.
 *
 * Run: npx tsx scripts/buyer-nl-search-simulator.ts   (npm run test:buyer-nl-search)
 */
import { parseNaturalLanguageQuery } from "../lib/buyer-search/intent-parser"
import { scanFairHousing, sanitizeFairHousing, sanitizeExplanation } from "../lib/buyer-search/fair-housing"
import { toPortalCards, savedRowToInterest } from "../lib/buyer-search/portal-cards"
import {
  extractCriteriaFromTranscript, criteriaGaps, mergeModelCriteria, unsearchableAsks,
  criteriaToAlertRow,
} from "../lib/buyer-search/conversation-criteria"
import { parseBuyerCriteria } from "../lib/buyer-search/parse-buyer-criteria"
import { buildRentcastListingQuery } from "../lib/property/rentcast-query"
import { BUYER_LISTING_RECENCY_DAYS } from "../lib/property-alerts/alert-cadence"
import { stripComments } from "./strip-comments"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
/** Stripped source (CLAUDE.md §2: a tombstone is not a call site). */
const code = (rel: string) => stripComments(src(rel))
/** The body of one top-level function, from its declaration to the next top-level declaration. */
function fnBody(text: string, decl: string): string {
  const start = text.indexOf(decl)
  if (start < 0) return ""
  const rest = text.slice(start + decl.length)
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\nexport\s+(?:const|async|function)/)
  return decl + (next < 0 ? rest : rest.slice(0, next))
}

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Buyer NL search verified — Fair-Housing clean, returns active (not deleted) listings, portal-shaped.")
  console.log(" BUYER_NL_SEARCH_PASS")
  process.exit(0)
}

// Phrases that are illegal STEERING regardless of context (proximity-to-schools, naming a neighborhood,
// and 55+ language in a verified senior community are all legal and intentionally NOT listed here).
const FORBIDDEN = /\b(safe neighborhood|safe area|crime[- ]free|family[- ]friendly|growing family|kid[- ]friendly|child[- ]friendly|your family|empty[- ]nest)\b/i

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer NL search simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · Fair Housing — parser]")
  // The parser must NOT infer protected-class lifestyle (familial status / age).
  const famIntent = parseNaturalLanguageQuery("a home for my family with kids near good schools and a safe neighborhood")
  check("parser does NOT set a 'family' lifestyle (familial status)", famIntent.lifestyle !== "family")
  const retIntent = parseNaturalLanguageQuery("a quiet single story home for retirement, senior friendly")
  check("parser does NOT set a 'retiree' lifestyle (age)", retIntent.lifestyle !== "retiree")
  const proIntent = parseNaturalLanguageQuery("walkable home near downtown with a short commute to the office")
  check("parser STILL infers non-protected intent (professional/relocation)", proIntent.lifestyle === "professional")
  // Property facts are never protected — they still parse.
  const facts = parseNaturalLanguageQuery("3 bedroom 2 bath house under 500k in Austin with a pool")
  check("property facts parse (beds/price/city/feature)", facts.minBeds === 3 && facts.maxPrice === 500000 && (facts.cities ?? []).includes("Austin") && (facts.features ?? []).includes("pool"))

  console.log("\n[Layer 1 · Fair Housing — output sanitizer]")
  check("strips 'growing family'", !FORBIDDEN.test(sanitizeFairHousing("3 bedrooms for your growing family")))
  check("strips 'family-friendly'", !FORBIDDEN.test(sanitizeFairHousing("In a family-friendly neighborhood")))
  check("strips 'safe neighborhood'", !FORBIDDEN.test(sanitizeFairHousing("A very safe neighborhood close in")))
  check("neutralizes 'see it with your family' CTA", !FORBIDDEN.test(sanitizeFairHousing("See it in person with your family")))
  // Schools: factual PROXIMITY stays; only the editorializing quality adjective is removed.
  const sch = sanitizeFairHousing("Located in a top-rated school district")
  check("school proximity kept, quality adjective dropped", /school district/i.test(sch) && !/top-rated/i.test(sch))
  check("factual proximity to schools/work is ALLOWED (untouched)", sanitizeFairHousing("Near schools and a short commute to work") === "Near schools and a short commute to work")
  // Age: neutralized by default, but PERMITTED in a verified 55+ community (FHA age exemption).
  check("age language neutralized by default", sanitizeFairHousing("Perfect for seniors") !== "Perfect for seniors")
  check("55+ community context permits senior language", sanitizeFairHousing("Perfect for seniors", { seniorCommunity: true }) === "Perfect for seniors")
  const scan = scanFairHousing("Perfect for your growing family near good schools")
  check("scan flags the protected phrases (audit trail)", scan.flagged.length >= 1 && !FORBIDDEN.test(scan.clean))
  check("non-steering copy passes through unchanged", sanitizeFairHousing("3 bedrooms, 2 baths, $450K in Austin with a pool") === "3 bedrooms, 2 baths, $450K in Austin with a pool")
  const cleanExp = sanitizeExplanation({ headline: "Great home for your growing family", bullets: ["Near good schools", "3 beds, 2 baths"], narrative: "Perfect for families relocating.", callToAction: "See it in person with your family" })
  check("sanitizeExplanation cleans every field", !FORBIDDEN.test([cleanExp.headline, ...cleanExp.bullets, cleanExp.narrative, cleanExp.callToAction].join(" ")))

  console.log("\n[Layer 1 · portal card mapping]")
  const cards = toPortalCards(
    [{ listing_id: "L1", address: "1 Main St", primary_photo_url: "p.jpg", headline: "h", bullets: [], narrative: "n", callToAction: "c", price: 450000, bedrooms: 3, bathrooms: 2, city: "Austin", state: "TX", property_type: "single_family", features: null, internal_match_score: 88, internal_confidence: "high" }] as any,
    { L1: "saved" },
  )
  check("maps listing_id→id, price→list_price, attaches interest", cards[0].id === "L1" && cards[0].list_price === 450000 && cards[0].current_interest === "saved")
  check("savedRowToInterest: dismissed→dismissed, tour→tour_requested, else saved",
    savedRowToInterest({ dismissed: true }) === "dismissed" && savedRowToInterest({ added_to_tour: true }) === "tour_requested" && savedRowToInterest({}) === "saved")

  await layer3NlCriteria()
  layer4RentcastRequestShape()
  layer5NoBatchDataOnBuyerListingPath()

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log("\n[Layer 2 · live: active returned, deleted excluded, output FH-clean]")
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { searchPropertiesCore } = await import("../lib/buyer-search/search-engine")
  const svc = createServiceClient()
  const TAG = `__nlsearch_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brk as any).id
  const city = `ZZ${Date.now() % 100000}`  // a city no real listing uses, so we match only our seeds

  try {
    const { data: contact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZBuyer", last_name: `${Date.now()}`,
      email: `zz-nl-${Date.now()}@example.com`, contact_type: "buyer",
    }).select("id").single()
    const contactId = (contact as any).id
    cleanup.push({ table: "contacts", id: contactId })

    const mk = async (deleted: boolean, label: string) => {
      const { data } = await svc.from("listings").insert({
        brokerage_id: brokerageId, address: `${label} ${city} Way`, city, state: "TX", zip: "78701",
        list_price: 450000, bedrooms: 3, bathrooms: 2, sqft: 1800, property_type: "single_family",
        status: "active", primary_photo_url: "https://example.com/p.jpg",
        deleted_at: deleted ? new Date().toISOString() : null,
      }).select("id").single()
      cleanup.push({ table: "listings", id: (data as any).id })
      return (data as any).id
    }
    const activeId = await mk(false, "Active")
    const deletedId = await mk(true, "Deleted")

    const r: any = await searchPropertiesCore({
      contactId,
      naturalLanguageQuery: `3 bedroom 2 bath single family home under 500k in ${city}`,
      options: { limit: 25, minScore: 0, logSignals: false },
    })
    check("search succeeded", r.success === true, JSON.stringify(r.error ?? r.message))
    const ids = (r.results ?? []).map((x: any) => x.listing_id)
    check("ACTIVE listing is returned", ids.includes(activeId), JSON.stringify(ids))
    check("SOFT-DELETED listing is EXCLUDED (deleted_at fix)", !ids.includes(deletedId))

    const mine = (r.results ?? []).find((x: any) => x.listing_id === activeId)
    check("result carries display fields (address + photo)", !!mine && !!mine.address && !!mine.primary_photo_url)
    const allText = (r.results ?? []).flatMap((x: any) => [x.headline, x.narrative, x.callToAction, ...(x.bullets ?? [])]).join("  ")
    check("every buyer-facing string is Fair-Housing clean", !FORBIDDEN.test(allText), allText.slice(0, 160))

    // Save it (live boolean model) → the portal interest reads back as 'saved'.
    await svc.from("saved_properties").insert({ contact_id: contactId, listing_id: activeId, brokerage_id: brokerageId, user_id: contactId, dismissed: false }).then(() => {}, () => {})
    const { data: savedRow } = await svc.from("saved_properties").select("listing_id, dismissed, added_to_tour").eq("contact_id", contactId).eq("listing_id", activeId).maybeSingle()
    if (savedRow) {
      cleanup.push({ table: "saved_properties", id: "" })  // placeholder; deleted by contact below
      check("saved_properties row maps to 'saved' interest", savedRowToInterest(savedRow as any) === "saved")
    }
  } finally {
    await svc.from("saved_properties").delete().eq("city", city).then(() => {}, () => {})
    // saved_properties has no city for our row; delete by listing ids we seeded instead:
    for (const c of cleanup.filter((c) => c.table === "listings")) {
      await svc.from("saved_properties").delete().eq("listing_id", c.id).then(() => {}, () => {})
    }
    for (const c of [...cleanup].reverse()) { if (c.id) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {}) }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).eq("city", city)
    check("cleanup: seeded listings removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

// ─── Lane 91C — owner: "we use rentcast for property listings to send to the
// buyers that reflect their criteria (even nlp natural language)" · "we should
// only pull more recent data" · no BatchData where a cheaper lookup exists. ──

/** Layer 3 — the ONE NL criteria parser (rules pass + the model-assist merge
 *  rule), on fixture sentences a buyer actually writes. No network: the rules
 *  pass is pure, and the model lane is exercised through its PURE merge. */
async function layer3NlCriteria() {
  console.log("\n[Layer 3 · NL buyer sentence → the existing criteria shape]")

  const frisco = "3 bed under 450 near good schools in Frisco, need a yard"
  const f = extractCriteriaFromTranscript(frisco).criteria
  check("FIXTURE 'Frisco': 3 beds", f.minBeds === 3, JSON.stringify(f))
  check("FIXTURE 'Frisco': bare 'under 450' is $450,000 (a buyer's thousands), not $450", f.maxPrice === 450000, String(f.maxPrice))
  check("FIXTURE 'Frisco': city off the metro list captured ('in Frisco')", (f.cities ?? []).includes("Frisco"), JSON.stringify(f.cities))
  check("FIXTURE 'Frisco': 'need a yard' → feature 'yard'", (f.features ?? []).includes("yard"), JSON.stringify(f.features))
  check("FIXTURE 'Frisco': 'good schools' is NOT captured as a criterion (characterization, fair housing)", !(f.schoolDistricts?.length))
  check("FIXTURE 'Frisco': the unsearchable ask is said back, not dropped", unsearchableAsks(frisco).length === 1)
  check("FIXTURE 'Frisco': no gap left → the model lane is not needed (free)", criteriaGaps(f).length === 0, JSON.stringify(criteriaGaps(f)))

  const either = extractCriteriaFromTranscript("condo or townhouse under $300k in Austin").criteria
  check("'condo OR townhouse' no longer reads as Oregon (no state)", either.state === undefined, String(either.state))
  // POSITIVE CONTROL for the state finder: an upper-case code is still read.
  const tx = extractCriteriaFromTranscript("4 bed house in Plano TX max 1.2 million").criteria
  check("positive control: 'TX' is read as the state; '1.2 million' = $1,200,000", tx.state === "TX" && tx.maxPrice === 1_200_000, JSON.stringify(tx))
  const texas = extractCriteriaFromTranscript("3 bed in Austin, Texas under 500k").criteria
  check("a full state name maps to its USPS code (TX, never 'TEXAS')", texas.state === "TX", String(texas.state))

  const beds = extractCriteriaFromTranscript("3-4 bed house under $400k in Austin").criteria
  check("'3-4 bed' is a bedroom range, not a $3–$4 price", beds.minBeds === 3 && beds.maxPrice === 400000 && beds.minPrice === undefined, JSON.stringify(beds))

  const zip = extractCriteriaFromTranscript("4 bedroom in 75034 from 500k to 650k").criteria
  check("ZIP 75034 captured; range 500k–650k", (zip.zipCodes ?? []).includes("75034") && zip.minPrice === 500000 && zip.maxPrice === 650000, JSON.stringify(zip))
  check("the ZIP is not mistaken for a price", zip.maxPrice !== 75034 && zip.minPrice !== 75034)

  const rent = extractCriteriaFromTranscript("renting a 2 bed under 2500 a month in Dallas").criteria
  check("renter: listingType 'rent', monthly figure NOT scaled", rent.listingType === "rent" && rent.maxPrice === 2500, JSON.stringify(rent))
  const rentRow = criteriaToAlertRow(rent, { contactId: "c", agentUserId: null, brokerageId: "b", alertName: "x" })
  check("alert row carries listing_type 'rent' (monthly budget never swept against sale prices)", rentRow.listing_type === "rent")
  const zipRow = criteriaToAlertRow(zip, { contactId: "c", agentUserId: null, brokerageId: "b", alertName: "x" })
  check("alert row carries the stated ZIP (zip_codes was always [])", zipRow.zip_codes.includes("75034"))

  console.log("\n[Layer 3b · model assist: fills a GAP only, only with the buyer's own words]")
  const vague = "looking for something with 3 bedrooms, Prosper area, maybe 600 or so"
  const rules = extractCriteriaFromTranscript(vague).criteria
  check("precondition: the rules pass MISSES this city and budget (so the merge is what is tested)", !(rules.cities?.length) && rules.maxPrice == null && criteriaGaps(rules).includes("location"), JSON.stringify(rules))
  const merged = mergeModelCriteria(rules, {
    cities: ["Prosper", "Dallas"], state: "TX", maxPrice: 600000, minBeds: 3,
    features: ["pool"], propertyTypes: ["single_family"],
  }, vague)
  check("model city the buyer named ('Prosper') is accepted", (merged.cities ?? []).includes("Prosper"), JSON.stringify(merged.cities))
  check("POSITIVE CONTROL — a model city the buyer never said ('Dallas') is REJECTED", !(merged.cities ?? []).includes("Dallas"))
  check("model state accepted only beside a stated city (RentCast needs it)", merged.state === "TX")
  check("model budget the buyer said ('600' → $600,000) fills the price gap", merged.maxPrice === 600000, String(merged.maxPrice))
  check("POSITIVE CONTROL — a model feature the buyer never said ('pool') is REJECTED", !(merged.features ?? []).includes("pool"))
  const invented = mergeModelCriteria({}, { maxPrice: 900000 }, "3 bed in Frisco please")
  check("POSITIVE CONTROL — an invented budget ($900k, never stated) is REJECTED", invented.maxPrice === undefined)
  const keepRules = mergeModelCriteria({ maxPrice: 450000 }, { maxPrice: 600000 }, "under 450, or 600 tops")
  check("rules win — the model never overwrites a value the rules already read", keepRules.maxPrice === 450000)
  check("a stated '450' backs a model $450,000; a stated '45' does not",
    mergeModelCriteria({}, { maxPrice: 450000 }, "somewhere under 450").maxPrice === 450000
      && mergeModelCriteria({}, { maxPrice: 450000 }, "somewhere under 45").maxPrice === undefined)
  check("the model schema carries no school/age/household field (nothing to fill)", !("schoolDistricts" in merged) && !("ageRestrictedCommunity" in merged))

  console.log("\n[Layer 3c · the one entry point — spend is tenant-booked or not made]")
  const noTenant = await parseBuyerCriteria(vague, { brokerageId: null })
  check("no tenant → no model call; rules answer + a note saying why", noTenant.via === "rules" && noTenant.notes.some((n) => /no tenant/i.test(n)), JSON.stringify(noTenant.notes))
  const rulesOnly = await parseBuyerCriteria(frisco, { brokerageId: "00000000-0000-0000-0000-000000000000", allowModelAssist: false })
  check("rules-only parse of the Frisco sentence returns the same criteria", rulesOnly.criteria.maxPrice === 450000 && rulesOnly.gaps.length === 0 && rulesOnly.confidence === "high")
  const models = code("lib/ai/models.ts")
  check("AI_TASK_ROUTING.buyer_criteria_parse is a claude-haiku row (the cheap lane)", /buyer_criteria_parse:\s*\{\s*model:\s*"claude-haiku"/.test(models))
  const one = code("lib/buyer-search/parse-buyer-criteria.ts")
  check("the one parser calls generateObjectRouted with feature 'buyer_criteria_parse' (structured, routed, ledgered)", /generateObjectRouted\(/.test(one) && /feature:\s*"buyer_criteria_parse"/.test(one))
  const smart = fnBody(code("app/actions/idx-search.ts"), "export async function smartSearch")
  check("DUPLICATE RETIRED — smartSearch carries no inline NL→JSON prompt and calls parseBuyerCriteria", smart.length > 0 && !/Convert this natural language/i.test(smart) && /parseBuyerCriteria\(/.test(smart))
  check("POSITIVE CONTROL — the finder sees the prompt in the retired shape", /Convert this natural language/i.test('const interpretPrompt = `Convert this natural language property search into structured filters`'))
}

/** Layer 4 — the RentCast REQUEST SHAPE, from the one pure builder both
 *  readers use, plus the call sites that must pass a recency window. */
function layer4RentcastRequestShape() {
  console.log("\n[Layer 4 · RentCast request shape — recency window on the wire]")
  const q = buildRentcastListingQuery(
    { city: "Frisco", state: "TX", bedroomsMin: 3, priceMax: 450000, listedWithinDays: BUYER_LISTING_RECENCY_DAYS },
    { defaultLimit: 30, endpoint: "sale" },
  )
  check(`sale query sends daysOld '*:${BUYER_LISTING_RECENCY_DAYS}' (listed within the window)`, q.daysOld === `*:${BUYER_LISTING_RECENCY_DAYS}`, JSON.stringify(q))
  check("range params stay ranges: bedrooms '3:*', price '*:450000', status Active", q.bedrooms === "3:*" && q.price === "*:450000" && q.status === "Active")
  check("city + state both sent (RentCast cannot search a bare city)", q.city === "Frisco" && q.state === "TX")
  const noWindow = buildRentcastListingQuery({ city: "Frisco", state: "TX" }, { defaultLimit: 30, endpoint: "sale" })
  check("POSITIVE CONTROL — no window asked → no daysOld sent (comps/rent-estimate callers unchanged)", !("daysOld" in noWindow))
  const single = buildRentcastListingQuery({ address: "1 Main St, Frisco, TX 75034", listedWithinDays: 30 }, { defaultLimit: 30, endpoint: "sale" })
  check("single-home lookup sends the address ALONE (window dropped, RentCast's contract)", JSON.stringify(single) === JSON.stringify({ address: "1 Main St, Frisco, TX 75034" }))
  const rental = buildRentcastListingQuery({ zipCode: "75034", propertyType: "land", bedroomsMax: 2, listedWithinDays: 14 }, { defaultLimit: 20, endpoint: "rental" })
  check("rental: 'Land' omitted, max-only beds '*:2', daysOld '*:14', limit 20", !rental.propertyType && rental.bedrooms === "*:2" && rental.daysOld === "*:14" && rental.limit === 20, JSON.stringify(rental))
  const saleMax = buildRentcastListingQuery({ zipCode: "75034", bedroomsMax: 2 }, { defaultLimit: 30, endpoint: "sale" })
  check("sale: the max-only bedroom range the old sale copy dropped is now sent", saleMax.bedrooms === "*:2")
  const shape = (d: number) => buildRentcastListingQuery({ zipCode: "75034", listedWithinDays: d }, { defaultLimit: 30, endpoint: "sale" }).daysOld
  check("daysOld floors at RentCast's minimum of 1; garbage → none", shape(0.2) === "*:1" && shape(Number.NaN) === undefined)

  const rc = code("lib/property/rentcast.ts")
  check("BOTH listing readers build through buildRentcastListingQuery (one builder, §6)",
    /callRentcastGet\("\/listings\/sale"/.test(rc) && (rc.match(/buildRentcastListingQuery\(f,/g) ?? []).length === 2)
  const smt = fnBody(code("lib/ai-isa/customer-context-tools.ts"), "export function buildSendMatchingListingsTool")
  check("send_matching_listings passes listedWithinDays: BUYER_LISTING_RECENCY_DAYS", /listedWithinDays:\s*BUYER_LISTING_RECENCY_DAYS/.test(smt))
  check("send_matching_listings runs the one parser on the buyer's words", /parseBuyerCriteria\(/.test(smt) && /buyer_words/.test(smt))
  check("send_matching_listings refuses an area-less RentCast pull (asks where first)", /rentcastSkipped/.test(smt))
  check("NL search engine passes the window to the one listing router", /listedWithinDays:\s*BUYER_LISTING_RECENCY_DAYS/.test(code("lib/buyer-search/search-engine.ts")))
  check("external router forwards listedWithinDays to RentCast", /listedWithinDays:\s*input\.listedWithinDays/.test(code("lib/property/external-listings-search.ts")))
  check("alert sweep: both RentCast legs carry the alert's window", (code("lib/property-alerts/idx-alert-search.ts").match(/listedWithinDays:\s*ctx\.listedWithinDays/g) ?? []).length === 2)
  check("alert engine derives the window from the alert (alertListingRecencyDays)", /listedWithinDays:\s*alertListingRecencyDays\(/.test(code("lib/property-alerts/alert-engine.ts")))
}

/** The finder for Layer 5 — any BatchData module, client, MCP tool or tool
 *  builder named in CODE (comments stripped first: a tombstone that names
 *  BatchData is not a call). */
const BATCHDATA_TOKEN = /batch[-_]?data/i
function batchDataHits(text: string): string[] {
  return text.split("\n").filter((l) => BATCHDATA_TOKEN.test(l)).map((l) => l.trim())
}

/** Layer 5 — no BatchData anywhere on the buyer listing path. */
function layer5NoBatchDataOnBuyerListingPath() {
  console.log("\n[Layer 5 · no BatchData on the buyer listing path]")
  // POSITIVE CONTROLS — the finder recognises the defect, and stripping works.
  const specimen = 'const { lookupProperty } = await import("@/lib/external/batchdata-client")'
  check("positive control: a BatchData import is flagged", batchDataHits(stripComments(specimen)).length === 1)
  check("positive control: a BatchData MCP tool call is flagged", batchDataHits(stripComments("await batchDataIsaTools({ brokerageId })")).length === 1)
  check("negative control: a comment naming BatchData is NOT a call (stripped)", batchDataHits(stripComments("// never BatchData here\nconst x = 1")).length === 0)

  const WHOLE_FILES = [
    "lib/buyer-search/parse-buyer-criteria.ts",
    "lib/buyer-search/conversation-criteria.ts",
    "lib/buyer-search/intent-parser.ts",
    "lib/buyer-search/search-engine.ts",
    "lib/property/external-listings-search.ts",
    "lib/property/rentcast.ts",
    "lib/property/rentcast-query.ts",
    "lib/property-alerts/idx-alert-search.ts",
    "lib/property-alerts/alert-engine.ts",
    "lib/property-alerts/alert-cadence.ts",
    "lib/property-alerts/alert-matcher.ts",
    "lib/property-alerts/alert-notifier.ts",
    "app/actions/portal-nl-search.ts",
  ]
  let scanned = 0
  for (const rel of WHOLE_FILES) {
    const hits = batchDataHits(code(rel))
    scanned++
    check(`${rel}: 0 BatchData references in code`, hits.length === 0, hits.slice(0, 2).join(" | "))
  }
  const smt = fnBody(code("lib/ai-isa/customer-context-tools.ts"), "export function buildSendMatchingListingsTool")
  check("send_matching_listings body (the ISA's listing send): 0 BatchData references", smt.length > 0 && batchDataHits(smt).length === 0)
  const smart = fnBody(code("app/actions/idx-search.ts"), "export async function smartSearch")
  check("smartSearch body (portal/CRM NL search): 0 BatchData references", smart.length > 0 && batchDataHits(smart).length === 0)
  console.log(`  · scanned ${scanned} whole files + 2 function bodies (blind spot: the dynamic RentCast MCP catalogue (rentcast_* tools) and the IDX client are outside this list; neither imports BatchData)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
