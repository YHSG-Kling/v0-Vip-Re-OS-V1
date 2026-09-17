# Lead-acquisition coverage — 2026-09 (wave 65)

Owner ruling (verbatim, 2026-09-15): "zenrows or zyte can help find leads that are on real
estate sites like zillow/realtor.com/nextdoor/homes.com/reddit that have property search saved
criterias or online chatter; using apify to scrape facebook groups, instagram, craigslist, etc.
for intent for buying or selling real estate plus many other scraping providers that can help
identify other potential leads that are looking to relocate, searching for properties or looking
to sell, looking for a realtor/real estate professional. these scrape searching should be
territory centric… do not merge lanes that look a like."

Research method: Exa web search against apify.com (Apify Store) and ZenRows/Zyte's own docs +
independent 2026 benchmarks (ZenRows/zenrows-vs-zyte-benchmark, ZenRows/web-scraping-api-
benchmark on GitHub, prospeo.io's ZenRows-alternatives writeup citing Proxyway's 2025 benchmark,
scrapeway.com's live August-2026 leaderboard, docs.zyte.com/zyte-api/pricing.html,
zyte.com/pricing). No live scrape or paid call was made by this lane (fail-closed, no keys).

## Provider verdict — ZenRows vs Zyte (2026)

| | ZenRows | Zyte |
|---|---|---|
| Model | Credit multiplier, 1×–25× (JS render 5×, premium proxy 10×, both 25×) | 5 auto-assigned domain tiers (HTTP + browser), reviewed quarterly |
| Pricing transparency | Full price known before the call (Developer $69/mo → $0.28–$7.00/1k) | Domain lands on a tier only AFTER the first request; Tier 1 HTTP $0.13/1k → Tier 5 browser $16.08/1k PAYG (123× spread) |
| ZenRows' own June-2026 benchmark (8 targets) | 96% avg success, wins 6/8 | 65.3% avg success |
| Independent Proxyway 2025 (15 hardest WAF targets, 2 req/s) | 70.39% | **93.14%** (leads) |
| Independent ZenRows/web-scraping-api-benchmark (Zim/Glassdoor/Idealista/**Indeed**) | 99% avg | 74.75% avg (8% on Indeed — a real-estate-adjacent classifieds/job site) |
| **scrapeway.com live Aug-2026 leaderboard** (12 real targets, ranked #8/8) | **17% overall success; 0% on zillow.com, realtor.com, instagram.com, linkedin.com, amazon.com, twitter.com** | not in this specific run |
| Automatic extraction / AI parsing | Autoparse (structured JSON on supported e-commerce/SERP targets) | AI Data Extraction — article/product/SERP schemas + `pageContent:true`, LLM only for custom fields |
| Billing floor | Pay-only-for-success (failed requests free) | Charged per successful response only |

**Verdict**: keep **ZenRows as the primary** scraper (already wired, predictable pricing, and
the vendor's own + one independent benchmark still favor it broadly) but **the live Aug-2026
scrapeway.com run reporting 0% ZenRows success specifically on zillow.com and realtor.com is the
reason this wave adds Zyte as a real fallback**, not a decorative one — `lib/external/zyte-
client.ts` + `scrapeSiteWithBestProvider()` in `lib/external/zenrows-client.ts` pick by
**configured key** (`ZENROWS_API_KEY` first, `ZYTE_API_KEY` fallback, fail-closed with neither).
Nextdoor has **no** dedicated Apify actor (confirmed below) and is served by ZenRows/Zyte raw
HTML + the LLM extractor (`lib/external/nextdoor-extract.ts`, survivor — unchanged this wave).

Pricing used for the vendor ledger's honest estimate (`estimateZyteCost` in zyte-client.ts): Zyte
Tier-3 "moderate" PAYG — $4.02/1k browser-rendered, $0.44/1k plain HTTP — as a mid-tier
approximation, since Zyte assigns the real tier only after the first live request (unresolved
until a production run reports it).

## Apify actor re-verification (2026)

| Task | Old primary (stale) | New primary (2026-confirmed live) | Price | Note |
|---|---|---|---|---|
| Reddit | `trudax/reddit-scraper` | `clearpath/reddit-search-scraper` | $0.99/1k | Reddit's logged-out `search.json` is reported **hard-blocked (403)** as of mid-2026 on both `www.` and `old.reddit.com`; a dedicated search actor with subreddit auto-discovery now leads. `trudax/reddit-scraper` kept as fallback (unverified live in this research pass). |
| Facebook groups | `apify/facebook-posts-scraper` | `memo23/facebook-public-group-posts-scraper` | $1.50/1k | 511 users, 100% run success, GraphQL-feed based, no login, has a `search` keyword param (used by the new "recommend a realtor" lane). `scrapier/facebook-groups-posts-scraper` (has built-in lead-scoring/email-phone extraction) kept as 2nd fallback. |
| Instagram hashtag | `apify/instagram-scraper` | `apify/instagram-hashtag-scraper` (unchanged, confirmed live) | $1.90–2.60/1k | `apidojo/instagram-hashtag-scraper` ($0.016/hashtag, 60 free posts) kept as a cheaper fallback. |
| Craigslist | `epctex/craigslist-scraper` | `solidcode/craigslist-scraper` | $1.4/1k | Confirmed live 2026, covers housing + for-sale sections directly. |
| LinkedIn | `apimaestro/linkedin-posts-search-scraper` | `apimaestro/linkedin-posts-search-scraper-no-cookies` | — | The old slug (missing `-no-cookies`) was never confirmed live; the real, currently-live actor (11k+ users) carries the suffix. `harvestapi/linkedin-post-search` ($2/1k, 21k+ users) kept as a confirmed-live 2nd fallback. |
| Nextdoor | — | **none** (confirmed — see below) | — | No Apify actor returns neighborhood-post *chatter with buy/sell/recommend-agent intent*; existing actors return city-metadata/business-directory data only, or require session cookies with an 11.9% success rate. ZenRows/Zyte raw HTML + `lib/external/nextdoor-extract.ts`'s LLM schema extractor remains the correct approach — unchanged, already wired. |
| Google | `apify/google-search-scraper` (unchanged) | — | — | Not re-verified live this pass — **unresolved**. |

`lib/external/apify-actors.ts::ACTOR_REGISTRY` updated with the above; resilience (try-next-
candidate) preserved — old entries kept as fallbacks rather than deleted outright where not
independently disproven.

## Coverage matrix

| Intent signal | Site / platform | Provider | Lane file | `sourceChannel` | Territory gate | Proof |
|---|---|---|---|---|---|---|
| FSBO seller + saved-search buyer | Zillow / Realtor / Redfin | ZenRows | `lib/lead-pipeline/scraper-parsers.ts` (`parsePropertySearchResults`, `parseBuyerSavedSearches`) via `app/api/cron/lead-scraping/route.ts` "zillow_behavior" block | `zillow` / `realtor` / `redfin` | `market.city`/`state` from active territory resolver | `test:scrapers`, `test:scraper-territory-gate` |
| **Saved-search + "contact agent" chatter (NEW)** | **Zillow / Realtor / Homes.com** | **ZenRows→Zyte** | `lib/lead-pipeline/social-sourcer.ts::sourceRealtySiteChatter`, `lib/lead-pipeline/scraper-parsers.ts::buildRealtySiteChatterUrl`/`parseContactAgentChatter` | `zillow_chatter` / `realtor_chatter` / `homes_chatter` | `market.city && market.state` gate before any call | `test:scrapers` §Wave 65, `test:scraper-territory-gate` §Layer 2 |
| Motivated seller (foreclosure/probate/…) | Nationwide property records | BatchData | (lane B — not owned by this lane) | `batchdata` | active territory | `test:scrapers` |
| Neighborhood chatter (selling/buying/recommend-agent) | Nextdoor | ZenRows (+LLM extract) | `lib/external/zenrows-client.ts::scrapeNextdoor` → `lib/external/nextdoor-extract.ts` (survivor) | `nextdoor` | `market.city`/`state` URL param | `test:scrapers` |
| Buyer/seller group posts | Facebook groups | Apify | `lib/lead-pipeline/social-sourcer.ts::sourceFacebook` | `facebook` | configured `facebook_group_urls` scoped to territory | `test:scrapers` |
| **"Recommend a realtor" (NEW)** | **Facebook groups** | **Apify** | `lib/lead-pipeline/social-sourcer.ts::sourceFacebookRecommendRealtor` | `facebook_recommend_realtor` | group URLs default to the market's city; no URLs ⇒ no scrape | `test:scrapers` §Wave 65, `test:scraper-territory-gate` §Layer 2 |
| Hashtag intent (buyer + seller) | Instagram | Apify | `lib/lead-pipeline/social-sourcer.ts::sourceInstagram` | `instagram` | configured hashtags | `test:scrapers` |
| Buyer/seller keyword posts | Reddit (configured subreddits) | Apify | `lib/lead-pipeline/social-sourcer.ts::sourceReddit` | `reddit` | configured subreddits/keywords | `test:scrapers` |
| **"Moving to <city>" / "looking for a realtor in <city>" (NEW)** | **Reddit (fixed relocation subs)** | **Apify** | `lib/lead-pipeline/social-sourcer.ts::sourceRedditRelocation` | `reddit_relocation` | fixed territory-centric query built from `market.city`/`state`; empty market ⇒ no-op | `test:scrapers` §Wave 65, `test:scraper-territory-gate` §Layer 1b+2 |
| FSBO / housing-wanted | Craigslist (for-sale + housing) | Apify (+ZenRows HTML fallback) | `lib/lead-pipeline/social-sourcer.ts::sourceCraigslist`/`sourceCraigslistWanted` | `craigslist` / `craigslist_wanted` | `city` param | `test:scrapers` |
| Landlord/investor seller | Craigslist apartments (`apa`) | Apify | `lib/lead-pipeline/social-sourcer.ts::sourceRentalListings` | `rental` | `city` param | `test:scrapers` |
| Buyer/seller phrase search | Google | Apify | `lib/lead-pipeline/social-sourcer.ts::sourceGoogle` + `buildTerritoryPhrases` | `google_phrase_intent` | territory-derived phrases | `test:scrapers` |
| **"Looking for a real estate agent/realtor" (NEW, cross-source)** | **Google (today); Reddit/FB lanes above also carry this signal** | **Apify** | `lib/lead-pipeline/social-sourcer.ts::sourceAgentSeekingPhraseIntent` + `source-intent-map.ts::buildAgentSeekingPhrases` | `agent_seeking_phrase_intent` | territory-derived phrases; empty market ⇒ zero phrases | `test:scrapers` §Wave 65, `test:scraper-territory-gate` §Layer 1b |
| Inbound relocation (new job) | LinkedIn | Apify | `lib/lead-pipeline/social-sourcer.ts::sourceLinkedInRelocation` | `linkedin` | territory-derived keywords | `test:scrapers` |
| Buyer intent (open-web, neural) | Open web | Exa | `lib/lead-pipeline/exa-sourcer.ts::sourceExaBuyerIntent` | `exa` | territory-derived queries | `test:scrapers` |
| Buyer/seller/investor (agentic search) | Open web | Tavily | `lib/lead-pipeline/tavily-sourcer.ts::sourceTavilyIntent` | `tavily` | territory-derived queries | `test:scrapers` |
| Distressed-seller filings | Court/public records | OSINT | `lib/lead-pipeline/osint-sourcer.ts::sourceOsintRecords` | `osint_signal` | `county`/`state` | `test:scrapers` |

Rows marked **NEW** are wave-65 builds. `market.brokerage_id` is never read from a request body
(CLAUDE.md §4) — every lane above resolves geography from `resolveActiveScrapeTerritories()`.

## New env var

`ZYTE_API_KEY` — added to `.env.example` with a comment explaining the fallback-by-configured-
key contract. `test:env-var-parity` confirms the read in `zyte-client.ts` is documented (0
undocumented reads).

## Unresolved

- Google Apify actor (`apify/google-search-scraper`) not independently re-verified live this
  research pass (kept unchanged).
- Zyte's real per-domain tier for zillow.com/realtor.com/homes.com is unknown until a live call
  reports it back (Zyte assigns tiers only after the first production request) — the ledger uses
  a Tier-3 mid-estimate, flagged in code as an estimate, not a measurement.
- `docs.zyte.com`/`zyte.com` render pricing client-side in places; the numbers above were pulled
  from the rendered/cached text Exa returned, not a browser session — cross-check against the
  live pricing page before treating the tier table as authoritative for billing.

## BatchData — wave 66 (owner: "Batchdata also allows you to find properties that are active
and other new features… enhance our lead acquisition, enrichment and listing providing.")

Research method: Exa web search/fetch against `help.batchdata.io`, `developer.batchdata.com`
(V1/V2/V3 API reference — Stoplight-rendered SPA, not executable by this lane's fetch tools) and
`batchdata.io/llms.txt`. No live paid call was made (fail-closed, `BATCHDATA_API_KEY` unset here).

| Capability | Contract | Doc URL | Limits | Blind spots |
|---|---|---|---|---|
| Smart Search (V2 Property Subscription) | `POST /api/v2/property-subscription` `{searchCriteria:{query,orQuickLists},deliveryConfig:{type:'webhook',url,headers}}` → `{status:{code:201},result:{subscriptionId}}`; `GET`/`DELETE /api/v2/property-subscription/{id}`; immutable (delete+recreate) | help.batchdata.io (fetched 2026-09-16, transcribed in the wave-66 lane prompt) | **5 subscriptions/account**, 5M properties each, 4 delivery retries; sales provisioning (7 business days + fee) | Push envelope confirmed as ids-only this wave (`propertyId`/`addedToSubscriptionIds`); the exact refusal wording for "not provisioned" was not independently observed — detected heuristically (403 or a phrase naming provisioning/sales/entitlement) |
| Property Lookup (hydrate) | `POST /api/v1/property/lookup/all-attributes` `{requests:[{propertyId}]}` | developer.batchdata.com (Exa fetch, 2026-09-16 — CONFIRMED live path, differs from the lane prompt's shorter `property/lookup`) | 100/request chunk (this repo's own conservative choice, no documented cap found) | — |
| Incremental Property Search | `options.useCursorPagination`, `options.take`, `options.pageCursor` ← previous `results.nextPageCursor`; `options.searchSession` (named, persistent, only-new delivery) | help.batchdata.io | Requires token ability `property-search-sessions` (else 403); `resultsFound` frozen from page 1; no random sort while paging | Exact 403 wording for a missing ability not independently observed — detected heuristically |
| Active-listing discovery | `orQuickLists:["on-market"]` (+ pending/expired/canceled/failed/recently-sold via the same quickList vocabulary) | help.batchdata.io | Same as the underlying Property Search | `market_active_listings` (m636) has no MLS field-level status beyond the quickList-derived bucket (active/expired/withdrawn/sold) |
| Buy Box (investor matching) | MCP tools `investor_buybox_preview`/`count`/`page` only | batchdata.io/buy-box-api (marketing copy — **no independently confirmed REST endpoint**) | MCP-only — no fallback when `BATCHDATA_MCP_URL` is unset | Per-call price not confirmed; metered at an estimate |
| Comps dataset | `comps` dataset projection on the SAME `property/search`/`property/lookup` call (14 named projections: `basic comps batchrank contact core deed demographic foreclosure image listing mortgage-liens owner permit quicklist valuation`) | developer.batchdata.com Property Lookup reference (Exa fetch, 2026-09-16 — CONFIRMED) | — | Field-level shape of a `comps` row not independently re-walked this wave (read defensively, reusing shapes this repo already trusts for the sibling datasets) |
| Wallet (balance, consumption report) | `GET wallet/balance`, `GET wallet/consumption-report` under `/api/v1` (V1 nav confirms a "Wallet" section exists) | developer.batchdata.com (Stoplight SPA — **path segments NOT independently confirmed**, following this file's own v1 naming convention as a best guess) | — | Response field names (`balance`, `totalConsumed`) are guesses read defensively across plausible shapes; treat `reconcileBatchDataWalletSpend`'s drift signal as advisory only until confirmed against a live account |

Coverage row (extends the matrix above): motivated-seller BatchData sourcing stays `lane B` (not
owned by this lane); the six capabilities above are ADDITIVE and each is its own `sourceChannel`
(`batchdata_smart_search`, `batchdata_incremental`, none for the listings feed itself — it writes
`market_active_listings` + `motivated_seller_signals`, not a raw lead — `batchdata_buybox`) so
none collapses into another (owner: never merge look-alike scraping lanes).

Files: `lib/external/batchdata-client.ts` (REST — subscription plan/create/list/delete, property
lookup, incremental search, comps, wallet, buy-box normalizer), `lib/external/batchdata-mcp.ts`
(MCP wrappers for buy-box + comps), `lib/kernel/listings-batchdata-feed.ts` (the three per-market
orchestration functions), `app/api/webhooks/batchdata-smart-search/route.ts` (ids-only envelope +
hydrate), `app/api/cron/lead-scraping/route.ts` (BatchData branch — reconcile plan, opt-in
incremental/active-listing/buy-box steps, end-of-run wallet reconcile), `lib/cma/comp-provider.ts`
(BatchData comps beside RentCast). Migrations `m635`/`m636` (WRITTEN, NOT APPLIED).

## Cap strategy + token provisioning + MCP — wave 67 (owner: "make sure our system will keep up
with the demands of our tenant subscribers… since batchdata is setup for the platform to pay, how
can we get around the caps")

Research method (owner-supplied, recorded verbatim in the wave-67 lane prompt): help.batchdata.io
+ batchdata.io/pricing, fetched 2026-09-16. No live paid call was made this wave either
(`BATCHDATA_API_KEY` unset here).

### Plan tiers (RESEARCHED FACTS — owner's commercial decision which tier to buy)

| Plan | Monthly price | Records/month | Notes |
|---|---|---|---|
| Growth | $1,000 | 100,000 | |
| Professional | $2,500 | 300,000 | |
| Scale | $5,000 | 750,000 | |
| Enterprise | $10,000 | 3,000,000 | Custom rate limits + dedicated infrastructure |

**Enterprise trigger (owner's commercial decision, never assumed in code):** the Scale tier's
per-record rate is $5,000 / 750,000 ≈ **$0.00667/record**; Enterprise's is $10,000 / 3,000,000 ≈
$0.00333/record — Enterprise is cheaper per record ONLY past its own $10,000 floor, i.e. once
sustained platform-wide consumption exceeds **750,000 records/month** (Scale's ceiling) for two+
consecutive billing periods. Below that, upgrading early just pays for headroom nobody used yet.
This repo does not auto-upgrade a plan — `fetchBatchDataWalletConsumptionReport` (existing REST
wrapper) is the measurement the owner reviews before deciding; no code path changes tier.

Skip-trace is billed **pay-as-you-go** separately from the plan tiers, ~$0.06/matched record.
Billing for every lane is **per record against whatever datasets the calling TOKEN is
provisioned for** (not runtime request params) — this is what makes the token-strategy seam
below a real lever, not just an organizational nicety: a token that only sees skip-trace traffic
never gets billed for datasets a different lane's calls asked for.

### (1) Pool Property Monitoring subscriptions BY QUICKLIST, not by (market × quicklist)

Property Monitoring is capped at **5 subscriptions PER ACCOUNT** (confirmed wave 66). The
wave-65B/66 reconcile spent that cap one (market × quicklist) pair at a time, so as few as 5
territories running distinct quicklists exhausted the account-wide cap. Wave 67 rebuilds
`buildSmartSearchSubscriptionPlan` + the cron's step 2b (`app/api/cron/lead-scraping/route.ts`)
to pool by QUICKLIST: every active territory wanting a given quicklist shares ONE subscription
whose `searchCriteria.query` is the union of their geographies
(`lib/external/batchdata-client.ts::buildPooledSmartSearchQuery`). Five slots now cover **5
quicklists platform-wide**, regardless of territory count. The per-territory row in
`batchdata_smart_search_subscriptions` survives as a MEMBERSHIP row (`pool_key`, `pooled`,
`geography_count` — migration `m637`, WRITTEN NOT APPLIED); the webhook receiver
(`app/api/webhooks/batchdata-smart-search/route.ts`) already fans a pooled event out to the
correct market by matching the hydrated property's city/zip against `lead_scraping_markets`
(`resolveActiveScrapeTerritories` + `recordMatchesTerritory`) — that fan-out needed no change,
it was already territory-centric rather than subscription-centric.

**UNRESOLVED / blind spot:** no fetched article states a multi-location `searchCriteria.query`
SYNTAX — BatchData's own documented example is a single `"City, ST"` string. The union query is
built as each territory's `"City, ST"` joined with `"; "` (deduped) as the most literal reading of
"pool the geographies"; if BatchData's parser does not accept a joined string, the query degrades
to matching only the first segment. This is visible immediately in the leads-per-subscription
count on the admin markets feed panel (a count that moves is the finding, CLAUDE.md §2) — never a
silent narrowing. The integrator should confirm the real syntax against a live account before
relying on this for full coverage.

### (2) Search-Session incremental pulls are the primary "only-new" rail

Property Monitoring (push) is the ACCELERATOR; the wave-66 Incremental Property Search
(cursor + `searchSession`, per market × quicklist lane, opt-in via `batchdata_incremental` in
`enabled_sources`) needs no subscription slot at all and is the rail every territory can run
regardless of whether its quicklist made the cut in the pooled cap above. No code change this
wave — this is a usage-pattern recommendation: enable `batchdata_incremental` broadly, treat
Smart Search admission as a bonus for whichever 5 quicklists are hottest platform-wide.

### (3) Token strategy — separate provisioned tokens per dataset need

`lib/external/batchdata-tokens.ts::resolveBatchDataToken(purpose)` resolves which env token backs
each call:

| Purpose | Env var | Falls back to | Used by |
|---|---|---|---|
| `search` | `BATCHDATA_API_KEY` | — (always this) | property/search, Smart Search subscription CRUD, address/verify, wallet reads |
| `skip_trace` | `BATCHDATA_SKIP_TRACE_TOKEN` | `BATCHDATA_API_KEY` | `property/skip-trace` (V3) |
| `listing` | `BATCHDATA_LISTING_TOKEN` | `BATCHDATA_API_KEY` | `property/lookup/all-attributes` (Smart Search hydrate, active-listing discovery) |
| `mcp` | `BATCHDATA_MCP_AUTH` | `BATCHDATA_API_KEY` | the MCP client (`lib/external/batchdata-mcp.ts`) |

Because billing is per-record against a token's OWN provisioning, a single shared token used for
every purpose gets billed at the union of every dataset any caller ever asked for — e.g. if the
search lane's token also carries listing/comps add-ons (because a search call once requested
them), every skip-trace record billed on that SAME token inherits that wider provisioning even
though skip-trace never reads those add-ons. Provisioning narrow, purpose-specific tokens (all
optional — every deployment that sets only `BATCHDATA_API_KEY` behaves exactly as before) keeps
per-record cost proportional to what each lane actually reads, and makes a runaway lane's spend
attributable to the token that caused it on BatchData's own per-token billing dashboard.

### MCP transport rebuild + AI-SDK tool surface

`lib/external/batchdata-mcp.ts` now uses the OFFICIAL `@modelcontextprotocol/sdk` `Client` +
`StreamableHTTPClientTransport` against `https://mcp.batchdata.com` (default when
`BATCHDATA_MCP_URL` is unset) with `Authorization: Bearer <mcp token>`, replacing the wave-6x
hand-rolled JSON-RPC POST. Every exported function/signature is unchanged (`investorBuybox*`,
`comparableProperty*`, `callBatchDataMcp`, `batchDataPreferMcp`) so no caller needed to change.

`@ai-sdk/mcp` (the AI-SDK-native MCP client wrapper the owner's research named) was CHECKED, not
assumed: its latest npm version is 2.0.50, targeting the `ai@4`/`ai@5`-era
`experimental_createMCPClient` shape; this repo runs `ai@6.0.16` (wave-59 ruling), whose own
exports (`Object.keys(require('ai'))`) carry no MCP client at all. Adding an unverified
major-version-mismatched dependency was judged riskier than the documented fallback, so
`lib/external/batchdata-ai-tools.ts::batchDataMcpTools()` instead wraps the official client's
`listTools()`/`callTool()` (both added to `batchdata-mcp.ts` this wave) into AI-SDK
`tool({inputSchema: jsonSchema(...), execute})` objects built from the `ai` package that IS
installed. Wired into the in-app agent copilot's tool registry
(`app/api/internal/ai-chat/route.ts` — the surface that already exposes `lookup_contact` and the
other Kernel OS action tools), gated on a configured "mcp" purpose token, tenant-scoped from the
session-resolved `brokerageId`/`user.id`, and metered per call
(`meterVendorSpend`, `usageType: "mcp_<tool name>"`).

## Active-listing source ranking for regular buyers — wave 68 (owner: "that is a lot of money to
spend for leads, is the rentcast with optional idx broker a better implementation for the smart
search buyer criteria of on the market active property listings?")

Research method: Exa `web_fetch_exa` against `rentcast.io/api` and `developers.rentcast.io/
reference/billing-and-pricing` (2 fetches — both render their price table client-side, so the
rendered markdown carries product copy and FAQ text but not the digits, the same limitation this
doc already flagged for `zyte.com`/`docs.zyte.com` above and the D-ID pricing page in wave 61).
Numbers below are RentCast's own published figures as captured by a third-party review
(`bnbcalc.com/reviews/rentcast-review-2026`, dated August 2026, read directly off RentCast's own
dashboard) — treated the same way this repo treated the Spatius D-ID breakdown in wave 61: a
mirror of the primary source, not the primary source, and flagged UNRESOLVED below pending a
direct dashboard screenshot.

### RentCast Property Data API — plan table (as captured August 2026)

| Plan | Monthly price | Included requests | Overage / request |
|---|---|---|---|
| Developer | $0 | 50 | $0.20 |
| Foundation | $74 | 1,000 | $0.06 |
| Growth | $199 | 5,000 | $0.03 |
| Scale | $449 | 25,000 | $0.015 |

Billed **per request**, not per record — one call to `/listings/sale` (or `/listings/rental/
long-term`) with a `limit` parameter returns a page of listings for that one request's cost,
whatever the page size. `lib/property/rentcast.ts` already wraps this endpoint
(`searchRentcastSaleListings`); no new client code needed for the ranking below.

### BatchData Listing Data add-on — per-record price

**Not separately published.** BatchData's own doc surface (confirmed in the wave-67 section
above) prices by PLAN TIER ($/record derived from the monthly price ÷ included records — Growth
$0.01, Professional $0.00833, Scale $0.00667, Enterprise $0.00333) and bills every pull against
whatever datasets the calling TOKEN is provisioned for, not a listed per-record SKU for "Listing
Data" specifically. State this as: **token-provisioned per-record, unpublished** — this repo's own
`fetchIncrementalPropertySearch` (the function `runActiveListingDiscoveryForMarket` calls) carries
a flat internal ledger ESTIMATE of `records.length * 0.05` (`lib/external/batchdata-client.ts`
line ~1287) for lack of a published number — 5–15× the plan-tier-derived range above, and itself a
blind spot: nobody has reconciled that literal against a real invoice.

### Worked example — 1 brokerage, 3 markets, daily refresh, 200 active listings/market

Smart search buyer criteria needs a current active-listing view per active market; the comparison
below prices REFRESHING that view once a day for 3 markets × 200 active listings each (600
property-records' worth of "what's active right now" per day, 18,000/month).

| Source | Unit cost | Daily | Monthly | Platform $ this wave's capability alone |
|---|---|---|---|---|
| **IDX broker feed** (brokerage's own MLS credential) | $0 — tenant-owned vendor relationship | $0 | $0 | **$0** — never touches the platform's BatchData/RentCast budget |
| **RentCast** | per REQUEST, not per record — 1 request/market/day covers the whole page | 3 requests | 90 requests/mo | **$8.00/mo** on Developer (50 free + 40 × $0.20 overage), or a flat **$74/mo** on Foundation (1,000 included, room to grow into per-buyer searches too) |
| **BatchData on-market quicklist** (`runActiveListingDiscoveryForMarket`) | per RECORD, full re-walk needed every cycle to detect status transitions (active→expired/withdrawn/sold), not only new-since-last | 600 records | 18,000 records/mo | **$180/mo** at the Growth plan's derived rate ($0.01/record) — **$900/mo** at this repo's own internal $0.05/record ledger estimate — either way drawn from the SAME shared $1,000–$10,000/mo plan pool every other BatchData lane (acquisition, skip-trace, comps, buy-box) also spends from |

**This is the "a lot of money" the owner named.** For the specific job of "does this buyer's box
match what's on the market right now," BatchData's per-record on-market pull costs 20×–100× what
RentCast's per-request pull costs for the identical 3-market/200-listing/day workload, and IDX
costs the platform nothing at all when the brokerage owns the feed. That is why the wave-68 DECISION
(`lib/buyer-search/listing-source-order.ts`) orders regular-buyer active-listing search IDX →
RentCast → BatchData-on-market-only-if-opted-in, while leaving BatchData PRIMARY for its own priced
job — motivated-seller/off-market ACQUISITION and Property Monitoring, which no per-request API
sells at any price (RentCast has no off-market/motivated-seller dataset at all).

### Best connection for BatchData acquisition (per owner's question, wave 68)

For ACQUISITION (motivated sellers, off-market, monitoring) — **REST v1 `property/search` with
cursor pagination + Search Sessions** (`lib/external/batchdata-client.ts::fetchIncrementalPropertySearch`,
already used by `runActiveListingDiscoveryForMarket` / `runIncrementalPropertySearchForMarket` /
`lib/buyer-search/investor-offmarket-runner.ts`) is the right connection: bulk, only-new delivery,
no LLM in the loop, cheapest per record because nothing is re-fetched that a prior page cursor
already returned. **MCP** (`https://mcp.batchdata.com`, `lib/external/batchdata-mcp.ts`, wave 67)
is the right connection for AGENT TOOLS — single-property lookups an LLM decides to make mid-
conversation (buy box preview, comps, skip-trace) — never for a scheduled bulk territory pull; the
per-call MCP overhead (tool-call framing, no cursor/session semantics documented) is the wrong
shape for "walk every active listing in 3 markets."

### Unresolved (this wave)

- RentCast's plan table above is read off a third-party mirror (`bnbcalc.com`), not RentCast's own
  rendered dashboard — both `rentcast.io/api` and `developers.rentcast.io` render the price table
  client-side and this lane's fetch tool returns pre-render markdown. Confirm against a live
  RentCast dashboard/account before treating these four numbers as billing-authoritative.
- BatchData's "Listing Data" add-on has no independently-confirmed per-record SKU distinct from
  the plan-tier $/record rate; `fetchIncrementalPropertySearch`'s `records.length * 0.05` ledger
  estimate is a placeholder 5–15× the plan-tier-derived range and has never been reconciled
  against an invoice — worth a follow-up once BatchData billing data is available.
- The worked example assumes a FULL daily re-walk of each market's active set (required to detect
  status transitions); if `market_active_listings`' existing session/cursor state ever proves the
  BatchData API delivers a smaller only-changed delta for `on-market`, the BatchData column above
  would shrink — not observed or measured this wave, flagged rather than assumed.

## IDX/RentCast — wave 69 (owner, verbatim, 2026-09-17): "rentcast is platform provided but idx
is for tenant connected if the tenant has this connection instead of rentcast option for for sale
properties. the setting page should only allow them to setup their idx connection."

Wave 68 gave the brokerage an ORDERED CHECKLIST that let them reorder or exclude idx/rentcast — a
tenant CHOICE, persisted through `app/actions/settings/active-listing-sources.ts` and rendered by
`app/dashboard/settings/integrations/lead-sources`. The owner's ruling corrects this: IDX-vs-
RentCast is not a preference, it is a FACT about whether the brokerage has connected its own MLS
feed. That action file is DELETED (tombstone at `lib/buyer-search/listing-source-order.ts:1`).

**What changed:**

- `lib/buyer-search/listing-source-order.ts::resolveActiveListingSources` now DERIVES idx-vs-
  rentcast on every call from `lib/property/rentcast-eligibility.ts::resolveRentcastEligibility`
  — the SAME IDX-credential cascade `IDXBrokerClient.forBrokerage` uses
  (`scripts/idx-tenant-credential-simulator.ts`, `test:idx-tenant-credential`). "idx" when
  connected, else "rentcast" when RentCast is eligible (platform key + vendor budget), else
  neither. An unreadable credential check fails CLOSED to `["rentcast"]` rather than guess.
- The tenant settings page (`app/dashboard/settings/integrations/lead-sources`) now shows ONLY
  the IDX Broker connection form — reused directly from
  `app/dashboard/settings/integrations/idx-broker/page.tsx` (never a second form) — plus a
  read-only line: "For-sale listings: your IDX feed when connected, otherwise the platform's
  RentCast feed." There is no checklist and no tenant write path for
  `brokerage_settings.active_listing_sources` any more.
- The ONE thing left stored in that column is the billed BatchData on-market opt-in flag — a
  platform cost decision, not a tenant one. `app/actions/superadmin/active-listing-sources.ts::
  setBrokerageActiveListingSourcesAction` (requireSuperadmin-gated) is the only writer, with a
  control on `app/dashboard/superadmin/brokerages/[id]/listing-sources-panel.tsx`. m643 narrows
  the column's COMMENT to state this and drops its DEFAULT to `[]` (no schema change).

### RentCast MCP — copilot-only, priced the same as REST

RESEARCHED (developers.rentcast.io, 2026-09-17): RentCast's MCP server is public at
`https://developers.rentcast.io/mcp`; sending `X-Api-Key: <RENTCAST_API_KEY>` enables live
requests. The docs state plainly: **"All successful API requests made using your API key,
including through the MCP server, will be counted for billing purposes."** An MCP call therefore
bills at the SAME per-request rate as REST, plus whatever LLM tokens the agent turn spends
reasoning about the call and its result — strictly more expensive than REST for identical data.

DECISION: production/scheduled/bulk RentCast pulls stay on the typed REST client
(`lib/property/rentcast.ts` + `lib/external/rentcast-typed.ts`, generated from RentCast's OpenAPI
spec). The MCP is exposed ONLY to the in-app agent copilot for ad-hoc lookups —
`lib/external/rentcast-mcp.ts` (transport: official `@modelcontextprotocol/sdk` `Client` +
`StreamableHTTPClientTransport`, mirroring `lib/external/batchdata-mcp.ts`'s shape with the one
real difference being the `X-Api-Key` header instead of BatchData's `Authorization: Bearer`) and
`lib/external/rentcast-ai-tools.ts::rentCastMcpTools(ctx)` (AI-SDK tool surface, dynamic
catalogue discovery — no hardcoded RentCast tool names — mirroring
`lib/external/batchdata-ai-tools.ts`), wired into `app/api/internal/ai-chat/route.ts` beside
`batchDataMcpTools`. Fail-closed without `RENTCAST_API_KEY` (returns `{}` — no tool that errors
on every call). Proof: `scripts/rentcast-copilot-tools-simulator.ts` (`test:rentcast-copilot-
tools`) — fail-closed, metering, and that no production pull path imports the MCP client.

### RentCast per-request price — one constant, replacing three invented ones

`lib/property/rentcast.ts` used to meter three DIFFERENT per-call estimates
(`COST_PER_LISTING_SEARCH` $0.20, `COST_PER_AVM_LOOKUP` $0.15, `COST_PER_MARKET_LOOKUP` $0.20) —
leftovers from RentCast's old "$49/mo / 250 calls" pricing, for a vendor that bills the SAME way
(per request) regardless of endpoint. Replaced by ONE constant, `RENTCAST_USD_PER_REQUEST =
0.074`, derived from the Foundation plan ($74/mo ÷ 1,000 included requests) — see the plan table
above for the other tiers (Developer $0/50 free, Growth $199/5,000 = $0.0398/req, Scale
$449/25,000 = $0.01796/req; Foundation is the assumed default tier, plan-dependent, the owner's
commercial decision). Every metered REST call site in `lib/property/rentcast.ts` and every MCP
tool call in `lib/external/rentcast-ai-tools.ts` use this SAME constant (§6 — one vocabulary),
through the existing `logVendorUsage`/`meterVendorSpend` vendor-cost ledger.

### Unresolved (wave 69)

- Two RentCast readers outside `lib/property/rentcast.ts` — `lib/lead-pipeline/
  contact-signal-rescrape.ts` and `lib/agentic-os/deal-investigator.ts` — read
  `process.env.RENTCAST_API_KEY` directly and are NOT confirmed to be metered through
  `logVendorUsage`/`meterVendorSpend`. Both are outside this lane's assigned scope (settings
  surface, resolver, migration, MCP copilot tools); flagged rather than fixed. A follow-up should
  confirm whether either issues real HTTP calls and, if so, route them through the ledger.
- `lib/cma/comp-provider.ts`'s `RENTCAST_COMPS_COST_CENTS = 15` cost-telemetry constant (a
  cents-denominated mirror of the retired `COST_PER_AVM_LOOKUP`) was not updated to
  `RENTCAST_USD_PER_REQUEST`'s value (7.4¢) — outside this lane's file scope, flagged for a
  follow-up so the CMA cost display and the vendor ledger price agree.
- The Foundation-tier assumption behind `RENTCAST_USD_PER_REQUEST` is a default, not a confirmed
  account tier — same caveat as the plan table above (read off a third-party mirror, not a live
  RentCast dashboard).

### Comps: RentCast primary, BatchData supplement, adjustment grid, attribution — wave 70

Owner ruling (verbatim): "comps for sold were being pulled from rentcast since rentcast has for
sale properties from sold to active listings and this is already built in the os. I guess it
wouldn't hurt to also add comps from batchdata to help with the ai to analyze for cma's but need
to best output for property appraisal adjusted comps without high costs."

- **Order confirmed correct, not wrong.** `lib/cma/comp-provider.ts::sourceCompsForCma` already
  had RentCast as the primary sold/active/pending source (`REQUIRED_SOLD_COMPS`,
  `PRIMARY_SOLD_WINDOW_MONTHS`, widened-window fallback — wave 17/18 build) and the BatchData
  branch (wave 69B: `comparable_property_count` pre-flight → `comparable_property_page` MCP →
  REST fallback) already ran ONLY when `closedComps.length < REQUIRED_SOLD_COMPS`, strictly
  AFTER the RentCast pull. This lane verified the order rather than finding it backwards.
- **New: same-day cache.** `lib/cma/comp-supplement-cache.ts` + `supabase/migrations/
  m645-cma-comp-supplement-cache.sql` (WRITTEN, awaiting apply) — per-subject-address,
  per-calendar-day cache of the BatchData comps supplement payload. A cache hit skips BOTH the
  free MCP pre-flight/preview AND the billed pull. Confirmed-empty results are cached too (an
  empty answer is exactly as expensive to re-fetch as a populated one); a transient failure is
  NOT cached, so a retry can still succeed.
- **Cost constant derived, not duplicated.** `RENTCAST_COMPS_COST_CENTS` in comp-provider.ts was
  a literal `15` (a leftover from RentCast's retired per-endpoint pricing, flagged unresolved in
  the wave-69 section above). Now `RENTCAST_USD_PER_REQUEST * 100` (7.4¢), imported from
  `lib/property/rentcast.ts` — one number, not two that can disagree.
- **BatchData comps metered as platform spend.** The billed `comps_lookup` call now goes through
  `meterVendorSpend` (the same gateway `lib/buyer-search/investor-offmarket-runner.ts` uses for
  every other BatchData call), `brokerageId` carried for COST-LEDGER ATTRIBUTION ONLY — never a
  tenant charge. `lib/external/batchdata-client.ts::reconcileBatchDataWalletSpend` already sums
  `vendor_usage_tracking` for vendor `'batchdata'` PLATFORM-WIDE against BatchData's own wallet
  consumption report, confirming this was always the intended accounting.
- **New: the appraisal-style adjustment grid.** `lib/cma/comp-adjustments.ts` — a deliberately
  PURE (no DB, no I/O) module adding what `lib/cma/state-adjustment-rates.ts::computeCompAdjustments`
  (the existing DB-backed, per-state, per-vintage engine — not touched, not duplicated) does not
  compute: a distance/location line item, the gross-vs-net adjustment split, a weak-comp flag at
  the Fannie Mae Selling Guide B4-1.3-09 gross>25%/net>15% thresholds, and a reconciled value
  range weighted by inverse gross adjustment. Wired into `lib/cma/ai-cma-orchestrator.ts::runAiCma`
  (`AiCmaResult.adjustmentGrid` / `.reconciledRange`, fed into the AI narrative prompt so the
  model analyzes ADJUSTED comps rather than raw sale prices) and rendered on the seller-facing
  CMA report tab. Every constant is a documented common-appraisal rule-of-thumb (sourced in the
  file's own header), never model-authored — labelled "CMA adjustments, not an appraisal"
  (`ADJUSTMENT_GRID_DISCLAIMER`) everywhere it surfaces, per CLAUDE.md §5.
- **New: `lib/listings/attribution.ts`.** One shared `listingAttributionLine(source)` +
  `<ListingAttribution />` component, rendering "Listing data provided by RentCast" on every
  RentCast-fed listing display: the buyer portal smart-search widget, buyer-home saved homes,
  the portal Top Matches panel, the buyer-match reel's payload (`examples[].attribution`, for the
  composition to render), and the CMA comp table. Tenant settings copy
  (`app/dashboard/settings/integrations/lead-sources/lead-sources-client.tsx`) now says "the
  platform feed" and never names RentCast to the tenant — the two are deliberately different
  surfaces with opposite rules (never name it in settings; always attribute it on display).
  **Unresolved:** RentCast's own Terms-of-Use attribution-clause page could not be fetched
  (`developers.rentcast.io` ToU/attribution path returned CRAWL_NOT_FOUND) — the wording above is
  the owner's own stated legal requirement, used verbatim; the exact ToU URL should be confirmed
  and recorded before this wording is treated as legally final.
- **Carried, not fixed this wave:** `app/dashboard/settings/integrations/integrations-client.tsx`
  still lists `"rentcast"` as a selectable, tenant-configurable MLS provider option
  (`PROVIDER_KEYS_BY_TYPE.mls`, label "Rentcast (no IDX needed)") on a brokerage-admin-facing
  settings page — a second surface with the same defect the lead-sources page had, and arguably
  worse (it implies a tenant can enter a RentCast credential). Confirmed nothing in
  `lib/property/rentcast.ts` / `lib/property/rentcast-eligibility.ts` reads a tenant-scoped
  RentCast credential — the entered value would be dead, written and never read. Out of this
  lane's named scope (only the lead-sources page was assigned); flagged for a follow-up.
  `AffordabilitySnapshotReel` (the buyer-match reel composition) does not yet render the new
  `examples[].attribution` field on its card — the payload carries it, the composition's caption
  layer does not yet consume it (a video-lanes-audit-scope follow-up, not a comps/CMA one).

## Behavioral + acquisition coverage audit — wave 70 (owner, verbatim, 2026-09-17): "make sure we
have covered every area of lead acquisition and enrichment scraping and behavioral scraping
opportunities… If we aren't doing this another competitor will."

### Coverage matrix — every lane named in the owner's list

| # | Lane | Provider | Status | Cost/record or /request | Territory-bound | Dedup |
|---|---|---|---|---|---|---|
| 1 | Zillow saved-search + FSBO | ZenRows | **Built** | metered per call (zenrows) | `market.city`/`state` | 3-table (raw+lead+contact) |
| 2 | Realtor.com saved-search + FSBO | ZenRows | **Built** | metered per call | yes | yes |
| 3 | Homes.com saved-search + "contact agent" chatter | ZenRows→Zyte | **Built** (wave 65) | metered per call | yes | yes |
| 4 | Redfin behavior | ZenRows (as `zenrows_homes`) | **Built** | metered per call | yes | yes |
| 5 | Zillow/Realtor/Homes "contact agent" chatter | ZenRows→Zyte | **Built** (wave 65) | metered per call | yes | yes |
| 6 | Nextdoor neighborhood chatter | ZenRows + LLM extract | **Built** | metered per call | yes | yes |
| 7 | Reddit buyer/seller keyword posts | Apify | **Built** | $0.99/1k (clearpath/reddit-search-scraper) | yes | yes |
| 8 | Reddit relocation / "looking for a realtor in \<city\>" | Apify | **Built** (wave 65) | $0.99/1k | yes | yes |
| 9 | Facebook group buyer/seller posts | Apify | **Built** | $1.50/1k | group URLs scoped to territory | yes |
| 10 | Facebook "recommend a realtor" | Apify | **Built** (wave 65) | $1.50/1k | yes | yes |
| 11 | Instagram hashtag intent | Apify | **Built** | $1.90–2.60/1k | configured hashtags | yes |
| 12 | Craigslist for-sale (FSBO) | Apify (+ZenRows HTML fallback) | **Built** | $1.4/1k | `city` param | yes |
| 13 | Craigslist "housing wanted" (buyer ISO) | Apify | **Built** | $1.4/1k | `city` param | yes |
| 14 | Google phrase intent (buyer/seller) | Apify | **Built** | Apify actor rate | territory-derived phrases | yes |
| 15 | "Looking for a real estate agent/realtor" (cross-source) | Apify (Google today) | **Built** (wave 65) | Apify actor rate | yes | yes |
| 16 | BatchData motivated-seller quicklists (foreclosure/probate/tax-lien/absentee/vacant/tired-landlord/high-equity/inherited) | BatchData REST | **Built** | plan-tier $/record ($0.00333–$0.01) | yes | yes |
| 17 | Property Monitoring (push, pooled by quicklist) | BatchData Smart Search | **Built** (wave 66/67) | shares the plan-tier pool, 5 subs/account | per-subscription geography union | membership row |
| 18 | Incremental Property Search (cursor, only-new) | BatchData REST | **Built** (wave 66) | plan-tier $/record | per (market×quicklist) | search-session state |
| 19 | Buy Box (investor demand per listing) | BatchData MCP | **Built** (wave 66) | unconfirmed per-call price | per market | yes |
| 20 | Active/expired/withdrawn/sold transitions | BatchData quicklist + IDX/RentCast | **Built** (wave 66/68) | IDX $0 → RentCast $0.074/req → BatchData opt-in | per market | relisting-detector |
| 21 | LinkedIn job-change/relocation | Apify (`linkedin_relocation`) | **Built** | Apify actor rate | territory-derived keywords | yes |
| 22 | Divorce/probate/tax-lien/pre-foreclosure court records | OSINT (`osint_signal`) | **Built** | per public-records call | `county`/`state` | yes |
| 23 | New-construction/builder lists | — | **Missing** | — | — | — |
| 24 | Rental-to-buyer graduation | — | **Partial** — `rental_listing` (Craigslist `apa`) sources the LANDLORD as a seller lead; nothing follows the TENANT side (a renter approaching lease-end as a future buyer) | — | — | — |
| 25 | Absentee / out-of-state owner | BatchData quicklist (`absentee`) | **Built** | plan-tier $/record | yes | yes |
| 26 | Lead magnets (guides, calculators) | `form_submissions` intake | **Built** (pre-existing, outside this pipeline — direct-consent intake, not raw scraping) | $0 | n/a (consented) | contact-direct |
| 27 | IDX/portal behavior (saved searches, favorites) | internal (`lead_idx_property_interactions`, m630/m631) | **Built** (pre-existing) | $0 | n/a | n/a |
| 28 | **Website visitor identification (anonymous, own site)** | internal (`website_visitors`) | **Was Missing → Built this wave** | **$0** | brokerage-scoped (own site) | identity-key dedup |
| 29 | Email engagement (opens/clicks) | — | **Missing** | — | — | — |
| 30 | Open-house sign-ins | `form_submissions` (open_house context) + conversion-welcome | **Built** (pre-existing, consented intake) | $0 | n/a | contact-direct |
| 31 | Review/reputation chatter (as an ACQUISITION signal, not just reputation response) | — | **Missing** as acquisition — `lib/reputation/*` exists for the tenant's OWN review responses, not for sourcing new leads from public review chatter | — | — | — |
| 32 | Permit / pre-listing signals | — | **Missing** | — | — | — |

### Totals

**Built: 25 / 32 · Partial: 1 / 32 · Missing: 6 / 32** (new-construction/builder lists, email
engagement, review/reputation-as-acquisition, permit/pre-listing signals, rental-to-buyer
graduation's tenant-side half, and — until this wave — website visitor identification).

### What this lane built — website visitor identification ($0/record, the cheapest lane possible)

**Why this one.** Compared against every other missing lane, this was the only one requiring
literally $0 marginal spend: the data (`website_visitors`, written by the existing pixel
`app/api/track/pixel` and dwell beacon `app/api/track/dwell`) was already being collected for a
DIFFERENT purpose (matching a KNOWN contact/lead to a session via `/api/track/identify`) and never
read for acquisition. LinkedIn job-change/relocation is already partially covered
(`sourceLinkedInRelocation`, wave 65) and every other missing lane (new-construction lists, email
engagement, permit records, review-as-acquisition) needs a new paid vendor relationship this lane
was not scoped to procure. Picked by cost (lowest possible: $0) and evidence (the gap was concrete
and provable from code, not speculative).

**Built:** `lib/lead-pipeline/site-visitor-sourcer.ts::sourceSiteVisitorIntent` reads
`website_visitors` for one brokerage's still-unidentified (`contact_id`/`lead_id`/`identified_at`
all null) sessions with ≥60s dwell (the same bar `lib/kernel/site-traffic-insights.ts` already uses
for its "stickiest page" verdict) in a 6-hour lookback (matching the cron's own cadence), and
normalizes each into a `NormalizedScrapedRecord` (`username`=session_id, `sourceUrl`=page_url,
`intentType`='buyer', signals `long_dwell` / `listing_page_view` when the URL looks like a
listing/property page / `return_visit` / `campaign_referred`). Wired into
`app/api/cron/lead-scraping/route.ts` behind `enabledSources.has("site_visitor_intent")`, running
ONCE per brokerage (not once per territory — website traffic is brokerage-wide, tracked with a
`siteVisitorBrokeragesRun` set keyed on the priority-ordered market loop) with `brokerageId` passed
EXPLICITLY (this is the tenant's OWN site — `source_origin='brokerage'` immediately, never the
platform pool every other lane in this cron defaults to). `sourceChannel='site_visitor_intent'`,
`sourceFamily` param (now `scrape_category`, see the m647 fix below) `='site_behavior'`.
`batchCostUsd: 0` passed explicitly. No new cron — folded into the existing lead-scraping tick, so
no invocation-count change and no `cron-cost-census.ts --write-baseline` needed.

**source-intent-map.ts:** new `SourceKey` `site_visitor_intent` (SOURCE_MAP entry: intentType
buyer, scoreRange [25,55], baseScore 35, identityPolicy enrichment_first — anonymous by
construction, real identity resolution stays `/api/track/identify`'s job), `SOURCE_ALIASES`
(`site_visitor`/`website_visitor`/`website_visitor_intent`), new `ScrapeVendor` member `'internal'`
(first-party, never appears in `vendor_usage_tracking` — `meterVendorSpend` no-ops on cost≤0 by
design), `GATE_TOKEN` entry.

**Territory:** bounded to the calling market's own `brokerage_id` — nested inside
`resolveActiveScrapeTerritories()`'s active-subscriber loop, so a churned/inactive brokerage's
traffic is never sourced. **Dedup:** `isViableRecord` (username present) +
`buildLeadIdentityKey` (`user:<session>|src:<page_url>`) — `ingestRawSourceBatch`'s existing
3-table dedup carries the load, no bespoke dedup needed. **Cost:** metered explicitly at
`batchCostUsd: 0` (never omitted, so `cost_per_record` reads null-not-fabricated per the kernel's
own contract, not a stale inherited estimate).

**Proof extension:** `scripts/scraper-simulator.ts` — see the proof output quoted in the lane
report; asserts the new SOURCE_MAP/SOURCE_VENDOR/GATE_TOKEN entries and
`normalizeSiteVisitorRow`'s pure classification (long_dwell / listing_page_view / return_visit /
campaign_referred, and the null-return on a session or page-less row).

### Fixed in passing — raw_scraped_leads.source_family / scrape_category (m647)

While reading `lib/kernel/scraping.ts::ingestRawSourceBatch` for this audit (required reading per
the task), found that `raw_scraped_leads.source_family` carries a LIVE CHECK restricted to the
LINEAGE vocabulary (`'raw' | 'lead' | 'contact_direct'`, confirmed against a real
`public.live_check_constraints_json()` dump and `scripts/check-vocabularies.ts:1283`) — but every
production caller of `ingestRawSourceBatch` (the cron, the BatchData webhook, the two
`lead-intelligence.ts` call sites, `listings-batchdata-feed.ts`) writes the SCRAPE-CATEGORY
vocabulary (`'property_search' | 'motivated_seller' | 'social_intent' | 'distressed_signal' |
'investor_demand'`) into that SAME column. None of those five values is admitted by the live CHECK,
so every governed scraping insert has been silently refused (the catch-all error handling buckets
any insert error, CHECK violations included, into `skipped_duplicate`) since the CHECK's
introduction — invisible to `check-vocabulary-guard.ts` because it only flags LITERAL comparisons
in the SAME file as the `.insert()` call, and invisible to `scripts/production-smoke-drill.ts`
(the one live-DB proof) because its hand-rolled insert never sets `source_family` at all. **Fixed**
(m647, WRITTEN NOT APPLIED): added `raw_scraped_leads.scrape_category` (free text, vocabulary
governed by `source-intent-map.ts`'s `SourceKey`); `ingestRawSourceBatch` and
`normalizeRawSourceRecord` now write the correct lineage constant `'raw'` to `source_family` and
the scrape category to the new column; the two real per-row readers
(`lib/lead-intelligence/person-timeline.ts`, `app/actions/lead-promotion/promote-lead.ts`) repointed
to `scrape_category`. `app/actions/source-analytics.ts`'s raw-record funnel counting was verified
UNAFFECTED — it already hardcodes the `"raw"` family for every `raw_scraped_leads` row rather than
trusting the column's actual (until now, wrong) value. Full trace in the migration's own header.
This means `raw_scraped_leads` has structurally held ~zero governed-writer rows to date in the live
database — a blind spot beside the "N leads created" counts every prior wave's cron run has
reported, which counted `ingestRawSourceBatch`'s `result.inserted` (which never actually
incremented against a real CHECK, since it only exists in that function's own in-memory counter
before the DB round-trip refuses the row) — **unresolved pending the integrator applying m647 and
confirming a real insert against the live database.**

### Part 3 — RentCast metering carry (wave 69 unresolved, closed this wave)

`lib/lead-pipeline/contact-signal-rescrape.ts` (`wantAvm` block) and
`lib/agentic-os/deal-investigator.ts` (MLS step) both read `process.env.RENTCAST_API_KEY` directly
and called `callRentcastGet("/avm/value", ...)` unmetered — a flat display-only `cost: 0.01`/`$0.01`
that was never logged to `vendor_usage_tracking` and skipped the platform vendor-budget gate
(`lib/property/rentcast.ts::gateRentcast`) every other RentCast caller in the tree goes through.
Both now call `lib/property/rentcast.ts::getRentcastAVM({ brokerageId, address, systemSource,
contactId })`, booking every request at `RENTCAST_USD_PER_REQUEST` ($0.074) through the same
metered client + budget gate as the rest of the codebase. `deal-investigator.ts` and
`contact-signal-rescrape.ts` both needed `contacts.brokerage_id` added to their existing
`.select()` (it was not previously selected) to have a tenant to meter against; a contact somehow
missing `brokerage_id` now fails the RentCast step closed with a named warning rather than an
unmetered live call.

**Simli** — confirmed still absent: `docs/face-render-backup-simli-2026-09.md:99` ("No Simli
session was run (no `SIMLI_API_KEY` in this environment)"), `.env.example:77` carries the key name
with no value. Left as documented — no action needed.
