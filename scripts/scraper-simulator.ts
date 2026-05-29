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
  parseBuyerSavedSearches,
  parseExpiredListings,
  parseCraigslistHtml,
  normalizeBatchDataRecord,
  buildPropertySearchUrl,
} from "../lib/lead-pipeline/scraper-parsers"
import { mergeEnrichment, shouldGapFill } from "../lib/lead-pipeline/enrichment-merge"
import {
  isViableRecord,
  hasPromotionEligibleIdentity,
  buildLeadIdentityKey,
  type NormalizedScrapedRecord,
} from "../lib/lead-pipeline/raw-record-types"
import { getSourceSemantics, resolveSourceKey, SOURCE_VENDOR, expandEnabledSources } from "../lib/lead-pipeline/source-intent-map"
import {
  detectIntent,
  isInvestor,
  normalizeRedditPost,
  normalizeInstagramPost,
  normalizeGoogleResult,
  normalizeCraigslistItem,
  normalizeFacebookPost,
  normalizeRentalListing,
  normalizeLinkedInPost,
} from "../lib/lead-pipeline/social-sourcer"
import { activeSubscriberBrokerageIds, isActiveSubscriptionStatus } from "../lib/lead-pipeline/subscription-gate"
import { parseTerritoryCourtRecords, recordTypeIntent } from "../lib/osint-client"
import { normalizeCourtFiling } from "../lib/lead-pipeline/osint-sourcer"
import { ACTOR_REGISTRY, pickActors, runApifyTask } from "../lib/external/apify-actors"
import { normalizeExaResult } from "../lib/lead-pipeline/exa-sourcer"
import { normalizeExaRow } from "../lib/external/exa-client"
import { normalizeTavilyResult } from "../lib/lead-pipeline/tavily-sourcer"
import { normalizeTavilyRow } from "../lib/external/tavily-client"
import { runWebSearch } from "../lib/ai/web-search"
import { normalizeRentcastMarketStats } from "../lib/property/rentcast-normalize"
import {
  isNeighborhoodReportAllowed,
  computeLivabilityScore,
  factualNarrative,
} from "../lib/property/neighborhood-scoring"
import { detectFairHousingViolations } from "../lib/compliance-rules/fair-housing-patterns"
import { BATCHDATA_MOTIVATION_TYPES, BATCHDATA_QUICKLISTS, fetchMotivatedSellers, normalizeBatchDataProperty, buildPropertySearchBody } from "../lib/external/batchdata-client"
import { runApifyActor } from "../lib/external/apify-client"
import { syncContactToHubSpot } from "../lib/crm/providers/hubspot"
import { publishToSocialPlatform } from "../lib/social/publisher"
import { meterVendorSpend, scraperTypeToVendor, estimatePlatformVendorCost, PLATFORM_VENDOR_RATES } from "../lib/vendor-governance/meter-vendor"
import { evaluateVendorBudget, vendorBudgetForTier, MONTHLY_VENDOR_BUDGET_USD, aggregateBrokerageSpend } from "../lib/vendor-governance/budget-eval"
import { budgetLevel, redactBudgetForActor } from "../lib/vendor-governance/budget-visibility"
import { resolveVendorAction, freeAlternativeFor } from "../lib/vendor-governance/vendor-policy"
import { VENDOR_CAPABILITY_REGISTRY, getVendorCapability, selectProvider, buildActionManifest, requiredScope, AGIS_VERBS } from "../lib/agentic-os/vendor-capability-registry"
import { hasScope, authorizedActions, ALL_SCOPES } from "../lib/agentic-os/agent-scopes"
import { planInvocation, parseInputSpec, planConnectedInvocation } from "../lib/agentic-os/invoke-planner"
import { hashAgentToken, generateAgentToken, extractBearerToken } from "../lib/agentic-os/agent-credentials"
import { APP_CAPABILITY_REGISTRY, buildAppActionManifest, buildConnectedActionManifest, buildFullActionManifest } from "../lib/agentic-os/app-capability-registry"
import { vendorOwnership, isPlatformVendor, isUserConnectedVendor, PLATFORM_VENDORS, USER_CONNECTED_VENDORS } from "../lib/agentic-os/vendor-ownership"
import { CONNECTED_CAPABILITY_REGISTRY, isConnectedCapability } from "../lib/agentic-os/connected-vendor-registry"
import { deriveConnectivityStatus, transportFor, summarizeConnectivity, needsAttention, EXPIRY_WARNING_DAYS, type ConnectorHealth } from "../lib/agentic-os/connectivity-agent"
import { inferTransport, assessShape, adaptResponse, shapeHealthy, type ConnectorShapeSpec } from "../lib/agentic-os/connector-shape"
import { classifyProbe, PROBE_SPECS } from "../lib/agentic-os/connector-probe"
import { buildAuthedRequest, callConnector } from "../lib/agentic-os/connector-gateway"
import { outcomeForDecision } from "../lib/agentic-os/invocation-log"
import { manifestToMcpTools, inputsToJsonSchema, toToolName } from "../lib/agentic-os/mcp-tools"
import { computeFreeSlots } from "../lib/providers/calendar/free-slots"
import { scopeCascade, isConnectionAllowed, writeScopeFor, isProviderAllowedForScope, domainsForScope, selectableConnectionsForScope, CONNECTOR_PROVIDERS } from "../lib/connections/scope"
import { buildCredentialWrite, isOAuthConnection, oauthStartPath, connectionScopeForUserType, isConnectSupported, selfConnectableDomains } from "../lib/connections/field-spec"
import { isPlatformStaff } from "../lib/auth/resolve-user-role"
import { matchTriggersForEvent, isCooldownActive, type LifecycleTrigger } from "../lib/marketing/trigger-match"
import { findReusableRun, type ExistingRun } from "../lib/workflow-orchestrator/run-dedupe"

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

// ── 8b. Vendor connector request shapes (BatchData + Apify, fetch mocked) ────
async function testVendorConnectors() {
  console.log("\n[Vendor connector request shapes — BatchData + Apify]")
  const realFetch = globalThis.fetch

  // normalizeBatchDataProperty (pure) maps a real-shaped Property Search row.
  const rec = normalizeBatchDataProperty(
    {
      address: { street: "123 Main St", city: "Tampa", state: "FL", zip: "33602" },
      owner: { fullName: "Jane Owner", mailingAddress: { street: "PO Box 9", city: "Tampa", state: "FL", zip: "33602" } },
      building: { bedroomCount: 3, bathroomCount: 2, livingAreaSquareFeet: 1800 },
      valuation: { estimatedValue: 415000 },
    },
    "preforeclosure" as any,
  )
  check("batchdata property → owner name split", rec.firstName === "Jane" && rec.lastName === "Owner")
  check("batchdata property → property address mapped", rec.propertyAddress === "123 Main St" && rec.propertyZip === "33602")
  check("batchdata property → beds/sqft/value mapped", rec.beds === 3 && rec.sqft === 1800 && rec.estimatedValue === 415000)

  // fetchMotivatedSellers → correct endpoint + searchCriteria.quickLists body.
  let captured: { url: string; body: any } | null = null
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), body: JSON.parse(init.body) }
    return { ok: true, status: 200, json: async () => ({ results: { properties: [], meta: { totalResults: 0 } } }) }
  }) as unknown as typeof fetch
  await fetchMotivatedSellers({ state: "FL", city: "Tampa", motivationTypes: ["pre_foreclosure", "high_equity"], limit: 25 })
  check("BatchData hits /api/v1/property/search", !!captured && (captured as any).url.endsWith("/property/search"))
  check("BatchData body uses searchCriteria.orQuickLists (OR — match ANY trigger)", !!captured && Array.isArray((captured as any).body.searchCriteria.orQuickLists))
  check("BatchData maps pre_foreclosure → 'preforeclosure' slug", !!captured && (captured as any).body.searchCriteria.orQuickLists.includes("preforeclosure"))
  check("BatchData maps high_equity → 'high-equity' slug", !!captured && (captured as any).body.searchCriteria.orQuickLists.includes("high-equity"))
  check("BatchData options.take = limit", !!captured && (captured as any).body.options.take === 25)

  // buildPropertySearchBody (pure) — quickLists ARE the lead descriptors; query is the geography.
  const built = buildPropertySearchBody({ state: "FL", city: "Tampa", zip: "33602", motivationTypes: ["high_equity", "absentee"], limit: 50, skip: 100 })
  const sc = built.searchCriteria as any
  check("BatchData builder: motivation triggers → orQuickLists (high-equity + absentee-owner)", sc.orQuickLists.includes("high-equity") && sc.orQuickLists.includes("absentee-owner"))
  check("BatchData builder: query carries the geography (city/zip/state)", sc.query === "Tampa, 33602, FL")
  check("BatchData builder: only query + orQuickLists by default (no param bloat)", Object.keys(sc).sort().join(",") === "orQuickLists,query")
  check("BatchData builder: pagination via options.take/skip", built.options.take === 50 && built.options.skip === 100)
  check("BatchData builder: every mapped slug is a VALID BatchData quickList", Object.values((buildPropertySearchBody({ state: "FL", motivationTypes: [...BATCHDATA_MOTIVATION_TYPES] }).searchCriteria as any).orQuickLists as string[]).every((s) => BATCHDATA_QUICKLISTS.has(s)))
  check("BatchData builder: quickList arrays capped at 3 (API limit)", (buildPropertySearchBody({ state: "FL", motivationTypes: [...BATCHDATA_MOTIVATION_TYPES] }).searchCriteria as any).orQuickLists.length === 3)
  check("BatchData builder: invalid slug dropped (divorce/foreclosure not valid quickLists)", (() => { const b = buildPropertySearchBody({ state: "FL", andQuickLists: ["divorce", "high-equity", "not-owner-occupied"] }).searchCriteria as any; return !b.quickLists.includes("divorce") && b.quickLists.includes("high-equity") && b.quickLists.includes("not-owner-occupied") })())
  check("BatchData builder: andQuickLists → AND-ed quickLists (intersection narrowing)", (() => { const b = buildPropertySearchBody({ state: "FL", motivationTypes: ["high_equity"], andQuickLists: ["out-of-state-owner"] }).searchCriteria as any; return b.orQuickLists.includes("high-equity") && b.quickLists.includes("out-of-state-owner") })())
  check("BatchData builder: searchCriteria passthrough is the structured 'third type' escape hatch", (() => { const b = buildPropertySearchBody({ state: "FL", searchCriteria: { building: { minBedroomCount: 3 } } }).searchCriteria as any; return b.building.minBedroomCount === 3 })())

  // runApifyActor → run-sync-get-dataset-items with slug `/`→`~`.
  let apifyUrl = ""
  globalThis.fetch = (async (url: any) => {
    apifyUrl = String(url)
    return { ok: true, status: 200, json: async () => [{ id: "post1" }] }
  }) as unknown as typeof fetch
  const apifyRes = await runApifyActor("apify/facebook-posts-scraper", { maxPosts: 10 })
  check("Apify slug '/'→'~' normalized in path", apifyUrl.includes("acts/apify~facebook-posts-scraper"))
  check("Apify uses run-sync-get-dataset-items endpoint", apifyUrl.endsWith("/run-sync-get-dataset-items"))
  check("Apify returns dataset items array", Array.isArray(apifyRes.data) && apifyRes.data.length === 1)

  // HubSpot CRM sync-out (gateway) — upsert by email, Bearer auth, result mapping.
  let hsReq: { url: string; body: any; auth: string } | null = null
  globalThis.fetch = (async (url: any, init: any) => {
    hsReq = { url: String(url), body: JSON.parse(init.body), auth: init.headers?.Authorization ?? init.headers?.authorization ?? "" }
    return { ok: true, status: 200, json: async () => ({ results: [{ id: "hs-123" }] }) }
  }) as unknown as typeof fetch
  const hsRes = await syncContactToHubSpot({ firstName: "Dana", lastName: "Buyer", email: "dana@example.com", phone: "+15557654321" }, "HSTOKEN")
  check("HubSpot upserts via /crm/v3/objects/contacts/batch/upsert", !!hsReq && (hsReq as any).url.endsWith("/crm/v3/objects/contacts/batch/upsert"))
  check("HubSpot upsert keyed by email idProperty", !!hsReq && (hsReq as any).body.inputs[0].idProperty === "email" && (hsReq as any).body.inputs[0].id === "dana@example.com")
  check("HubSpot maps name/email/phone to properties", !!hsReq && (hsReq as any).body.inputs[0].properties.firstname === "Dana" && (hsReq as any).body.inputs[0].properties.email === "dana@example.com" && (hsReq as any).body.inputs[0].properties.phone === "+15557654321")
  check("HubSpot uses Bearer auth", !!hsReq && (hsReq as any).auth === "Bearer HSTOKEN")
  check("HubSpot returns contactId from results[0].id", hsRes.success && hsRes.contactId === "hs-123")
  check("HubSpot without token → requiresConfiguration", (await syncContactToHubSpot({ firstName: "X", lastName: "Y" }, null)).requiresConfiguration === true)

  // Gateway arraybuffer mode (binary egress, e.g. ElevenLabs TTS audio) — returns raw bytes as Buffer.
  let ttsReq: { url: string; header: string } | null = null
  globalThis.fetch = (async (url: any, init: any) => {
    ttsReq = { url: String(url), header: init?.headers?.["xi-api-key"] ?? "" }
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("MP3BYTES").buffer }
  }) as unknown as typeof fetch
  const abRes = await callConnector<Buffer>({
    connector: "elevenlabs", baseUrl: "https://api.elevenlabs.io", path: "v1/text-to-speech/voice123",
    method: "POST", auth: { style: "header", name: "xi-api-key", value: "XL_KEY" },
    headers: { Accept: "audio/mpeg" }, responseType: "arraybuffer", body: { text: "hi" },
  })
  check("gateway arraybuffer: returns Buffer bytes on 200", abRes.ok && Buffer.isBuffer(abRes.data) && abRes.data!.toString() === "MP3BYTES")
  check("gateway arraybuffer: routed to elevenlabs with header auth", !!ttsReq && (ttsReq as any).url === "https://api.elevenlabs.io/v1/text-to-speech/voice123" && (ttsReq as any).header === "XL_KEY")
  globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => "quota exceeded" })) as unknown as typeof fetch
  const abErr = await callConnector({ connector: "elevenlabs", baseUrl: "https://api.elevenlabs.io", path: "x", method: "POST", auth: { style: "header", name: "xi-api-key", value: "K" }, responseType: "arraybuffer", body: {} })
  check("gateway arraybuffer: surfaces error body on failure", !abErr.ok && abErr.status === 401 && abErr.error === "quota exceeded")

  // Gateway form-urlencoded body mode (Stripe/Intuit style) — body is x-www-form-urlencoded.
  let formReq: { ct: string; body: string; auth: string } | null = null
  globalThis.fetch = (async (_url: any, init: any) => {
    formReq = { ct: init?.headers?.["Content-Type"] ?? "", body: String(init?.body ?? ""), auth: init?.headers?.Authorization ?? "" }
    return { ok: true, status: 200, json: async () => ({ id: "tr_1", amount: 5000 }) }
  }) as unknown as typeof fetch
  const formRes = await callConnector<{ id: string }>({
    connector: "stripe", baseUrl: "https://api.stripe.com", path: "v1/transfers", method: "POST",
    auth: { style: "bearer", token: "sk_test" }, bodyType: "form",
    body: { amount: "5000", currency: "usd", "metadata[txn]": "abc" },
  })
  check("gateway form: Content-Type is x-www-form-urlencoded", !!formReq && (formReq as any).ct === "application/x-www-form-urlencoded")
  check("gateway form: body is urlencoded (incl bracket keys)", !!formReq && (formReq as any).body.includes("amount=5000") && (formReq as any).body.includes("metadata%5Btxn%5D=abc"))
  check("gateway form: bearer auth + parsed json response", !!formReq && (formReq as any).auth === "Bearer sk_test" && formRes.ok && (formRes.data as any).id === "tr_1")

  // Social publisher now egresses through the connector-gateway — verify routing + auth per platform.
  let socReq: { url: string; auth: string; restli: string } | null = null
  globalThis.fetch = (async (url: any, init: any) => {
    socReq = { url: String(url), auth: init?.headers?.Authorization ?? "", restli: init?.headers?.["X-Restli-Protocol-Version"] ?? "" }
    return { ok: true, status: 200, json: async () => ({ id: "post_1" }) }
  }) as unknown as typeof fetch
  const fb = await publishToSocialPlatform("facebook", { content: "hi", accessToken: "FBTOK", accountId: "123" })
  check("social: Facebook routes through gateway to graph.facebook.com w/ access_token query", !!socReq && (socReq as any).url.startsWith("https://graph.facebook.com/v18.0/123/feed") && (socReq as any).url.includes("access_token=FBTOK") && fb.success && fb.externalPostId === "post_1")
  const li = await publishToSocialPlatform("linkedin", { content: "hi", accessToken: "LITOK", accountId: "u1" })
  check("social: LinkedIn uses Bearer + X-Restli header through the gateway", !!socReq && (socReq as any).url === "https://api.linkedin.com/v2/ugcPosts" && (socReq as any).auth === "Bearer LITOK" && (socReq as any).restli === "2.0.0" && li.success)
  globalThis.fetch = (async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "bad page" } }) })) as unknown as typeof fetch
  const fbErr = await publishToSocialPlatform("facebook", { content: "x", accessToken: "T", accountId: "1" })
  check("social: gateway error surfaces provider message (success:false)", !fbErr.success && (fbErr.error ?? "").includes("bad page"))

  // ShowingTime scheduling now egresses through the connector-gateway (was a bespoke fetch).
  // Verify the connector contract: bearer auth, POST /v2/appointments, json appointment body.
  let stReq: { url: string; auth: string; ct: string; body: any } | null = null
  globalThis.fetch = (async (url: any, init: any) => {
    stReq = { url: String(url), auth: init?.headers?.Authorization ?? "", ct: init?.headers?.["Content-Type"] ?? "", body: JSON.parse(init.body) }
    return { ok: true, status: 200, json: async () => ({ id: "appt_42" }) }
  }) as unknown as typeof fetch
  const stRes = await callConnector<{ id?: string }>({
    connector: "showingtime", baseUrl: "https://api.showingtime.com", path: "/v2/appointments", method: "POST",
    auth: { style: "bearer", token: "ST_KEY" },
    body: { property: { address: "123 Main St", city: "Tampa", state: "FL", zip: "33602" }, duration_minutes: 30, buyer_agent_name: "Dana Agent" },
  })
  check("ShowingTime routes through gateway to /v2/appointments", !!stReq && (stReq as any).url === "https://api.showingtime.com/v2/appointments")
  check("ShowingTime uses Bearer auth + json body", !!stReq && (stReq as any).auth === "Bearer ST_KEY" && (stReq as any).ct === "application/json" && (stReq as any).body.property.zip === "33602")
  check("ShowingTime returns appointment id on 200", stRes.ok && stRes.data?.id === "appt_42")
  globalThis.fetch = (async () => ({ ok: false, status: 403, json: async () => ({ message: "partner access required" }) })) as unknown as typeof fetch
  const stErr = await callConnector({ connector: "showingtime", baseUrl: "https://api.showingtime.com", path: "/v2/appointments", method: "POST", auth: { style: "bearer", token: "ST_KEY" }, body: {} })
  check("ShowingTime non-200 → not ok (caller falls back to manual draft)", !stErr.ok && stErr.status === 403)

  // Gateway: response headers are exposed (SendGrid x-message-id / resumable Location live in headers).
  globalThis.fetch = (async () => ({
    ok: true, status: 202,
    headers: { forEach: (cb: any) => { cb("msg_abc", "X-Message-Id"); cb("https://up.example/loc", "Location") }, get: () => null },
    json: async () => ({}),
  })) as unknown as typeof fetch
  const hdrRes = await callConnector({ connector: "sendgrid", baseUrl: "https://api.sendgrid.com", path: "/v3/mail/send", method: "POST", auth: { style: "bearer", token: "K" }, body: {} })
  check("gateway exposes response headers (lowercased)", hdrRes.headers["x-message-id"] === "msg_abc" && hdrRes.headers["location"] === "https://up.example/loc")

  // Gateway: absolute-url override bypasses baseUrl/path (asset downloads + resumable upload URLs).
  let overrideUrl = ""
  globalThis.fetch = (async (url: any) => {
    overrideUrl = String(url)
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("BYTES").buffer }
  }) as unknown as typeof fetch
  const ovRes = await callConnector<Buffer>({ connector: "asset-download", baseUrl: "", path: "", url: "https://cdn.example/signed/img.png?sig=abc", method: "GET", auth: { style: "none" }, responseType: "arraybuffer" })
  check("gateway url override hits the exact absolute URL", overrideUrl === "https://cdn.example/signed/img.png?sig=abc")
  check("gateway url override returns bytes", ovRes.ok && Buffer.isBuffer(ovRes.data) && ovRes.data!.toString() === "BYTES")

  // Gateway: binary body passes the Buffer through unmodified + keeps caller Content-Type.
  let binReq: { body: any; ct: string } | null = null
  globalThis.fetch = (async (_url: any, init: any) => {
    binReq = { body: init?.body, ct: init?.headers?.["Content-Type"] ?? "" }
    return { ok: true, status: 200, json: async () => ({ id: "v1" }) }
  }) as unknown as typeof fetch
  const buf = Buffer.from("VIDEOBYTES")
  const binRes = await callConnector<{ id?: string }>({ connector: "youtube", baseUrl: "", path: "", url: "https://up.example/loc", method: "PUT", auth: { style: "none" }, headers: { "Content-Type": "video/*" }, body: buf, bodyType: "binary" })
  check("gateway binary body passes the Buffer through (not JSON-stringified)", !!binReq && Buffer.isBuffer((binReq as any).body) && (binReq as any).body.toString() === "VIDEOBYTES")
  check("gateway binary keeps caller Content-Type (not application/json)", !!binReq && (binReq as any).ct === "video/*" && binRes.ok)

  // Podcast syndication (Transistor) — create episode then publish, x-api-key header, form body.
  let txReqs: Array<{ url: string; key: string; ct: string; body: string }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    txReqs.push({ url: String(url), key: init?.headers?.["x-api-key"] ?? "", ct: init?.headers?.["Content-Type"] ?? "", body: String(init?.body ?? "") })
    const isPublish = String(url).endsWith("/publish")
    return { ok: true, status: 200, json: async () => isPublish ? ({ data: { attributes: { share_url: "https://share.transistor.fm/e/abc" } } }) : ({ data: { id: "ep_99" } }) }
  }) as unknown as typeof fetch
  const txCreate = await callConnector<{ data?: { id?: string } }>({
    connector: "transistor", baseUrl: "https://api.transistor.fm", path: "/v1/episodes", method: "POST",
    auth: { style: "header", name: "x-api-key", value: "TX_KEY" }, bodyType: "form",
    body: { "episode[show_id]": "show_1", "episode[title]": "Market Update", "episode[summary]": "s", "episode[audio_url]": "https://cdn/x.mp3" },
  })
  check("Transistor create → /v1/episodes with x-api-key + form body (bracket keys)", txReqs[0]?.url === "https://api.transistor.fm/v1/episodes" && txReqs[0]?.key === "TX_KEY" && txReqs[0]?.ct === "application/x-www-form-urlencoded" && txReqs[0]?.body.includes("episode%5Bshow_id%5D=show_1") && txCreate.data?.data?.id === "ep_99")
  const txPub = await callConnector<{ data?: { attributes?: { share_url?: string } } }>({
    connector: "transistor", baseUrl: "https://api.transistor.fm", path: "/v1/episodes/ep_99/publish", method: "PATCH",
    auth: { style: "header", name: "x-api-key", value: "TX_KEY" }, bodyType: "form", body: { "episode[status]": "published" },
  })
  check("Transistor publish → PATCH /publish returns share_url", txReqs[1]?.url.endsWith("/v1/episodes/ep_99/publish") && txPub.data?.data?.attributes?.share_url === "https://share.transistor.fm/e/abc")
  globalThis.fetch = (async () => ({ ok: false, status: 422, json: async () => ({ errors: [{ title: "show not found" }] }) })) as unknown as typeof fetch
  const txErr = await callConnector({ connector: "transistor", baseUrl: "https://api.transistor.fm", path: "/v1/episodes", method: "POST", auth: { style: "header", name: "x-api-key", value: "K" }, bodyType: "form", body: {} })
  check("Transistor non-2xx → not ok (caller marks distribution failed)", !txErr.ok && txErr.status === 422)

  globalThis.fetch = realFetch
}

// ── 8c. Unified vendor-spend gateway (meterVendorSpend) ──────────────────────
async function testVendorGateway() {
  console.log("\n[Unified vendor-spend gateway — meterVendorSpend]")
  // scraper_type → canonical vendor mapping (the ledger's vendor_name).
  check("zillow_behavior → zenrows", scraperTypeToVendor("zillow_behavior") === "zenrows")
  check("batchdata_motivated → batchdata", scraperTypeToVendor("batchdata_motivated") === "batchdata")
  check("social_intent → apify_social", scraperTypeToVendor("social_intent") === "apify_social")
  check("osint_signal → osint", scraperTypeToVendor("osint_signal") === "osint")

  // Captured logger records exactly what the gateway forwards.
  const calls: any[] = []
  const logger = async (e: any) => {
    calls.push(e)
    return { success: true }
  }

  const recorded = await meterVendorSpend(
    { vendorName: "tavily", usageType: "social_scrape", cost: 0.05, brokerageId: "b1", metadata: { market_id: "m1" } },
    { logger },
  )
  check("records spend when cost>0 + brokerageId", recorded === true && calls.length === 1)
  check("forwards estimatedCost + vendor + brokerage", calls[0]?.estimatedCost === 0.05 && calls[0]?.vendorName === "tavily" && calls[0]?.brokerageId === "b1")
  check("defaults systemSource to lead_scraping", calls[0]?.systemSource === "lead_scraping")

  // No-op guards (no ledger pollution).
  const zeroCost = await meterVendorSpend({ vendorName: "exa", usageType: "x", cost: 0, brokerageId: "b1" }, { logger })
  check("skips zero-cost calls", zeroCost === false && calls.length === 1)
  const noBrokerage = await meterVendorSpend({ vendorName: "exa", usageType: "x", cost: 0.1, brokerageId: null }, { logger })
  check("skips calls with no brokerage", noBrokerage === false && calls.length === 1)

  // Never throws even if the logger blows up.
  const boom = async () => { throw new Error("ledger down") }
  const safe = await meterVendorSpend({ vendorName: "zenrows", usageType: "x", cost: 0.2, brokerageId: "b1" }, { logger: boom as any })
  check("never throws when ledger fails", safe === false)

  // Platform-controlled AI vendors (D-ID, HeyGen, ElevenLabs, Vapi) cost catalog.
  check("did + heygen are per-video, elevenlabs per-char, vapi per-minute",
    PLATFORM_VENDOR_RATES.did.unit === "video" && PLATFORM_VENDOR_RATES.heygen.unit === "video" &&
    PLATFORM_VENDOR_RATES.elevenlabs.unit === "character" && PLATFORM_VENDOR_RATES.vapi.unit === "minute")
  check("D-ID 1 video → $0.10", estimatePlatformVendorCost("did", 1) === 0.10)
  check("HeyGen 1 video → $0.50", estimatePlatformVendorCost("heygen", 1) === 0.50)
  check("ElevenLabs 1000 chars → $0.18", estimatePlatformVendorCost("elevenlabs", 1000) === 0.18)
  check("Vapi 5 minutes → $0.35", estimatePlatformVendorCost("vapi", 5) === 0.35)
  check("zero/negative units → $0 (no charge)", estimatePlatformVendorCost("did", 0) === 0 && estimatePlatformVendorCost("vapi", -3) === 0)

  // End-to-end: a metered D-ID render lands in the ledger via the gateway.
  const aiCalls: any[] = []
  const aiLogger = async (e: any) => { aiCalls.push(e); return { success: true } }
  await meterVendorSpend(
    { vendorName: "did", usageType: "video_render", cost: estimatePlatformVendorCost("did", 1), brokerageId: "b1", systemSource: "video_generation" },
    { logger: aiLogger },
  )
  check("D-ID render recorded to ledger (vendor=did, cost=0.10)", aiCalls.length === 1 && aiCalls[0].vendorName === "did" && aiCalls[0].estimatedCost === 0.10)

  // ── Vendor budget gate (the cap that closes the metering→enforcement loop) ──
  check("tier budgets ascend solo<team<brokerage<multi", MONTHLY_VENDOR_BUDGET_USD.solo_agent < MONTHLY_VENDOR_BUDGET_USD.team && MONTHLY_VENDOR_BUDGET_USD.team < MONTHLY_VENDOR_BUDGET_USD.brokerage && MONTHLY_VENDOR_BUDGET_USD.brokerage < MONTHLY_VENDOR_BUDGET_USD.multi_location)
  check("unknown tier → solo default budget", vendorBudgetForTier("nope") === MONTHLY_VENDOR_BUDGET_USD.solo_agent)
  check("under budget → allowed, no warning", (() => { const r = evaluateVendorBudget(10, 50, 0.5); return r.allowed && !r.softWarning })())
  check("at 80% → soft warning (still allowed)", (() => { const r = evaluateVendorBudget(40, 50); return r.allowed && r.softWarning && r.percent === 80 })())
  check("projected over ceiling → BLOCKED", (() => { const r = evaluateVendorBudget(49.8, 50, 0.5); return r.allowed === false })())
  check("exactly at ceiling → allowed (boundary)", evaluateVendorBudget(49.5, 50, 0.5).allowed === true)
  check("zero/invalid budget falls back to default ceiling", evaluateVendorBudget(0, 0, 1).budget === MONTHLY_VENDOR_BUDGET_USD.solo_agent)

  // ── Role-scoped visibility (PRIVACY: brokerages never see vendor names/$) ───
  check("support is platform staff", isPlatformStaff("support"))
  check("superadmin is platform staff", isPlatformStaff("superadmin"))
  check("broker is NOT platform staff", !isPlatformStaff("broker"))
  check("agent is NOT platform staff", !isPlatformStaff("agent"))

  check("budgetLevel ok/approaching/paused", budgetLevel({ allowed: true, softWarning: false }) === "ok" && budgetLevel({ allowed: true, softWarning: true }) === "approaching" && budgetLevel({ allowed: false, softWarning: false }) === "paused")

  const evalApproaching = evaluateVendorBudget(45, 50) // 90% → softWarning
  const evalBlocked = evaluateVendorBudget(60, 50)

  // Platform staff: full detail incl. vendor names.
  const staffView = redactBudgetForActor(evalApproaching, { isPlatformStaff: true, showBrokerageWarning: false, vendors: [{ vendor: "did", spent: 30 }, { vendor: "vapi", spent: 15 }] })
  check("platform view exposes spend + vendor names", staffView.scope === "platform" && (staffView as any).spent === 45 && (staffView as any).vendors?.[0]?.vendor === "did")

  // Brokerage: NO spend, NO budget, NO percent, NO vendor names — level only.
  const brokView = redactBudgetForActor(evalApproaching, { isPlatformStaff: false, showBrokerageWarning: true, vendors: [{ vendor: "did", spent: 30 }] })
  check("brokerage view is level-only (no $/vendors)", brokView.scope === "brokerage" && !("spent" in brokView) && !("budget" in brokView) && !("vendors" in brokView) && !("percent" in brokView))
  check("brokerage warning shows when toggle ON + approaching", (brokView as any).showWarning === true && brokView.level === "approaching")

  // Superadmin toggle OFF → brokerage sees no warning even when approaching.
  const brokHidden = redactBudgetForActor(evalApproaching, { isPlatformStaff: false, showBrokerageWarning: false })
  check("brokerage warning hidden when superadmin toggle OFF", brokHidden.scope === "brokerage" && (brokHidden as any).showWarning === false)

  // Even blocked, brokerage only sees level (paused) — never the numbers.
  const brokBlocked = redactBudgetForActor(evalBlocked, { isPlatformStaff: false, showBrokerageWarning: true })
  check("brokerage blocked → level 'paused', still no $", brokBlocked.level === "paused" && !("spent" in brokBlocked))

  // ── Support-console overview aggregation (multi-tier: solo / team / brokerage) ──
  const overview = aggregateBrokerageSpend(
    [
      { brokerage_id: "solo1", estimated_cost: 48 },   // near solo $50 ceiling
      { brokerage_id: "solo1", estimated_cost: 3 },     // → 51 over → paused
      { brokerage_id: "team1", estimated_cost: 170 },   // 85% of team $200 → approaching
      { brokerage_id: "brok1", estimated_cost: 100 },   // well under brokerage $750 → ok
    ],
    [
      { id: "solo1", name: "Solo Co", plan_tier: "solo_agent" },
      { id: "team1", name: "Team Co", plan_tier: "team" },
      { id: "brok1", name: "Brokerage Co", plan_tier: "brokerage" },
    ],
  )
  const byId = Object.fromEntries(overview.map((r) => [r.brokerageId, r]))
  check("overview sums per brokerage (solo1 = 51)", byId.solo1.spent === 51)
  check("solo over $50 ceiling → paused", byId.solo1.level === "paused" && byId.solo1.budget === 50)
  check("team at 85% of $200 → approaching", byId.team1.level === "approaching" && byId.team1.budget === 200)
  check("brokerage under $750 → ok", byId.brok1.level === "ok" && byId.brok1.budget === 750)
  check("overview sorted closest-to-limit first", overview[0].brokerageId === "solo1")

  // ── Downgrade ladder (cap throttles cost, not capability) ───────────────────
  // Under budget → everything allowed.
  check("under budget → allow (rentcast)", resolveVendorAction("rentcast", false) === "allow")
  check("under budget → allow (did)", resolveVendorAction("did", false) === "allow")
  // Over budget → degrade where a free path exists, block where none does.
  check("over budget: rentcast DEGRADES (free Perplexity/OSINT AVM)", resolveVendorAction("rentcast", true) === "degrade")
  check("over budget: elevenlabs DEGRADES (browser TTS)", resolveVendorAction("elevenlabs", true) === "degrade")
  check("over budget: D-ID BLOCKS (no free video)", resolveVendorAction("did", true) === "block")
  check("over budget: HeyGen BLOCKS (no free video)", resolveVendorAction("heygen", true) === "block")
  check("over budget: Vapi BLOCKS (reroute to cheaper channel upstream)", resolveVendorAction("vapi", true) === "block")
  check("over budget: unknown vendor BLOCKS (conservative)", resolveVendorAction("mystery", true) === "block")
  check("free alternative names exposed", freeAlternativeFor("rentcast") === "perplexity_osint_avm" && freeAlternativeFor("elevenlabs") === "browser_tts" && freeAlternativeFor("did") === null)

  // ── AI-API agent: vendor-capability registry + budget-aware selection ───────
  // Every capability carries context (purpose + inputs) and providers in priority order.
  const caps = Object.keys(VENDOR_CAPABILITY_REGISTRY)
  check("registry covers core capabilities", caps.includes("property_valuation") && caps.includes("buyer_seller_intent") && caps.includes("voice_call") && caps.includes("video_render"))
  for (const [k, def] of Object.entries(VENDOR_CAPABILITY_REGISTRY)) {
    check(`capability '${k}' has context (purpose+inputs+providers)`, def.purpose.length > 0 && def.inputs.length > 0 && def.providers.length > 0)
  }
  check("getVendorCapability returns the def", getVendorCapability("property_valuation").domain === "valuation")

  // Under budget → primary provider, allow.
  check("valuation under budget → primary (perplexity, allow)", (() => { const s = selectProvider("property_valuation", { overBudget: false }); return s.provider === "perplexity" && s.action === "allow" })())

  // Over budget, capability with a PAID primary + a FREE tier → degrade to free.
  // (market_stats: rentcast paid primary, osint free) and skip-trace (peopledata paid, perplexity free).
  check("market_stats over budget → degrade to free (osint)", (() => { const s = selectProvider("market_stats", { overBudget: true }); return s.usingFreeFallback && s.action === "degrade" && s.tier === "free" })())
  check("skip_trace over budget → degrade to free (perplexity)", (() => { const s = selectProvider("lead_skip_trace", { overBudget: true }); return s.provider === "perplexity" && s.action === "degrade" })())

  // Over budget, capability whose primary is already FREE → still allowed (no spend).
  check("valuation over budget → still free primary, allow", (() => { const s = selectProvider("property_valuation", { overBudget: true }); return s.tier === "free" && s.action === "allow" })())

  // Over budget, NO free path (video_render: did/heygen both paid) → block.
  check("video_render over budget → BLOCK (no free render)", (() => { const s = selectProvider("video_render", { overBudget: true }); return s.action === "block" && !s.usingFreeFallback })())
  check("voice_call over budget → BLOCK (no free voice)", selectProvider("voice_call", { overBudget: true }).action === "block")

  // ── Agentic API layer (agenticapi.com): manifest, AGIS verbs, scopes ────────
  const manifest = buildActionManifest()
  check("manifest covers every capability", manifest.length === Object.keys(VENDOR_CAPABILITY_REGISTRY).length)
  check("every action uses a valid AGIS verb", manifest.every((a) => (AGIS_VERBS as readonly string[]).includes(a.verb)))
  check("every action has scope + inputs + purpose", manifest.every((a) => a.scope.includes(":") && a.inputs.length > 0 && a.purpose.length > 0))
  check("manifest is VENDOR-ANONYMOUS (no provider/vendor fields leak)", manifest.every((a) => !("providers" in a) && !("vendor" in a) && !JSON.stringify(a).includes("rentcast") && !JSON.stringify(a).includes("perplexity")))
  check("manifest sorted by intentWeight desc (voice_call first)", manifest[0].capability === "voice_call")
  check("action id = 'VERB capability'", manifest.find((a) => a.capability === "property_valuation")?.action === "ANALYZE property_valuation")
  check("requiredScope maps capability→scope", requiredScope("video_render") === "marketing:video" && requiredScope("lead_skip_trace") === "lead:enrich")

  // Scope matching: exact, wildcard domain, and global *.
  check("exact scope grants access", hasScope(["valuation:read"], "valuation:read"))
  check("domain wildcard grants access", hasScope(["valuation:*"], "valuation:read"))
  check("global * grants all", hasScope([ALL_SCOPES], "comms:voice"))
  check("missing scope denies", !hasScope(["market:read"], "comms:voice"))
  check("empty grants deny", !hasScope([], "valuation:read") && !hasScope(undefined, "valuation:read"))
  check("authorizedActions filters by scope", authorizedActions(manifest, ["valuation:read"]).every((a) => a.scope === "valuation:read") && authorizedActions(manifest, [ALL_SCOPES]).length === manifest.length)

  // ── Agentic API INVOKE planner (discover→describe→invoke loop) ──────────────
  check("parseInputSpec marks required vs optional", (() => { const s = parseInputSpec(["address", "zipCode?"]); return s[0].name === "address" && s[0].required && s[1].name === "zipCode" && !s[1].required })())

  const ALL = [ALL_SCOPES]
  // No scope → unauthorized (gate 1, before anything else).
  check("no scope → unauthorized", planInvocation("property_valuation", { inputs: { address: "1 Main" }, grantedScopes: [], overBudget: false }).decision === "unauthorized")
  // Missing required input → invalid_input with the missing field listed.
  check("missing required input → invalid_input", (() => { const p = planInvocation("property_valuation", { inputs: {}, grantedScopes: ALL, overBudget: false }); return p.decision === "invalid_input" && p.missingInputs.includes("address") })())
  // Read action, scoped, inputs present, under budget → execute.
  check("read action authorized + inputs → execute", planInvocation("web_research", { inputs: { query: "Tampa market" }, grantedScopes: ALL, overBudget: false }).decision === "execute")
  // ANALYZE valuation → execute (read verb, weight 0.8 < threshold).
  check("ANALYZE valuation → execute", planInvocation("property_valuation", { inputs: { address: "1 Main" }, grantedScopes: ALL, overBudget: false }).decision === "execute")
  // Side-effecting verbs require confirmation (never auto-fire).
  check("NOTIFY voice_call → requires_confirmation", planInvocation("voice_call", { inputs: { phoneNumber: "555", brokerageId: "b1", assistantConfig: {} }, grantedScopes: ALL, overBudget: false }).decision === "requires_confirmation")
  check("RENDER video_render → requires_confirmation", planInvocation("video_render", { inputs: { script: "hi", brokerageId: "b1", "avatar/voice assets": {} }, grantedScopes: ALL, overBudget: false }).decision === "requires_confirmation")
  // High-weight FIND (lead sourcing) → requires_confirmation even though it's a read verb.
  check("FIND buyer_seller_intent (weight .9) → requires_confirmation", planInvocation("buyer_seller_intent", { inputs: { city: "Tampa", state: "FL" }, grantedScopes: ALL, overBudget: false }).decision === "requires_confirmation")
  // Over budget, capability with NO free path → blocked.
  check("over budget + no free path → blocked", planInvocation("video_render", { inputs: { script: "hi", brokerageId: "b1", "avatar/voice assets": {} }, grantedScopes: ALL, overBudget: true }).selection.action === "block")
  // Over budget, read capability WITH free tier → still executes (degraded), not blocked.
  check("over budget read w/ free tier → execute (degraded)", (() => { const p = planInvocation("market_stats", { inputs: { zipCode: "33602" }, grantedScopes: ALL, overBudget: true }); return p.decision === "execute" && p.selection.usingFreeFallback })())

  // ── Agent credentials (tokens + scopes) ────────────────────────────────────
  const tok = generateAgentToken()
  check("generated token has vos_ prefix", tok.startsWith("vos_"))
  check("token hash is deterministic sha256 hex (64 chars)", hashAgentToken(tok) === hashAgentToken(tok) && /^[0-9a-f]{64}$/.test(hashAgentToken(tok)))
  check("different tokens → different hashes", hashAgentToken(generateAgentToken()) !== hashAgentToken(generateAgentToken()))
  check("extractBearerToken parses 'Bearer vos_...'", extractBearerToken(`Bearer ${tok}`) === tok)
  check("extractBearerToken rejects non-vos / missing", extractBearerToken("Bearer abc123") === null && extractBearerToken(null) === null && extractBearerToken("Basic xxx") === null)

  // ── App-capability expansion + unified manifest ─────────────────────────────
  const appManifest = buildAppActionManifest()
  check("app registry covers kernel ops", Object.keys(APP_CAPABILITY_REGISTRY).length >= 8 && !!APP_CAPABILITY_REGISTRY.lead_search && !!APP_CAPABILITY_REGISTRY.transaction_advance)
  check("app actions are scope-tagged + verb'd", appManifest.every((a) => a.scope.includes(":") && a.verb.length > 0 && a.kind === "app"))
  check("read app caps not mutating; write app caps mutating", APP_CAPABILITY_REGISTRY.lead_search.mutates === false && APP_CAPABILITY_REGISTRY.listing_publish.mutates === true && APP_CAPABILITY_REGISTRY.transaction_advance.mutates === true)
  const connectedManifest = buildConnectedActionManifest()
  const full = buildFullActionManifest()
  check("unified manifest merges vendor + app + connected", full.some((a) => a.kind === "vendor") && full.some((a) => a.kind === "app") && full.some((a) => a.kind === "connected") && full.length === manifest.length + appManifest.length + connectedManifest.length)
  check("unified manifest stays VENDOR-ANONYMOUS", !JSON.stringify(full).includes("rentcast") && !JSON.stringify(full).includes("perplexity") && !JSON.stringify(full).includes("vapi"))
  check("unified manifest sorted by intentWeight desc", full.every((a, i) => i === 0 || full[i - 1].intentWeight >= a.intentWeight))
  check("listing_publish (PUBLISH) is highest-weight write", full[0].mutates === true)

  // MCP read-executor extension: the auto-runnable read tools must all be real, non-mutating
  // capabilities present in the unified manifest (the MCP route only auto-fires reads).
  const MCP_READ_CAPS = ["web_research", "property_valuation", "comparable_sales", "market_stats", "lead_skip_trace", "connectivity_scan"]
  check("MCP read executors map to manifest capabilities that exist", MCP_READ_CAPS.every((c) => full.some((a) => a.capability === c)))
  check("MCP read executors are all NON-mutating (mutations stay gated over MCP)", MCP_READ_CAPS.every((c) => full.find((a) => a.capability === c)?.mutates === false))
  check("MCP new reads carry the expected scopes", requiredScope("comparable_sales") === "valuation:read" && requiredScope("market_stats") === "market:read" && requiredScope("lead_skip_trace") === "lead:enrich" && APP_CAPABILITY_REGISTRY.connectivity_scan.scope === "connectivity:read")

  // ── Kernel event reactor (Phase 1) — pure trigger matching + cooldown ────────
  const trig = (over: Partial<LifecycleTrigger>): LifecycleTrigger => ({ id: "t1", brokerage_id: "b1", campaign_id: "c1", trigger_value: "offer_accepted", channel: "email", cooldown_days: 7, audience_filter: {}, ...over })
  const triggerSet: LifecycleTrigger[] = [
    trig({ id: "t1", trigger_value: "offer_accepted", brokerage_id: "b1" }),
    trig({ id: "t2", trigger_value: "deal_closed",    brokerage_id: "b1" }),
    trig({ id: "t3", trigger_value: "offer_accepted", brokerage_id: "b2" }), // other brokerage
  ]
  check("reactor: matchTriggersForEvent matches on event_type + brokerage (tenant-isolated)", (() => {
    const m = matchTriggersForEvent(triggerSet, "offer_accepted", "b1")
    return m.length === 1 && m[0].id === "t1"
  })())
  check("reactor: no cross-brokerage trigger leak", matchTriggersForEvent(triggerSet, "offer_accepted", "b1").every(t => t.brokerage_id === "b1"))
  check("reactor: unmatched event yields no triggers", matchTriggersForEvent(triggerSet, "listing_created", "b1").length === 0)
  const now = Date.parse("2026-01-10T00:00:00Z")
  check("reactor: cooldown active inside window (idempotent re-fire is skipped)", isCooldownActive("2026-01-08T00:00:00Z", 7, now) === true)
  check("reactor: cooldown expired outside window", isCooldownActive("2025-12-20T00:00:00Z", 7, now) === false)
  check("reactor: no prior touchpoint → never in cooldown", isCooldownActive(null, 7, now) === false)
  check("reactor: cooldown_days<=0 → never throttle (re-enroll allowed)", isCooldownActive("2026-01-09T23:59:00Z", 0, now) === false)

  // ── Workflow chain-run idempotency (protects flagship CMA/video/drip chains) ──
  const runs: ExistingRun[] = [
    { id: "r1", status: "done",    trigger_event_id: "evt-A" },
    { id: "r2", status: "running", trigger_event_id: "evt-B" },
  ]
  check("dedupe: same source event reuses its run (exact idempotency, even if done)", findReusableRun(runs, "evt-A")?.id === "r1")
  check("dedupe: an active run blocks a concurrent duplicate", findReusableRun(runs, "evt-C")?.id === "r2")
  check("dedupe: a brand-new occurrence with no active run starts fresh (null)", findReusableRun([{ id: "r3", status: "done", trigger_event_id: "evt-X" }], "evt-NEW") === null)
  check("dedupe: no triggerEventId + no active run → fresh", findReusableRun([{ id: "r4", status: "failed", trigger_event_id: null }], null) === null)

  // Expansive-domain coverage (marketing / social / reporting / education / portal / etc.).
  const appDomains = new Set(appManifest.map((a) => a.category))
  check("app registry now spans expansive domains", ["marketing", "social", "reporting", "education", "portal", "reputation", "communications"].every((d) => appDomains.has(d)))
  check("newsletter_send is NOTIFY + marketing:send + mutating", APP_CAPABILITY_REGISTRY.newsletter_send.verb === "NOTIFY" && APP_CAPABILITY_REGISTRY.newsletter_send.scope === "marketing:send" && APP_CAPABILITY_REGISTRY.newsletter_send.mutates === true)
  check("report_generate is read (ANALYZE, not mutating)", APP_CAPABILITY_REGISTRY.report_generate.verb === "ANALYZE" && APP_CAPABILITY_REGISTRY.report_generate.mutates === false)
  check("every app action has a domain-scoped scope (domain:verb form)", appManifest.every((a) => /^[a-z_]+:[a-z_]+$/.test(a.scope)))
  check("unified manifest grew to cover whole app (>=18 actions)", full.length >= 18)

  // Newly-added marketing/comms/gifting capabilities (podcast / direct mail / video / gifts / notes).
  check("podcast/direct-mail/video/gift/note capabilities registered", ["podcast_publish", "direct_mail_send", "video_distribute", "gift_send", "handwritten_note_send"].every((c) => !!(APP_CAPABILITY_REGISTRY as any)[c]))
  check("all new send/publish actions are mutating (confirmation-gated)", ["podcast_publish", "direct_mail_send", "video_distribute", "gift_send", "handwritten_note_send"].every((c) => (APP_CAPABILITY_REGISTRY as any)[c].mutates === true))
  check("gifting domain present + scoped", APP_CAPABILITY_REGISTRY.gift_send.domain === "gifting" && APP_CAPABILITY_REGISTRY.gift_send.scope === "gifting:write" && APP_CAPABILITY_REGISTRY.handwritten_note_send.scope === "gifting:write")
  check("direct_mail_send uses marketing:send (NOTIFY)", APP_CAPABILITY_REGISTRY.direct_mail_send.scope === "marketing:send" && APP_CAPABILITY_REGISTRY.direct_mail_send.verb === "NOTIFY")

  // ── Vendor ownership: platform-owned (budget-gated) vs user-connected (connection-gated) ──
  check("lob is classified PLATFORM-owned", isPlatformVendor("lob") && vendorOwnership("lob") === "platform")
  check("financial vendors (stripe/quickbooks) are PLATFORM-operated (offered to all subscribers)", ["stripe", "quickbooks", "plaid"].every((v) => isPlatformVendor(v)))
  check("CRM sync-out vendors (ghl/lofty/followupboss) are USER-CONNECTED", ["gohighlevel", "lofty", "followupboss"].every((v) => isUserConnectedVendor(v)))
  check("comms/idx/social/calendar/podcast/showing/txn vendors are USER-CONNECTED", ["sendgrid", "twilio", "idxbroker", "meta", "nylas", "podcast_syndicator", "showingtime", "dotloop"].every((v) => isUserConnectedVendor(v)))
  check("scraper/AVM/voice/video vendors stay PLATFORM-owned", ["rentcast", "perplexity", "vapi", "did", "heygen", "batchdata", "peopledata"].every((v) => isPlatformVendor(v)))
  check("platform & user-connected vendor sets are disjoint", [...PLATFORM_VENDORS].every((v) => !USER_CONNECTED_VENDORS.has(v)))
  check("lob metered as a platform vendor (per-piece rate)", PLATFORM_VENDOR_RATES.lob.unit === "piece" && estimatePlatformVendorCost("lob", 100) > 0)
  check("lob over-budget hard-blocks (no free direct-mail alt)", freeAlternativeFor("lob") === null && resolveVendorAction("lob", true) === "block")

  // ── Connected-vendor capability registry + manifest ─────────────────────────
  check("connected registry covers the user-connected surface (>=11)", Object.keys(CONNECTED_CAPABILITY_REGISTRY).length >= 11)
  check("payments/accounting are NOT user-connected (platform-operated app capabilities)", !isConnectedCapability("payment_transfer") && !isConnectedCapability("accounting_sync") && APP_CAPABILITY_REGISTRY.payment_transfer?.domain === "finance" && APP_CAPABILITY_REGISTRY.accounting_sync?.domain === "finance")
  check("crm_contact_sync is sync-OUT to ghl/lofty/followupboss", CONNECTED_CAPABILITY_REGISTRY.crm_contact_sync.verb === "UPDATE" && ["gohighlevel", "lofty", "followupboss"].every((p) => CONNECTED_CAPABILITY_REGISTRY.crm_contact_sync.connections.includes(p)))
  check("connected manifest tagged ownership=user_connected + kind=connected", connectedManifest.every((a) => a.ownership === "user_connected" && a.kind === "connected"))
  check("every app/vendor action tagged ownership=platform", appManifest.every((a) => a.ownership === "platform") && full.filter((a) => a.kind !== "connected").every((a) => a.ownership === "platform"))
  check("connected actions carry their connection provider list", connectedManifest.every((a) => Array.isArray(a.connections) && a.connections!.length > 0))
  check("crm/idx/email/phone/calendar/social/txn/esign/showing/podcast all present", ["crm_contact_sync", "idx_listing_search", "email_send", "sms_send", "phone_call_place", "calendar_event_book", "social_account_publish", "transaction_forms_open", "esign_send", "showing_schedule", "podcast_syndicate"].every((c) => isConnectedCapability(c)))
  check("esign_send maps to real esign providers", CONNECTED_CAPABILITY_REGISTRY.esign_send.connections.includes("docusign") && CONNECTED_CAPABILITY_REGISTRY.esign_send.connections.includes("dotloop"))

  // Connection-gate planner: scope → inputs → CONNECTION presence → confirmation.
  check("connected plan: missing scope → unauthorized", planConnectedInvocation("email_send", { inputs: { to: "x", subject: "s", body: "b" }, grantedScopes: ["lead:read"], connected: true }).decision === "unauthorized")
  check("connected plan: missing inputs → invalid_input", planConnectedInvocation("email_send", { inputs: {}, grantedScopes: [ALL_SCOPES], connected: true }).decision === "invalid_input")
  check("connected plan: not connected → not_connected (with providers to connect)", (() => { const p = planConnectedInvocation("crm_contact_sync", { inputs: { contactId: "c1" }, grantedScopes: [ALL_SCOPES], connected: false }); return p.decision === "not_connected" && p.missingConnections.includes("followupboss") })())
  check("connected plan: authorized + connected write → requires_confirmation", planConnectedInvocation("crm_contact_sync", { inputs: { contactId: "c1" }, grantedScopes: [ALL_SCOPES], connected: true }).decision === "requires_confirmation")
  check("connected plan: authorized + connected read → execute", planConnectedInvocation("calendar_availability_get", { inputs: { from: "a", to: "b" }, grantedScopes: [ALL_SCOPES], connected: true }).decision === "execute")

  // ── Connectivity API Agent (keeps up with api/oauth/mcp connection health) ──
  const NOW = new Date("2026-05-26T00:00:00Z")
  const soon = new Date(NOW.getTime() + 3 * 86_400_000).toISOString()  // 3 days out (< 7d)
  const later = new Date(NOW.getTime() + 30 * 86_400_000).toISOString() // 30 days out
  const past = new Date(NOW.getTime() - 86_400_000).toISOString()       // yesterday
  check("connectivity: api_key connected when active", deriveConnectivityStatus({ connected: true, transport: "api_key", isActive: true }, NOW) === "connected")
  check("connectivity: inactive credential → disconnected", deriveConnectivityStatus({ connected: true, transport: "api_key", isActive: false }, NOW) === "disconnected")
  check("connectivity: no credential → disconnected", deriveConnectivityStatus({ connected: false, transport: "oauth" }, NOW) === "disconnected")
  check("connectivity: oauth lapsed → expired", deriveConnectivityStatus({ connected: true, transport: "oauth", isActive: true, tokenExpiresAt: past }, NOW) === "expired")
  check("connectivity: oauth within warning window → expiring_soon", deriveConnectivityStatus({ connected: true, transport: "oauth", isActive: true, tokenExpiresAt: soon }, NOW) === "expiring_soon")
  check("connectivity: oauth far out → connected", deriveConnectivityStatus({ connected: true, transport: "oauth", isActive: true, tokenExpiresAt: later }, NOW) === "connected")
  check("connectivity: platform_managed always platform_managed", deriveConnectivityStatus({ connected: false, transport: "platform_managed" }, NOW) === "platform_managed")
  check("connectivity: 7-day warning window constant", EXPIRY_WARNING_DAYS === 7)
  check("connectivity: transportFor classifies oauth vs api_key", transportFor("gohighlevel") === "oauth" && transportFor("nylas") === "oauth" && transportFor("idxbroker") === "api_key" && transportFor("twilio") === "api_key" && transportFor("followupboss") === "api_key")
  check("connectivity: expired/expiring need attention; connected does not", needsAttention("expired") && needsAttention("expiring_soon") && !needsAttention("connected") && !needsAttention("disconnected"))
  const fleet: ConnectorHealth[] = [
    { provider: "idxbroker", transport: "api_key", status: "connected", expiresAt: null, source: "integration_credentials", actionRequired: false },
    { provider: "nylas", transport: "oauth", status: "expiring_soon", expiresAt: soon, source: "platform_credentials", actionRequired: true },
    { provider: "quickbooks", transport: "oauth", status: "expired", expiresAt: past, source: "agent_api_credentials", actionRequired: true },
    { provider: "twilio", transport: "api_key", status: "disconnected", expiresAt: null, source: null, actionRequired: false },
    { provider: "rentcast", transport: "platform_managed", status: "platform_managed", expiresAt: null, source: null, actionRequired: false },
  ]
  const sum = summarizeConnectivity(fleet)
  check("connectivity summary counts by status", sum.total === 5 && sum.connected === 1 && sum.expiringSoon === 1 && sum.expired === 1 && sum.disconnected === 1 && sum.platformManaged === 1)
  check("connectivity summary surfaces attention list (expired+expiring)", sum.attention.length === 2 && sum.attention.includes("quickbooks") && sum.attention.includes("nylas"))
  check("connectivity_scan registered as a discoverable read capability", APP_CAPABILITY_REGISTRY.connectivity_scan?.verb === "GET" && APP_CAPABILITY_REGISTRY.connectivity_scan.scope === "connectivity:read" && APP_CAPABILITY_REGISTRY.connectivity_scan.mutates === false && APP_CAPABILITY_REGISTRY.connectivity_scan.domain === "connectivity")

  // ── Adaptive connector: shape inference + self-healing field drift ──────────
  check("infer oauth from token fields", inferTransport({ accessToken: "x", refreshToken: "y", tokenExpiresAt: "2026-06-01T00:00:00Z" }) === "oauth")
  check("infer api_key from apiKey", inferTransport({ apiKey: "k" }) === "api_key")
  check("infer mcp from mcpUrl", inferTransport({ mcpUrl: "https://mcp.example.com" }) === "mcp")
  check("oauth missing accessToken is incomplete", (() => { const a = assessShape({ refreshToken: "r" }, "oauth"); return !a.complete && a.missing.includes("accessToken") })())
  check("oauth with refresh is refreshable", assessShape({ accessToken: "a", refreshToken: "r" }, "oauth").refreshable === true)
  check("api_key complete when key present", assessShape({ apiKey: "k" }, "api_key").complete === true)
  const idxSpec: ConnectorShapeSpec = { connector: "idxbroker", fields: [{ canonical: "clientID", aliases: ["clientId", "memberID"], required: true }, { canonical: "email", aliases: ["emailAddress"], required: false }] }
  check("adaptResponse maps canonical key cleanly (no drift)", (() => { const r = adaptResponse({ clientID: "abc", email: "a@b.com" }, idxSpec); return !r.drifted && r.value.clientID === "abc" && r.drift.aliased.length === 0 })())
  check("adaptResponse self-heals a renamed field via alias (flags drift)", (() => { const r = adaptResponse({ memberID: "abc" }, idxSpec); return r.value.clientID === "abc" && r.drifted && r.drift.aliased[0].matchedKey === "memberID" && shapeHealthy(r.drift) })())
  check("adaptResponse flags a missing required field (unhealthy)", (() => { const r = adaptResponse({ email: "a@b.com" }, idxSpec); return r.drift.missingRequired.includes("clientID") && !shapeHealthy(r.drift) })())
  check("adaptResponse reports unmapped (candidate new vendor) keys", (() => { const r = adaptResponse({ clientID: "x", brandNewField: 1 }, idxSpec); return r.drift.unmapped.includes("brandNewField") })())

  // ── Live probe classification (pure) ────────────────────────────────────────
  check("probe: not configured", classifyProbe({ configured: false, httpStatus: null, networkError: false, missingRequired: [] }) === "not_configured")
  check("probe: 200 + healthy shape → ok", classifyProbe({ configured: true, httpStatus: 200, networkError: false, missingRequired: [] }) === "ok")
  check("probe: 200 + missing required → shape_drift", classifyProbe({ configured: true, httpStatus: 200, networkError: false, missingRequired: ["id"] }) === "shape_drift")
  check("probe: 401/403 → auth_failed", classifyProbe({ configured: true, httpStatus: 401, networkError: false, missingRequired: [] }) === "auth_failed" && classifyProbe({ configured: true, httpStatus: 403, networkError: false, missingRequired: [] }) === "auth_failed")
  check("probe: 5xx and 429 → unreachable", classifyProbe({ configured: true, httpStatus: 503, networkError: false, missingRequired: [] }) === "unreachable" && classifyProbe({ configured: true, httpStatus: 429, networkError: false, missingRequired: [] }) === "unreachable")
  check("probe: network error → unreachable", classifyProbe({ configured: true, httpStatus: null, networkError: true, missingRequired: [] }) === "unreachable")
  check("probe specs cover the key real-estate financial+comms connectors", ["idxbroker", "gohighlevel", "meta", "sendgrid", "twilio", "stripe", "quickbooks"].every((p) => !!PROBE_SPECS[p]))
  check("quickbooks probe url requires realmId from config", (() => { const u = PROBE_SPECS.quickbooks.url; return typeof u === "function" && u({ config: {} }) === null && typeof u({ config: { realmId: "123" }, accessToken: "t" }) === "string" })())

  // ── Single egress gateway (the one way in/out through connector-shape) ───────
  check("gateway builds bearer auth header + joined url", (() => { const r = buildAuthedRequest({ connector: "lofty", baseUrl: "https://api.lofty.com/v1", path: "contacts", auth: { style: "bearer", token: "TKN" } }); return r.headers.Authorization === "Bearer TKN" && r.url === "https://api.lofty.com/v1/contacts" })())
  check("gateway builds basic auth (followupboss key:'' )", (() => { const r = buildAuthedRequest({ connector: "followupboss", baseUrl: "https://api.followupboss.com/v1", path: "/people", auth: { style: "basic", username: "APIKEY", password: "" } }); return r.headers.Authorization === `Basic ${Buffer.from("APIKEY:").toString("base64")}` })())
  check("gateway header auth + query auth styles", (() => { const h = buildAuthedRequest({ connector: "idxbroker", baseUrl: "https://api.idxbroker.com", path: "clients/accountinfo", auth: { style: "header", name: "accesskey", value: "K" } }); const q = buildAuthedRequest({ connector: "meta", baseUrl: "https://graph.facebook.com/v18.0", path: "me", auth: { style: "query", name: "access_token", value: "T" } }); return h.headers.accesskey === "K" && q.url.includes("access_token=T") })())
  check("gateway merges vendor-required extra headers (e.g. GHL Version)", buildAuthedRequest({ connector: "gohighlevel", baseUrl: "https://services.leadconnectorhq.com", path: "/contacts/", auth: { style: "bearer", token: "T" }, headers: { Version: "2021-07-28" } }).headers.Version === "2021-07-28")

  // ── Invocation audit/learning log (pure decision→outcome) ────────────────────
  check("invocation outcome mapping", outcomeForDecision("executed") === "executed" && outcomeForDecision("requires_confirmation") === "planned" && outcomeForDecision("no_executor") === "planned" && outcomeForDecision("unauthorized") === "denied" && outcomeForDecision("not_connected") === "denied" && outcomeForDecision("blocked") === "denied" && outcomeForDecision("error") === "error")

  // ── MCP server wrapper (manifest → tools) ────────────────────────────────────
  const mcpTools = manifestToMcpTools(buildFullActionManifest())
  check("MCP exposes one tool per unified capability", mcpTools.length === buildFullActionManifest().length && mcpTools.length >= 30)
  check("MCP tools carry scope+ownership meta + valid names", mcpTools.every((t) => /^[a-zA-Z0-9_-]+$/.test(t.name) && t.inputSchema.type === "object" && !!t._meta.scope && !!t._meta.ownership))
  check("MCP inputSchema marks required vs optional", (() => { const s = inputsToJsonSchema(["address", "zipCode?"]); return s.required.includes("address") && !s.required.includes("zipCode") && !!s.properties.zipCode })())
  check("MCP tool name sanitizer", toToolName("lead_search") === "lead_search")
  check("MCP stays vendor-anonymous (no platform vendor names leak)", !JSON.stringify(mcpTools).includes("rentcast") && !JSON.stringify(mcpTools).includes("perplexity"))

  // ── Per-agent calendar (Google/Microsoft OAuth) — pure free-slot computation ──
  const calStart = "2026-06-01T00:00:00.000Z"
  const calEnd = "2026-06-01T23:59:59.000Z"
  const freeNoBusy = computeFreeSlots([], { startDate: calStart, endDate: calEnd, durationMinutes: 60 })
  check("free-slots: generates business-hours slots when no busy windows", freeNoBusy.length === 8 && freeNoBusy.every((s) => s.startTime < s.endTime))
  check("free-slots: excludes a slot overlapping a busy window", (() => {
    // Busy 09:00–10:00 local on that day → the 9am slot must be dropped.
    const nineLocal = new Date("2026-06-01T00:00:00.000Z"); nineLocal.setHours(9, 0, 0, 0)
    const busy = [{ start: nineLocal.getTime(), end: nineLocal.getTime() + 60 * 60_000 }]
    const slots = computeFreeSlots(busy, { startDate: calStart, endDate: calEnd, durationMinutes: 60 })
    return slots.length === 7 && !slots.some((s) => new Date(s.startTime).getHours() === 9)
  })())
  check("free-slots: respects duration (30-min slots still 8 in 9-17 hourly grid)", computeFreeSlots([], { startDate: calStart, endDate: calEnd, durationMinutes: 30 }).length === 8)

  // ── Unified connection ownership scope (agent→team→brokerage→platform) ──────
  check("scope cascade: agent → team → brokerage → platform (most-specific first)", (() => {
    const c = scopeCascade({ agentUserId: "u1", teamId: "t1", brokerageId: "b1" })
    return c.map((o) => o.ownerType).join(",") === "agent,team,brokerage,platform"
  })())
  check("scope cascade: brokerage-only actor → brokerage → platform", scopeCascade({ brokerageId: "b1" }).map((o) => o.ownerType).join(",") === "brokerage,platform")
  check("scope cascade: vendor is a leaf → vendor → platform (no brokerage cascade)", scopeCascade({ vendorId: "v1", brokerageId: "b1" }).map((o) => o.ownerType).join(",") === "vendor,platform")
  check("scope cascade: contact is a leaf → contact → platform", scopeCascade({ contactId: "c1", brokerageId: "b1" }).map((o) => o.ownerType).join(",") === "contact,platform")
  check("vendor/contact may connect email + calendar + social + financial only", isConnectionAllowed("vendor", "email") && isConnectionAllowed("vendor", "calendar") && isConnectionAllowed("vendor", "social") && isConnectionAllowed("vendor", "financial") && !isConnectionAllowed("contact", "phone") && !isConnectionAllowed("contact", "crm") && !isConnectionAllowed("contact", "esign"))
  check("agent/team/brokerage/platform may connect any provider-backed domain", (["agent", "team", "brokerage", "platform"] as const).every((s) => isConnectionAllowed(s, "email") && isConnectionAllowed(s, "financial") && isConnectionAllowed(s, "calendar") && isConnectionAllowed(s, "crm") && isConnectionAllowed(s, "transaction") && isConnectionAllowed(s, "esign")))
  check("provider-less domains (documents, marketing) are never connectable", (["agent", "brokerage", "vendor"] as const).every((s) => !isConnectionAllowed(s, "documents") && !isConnectionAllowed(s, "marketing")))
  check("writeScope: agent writes agent scope; broker-manager writes brokerage", writeScopeFor({ agentUserId: "u1", brokerageId: "b1" })?.ownerType === "agent" && writeScopeFor({ agentUserId: "u1", brokerageId: "b1", isBrokerageManager: true })?.ownerType === "brokerage")
  check("writeScope: vendor/contact write to themselves", writeScopeFor({ vendorId: "v1" })?.ownerType === "vendor" && writeScopeFor({ contactId: "c1" })?.ownerType === "contact")

  // ── Connection provider registry + per-actor provider gating ────────────────
  check("provider gating: agent may pick docusign for esign, but not for crm", isProviderAllowedForScope("agent", "esign", "docusign") && !isProviderAllowedForScope("agent", "crm", "docusign"))
  check("provider gating: crm is sync-out set {gohighlevel, followupboss, lofty, hubspot}", CONNECTOR_PROVIDERS.crm.join(",") === "gohighlevel,followupboss,lofty,hubspot")
  check("provider gating: unknown provider rejected for a valid domain", !isProviderAllowedForScope("brokerage", "transaction", "notarize"))
  check("provider gating: vendor may pick stripe (financial) but NOT a transaction provider", isProviderAllowedForScope("vendor", "financial", "stripe") && !isProviderAllowedForScope("vendor", "transaction", "dotloop"))
  check("provider gating: contact may pick email/calendar/social providers", isProviderAllowedForScope("contact", "email", "gmail") && isProviderAllowedForScope("contact", "calendar", "gmail") && isProviderAllowedForScope("contact", "social", "meta") && !isProviderAllowedForScope("contact", "crm", "gohighlevel"))
  check("domainsForScope: vendor sees email+calendar+social+financial", domainsForScope("vendor").sort().join(",") === "calendar,email,financial,social")
  check("domainsForScope: agent sees the full provider-backed set incl IDX; documents/marketing excluded", (() => { const ds = domainsForScope("agent"); return ds.includes("email") && ds.includes("transaction") && ds.includes("esign") && ds.includes("showing") && ds.includes("listing") && !ds.includes("documents") && !ds.includes("marketing") })())
  check("registry: transaction set is catalog-derived (includes authentisign)", CONNECTOR_PROVIDERS.transaction.includes("authentisign") && CONNECTOR_PROVIDERS.transaction.includes("brokermint") && CONNECTOR_PROVIDERS.transaction.length === 6)
  check("registry: esign set is catalog-derived (includes formsimplicity, excludes brokermint)", CONNECTOR_PROVIDERS.esign.includes("formsimplicity") && !CONNECTOR_PROVIDERS.esign.includes("brokermint") && CONNECTOR_PROVIDERS.esign.length === 5)
  check("registry: IDX Broker is per-tier (agent/team/brokerage/platform), not vendor/contact", CONNECTOR_PROVIDERS.listing.join(",") === "idxbroker" && isConnectionAllowed("agent", "listing") && isConnectionAllowed("brokerage", "listing") && !isConnectionAllowed("vendor", "listing") && !isConnectionAllowed("contact", "listing"))
  check("selectableConnectionsForScope(contact) only exposes allowed domains with providers", (() => { const m = selectableConnectionsForScope("contact"); return Object.keys(m).sort().join(",") === "calendar,email,financial,social" && (m.calendar as readonly string[]).includes("outlook") })())
  check("every registry provider id is lowercase canonical (no spaces/aliases)", Object.values(CONNECTOR_PROVIDERS).every((list) => list.every((p) => /^[a-z0-9_]+$/.test(p))))
  check("registry: podcast is per-tier (agent/team/brokerage/platform), not vendor/contact", CONNECTOR_PROVIDERS.podcast.join(",") === "transistor" && isConnectionAllowed("agent", "podcast") && isConnectionAllowed("brokerage", "podcast") && !isConnectionAllowed("vendor", "podcast") && !isConnectionAllowed("contact", "podcast"))
  check("field-spec: podcast write maps apiKey→api_key + showId→config.show_id (rejects missing showId)", (() => { const w = buildCredentialWrite("podcast", { apiKey: "TX", showId: "show_1" }); return !!w && w.api_key === "TX" && w.account_id === "show_1" && (w.config as any).show_id === "show_1" && buildCredentialWrite("podcast", { apiKey: "TX" }) === null })())
  check("field-spec: agent may pick transistor for podcast, not for esign", isProviderAllowedForScope("agent", "podcast", "transistor") && !isProviderAllowedForScope("agent", "esign", "transistor"))

  // ── Connection field-spec: auth method + resolver-correct credential mapping ─
  check("field-spec: email/calendar/social are OAuth; phone/esign are api_key", isOAuthConnection("email", "gmail") && isOAuthConnection("calendar", "outlook") && isOAuthConnection("social", "facebook") && !isOAuthConnection("phone", "twilio") && !isOAuthConnection("esign", "docusign"))
  check("field-spec: financial is OAuth/Connect (quickbooks OAuth + stripe Connect), no key paste", isOAuthConnection("financial", "quickbooks") && isOAuthConnection("financial", "stripe") && buildCredentialWrite("financial", { apiKey: "sk_x" }) === null)
  check("field-spec: oauthStartPath — email gmail→google_calendar, calendar outlook→outlook_calendar (PROVIDER_METADATA keys), social, stripe→Connect, qbo→oauth", oauthStartPath("email", "gmail") === "/api/integrations/oauth/google_calendar" && oauthStartPath("calendar", "outlook") === "/api/integrations/oauth/outlook_calendar" && oauthStartPath("social", "facebook") === "/api/social/oauth/facebook" && oauthStartPath("financial", "quickbooks") === "/api/integrations/oauth/quickbooks" && oauthStartPath("financial", "stripe") === "/vendor/earnings")
  check("field-spec: phone write maps SID/auth/from to resolver shape", (() => { const w = buildCredentialWrite("phone", { accountSid: "AC1", authToken: "tok", fromNumber: "+15551112222" }); return !!w && w.api_key === "AC1" && (w.config as any).auth_token === "tok" && (w.config as any).from_number === "+15551112222" })())
  check("field-spec: esign write maps profileId to config.profile_id + account_id", (() => { const w = buildCredentialWrite("esign", { apiKey: "k", profileId: "p1" }); return !!w && w.api_key === "k" && w.account_id === "p1" && (w.config as any).profile_id === "p1" })())
  check("field-spec: missing required field rejected (returns null)", buildCredentialWrite("phone", { accountSid: "AC1" }) === null && buildCredentialWrite("listing", {}) === null)
  check("field-spec: userType→scope mapping (vendor/broker/team_lead/agent/superadmin)", connectionScopeForUserType("vendor").scope === "vendor" && connectionScopeForUserType("broker_owner").scope === "brokerage" && connectionScopeForUserType("broker_owner").isBrokerageManager && connectionScopeForUserType("team_lead").scope === "team" && connectionScopeForUserType("agent").scope === "agent" && connectionScopeForUserType("superadmin").scope === "platform")
  check("field-spec: external partners (lender/title) map to vendor scope (not agent)", connectionScopeForUserType("lender").scope === "vendor" && connectionScopeForUserType("title").scope === "vendor")
  check("field-spec: staff (tc/isa/compliance) own at agent scope", connectionScopeForUserType("tc").scope === "agent" && connectionScopeForUserType("isa").scope === "agent" && connectionScopeForUserType("compliance").scope === "agent")
  check("field-spec: staff self-connect ONLY email+calendar (rest is brokerage-managed)", selfConnectableDomains("tc", "agent").sort().join(",") === "calendar,email")
  check("field-spec: a solo/team agent self-connects the full set (incl phone/crm/transaction)", (() => { const d = selfConnectableDomains("agent", "agent"); return d.includes("phone") && d.includes("crm") && d.includes("transaction") && d.includes("email") })())
  check("field-spec: external partner (vendor scope) self-connects email/calendar/social/financial", selfConnectableDomains("lender", "vendor").sort().join(",") === "calendar,email,financial,social")

  // ── Connect availability (honest UI: no connect path that silently no-ops) ──
  const agentCaps = { canOwn: true, hasAgentId: true, isBrokerageManager: false, hasBrokerage: true }
  const vendorCaps = { canOwn: true, hasAgentId: false, isBrokerageManager: false, hasBrokerage: true }
  const noOwnCaps = { canOwn: false, hasAgentId: false, isBrokerageManager: false, hasBrokerage: true }
  const platformNoBrokerage = { canOwn: true, hasAgentId: false, isBrokerageManager: false, hasBrokerage: false }
  check("availability: api_key supported when actor can own + has a brokerage (esign docusign)", isConnectSupported("esign", "docusign", vendorCaps).available && isConnectSupported("esign", "docusign", agentCaps).available)
  check("availability: stripe Connect available to any owner; quickbooks needs brokerage manager", isConnectSupported("financial", "stripe", vendorCaps).available && !isConnectSupported("financial", "quickbooks", vendorCaps).available)
  check("availability: social OAuth supported for any owner (stored by user_id)", isConnectSupported("social", "meta", vendorCaps).available && isConnectSupported("social", "linkedin", agentCaps).available)
  check("availability: email/calendar OAuth available to any owner with a brokerage (incl vendor/contact)", isConnectSupported("calendar", "gmail", agentCaps).available && isConnectSupported("email", "gmail", vendorCaps).available && !isConnectSupported("email", "gmail", platformNoBrokerage).available)
  check("availability: QuickBooks OAuth needs brokerage manager", isConnectSupported("financial", "quickbooks", { canOwn: true, hasAgentId: false, isBrokerageManager: true, hasBrokerage: true }).available && !isConnectSupported("financial", "quickbooks", vendorCaps).available)
  check("availability: api_key unavailable without a brokerage anchor (platform/superadmin)", !isConnectSupported("esign", "docusign", platformNoBrokerage).available && !isConnectSupported("transaction", "dotloop", platformNoBrokerage).available)
  check("availability: nothing is connectable without an owner id", !isConnectSupported("esign", "docusign", noOwnCaps).available && !isConnectSupported("social", "meta", noOwnCaps).available)
}

// ── 9. Source → intent mapping (the vendor/intent model) ─────────────────────
function testIntentMapping() {
  console.log("\n[Source → intent mapping]")
  // Each scraper source must resolve to the correct buyer/seller intent.
  // ZenRows listing sites = FSBO SELLER intent (we capture by-owner, not property).
  const cases: Array<[string, "buyer" | "seller" | "unknown"]> = [
    ["zillow", "unknown"],           // FSBO sellers + saved-search buyers (both)
    ["realtor", "unknown"],
    ["redfin", "unknown"],           // aliased → zenrows_homes
    ["batchdata_motivated", "seller"], // FSBO/divorce/probate/foreclosure distress
    ["craigslist_fsbo", "seller"],
    ["facebook_group", "unknown"],   // both buyer + seller posts (per-post detect)
    ["reddit_intent", "unknown"],    // both buyer + seller posts (per-post detect)
    ["instagram", "unknown"],        // both buyer + seller (aliased → instagram_intent)
    ["nextdoor", "unknown"],         // buyer-or-seller until enrichment
    ["google_phrase_intent", "unknown"], // buyers search homes + sellers search agents
    ["rental_listing", "seller"],    // landlord/investor sellers
    ["expired_listing", "seller"],   // failed listings = motivated sellers
    ["linkedin_relocation", "buyer"],// inbound relocating buyers
  ]
  for (const [source, expected] of cases) {
    const sem = getSourceSemantics(source)
    check(`source "${source}" → intent ${expected}`, sem.intentType === expected, `got ${sem.intentType}`)
  }
  // Alias resolution must not fall through to the unknown fallback.
  check("alias zillow → zenrows_zillow", resolveSourceKey("zillow") === "zenrows_zillow")
  check("alias redfin → zenrows_homes", resolveSourceKey("redfin") === "zenrows_homes")
  check("alias nextdoor → nextdoor_intent", resolveSourceKey("nextdoor") === "nextdoor_intent")
  check("listing-site motivation = real_estate_site_intent", getSourceSemantics("zillow").motivationType === "real_estate_site_intent")

  // ── enabled_sources gate bridge — the cron checks short names; DB may store ──
  // canonical keys or aliases. expandEnabledSources must make all forms activate
  // the same gate (this is the silent-skip drift fix).
  const canonical = expandEnabledSources(["facebook_group", "reddit_intent", "instagram_intent", "linkedin_relocation", "exa_buyer_intent", "tavily_intent"])
  check("canonical facebook_group activates 'facebook' gate", canonical.has("facebook"))
  check("canonical reddit_intent activates 'reddit' gate", canonical.has("reddit"))
  check("canonical instagram_intent activates 'instagram' gate", canonical.has("instagram"))
  check("canonical linkedin_relocation activates 'linkedin' gate", canonical.has("linkedin"))
  check("canonical exa_buyer_intent activates 'exa' gate", canonical.has("exa"))
  check("canonical tavily_intent activates 'tavily' gate", canonical.has("tavily"))
  const shortNames = expandEnabledSources(["facebook", "reddit", "zillow"])
  check("short 'facebook' still activates gate", shortNames.has("facebook"))
  check("short 'zillow' activates 'zillow_behavior' property gate", shortNames.has("zillow_behavior"))
  const canonicalZillow = expandEnabledSources(["zenrows_zillow", "zenrows_realtor"])
  check("canonical zenrows_zillow activates 'zillow_behavior' gate", canonicalZillow.has("zillow_behavior"))
  // Pass-through tokens used directly by the cron must survive verbatim.
  const passthrough = expandEnabledSources(["zillow_behavior", "recruiting_intent", "batchdata_motivated", "osint_signal"])
  check("'zillow_behavior' passes through", passthrough.has("zillow_behavior"))
  check("'recruiting_intent' passes through", passthrough.has("recruiting_intent"))
  check("'batchdata_motivated' passes through", passthrough.has("batchdata_motivated"))
  check("'osint_signal' passes through", passthrough.has("osint_signal"))
  check("empty/null enabled_sources → empty set", expandEnabledSources(null).size === 0)
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
  // New sources (recs 1-5).
  check("rental → apify", SOURCE_VENDOR.rental_listing === "apify")
  check("linkedin → apify", SOURCE_VENDOR.linkedin_relocation === "apify")
  check("expired → zenrows", SOURCE_VENDOR.expired_listing === "zenrows")
}

// ── 17. New sources: rental / expired / linkedin / OSINT permits-violations ──
function testNewSources() {
  console.log("\n[New sources — rental / expired / linkedin / OSINT records]")
  // Expired/withdrawn listing → seller
  const expiredHtml = `
    <div class="listing-card" data-id="e1">
      <span class="status-badge">Off market</span>
      <div class="card-address">55 Failed Sale Dr, Tampa FL</div>
      <a href="/home/e1"></a>
    </div>
    <div class="listing-card" data-id="e2"><span>Active</span><div class="card-address">99 Active Rd</div></div>`
  const expired = parseExpiredListings(expiredHtml, "zillow", { city: "Tampa", state: "FL" })
  check("expired: parses 1 off-market (active skipped)", expired.length === 1, `got ${expired.length}`)
  check("expired → seller + expired_listing", expired[0]?.intentType === "seller" && expired[0]?.source === "expired_listing")
  check("expired motivationScore high (>=70)", (expired[0]?.motivationScore ?? 0) >= 70)
  check("expired anchored on address", expired[0]?.propertyAddress === "55 Failed Sale Dr, Tampa FL")

  // Rental → landlord/investor seller
  const rental = normalizeRentalListing({ id: "r1", title: "3BR house for rent by owner", email: "landlord@example.com" }, { city: "Tampa", state: "FL" })
  check("rental → seller (landlord)", rental.intentType === "seller" && rental.source === "rental_listing")
  check("rental by-owner viable via email", isViableRecord(rental))

  // LinkedIn relocation → buyer
  const li = normalizeLinkedInPost({ id: "li1", text: "Excited to relocate to Tampa for my new role!", authorName: "Mia Mover" }, { city: "Tampa", state: "FL" })
  check("linkedin → buyer (relocation)", li.intentType === "buyer" && li.source === "linkedin_relocation")
  check("linkedin author parsed", li.firstName === "Mia" && li.lastName === "Mover")

  // OSINT permit/violation/obituary → seller
  check("building_permit → seller", recordTypeIntent("building_permit") === "seller")
  check("code_violation → seller", recordTypeIntent("code_violation") === "seller")
  check("obituary → seller (probate)", recordTypeIntent("obituary") === "seller")
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
  const fbSell = normalizeFacebookPost({ id: "fb3", text: "thinking of selling my home soon", authorName: "Pat Seller" }, { city: "Tampa", state: "FL" })
  check("FB seller post → seller intent", fbSell.intentType === "seller")

  // Buyer-intent coverage on every social source (the mandate).
  const rdBuy = normalizeRedditPost({ id: "r1", title: "Looking to buy a first home in Tampa", author: "buyer1" }, { city: "Tampa", state: "FL" })
  check("Reddit buyer post → buyer intent", rdBuy.intentType === "buyer")
  const rdSell = normalizeRedditPost({ id: "r2", title: "Selling my home FSBO", author: "seller1" }, { city: "Tampa", state: "FL" })
  check("Reddit seller post → seller intent", rdSell.intentType === "seller")
  const clWanted = normalizeCraigslistItem({ id: "clw", title: "ISO / wanted to buy a 3BR house", email: "iso@example.com" }, { city: "Tampa", state: "FL" })
  check("Craigslist wanted/ISO → buyer intent", clWanted.intentType === "buyer")
  check("Craigslist buyer post viable via reply email", isViableRecord(clWanted))
}

// ── 12. Subscription gate (auto territory scoping) ───────────────────────────
function testSubscriptionGate() {
  console.log("\n[Subscription gate — scrape only active-subscriber territories]")
  check("active is eligible", isActiveSubscriptionStatus("active"))
  check("trialing is eligible", isActiveSubscriptionStatus("trialing"))
  check("past_due not eligible", !isActiveSubscriptionStatus("past_due"))
  check("cancelled not eligible", !isActiveSubscriptionStatus("cancelled"))
  check("paused not eligible", !isActiveSubscriptionStatus("paused"))
  check("null not eligible", !isActiveSubscriptionStatus(null))

  const subs = [
    { brokerage_id: "b-active", status: "active" },
    { brokerage_id: "b-trial", status: "trialing" },
    { brokerage_id: "b-lapsed", status: "cancelled" },
    { brokerage_id: "b-due", status: "past_due" },
    { brokerage_id: null, status: "active" },
  ]
  const ids = activeSubscriberBrokerageIds(subs)
  check("includes active + trialing only", ids.has("b-active") && ids.has("b-trial") && ids.size === 2, `${[...ids].join(",")}`)
  check("excludes cancelled/past_due/null", !ids.has("b-lapsed") && !ids.has("b-due"))
}

// ── 13. OSINT distressed-seller source (divorce/probate/foreclosure) ─────────
function testOsint() {
  console.log("\n[OSINT public-records source]")
  const html = `
    <div class="result">
      <a class="case-name">Doe, Jane</a>
      <span class="county">Hillsborough</span>
      <span class="case-number">2024-DR-1234</span>
      <time class="date">2024-03-01</time>
    </div>
    <div class="result">
      <h3 class="party-name">Robert Smith</h3>
      <span class="county">Pinellas</span>
    </div>
    <div class="result"><span>too short</span></div>`
  const filings = parseTerritoryCourtRecords(html, "divorce")
  check("parses 2 named filings (short row dropped)", filings.length === 2, `got ${filings.length}`)
  const doe = filings.find((f) => f.lastName === "Doe")
  check("'Last, First' parsed", doe?.firstName === "Jane" && doe?.lastName === "Doe")
  check("county + case number captured", doe?.county === "Hillsborough" && doe?.caseNumber === "2024-DR-1234")
  const smith = filings.find((f) => f.lastName === "Smith")
  check("'First Last' parsed", smith?.firstName === "Robert" && smith?.lastName === "Smith")

  const rec = normalizeCourtFiling(filings[0]!, { city: "Tampa", state: "FL", county: "Hillsborough" })
  check("OSINT record = seller intent", rec.intentType === "seller")
  check("OSINT source = osint_signal", rec.source === "osint_signal")
  check("divorce motivationScore high (>=70)", (rec.motivationScore ?? 0) >= 70)
  check("OSINT record viable (name + state)", isViableRecord(rec))
  // OSINT source key maps correctly (alias osint → osint_signal).
  check("osint alias resolves", resolveSourceKey("osint") === "osint_signal")
}

// ── 14. Listing-site BUYER saved-search capture (ZenRows) ────────────────────
function testBuyerSavedSearches() {
  console.log("\n[Listing-site buyer saved-search parse]")
  const html = `
    <div class="saved-search" data-user="Jane Buyer" data-id="ss1">
      <span class="search-criteria">3BR Tampa under 500k</span>
    </div>
    <div class="favorited-home" data-id="fav2">
      <span class="member">Bob Shopper</span>
      <span class="home-address">123 Bay St, Tampa FL</span>
    </div>
    <div class="saved-search" data-id="ss3"><span>no identity here</span></div>`
  const records = parseBuyerSavedSearches(html, "zillow", { city: "Tampa", state: "FL" })
  check("parses 2 buyer signals (identity-less dropped)", records.length === 2, `got ${records.length}`)
  check("all buyer intent", records.every((r) => r.intentType === "buyer"))
  check("behaviorType = saved_search", records[0]?.behaviorType === "saved_search")
  const jane = records.find((r) => r.username === "Jane Buyer")
  check("saved-search buyer handle captured", !!jane && jane.firstName === "Jane")
  check("buyer records viable (handle/address anchor)", records.every(isViableRecord))
}

// ── 15. Perplexity enrichment gap-fill (pure merge) ──────────────────────────
function testPerplexityEnrichment() {
  console.log("\n[Perplexity enrichment — gap-fill merge]")
  const base = { first_name: "Ann", last_name: "Lee", email: null, phone: "8135551234", enrichmentConfidence: 0.4 }
  check("shouldGapFill: full name + no email → yes", shouldGapFill(base))
  check("shouldGapFill: has email → no", !shouldGapFill({ ...base, email: "a@x.com" }))
  const merged = mergeEnrichment(base, { email: "ann.lee@example.com", currentBrokerage: "Old Realty" })
  check("fills missing email from Perplexity", merged.email === "ann.lee@example.com")
  check("does not overwrite existing phone", merged.phone === "8135551234")
  check("confidence nudged up after gap-fill", merged.enrichmentConfidence > base.enrichmentConfidence)
  const noChange = mergeEnrichment({ ...base, email: "have@x.com" }, { email: "other@x.com" })
  check("structured email takes precedence (no overwrite)", noChange.email === "have@x.com")
  check("null findings → unchanged", mergeEnrichment(base, null).email === null)
}

// ── 16. OSINT buyer-intent record types ──────────────────────────────────────
function testOsintBuyer() {
  console.log("\n[OSINT buyer-intent record types]")
  check("marriage → buyer", recordTypeIntent("marriage") === "buyer")
  check("new_mover → buyer", recordTypeIntent("new_mover") === "buyer")
  check("relocation → buyer", recordTypeIntent("relocation") === "buyer")
  check("divorce → seller", recordTypeIntent("divorce") === "seller")
  check("foreclosure → seller", recordTypeIntent("foreclosure") === "seller")
  const buyerRec = normalizeCourtFiling(
    { firstName: "New", lastName: "Couple", recordType: "marriage", county: "Hillsborough", caseNumber: null, date: null },
    { city: "Tampa", state: "FL" },
  )
  check("OSINT marriage filing → buyer intent", buyerRec.intentType === "buyer")
}

// ── 18. Apify actor resilience (fallback chain + health) ─────────────────────
async function testActorResilience() {
  console.log("\n[Apify actor resilience — fallback chain]")
  // Every task has a primary + at least one fallback (no single point of failure).
  for (const task of Object.keys(ACTOR_REGISTRY) as Array<keyof typeof ACTOR_REGISTRY>) {
    check(`task "${task}" has >=2 candidate actors`, ACTOR_REGISTRY[task].length >= 2, `${ACTOR_REGISTRY[task].length}`)
  }
  // Health filtering: a dead primary is dropped; order preserved.
  const reddit = ACTOR_REGISTRY.reddit
  const picked = pickActors("reddit", { [reddit[0]]: false })
  check("pickActors drops dead primary", !picked.includes(reddit[0]) && picked[0] === reddit[1])
  check("pickActors keeps all when no health", pickActors("reddit").length === reddit.length)
  check("pickActors falls back to primary if all dead", pickActors("reddit", Object.fromEntries(reddit.map((a) => [a, false])))[0] === reddit[0])

  // Runtime fallback: first actor errors (gone), second succeeds.
  let calls: string[] = []
  const runner = async (actorId: string) => {
    calls.push(actorId)
    if (actorId === reddit[0]) throw new Error("Actor not found (404)")
    return { data: [{ id: "ok" }], cost: 0.5 }
  }
  const r = await runApifyTask("reddit", { x: 1 }, { runner })
  check("runApifyTask skips dead actor → uses fallback", r.actorUsed === reddit[1], String(r.actorUsed))
  check("runApifyTask returns the working actor's data", r.data.length === 1)
  check("runApifyTask records tried actors", r.triedActors.length === 2)

  // All actors down → graceful empty (never throws).
  const allFail = async () => { throw new Error("down") }
  const r2 = await runApifyTask("facebook", {}, { runner: allFail })
  check("all actors down → empty + actorUsed null (no throw)", r2.actorUsed === null && r2.data.length === 0)
}

// ── 19. Exa neural-search buyer intent (AI-native) ───────────────────────────
function testExaBuyerIntent() {
  console.log("\n[Exa neural-search buyer intent (AI-native)]")
  // Raw Exa row → normalized result (defensive field mapping, contents.text fallback).
  const row = normalizeExaRow({ id: "x1", url: "https://forum.example/post/1", title: "Pre-approved, house hunting in Tampa", author: "homehunter_mia", contents: { text: "We just got pre-approved and are looking to buy our first home in Tampa." } })
  check("Exa row → text via contents fallback", !!row.text && row.text.includes("pre-approved"))
  check("Exa row → author captured", row.author === "homehunter_mia")

  const rec = normalizeExaResult(row, { city: "Tampa", state: "FL" })
  check("Exa record → buyer intent + exa_buyer_intent", rec.intentType === "buyer" && rec.source === "exa_buyer_intent")
  check("Exa record → ai_neural_match signal", rec.intentSignals?.includes("ai_neural_match"))
  check("Exa record viable via author handle", rec.username === "homehunter_mia" && isViableRecord(rec))
  // Seller phrasing within Exa content classifies as seller.
  const sellerRow = normalizeExaRow({ id: "x2", url: "https://blog/2", title: "Thinking of selling my home in Tampa", author: "owner_bob" })
  check("Exa seller content → seller intent", normalizeExaResult(sellerRow, { city: "Tampa", state: "FL" }).intentType === "seller")
  // Source intent + vendor routing.
  check("exa → buyer intent", getSourceSemantics("exa").intentType === "buyer")
  check("exa → exa vendor", SOURCE_VENDOR.exa_buyer_intent === "exa")
}

// ── 19b. Tavily agentic-search intent (AI-native) — buyer/seller/investor ────
function testTavilyIntent() {
  console.log("\n[Tavily agentic-search intent (AI-native)]")
  // Raw Tavily row → normalized result (defensive field mapping, snippet fallback).
  const row = normalizeTavilyRow({ title: "Pre-approved buyer in Tampa", snippet: "looking to buy a first home in Tampa", url: "https://forum.example/1", score: 0.8 })
  check("Tavily row → content via snippet fallback", row.content === "looking to buy a first home in Tampa")
  check("Tavily row → score captured", row.score === 0.8)

  // Buyer intent + contact extraction from snippet anchors viability.
  const buyer = normalizeTavilyResult(
    { title: "House hunting in Tampa", content: "We are pre-approved and looking to buy. Reach me at buyer@example.com.", url: "https://x/1", score: 0.7 },
    { city: "Tampa", state: "FL" },
  )
  check("Tavily buyer → buyer intent + tavily_intent", buyer.intentType === "buyer" && buyer.source === "tavily_intent")
  check("Tavily buyer → email extracted for viability", buyer.email === "buyer@example.com" && isViableRecord(buyer))
  check("Tavily buyer → ai_search_match signal", buyer.intentSignals?.includes("ai_search_match"))

  // Seller phrasing → seller intent; phone extraction anchors viability.
  const seller = normalizeTavilyResult(
    { title: "FSBO Tampa", content: "Selling my home, call (813) 555-0142", url: "https://x/2", score: 0.6 },
    { city: "Tampa", state: "FL" },
  )
  check("Tavily seller → seller intent", seller.intentType === "seller")
  check("Tavily seller → phone extracted for viability", !!seller.phone && isViableRecord(seller))

  // Investor phrasing → buyer intent + investor signal.
  check("isInvestor detects 1031 exchange", isInvestor("looking for a 1031 exchange rental property"))
  const investor = normalizeTavilyResult(
    { title: "Investor Tampa", content: "Cash buyer seeking rental portfolio, email investor@example.com", url: "https://x/3", score: 0.9 },
    { city: "Tampa", state: "FL" },
  )
  check("Tavily investor → buyer intent + investor signal", investor.intentType === "buyer" && investor.intentSignals?.includes("investor"))
  check("Tavily investor → higher motivation score", (investor.motivationScore ?? 0) === 55)

  // Source intent + vendor routing.
  check("tavily → tavily vendor", SOURCE_VENDOR.tavily_intent === "tavily")
  check("tavily alias resolves", resolveSourceKey("tavily") === "tavily_intent")
  check("tavily semantics present", getSourceSemantics("tavily").motivationType === "ai_search_intent")
}

// ── 19c. Unified web search — Exa-first (intent) / Tavily-first (research) ────
async function testWebSearchFallback() {
  console.log("\n[Unified web search — Exa-first intent, Tavily-first research]")
  const exaOk = async () => ({ results: [{ id: "e1", url: "https://e/1", title: "Exa hit", text: "exa text", author: null, publishedDate: null }], cost: 0.01 })
  const exaEmpty = async () => ({ results: [], cost: 0 })
  const tavilyOk = async () => ({ answer: "summary", results: [{ title: "T", url: "https://t/1", content: "t snippet", score: 0.5 }], cost: 0.005 })
  const tavilyEmpty = async () => ({ answer: null, results: [], cost: 0 })

  // DEFAULT (intent) mode → Exa is PRIMARY for behavior/intent discovery.
  const r1 = await runWebSearch({ query: "q" }, { tavily: tavilyOk as any, exa: exaOk as any })
  check("intent mode uses Exa first (lead-acquisition behavior discovery)", r1.provider === "exa" && r1.hits.length === 1)

  // intent mode, Exa empty → falls back to Tavily.
  const r2 = await runWebSearch({ query: "q" }, { tavily: tavilyOk as any, exa: exaEmpty as any })
  check("intent mode falls back to Tavily when Exa empty", r2.provider === "tavily" && r2.answer === "summary")

  // research mode → Tavily is PRIMARY (synthesized answer for Q&A grounding).
  const r3 = await runWebSearch({ query: "q", mode: "research" }, { tavily: tavilyOk as any, exa: exaOk as any })
  check("research mode uses Tavily first (synthesized answer)", r3.provider === "tavily" && r3.answer === "summary")

  // research mode, Tavily empty → falls back to Exa.
  const r4 = await runWebSearch({ query: "q", mode: "research" }, { tavily: tavilyEmpty as any, exa: exaOk as any })
  check("research mode falls back to Exa when Tavily empty", r4.provider === "exa" && r4.hits.length === 1)

  // Both empty → provider none (either mode).
  const r5 = await runWebSearch({ query: "q" }, { tavily: tavilyEmpty as any, exa: exaEmpty as any })
  check("web search → none when both empty", r5.provider === "none" && r5.hits.length === 0)
}

// ── 19d. RentCast market-stats normalizer (TIER-1 market data feed) ──────────
function testRentcastMarketStats() {
  console.log("\n[RentCast market-stats normalizer]")
  const history: Record<string, any> = {}
  // 13 monthly snapshots: 12 months ago = 400k, latest = 440k → +10% YoY.
  for (let i = 12; i >= 0; i--) {
    const m = `2024-${String(13 - i).padStart(2, "0")}` // arbitrary ascending keys
    history[m] = { medianPrice: i === 12 ? 400000 : i === 0 ? 440000 : 420000 }
  }
  const stats = normalizeRentcastMarketStats({
    medianPrice: 440000,
    averageDaysOnMarket: 32,
    totalListings: 120,
    newListings: 18,
    history,
  })
  check("rentcast → median price", stats?.median_sale_price === 440000)
  check("rentcast → DOM", stats?.avg_days_on_market === 32)
  check("rentcast → active listings", stats?.active_listings === 120)
  check("rentcast → YoY +10%", stats?.price_trend_yoy_pct === 10)
  check("rentcast → null on empty", normalizeRentcastMarketStats(null) === null)
  check("rentcast → null on zero price", normalizeRentcastMarketStats({ medianPrice: 0 }) === null)
}

// ── 19e. Neighborhood intelligence — tier gate, livability, Fair-Housing ─────
function testNeighborhoodIntelligence() {
  console.log("\n[Neighborhood intelligence — tier gate + livability + Fair-Housing]")
  // Tier gate: only the most advanced plans.
  check("tier gate allows brokerage", isNeighborhoodReportAllowed("brokerage"))
  check("tier gate allows multi_location", isNeighborhoodReportAllowed("multi_location"))
  check("tier gate denies solo_agent", !isNeighborhoodReportAllowed("solo_agent"))
  check("tier gate denies team", !isNeighborhoodReportAllowed("team"))
  check("tier gate denies null", !isNeighborhoodReportAllowed(null))

  const rich = {
    lat: 27.95, lon: -82.45,
    amenities: {
      restaurants: [{ name: "Cafe", distance: 200 }, { name: "Grill", distance: 350 }],
      grocery: [{ name: "Market", distance: 300 }],
      parks: [{ name: "Park", distance: 600 }],
      schools: [{ name: "Elementary", distance: 800 }],
      transit: [{ name: "Bus Stop", distance: 150 }],
    },
    censusMedianHomeValue: 415000,
    dataSource: "openstreetmap+census" as const,
  }
  const liv = computeLivabilityScore(rich)
  check("livability: all 5 categories scored", liv.score >= 60)
  check("livability: proximity bonus pushed to walkable band", liv.score >= 75 && liv.label === "Highly walkable")

  const empty = {
    lat: null, lon: null,
    amenities: { restaurants: [], grocery: [], parks: [], schools: [], transit: [] },
    censusMedianHomeValue: null,
    dataSource: "none" as const,
  }
  const livEmpty = computeLivabilityScore(empty)
  check("livability: no data → score 0 / Limited data", livEmpty.score === 0 && livEmpty.label === "Limited data")

  // The factual fallback narrative must be Fair-Housing clean (no high-severity hits).
  const narrative = factualNarrative(rich, liv)
  check("factual narrative non-empty", narrative.length > 0)
  const violations = detectFairHousingViolations(narrative)
  check("factual narrative passes Fair-Housing detector", violations.filter((v) => v.severity === "high").length === 0)
}

// ── 20. BatchData = comprehensive motivated-seller source ────────────────────
function testBatchDataTypes() {
  console.log("\n[BatchData motivated-seller coverage]")
  // The BatchData-pullable triggers (divorce has no BatchData quickList — sourced elsewhere).
  const required = ["probate", "foreclosure", "pre_foreclosure", "tax_lien", "high_equity", "absentee", "expired", "vacant", "tired_landlord"]
  for (const t of required) {
    check(`BatchData covers "${t}"`, (BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes(t))
  }
  check("batchdata_motivated → seller intent", getSourceSemantics("batchdata_motivated").intentType === "seller")
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
  testSubscriptionGate()
  testOsint()
  testBuyerSavedSearches()
  testPerplexityEnrichment()
  testOsintBuyer()
  testNewSources()
  await testActorResilience()
  await testVendorConnectors()
  await testVendorGateway()
  testExaBuyerIntent()
  testTavilyIntent()
  await testWebSearchFallback()
  testRentcastMarketStats()
  testNeighborhoodIntelligence()
  testBatchDataTypes()
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
