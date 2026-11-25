# Wave 156 — provider decision packet (lane 156G)

**For the owner. This packet supports a decision. It does not choose a vendor.** No provider is authorized for paid
activation. Nothing was bought, no account was opened, no paid or live provider call was made, and no key was requested
while writing this. Every vendor price below is a public **indication** read on the date shown. None of them is an executed
quote for this platform.

The measure that matters is **cost per verified usable person**, not cost per credit or per row:

```
fully loaded cost per usable person =
  (subscription allocation + billed requests/records + AI/scraper/tool costs + validation/corrections)
  ÷ unique, correctly matched, fresh, licensed, actionable persons
```

This formula is now in code (`lib/vendor-governance/acquisition-economics.ts` `foldCohortFinance`). The platform console
(`/dashboard/superadmin/connector-healing`) shows it. Any part nobody has measured is shown as unknown, and every figure
then reads as a lower bound.

---

## 1. Answer first

1. **RentCast stays the property-data primary.** Its billing is per *successful* request (HTTP 200 with a body), and it offers
   **no hard usage cap**. This wave makes the platform enforce its own cap. It also stops the platform booking failed requests
   as spend, which it had been doing. At 10,000 property reads a month, **Growth ($199 + overage) is cheaper than Scale**.
   At 50,000, **Scale** is cheaper (§4). The ledger still books every request at the Foundation rate ($0.074), so once a plan
   is chosen, that constant must change with it (§8, OWNER-HELD).
2. **The Versium figure that matters is the minimum, not "$0.02 per match".** The annual plan is $5,000 a year, which is
   **$416.67 a month whatever is used**. At 1,000 matches a month, the real rate is about $0.42 per credit (§4, modeled in
   code by `costUnderCommitment`). Versium's own pricing page also puts "build Versium data into your own products and
   services" under a separate **Reseller** tier: custom price, and "Must be a registered data broker". A multi-tenant SaaS may
   fall into that tier. Its price is **unknown** until sales quotes it.
3. **Datafiniti's datasets have to be judged one at a time.** Its *People* data is small for consumer contact: the people-data
   page claims 6.9 M emails and 4.8 M phones nationwide. Its *Property* data is broad: about 122 M single-family records, plus
   new business-to-property links in the November 2026 release. Its *Business* data is a possible join. Its *Product* data has
   no customer use here. Datafiniti stays **dormant pending rights**: its license terms for a multi-tenant SaaS have not been
   read, and in that state it makes **zero spend**, which this wave's guard proves.
4. **Perplexity "Computer" is not a pipeline component.** It is a consumer and pro agent product. The **Search API**
   (per-request) is the part that could compete with Exa. Nothing here shows it is better than the current Exa + AI Gateway
   setup. A paid benchmark would need the owner's authorization (§6).
5. **The pilot below is designed, not approved.** Its budget is **UNAPPROVED**.

---

## 2. Price and plan knowledge that was already in the repository (reconciled)

| Fact in the repository | Where | Current official reading (fetched 2026-11-25) | Status |
|---|---|---|---|
| RentCast `RENTCAST_USD_PER_REQUEST = 0.074` (Foundation $74 / 1,000) | `lib/property/rentcast.ts` | Plan prices are published, but the page rendered only the "$0.20 per request" (Developer overage) and "$0.015 per request" / "25,000 per month" (Scale) cells | Still correct for the **Foundation** assumption. It is **wrong as an invoice** under any other plan (§4) |
| RentCast plan table: Developer $0/50, Foundation $74/1,000, Growth $199/5,000, Scale $449/25,000; overage $0.20 / $0.06 / $0.03 / $0.015 | `docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md` §10 (read 2026-11-03) | Developer 50 free, overage $0.20; Scale 25,000 at $0.015 overage. Foundation and Growth cells **not re-verified today** | Partly re-verified |
| RentCast "no vendor-side cap" | directive | "We do not currently support hard usage caps or automatic API request blocking … recommend implementing usage monitoring and API request blocking in your own application code" | **Verified.** Now enforced (§3) |
| RentCast bills per **successful** request | `lib/property/rentcast.ts` header | "A 'successful API request' is an HTTP request … that returns a 200 status code and a response body … You will also not be billed for requests that return an error" | **Verified.** The code had been booking failures (fixed, §3) |
| Versium `VERSIUM_MATCH_CREDIT_USD = 0.05` (package ceiling), credit weights (email 1, phone 1, full demographic 3, …) | `lib/external/versium-client.ts` | Packages: "$250 for 5,000 match credits, $0.05 per match credit, lower on larger packages", seven packages from 5K to 500K, credits never expire. Annual: "Starting at $5,000 per year for 250,000 match credits … $0.02 and lower … as low as $0.005", overage "at your fixed rate", balance resets at term end | Ceiling still correct |
| Versium "pay as you go $0.075–$0.05, $125 minimum per file, no API" | CUSTOMER-360 §10 (read 2026-10-29) | **No longer on the page.** Credit packages and annual plans only, both with API + MCP | **Stale.** Superseded |
| Versium "~$0.017 per match" (directive) | directive | Page reads "$0.02 and lower … as low as $0.005 for high volume subscriptions" | A volume floor, not a quote |
| Versium rights: "standard terms forbid caching and service-bureau use"; signed terms unverified | `PROVIDER_ACTIVATION.versium` | Pricing page: the Reseller / distributor tier is the one that "build[s] Versium data into your own products"; "Must be a registered data broker" | **Unresolved.** The owner must read the signed agreement |
| Datafiniti people plans 100/$19 · 1K/$99 · 5K/$499 · 10k/$749 · 50k/$3,499 | `lib/vendor-governance/cost-normalizer.ts` (read 2026-11-16) | The people-data page **no longer lists prices** ("pricing adjusts based on the number of records"). datafiniti.co/pricing returned not-found. The docs' sample `plan_ids` show `people-1k-99`, `property-10k-349` | **Not verified today.** Kept as indications only |
| Datafiniti `df_count` / `df_get_schema` / `df_download_status` free; `df_search` per returned record | `DATAFINITI_TOOL_CHARGE` | mcp-server page: count, schema and download_status are "None"; search is "Charged like REST /search". October release log: `df_get_record` costs **1 credit**; `df_start_download` is charged "per record found" | Verified |
| BatchData $0.07 / match skip trace; plans from $1,000–$2,000 a month, annual commitment | rail + CUSTOMER-360 §10 | Not re-read this wave | Unchanged, **dormant survivor** |
| PeopleData Labs $0.25 / match | `lib/external/peopledata-client.ts` | Not re-read this wave | Unchanged, **dormant survivor** |
| Perplexity Sonar used by the public-records rung (`lookupPropertyByAddress`) | `lib/property/address-lookup.ts` | docs.perplexity.ai: "Sonar Chat Completions has been superseded by the Agent API" (legacy page). Search API is $5 / 1,000 successful requests ($1 Fast) | Worth knowing. The rung goes through the AI Gateway, so it is not changed here |

---

## 3. What the code enforces after this wave (proof: `scripts/wave156-g-provider-economics-guard.ts`, 62/62)

| Rule | Mechanism | Driven proof |
|---|---|---|
| The platform has its own RentCast hard cutoff | `reserveRentcastPlatformRequest` (`lib/property/rentcast-eligibility.ts`) runs before every REST request (`lib/property/rentcast.ts` foot) and every MCP tool call (`lib/external/rentcast-ai-tools.ts`). The ceiling comes from `platform_settings.provider_request_caps.rentcast.monthly_requests` (m1019). If none is set, it is the plan's included requests (1,000), so there is **no paid overage until the owner authorizes some**. If the cap cannot be read, the request is refused | §C: refused at 1,000 with zero egress; the next request after 999 goes out and the one after it is refused; an owner ceiling of 5 holds; an unreadable ledger refuses; the MCP door is refused |
| Only successful calls are booked | `meterCall` returns early unless the response was `ok`. The MCP door meters only `result.ok` | §A: a 500 books 0 rows, a 200 books 1. §C: a failed MCP call books 0 |
| The same property is never bought twice | `cachedRentcastRead` is single-flight per address key, on top of the existing 30-day read-through cache | §B: two concurrent reads give 1 request; a later read is a cache hit; two different addresses give 2 requests |
| Pre-pull waterfall | `decidePrePull` (`lib/ai-isa/property-lookup-rail.ts`, beside `routeCapability`). Order: own record → already purchased → free count → licensed and healthy route → budget → identity → cheapest licensed provider → narrow supplement. `runVersiumContactLeg` asks its rights step | §E: every stage |
| Failover only where licensed | `routeCapability(…, activation)` leaves out any provider whose `PROVIDER_ACTIVATION.state` is not `active`, and says why | §E: dormant BatchData is never the supplement; once licensed, it is (positive control) |
| Dormant Datafiniti spends nothing; a free count never downloads | `runDatafinitiDatasetDoor` (unchanged, now pinned) | §D: 0 calls on the platform route and on a pending tenant key; the preflight positive control shows schema + count only, 0 charged |
| Tenant-owned credentials stay tenant-owned | The Datafiniti credential resolver never falls back to the platform token; the door refuses another tenant's connection | §D |
| A dormant or simulated provider is never shown as connected | Settings services: env-derived `connected` becomes `configured`, and BatchData / PeopleData become `dormant`. Platform console: an accepted dormant key reads "Key accepted — dormant, not routed". The HouseCanary "test" no longer makes a **billed valuation** call | §H |

---

## 4. Fully loaded economics: 10,000 and 50,000 consumers a month

**Every input below is labeled.** **[V]** means read from a vendor page on the date given. **[R]** means a repository constant.
**[A]** means an ASSUMPTION the pilot must replace. A result built on an [A] is a scenario, not a forecast.

### Assumptions

- [A] One consumer is one person record that needs a contact point plus the facts of one property.
- [A] One RentCast property-record request per consumer, with 0% cache reuse (worst case). The guard proves reuse, but its rate
  is not measured.
- [A] A Lead asks for **email only** (leads get email + direct mail, per the code in `runVersiumContactLeg`), which is 1 match
  credit per matched email [V weights, read 2026-10-23].
- [A] Versium match rate scenarios: 40% / 60% / 80%. No match rate has been measured. A no-match is free [R].
- [A] Correct-match share: 90% (the blinded verification in §7 replaces it). "Fresh, licensed, actionable" is taken as 100% of
  correct matches, which is optimistic.
- [A] Credit-package price: **$0.05 per credit** (the 5K package rate, the published ceiling). Larger packages are "lower" [V],
  with exact prices unpublished.
- AI / scraper / tool costs and validation / corrections: **UNKNOWN**. They are left out, so every figure below is a
  **LOWER BOUND**.
- Subscription allocation: only the plan that the volume forces (shown in each row).

### RentCast (property facts): plan choice by volume [V/R]

| Requests / month | Foundation ($74 / 1,000; overage $0.06) | Growth ($199 / 5,000; $0.03) | Scale ($449 / 25,000; $0.015) | Cheapest |
|---|---|---|---|---|
| 10,000 | $614 | **$349** | $449 | Growth, $0.0349 / request |
| 50,000 | $3,014 | $1,549 | **$824** | Scale, $0.0165 / request |

The platform's hard cutoff (§3) defaults to the plan's included requests. At 10,000 a month on Growth, the owner sets
`monthly_requests` to 10,000, which authorizes 5,000 overage requests ($150). Until that is set, the cutoff stops at 1,000.

### Versium (email append): the minimum is what you pay [V, modeled in `costUnderCommitment`]

| Matched credits / month | Credit packages at $0.05 [A] | Annual $5,000 / 250,000 (overage $0.02) | Effective rate (annual) |
|---|---|---|---|
| 1,000 | $50 (one $250 block lasts 5 months) | **$416.67** (minimum binds) | $0.42 |
| 4,000 / 6,000 / 8,000 (10k consumers at 40 / 60 / 80%) | $200 / $300 / $400 | $416.67 (minimum binds) | $0.104 / $0.069 / $0.052 |
| 20,000 / 30,000 / 40,000 (50k consumers) | $1,000 / $1,500 / $2,000 | $416.67 / $600.00 / $800.00 | $0.021 / $0.020 / $0.020 |

At 10,000 consumers, **packages beat the annual plan** at every match-rate scenario. At 50,000, the **annual plan wins**. This
holds only if the pricing-page plans apply to this deployment at all. The Reseller tier (custom) may be required (§1.2).

### Lower-bound cost per usable person (RentCast + Versium email only)

| Consumers / month | Match rate [A] | RentCast | Versium | Known cost | Usable persons (match × 90% [A]) | **$ / usable person (lower bound)** |
|---|---|---|---|---|---|---|
| 10,000 | 40% | $349 | $200 (packages) | $549 | 3,600 | **$0.153** |
| 10,000 | 60% | $349 | $300 | $649 | 5,400 | **$0.120** |
| 10,000 | 80% | $349 | $400 | $749 | 7,200 | **$0.104** |
| 50,000 | 40% | $824 | $416.67 (annual) | $1,240.67 | 18,000 | **$0.069** |
| 50,000 | 60% | $824 | $600.00 | $1,424.00 | 27,000 | **$0.053** |
| 50,000 | 80% | $824 | $800.00 | $1,624.00 | 36,000 | **$0.045** |

**What these figures are not.** They are not the fully loaded cost, because AI / tool costs and validation are unknown. They are
not a contract, since the Versium Reseller tier may apply. A Contact's phone (1 more credit per match) and Versium
demographics (up to 2 credits per record on a contact hit) are left out. Cost per promoted Lead, per AI-ISA-qualified Contact
and per closed opportunity come from the console's cohort figures once real rows exist. On 2026-11-25 the live ledger held
**zero** RentCast / Versium / Datafiniti / BatchData / PeopleData rows (read-only count), so every live cohort figure is
currently n/a.

### Datafiniti: only if a verified gap remains

- *People* [V 2026-11-25, people-data page]: 6.9 M emails, 4.8 M phones, 88.4 M addresses nationwide. That is a thin
  consumer contact source next to Versium. The indicative 10k-record plan is $749 / month, about $0.075 per record [repo read
  2026-11-16; **not on the page today**]. Not proposed.
- *Property* [V]: about 122 M single-family, 5.5 M multi-family, 27.2 M condo / townhome and 6.2 M commercial records. It has
  status history, transaction and price fields, and (since the November 2026 release) `businessesAtAddress`,
  `mostRecentOwnerTransactionDate` and `noi`. It overlaps RentCast's record, AVM and sale history. Its **incremental** value
  is permit data and the business-to-property join. Use it only as a field-gap fill, after a free `df_count` and
  `df_get_schema` and a rights confirmation. The door already enforces exactly that.
- *Business*: a possible join for the property-to-business crosswalk. It overlaps Versium's B2B2C. Not proposed until a gap is
  measured.
- *Product*: no verified customer-value use. **Not needed.**

---

## 5. Fields × coverage × freshness × rights

| Field family | Primary (state) | Coverage (vendor statement) | Freshness | Rights for THIS deployment | Supplement only if a verified gap remains |
|---|---|---|---|---|---|
| Property structure, tax, HOA, owner | RentCast (active) | "150+ million property records", "500K property records updated every day" [V rentcast.io/api] | cached 30 d [R] | "flexible licensing terms … any use case that is not specifically prohibited under our Terms of Use"; the Terms of Use themselves are **not read** | Datafiniti Property (dormant pending rights) |
| AVM / sold comps / sale history | RentCast (owner-ordered primary) | nationwide; sold records lag in non-disclosure states [directive; not quantified] | AVM cached 14 d [R] | as above | BatchData (dormant survivor, backup) |
| Sale / rental listings, listing photos | tenant IDX first, then RentCast | "all 50 states" [V] | listings never cached [R] | **Listing-photo display rights are not stated** on the pages read. Treat as OWNER-HELD | none |
| Owner / person email, phone | Versium (active) | unpublished | Versium unpublished; 180 d window [R] | signed SaaS / reseller terms **unverified**; the Reseller tier requires a registered data broker [V] | PeopleData (dormant survivor), BatchData (dormant survivor) |
| Demographics, online presence | Versium | unpublished | 180 d [R] | protected / proxy fields are stored for research only, never used for targeting [R] | none |
| Free audience count | Versium Estimates API ($0) [R] | — | per call | — | Datafiniti `df_count` ($0) once licensed |
| Permits, business at address | none today | Datafiniti property schema [V] | "daily and weekly" [V] | **not read** | Datafiniti (dormant pending rights) |

---

## 6. Perplexity: what each product actually is

| Product | What it is (fetched 2026-11-25) | Cost | Could it do something Exa + AI Gateway cannot? | Data handling |
|---|---|---|---|---|
| **Computer** (perplexity.ai/products/computer) | A "general-purpose digital worker that operates the same interfaces you do": it browses, runs background tasks, connects Gmail, Slack, Notion and Calendar. "Available to Pro and Max subscribers on desktop, mobile, Slack, and Microsoft 365" | consumer / pro subscription; no per-call API pricing published on that page | **No, not for this pipeline.** It is an operator's tool, not a server-side component. It cannot be called from the kernel under tenant scope and would sit outside the ledger and the policy gates | **Never place tenant secrets or personal data in it.** Supervised desk research by the owner only, and only if the owner opens an account |
| **Search API** (`POST /search`) | Ranked web results with extracted page text; no model, no answer | $5 / 1,000 successful requests; $1 / 1,000 Fast Search; failed requests not billed [V docs.perplexity.ai/docs/getting-started/pricing] | Possibly cheaper than Exa's $7 / 1,000 [R] for plain retrieval. **Unproven:** it needs a matched benchmark on the same public-request queries (precision of first-person posts, dated pages) | Server-side; the AI Gateway rules would apply. No tenant data is sent in a query |
| **Agent API** (`POST /v1/agent`, which replaces Sonar Chat Completions) | Multi-model agent with a `web_search` tool | tokens + $0.0025 / web_search call ($0.001 Fast) [V] | The repo's public-records rung already uses a Sonar-class model through the AI Gateway. Sonar is now "Legacy, superseded by the Agent API". The integrator should confirm the gateway model route still answers | — |

**Recommendation:** no integration. If the owner wants one, run an Exa vs Perplexity Search API benchmark on a fixed public
query set. That benchmark is **paid** and is **not authorized** here.

---

## 7. Pilot design (budget UNAPPROVED)

This extends the existing matched-cohort design (`lib/providers/provider-pilot.ts` `MATCHED_COHORT_DESIGN`). It is not a new
pilot.

- **Matched sample:** 7 cohorts × 150 records (hard identity, absentee owner, owner-occupied, seller candidate, buyer candidate,
  sparse rural, dense urban). Each record is sent with the **same** raw identity to every arm. Arms: Versium (incumbent),
  RentCast (property incumbent), Datafiniti People / Property (only if licensed), and the R9 Tracerfy vs DataZapp arm.
- **Normalized address:** the same normalization as `normalizeStreetLine` / `splitOneLineAddress` in the rail.
- **Measured per arm and cohort:** field coverage by state and county; age of each fact (`dateUpdated` / RentCast
  `lastSeenDate`); **wrong-match rate** (blinded 20% verification against consented contact points the platform already holds,
  with provider names removed); **append rate**; **unique incremental fields** over the incumbents; Raw Lead → Lead advancement;
  whether permission for AI processing exists; **re-query / refresh cost** at 30 / 90 / 180 days; and outcomes (reply,
  appointment, contract) through `loadLedgerAttribution`.
- **Cost-per-usable-person output:** `foldCohortFinance`, with the pilot's measured usable persons as the denominator.
- **Budget:** about 1,050 records × the arms' worst case. Versium email + phone is 2 credits (about $0.10, so about $105).
  RentCast is 1,050 requests (about $78 on Foundation). Datafiniti, if licensed, is about $79 at the indicative people rate.
  **Indicative only and UNAPPROVED.** Nothing runs without the owner's written approval and the rights confirmations in §8.

---

## 8. Unknown quotes, keys and owner decisions

| Item | Why it matters | Who |
|---|---|---|
| RentCast plan (Foundation / Growth / Scale) and `provider_request_caps.rentcast.monthly_requests` (m1019) | Sets the hard cutoff. Until it is set, the cutoff is 1,000 / month with zero overage | owner |
| `RENTCAST_USD_PER_REQUEST` once a plan is chosen | The ledger books $0.074 / request. Under Growth at 10k the invoice is about $0.035, under Scale at 50k about $0.0165, so booked spend would overstate the bill about 2–4.5× | owner, then a reviewed constant change |
| RentCast Terms of Use (SaaS, storage on tenant records, listing-photo display) | Rights for the active primary are only stated on the API page | owner / counsel |
| Versium signed agreement: SaaS / reseller / data-broker status, caching, outreach | The pricing page routes "build into your own products" to a custom Reseller tier | owner + Versium sales (quote: **unknown**) |
| Datafiniti license for a multi-tenant SaaS (storage, AI processing, outreach, retention) and current plan prices | It is dormant until then; prices are not published on the page today | owner |
| `DATAFINITI_API_TOKEN`, `VERSIUM_API_KEY`, `RENTCAST_API_KEY`, `PERPLEXITY_*` | No live call was made. Every proof is offline | owner (keys); the integrator never sees values |
| Perplexity account / benchmark | Not authorized | owner |

---

### Round 2 (same day): changes to what is enforced

- **The platform failover to dormant providers is closed.** Before this, the enrichment drain
  (`processEnrichmentQueue`) and the raw-record promotion called platform BatchData and PeopleData while both were
  `dormant_survivor`, which meant paid calls the owner had not confirmed. The drain driven at base made `peopledata`
  and `batchdata + peopledata` calls. Both paths now walk only licensed platform providers (`licensedContactRoute` /
  `isPlatformProviderLicensed`). A tenant's OWN BatchData connection (its own account, key and bill) is unaffected.
- **The RentCast health probe counts.** It reserves against the same ceiling and is booked on success only, as a
  platform-paid `health_probe` row. At the ceiling it is skipped, and connector health falls back to credential posture.
- **Billing anchor day.** `billing_anchor_day` (1–31) aligns the counted window with RentCast's own billing period. A
  short month starts on its last day. The default is still the calendar month in UTC.
- **The editor is on the platform console** (connector-healing, superadmin): it is validated, audited and receipted.
  Until m1019 is applied it says the setting is not available yet.

## 9. Sources (fetched 2026-11-25 unless noted)

- RentCast billing: <https://developers.rentcast.io/reference/billing-and-pricing>. Read: per successful (200) request; no hard
  cap; 50 free Developer requests; overage per plan; 85% / 100% usage emails.
- RentCast API product page: <https://www.rentcast.io/api>. Read: 150 M+ records; 500K updates a day; MCP server; "flexible
  licensing terms". The plan table rendered partially.
- Versium pricing: <https://versium.com/pricing/>. Read: packages $250 / 5K; annual $5,000 / 250K; $0.02 → $0.005; Reseller
  tier "Must be a registered data broker"; business verification required.
- Datafiniti API introduction: <https://docs.datafiniti.co/docs/api-introduction>. Read: four datasets (Property, People,
  Product, Business).
- Datafiniti MCP server: <https://docs.datafiniti.co/mcp-server>. Read: same token, permissions and credits as REST;
  count / schema / download_status free.
- Datafiniti October 2026 release log: <https://docs.datafiniti.co/october-2026>. Read: MCP launch; `df_get_record` 1 credit;
  `df_start_download` per record found.
- Datafiniti November 2026 release log: <https://docs.datafiniti.co/november-2026>. **REACHABLE on 2026-11-25** (the directive
  could not retrieve it). It says the MCP server lets AI tools search, count, retrieve, download and read schemas, with 45
  prebuilt prompts; there are AI setup guides (Claude / ChatGPT plugins "pending review"); downloads over 50,000 records are up
  to 6× faster. **Property schema adds** `businessesAtAddress`, `corporateTenants`, `investmentSubtype`, `noi`, `numBuildings`,
  `mostRecentEstimatedPriceCurrency`, `postalCodePlusFour`, `rawAddress`, `numKeys`, `mostRecentSaleListPriceCurrency`,
  `mostRecentOwnerTransactionDate`, `mostRecentRentalListPriceCurrency`, `mostRecentRentalPriceCurrency`,
  `mostRecentPricePerSquareFoot`, `mostRecentPriceSourceURL`, `mostRecentSoldPriceCurrency`. **People schema adds**
  `currentListingCount`, `maxListingPrice`, `minListingPrice`, `recentlySoldCount`, `salesHistoryDateSeen`, `middleName`. The
  `statuses` → `statusHistory` migration is complete. No bug fixes. Coming soon: normalized product categories and official
  Claude / ChatGPT connectors. The repo's typed People record does not yet declare the six new people fields. They pass through
  its index signature untyped.
- Datafiniti credits: <https://docs.datafiniti.co/docs/how-credits-work-api>. Read: free `GET /v4/account`; per-type credits;
  `plan_ids`; overage flags.
- Datafiniti people / property pages: <https://www.datafiniti.co/data/people-data>,
  <https://www.datafiniti.co/data/property-data>. Read: coverage counts; no prices shown. <https://www.datafiniti.co/pricing>
  could not be fetched (not found). Prices are **not verified** today.
- Perplexity Computer: <https://www.perplexity.ai/products/computer>.
- Perplexity API pricing: <https://docs.perplexity.ai/docs/getting-started/pricing>.
- Perplexity Sonar (legacy): <https://docs.perplexity.ai/docs/legacy/sonar/models/sonar>.
- Not re-read this wave (repository reads cited instead): BatchData pricing, PeopleData Labs pricing, the Versium credit-weight
  table (read 2026-10-23), and the RentCast Terms of Use (never read).
