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

import { PROVIDER_ACTIVATION, PROVIDER_COMMERCIAL_FACTS, PROVIDER_RECOMMENDATION, type ScorecardProvider } from "@/lib/providers/provider-scorecard"
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
    endpoint: "exa-js SDK: /search (structured JSON-schema summary, startPublishedDate), Search Monitors (pushed deltas to a signed webhook)",
    transport: A("lib/providers/exa/client.ts", "structuredSearch"),
    producer: { door: "rawdata", anchor: A("lib/acquisition-plays/public-request.ts", "runPublicRequestPlay"), path: "PERSON: grounded candidate (URL + date + quote, a contact point the author published on a permitted page class) → existing-Contact check → THE ONE RawData producer → Raw Lead gate → Lead → AI ISA; CONTENT / MARKET: lib/lead-pipeline/exa-sourcer.ts + the moving-corridor radar → research / market intelligence, never the Lead door" },
    mapping: { anchor: A("lib/external/exa-client.ts", "normalizeExaRow"), provenance: "groundedEvidence: source URL, published date, retrieval time, ≤ 280-char quoted basis (lib/providers/exa/hunting.ts)" },
    preview: { kind: "not_applicable", anchor: null, note: "a search is the call (numResults bounds it); monitors replace repeated searches" },
    freshnessDedup: "freshnessProblem per play window; one result per page across searches; the RawData idempotency key on the Exa result id",
    incremental: "Search Monitors push deltas (createSearchMonitor / getSearchMonitorRun); startPublishedDate bounds a search — documented, no cursor fabricated",
    limitsCost: "$7 / 1k searches (≤ 10 results) list price, the SDK's costDollars.total booked when present; webhook signature + timestamp tolerance + replay protection (EXA_SIGNATURE_TOLERANCE_SEC)",
    rights: "Exa returns pages it does not license for reuse — only a cited ≤ 280-char excerpt is kept; a forum author is answered only through our own inbound resources; Exa is not a contact append",
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
    producer: { door: "rawdata", anchor: A("lib/providers/scrape-checkpoint.ts", "fetchCheckpointedSnapshot"), path: "robots + terms + spend gate → the snapshot checkpoint → the page parsers → only records new inside the rescan window → THE ONE RawData producer → commit" },
    mapping: { anchor: A("lib/lead-pipeline/scraper-parsers.ts", "parseBuyerSavedSearches"), provenance: "the page parsers stamp site + a stable source_record_id; the producer envelope carries rights (transport terms + page terms)" },
    preview: { kind: "not_offered", anchor: null, note: "a single-page fetch — no count before the request" },
    freshnessDedup: "page content digest vs the PROCESSED watermark; record digests inside the bounded rescan window; the RawData idempotency key",
    incremental: `cursor: ${CK.zyte.cursor} documented — snapshot checkpoint instead; conditional requests: ${CK.zyte.conditionalRequests.how}; validators: ${CK.zyte.responseHeaders}`,
    limitsCost: `${CK.zyte.billing}; per-domain tier pricing (ZYTE_REQUEST_COST_USD estimate); retry ${CK.zyte.retryStatuses.join("/")}, hold ${CK.zyte.holdStatuses.join("/")}; bounded timeout; per-tick fetch budget`,
    rights: "transport only — the target page's terms govern: portal / classified / forum hosts are HELD unless a written agreement is recorded; robots.txt honoured (RFC 9309)",
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
])

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
    const tenancy = tenancyOf(f)
    const activation = f.scorecard ? PROVIDER_ACTIVATION[f.scorecard] : null
    const tenantCatalogue = TENANT_ACQUISITION_PROVIDERS[f.provider] ?? null
    const platformRoute = f.provider !== "idxbroker" || (tenancy?.models.includes("tenant_optional_key") ?? false)
    const envVars = activation?.credential.envVars ?? (f.provider === "exa" ? ["EXA_API_KEY"] : f.provider === "apify" ? ["APIFY_API_TOKEN"] : f.provider === "zyte" ? ["ZYTE_API_KEY"] : f.provider === "zenrows" ? ["ZENROWS_API_KEY"] : f.provider === "idxbroker" ? ["IDXBROKER_API_KEY"] : f.provider === "tavily" ? ["TAVILY_API_KEY"] : [])
    const tenantState = f.tenantRoute === "built" ? routeState(f, "tenant") : null
    const platformState = platformRoute ? routeState(f, "platform") : null
    const connector = [
      platformRoute ? `platform: ${tenancy ? tenancy.models.join(" + ") : f.scorecard ? "platform env key (scorecard provider)" : "keyless / platform"}` : null,
      f.tenantRoute === "built" ? `tenant-owned: built (${tenantCatalogue ? `Settings → Integrations → Lead sources; ${tenantCatalogue.transports.join(" + ")}` : "Settings → Integrations; resolveScopedConnection cascade"})`
        : f.tenantRoute === "ruled_out" ? "tenant-owned: ruled out by the owner (platform-owned lane)"
        : f.tenantRoute === "no_transport" ? "tenant-owned: not offered — no transport (`unsupported`)" : "tenant-owned: not offered",
    ].filter(Boolean).join(" · ")
    const commercial = f.scorecard ? PROVIDER_COMMERCIAL_FACTS[f.scorecard] : null
    const rights = commercial ? `${commercial.permittedUse} · retention: ${commercial.retention} · display: ${commercial.consumerDisplayRights}` : (f.rights ?? "not read")
    const auth = envVars.length
      ? `${envVars.map((n) => `\`${n}\``).join(", ")} (platform, by NAME)${f.tenantRoute === "built" ? " · the tenant's own key, encrypted in platform_credentials (enc:v1) — never mixed with the platform's" : ""}`
      : f.provider === "public_records" ? "keyless (an optional app token raises rate limits)" : "no credential name — no product chosen"
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
    }
  })
}

// ─── needle-in-a-haystack playbooks on EXISTING survivors (directive G4, line 271) ──────────────────────────────────

/**
 * The combinations that can be sourced RELIABLY, each run by a survivor that already exists (module + symbol, verified by the
 * guard), each naming the providers it composes and what it never claims. Data, not a new engine — no person-level
 * behavioral surveillance, no private housing plan inferred.
 */
export const NEEDLE_PLAYBOOKS = Object.freeze([
  {
    key: "relocation_demand_x_inventory_mismatch",
    combination: "public employer / installation relocation announcement × the territory's stored inventory mismatch × opted-in buyer / property interest",
    providers: ["exa", "rentcast", "idxbroker"],
    survivor: A("lib/acquisition-plays/moving-corridor.ts", "runMovingCorridorPlay"),
    output: "a market-level brief, a market report and a DRAFT relocation guide / magnet — inbound resources that let the movers raise their hand",
    neverClaims: "never a person: an announcement identifies an employer and a date, not who will move",
  },
  {
    key: "stated_need_x_property_facts_x_appointment",
    combination: "a freshly stated housing need in the author's own words (URL, date, quote, a contact point they published) × property facts × a real appointment pathway",
    providers: ["exa", "rentcast", "versium"],
    survivor: A("lib/acquisition-plays/public-request.ts", "runPublicRequestPlay"),
    output: "a grounded Raw Lead through the promotion gate to the AI ISA — or, for an existing Contact, the arbiter's life-change door; an anonymous question becomes an inbound answer",
    neverClaims: "never deanonymizes a handle, never infers a private plan, never messages the channel the post was made in",
  },
  {
    key: "permits_transport_x_hyperlocal_education",
    combination: "neighborhood permitting / code / transport changes from public records × hyperlocal educational campaigns",
    providers: ["public_records", "exa"],
    survivor: A("lib/lead-pipeline/permit-sourcer.ts", "sourcePermitPrelistingIntent"),
    output: "property-level pre-listing signals on properties already held and neighborhood education content — property facts, not people",
    neverClaims: "a permit is a property event; the owner is reached only through an existing Contact or a verified ownership path",
  },
  {
    key: "contradiction_saver",
    combination: "a public page that contradicts an open lead theory (listed with another brokerage, sold, withdrawn) × the tenant's open theories",
    providers: ["exa"],
    survivor: A("lib/acquisition-plays/negative-evidence.ts", "assessNegativeEvidence"),
    output: "holds or closes the theory and pauses outreach — spend and annoyance avoided",
    neverClaims: "reported evidence holds and asks for verification; it never closes a Contact's file alone",
  },
] as const)
