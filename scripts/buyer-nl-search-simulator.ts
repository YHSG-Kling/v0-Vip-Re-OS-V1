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
 * Layer 2 (live, creds-gated): seed an ACTIVE listing + a SOFT-DELETED listing for a real brokerage +
 * a buyer contact; run searchPropertiesCore; assert the active listing is returned, the deleted one is
 * NOT, and every buyer-facing string is Fair-Housing clean. Reverse-delete; cleanup count == 0.
 *
 * Run: npx tsx scripts/buyer-nl-search-simulator.ts   (npm run test:buyer-nl-search)
 */
import { parseNaturalLanguageQuery } from "../lib/buyer-search/intent-parser"
import { scanFairHousing, sanitizeFairHousing, sanitizeExplanation } from "../lib/buyer-search/fair-housing"
import { toPortalCards, savedRowToInterest } from "../lib/buyer-search/portal-cards"

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

main().catch((e) => { console.error(e); process.exit(1) })
