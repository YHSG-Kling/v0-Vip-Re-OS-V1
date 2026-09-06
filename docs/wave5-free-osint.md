# Wave 5 — Free OSINT selection in the enrichment lane

Owner ruling (verbatim):

> "there is a free osint selection"

Reading: the enrichment lane must be able to use a FREE OSINT option, not only the
paid one. Scope of this agent = the PROVIDER layer (`lib/osint-client.ts`,
`lib/external/*` OSINT modules, `lib/platform/provider-posture.ts`, and the
provider-SELECTION path inside `lib/lead-pipeline/enrichment-orchestrator.ts`).
`lib/enrichment/*`, the lead-create doors and `lib/kernel/lead-acquisition-handlers.ts`
belong to a parallel agent.

## Baseline verified by read (2026-08-09)

### The free lane as it exists today

- `lib/platform/provider-posture.ts:544-549` — `POSTURE_CANON` folds `nominatim`,
  `overpass`, `census` onto the single posture key `osint_free`. CONFIRMED.
- `:578` `KEYLESS_PROVIDERS = {osint_free, browser_tts, remotion, cma_aggregate}`. CONFIRMED.
- `:566` `DECOMMISSIONED_PROVIDERS = {vapi, heygen}` — nothing new may bind to those.
- `:763-774` binds the row to `fetchOSINTNeighborhoodData`.

Free modules, read in full:

| module | function | answers |
|---|---|---|
| `lib/external/nominatim-geocode.ts` | `geocodeOne` / `createCachedGeocoder` | address → lat/lng (OSM Nominatim, keyless, 1 req/s) |
| `lib/external/osint-neighborhood.ts` | `fetchOSINTNeighborhoodData` | lat/lon + nearby amenities (Overpass) + ZIP median home value (Census ACS 2022) |
| `lib/external/census-appreciation.ts` | `fetchCensusAppreciation` | ZIP median-value appreciation across ACS 2018 vs 2022 vintages |

All three go through `callConnector` (`lib/agentic-os/connector-gateway.ts`), which
returns `{ok, status, data, headers, drift, error}` and NEVER throws. Every one of the
free modules currently swallows `!res.ok` into `null` / empty — i.e. **"provider down"
and "no data for this address" are indistinguishable to the caller today.** That is the
availability-honesty defect to fix.

### What the free lane can and CANNOT answer

CAN (place-keyed / ADDRESS-keyed facts):
- geocode an address to a coordinate
- what amenities are near a coordinate (restaurants, grocery, parks, schools, transit)
- the ACS median owner-occupied home value for a ZIP
- multi-year direction of that median value for a ZIP

CANNOT (person-keyed facts — the entire paid skip-trace product):
- phone numbers, emails, or any contact point for a person
- name → identity resolution, age, gender, marital status, household size/income,
  net worth, employer/title, education
- social profile URLs for a person
- court/public-record filings for a person (divorce, probate, foreclosure, liens)
- property records BY OWNER NAME (Census/OSM are not an ownership index)
- life events

So the free lane is NOT a substitute for `skipTraceWithPeopleData` or
`OSINTClient.searchPerson`. It is a substitute for the ADDRESS-derived subset only. Any
design that lets a free result close a skip_trace queue row as `completed` would be the
exact "reports success without doing the thing" defect.

### The paid lane

- `lib/osint-client.ts` — `OSINTClient.searchPerson` fans out to 4 private scrape
  methods; `searchPublicRecords` and `searchPropertyRecords` use ZenRows
  `premium_proxy: true` (most expensive setting). `searchCourtRecordsByTerritory`
  returns `{filings, cost}`.
- Callers of `searchPerson`: `lib/enrichment/contact-enrichment-core.ts:505,647`
  (parallel agent's file). Callers of `OSINTClient`: also
  `app/actions/lead-intelligence.ts:2198`, `lib/lead-pipeline/osint-sourcer.ts:64`,
  `lib/property/enrichment-chain.ts:92`, `lib/platform/provider-posture.ts:756`.
- The orchestrator drain calls `skipTraceWithPeopleData` (PeopleData, $0.10/record)
  and meters `vendor: 'PeopleData'`.

### Ledger hazard found

`lib/vendor-governance/cost-normalizer.ts:137-146` — `normalizeVendorCost` falls back to
**$0.01/unit for an UNKNOWN vendor key**. So metering a free call as
`vendor: 'osint_free'` today would silently invent one cent of spend per call and
inflate the budget ledger that `checkVendorBudget` reads. A `$0` pricing row is required
before the free lane may be metered at all.

## WHAT WAS BUILT

### 1. `lib/external/free-probe.ts` (new) — the honesty primitive

`FreeProbe<T>` keeps four outcomes distinct that every free module previously
collapsed into one `null`: `ok` · `no_data` · `unreachable` · `not_attempted`.
`gatewayProbe` / `unreachableProbe` / `notAttemptedProbe` are the three constructors.
Pure, import-free. Lives in its own module so the primitive modules never have to
import the lane assembler that imports them.

### 2. `lib/external/osint-free.ts` (new) — the lane, and its written boundary

- `FREE_OSINT_ANSWERS` / `PAID_ONLY_ANSWERS` — the capability boundary as data.
- `planEnrichmentLane(...)` — PURE selection. Routes **by question, not by preference**.
- `runFreeOsintLane(input, answers)` — executes Nominatim + Overpass + Census,
  `cost: 0`, per-connector availability reporting, never throws.
- `describeFreeLane(result)` — one honest line for an `error_message` / ledger note.

**Selection mechanism chosen: capability-keyed routing, not a config toggle.**
Rationale, written into the module header: the two lanes answer *different*
questions. A per-brokerage "prefer free" switch would let an operator point a
`skip_trace` row at sources that hold no person data and get a confident empty
answer back. There is therefore deliberately no toggle. The routing table:

| enrichment_type | free lane | paid lane | label |
|---|---|---|---|
| `skip_trace` | rides along at $0 for the place-keyed facts | REQUIRED | `osint_free+peopledata` |
| `property_match` | PRIMARY — answers it | never (the person provider is not an address index) | `osint_free` |
| `phone_validation` | not offered | REQUIRED | `peopledata` |
| `osint_profile` | not offered | REQUIRED (routed earlier in the drain) | `peopledata` |
| `duplicate_check` | not offered | not offered — internal record matching | `none` |
| unknown | none | none — the row fails loudly | `none` |

### 3. Availability honesty in the three free modules (duplicates merged)

| deleted | survivor |
|---|---|
| `lib/external/osint-neighborhood.ts` private `geocodeAddress` | `lib/external/nominatim-geocode.ts:geocodeOne` |
| `lib/external/osint-neighborhood.ts` private `fetchCensusMedianHomeValue` | `lib/external/census-appreciation.ts:fetchCensusMedianHomeValue` |
| `lib/external/census-appreciation.ts` private `medianValueForVintage` | `lib/external/census-appreciation.ts:probeCensusMedianHomeValue` |

New availability-aware forms, each with a value-only wrapper so existing callers
are untouched: `geocodeOneDetailed`, `probeCensusMedianHomeValue`,
`probeCensusAppreciation`, `probeOverpassAmenities`.

Two further honesty fixes in `osint-neighborhood.ts`:
- `dataSource` claimed `"openstreetmap+census"` whenever any amenity was found,
  even with `censusMedianHomeValue === null`. It now claims `+census` only when
  the ACS figure actually came back.
- A courtesy pacer now sits at the single Nominatim egress point
  (`respectNominatimGap`, 1100 ms) — the drain calls the geocoder once per queue
  row with no shared resolver, so `createCachedGeocoder`'s per-batch spacing did
  not cover it. Getting the platform banned would take the whole free lane down.

Still outstanding (recorded, not done — outside this agent's file boundary): a
THIRD inline Nominatim copy lives in the `server-only`
`lib/property/enrichment-chain.ts`. Survivor is the same `geocodeOne`.

### 4. Orchestrator wiring (`lib/lead-pipeline/enrichment-orchestrator.ts`)

- entity read extended per table (`ENTITY_COLUMNS`) — leads and contacts have
  different address columns; leads alone have `lat`/`lng`.
- **`checkVendorBudget` pre-flight added.** The drain previously metered spend
  only AFTER the call and would run a whole batch past an exhausted cap.
  Dynamically imported (`budget-gate.ts` is `server-only`).
- free lane runs FIRST whenever the row has address parts, metered at $0,
  persisted into `enrichment_profile.osint_free` (+ `leads.lat/lng` when empty).
- free-only rows terminate before any spend; unreachable free providers →
  retry with a named reason, never a silent "completed".
- paid-withheld rows → `status: 'skipped'`, `person_enrichment: 'withheld_budget'`,
  counted in a new `paidWithheld` counter, never in `succeeded`.
- every result carries `lane`, and `leads.enrichment_provider` records the lane.

### 5. Ledger (`lib/vendor-governance/`)

- `VENDOR_PRICING['osint_free']` at **$0/api_call** — without it,
  `normalizeVendorCost`'s $0.01/unit unknown-vendor fallback would invent spend.
- `inferUsageType` learns `osint` → `api_calls`.
- **Pre-existing 10x under-report fixed**: the drain metered `vendor: 'PeopleData'`,
  which matches no pricing row, so PeopleData was priced at $0.01 instead of $0.10
  in the same ledger `checkVendorBudget` reads. Now lowercase `'peopledata'`, matching
  `lib/enrichment/contact-enrichment-core.ts`.

### 6. Proof

`scripts/enrichment-suppression-simulator.ts` (already in the `guard` chain as
`test:enrichment-suppression`) gained a `freeOsintLaneLayer()` section — 33 checks
over the routing table, the withheld-paid semantics, the $0 pricing, the drain's
selection order, the lane stamps, availability honesty, and the DECOMMISSIONED set.
**198 passed, 0 failed.**

`npx tsx scripts/orphan-export-guard.ts` → PASS, `lib/external/nominatim-geocode.ts`
burned down 3 → 2 (`geocodeOne` is now wired into `osint-neighborhood.ts`).

## Live verification (2026-08-09)

Run against the real connectors from this container: all three answered HTTP 403
(the sandbox agent proxy blocks these hosts). That is the exact case this wave
exists to get right, and the lane reported it correctly:

```
reachable: false
unavailable: ["nominatim unreachable (HTTP 403)", "census unreachable (HTTP 403)", ...]
describe:   "free OSINT lane UNAVAILABLE — nominatim unreachable (HTTP 403); ..."
```

NOT "no data for this address". The happy path could not be exercised from this
container (no allowlist for openstreetmap.org / census.gov through the proxy);
the parse layer is covered by the pre-existing pure `parseNominatimRow` tests.

## Status log
- [x] Read the three free modules + posture + orchestrator + cost normalizer
- [x] Design the selection mechanism (capability-keyed, no toggle)
- [x] Free-lane provider module with availability honesty
- [x] Wire selection into the orchestrator (free-first + budget pre-flight)
- [x] $0 pricing row + PeopleData key fix
- [x] Posture registry unchanged / no decommissioned provider added
- [x] Proof wired into the guard chain
- [ ] Fold the third inline Nominatim copy out of `lib/property/enrichment-chain.ts`
      (survivor `lib/external/nominatim-geocode.ts:geocodeOne`) — other agent's file
