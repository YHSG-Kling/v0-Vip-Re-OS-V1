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
