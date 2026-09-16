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
