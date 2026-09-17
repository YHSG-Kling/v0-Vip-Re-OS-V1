# Real-estate data provider evaluation — 2026-09 (wave 71B)

Owner (wave 71, verbatim): *"check out maybe some other providers for real
estate data that won't cost a lot and can handle all of our needs."*

**Headline verdict: no new provider seam is justified this wave.** Every need
this OS has is already served by a resolver built in a prior wave (RentCast
platform feed, BatchData platform feed, IDX tenant feed), and every
candidate researched here (Tovo Data, ATTOM, HouseCanary, Zillow) either
publishes no per-call unit price or is enterprise/quote-only — CLAUDE.md §2
("a count without its denominator is not a measurement") applies to price
comparisons too: a provider whose per-record cost cannot be read is not
provably cheaper, so no seam is built against it. Rule from the wave-71
ruling: *"build a seam ONLY where a provider is cheaper at equal quality for
a need we have; never a second resolver."* Every row below is `keep` or
`quote-needed`; none is `replace`.

## 1. Needs × current resolver × verdict

| Need (source in repo) | Current provider(s) | Unit price today | Verdict |
|---|---|---|---|
| Active/sold/pending listings, regular buyers (`lib/buyer-search/listing-source-order.ts`) | IDX (tenant feed) → RentCast (platform) → BatchData on-market (opt-in) | RentCast `RENTCAST_USD_PER_REQUEST=$0.074`/req (`lib/property/rentcast.ts:124`); IDX $0 (tenant-owned) | **keep** — wave 69 ruling already orders these correctly; IDX is free and RentCast is 20–100× cheaper than BatchData for this job (see §3) |
| Sold/active/pending comps for CMA (`lib/cma/comp-provider.ts`) | RentCast primary (`REQUIRED_SOLD_COMPS`, `PRIMARY_SOLD_WINDOW_MONTHS`), BatchData supplement when short (`comp-provider.ts:567`) | RentCast $0.074/req; BatchData `BATCHDATA_COMPS_COST_CENTS=5¢`/pull (`batchdata-client.ts:1400`) | **keep** — wave 70 ruling; already built, both wired |
| AVM (`lib/avm/provider-chain.ts`) | RentCast → BatchData → ZenRows/Zillow scrape → Perplexity → OSINT → cached → market-appreciation fallback (`AvmSource` union, `provider-chain.ts:33`) | RentCast $0.074/req; others per their own metered rate | **keep** — 7-deep fallback chain already covers cost/coverage tradeoffs |
| Owner/skip-trace/right-party contact (`lib/external/batchdata-client.ts::skipTraceBatchDataV3Batch`) | BatchData V3 skip-trace | $0.15/match-attempt in code (`batchdata-client.ts:1031`) — **note**: this is code's own ledger estimate, higher than the wave-67 researched figure (~$0.06/matched record); unreconciled against an invoice, flagged as a blind spot, not a defect to fix this wave | **keep** — BatchData is the named right-party-contact leader (76% right-party contact per the wave-71 BatchData blog citation); Tovo/ATTOM do not publish a skip-trace SKU at all |
| Motivated-seller quicklists (pre-foreclosure, absentee, vacant, inherited, tired-landlord) (`lib/external/batchdata-client.ts::fetchMotivatedSellers`, `quickListSlugsFor`) | BatchData quicklists | Plan-tier $/record: Growth $0.01, Professional $0.00833, Scale $0.00667, Enterprise $0.00333 (wave 67/68) | **keep** — this is exactly what BatchData is priced for; Tovo's page claims "marketing lists" and foreclosure coverage but publishes no per-record price to compare against |
| Property monitoring (`lib/kernel/listings-batchdata-feed.ts`, pooled-by-quicklist subscriptions) | BatchData Property Monitoring (5 subscriptions/account, pooled by quicklist, wave 67) | Same plan-tier pool as above | **keep** — no competitor researched here offers a push/subscription monitoring product; RentCast and Tovo are pull-only |
| Investor buy-box matching (`lib/external/batchdata-mcp.ts::investorBuyboxPreview/Count/Page`) | BatchData MCP (`investor_buybox_*`) | Not independently confirmed — metered at `MCP_TOOL_CALL_COST_USD=$0.05`/call estimate (`batchdata-ai-tools.ts:53`) | **keep** — MCP-only, no REST equivalent exists per wave 67/68 research; no other provider in this evaluation publishes a buy-box product |
| Comps supplement (already covered above) | BatchData | 5¢/pull | **keep** |
| Address verification (`lib/external/lob-address-verify.ts` survivor, `verifyAddressBatchData` fallback) | Lob (primary), BatchData Address APIs (fallback when Lob unconfigured) | Lob `PLATFORM_VENDOR_RATES.lob=$0.84/piece` (mail, different job) — address-verify-only pricing not separately broken out; BatchData address verify billed against the search token | **keep** — Lob is the named survivor (CLAUDE.md §1 tombstone in `lib/lead-pipeline/promotion-address-verification.ts`); no candidate here publishes a cheaper standalone address-verify SKU |
| Phone verification / DNC / TCPA flags (`lib/external/batchdata-mcp.ts::verifyPhone/checkDncStatus/checkTcpaStatus`, `lib/communication/tcpa-gate.ts`) | BatchData MCP | Metered at the same `MCP_TOOL_CALL_COST_USD=$0.05` estimate | **keep** — this is the outbound-gate scrub-before-use rail (wave 68); switching providers here would touch a compliance-critical gate for no proven savings |

## 2. Candidate providers researched this wave

| Provider | Price (published) | Coverage | SDK/MCP | Verdict |
|---|---|---|---|---|
| **RentCast** (incumbent) | Developer $0/50 req/mo; Foundation $74/1,000; Growth $199/5,000; Scale $449/25,000; per-request overage (`RENTCAST_USD_PER_REQUEST=0.074` = Foundation tier, `lib/property/rentcast.ts:124`) | For-sale/rental listings, AVM, comps, market stats | Typed OpenAPI REST client (production) + public MCP (`developers.rentcast.io/mcp`, agent-copilot only — wave 69 ruling: MCP bills the same per-request rate **plus** LLM tokens, so it never replaces the REST path) | **keep** — cheapest per-request active-listing/comp/AVM source with a real coverage record already proven in this codebase |
| **BatchData** (incumbent) | Growth $1,000/100k records ($0.01/rec), Professional $2,500/300k ($0.00833/rec), Scale $5,000/750k ($0.00667/rec), Enterprise $10,000/3M ($0.00333/rec); skip-trace pay-as-you-go; official MCP at `mcp.batchdata.com` | Motivated-seller quicklists, property monitoring, buy-box, skip-trace, DNC/TCPA, comps supplement, address/geocode | REST (typed client) + official MCP, both already built | **keep** — no researched alternative publishes an equivalent off-market/skip-trace/monitoring/buy-box product at any price |
| **Tovo Data** (tovodata.com) | Starter $50 (credit plan, 50 free credits, no card) / Builder $400 (credit plan) — **fetched `tovodata.com/real-estate-api-pricing/` directly (2026-09-17): confirms the two named plans and the feature list (150+ Million Properties, Multisource, Ownership Data, Property Characteristics, Property Valuation, Mortgage Details, Listing Data, Liens, Swagger). The page does NOT publish a per-credit or per-call unit price** — it is credit-plan pricing with the conversion rate withheld (client-rendered checkout, confirmed by a second fetch attempt at `tovodata.com/pricing/` returning not-found and `docs.tovodata.com` timing out). | Tax assessor, deeds/mortgages, AVM, assignments/releases, foreclosure (pre-foreclosure→REO), marketing lists — broad overlap with BatchData's coverage on paper | Swagger/REST only (no MCP mentioned) | **quote-needed** — cannot compute a $/record comparison without the unit price; request a quote before considering a seam. Per the wave-71 ruling's own prediction, this is NOT a seam this wave. |
| **ATTOM** (api.gateway.attomdata.com) | Enterprise pricing, 30-day trial; gateway is live (`{"name":"APIGateway","message":"I'm alive!"}`, fetched 2026-09-17) but no public price list | 158M properties (tax assessor, deeds, AVM, foreclosure) | REST only, no SDK found | **quote-needed** — enterprise/custom pricing, no public per-record rate to compare |
| **HouseCanary** | Enterprise/quote-based (no fetch performed — no public self-serve price page exists per the wave-71 research) | Predictive AVM, forecasting | REST | **quote-needed** — same reasoning; predictive-AVM is not a gap this repo has (`lib/avm/provider-chain.ts` already has a 7-provider fallback chain) |
| **Zillow** | Public third-party API retired; Zestimate only available through a Bridge Interactive partner agreement | Zestimate, listing display | None self-serve | **not viable** — no public API surface to integrate against; would require a separate partner agreement outside this evaluation's scope |

## 3. Monthly cost delta — 3-market brokerage (repo's own volume assumption)

Reused verbatim from `docs/lead-acquisition-coverage-2026-09.md`'s worked
example (§"Worked example — 1 brokerage, 3 markets, daily refresh, 200
active listings/market") — the repo's own stated volume assumption for a
3-market tenant, not a new guess:

> 3 markets × 200 active listings each, refreshed once/day = 600
> property-records'-worth/day, 18,000/month.

| Source | Monthly cost for this workload | Note |
|---|---:|---|
| IDX (tenant-owned) | $0 | Never touches platform spend |
| RentCast (platform, current default when no IDX) | $8.00/mo (Developer: 50 free + 40×$0.20 overage) or $74/mo flat (Foundation) | 1 request/market/day = 90 requests/mo total |
| BatchData on-market quicklist (opt-in only) | $180/mo (Growth-plan derived rate) to $900/mo (this repo's own internal ledger estimate) | Full re-walk needed every cycle; shares the same $1,000–$10,000/mo pool as every other BatchData lane |
| Tovo Data | **cannot compute** — no published per-record or per-credit rate | Would need a quote naming $/record before this row can be filled in |
| ATTOM | **cannot compute** — enterprise pricing, no public rate | Same blind spot |

**Delta**: switching this workload from RentCast to Tovo or ATTOM cannot be
shown to save money — there is nothing to subtract. The only provable
comparison remains the one wave 68/69 already ruled on: RentCast ($8–$74/mo)
beats BatchData on-market ($180–$900/mo) by 20×–100× for this exact job,
which is why the source order stays IDX → RentCast → BatchData-opt-in.

## 4. Investor persona (wave 69 ruling, already built)

*"investor buyers portal persona is different than the regular real estate
buyer… if it is for the investor with giving them just off market but most
likely to sell, that is just showing them the properties nothing else."*
Investors get **property-only fields** (address, city/state/zip, estimated
value, beds/baths/property type, quicklist tags, likelihood band) — no
owner name/phone/email/mailing address, no equity %, no agent analytics.
Enforced at the reader boundary in `lib/buyer-search/investor-facing.ts`
(`toInvestorFacingCandidate(s)`, `OWNER_FIELDS` + `equity_percent` stripped).
Part 2 of this lane's build (`lib/ai-isa/batchdata-isa-tools.ts`) applies the
same boundary to the AI tool surface: the `investor` persona's tool set
carries no skip-trace/owner-contact tool at all, and its property-search/
comps/buy-box tool results are mapped through the same redaction shape
before the model ever sees them (§2c below).

## 5. Blind spots

- Tovo Data and ATTOM per-record/per-call unit prices are genuinely
  unpublished on their public pages (2 fetches spent on Tovo, 1 on ATTOM,
  per the task's fetch budget) — "unpublished — request quote" is recorded
  rather than guessed, per CLAUDE.md §1 ("unresolved beats a guess").
- BatchData's own skip-trace cost is recorded TWO ways in this repo: the
  wave-67 researched figure (~$0.06/matched record) and the code's actual
  ledger charge (`$0.15`/match-attempt, `batchdata-client.ts:1031`). Neither
  has been reconciled against a real invoice — flagged, not fixed, this wave
  (out of scope: this lane does not touch `lib/external/*` scraping-frozen
  files).
- RentCast's own plan table (used throughout this doc and the repo) is read
  off a third-party mirror per `docs/lead-acquisition-coverage-2026-09.md`'s
  own unresolved note — not RentCast's live dashboard.
- HouseCanary was not fetched (task said no fetch needed) — its "quote-based"
  verdict rests entirely on the wave-71 lane-prompt research, not this lane's
  own confirmation.

## 6. Seam built this wave

**None.** Per the rule stated in §0 and confirmed by every row in §1/§2, no
candidate provider is verifiably cheaper at equal quality for a need this OS
already has a resolver for. Building a `CompProviderId`/`AvmSource` entry for
Tovo or ATTOM without a unit price would be a second resolver with no
provable cost benefit — exactly what CLAUDE.md §1 and the wave-71 ruling
forbid. If Tovo or ATTOM later publish a per-record/per-call quote, the seam
design (for the record) would be: add `"tovo"` / `"attom"` to `AvmSource` in
`lib/avm/provider-chain.ts` or to `CompProviderId` in `lib/cma/comp-types.ts`,
gate behind a platform flag defaulting off (mirrors
`brokerage_settings.active_listing_sources`'s `batchdata_on_market` opt-in
pattern), fail closed without an API key (mirrors every provider client in
this repo), and meter through `meterVendorSpend` with the quoted unit price
as a named constant (mirrors `RENTCAST_USD_PER_REQUEST` /
`BATCHDATA_COMPS_COST_CENTS`) — never a hand-rolled second per-record price.
