// lib/providers/provider-capability-matrix.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PROVIDER CAPABILITY MATRIX — every provider the owner can CHOOSE, in the directive's thirteen columns (wave 153,
// lane 153G — directive G1; owner ruling 12, 2026-11-14: "all scrapers and provider connection need to be checked and
// implemented so there are outside provider choices. rentcast and zenrows/zyte/versium etc. exa searches for content and
// for people (raw leads)."). PURE: no client, no network, no credential read, no `server-only`.
//
// NOT A SECOND REGISTRY (OS-CONSTITUTION law 1 / law 2). What other survivors already declare is DERIVED here, never
// re-typed: activation / rights (lib/ai-isa/property-lookup-rail.ts PROVIDER_ACTIVATION via the scorecard), commercial
// rights (lib/providers/provider-scorecard.ts PROVIDER_COMMERCIAL_FACTS), the tenancy model (lib/providers/tenancy-matrix.ts
// PROVIDER_TENANCY), the tenant-owned connector (lib/providers/tenant-provider-connections.ts TENANT_ACQUISITION_PROVIDERS),
// the page transports' documented checkpoint facts (lib/providers/scrape-checkpoint.ts SNAPSHOT_TRANSPORT_FACTS). What no
// survivor carried — the producer door, the mapper, the preview, the documented incremental support and the proof for each
// provider — is declared ONCE below as CODE ANCHORS (module + symbol), and scripts/provider-gap-matrix-guard.ts §J verifies
// every anchor in stripped source, every proof in package.json, and re-derives every honest state. A row whose transport is
// absent cannot read "simulated"; a row with no live evidence cannot read "ready".
//
// THE HONEST STATE (per ROUTE — platform connector and tenant-owned connector are judged apart), the FIRST unmet step wins:
//   unavailable       no transport in this repo and the provider was never evaluated for this deployment
//   awaiting_license  no transport because the platform keeps the provider dormant pending rights (written terms first)
//   awaiting_key      transport + offline proof exist, but the route's credential is held by an owner decision (a dormant
//                     survivor's platform account: its doors wait on the owner's confirmation)
//   simulated         transport + producer + offline proof exist and the route is permitted; what remains is the owner's
//                     provisioned credential and a first live call (L-level certification — docs/operations/PROVIDER-CERTIFICATION.md)
//   ready             a live call with a real credential is on record — NONE today (no credential exists in this environment)
// Product reader: the platform connector-healing console (app/dashboard/superadmin/connector-healing/page.tsx). The doc
// docs/operations/PROVIDER-SELECTION-WAVE151.md §9–§10 is rendered from it by scripts/provider-gap-matrix-guard.ts.

import { PROVIDER_ACTIVATION, PROVIDER_COMMERCIAL_FACTS, PROVIDER_RECOMMENDATION, PROVIDER_FIELD_SCORECARD, PROVIDER_SELECTION_STATUS, formatUnitUsd, type ScorecardProvider } from "@/lib/providers/provider-scorecard"
// Wave 154 (lane 154J): the J6 pilot extends the existing matched-cohort design (same page-reachable module set — no new module).
import { MATCHED_COHORT_DESIGN, projectMonthlyWaterfall } from "@/lib/providers/provider-pilot"
import { TENANT_ACQUISITION_PROVIDERS } from "@/lib/providers/tenant-provider-connections"
import { PROVIDER_TENANCY } from "@/lib/providers/tenancy-matrix"
import { SNAPSHOT_TRANSPORT_FACTS } from "@/lib/providers/scrape-checkpoint"

type HonestState = "ready" | "simulated" | "awaiting_license" | "awaiting_key" | "unavailable"
type AcquisitionKind = "person" | "property" | "market" | "content"
interface Anchor { module: string; symbol: string }

interface CapabilityFacts {
  provider: string
  label: string
  /** The scorecard row it joins (activation, rights, commercial facts), when it is one of the C39 data providers. */
  scorecard: ScorecardProvider | null
  /** The PROVIDER_TENANCY row it joins (the scrapers share one row). */
  tenancyKey: string | null
  kinds: readonly AcquisitionKind[]
  /** Column 2 — the vendor's actual endpoint / feature and contract (documentation read, date in the citation). */
  endpoint: string
  transport: Anchor | null
  /** Column 5 — the producer entry: THE ONE RawData door for persons; the property / market producers; research for content. */
  producer: { door: "rawdata" | "property" | "market" | "research" | "enrichment" | "none"; anchor: Anchor | null; path: string }
  /** Column 6 — field mapping + provenance. */
  mapping: { anchor: Anchor | null; provenance: string }
  /** Column 7 — preview / count before a paid pull. */
  preview: { kind: "free_estimate" | "observed_count" | "documented_no_transport" | "not_offered" | "not_applicable"; anchor: Anchor | null; note: string }
  /** Column 8 — activity freshness and dedup. */
  freshnessDedup: string
  /** Column 9 — incremental paging / cursor / change support ACTUALLY documented (none invented). */
  incremental: string
  /** Column 10 — rate limits, retries, webhooks, idempotency, cost. */
  limitsCost: string
  /** Column 11 for a provider outside the scorecard (the scorecard's own commercial facts are derived otherwise). */
  rights: string | null
  /** Column 12 — the offline proof that drives the path (package.json script), and the adverse cases it holds. */
  proof: { script: string | null; adverse: string }
  /** The tenant-owned route as the owner RULED it (a tenant key where the ruling and a transport allow). */
  tenantRoute: "built" | "ruled_out" | "no_transport" | "not_offered"
  /** A live call with a real credential is on record (none in this environment). */
  liveEvidence: string | null
  /** Was the provider evaluated for this deployment (documentation read)? */
  evaluated: boolean
  /** Wave 154 (lane 154J): the credential NAMES for a row outside the scorecard (absent → the scorecard / legacy list). */
  envVars?: readonly string[]
  /** Wave 154 (lane 154J): the platform half of column 1 when "keyless / platform" would mislead (a tenant-only grant). */
  connectorOverride?: string
}

const A = (module: string, symbol: string): Anchor => ({ module, symbol })
const CK = SNAPSHOT_TRANSPORT_FACTS

const FACTS: readonly CapabilityFacts[] = Object.freeze([
  {
    provider: "rentcast", label: "RentCast", scorecard: "rentcast", tenancyKey: "rentcast", kinds: ["property", "market"],
    endpoint: "REST v1 (vendored OpenAPI lib/external/_generated/rentcast-openapi.ts): /properties (record + sale history; saleDateRange = recorded sales), /markets (ZIP LISTING statistics), /listings/sale + /listings/rental (listing records), /avm/value (+ comparable listings)",
    transport: A("lib/property/rentcast.ts", "getRentcastPropertyRecord"),
    producer: { door: "property", anchor: A("lib/avm/provider-chain.ts", "getAreaSoldRecords"), path: "property facts / AVM → requestPropertyValuation + getPropertyRecordWithFallback; recorded sales → getAreaSoldRecords → the market report (lib/market-reports/research.ts researchMarket); listing records → the Shopping Agent (lib/property/external-listings-search.ts searchExternalListings, only when the tenant has no connected IDX)" },
    mapping: { anchor: A("lib/property/rentcast-normalize.ts", "normalizeRentcastMarketStats"), provenance: "RENTCAST_DATA_TYPES labels every figure by kind (recorded sale vs listing statistic vs listing record); the listing's MLS name is shown as its source" },
    preview: { kind: "not_applicable", anchor: null, note: "a per-request read of a known address / ZIP (no list purchase); budget-gated and metered per tenant (meterCall)" },
    freshnessDedup: "record 30 d / AVM 14 d / markets 7 d caches (RENTCAST_CACHE_TTL_DAYS); listing references purged after 3 d; listing freshness window owed before display",
    incremental: "documented FILTERS, no change feed: saleDateRange (days since last sale), daysOld / lastSeenDate on listings — each read is a bounded query, never a cursor",
    limitsCost: "≤ 500 rows a request; $0.074 a request (Foundation, RENTCAST_USD_PER_REQUEST); one platform key, per-tenant metering + vendor budget gate; no webhook",
    rights: null,
    proof: { script: "test:rentcast-platform", adverse: "unconfigured key, budget gate refusal, IDX tenant answered without spend" },
    tenantRoute: "ruled_out", liveEvidence: null, evaluated: true,
  },
  {
    provider: "versium", label: "Versium", scorecard: "versium", tenancyKey: null, kinds: ["person"],
    endpoint: "REST v2 (api-documentation.versium.com): Contact Append, Demographic / financial append, Online Presence (real-estate indicators), B2B2C crosswalk, B2C ListGen Estimates (a COUNT), Online Audience Append (hashed match ids); REACH MCP is OAuth-only (WAITING_EXTERNAL)",
    transport: A("lib/external/versium-client.ts", "appendVersiumContact"),
    producer: { door: "enrichment", anchor: A("lib/kernel/lookalike-audience.ts", "runLookalikeResearch"), path: "appends onto a record already held (owner_contact rung 1 on the property-lookup rail; online presence / audience estimate on the lookalike research) — gap-only, never a list purchase" },
    mapping: { anchor: A("lib/lead-pipeline/enrichment-column-map.ts", "demographicsFromProfile"), provenance: "per-field provenance (retrieved_at, provider) on every appended field; protected demographic values are dropped" },
    preview: { kind: "free_estimate", anchor: A("lib/external/versium-client.ts", "VERSIUM_PRODUCT_MATRIX"), note: "B2C ListGen Estimates — free, returns an estimated COUNT, never contacts (counts ≠ delivered contacts)" },
    freshnessDedup: "vendor refresh cadence unpublished; gap-only append (a field already held is not re-bought; provider-dedup freshness window)",
    incremental: "none documented (point-in-time append and estimate APIs)",
    limitsCost: "billed per MATCHED output (VERSIUM_MATCH_CREDIT_USD); a no-match is free; 400/401/402/403/429 named; job callback_url is unsigned",
    rights: null,
    proof: { script: "test:versium-capability-matrix", adverse: "estimate is a count not contacts; Online Audience Append is not targeting; protected fields dropped" },
    tenantRoute: "not_offered", liveEvidence: null, evaluated: true,
  },
  {
    provider: "exa", label: "Exa", scorecard: null, tenancyKey: "exa", kinds: ["person", "content", "market"],
    endpoint: "exa-js SDK: /search (structured JSON-schema summary, startPublishedDate), Search Monitors (pushed deltas to a signed webhook). Lane 154B: Google-indexed public pages are reached THROUGH Exa; the Google Custom Search JSON API is not used (withdrawn for existing users by 2027-01-01) and no search-result page is scraped (lib/providers/exa/hunting.ts GOOGLE_INDEXED_DISCOVERY_ROUTE)",
    transport: A("lib/providers/exa/client.ts", "structuredSearch"),
    producer: { door: "rawdata", anchor: A("lib/acquisition-plays/public-request.ts", "runPublicRequestPlay"), path: "PERSON: grounded candidate (URL + date + quote, the author's own first-person need or request, a contact point the author published on a public page) → existing-Contact check → pre-pull dedup → THE ONE RawData producer → Raw Lead gate → Lead → AI ISA; CONTENT / MARKET / PERMITS: lib/lead-pipeline/exa-sourcer.ts, the moving-corridor radar and the permit sourcer → research / market intelligence / property events, never the Lead door" },
    mapping: { anchor: A("lib/external/exa-client.ts", "normalizeExaRow"), provenance: "groundedEvidence: source URL, published date, retrieval time, ≤ 280-char quoted basis (lib/providers/exa/hunting.ts)" },
    preview: { kind: "not_applicable", anchor: null, note: "a search is the call (numResults bounds it); monitors replace repeated searches" },
    freshnessDedup: "freshnessProblem per play window; one result per page across searches; the RawData idempotency key on the Exa result id",
    incremental: "Search Monitors push deltas (createSearchMonitor / getSearchMonitorRun); startPublishedDate bounds a search — documented, no cursor fabricated",
    limitsCost: "$7 / 1k searches (≤ 10 results) list price, the SDK's costDollars.total booked when present; webhook signature + timestamp tolerance + replay protection (EXA_SIGNATURE_TOLERANCE_SEC)",
    rights: "Exa returns pages it does not license for reuse — only a cited ≤ 280-char excerpt is kept; owner ruling B4: public → usable at the AUTHOR's own published contact point (never the channel, never a deanonymized handle); Nextdoor LICENSE_REQUIRED; Exa is not a contact append",
    proof: { script: "test:early-opportunity-plays", adverse: "no key → nothing invented; ungrounded / handle-only / third-party / forum candidate refused from the person path; content kept off the Lead door" },
    tenantRoute: "not_offered", liveEvidence: null, evaluated: true,
  },
  {
    provider: "apify", label: "Apify", scorecard: null, tenancyKey: "scrapers", kinds: ["person", "property"],
    endpoint: "REST v2 / SDK: run an Actor (actor.call), GET /v2/actor-runs/{runId}, GET /v2/datasets/{id}/items?offset=&limit=",
    transport: A("lib/providers/apify/client.ts", "runActorSyncGetDatasetItems"),
    producer: { door: "rawdata", anchor: A("lib/external/apify-actors.ts", "runApifyTask"), path: "an approved Actor per source (ACTOR_REGISTRY) → the social / FSBO sourcers → THE ONE RawData producer" },
    mapping: { anchor: A("lib/lead-pipeline/social-sourcer.ts", "normalizeNextdoorPost"), provenance: "per-source normalizers stamp source + source_record_id + sourceUrl; the producer envelope carries rights and proof URLs" },
    preview: { kind: "not_offered", anchor: null, note: "no count endpoint documented before a run" },
    freshnessDedup: "per-source recency windows at the producer; the run cursor's offset reads an item once; the RawData idempotency key",
    incremental: "the RUN CURSOR (run id + dataset + offset — what Apify documents; wave 152) and an Actor's own incremental input where it documents one (FSBO monitoringMode)",
    limitsCost: "billed per Actor run (compute units); a started run is never followed by a second candidate; 3-attempt cap, 7-day dataset retention retirement",
    rights: "Actor terms + each target page's terms — forum / social sources are CONTESTED (lib/intent/movement-source-registry.ts); collection infrastructure, not a license to a site's data",
    proof: { script: "test:scrapers", adverse: "unfinished run drained from its offset, billed run never re-bought, unreadable cursor ledger starts no paid run" },
    tenantRoute: "ruled_out", liveEvidence: null, evaluated: true,
  },
  {
    provider: "zyte", label: "Zyte API", scorecard: null, tenancyKey: "scrapers", kinds: ["person", "property"],
    endpoint: "POST https://api.zyte.com/v1/extract — httpResponseBody | browserHtml, httpResponseHeaders, customHttpRequestHeaders (HTTP mode only)",
    transport: A("lib/external/zyte-client.ts", "scrapeWithZyte"),
    producer: { door: "rawdata", anchor: A("lib/providers/scrape-checkpoint.ts", "fetchCheckpointedSnapshot"), path: "PURPOSE (real_estate_need_chatter | fsbo_listing only — any other refused by name, owner ruling B3) → robots + terms + spend gate → the snapshot checkpoint → the page parsers → only records new inside the rescan window → THE ONE RawData producer → commit" },
    mapping: { anchor: A("lib/lead-pipeline/scraper-parsers.ts", "parseBuyerSavedSearches"), provenance: "the page parsers stamp site + a stable source_record_id; the producer envelope carries rights (transport terms + page terms)" },
    preview: { kind: "not_offered", anchor: null, note: "a single-page fetch — no count before the request" },
    freshnessDedup: "page content digest vs the PROCESSED watermark; record digests inside the bounded rescan window; the RawData idempotency key",
    incremental: `cursor: ${CK.zyte.cursor} documented — snapshot checkpoint instead; conditional requests: ${CK.zyte.conditionalRequests.how}; validators: ${CK.zyte.responseHeaders}`,
    limitsCost: `${CK.zyte.billing}; per-domain tier pricing (ZYTE_REQUEST_COST_USD estimate); retry ${CK.zyte.retryStatuses.join("/")}, hold ${CK.zyte.holdStatuses.join("/")}; bounded timeout; per-tick fetch budget`,
    rights: "transport only, for need chatter and FSBO only — the target page's terms govern: portal / classified / forum hosts are HELD unless a written agreement is recorded; Nextdoor LICENSE_REQUIRED; robots.txt honoured (RFC 9309)",
    proof: { script: "test:scrapers", adverse: "unchanged page forwards nothing, replay is one observation, robots / terms / spend / tick budget / unreadable checkpoint hold before spend, 429 backoff, 401 hold, timeout" },
    tenantRoute: "ruled_out", liveEvidence: null, evaluated: true,
  },
  {
    provider: "zenrows", label: "ZenRows", scorecard: null, tenancyKey: "scrapers", kinds: ["person", "property"],
    endpoint: "GET https://api.zenrows.com/v1/?url= (official SDK `zenrows`) — js_render, premium_proxy, custom_headers, original_status; X-Request-Cost; target headers prefixed Zr-",
    transport: A("lib/providers/zenrows/client.ts", "scrapePage"),
    producer: { door: "rawdata", anchor: A("lib/providers/scrape-checkpoint.ts", "fetchCheckpointedSnapshot"), path: "the same snapshot checkpoint as Zyte (the picker chooses the transport per host; the checkpoint is per TARGET)" },
    mapping: { anchor: A("lib/lead-pipeline/scraper-parsers.ts", "parsePropertySearchResults"), provenance: "as Zyte" },
    preview: { kind: "not_offered", anchor: null, note: "a single-page fetch — no count before the request" },
    freshnessDedup: "as Zyte (one checkpoint per target)",
    incremental: `cursor: ${CK.zenrows.cursor} documented — snapshot checkpoint instead; conditional requests: ${CK.zenrows.conditionalRequests.how}; validators: ${CK.zenrows.responseHeaders}`,
    limitsCost: `${CK.zenrows.billing}; X-Request-Cost booked as the FINAL cost when present; retry ${CK.zenrows.retryStatuses.join("/")}, hold ${CK.zenrows.holdStatuses.join("/")}`,
    rights: "transport only — as Zyte",
    proof: { script: "test:scrapers", adverse: "as Zyte, plus the 402 quota status carried to the hold rule and wait_for no longer sent as a load state" },
    tenantRoute: "ruled_out", liveEvidence: null, evaluated: true,
  },
  {
    provider: "batchdata", label: "BatchData", scorecard: "batchdata", tenancyKey: "batchdata", kinds: ["person", "property"],
    endpoint: "REST v1/v3 (developer.batchdata.com): property search + quicklists, property lookup, skip trace, Smart Search push webhook; MCP for DNC/TCPA",
    transport: A("lib/external/batchdata-client.ts", "BatchDataClient"),
    producer: { door: "rawdata", anchor: A("lib/lead-pipeline/pooled-pull.ts", "runPooledBatchDataLane"), path: "platform: the pooled lane → THE ONE RawData producer; tenant-owned: the signed Smart Search door (ingestTenantWebhookDelivery) → pre-pull dedup → hydrate only new → the producer" },
    mapping: { anchor: A("lib/lead-pipeline/enrichment-column-map.ts", "batchDataPropertyEnrichmentToLeadColumns"), provenance: "the vendor event id anchors the m961 idempotency key; field provenance on enrichment" },
    preview: { kind: "observed_count", anchor: A("lib/lead-pipeline/source-discovery-planner.ts", "previewsFromObservedSearchCounts"), note: "BatchData documents NO free count-only endpoint (it bills per returned record); the planner reuses the resultsFound count BatchData already returned on this territory's last paid pull — no new call — beside the cost / freshness preview (previewAggregateList); a count, never contacts" },
    freshnessDedup: "planPrePullDedup before every paid per-property lookup (known source id / person / property / fresh prior answer)",
    incremental: "Smart Search push (property-change events, signed per connection) — documented; list pulls are bounded queries",
    limitsCost: "annual plans; $0.07 / skip-trace match, $0.05 / property record (published); per-connection daily cap for tenant keys",
    rights: null,
    proof: { script: "test:tenant-provider-connections", adverse: "two tenants never cross; replay = one observation; revoked / 401 / quota / daily cap recover as ruled" },
    tenantRoute: "built", liveEvidence: null, evaluated: true,
  },
  {
    provider: "peopledata", label: "People Data Labs", scorecard: "peopledata", tenancyKey: "peopledata", kinds: ["person"],
    endpoint: "REST v5 Person Enrichment + Email Validation (docs.peopledatalabs.com)",
    transport: A("lib/providers/peopledata/client.ts", "enrichPerson"),
    producer: { door: "enrichment", anchor: A("lib/lead-pipeline/enrichment-column-map.ts", "buildPeopleDataProfile"), path: "the person_profile route on the property-lookup rail (owner_contact rung 3) — appends to a held record" },
    mapping: { anchor: A("lib/lead-pipeline/enrichment-column-map.ts", "peopleDataContactPointProvenance"), provenance: "contact-point provenance per field" },
    preview: { kind: "not_offered", anchor: null, note: "per-match enrichment of a known person" },
    freshnessDedup: "PROVIDER_FRESHNESS_DAYS — a fresh answer is never re-bought",
    incremental: "none documented",
    limitsCost: "one credit per SUCCESSFUL match (a 404 no-match is free); PEOPLEDATA_MATCH_COST_USD",
    rights: null,
    proof: { script: "test:provider-waterfall", adverse: "dormant survivor routed only while its doors wait; a dormant-closed door is skipped" },
    tenantRoute: "not_offered", liveEvidence: null, evaluated: true,
  },
  ...(["tracerfy", "datazapp", "propertyradar", "data_axle"] as const).map((p): CapabilityFacts => ({
    provider: p, label: p === "data_axle" ? "Data Axle" : p === "propertyradar" ? "PropertyRadar" : p === "datazapp" ? "DataZapp" : "Tracerfy", scorecard: p, tenancyKey: null,
    kinds: p === "propertyradar" ? ["property", "person"] : p === "data_axle" ? ["person", "market"] : ["person"],
    endpoint: p === "tracerfy" ? "REST (Bearer) + MCP + a free mock sandbox (mock.tracerfy.com); Normal / Advanced Trace, DNC scrub, Property Monitors" : p === "datazapp" ? "HTTPS POST JSON (ApiKey in the body): Email / Phone / Demography Append" : p === "propertyradar" ? "REST (owner-installed propertyradar-api playbook): property search with Purchase=0 preview counts; persons Purchase=1" : "no product chosen — no field-level documentation read",
    transport: null,
    producer: { door: "none", anchor: A("lib/providers/dormant-adapters.ts", "mapDormantProviderResponse"), path: "none — the documented-fields mapper only; no request is built anywhere" },
    mapping: { anchor: A("lib/providers/dormant-adapters.ts", "mapDormantProviderResponse"), provenance: "documented keys only; an undocumented score is never labelled" },
    preview: p === "propertyradar" ? { kind: "documented_no_transport", anchor: A("lib/investor/rei-playbook.ts", "investorPlay"), note: "Purchase=0 totalResultCount is free and documented — used as methodology, no transport sends it" } : { kind: "not_offered", anchor: null, note: "no preview documented" },
    freshnessDedup: "n/a — nothing is ingested",
    incremental: p === "tracerfy" ? "Property Monitors with a webhook are documented — not built (no transport)" : "none documented",
    limitsCost: p === "tracerfy" ? "batch 10 submissions / 5 min, instant 500 / min; 1 credit a hit, misses free" : p === "datazapp" ? "prepaid ($1,000 minimum after a $125 test — a purchase); phone scrub 1 request / s" : p === "propertyradar" ? "Purchase=0 consumes no quota; Purchase=1 spends credits at an unpublished price" : "unknown",
    rights: null,
    proof: { script: "test:provider-scorecard", adverse: "license unknown blocks activation, never offline simulation; no route row → unreachable live" },
    tenantRoute: "no_transport", liveEvidence: null, evaluated: true,
  })),
  {
    // Wave 153 (lane 153M, owner ruling B1): People Data BUILT — the transport, the RawData producer and the offline proof exist;
    // both routes stay dormant pending rights (PROVIDER_ACTIVATION.datafiniti) and no live call is on record. Property Data is
    // NOT built (owner asked for People Data; a property record is RentCast's survivor).
    provider: "datafiniti", label: "Datafiniti", scorecard: "datafiniti", tenancyKey: "datafiniti", kinds: ["person"],
    endpoint: "People Data REST v4 (docs.datafiniti.co, read 2026-11-16): POST https://api.datafiniti.co/v4/people/search (Bearer token; query in Datafiniti / Lucene syntax, num_records ≤ 10 non-download, format json|csv, download, view) → num_found / total_cost / records / download_id; GET /v4/account (free credit read); MCP df_download_status (queued | running | completed | cancelled, links 7 days). Property Data endpoints exist but are not built here",
    transport: A("lib/external/datafiniti-client.ts", "searchDatafinitiPeople"),
    producer: { door: "rawdata", anchor: A("lib/lead-pipeline/datafiniti-people-producer.ts", "runDatafinitiPeoplePull"), path: "rights gate (activation / tenant connection) → known keys → pre-pull dedup of held candidates → free count → paid-pull gate (paidPullApproval with the door context) → typed search / download → documented-schema mapper → grounded only → dedup again at ingress → THE ONE RawData producer (ingestRawSourceBatch, source datafiniti_people) → Raw Lead gate → Lead → AI ISA; never a Contact, never outreach" },
    mapping: { anchor: A("lib/lead-pipeline/datafiniti-people-producer.ts", "mapDatafinitiPerson"), provenance: "per-field provenance (vendor field, dateUpdated / lastDateSeen, retrieved_at); work location labelled as work (schema), never as a property address; sourceURLs kept as proof; tcpa-flagged phones suppressed; deceased records refused" },
    preview: { kind: "free_estimate", anchor: A("lib/external/datafiniti-client.ts", "countDatafinitiPeople"), note: "num_records: 0 returns num_found at 0 credits (paid accounts only — a trial may refuse it: preview UNAVAILABLE, never assumed); a count, never contacts" },
    freshnessDedup: "dateUpdated ages the record (owner_profile_pull class: fresh 90 d / stale 365 d); planPrePullDedup before the paid pull (held candidates) and again on the returned records; the RawData idempotency key on the Datafiniti record id / key",
    incremental: "dateUpdated range filter (updatedSince) — the vendor page names 'change detection using update timestamps'; bulk download with a download_id checkpoint; the REST paginate request shape was not documented to us — not built",
    limitsCost: "one credit per record returned (num_records caps the charge; 0 found = 0 credits); count 0 credits; 400 'exceed credit allotment' = quota (no retry); 429 retried with backoff; a paid 5xx is OUTCOME UNKNOWN — reconciled against the free account read, never blindly re-sent; booked once per request / download_id",
    rights: null,
    proof: { script: "test:datafiniti-connector", adverse: "count books nothing; credits booked once; quota / 429 / 500 / invalid token; two-tenant key isolation with no platform fallback; rights missing → not activated; replay = no new RawData and no second charge; person/property collision; stale source date held; no outreach" },
    tenantRoute: "built", liveEvidence: null, evaluated: true,
  },
  {
    provider: "idxbroker", label: "IDX / MLS (IDX Broker)", scorecard: null, tenancyKey: "idxbroker", kinds: ["property"],
    endpoint: "IDX Broker API (middleware.idxbroker.com/docs): the tenant's own MLS board feed — active listings / property search",
    transport: A("lib/idxbroker-client.ts", "IDXBrokerClient"),
    producer: { door: "property", anchor: A("lib/property/external-listings-search.ts", "searchExternalListings"), path: "the Shopping Agent's source order tenant_listing → idx_mls → rentcast_listing (a connected IDX wins and is exclusive); market reports read MLS-synced closed sales first" },
    mapping: { anchor: A("lib/property/external-listings-search.ts", "BUYER_LISTING_SOURCE_ORDER"), provenance: "rows are feed_active under the tenant's board; the MLS is named as the source" },
    preview: { kind: "not_applicable", anchor: null, note: "the tenant's own subscription — no per-record purchase" },
    freshnessDedup: "feed-active rows; saved-home origin idx_mls",
    incremental: "no change feed used; BulkData (a separate agreement + MLS approval) is not held",
    limitsCost: "the tenant pays its own IDX / MLS bill (USER_CONNECTED_VENDOR); the platform key is the floor, never the ceiling",
    rights: "the tenant's MLS board IDX rules govern display; photos are display-time only — no platform photo ingest (row 84)",
    proof: { script: "test:idx-tenant-credential", adverse: "the most specific connected account wins; no cross-tenant read" },
    tenantRoute: "built", liveEvidence: null, evaluated: true,
  },
  {
    provider: "tavily", label: "Tavily", scorecard: null, tenancyKey: null, kinds: ["content"],
    endpoint: "REST search + answer (tavily.com)",
    transport: A("lib/external/tavily-client.ts", "tavilySearch"),
    producer: { door: "research", anchor: A("lib/lead-pipeline/tavily-sourcer.ts", "sourceTavilyIntent"), path: "web research / intent discovery (cited results); the healer's provider-setup research" },
    mapping: { anchor: A("lib/external/tavily-client.ts", "normalizeTavilyRow"), provenance: "result URL + title + snippet" },
    preview: { kind: "not_applicable", anchor: null, note: "a search is the call" },
    freshnessDedup: "per-source recency window at the producer",
    incremental: "none documented",
    limitsCost: "credits per search (TAVILY_CREDITS_PER_SEARCH basic 1 / advanced 2; TAVILY_CREDIT_USD)",
    rights: "search API terms not read for redistribution — cited research only",
    proof: { script: "test:scrapers", adverse: "normalizer drops non-viable rows" },
    tenantRoute: "not_offered", liveEvidence: null, evaluated: true,
  },
  {
    provider: "public_records", label: "Public records (Socrata / ArcGIS permits)", scorecard: null, tenancyKey: null, kinds: ["property", "market"],
    endpoint: "Socrata SODA 2.1 (per-city datasets) and ArcGIS FeatureServer query (public permit layers) — keyless",
    transport: A("lib/external/socrata-client.ts", "recentPermits"),
    producer: { door: "property", anchor: A("lib/external/permit-signals.ts", "matchPermitsToLeads"), path: "permit / violation events matched to properties already held (property facts, never a person invented)" },
    mapping: { anchor: A("lib/external/permit-signals.ts", "readPermitEventDate"), provenance: "dataset id + permit id + the event date as the source states it" },
    preview: { kind: "not_applicable", anchor: null, note: "free public data" },
    freshnessDedup: "the source's own event date; per-permit id",
    incremental: "date-window queries ($where on the dataset's date field / buildArcgisDateWhere) — documented query filters, no cursor",
    limitsCost: "free (an app token raises the Socrata rate limit only)",
    rights: "public open data under each city's dataset terms",
    proof: { script: "test:external-signal-lanes", adverse: "field-name validation refuses an injected SoQL field" },
    tenantRoute: "not_offered", liveEvidence: null, evaluated: true,
  },
  // ── Wave 154 (lane 154J — directive J2 "plus Google Trends, Search Console and the Meta / Apify actors this wave touched") ──
  {
    provider: "google_trends", label: "Google Trends API", scorecard: null, tenancyKey: null, kinds: ["content", "market"],
    endpoint: "Google Trends API ALPHA (developers.google.com/search/apis/trends, read 2026-11-18): consistently scaled interest (not the website's 0–100), rolling 5 years, daily / weekly / monthly / yearly, region + sub-region — access-limited alpha by application; no price published",
    transport: null,
    producer: { door: "research", anchor: A("lib/content-intel/search-demand.ts", "trendsProducer"), path: "a trend point → trendIdea (a REWORDED demand topic with a relative-interest evidence label) → the ONE topic intake (content_topic_bank) — topics only, never a person, never a search volume" },
    mapping: { anchor: A("lib/content-intel/search-demand.ts", "trendIdea"), provenance: "geo the source states + observed / published dates + evidence kind 'proxy' (relative interest), never an absolute count" },
    preview: { kind: "not_applicable", anchor: null, note: "a read of an aggregate index — nothing is bought" },
    freshnessDedup: "topic TTL 14 d at the producer; the topic intake's dedup key merges a repeated idea",
    incremental: "date-range reads of an aggregate series (documented aggregation windows) — no cursor",
    limitsCost: "UNKNOWN — the alpha publishes no price and no quota; productionTrendsTransport() returns null (no grant on record)",
    rights: "aggregate, anonymous interest — it can NEVER yield a searcher's identity (owner ruling R5b); trends.google.com is never scraped",
    proof: { script: "test:google-intelligence", adverse: "no transport → not_connected, zero topics, none invented; a relative index never renders as a search count" },
    tenantRoute: "not_offered", liveEvidence: null, evaluated: true, envVars: [],
  },
  {
    provider: "search_console", label: "Google Search Console API", scorecard: null, tenancyKey: null, kinds: ["content", "market"],
    endpoint: "Search Console API v1 searchanalytics.query (developers.google.com/webmaster-tools, limits page read 2026-11-18): the TENANT'S OWN verified site — queries / pages / clicks / impressions, aggregated; OAuth scope webmasters.readonly",
    transport: null,
    producer: { door: "research", anchor: A("lib/content-intel/search-demand.ts", "searchConsoleProducer"), path: "the tenant's own site rows → whitelistSearchConsoleRow → reworded demand topics → the ONE topic intake — website intelligence, never a visitor and never a searcher" },
    mapping: { anchor: A("lib/content-intel/search-demand.ts", "whitelistSearchConsoleRow"), provenance: "field-by-field whitelist (query, page, clicks, impressions, ctr, position) + the site URL + the report window; anonymized-query caveats carried (searchConsoleCaveats)" },
    preview: { kind: "not_applicable", anchor: null, note: "the tenant's own analytics — nothing is bought" },
    freshnessDedup: "report window per read; the topic intake's dedup key",
    incremental: "date-range queries (startDate / endDate) — documented; no cursor",
    limitsCost: "no price published on the limits page (UNKNOWN as a quote); published quotas: Search Analytics 1,200 QPM per site and per user, 30,000,000 QPD per project",
    rights: "the tenant's own site data under the tenant's own Google grant; aggregate queries only — never a searcher's identity (owner ruling R5b)",
    proof: { script: "test:google-intelligence", adverse: "no transport → not_connected (zero rows); unknown fields dropped by the whitelist" },
    tenantRoute: "no_transport", liveEvidence: null, evaluated: true, envVars: [],
    connectorOverride: "platform: none — the tenant's OWN Google OAuth grant (webmasters.readonly) on its own verified site; no platform key exists or is wanted",
  },
  {
    provider: "apify_idea_actors", label: "Apify idea actors (public Facebook groups / Meta Ad Library)", scorecard: null, tenancyKey: "scrapers", kinds: ["content"],
    endpoint: "apify/facebook-groups-scraper and apify/facebook-ads-scraper (public actor pages + API metadata read by lane 154C, 2026-11-18 — APIFY_IDEA_ACTORS); run through the same Apify run API",
    transport: A("lib/providers/apify/client.ts", "runActorSyncGetDatasetItems"),
    producer: { door: "research", anchor: A("lib/content-intel/public-chatter-topics.ts", "normalizeApifyIdeaItems"), path: "public group posts / public ad creatives → fenced in memory → REWORDED topic or creative idea → the ONE topic intake (rights public_read_reworded) — IDEAS ONLY (owner ruling R3): never RawData, Raw Lead, Lead, Contact, audience or outreach" },
    mapping: { anchor: A("lib/content-intel/public-chatter-topics.ts", "normalizeMetaAdItems"), provenance: "host / URL where permitted + observed / published dates + geography the source states; author, profile, comments and page contact details DROPPED in memory" },
    preview: { kind: "not_offered", anchor: null, note: "no count endpoint documented before a run; apifyIdeaBudgetProblem caps the run first" },
    freshnessDedup: "onlyPostsNewerThan / onlyAdsNewerThan inputs; ad campaigns collapsed by collationId; the topic intake's dedup key",
    incremental: "the actor's own date inputs (documented) — no cursor beyond the Apify run cursor",
    limitsCost: "pay-per-event as published on the actor pages: groups — start $0.001–0.006 + $0.0008–0.005 per post; ads — $0.001–0.0058 per ad (tier-dependent)",
    rights: "public pages only (no login, no cookies, no private group — a credential in the input is refused); Meta's terms for automated collection are the owner's accepted risk for TOPICS only (R1), listed for counsel",
    proof: { script: "test:public-chatter-topics", adverse: "a cookie / private-group input refused; author identity never stored; a first-person post stays ideas-only" },
    tenantRoute: "ruled_out", liveEvidence: null, evaluated: true, envVars: ["APIFY_API_TOKEN"],
  },
])

// ─── THE SOURCE-TO-BUSINESS COLUMNS (wave 154, lane 154J — directive J2) ─────────────────────────────────────────────
//
// What each provider TRULY provides, in ONE category vocabulary that keeps identity, facts, statistics, discovery and
// transport apart (a page transport provides no identity; a trend index provides no person; Exa provides discovery — the
// identity on a grounded person record is the AUTHOR'S own published contact point, not an Exa product). Rights, territory,
// timestamps, credential owner, consumer, recovery and the responsible registered manager are declared once per provider;
// every cell is a fact read (docs + date) or an explicit "UNKNOWN — reason" / "LICENSE-HELD — reason", never blank and never
// an estimate presented as a quote. Costs for the scorecard providers are DERIVED from PROVIDER_FIELD_SCORECARD (published
// units) — never retyped. Cost per USABLE record is UNKNOWN for every provider: it needs a measured usable ratio, and no live
// pull is on record (the J6 pilot measures it). scripts/provider-gap-matrix-guard.ts §K holds every rule below.

type ProvidedCategory =
  | "people" | "contact_field_append" | "property_owner_identity" | "sale_listing_fact" | "sold_comps" | "market_trend"
  | "property_event_record" | "public_web_discovery" | "trend_insight" | "raw_web_transport" | "licensed_listing_photos"
/** J6 — the smallest practical stack, one status per provider (derived from PROVIDER_RECOMMENDATION for scorecard rows). */
type StackTier = "PRIMARY" | "CONDITIONAL_GAP_FILL" | "TENANT_OWNED_OPTION" | "DORMANT" | "LICENSE_HELD" | "NOT_NEEDED"
/** J2 status — LIVE_VERIFIED only with a recorded live call; a registry entry or an activation state named "active" is not one. */
type BusinessStatus = "LIVE_VERIFIED" | "SIMULATED_ONLY" | "PENDING_RIGHTS" | "NO_KEY" | "NO_ACCOUNT" | "UNAVAILABLE"

interface BusinessFacts {
  provides: readonly ProvidedCategory[]
  docs: string
  credentialOwner: "platform" | "tenant" | "either" | "none"
  rights: { resale: string; ai: string; retention: string; outreach: string }
  territory: string
  sourceTimestamps: string
  /** Non-scorecard rows only (scorecard costs are derived). */
  costs?: { perAttempt: string; perMatch: string }
  consumer: string
  failureRecovery: string
  manager: string
  /** Why a row with no transport is not merely "unavailable". */
  noTransportBecause?: "no_account"
  /** Non-scorecard rows only (scorecard rows derive it from PROVIDER_RECOMMENDATION). */
  stack?: { tier: StackTier; why: string }
}

const TERMS_NOT_READ = "UNKNOWN — the vendor terms were not read for this use"
const TRANSPORT_RIGHTS = { resale: "n/a — a transport carries no data license; the TARGET page's terms govern", ai: "the target page's terms govern; fetched text is fenced as untrusted before any model reads it", retention: "page digests + derived records only (snapshot checkpoint); raw pages are not kept", outreach: "never from the transport — a person found on a page passes the RawData producer and the Raw Lead gate first" } as const

const BUSINESS: Readonly<Record<string, BusinessFacts>> = Object.freeze({
  rentcast: { provides: ["property_owner_identity", "sale_listing_fact", "sold_comps", "market_trend"], docs: "developers.rentcast.io (OpenAPI v1 vendored, lib/external/_generated/rentcast-openapi.ts)", credentialOwner: "platform",
    rights: { resale: "API page: 'any use case that is not specifically prohibited under our Terms of Use' — the Terms of Use themselves NOT read (UNKNOWN for SaaS resale)", ai: TERMS_NOT_READ, retention: "repo caches 30 d record / 14 d AVM / 7 d markets; vendor retention terms not read", outreach: "n/a — the owner block is a staff-audience fact, never an outreach list" },
    territory: "US residential (vendor coverage per county unpublished)", sourceTimestamps: "lastSaleDate / listing listedDate / lastSeenDate per record; /markets readings dated per request", consumer: "requestPropertyValuation, getAreaSoldRecords → the market report, searchExternalListings (no IDX)", failureRecovery: "unconfigured key → null + named miss; budget gate refusal → no call; BatchData is the named backup on a miss", manager: "data_steward" },
  versium: { provides: ["people", "contact_field_append"], docs: "api-documentation.versium.com (REST v2)", credentialOwner: "platform",
    rights: { resale: "the STANDARD terms forbid caching / building a database and service-bureau use — signed SaaS terms UNVERIFIED", ai: TERMS_NOT_READ, retention: "standard terms forbid caching; gap-only append keeps only the fields a decision needs", outreach: "appended contact points pass the consent / suppression / TCPA gates before any send — the license for outreach use is UNVERIFIED in the signed terms" },
    territory: "US consumers", sourceTimestamps: "vendor refresh cadence unpublished; retrieved_at stamped per appended field", consumer: "property-lookup rail owner_contact rung 1; lookalike research (estimate = a count)", failureRecovery: "400/401/402/403/429 named; a no-match is free and recorded as a miss", manager: "data_steward" },
  exa: { provides: ["public_web_discovery"], docs: "docs.exa.ai (exa-js SDK: /search, Search Monitors)", credentialOwner: "platform",
    rights: { resale: "Exa returns pages it does not license for reuse — only a cited ≤ 280-char excerpt is kept", ai: "search results are read by the grounded-candidate classifier; the excerpt is the evidence", retention: "excerpt + URL + dates on the evidence; the RawData TTL counts 90 d from the published date", outreach: "only at the AUTHOR's own published contact point after the Raw Lead gate (owner ruling B4); never the channel, never a deanonymized handle" },
    territory: "the open web (any US city named in the search)", sourceTimestamps: "published date per page (an undated page is never a person) + retrieval time", costs: { perAttempt: "$7 per 1,000 searches of ≤ 10 results (published list price; costDollars.total booked when present)", perMatch: "n/a — billed per search, not per match" },
    consumer: "runPublicRequestPlay (persons), exa-sourcer / moving-corridor / permit sourcer (research and market intelligence)", failureRecovery: "no key → nothing invented; ungrounded / handle-only / third-party candidates refused; webhook signature + replay window", manager: "data_steward",
    stack: { tier: "PRIMARY", why: "the ONE public-web discovery route: grounded first-person public statements (R5a) and content / market research; Google-indexed pages are reached through it (the Custom Search JSON API is withdrawn by 2027-01-01)" } },
  apify: { provides: ["raw_web_transport"], docs: "docs.apify.com/api/v2 (run an Actor, actor-runs, datasets items offset / limit)", credentialOwner: "platform",
    rights: { ...TRANSPORT_RIGHTS, resale: "Actor terms + each target page's terms — collection infrastructure, not a license to a site's data" },
    territory: "per Actor input (URLs / geography the source supports)", sourceTimestamps: "per Actor output (post / listing time where the page shows it)", costs: { perAttempt: "billed per Actor run (compute units / pay-per-event per actor page) — UNKNOWN as a per-record quote: it varies by actor and tier", perMatch: "n/a — a run is billed whether or not a record is usable" },
    consumer: "the FSBO / classifieds sourcers → THE ONE RawData producer", failureRecovery: "the run cursor drains an unfinished run from its offset; a billed run is never re-bought; 3-attempt cap", manager: "data_steward",
    stack: { tier: "CONDITIONAL_GAP_FILL", why: "FSBO / classifieds actors only where a page's terms permit (portal and classified hosts stay HELD); collection infrastructure, never an identity database" } },
  zyte: { provides: ["raw_web_transport"], docs: "docs.zyte.com/zyte-api (reference, errors, pricing — read 2026-11-14)", credentialOwner: "platform", rights: TRANSPORT_RIGHTS,
    territory: "any reachable public host (the target's terms and robots.txt decide)", sourceTimestamps: "the page's own dates; response validators where returned", costs: { perAttempt: `${CK.zyte.billing}; per-domain tier pricing — ZYTE_REQUEST_COST_USD is an ESTIMATE, not a quote`, perMatch: "n/a — a transport has no match" },
    consumer: "fetchCheckpointedSnapshot (need chatter, FSBO, community topic research)", failureRecovery: "429 backoff, 401 hold, bounded timeout, per-tick fetch budget, unreadable checkpoint holds before spend", manager: "data_steward",
    stack: { tier: "DORMANT", why: "the picker (lib/external/zenrows-client.ts scrapeProviderOrder) tries Zyte first only on PORTAL hosts, which scrape-checkpoint holds on terms; on every permitted host it is ZenRows' fallback — one transport suffices until a portal agreement is recorded" } },
  zenrows: { provides: ["raw_web_transport"], docs: "docs.zenrows.com (Universal Scraper API) + zenrows.com/pricing (read 2026-11-18: plans from Build $19/mo published; credits per request vary with js_render / premium_proxy)", credentialOwner: "platform", rights: TRANSPORT_RIGHTS,
    territory: "any reachable public host (the target's terms and robots.txt decide)", sourceTimestamps: "the page's own dates; Zr- validators where returned", costs: { perAttempt: "UNKNOWN as a per-request quote — the pricing page publishes plan prices and credit allowances, not a per-request price; X-Request-Cost is booked as the final cost per response", perMatch: "n/a — a transport has no match" },
    consumer: "fetchCheckpointedSnapshot (need chatter, FSBO, community topic research)", failureRecovery: "402 quota held, 429 backoff, original_status carried, wait_for not sent as a load state", manager: "data_steward",
    stack: { tier: "CONDITIONAL_GAP_FILL", why: "the narrow permitted fetch: the picker's first transport on every non-portal host — used only where the source is not available with better rights" } },
  batchdata: { provides: ["property_owner_identity", "contact_field_append", "sale_listing_fact", "sold_comps"], docs: "developer.batchdata.com (REST v1 / v3, read 2026-09-16 / 2026-11-09)", credentialOwner: "either",
    rights: { resale: "marketing-use terms by NAME (batchdata_api_terms), NOT read — UNKNOWN", ai: TERMS_NOT_READ, retention: "repo 14-day fallback cache; a tenant connection attests its own retention_days", outreach: "skip-traced contact points pass DNC / TCPA scrub (its own MCP) and the consent gates — marketing-use terms not read" },
    territory: "US properties", sourceTimestamps: "list pull date; Smart Search push events carry their own date; vendor per-field recency unpublished", consumer: "runPooledBatchDataLane → THE RawData producer; the AVM / record backup; the tenant Smart Search door", failureRecovery: "revoked / 401 / quota / daily cap recover as ruled; replay = one observation", manager: "data_steward" },
  peopledata: { provides: ["people", "contact_field_append"], docs: "docs.peopledatalabs.com (REST v5 Person Enrichment + Email Validation)", credentialOwner: "platform",
    rights: { resale: "standard terms: data for ONE End User on the Customer's platform (comparison §4)", ai: TERMS_NOT_READ, retention: "standard terms: cached no longer than necessary; delete on termination", outreach: TERMS_NOT_READ },
    territory: "global person dataset (US used)", sourceTimestamps: "dataset release cadence; per-record age unpublished", consumer: "person_profile route (owner_contact rung 3)", failureRecovery: "a 404 no-match is free; a dormant-closed door is skipped", manager: "data_steward" },
  tracerfy: { provides: ["contact_field_append", "property_owner_identity"], docs: "tracerfy.com/pricing + ToS + mock.tracerfy.com (comparison §10–§11)", credentialOwner: "none",
    rights: { resale: "ToS §13 internal use + lawful delivery to contracted end users — platform / white-label UNCONFIRMED in writing (LICENSE-HELD)", ai: TERMS_NOT_READ, retention: "no retention clause found", outreach: "ToS §3 flow-down (no resale, no FCRA use, no harassment) — LICENSE-HELD" },
    territory: "US; individual owners only (no LLCs)", sourceTimestamps: "UNKNOWN — unpublished", consumer: "none — no transport", failureRecovery: "n/a — nothing is called", manager: "data_steward" },
  datazapp: { provides: ["contact_field_append"], docs: "knowledgebase.datazapp.com (Email / Phone / Demography Append API)", credentialOwner: "none",
    rights: { resale: "NONE STATED in writing — LICENSE-HELD", ai: "NONE STATED — LICENSE-HELD", retention: "not addressed in the Terms", outreach: "NONE STATED — LICENSE-HELD" },
    territory: "US", sourceTimestamps: "UNKNOWN — 'regularly updated', no per-record date", consumer: "none — no transport", failureRecovery: "n/a — nothing is called", manager: "data_steward" },
  propertyradar: { provides: ["property_owner_identity", "sale_listing_fact", "contact_field_append"], docs: "owner-installed propertyradar-api playbook (references/endpoints.md, read 2026-11-06)", credentialOwner: "none",
    rights: { resale: "partner / embedded product rights UNVERIFIED — LICENSE-HELD", ai: TERMS_NOT_READ, retention: "not read", outreach: "LICENSE-HELD — persons only with Purchase=1 under rights not held" },
    territory: "US (state coverage per the vendor; not read per county)", sourceTimestamps: "per record as returned", consumer: "lib/investor/rei-playbook.ts (methodology only — no transport)", failureRecovery: "n/a — nothing is called", manager: "data_steward" },
  data_axle: { provides: ["people"], docs: "UNKNOWN — no product chosen, no field-level documentation read", credentialOwner: "none",
    rights: { resale: "UNKNOWN — no product chosen", ai: "UNKNOWN — no product chosen", retention: "UNKNOWN — no product chosen", outreach: "UNKNOWN — no product chosen" },
    territory: "UNKNOWN — no product chosen", sourceTimestamps: "UNKNOWN — no product chosen", consumer: "none", failureRecovery: "n/a — nothing is called", manager: "data_steward" },
  datafiniti: { provides: ["people", "contact_field_append"], docs: "docs.datafiniti.co People Data REST v4 (read 2026-11-16)", credentialOwner: "either",
    rights: { resale: "LICENSE-HELD — multi-tenant SaaS storage / resale not stated in anything read", ai: "LICENSE-HELD — AI processing not stated", retention: "LICENSE-HELD — vendor retention not read; download links expire after 7 d; repo RawData TTL person 365 d", outreach: "LICENSE-HELD — outreach use of contact points not stated; tcpa-flagged phones suppressed" },
    territory: "US persons (geography fields are the WORK location per the schema)", sourceTimestamps: "dateUpdated per record + phoneNumbers[].lastDateSeen", consumer: "runDatafinitiPeoplePull → THE RawData producer (dormant)", failureRecovery: "quota no retry; 429 backoff; a paid 5xx reconciled against the free account read; replay = no second charge", manager: "data_steward" },
  idxbroker: { provides: ["sale_listing_fact", "sold_comps", "licensed_listing_photos"], docs: "middleware.idxbroker.com/docs (IDX Broker API)", credentialOwner: "tenant",
    rights: { resale: "n/a — the tenant's own MLS board feed under its IDX rules", ai: "the MLS board's IDX rules govern (not read per board) — UNKNOWN per board", retention: "feed-active rows only; photos display-time only (no platform photo ingest)", outreach: "n/a — listings, not people" },
    territory: "the tenant's MLS board area", sourceTimestamps: "MLS modification timestamps as the feed carries them", costs: { perAttempt: "n/a to the platform — the tenant pays its own IDX / MLS subscription", perMatch: "n/a" },
    consumer: "searchExternalListings (Shopping Agent, exclusive when connected); MLS-synced closed sales in market reports", failureRecovery: "the most specific connected account wins; no cross-tenant read", manager: "shopping_agent",
    stack: { tier: "TENANT_OWNED_OPTION", why: "the only LICENSED listing-photo source: the tenant's own MLS board under its IDX rules; RentCast carries no photos and no imagery is ever scraped" } },
  tavily: { provides: ["public_web_discovery"], docs: "docs.tavily.com (search + answer)", credentialOwner: "platform",
    rights: { resale: "search API terms not read for redistribution — cited research only", ai: TERMS_NOT_READ, retention: "result URL + snippet on research rows", outreach: "never — research only" },
    territory: "the open web", sourceTimestamps: "per result where the page shows one", costs: { perAttempt: "credits per search (basic 1 / advanced 2 — TAVILY_CREDITS_PER_SEARCH; TAVILY_CREDIT_USD)", perMatch: "n/a" },
    consumer: "sourceTavilyIntent; the healer's provider-setup research", failureRecovery: "the normalizer drops non-viable rows", manager: "data_steward",
    stack: { tier: "NOT_NEEDED", why: "the same function as Exa (public-web discovery) — one canonical path (OS-CONSTITUTION law 2); the code is kept (extend before replacing), never activated for acquisition" } },
  public_records: { provides: ["property_event_record"], docs: "Socrata SODA 2.1 + ArcGIS FeatureServer query (per-city datasets)", credentialOwner: "none",
    rights: { resale: "public open data under each city's dataset terms", ai: "public open data — each dataset's terms", retention: "the event + dataset id + permit id", outreach: "never — a permit is a property event, never a person" },
    territory: "only the cities whose open-data portals publish permits (named per dataset)", sourceTimestamps: "the dataset's own event date", costs: { perAttempt: "$0 — free public data (an app token raises the rate limit only)", perMatch: "n/a" },
    consumer: "matchPermitsToLeads (property events on held properties)", failureRecovery: "field-name validation refuses an injected SoQL field; a dataset outage skips that city", manager: "data_steward",
    stack: { tier: "PRIMARY", why: "free, keyless property events with the source's own date — no vendor bill" } },
  google_trends: { provides: ["trend_insight"], docs: "developers.google.com/search/apis/trends (alpha, read 2026-11-18)", credentialOwner: "platform",
    rights: { resale: "UNKNOWN — the alpha terms are given on acceptance; none on record", ai: "UNKNOWN — alpha terms not on record", retention: "reworded topics only (content_topic_bank), 14-day topic TTL", outreach: "never — aggregate interest is never a person" },
    territory: "country / region / sub-region (documented)", sourceTimestamps: "the series' own period (daily / weekly / monthly / yearly)", costs: { perAttempt: "UNKNOWN — no price published for the alpha", perMatch: "n/a" },
    consumer: "the content-intel scan → the topic pool (pickTopics)", failureRecovery: "no transport → not_connected, nothing stored", manager: "campaign_orchestrator", noTransportBecause: "no_account",
    stack: { tier: "CONDITIONAL_GAP_FILL", why: "demand intelligence for the topic pool only if Google grants alpha access (OWNER-HELD); first-party search statements and keyword_intelligence run without it" } },
  search_console: { provides: ["trend_insight"], docs: "developers.google.com/webmaster-tools (API v1 + usage limits, read 2026-11-18)", credentialOwner: "tenant",
    rights: { resale: "n/a — the tenant's own site data under the tenant's own grant", ai: "the tenant's own data; Google API terms apply (not read in full) — UNKNOWN for AI use", retention: "reworded topics only; rows whitelisted field by field", outreach: "never — aggregate queries are never a searcher" },
    territory: "the tenant's own verified site", sourceTimestamps: "the report's date range", costs: { perAttempt: "no price published (UNKNOWN as a quote); quotas published (1,200 QPM per site)", perMatch: "n/a" },
    consumer: "the content-intel scan → the topic pool; SEO → Trends tab (SearchDemandCard)", failureRecovery: "no transport → not_connected (zero rows)", manager: "campaign_orchestrator", noTransportBecause: "no_account",
    stack: { tier: "TENANT_OWNED_OPTION", why: "website intelligence from the tenant's own site, on the tenant's own Google grant — no platform account exists or is needed" } },
  apify_idea_actors: { provides: ["trend_insight"], docs: "apify.com actor pages apify/facebook-groups-scraper (build 0.0.405) and apify/facebook-ads-scraper (build 0.0.410) — read by lane 154C 2026-11-18", credentialOwner: "platform",
    rights: { resale: "n/a — nothing resold; reworded topics only", ai: "fetched text is fenced as untrusted, reworded in memory and discarded", retention: "the reworded topic + minimal provenance only; post wording, author, profile links and comments are NEVER stored (R1)", outreach: "NEVER — ideas only (owner ruling R3)" },
    territory: "the public groups / Ad Library pages named in a source's input", sourceTimestamps: "post time / ad start-end dates as the actor returns them", costs: { perAttempt: "pay-per-event as published per actor page (see limits column) — tier-dependent", perMatch: "n/a" },
    consumer: "the topic pool → Refurbish / Omnipresence (never the Lead door)", failureRecovery: "an inactive source makes zero calls; a removed source is re-evaluated (reevaluateRemovedTopicSource)", manager: "campaign_orchestrator",
    stack: { tier: "CONDITIONAL_GAP_FILL", why: "IDEAS ONLY: public group questions and competitor ad creatives as topic inputs, run only when a source row is active with its rights recorded" } },
})

const STACK_FROM_SCORECARD: Readonly<Record<string, StackTier>> = Object.freeze({ PRIMARY: "PRIMARY", GAP_FILL: "CONDITIONAL_GAP_FILL", DORMANT_BACKUP: "DORMANT", WAITING_LICENSE: "LICENSE_HELD", UNNECESSARY: "NOT_NEEDED" })
const UNKNOWN_USABLE = "UNKNOWN — needs a measured usable ratio; no live pull is on record (the J6 pilot measures it)"

/** PURE — the cost cells of a scorecard provider, derived from its PUBLISHED units (PROVIDER_FIELD_SCORECARD). */
function scorecardCosts(p: ScorecardProvider): { perAttempt: string; perMatch: string; perUsable: string } {
  const rows = PROVIDER_FIELD_SCORECARD.filter((r) => r.provider === p && r.unit !== "free")
  const priced = rows.filter((r) => r.unitUsd !== null)
  if (priced.length === 0) return { perAttempt: "UNKNOWN — no published unit price (scorecard)", perMatch: "UNKNOWN — no published unit price (scorecard)", perUsable: UNKNOWN_USABLE }
  const uniq = (xs: string[]) => [...new Set(xs)].join("; ")
  const perMatchRows = priced.filter((r) => r.unit === "per_match")
  const perCallRows = priced.filter((r) => r.unit !== "per_match")
  return {
    perAttempt: uniq([...(perMatchRows.length ? ["$0 on a miss — billed per match (published)"] : []), ...perCallRows.map((r) => `${formatUnitUsd(r.unitUsd, r.unit)} (${r.field}, published)`)]),
    perMatch: perMatchRows.length ? uniq(perMatchRows.map((r) => `${formatUnitUsd(r.unitUsd, r.unit)} (${r.field}, published)`)) : "n/a — billed per record / request, matched or not",
    perUsable: UNKNOWN_USABLE,
  }
}

/** PURE — the J2 status from the honest route states (the first route that exists). */
function businessStatus(state: HonestState | null, b: BusinessFacts | undefined): BusinessStatus {
  if (state === "ready") return "LIVE_VERIFIED"
  if (state === "simulated") return "SIMULATED_ONLY"
  if (state === "awaiting_license") return "PENDING_RIGHTS"
  if (state === "awaiting_key") return "NO_KEY"
  return b?.noTransportBecause === "no_account" ? "NO_ACCOUNT" : "UNAVAILABLE"
}

// ─── derivations (the columns other survivors already declare) ─────────────────────────────────────────────────────

const ROUTE_LABEL: Record<HonestState, string> = { ready: "ready", simulated: "simulated", awaiting_license: "awaiting license", awaiting_key: "awaiting key", unavailable: "unavailable" }

/** PURE — the honest state of one ROUTE (the first unmet step wins; see the header). */
function routeState(f: CapabilityFacts, route: "platform" | "tenant"): HonestState {
  if (f.liveEvidence) return "ready"
  if (!f.transport) return f.scorecard && PROVIDER_ACTIVATION[f.scorecard].state === "dormant_pending_rights" ? "awaiting_license" : "unavailable"
  if (!f.proof.script) return "unavailable"
  // Wave 153 (lane 153M): a BUILT transport does not license the data — a provider the platform keeps dormant pending rights
  // waits on the license on BOTH routes (tenant-provider-connections.ts derives pending_owner_licensing for the tenant key too).
  if (f.scorecard && PROVIDER_ACTIVATION[f.scorecard].state === "dormant_pending_rights") return "awaiting_license"
  if (route === "platform" && f.scorecard && PROVIDER_ACTIVATION[f.scorecard].state === "dormant_survivor") return "awaiting_key"
  return "simulated"
}

function tenancyOf(f: CapabilityFacts): { models: readonly string[]; why: string } | null {
  const row = f.tenancyKey ? PROVIDER_TENANCY.find((t) => t.provider === f.tenancyKey) : undefined
  return row ? { models: row.models, why: row.why } : null
}

/**
 * PURE — the whole matrix: one row per choosable provider with the thirteen columns, every derived column read from its
 * survivor and every honest state computed per route. Read by the platform connector-healing console and rendered into
 * docs/operations/PROVIDER-SELECTION-WAVE151.md §9 by scripts/provider-gap-matrix-guard.ts (which verifies the anchors).
 */
export function providerCapabilityMatrix() {
  return FACTS.map((f) => {
    const b = BUSINESS[f.provider] as BusinessFacts | undefined
    const tenancy = tenancyOf(f)
    const activation = f.scorecard ? PROVIDER_ACTIVATION[f.scorecard] : null
    const tenantCatalogue = TENANT_ACQUISITION_PROVIDERS[f.provider] ?? null
    const platformRoute = f.provider !== "idxbroker" || (tenancy?.models.includes("tenant_optional_key") ?? false)
    const envVars = f.envVars ?? activation?.credential.envVars ?? (f.provider === "exa" ? ["EXA_API_KEY"] : f.provider === "apify" ? ["APIFY_API_TOKEN"] : f.provider === "zyte" ? ["ZYTE_API_KEY"] : f.provider === "zenrows" ? ["ZENROWS_API_KEY"] : f.provider === "idxbroker" ? ["IDXBROKER_API_KEY"] : f.provider === "tavily" ? ["TAVILY_API_KEY"] : [])
    const tenantState = f.tenantRoute === "built" ? routeState(f, "tenant") : null
    const platformState = platformRoute ? routeState(f, "platform") : null
    const connector = [
      platformRoute ? f.connectorOverride ?? `platform: ${tenancy ? tenancy.models.join(" + ") : f.scorecard ? "platform env key (scorecard provider)" : "keyless / platform"}` : null,
      f.tenantRoute === "built" ? `tenant-owned: built (${tenantCatalogue ? `Settings → Integrations → Lead sources; ${tenantCatalogue.transports.join(" + ")}` : "Settings → Integrations; resolveScopedConnection cascade"})`
        : f.tenantRoute === "ruled_out" ? "tenant-owned: ruled out by the owner (platform-owned lane)"
        : f.tenantRoute === "no_transport" ? "tenant-owned: not offered — no transport (`unsupported`)" : "tenant-owned: not offered",
    ].filter(Boolean).join(" · ")
    const commercial = f.scorecard ? PROVIDER_COMMERCIAL_FACTS[f.scorecard] : null
    const rights = commercial ? `${commercial.permittedUse} · retention: ${commercial.retention} · display: ${commercial.consumerDisplayRights}` : (f.rights ?? "not read")
    const auth = envVars.length
      ? `${envVars.map((n) => `\`${n}\``).join(", ")} (platform, by NAME)${f.tenantRoute === "built" ? " · the tenant's own key, encrypted in platform_credentials (enc:v1) — never mixed with the platform's" : ""}`
      : f.provider === "public_records" ? "keyless (an optional app token raises rate limits)" : f.provider === "search_console" ? "the tenant's own Google OAuth grant (webmasters.readonly) — no adapter built, no grant on record (OWNER-HELD per tenant)" : f.provider === "google_trends" ? "an alpha access grant from Google — none on record (OWNER-HELD); no credential name exists until one is granted" : "no credential name — no product chosen"
    return {
      provider: f.provider,
      label: f.label,
      kinds: f.kinds,
      connector,
      endpoint: f.endpoint,
      auth,
      producer: f.producer,
      transport: f.transport,
      mapping: f.mapping,
      preview: f.preview,
      freshnessDedup: f.freshnessDedup,
      incremental: f.incremental,
      limitsCost: f.limitsCost,
      rights,
      validation: f.proof.script ? `${f.proof.script} (SIMULATED — offline, injected seams: ${f.proof.adverse}); live: ${f.liveEvidence ?? "none on record"}` : `none — ${f.proof.adverse}; live: none on record`,
      proofScript: f.proof.script,
      recommendation: f.scorecard ? PROVIDER_RECOMMENDATION[f.scorecard].tier : null,
      states: { platform: platformState, tenant: tenantState },
      honestState: [platformState ? `platform: ${ROUTE_LABEL[platformState]}` : null, tenantState ? `tenant-owned: ${ROUTE_LABEL[tenantState]}` : null].filter(Boolean).join(" · "),
      evaluated: f.evaluated,
      // Wave 154 (lane 154J — directive J2 / J6): the source-to-business columns, the derived status and the stack tier.
      business: b ? {
        provides: b.provides, docs: b.docs, credentialOwner: b.credentialOwner, rights: b.rights, territory: b.territory, sourceTimestamps: b.sourceTimestamps,
        costs: f.scorecard ? scorecardCosts(f.scorecard) : { perAttempt: b.costs?.perAttempt ?? "UNKNOWN — no cost declared", perMatch: b.costs?.perMatch ?? "UNKNOWN — no cost declared", perUsable: UNKNOWN_USABLE },
        consumer: b.consumer, failureRecovery: b.failureRecovery, manager: b.manager,
      } : null,
      businessStatus: businessStatus(platformState ?? tenantState, b),
      stack: {
        tier: (f.scorecard ? STACK_FROM_SCORECARD[PROVIDER_RECOMMENDATION[f.scorecard].tier] : b?.stack?.tier) ?? null,
        why: f.scorecard ? `${PROVIDER_RECOMMENDATION[f.scorecard].tier} (PROVIDER_RECOMMENDATION) — ${PROVIDER_RECOMMENDATION[f.scorecard].role}` : b?.stack?.why ?? "no stack decision declared",
        // A tenant may bring its own account only where that route is built AND not waiting on a license.
        tenantOption: tenantState === "simulated" || tenantState === "ready" || b?.stack?.tier === "TENANT_OWNED_OPTION",
      },
    }
  })
}

// ─── ONLINE HUNTING WORKFLOWS — concrete, source-backed (wave 153, lane 153N — owner rulings B2–B5) ─────────────────────
//
// TOMBSTONE (wave 153, lane 153N): NEEDLE_PLAYBOOKS (lane 153G) is RETIRED. Owner, verbatim: "don't just make up something like
// you have just to say you came up with a needle in a haystack or creative way … you are hallucinating by creating plays that
// you created yourself". Its four rows were COMBINATION NAMES ("relocation demand × inventory mismatch", "permits × transport ×
// hyperlocal education", …) with no query, no evidence fields, no freshness and no cost — strategy labels, not workflows. Each
// is rewritten below as what it really runs (the survivor, the provider, the exact search, the evidence a hit must carry, its
// window, its rights, its cost); the "transport changes" and "hyperlocal education campaigns" halves had no source and no
// survivor and are DELETED, not rewritten. Survivor of the export: ONLINE_HUNTING_WORKFLOWS (this file); its readers are
// app/dashboard/superadmin/connector-healing/page.tsx and scripts/provider-gap-matrix-guard.ts §J.

const PUBLIC_REQUEST_SEARCHES = "lib/acquisition-plays/public-request.ts publicRequestSearches"

/**
 * Every way the OS hunts online, as a WORKFLOW: the provider(s), the exact search or page, the evidence fields a hit must carry
 * to count, its freshness window, its rights basis, its cost and the existing survivor that runs it. Nothing here is a strategy
 * name; a row with no real query is not a row.
 */
export const ONLINE_HUNTING_WORKFLOWS = Object.freeze([
  {
    key: "exa_public_stated_need",
    replaces: "stated_need_x_property_facts_x_appointment",
    providers: ["exa"],
    survivor: A("lib/acquisition-plays/public-request.ts", "runPublicRequestPlay"),
    query: `${PUBLIC_REQUEST_SEARCHES}: "I'm looking for a real estate agent in {city, ST}…", "relocating to {city, ST} and need a realtor…", "we are looking to buy a house in {city, ST}…", "we need to sell our house in {city, ST}…", "selling my house by owner in {city, ST}…"`,
    evidenceFields: "openable URL · published date · ≤ 280-char quote of the author's own words · first-person author (the poster states the need as their own) · a contact point the author published · need_kinds",
    freshness: "90 days (PUBLIC_REQUEST_MAX_AGE_DAYS); an undated page is never a person",
    rights: "public page (owner ruling B4: public → usable at the author's own published contact point); Nextdoor LICENSE_REQUIRED; the channel is never messaged; a handle never deanonymized",
    cost: "Exa search list price $7 / 1k searches (≤ 10 results), booked from costDollars when present; a person already held is HELD by the pre-pull dedup before the RawData door (no second paid enrichment)",
    output: "a grounded Raw Lead (subject person) → the existing promotion gate → Lead → AI ISA; an existing Contact → the arbiter's life-change door; a question with no identity → an inbound answer",
    neverClaims: "never infers a private plan, never joins on a name or a handle, never messages the channel the post was made in",
  },
  {
    key: "exa_volunteered_military_move",
    replaces: null,
    providers: ["exa"],
    survivor: A("lib/acquisition-plays/public-request.ts", "runPublicRequestPlay"),
    query: `${PUBLIC_REQUEST_SEARCHES} need:military_move: "PCSing to {city, ST} and looking for a home to buy or rent"`,
    evidenceFields: "as exa_public_stated_need, with need_kinds ∋ military_move and the military_boundary note (volunteered move only)",
    freshness: "90 days",
    rights: "what the service member VOLUNTEERED on a public page; no restriction on who can be found (owner ruling B5)",
    cost: "as exa_public_stated_need (one of the same searches)",
    output: "a grounded Raw Lead → the promotion gate → AI ISA; after they become a Contact, the military persona's PCS journey on the portal (lib/portal/persona-config.ts journeyTools pcs_move_plan)",
    neverClaims: "never claims orders, a report date or a duty station from the text — no PCS-orders data source exists or is invented; installation-level facts stay market intelligence",
  },
  {
    key: "exa_employer_and_installation_announcements",
    replaces: "relocation_demand_x_inventory_mismatch",
    providers: ["exa"],
    survivor: A("lib/acquisition-plays/moving-corridor.ts", "runMovingCorridorPlay"),
    query: `lib/acquisition-plays/moving-corridor.ts: "company relocating its headquarters or opening a new office or plant with new jobs in {city, ST}", "employer expansion announced hiring workers {city, ST} campus base plant expansion jobs" (category news)`,
    evidenceFields: "openable URL · published date · quoted basis · the employer / installation named on the page · announced job count and date when the page states them",
    freshness: "120 days (CORRIDOR_MAX_AGE_DAYS)",
    rights: "news / official pages — cited excerpt only",
    cost: "Exa search list price, as above",
    output: "MARKET intelligence only: a market-level brief, a market report and a DRAFT relocation guide (an inbound resource)",
    neverClaims: "never a person — an announcement names an employer and a date, not who will move",
  },
  {
    key: "exa_public_permit_property_event",
    replaces: "permits_transport_x_hyperlocal_education",
    providers: ["exa", "public_records"],
    survivor: A("lib/lead-pipeline/permit-sourcer.ts", "sourcePermitPrelistingIntent"),
    query: `lib/lead-pipeline/permit-sourcer.ts: "recent residential remodel or addition building permit filed {loc}", "building permit issued roof replacement or pool {loc}", "coming soon home for sale pre-listing preparation {loc}", "contractor bid renovation remodel before selling {loc}"`,
    evidenceFields: "openable URL · published date · the property address on the page · permit / notice category",
    freshness: "the permit sourcer's window per category",
    rights: "public records / official pages — a PROPERTY event",
    cost: "Exa search list price, as above",
    output: "a property-level pre-listing signal on a property (attached to a held Contact by verified ownership, else a property observation)",
    neverClaims: "a permit is a property event, never a person's assumed intent unless the identity is independently grounded",
  },
  {
    key: "exa_listing_contradiction_check",
    replaces: "contradiction_saver",
    providers: ["exa"],
    survivor: A("lib/acquisition-plays/negative-evidence.ts", "assessNegativeEvidence"),
    query: "a public page for an open theory's address showing it listed with another brokerage, sold or withdrawn",
    evidenceFields: "openable URL · published date · the address match · the contrary status",
    freshness: "newer than the theory's own evidence (older facts are history)",
    rights: "cited excerpt only",
    cost: "Exa search list price; saves outreach and enrichment spend on a dead theory",
    output: "holds / closes the theory and pauses outreach",
    neverClaims: "reported evidence holds and asks for verification; it never closes a Contact's file alone",
  },
  {
    key: "page_transport_fsbo_listings",
    replaces: null,
    providers: ["zyte", "zenrows"],
    survivor: A("lib/providers/scrape-checkpoint.ts", "fetchCheckpointedSnapshot"),
    query: "purpose fsbo_listing — the by-owner portal searches (lib/lead-pipeline/scraper-parsers.ts FSBO_FILTERED_PORTAL_SEARCH: zillow fsbo, realtor show-fsbo, redfin forSaleByOwner) and the craigslist 'rea' HTML fallback",
    evidenceFields: "the page URL · the listing's own address / price / published contact · a stable source_record_id · the snapshot digest",
    freshness: "the snapshot checkpoint: 6-hour re-fetch interval, 14-day rescan window, only records new since the processed watermark",
    rights: "transport only — the page's terms govern: portal and craigslist hosts are HELD until a written agreement is recorded",
    cost: "per request (Zyte tier / ZenRows X-Request-Cost), behind the territory budget and the run's page-fetch budget",
    output: "FSBO property / owner records → THE ONE RawData producer → the promotion gate",
    neverClaims: "never general listing inventory — a fact RentCast / IDX supply (refused by name as a scrape purpose)",
  },
  {
    key: "page_transport_need_chatter",
    replaces: null,
    providers: ["zyte", "zenrows"],
    survivor: A("lib/providers/scrape-checkpoint.ts", "fetchCheckpointedSnapshot"),
    query: "purpose real_estate_need_chatter — portal saved-search / contact-agent / sell-side chatter (sourceRealtySiteChatter), craigslist housing-wanted (hhh) fallback, the tenant's own review pages (sourceReviewAcquisitionIntent) and Nextdoor (sourceNextdoorChatter)",
    evidenceFields: "the page URL · the post's own words · a stable source_record_id · the snapshot digest",
    freshness: "the snapshot checkpoint (as above)",
    rights: "transport only — portal / forum / review hosts HELD on terms; Nextdoor LICENSE_REQUIRED until a reviewed agreement is recorded (owner decision)",
    cost: "per request, as above",
    output: "need-chatter records → THE ONE RawData producer → the promotion gate (an agent-written page is a recruiting prospect, never a consumer Lead)",
    neverClaims: "never a page fetched for any purpose but chatter or FSBO (refused by name)",
  },
] as const)

// ─── GOOGLE, NEXTDOOR AND META STATUS + THE J6 PILOT PROPOSAL (wave 154, lane 154J — directive J5 / J6) ────────────────
//
// J5 is stated the way the owner ruled it ($S/WAVE154_OWNER_NOTES.md R1 / R2 / R3 / R5): Trends and Search Console are
// demand and website intelligence and can never yield a searcher; first-person public statements are reached through Exa;
// Nextdoor and public Facebook groups are read for TOPICS under the owner's public-read / reword-before-store accepted risk
// (listed for counsel); a Nextdoor person-level Raw Lead and any Facebook person record stay LICENSE-HELD / ideas-only. Each
// row names the survivor that enforces it; scripts/provider-gap-matrix-guard.ts §K EXECUTES those survivors.
//
// J6 extends the existing matched-cohort design (lib/providers/provider-pilot.ts MATCHED_COHORT_DESIGN) — it is not a second
// design. It keeps owner contacts, market statistics and licensed imagery / IDX in three separate tracks, quotes only
// PUBLISHED units (a per-match unit gives a CEILING at a 100% match rate, never an expected cost — the match rate is
// unmeasured), names every metric's existing measuring survivor with value null, and authorizes nothing.

const SOURCE_STATUS = [
  { key: "google_trends", source: "Google Trends API", yields: "aggregate, relative search interest → reworded demand topics (topic pool)", identity: "never" as const, status: "OWNER-HELD (alpha access grant)", ruling: "R5b", survivor: A("lib/content-intel/search-demand.ts", "trendsProducer"), stored: "a reworded topic + region + period + evidence 'proxy'" },
  { key: "search_console", source: "Google Search Console (the tenant's own site)", yields: "aggregate queries / pages / clicks for the tenant's own site → reworded topics", identity: "never" as const, status: "OWNER-HELD per tenant (webmasters.readonly grant)", ruling: "R5b", survivor: A("lib/content-intel/search-demand.ts", "searchConsoleProducer"), stored: "whitelisted aggregate fields → reworded topics" },
  { key: "google_custom_search", source: "Google Custom Search JSON API", yields: "nothing — not used and not built (withdrawn for existing users by 2027-01-01)", identity: "never" as const, status: "NOT USED", ruling: "R5a (lane 154B)", survivor: A("lib/providers/exa/hunting.ts", "GOOGLE_INDEXED_DISCOVERY_ROUTE"), stored: "nothing" },
  { key: "exa_first_person_statements", source: "Publicly indexed first-person statements (through Exa)", yields: "a grounded Raw Lead: URL + date + the author's own words + the contact point the author published", identity: "author_published_only" as const, status: "SIMULATED (no key; runs through the RawData producer and the Raw Lead gate)", ruling: "R5a", survivor: A("lib/acquisition-plays/public-request.ts", "runPublicRequestPlay"), stored: "the grounded evidence (≤ 280-char quote) under source rights, identity and freshness checks" },
  { key: "nextdoor_topics", source: "Nextdoor public posts (Zyte / ZenRows transport)", yields: "reworded TOPICS only", identity: "never" as const, status: "NEWLY WIRED by lane 154C — owner's accepted risk, LISTED FOR COUNSEL", ruling: "R1 / R2", survivor: A("lib/content-intel/public-chatter-topics.ts", "researchCommunityPostTopics"), stored: "the reworded topic + host / URL + dates + stated geography; never wording, author, contact, member list or profile link" },
  { key: "nextdoor_person", source: "Nextdoor person-level Raw Lead", yields: "nothing without a reviewed written agreement for nextdoor.com", identity: "license_held" as const, status: "LICENSE-HELD", ruling: "R2", survivor: A("lib/content-intel/public-chatter-topics.ts", "routeChatter"), stored: "nothing on the person path" },
  { key: "facebook_group_topics", source: "Public Facebook groups (Apify)", yields: "reworded consumer questions as TOPICS", identity: "never" as const, status: "NEWLY WIRED by lane 154C — inactive until a source row's rights + credential are recorded; LISTED FOR COUNSEL", ruling: "R1 / R3", survivor: A("lib/content-intel/public-chatter-topics.ts", "normalizeFacebookGroupItems"), stored: "the reworded topic + minimal provenance" },
  { key: "facebook_person", source: "Any Facebook person record", yields: "nothing — ideas only, never RawData / Raw Lead / Lead / Contact / audience / outreach", identity: "ideas_only" as const, status: "LICENSE-HELD / IDEAS ONLY", ruling: "R3", survivor: A("lib/content-intel/public-chatter-topics.ts", "routeChatter"), stored: "nothing on the person path" },
  { key: "meta_ad_library", source: "Meta Ad Library (Apify)", yields: "competitor creative IDEAS for Refurbish / the topic pool", identity: "ideas_only" as const, status: "NEWLY WIRED by lane 154C — ideas only", ruling: "R3 / R4", survivor: A("lib/content-intel/public-chatter-topics.ts", "normalizeMetaAdItems"), stored: "the reworded idea; page contact details never requested (includeAboutPage not used)" },
] as const

const PILOT_CONTACT_ARMS: readonly ScorecardProvider[] = Object.freeze([...MATCHED_COHORT_DESIGN.incumbents.filter((p) => p !== "rentcast"), ...MATCHED_COHORT_DESIGN.arms, "datafiniti"] as ScorecardProvider[])

function pilotQuote(p: ScorecardProvider, monthly: number) {
  const row = PROVIDER_FIELD_SCORECARD.find((r) => r.provider === p && r.field === "owner_phone" && r.unitUsd !== null) ?? PROVIDER_FIELD_SCORECARD.find((r) => r.provider === p && r.field === "owner_email" && r.unitUsd !== null) ?? null
  if (!row || row.unitUsd === null) return { provider: p, unit: "UNKNOWN — no published unit", basis: "unknown" as const, monthlyUsd: null, terms: PROVIDER_COMMERCIAL_FACTS[p].payer }
  return {
    provider: p, unit: `${formatUnitUsd(row.unitUsd, row.unit)} (${row.field}; ${row.source})`,
    basis: row.unit === "per_match" ? "ceiling_at_full_match" as const : "every_record_attempted" as const,
    monthlyUsd: Math.round(monthly * row.unitUsd * 100) / 100, terms: PROVIDER_COMMERCIAL_FACTS[p].payer,
  }
}

/**
 * PURE — the J5 source status table and the J6 matched-record pilot PROPOSAL (nothing run, nothing authorized). Read by the
 * platform connector-healing console and rendered into docs/operations/PROVIDER-SELECTION-WAVE151.md by the guard's --write.
 */
export function acquisitionDecisionSupport() {
  const monthly = projectMonthlyWaterfall().variables.monthlyRecords
  return {
    sourceStatus: SOURCE_STATUS,
    pilot: {
      id: "acquisition-pilot-j6",
      extendsDesign: MATCHED_COHORT_DESIGN.id,
      status: "PROPOSAL — not run, not authorized",
      approved: PROVIDER_SELECTION_STATUS.paidPilotApproved,
      paidCalls: 0 as const,
      note: "the $1,000 paid pilot proposed in earlier waves is NOT approved; this proposal authorizes no spend, no account and no key",
      monthlyConsumers: monthly,
      bound: `matched records the platform ALREADY holds, drawn by MATCHED_COHORT_DESIGN's ${MATCHED_COHORT_DESIGN.cohorts.length} disjoint cohorts (${MATCHED_COHORT_DESIGN.cohorts.reduce((s, c) => s + c.size, 0)} records) — never a vendor list; free / sandbox / count steps first, a paid matched sample only on the owner's written approval`,
      steps: [
        "1 · free first: Tracerfy mock sandbox, Datafiniti num_records: 0 count, Versium B2C ListGen estimate — counts, never contacts",
        "2 · owner decision: approve (or not) a bounded paid matched sample per arm, with a cap the owner writes",
        "3 · measure the metrics below on the same records across arms (blinded verification share from the design)",
        "4 · decide the stack by measured cost per verified usable Contact — a provider earns a role only with a measured gap",
      ],
      tracks: [
        { track: "owner_contacts", what: "contact-field append and owner identity for records the platform already holds", arms: PILOT_CONTACT_ARMS.map((p) => pilotQuote(p, monthly)) },
        { track: "market_statistics", what: "ZIP / month market figures: RentCast /markets (LISTING statistics), RentCast /properties recorded sales, the tenant's MLS-synced closed sales — compared for agreement on the same ZIP and month, never mixed into contact cost", arms: [] },
        { track: "licensed_imagery_idx", what: "listing photos: ONLY the tenant's own IDX / MLS feed under its board's rules — not a pilot arm (nothing to buy; RentCast carries no photos; imagery is never scraped)", arms: [] },
      ],
      metrics: [
        { metric: "source freshness", measuredBy: "the vendor's dated fields (dateUpdated / lastDateSeen / retrieved_at) — MATCHED_COHORT_DESIGN 'data refresh age'" },
        { metric: "record accuracy", measuredBy: "the design's blinded right-party verification sample (provider names removed)" },
        { metric: "overlap", measuredBy: "lib/lead-pipeline/pre-pull-dedup.ts planPrePullDedup against held source ids / persons / properties and the incumbents" },
        { metric: "incremental fields", measuredBy: "per-field provenance (enrichment-column-map stampFieldProvenance): fields the incumbents did not already hold" },
        { metric: "match rate", measuredBy: "hits ÷ attempted per cohort per arm" },
        { metric: "Raw Lead pass rate", measuredBy: "raw_scraped_leads promoted ÷ rows (lib/lead-pipeline/pre-pull-value.ts factorsFromObservedOutcomes)" },
        { metric: "Lead → Contact", measuredBy: "lib/vendor-governance/acquisition-economics.ts loadAcquisitionEconomics contactConversion" },
        { metric: "useful response", measuredBy: "a reply / appointment attributed to the record's source — UNMEASURABLE where no source key rides the outcome (named, never imputed)" },
        { metric: "cost per verified usable Contact", measuredBy: "acquisition-economics costPerUsableRecordUsd over the blinded-verified share" },
      ].map((m) => ({ ...m, value: null, status: "UNMEASURED — no live pull is on record" })),
    },
  }
}
