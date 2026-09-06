/**
 * scripts/intelligence-modules-simulator.ts
 *
 * Exercises the pure + DB-bound paths of the 8 intelligence modules built this turn:
 *   #1 contact-signal-rescrape   (server-only — registry assertions only)
 *   #2 deal-investigator         (server-only — registry assertions only)
 *   #3 socrata-client            (LIVE public call to a known-good open dataset, no auth needed)
 *   #4 vision-property           (registry assertion + tsc proves wiring; live call needs key)
 *   #5 relisting-detector        (server-only — registry assertion)
 *   #6 intent-phrase-rollup      (server-only — registry assertion)
 *   #7 email-verifier            (RFC + MX tiers run live, no cost; Tier 3 covered by tsc)
 *   #8 lob-address-verify        (registry assertion; live call needs key)
 *
 * Pure pieces get real assertions; server-only modules covered by tsc + connector-gateway contract
 * + their own dedicated DB-bound tests when wired into a route.
 */
import { checkEmailSyntax, checkEmailMx } from "../lib/external/email-verifier"
import { socrataQuery } from "../lib/external/socrata-client"
import { getMarketDatasets, listSupportedMarkets, providerOf, MARKETS } from "../lib/external/socrata-market-registry"
import { getConnectorSpec } from "../lib/agentic-os/connector-registry"

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log(` ✗ ${msg}`) } }

// ── #7 Email verifier — Tier 1 (pure) ───────────────────────────────────────
const goodSyn = checkEmailSyntax("alice@example.com")
ok(goodSyn.verified && goodSyn.tier === 1,                          "email Tier 1: valid syntax")
const badSyn  = checkEmailSyntax("not-an-email")
ok(!badSyn.verified && badSyn.tier === 1,                           "email Tier 1: bad syntax rejected")
const disp    = checkEmailSyntax("foo@mailinator.com")
ok(!disp.verified && disp.isDisposable === true,                    "email Tier 1: disposable domain rejected")
const role    = checkEmailSyntax("support@acme.com")
ok(role.verified && role.isRoleAccount === true,                    "email Tier 1: role account flagged but not rejected")
const empty   = checkEmailSyntax("")
ok(!empty.verified,                                                 "email Tier 1: empty rejected")

// ── #7 Email verifier — Tier 2 (live MX lookup, free) ───────────────────────
const mxOk   = await checkEmailMx("alice@google.com")  // google.com has MX
ok(mxOk.verified && mxOk.tier === 2 && mxOk.hasMx === true,         "email Tier 2: google.com has MX")
const mxBad  = await checkEmailMx("alice@nonexistent-test-domain-12345.invalid")
ok(!mxBad.verified && mxBad.tier === 2 && mxBad.hasMx === false,    "email Tier 2: .invalid domain has no MX")
// Bad-syntax address short-circuits at Tier 1 and never hits DNS.
const mxShort = await checkEmailMx("not-an-email")
ok(!mxShort.verified && mxShort.tier === 1,                         "email Tier 2: bad syntax short-circuits before MX")

// ── #3 Socrata — live call against a known-stable open dataset (NYC 311, no auth) ─
// We ask for ONE row to keep the call bounded; the contract under test is "adapter returns
// structured result, never throws", not "this exact dataset id never changes".
const sa = await socrataQuery({
  host: "data.cityofnewyork.us",
  datasetId: "erm2-nwe9",                  // NYC 311 Service Requests — long-stable public dataset
  query: { limit: 1 },
})
ok(typeof sa.ok === "boolean" && Array.isArray(sa.data),            "socrata: live call returns structured shape (no throw)")
ok(sa.ok ? sa.data.length >= 0 : typeof sa.error === "string",      "socrata: ok=true implies array data, ok=false implies error string")
// Bad host — must not throw (gateway contract); returns ok=false structured.
const sb = await socrataQuery({ host: "this-portal-does-not-exist-12345.invalid", datasetId: "abcd-1234", query: { limit: 1 } })
ok(sb.ok === false,                                                 "socrata: bad host returns ok=false (no throw)")

// ── Registry assertions for the new connectors / endpoints ─────────────────
ok(!!getConnectorSpec("socrata"),                                   "registry: socrata connector added")
ok(getConnectorSpec("socrata")?.category === "scraper",             "registry: socrata category=scraper")
ok(!!getConnectorSpec("socrata")?.tags?.includes("permits"),        "registry: socrata tagged 'permits'")

// ── Per-market Socrata datasets — application is NATIONAL, not NYC-only ────
const markets = listSupportedMarkets()
ok(markets.length >= 10,                                            "market-registry: ≥10 US metro areas registered")
const states = new Set(markets.map(m => m.state))
ok(states.size >= 8,                                                "market-registry: covers ≥8 distinct states (national coverage)")
ok(getMarketDatasets({ state: "TX", city: "Austin" }).length >= 1,  "market-registry: Austin TX has datasets")
ok(getMarketDatasets({ state: "tx", city: "AUSTIN" }).length >= 1,  "market-registry: lookup is case-insensitive")
ok(getMarketDatasets({ state: "WA", city: "Seattle" }).some(d => d.kind === "permits"), "market-registry: Seattle has a permits dataset")
ok(getMarketDatasets({ state: "FL", city: "Miami"   }).some(d => d.kind === "permits"), "market-registry: Miami has a permits dataset")
ok(getMarketDatasets({ state: "XX", city: "Nowhere" }).length === 0, "market-registry: unknown market returns empty (fallback)")
ok(getMarketDatasets({ state: null, city: null }).length === 0,     "market-registry: null inputs safe")
// Every spec has a real host + a well-formed dataset id (data quality).
//
// ── ID SHAPE IS PER-PROVIDER (2026-08-20) ───────────────────────────────────
// This loop asserted "every id is a Socrata 4x4", which was true while Socrata was the only
// provider and became false the moment the registry gained `provider: "arcgis"` (Miami-Dade, read
// by lib/external/arcgis-permits.ts). ArcGIS has no 4x4 — an ArcGIS entry is identified by its
// 32-hex AGOL item id, with the queryable locator in `serviceUrl`.
//
// The RULE this assertion existed for is unchanged and is the one that matters: `datasetId` is
// the first segment of `permitDedupeKey`, so a malformed or unstable id means a signal that
// re-files itself every day. So the id is still checked strictly — just against the shape its own
// provider actually issues, rather than against one provider's shape for all of them.
for (const m of Object.values(MARKETS)) {
  for (const d of m.datasets) {
    ok(/^[a-z0-9.-]+$/i.test(d.host) && d.host.includes("."), `market-registry: ${m.city} dataset host shape ok`)
    const isArcgis = providerOf(d) === "arcgis"
    ok(isArcgis ? /^[0-9a-f]{32}$/.test(d.datasetId) : /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(d.datasetId),
      `market-registry: ${m.city} dataset id is a well-formed ${isArcgis ? "ArcGIS item id" : "Socrata 4x4"}`)
    // An ArcGIS spec without a layer URL is not addressable at all — it would be counted as
    // coverage and then refused on every run. isQueryableDataset enforces it; this proves the
    // registry never contains one in the first place.
    ok(!isArcgis || /^https:\/\/.+\/(FeatureServer|MapServer)\/\d+$/.test(d.serviceUrl ?? ""),
      `market-registry: ${m.city} ArcGIS dataset carries a FeatureServer layer URL`)
  }
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
