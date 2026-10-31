# DealMachine — acquisition-provider evaluation

Wave 147, lane 147D. Owner ruling 17 (2026-10-31): "DealMachine (api.docs.dealmachine.com) may be the better acquisition tool —
evaluate, do not assume. Adapter only on a confirmed gap, permitted licensing and a compelling benefit, through the existing
provider fabric." This report is **INTERNAL**. It names a vendor, its terms and its prices.

**Method.** Every DealMachine fact below was read from DealMachine's own pages on **2026-10-31**. The whole API documentation set
was read from its published corpus (<https://api.docs.dealmachine.com/llms-full.txt>, 904,674 bytes, 127 operations). Each page is
also cited at its own URL. No account was opened and no key was created. No API endpoint was called, including the free count and
cost-estimate endpoints. Those endpoints were read as documentation only, so no credit was spent. Existing survivors are cited at
`file:line` in this worktree (base `4d527cc3`). The earlier pass on the same vendor is
`docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md` §3.4 (wave 146D, read 2026-10-29). Where today's read differs from it, §8 says so.

## 1. Verdict

**No adapter is built.** The owner's gate needs three conditions at once: a confirmed gap, permitted licensing and a compelling
benefit. Licensing fails on DealMachine's standard terms, so no code is written, migration number m897 is not used, and no
`test:acquisition-provider-posture` proof is created.

1. **Licensing blocks multi-tenant use.** The Terms of Service grant a "non-transferrable, non-sublicensable" right "limited to the
   Customer's internal, lawful use only" (§2(b)). They forbid making "the Services available to any other party" (§2(e)(ii)) and
   allow one account per customer (§2(a)). Our acquisition model is platform-paid and pooled across tenant territories
   (`lib/lead-pipeline/acquisition-coverage.ts:24-37`), which is the use these clauses rule out. Section 4 has the quotes.
2. **DealMachine is genuinely cheaper per record.** A people credit carries phones, emails, phone type, carrier and a DNC flag.
   At full use of a plan it costs **$0.0060 – $0.0099**. Our ledger books **$0.07 per BatchData skip-trace match** (that figure is
   itself UNVERIFIED, `PROVIDER-COST-REPORT.md` §8) and **$0.05 per Versium match** (a ceiling). That is a measurable cost benefit,
   but only after a fixed per-seat fee, monthly credits that do not roll over and an unknown fill rate (§5). The benefit is real and
   blocked by licence.
3. **DealMachine sells a few modeled consumer flags that no current provider sells.** These are a lease-ending window
   (`lease_ending`), a new-mover flag and month, potential first-time buyer, likely mortgage applicant, and "likely to move". The
   repo documents the lease gap itself: `lib/lead-pipeline/rental-graduation-sourcer.ts:16-31` uses tenure because "There is no
   `lease_end_date` column anywhere live". All of these flags are **modeled** (inferred), and DealMachine discloses neither their
   source nor their accuracy. This is a gap, pending a licence and a provenance answer.
4. **Everything else is already covered.** Distress and seller signals, property records, comps, DNC/TCPA, address validation,
   direct mail and push monitoring each have a survivor in this repo (§3). DealMachine's webhooks fire on the workspace's own CRM
   actions (prospects, lists), not on property-data changes, so they close no push-signal gap.
5. **The people search exposes protected characteristics as filters.** These include gender, marital status ("Divorced",
   "Widow"), household composition ("Single Mom"), language and age. DealMachine describes People Search as the tool "for
   filter-defined audiences", which makes a DealMachine search an audience selection. If a licence is ever signed, the adapter
   must refuse those filters **at the request**, not only at the reader (§6).

**What would reopen this:** a signed DealMachine Order Form or enterprise licence that expressly overrides §2(a), §2(b), §2(e)(ii)
and §5(b) for multi-tenant service-bureau use (§7). Until then, this belongs to the owner and counsel as **WAITING_EXTERNAL**.

## 2. Sources read (all on 2026-10-31)

| Source | URL | Notes |
|---|---|---|
| API documentation corpus | <https://api.docs.dealmachine.com/llms-full.txt> (index <https://api.docs.dealmachine.com/llms.txt>) | Every page as markdown. Pages cited below by their own URL |
| Introduction, authentication, rate limits | <https://api.docs.dealmachine.com/introduction>, <https://api.docs.dealmachine.com/authentication>, <https://api.docs.dealmachine.com/rate-limits> | Base `https://api.v2.dealmachine.com/v1`, Bearer key, 60 / min, 5,000 / day |
| Credits, credit-efficient queries | <https://api.docs.dealmachine.com/concepts/credits>, <https://api.docs.dealmachine.com/concepts/credit-efficient-queries> | Billing model, count and estimate rules |
| Lists, exporting, activity | <https://api.docs.dealmachine.com/concepts/lists>, <https://api.docs.dealmachine.com/concepts/exporting>, <https://api.docs.dealmachine.com/concepts/activity> | Organization-wide scope of dedupe, exclusions and logs |
| Webhooks, events | <https://api.docs.dealmachine.com/webhooks/introduction>, <https://api.docs.dealmachine.com/webhooks/events> | Prospect and list events only |
| Property and people filters | <https://api.docs.dealmachine.com/reference/property-filters>, <https://api.docs.dealmachine.com/reference/people-filters> | Signal catalogue, protected attributes |
| Response format | <https://api.docs.dealmachine.com/concepts/response-format> | Phones, DNC flag, known-litigator scrub |
| Prospects, driving, mail | <https://api.docs.dealmachine.com/api-reference/prospects/introduction>, <https://api.docs.dealmachine.com/driving/introduction>, <https://api.docs.dealmachine.com/mail/introduction>, <https://api.docs.dealmachine.com/mail/wallet/get-pricing> | CRM, drive history, postcards |
| Plans, MCP server | <https://api.docs.dealmachine.com/api-reference/account/get-plans>, <https://api.docs.dealmachine.com/ai-assistants/mcp-server> | Self-serve cap, agent tools |
| **Terms of Service** (effective **2026-07-14**) | <https://www.dealmachine.com/terms-of-service> | The licence (§4) |
| **Privacy Policy** (effective **2026-08-26**) | <https://www.dealmachine.com/privacy-policy> | Freshness, data-broker status, consent |
| Pricing | <https://www.dealmachine.com/pricing> | Plans, mail per piece |
| API quickstart guide, data-credits guide | <https://www.dealmachine.com/guides/api-quickstart>, <https://www.dealmachine.com/guides/data-credits> | Data use and retention, DNC refresh, overage |

## 3. Capability by capability

Verdict labels follow the lane brief:

- **COVERED** means an existing survivor covers it.
- **ADDS** means DealMachine adds a missing capability.
- **IMPROVES** means DealMachine improves measurable cost or quality.
- **UNKNOWN-LICENCE** means the answer is unknown pending a licence.

A row can carry two labels. For example, "ADDS · UNKNOWN-LICENCE" means a real gap that the licence blocks.

| # | Capability | What DealMachine documents | Existing survivor | Verdict |
|---|---|---|---|---|
| 1 | Property intelligence and owner records | 150M+ properties. Owner names, owner mailing address, four mortgage slots, tax, assessor, liens, HOA, MLS status, sale history, building, flood, estimated value, equity and repair cost ([property-filters](https://api.docs.dealmachine.com/reference/property-filters), [pricing](https://www.dealmachine.com/pricing)) | RentCast record and AVM, BatchData backup: `lib/avm/provider-chain.ts:301` `requestPropertyValuation`. Facts route: `lib/ai-isa/property-lookup-rail.ts:369` `property_facts` | **COVERED.** Unit cost is comparable to BatchData's subscription tier (§5) |
| 2 | Search and enrichment | Enrich by address, geocode, APN, email, phone and name. Property and people search with 50 filters and 15 locations per request. Batches of up to 250 items ([credits](https://api.docs.dealmachine.com/concepts/credits), [rate-limits](https://api.docs.dealmachine.com/rate-limits)) | `CONTACT_PROVIDER_ROUTES` `owner_contact` / `reverse_contact` (Versium → BatchData → PeopleData), `lib/ai-isa/property-lookup-rail.ts:334-350`, routed by `routeCapability` `:473` | **COVERED · IMPROVES on price · UNKNOWN-LICENCE** |
| 3 | Skip-trace contact points | People credit returns `phones[]` (number, type, `do_not_call`, carrier) and `emails[]`, "regardless of how many phone numbers or emails are returned". Known litigators come back with an empty `phones` array ([response-format](https://api.docs.dealmachine.com/concepts/response-format)) | Same routes as row 2. `lib/compliance/phone-scrub.ts:66` `dispositionOf` (DNC / TCPA-litigator dominate) | **IMPROVES on price · UNKNOWN-LICENCE.** The useful-contact fill rate is unmeasured (§5) |
| 4 | DNC / TCPA | `do_not_call` is "our data provider's DNC flag, which is refreshed monthly … not a live registry check … we recommend scrubbing against the registry yourself before dialing" ([api-quickstart](https://www.dealmachine.com/guides/api-quickstart)) | `dnc_tcpa` route (`property-lookup-rail.ts:354`), `lib/communication/tcpa-gate.ts:132` `enforceTCPACompliance` with a freshness check at `:46` | **COVERED.** DealMachine's flag is weaker, a monthly snapshot by its own description |
| 5 | Distress and potential-seller signals | Pre-foreclosure (NOD, lis pendens, notice of sale, auction date), tax delinquent, liens, vacant, zombie, bank owned, absentee, out-of-state, tired landlord, `is_pre_probate`, intrafamily transfer, expired listing, high equity / free and clear, `is_likely_to_move` ([property-filters](https://api.docs.dealmachine.com/reference/property-filters)) | `lib/external/batchdata-seller-signals.ts:358` `BATCHDATA_SELLER_SIGNAL_SOURCES`: sale propensity, foreclosure, tax, lien, vacancy, absentee, tired landlord, withdrawn / expired / sold / price-cut transitions, equity, tenure, FSBO, below market, corporate, trust, fix-and-flip, cash buyer, vacant lot, inherited / probate, senior owner, recent divorce, household outgrown, plus active-listing **suppression** (Article 16) | **COVERED.** The survivor is broader. It carries suppression and dated status *transitions*, and DealMachine documents neither |
| 6 | Buyer-side and mover indicators | People filters `lease_ending` (3 / 6 / 9 / 12 months), `has_likely_to_move`, `is_new_mover_flag` / `new_mover_month`, `has_potential_first_time_home_buyer`, `has_likely_apply_mortgage_loan*`, `has_recent_mortgage_application` ([people-filters](https://api.docs.dealmachine.com/reference/people-filters)) | Versium indicators (own/rent, tenure, mortgage and refinance dates, online real-estate presence): `lib/external/versium-client.ts:953`. Tenure proxy for renters: `lib/lead-pipeline/rental-graduation-sourcer.ts:16-31`. First-party watcher: `lib/enrichment/first-party-intent-watcher.ts` | **ADDS · UNKNOWN-LICENCE.** Every one of these is modeled (epistemic class *inferred* at best). Source and accuracy are not published. The mortgage-application and credit fields are FCRA-adjacent (§6) |
| 7 | Lead-list creation | Lists of up to 1M IDs (retention "Indefinite (until deleted)"). Exports of up to 1M rows as signed CSV.gz. `exclude_previously_exported` "applies across your whole account with no time limit" ([lists](https://api.docs.dealmachine.com/concepts/lists), [exporting](https://api.docs.dealmachine.com/concepts/exporting), [api-quickstart](https://www.dealmachine.com/guides/api-quickstart)) | Territory-scoped pulls: `lib/lead-pipeline/scrape-territories.ts:134` `resolveActiveScrapeTerritories` → the one raw-lead pipeline. Dedupe: `lib/kernel/person-identity.ts:181` `resolvePerson` | **COVERED.** Account-wide exclusions would leak one tenant's purchases into another tenant's results inside a pooled account (§4.3) |
| 8 | Webhook and event changes | Events are `prospect.*` (added, lifecycle_changed, favorited, note / file / photo / tags) and `list.item_added` / `list.item_removed` only. HMAC-signed, retried for about 3 days, 25 per workspace ([webhooks](https://api.docs.dealmachine.com/webhooks/introduction), [events](https://api.docs.dealmachine.com/webhooks/events)) | Property-change **push**: `app/api/webhooks/batchdata-smart-search/route.ts` (fail-closed secret, territory match before ingest). Poll-and-diff: the active-listing monitor (row 5) | **COVERED.** DealMachine pushes *its own users' CRM actions*, never a property or owner data change. See §9 for the lane-B rule |
| 9 | Direct mail | Postcards 4×6 at $0.75 (Basic) / $0.70 (Pro) per piece, prepaid $0.62 → $0.58. Wallet credits expire after one year (ToS §2(j)). Audience is property, contact or list IDs ([pricing](https://www.dealmachine.com/pricing), [mail](https://api.docs.dealmachine.com/mail/introduction)) | `lib/providers/dispatch.ts:991` `dispatchDirectMail` → Lob, gated by opt-out, suppression, `lib/providers/mailing-cass-gate.ts` and budget, ledgered `comms.direct_mail.send` (`lib/providers/channel-provider-matrix.ts:255-275`). Lob 4×6 First Class $0.905 / $0.645 / $0.615 by plan (`PROVIDER-COST-REPORT.md` §3, Lob page published 2026-09-29) | **COVERED.** There is no price improvement, and a second sender outside `dispatch.ts` would bypass consent, suppression, CASS and the ledger |
| 10 | Comps and valuation | `POST /v1/comps`, 1 property credit per subject found ([mcp-server](https://api.docs.dealmachine.com/ai-assistants/mcp-server)) | `property_valuation` (RentCast primary, BatchData backup; owner-ordered), `property-lookup-rail.ts:382` | **COVERED** |
| 11 | Address validation | `POST /v1/addresses/validate` (logged as `validate_addresses`, [activity](https://api.docs.dealmachine.com/concepts/activity)) | `lib/providers/lob/client.ts:96` `verifyUsAddress` and the send-time CASS gate | **COVERED** |
| 12 | Driving for Dollars (field capture) | A read-only API over drives recorded in DealMachine's own mobile app. Prospects are tagged `source=driving` ([driving](https://api.docs.dealmachine.com/driving/introduction)) | No field-drive capture exists in this repo. The neighbourly observation catalogue (dumpster, estate-sale sign) belongs to lane B, ruling 4 | **ADDS · UNKNOWN-LICENCE.** It would also put agents in a second app. If wanted, the right build is our own first-party capture, not this API |
| 13 | Agent production data (recruiting) | People filters `is_real_estate_agent`, `listings_last_12_months`, `listing_volume_12_months`, `avg_listing_price_12_months` ([people-filters](https://api.docs.dealmachine.com/reference/people-filters)) | `lib/recruit-pipeline/recruit-sourcer.ts` uses social and review intent only. No production roster | **ADDS · UNKNOWN-LICENCE.** The canonical source is the tenant's MLS, under that MLS's rules |
| 14 | Freshness and accuracy | "property data is not destroyed or deleted, but is refreshed on a daily basis; owner and contact data is refreshed monthly and matched with property data monthly" ([privacy §8](https://www.dealmachine.com/privacy-policy)). Foreclosure and MLS dates are "only populated from a recent (last 12 months) … record". ToS §7(b): no warranty that data is "accurate, complete, reliable, current" | BatchData cadence: not stated in this repo (UNKNOWN). PeopleData: monthly. Versium: not published (`CUSTOMER-360-PROVIDER-COMPARISON.md` §5) | **IMPROVES on *published* freshness only.** Accuracy and fill rates are unpublished on both sides, so nothing measurable |
| 15 | Cost per useful record | §5 | `CONTACT_PROVIDER_ROUTES` booked constants | **IMPROVES · UNKNOWN-LICENCE** (§5) |
| 16 | Storage, sublicensing and multi-tenant SaaS rights | §4 | — | **UNKNOWN-LICENCE.** Not permitted on standard terms |
| 17 | AI-agent access | A remote MCP server (`https://mcp.dealmachine.com/mcp`) exposes 127 operations to an agent with the account's key ([mcp-server](https://api.docs.dealmachine.com/ai-assistants/mcp-server)) | LAW 3: agents request capabilities through `routeCapability`, never a vendor. Tools go by persona and risk class (`OS-CONSTITUTION.md` LAW 3 / LAW 4) | **Not mountable.** Giving agents a vendor MCP server would bypass the router, budget gate, ledger and tenant scope |

**Count:** 17 capabilities. COVERED 9 (rows 1, 4, 5, 7, 8, 9, 10, 11, plus row 2's capability). Real gaps (ADDS) 3 (rows 6, 12,
13), all licence-blocked. Measurable improvement on price 3 (rows 2, 3, 15), all licence-blocked. One improvement on *published*
freshness (row 14). Licensing not permitted on standard terms: row 16. Not mountable: row 17.

## 4. Licensing, sublicensing and multi-tenant findings

### 4.1 Terms of Service — effective 2026-07-14, read 2026-10-31 (<https://www.dealmachine.com/terms-of-service>)

| Clause | Verbatim | What it means for a multi-tenant platform |
|---|---|---|
| §2(a) one account | "Customer is only permitted to have one account with Provider unless specifically authorized to have multiple accounts by Provider in writing … any attempt to open multiple accounts without the express written consent of Provider constitutes a material breach" | We cannot open one DealMachine account per tenant under the platform without written authorization |
| §2(b) the grant | "a limited, non-exclusive, non-transferrable, non-sublicensable, revocable right to access and use the Services during the Term of this Agreement solely for the use by Permitted Users. Such right to use the Services is limited to the Customer's internal, lawful use only." | A platform account cannot serve tenant brokerages, because their use is not the platform's "internal" use |
| §2(b) volume | "Customer shall be permitted to view or export property ownership information and county records on up to the amount of parcels of real property per day as described in the relevant Order Form." | Volume is set by the Order Form, not by the API alone |
| §2(d) seats | Logins "shall not be shared or used by more than one Permitted User" | Per-seat pricing assumes named humans, not a platform service account fanning out to tenants |
| §2(e)(i)–(ii) restrictions | Customer shall not "(i) copy, modify, distribute, or create derivative works based upon the Services … (ii) rent, lease, lend, sell, license, sublicense, assign, publish, transfer, or otherwise make available the Services to any other party" | Writing DealMachine-sourced records into tenant CRMs, where tenant staff read and act on them, is "making available" to other parties |
| §2(e)(vii) competition | Customer shall not "use or access the Services to (y) build or support; and/or (z) assist any third party in building or supporting, any services or technology competitive to the Services" | Our lead lists, skip trace, direct mail and prospect pipeline overlap DealMachine's product, so this risk exists even under a bring-your-own-account model |
| §2(e) geography | "Customer will not use the Services to communicate with Persons outside the United States of America" | Excludes any non-US tenant market |
| §2(g) compliance | Customer is solely responsible for the TSR, TCPA, DNC and state telemarketing law. "Provider cannot guarantee that Customer has the legal right to contact individuals using contact information provided via the Services and it is Customer's sole obligation to ensure that it has proper consent or other legal exemption." | Our gates (`tcpa-gate.ts`, `dispatch.ts`) stay the authority whatever the source |
| §5(b) **data we send** | Customer grants Provider "a non-exclusive, royalty-free, worldwide, perpetual, irrevocable, transferrable, sublicensable license to exercise the copyright, publicity, and database rights Customer has in Customer Data", except it may not "sell, publicly distribute, publicly display, or publish Customer Data" | Enriching a tenant's own contacts by email, phone or name would grant DealMachine a **perpetual, sublicensable licence over that tenant's consumer data**. That conflicts with what our tenants promise their own consumers |
| §10(d) termination | Provider shall "have no obligation to save Customer Data" | **No clause found** obliging the customer to destroy DealMachine-sourced data on termination, unlike Versium §7.3. Retention is still bounded by §2(b) / §2(e) and the quickstart line in §4.2 |
| §11(j) precedence | The Agreement prevails over an Order Form "unless expressly stated otherwise in the applicable Order Form" | Any licence that fixes this must say so **expressly**, in a signed Order Form |
| §11(m) changes | Changes are "binding on Customer immediately upon posting" | This posture must be re-read before any build |

### 4.2 DealMachine's own guidance pages

- API quickstart, "Data use and retention", verbatim: "Use and retain data according to the current terms of service and your
  agreement. Contact the team before using data beyond those terms." (<https://www.dealmachine.com/guides/api-quickstart>)
- The same page: "For a plan tailored to very high volume, enterprise or licensing needs, reach out and we'll connect you with
  our team." Licensing beyond the standard terms exists only by negotiation.
- List Plans: "Sales-managed Scale plans and private offer plans are not returned", and "Self-serve API checkout is capped at
  60,000 monthly data credits." (<https://api.docs.dealmachine.com/api-reference/account/get-plans>)
- Privacy Policy §3, the stated use of property-owner data: "Display owner name and contact information to the User who
  conducted the search". §2: owners "have not been asked for consent to this collection". §10: DealMachine "is registered as a
  data broker in the following states: California and Texas." (<https://www.dealmachine.com/privacy-policy>)

### 4.3 Technical facts that defeat tenant isolation inside one account

These are documentation facts, independent of the legal reading:

- "API keys are scoped to your organization" ([introduction](https://api.docs.dealmachine.com/introduction)).
- "Activity is scoped to your organization — all API keys and OAuth tokens under the same organization share the same activity
  log", retained 12 months ([activity](https://api.docs.dealmachine.com/concepts/activity)).
- Credits are "deduplicated within your billing period", organization-wide ([credits](https://api.docs.dealmachine.com/concepts/credits)).
- `exclude_previously_exported` "applies across your whole account with no time limit"
  ([api-quickstart](https://www.dealmachine.com/guides/api-quickstart)).
- "Only one export can run at a time per organization", and lists have "Concurrent builds per org: 1"
  ([exporting](https://api.docs.dealmachine.com/concepts/exporting), [lists](https://api.docs.dealmachine.com/concepts/lists)).

In a pooled platform account, tenant A's purchase would silently suppress the same record from tenant B's next pull. That leaks
information between tenants. Every tenant's search parameters would also land in one shared log, and one tenant's export would
block every other tenant's. CLAUDE.md §4 puts tenancy in the session; this vendor puts it in the account.

### 4.4 Conclusion on rights

| Model | Permitted on standard terms? |
|---|---|
| Platform-held account serving all tenants (our acquisition model) | **No.** §2(b) internal use, §2(e)(ii), plus the isolation facts in §4.3 |
| One platform-opened account per tenant | **No** without written authorization (§2(a)) |
| Each brokerage holds its own account and key, used through our platform | **Unknown.** The brokerage is the Customer, and contractors may be Permitted Users. But §2(e)(vii) (competitive services), §5(b) (licence over the tenant contact data we would send) and the seat model all need DealMachine's written answer. It also breaks the platform-paid acquisition model |
| Negotiated enterprise / platform licence | **Possible.** Only by a signed Order Form that expressly overrides §2(a), §2(b), §2(e)(ii) / (vii) and §5(b) (§11(j)) |

## 5. Cost per useful record — computed from published prices, no credit spent

**Billing rules** ([credits](https://api.docs.dealmachine.com/concepts/credits),
[credit-efficient queries](https://api.docs.dealmachine.com/concepts/credit-efficient-queries)):

- One property credit per unique property, and one people credit per unique person returned, "regardless of how many phone
  numbers or emails are returned".
- Deduplication applies within the billing month.
- A people-anchored search that returns only address and context fields costs people credits only.
- Counts and cost estimates are free. Estimates are "conservative" and exclude deduplication.
- "Do not expect automatic per-credit overages. A chargeable request can stop at your remaining balance."
  (<https://www.dealmachine.com/guides/data-credits>)
- Monthly credits "reset at the start of each billing period".

| Plan (read 2026-10-31 unless noted) | Fee | Credits / month | $ per credit at 100 % use |
|---|---|---|---|
| Basic | $99 / seat / mo ("Plans start at $99/mo") | 10,000 | **$0.0099** |
| Pro | $149 / seat / mo (the amount renders client-side today; figure from wave 146D, read 2026-10-29) | 20,000 | **$0.00745** |
| Scale | $599 / package / mo, 10 seats | 100,000 | **$0.00599** |

**What a record costs:**

- An owner's contact points from a people-anchored search cost 1 people credit.
- A property with two owners and contacts costs 3 credits, which is **$0.018 – $0.030** at full use.
- A property record alone costs 1 property credit. That is comparable to BatchData's subscription tier ("≈ $0.01 → $0.003 /
  record", `PROVIDER-COST-REPORT.md` §3), so property-only data gains nothing.

**Break-even against the constants our ledger books**, as the fee divided by the booked unit:

| Plan | vs BatchData skip trace $0.07 / match (`lib/external/batchdata-client.ts:1440`, UNVERIFIED) | vs Versium $0.05 / match ceiling (`lib/external/versium-client.ts:116`) | vs Versium $0.02 package floor |
|---|---|---|---|
| Basic $99 | 1,415 people records / mo | 1,980 | 4,950 |
| Pro $149 | 2,129 | 2,980 | 7,450 |
| Scale $599 | 8,558 | 11,980 | 29,950 |

**Why "useful" stays UNKNOWN:**

- DealMachine bills per person **returned**. BatchData and Versium bill per **match**.
- Cost per *useful* contact is the cost per credit divided by the share of returned people who have a callable or emailable point.
  That fill rate is unpublished and was not measured (no key).
- The rate at which contacts change is also unmeasured. Our tables held 0 rows on 2026-10-29 (`CUSTOMER-360-PROVIDER-COMPARISON.md` §6).
- The per-seat fee is a fixed commitment, so below break-even DealMachine costs more than the providers we use today.

**Direct mail.** DealMachine 4×6 costs $0.75 / $0.70 per piece and needs a seat subscription. Lob 4×6 First Class costs
$0.905 / $0.645 / $0.615 by plan. There is no improvement.

## 6. Fair-housing and compliance findings

1. **Protected or proxy attributes are exposed as audience filters.** DealMachine lists `gender`, `marital_status` (options
   include "Divorced" and "Widow"), `household_composition` ("Single Mom", "Couple w/ Kids" …), `household_role` ("Elderly
   Parent"), `language` (a national-origin proxy), `person_age` / `person_birth_month`, `consumer_segment` (age and family
   bands), `has_veteran_in_household` / `is_us_military_likely`, `political_party`, and on the property side `has_senior_owners`
   and `is_empty_nester` ([people-filters](https://api.docs.dealmachine.com/reference/people-filters),
   [property-filters](https://api.docs.dealmachine.com/reference/property-filters)). Ruling 2 lets such attributes be **stored**
   for purpose-gated research, with provenance. It never lets them **select** who is approached. A DealMachine people search is a
   selection, which DealMachine itself describes as "for filter-defined audiences". A licensed adapter would therefore refuse
   these filter IDs before the request leaves us, using the same vocabulary that
   `lib/lead-governance/protected-class-signals.ts:596` `screenProtectedClassCriteria(criteria, "ad_audience")` already applies.
2. **Divorce from DealMachine is a modeled demographic, not a filing.** `marital_status = Divorced` is a vendor-modeled field
   with no date or court source. Under contract C9 it would be *inferred* at most and could never read as a verified life event.
   The survivor `RECENT_DIVORCE_SIGNAL_TYPE` (`batchdata-seller-signals.ts:556`) is already a declared provider field with a
   protected-class basis.
3. **Credit-behaviour fields are FCRA-adjacent.** `credit_behavior`, `buying_power` (options include "High Risk"),
   `has_balance_credit_ratio_highest`, `has_recent_mortgage_application`. DealMachine's pages do not state the FCRA status of these
   fields. They must never decide who is offered a housing service (eligibility or steering).
4. **The DNC flag is a monthly snapshot.** DealMachine's own words: "not a live registry check". It cannot replace
   `enforceTCPACompliance`. Its known-litigator scrub (phones emptied) is a sensible default, but our litigator disposition stays
   the authority.
5. **Owners have not consented.** The Privacy Policy says so (§4.2), and ToS §2(g) puts all contact legality on the customer. A
   DealMachine-sourced person is a purchased record, so the raw-lead / lead identity gates apply (ruling 1). Such a person is
   never a consented Contact.

## 7. What would change the verdict, and the design if it does

**Reopen conditions.** All three must hold:

1. A signed Order Form or enterprise licence from DealMachine Operations Inc. that **expressly** grants multi-tenant
   (service-bureau) use, storage on tenant contact and lead records, display to each tenant's authorised users, and a defined
   retention or purge rule. It must also waive or carve out the §5(b) licence for tenant data we submit.
2. A measured comparison at our real volume: BatchData's actual per-match rate (§8 UNKNOWN in `PROVIDER-COST-REPORT.md`) against
   DealMachine's effective rate including fill rate.
3. Evidence from lane B's `outcomes` that the modeled lease-ending or new-mover flags move decisions.

**Design if reopened (not built).** No new rail:

- Append `dealmachine` rows to `CONTACT_PROVIDER_ROUTES` (`owner_contact` and `motivated_seller_list` at its booked per-credit
  cost, cheapest-first held by `test:provider-cost-routing`). The modeled renter window would be a new capability row, for
  example `renter_lease_window`.
- Pre-flight every pull with the free `estimate_cost: true` and `mayUseAndAfford` (`lib/billing/billing-access.ts:313`).
- Scope territory with `resolveActiveScrapeTerritories`.
- Dedupe through `resolvePerson` and the provider's own activity entity check.
- Record evidence with `withActionLedger` (`lib/kernel/action-ledger.ts:538`) under a `domain.entity.action` name such as
  `provider.dealmachine.enrich`.
- Book spend with `meterVendorSpend`.
- Refuse protected filters at the request (§6.1).
- Never mount the DealMachine MCP server for agents.
- Credentials would be `DEALMACHINE_API_KEY`, plus `DEALMACHINE_WEBHOOK_SECRET` only if the prospect webhook were used. Neither
  is requested now.
- Only then: `test:acquisition-provider-posture`.

## 8. Facts that moved since wave 146D (read 2026-10-29)

| Fact | 146D said | Read 2026-10-31 |
|---|---|---|
| Overage | "Overage is billed 'at your plan's per-credit rate'" | "Do not expect automatic per-credit overages. A chargeable request can stop at your remaining balance." (data-credits guide) |
| Freshness | not recorded | Property data refreshed daily. Owner and contact data monthly. DNC flag monthly (privacy §8, quickstart) |
| Webhooks | "API, CLI and webhooks are on every plan" | Still true, but the events are prospect and list CRM events only, not data changes |
| Account and data clauses | §2(b) and §2(e) quoted | Also §2(a) (one account), §5(b) (perpetual sublicensable licence over Customer Data) and §11(j) (an Order Form must expressly override) |
| Sandbox | not recorded | "All API keys are live. There is no test/sandbox environment." ([authentication](https://api.docs.dealmachine.com/authentication)) |

The verdict does not move: **not recommended on standard terms**. 146D gave three reasons: an internal-use licence, overlap with
BatchData, and no behavioural intent. Today's read narrows the third: DealMachine sells *modeled* mover and renter flags, but none
of the first-party behavioural intent that ruling 4 asks for.

## 9. Handed to lane 147B (source registry): "a DealMachine prospect lifecycle event is not proof a consumer is ready to move"

The events behind this rule are `prospect.added`, `prospect.lifecycle_changed` (`active` / `opportunity` / `archived`),
`prospect.favorited`, `prospect.tags_changed`, `prospect.note_added` and `list.item_added`. Each records that **a DealMachine
workspace user, API key or background job** acted on a record they chose to work: the event `actor` is `user`, `api_key` or
`system` ([events](https://api.docs.dealmachine.com/webhooks/events)). The consumer did nothing.

If such an event were ever registered, it would be:

- a provider observation of *our own team's* activity;
- epistemic class `unknown` about the consumer;
- no `event_relevance`;
- `next_appropriate_action` at most `research`;
- licence: "not licensed for platform use (this document §4)".

The modeled flags (`is_likely_to_move`, `has_likely_to_move`, `lease_ending`, `is_new_mover_flag`) are *inferred* at most and never
*verified*. The exact registry change is in `lane147D-notes.md` under "Outside-lane".

## 10. Blind spots

- **No key, account or call.** Match rates, field fill rates and accuracy are unmeasured, and DealMachine publishes no accuracy
  figure.
- **Pro pricing and examples.** The Basic and Pro per-seat amounts render client-side. Today's raw page text shows "Plans start at
  $99/mo" and the Scale price. The $149 Pro figure is carried from 146D (2026-10-29). The documentation's response examples (plan
  catalogue, mail pricing) are labelled illustrative by DealMachine and are not used as prices here.
- **Sales-managed terms.** Scale and enterprise terms are not in the self-serve catalogue, so a negotiated price or licence may
  differ materially.
- **Undisclosed sources.** The origin of the modeled flags (likely to move, lease ending, credit behaviour) is not disclosed, so
  their FCRA status is UNKNOWN.
- **This is not legal advice.** Section 4 is a procurement reading. Counsel must read the ToS and any Order Form before
  signature, and ToS §11(m) lets DealMachine change the terms on posting.
- **BatchData's $0.07 is UNVERIFIED.** It is a booked constant (`PROVIDER-COST-REPORT.md` §8). If BatchData's real rate is lower,
  the price advantage in §5 shrinks.
