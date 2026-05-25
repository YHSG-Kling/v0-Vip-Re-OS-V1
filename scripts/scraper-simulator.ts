#!/usr/bin/env tsx
/**
 * scripts/scraper-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Scraper simulator / connection harness.
 *
 * The live scrapers call external vendor APIs (ZenRows, BatchData, Apify,
 * PeopleData) which cannot run in CI or the agent sandbox (no egress, no keys).
 * This harness exercises the REAL scraper code paths against realistic fixture
 * payloads — the parse/normalize layer (lib/lead-pipeline/scraper-parsers.ts),
 * the canonical viability + identity gates (lib/lead-pipeline/raw-record-types),
 * and the ZenRows client's response handling (global fetch is stubbed). It
 * proves the parsing/normalization/connection logic without hitting the network.
 *
 * The DB half of the connection (raw_scraped_leads -> processRawRecord -> leads)
 * is covered by the SQL harness FLOW 1 / FLOW 9 in run-vip-re-os/flows.sql.
 *
 * Run:  npx tsx scripts/scraper-simulator.ts
 * Exit: 0 = all checks pass, 1 = any failure (CI gate).
 */

import {
  parsePropertySearchResults,
  parseCraigslistHtml,
  normalizeBatchDataRecord,
  buildPropertySearchUrl,
} from "../lib/lead-pipeline/scraper-parsers"
import {
  isViableRecord,
  hasPromotionEligibleIdentity,
  buildLeadIdentityKey,
  type NormalizedScrapedRecord,
} from "../lib/lead-pipeline/raw-record-types"
import { getSourceSemantics, resolveSourceKey, SOURCE_VENDOR } from "../lib/lead-pipeline/source-intent-map"
import {
  detectIntent,
  normalizeInstagramPost,
  normalizeGoogleResult,
  normalizeCraigslistItem,
  normalizeFacebookPost,
} from "../lib/lead-pipeline/social-sourcer"

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const MARKET = { city: "Tampa", state: "FL" }

// ── 1. Zillow JSON parse ─────────────────────────────────────────────────────
function testZillow() {
  console.log("\n[Zillow property-view parse]")
  const listResults = [
    { zpid: 12345, address: "123 Main St", city: "Tampa", state: "FL", zipcode: "33601", detailUrl: "/homedetails/123_zpid/" },
    { zpid: 67890, streetAddress: "456 Bay Dr", city: "Tampa", state: "FL" },
    { zpid: 99999 }, // no address — must be dropped
  ]
  const html = `<html><body><script type="application/json">${JSON.stringify({
    cat1: { searchResults: { listResults } },
  })}</script></body></html>`

  const records = parsePropertySearchResults(html, "zillow", MARKET)
  check("parses 2 viable Zillow listings (address-less dropped)", records.length === 2, `got ${records.length}`)
  const r = records[0]
  check("source = zillow", r?.source === "zillow")
  check("intentType = seller (FSBO, not property/buyer)", r?.intentType === "seller")
  check("behaviorType = fsbo_listing", r?.behaviorType === "fsbo_listing")
  check("propertyAddress captured", r?.propertyAddress === "123 Main St")
  check("sourceUrl built from detailUrl", r?.sourceUrl === "https://www.zillow.com/homedetails/123_zpid/")
  check("sourceRecordId namespaced", r?.sourceRecordId === "zillow-12345")
  check("all records pass viability gate", records.every(isViableRecord))
}

// ── 2. Realtor HTML parse ────────────────────────────────────────────────────
function testRealtor() {
  console.log("\n[Realtor property-card parse]")
  // Real Realtor cards carry two card-address lines (street, then locality);
  // the parser combines first()+last() into a single address string.
  const html = `
    <div data-testid="property-card">
      <div data-testid="card-address">789 Oak Ave</div>
      <div data-testid="card-address">Tampa, FL 33601</div>
      <a href="/realestateandhomes-detail/789-Oak-Ave_Tampa_FL"></a>
      <div data-testid="card-price">$525,000</div>
    </div>`
  const records = parsePropertySearchResults(html, "realtor", MARKET)
  check("parses 1 Realtor card", records.length === 1, `got ${records.length}`)
  check("source = realtor", records[0]?.source === "realtor")
  check("address combines street + locality", records[0]?.propertyAddress === "789 Oak Ave, Tampa, FL 33601", records[0]?.propertyAddress ?? undefined)
  check("price parsed into rawPayload", (records[0]?.rawPayload as any)?.price === 525000)
}

// ── 3. Redfin HTML parse ─────────────────────────────────────────────────────
function testRedfin() {
  console.log("\n[Redfin home-card parse]")
  const html = `
    <div data-rf-test-name="mapHomeCard">
      <div data-rf-test-name="homecard-address">321 Pine Rd</div>
      <a href="/FL/Tampa/321-Pine-Rd/home/12345"></a>
    </div>`
  const records = parsePropertySearchResults(html, "redfin", MARKET)
  check("parses 1 Redfin card", records.length === 1, `got ${records.length}`)
  check("address captured", records[0]?.propertyAddress === "321 Pine Rd")
  check("city/state from market", records[0]?.city === "Tampa" && records[0]?.state === "FL")
}

// ── 4. Craigslist FSBO parse ─────────────────────────────────────────────────
function testCraigslist() {
  console.log("\n[Craigslist FSBO parse]")
  const html = `
    <li class="result-row" data-pid="7711">
      <a class="result-title" href="https://tampa.craigslist.org/reo/7711.html">3BR/2BA home for sale by owner</a>
      <span class="result-price">$310,000</span>
    </li>
    <li class="result-row" data-pid="7712">
      <a class="result-title" href="/reo/7712.html">Cozy condo listing downtown</a>
      <span class="result-price">$210,000</span>
    </li>`
  const records = parseCraigslistHtml(html)
  check("parses 2 Craigslist rows", records.length === 2, `got ${records.length}`)
  const fsbo = records.find((r) => r.sourceRecordId === "7711")
  check("FSBO detected → fsbo_listing", fsbo?.behaviorType === "fsbo_listing")
  check("FSBO motivationScore = 75", fsbo?.motivationScore === 75)
  check("FSBO intentType = seller", fsbo?.intentType === "seller")
  const regular = records.find((r) => r.sourceRecordId === "7712")
  check("non-FSBO → property_listing (score 45)", regular?.behaviorType === "property_listing" && regular?.motivationScore === 45)
  check("relative href absolutized", regular?.sourceUrl === "https://craigslist.org/reo/7712.html")
}

// ── 5. BatchData normalize ───────────────────────────────────────────────────
function testBatchData() {
  console.log("\n[BatchData motivated-seller normalize]")
  const a = normalizeBatchDataRecord(
    { owner_name: "Jane Q Doe", property_address: "99 Elm St", city: "Tampa", state: "FL", motivationConfidence: 0.85, motivationType: "pre_foreclosure" },
    MARKET,
  )
  check("owner_name split → first name", a.firstName === "Jane")
  check("owner_name split → last name", a.lastName === "Q Doe")
  check("confidence 0.85 → score 85 (clamped/scaled)", a.motivationScore === 85, `got ${a.motivationScore}`)
  check("intentType = seller", a.intentType === "seller")
  check("motivationType → intentSignals", a.intentSignals?.[0] === "pre_foreclosure")
  check("propertyAddress mapped", a.propertyAddress === "99 Elm St")

  const b = normalizeBatchDataRecord({ first_name: "Bob", last_name: "Smith", motivation_score: 250 }, MARKET)
  check("out-of-range score clamped to 100", b.motivationScore === 100, `got ${b.motivationScore}`)
}

// ── 6. Viability + identity gates ────────────────────────────────────────────
function testGates() {
  console.log("\n[Viability + identity gates]")
  const withContact: NormalizedScrapedRecord = {
    sourceRecordId: "t-1", source: "batchdata_motivated", behaviorType: "motivated_seller",
    intentType: "seller", intentSignals: ["x"], firstName: "Ann", lastName: "Lee",
    email: "ann.lee@example.com", city: "Tampa", state: "FL", motivationScore: 70, rawPayload: {},
  }
  check("record with email is viable", isViableRecord(withContact))
  check("record with full name + email is promotion-eligible", hasPromotionEligibleIdentity(withContact))
  const key = buildLeadIdentityKey(withContact)
  check("identity key built", !!key && key.length > 0, String(key))

  const anonymous: NormalizedScrapedRecord = {
    sourceRecordId: "t-2", source: "zillow", behaviorType: "property_view",
    intentType: "buyer", intentSignals: ["x"], motivationScore: 40, rawPayload: {},
  }
  check("anonymous (no contact/address/name) not promotion-eligible", !hasPromotionEligibleIdentity(anonymous))
}

// ── 7. URL builder ───────────────────────────────────────────────────────────
function testUrlBuilder() {
  console.log("\n[Property search URL builder]")
  const z = buildPropertySearchUrl("zillow", { city: "St Petersburg", state: "FL" }, { min_price: 200000, max_price: 500000 })
  check("zillow url targets FSBO + encoded", z.startsWith("https://www.zillow.com/st-petersburg-fl/fsbo/") && z.includes("searchQueryState=") && z.includes("fsbo"))
  const rl = buildPropertySearchUrl("realtor", { city: "Tampa", state: "FL" }, { min_beds: 3 })
  check("realtor url uses underscores + beds + show-fsbo", rl.includes("Tampa_FL") && rl.includes("beds-3") && rl.endsWith("/show-fsbo"))
  const rd = buildPropertySearchUrl("redfin", { city: "Tampa", state: "FL" }, {})
  check("redfin url includes forSaleByOwner", rd.includes("include=forSaleByOwner"))
  const d = buildPropertySearchUrl("unknown", { city: "Tampa", state: "FL" }, {})
  check("unknown site falls back to zillow", d.startsWith("https://www.zillow.com/"))
}

// ── 8. ZenRows client response handling (fetch stubbed) ──────────────────────
async function testZenRowsClient() {
  console.log("\n[ZenRows client — response handling (fetch mocked)]")
  process.env.ZENROWS_API_KEY = process.env.ZENROWS_API_KEY || "sim-test-key"
  const { scrapeWithZenRows, extractContactsFromHtml } = await import("../lib/external/zenrows-client")

  const realFetch = globalThis.fetch
  // success
  globalThis.fetch = (async () => ({
    ok: true, status: 200, statusText: "OK", text: async () => "<html>scraped body</html>",
  })) as unknown as typeof fetch
  try {
    const ok = await scrapeWithZenRows("https://example.com", { jsRender: true })
    check("returns body on 200", ok.body.includes("scraped body"))
    check("statusCode propagated", ok.statusCode === 200)
    check("cost recorded", typeof ok.cost === "number" && ok.cost > 0)
  } catch (e) {
    check("success path did not throw", false, String(e))
  }

  // failure
  globalThis.fetch = (async () => ({ ok: false, status: 403, statusText: "Forbidden", text: async () => "" })) as unknown as typeof fetch
  let threw = false
  try {
    await scrapeWithZenRows("https://example.com")
  } catch {
    threw = true
  }
  check("throws on non-ok response (403)", threw)
  globalThis.fetch = realFetch

  // pure contact extraction
  const { emails, phones } = await extractContactsFromHtml(
    "Reach me at jane@example.com or (813) 555-0142. Dup jane@example.com.",
  )
  check("extracts + dedups email", emails.length === 1 && emails[0] === "jane@example.com")
  check("extracts phone", phones.some((p) => p.replace(/\D/g, "").includes("8135550142")))
}

// ── 9. Source → intent mapping (the vendor/intent model) ─────────────────────
function testIntentMapping() {
  console.log("\n[Source → intent mapping]")
  // Each scraper source must resolve to the correct buyer/seller intent.
  // ZenRows listing sites = FSBO SELLER intent (we capture by-owner, not property).
  const cases: Array<[string, "buyer" | "seller" | "unknown"]> = [
    ["zillow", "seller"],            // FSBO seller intent (aliased → zenrows_zillow)
    ["realtor", "seller"],
    ["redfin", "seller"],            // aliased → zenrows_homes
    ["batchdata_motivated", "seller"], // FSBO/divorce/probate/foreclosure distress
    ["craigslist_fsbo", "seller"],
    ["facebook_group", "seller"],
    ["reddit_intent", "buyer"],      // buyer research/intent posts
    ["instagram", "unknown"],        // both buyer + seller (aliased → instagram_intent)
    ["nextdoor", "unknown"],         // buyer-or-seller until enrichment
    ["google_phrase_intent", "unknown"], // buyers search homes + sellers search agents
  ]
  for (const [source, expected] of cases) {
    const sem = getSourceSemantics(source)
    check(`source "${source}" → intent ${expected}`, sem.intentType === expected, `got ${sem.intentType}`)
  }
  // Alias resolution must not fall through to the unknown fallback.
  check("alias zillow → zenrows_zillow", resolveSourceKey("zillow") === "zenrows_zillow")
  check("alias redfin → zenrows_homes", resolveSourceKey("redfin") === "zenrows_homes")
  check("alias nextdoor → nextdoor_intent", resolveSourceKey("nextdoor") === "nextdoor_intent")
  check("listing-site motivation = fsbo_seller", getSourceSemantics("zillow").motivationType === "fsbo_seller")
}

// ── 10. Vendor routing contract ──────────────────────────────────────────────
function testVendorRouting() {
  console.log("\n[Vendor routing — SOURCE_VENDOR contract]")
  // ZenRows is reserved for the (expensive) real-estate sites + Nextdoor.
  check("zillow → zenrows", SOURCE_VENDOR.zenrows_zillow === "zenrows")
  check("realtor → zenrows", SOURCE_VENDOR.zenrows_realtor === "zenrows")
  check("redfin/homes → zenrows", SOURCE_VENDOR.zenrows_homes === "zenrows")
  check("nextdoor → zenrows", SOURCE_VENDOR.nextdoor_intent === "zenrows")
  // Apify owns Facebook / Instagram / Craigslist / Reddit / Google.
  check("facebook → apify", SOURCE_VENDOR.facebook_group === "apify")
  check("instagram → apify", SOURCE_VENDOR.instagram_intent === "apify")
  check("craigslist → apify", SOURCE_VENDOR.craigslist_fsbo === "apify")
  check("reddit → apify", SOURCE_VENDOR.reddit_intent === "apify")
  check("google → apify", SOURCE_VENDOR.google_phrase_intent === "apify")
  // Distress + records sources.
  check("batchdata → batchdata", SOURCE_VENDOR.batchdata_motivated === "batchdata")
  check("osint → osint", SOURCE_VENDOR.osint_signal === "osint")
}

// ── 11. Social-source normalizers + intent detection ─────────────────────────
function testSocialNormalizers() {
  console.log("\n[Social normalizers + detectIntent]")
  check("detectIntent: seller phrase", detectIntent("Thinking of selling my home, FSBO") === "seller")
  check("detectIntent: buyer phrase", detectIntent("We are house hunting and pre-approved") === "buyer")
  check("detectIntent: ambiguous → unknown", detectIntent("Nice neighborhood photos") === "unknown")

  const ig = normalizeInstagramPost(
    { id: "ig1", caption: "Finally listing my home! #fsbo", ownerFullName: "Dana Seller", ownerUsername: "dana_s", url: "https://instagram.com/p/ig1" },
    { city: "Tampa", state: "FL" },
  )
  check("IG source = instagram_intent", ig.source === "instagram_intent")
  check("IG seller caption → seller intent", ig.intentType === "seller")
  check("IG owner name parsed", ig.firstName === "Dana" && ig.lastName === "Seller")

  const g = normalizeGoogleResult(
    { title: "Sell my house fast in Tampa", url: "https://x.com/sell", snippet: "cash offer" },
    { city: "Tampa", state: "FL" },
  )
  check("Google source = google_phrase_intent", g.source === "google_phrase_intent")
  check("Google seller query → seller intent", g.intentType === "seller")

  const cl = normalizeCraigslistItem({ id: "cl9", title: "3BR home for sale by owner", url: "https://cl/9" }, { city: "Tampa", state: "FL" })
  check("Craigslist FSBO → seller + fsbo_listing", cl.intentType === "seller" && cl.behaviorType === "fsbo_listing")

  const fb = normalizeFacebookPost({ id: "fb2", text: "looking to buy my first home", authorName: "Sam Buyer" }, { city: "Tampa", state: "FL" })
  check("FB buyer post → buyer intent", fb.intentType === "buyer")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" SCRAPER SIMULATOR — parse / normalize / gate / client")
  console.log("══════════════════════════════════════════════════")
  testZillow()
  testRealtor()
  testRedfin()
  testCraigslist()
  testBatchData()
  testGates()
  testUrlBuilder()
  testIntentMapping()
  testVendorRouting()
  testSocialNormalizers()
  await testZenRowsClient()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" FAILURES:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ All scraper parse/normalize/gate/client checks passed")
  process.exit(0)
}

void main()
