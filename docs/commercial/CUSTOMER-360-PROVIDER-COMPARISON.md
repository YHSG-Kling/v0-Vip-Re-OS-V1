# Customer 360 — provider comparison and the lowest-cost combination

Wave 146, lane 146D. Owner rulings 11, 12 and 13 (2026-10-29). This report is **INTERNAL**. It names providers, their terms and their prices.

> Ruling 12, verbatim: "If there is a provider that does this better (keeping our data up to date with behavioral real estate
> intent, life changes and doesn't prohibit from writing and reading all data to the customers contact or lead profiles including
> fair housing prohibited rules and still keeps our costs low) we need this built. like celebrus, full contact, dealmachine."

**Method.** Every fact below has a source URL and the date it was read. All pages were read on **2026-10-29** unless another date
is given. Research used web search and Exa, read-only. Nothing was bought, no account was opened and no key was requested. When a
vendor does not publish a price, this report says **"not published"**. A reported third-party price is labelled **reported**, and
the recommendation never rests on one. When a primary page could not be read by machine, the report says so and names the
secondary source it used.

## 1. Verdict

1. **The current stack meets the capability requirements at the lowest verified cost.** That stack is PeopleData + Versium, with
   BatchData and RentCast for the property side. No evaluated vendor adds a material capability at a lower verified price. The
   research closes without a new provider adapter.
2. **The missing piece was first-party behaviour, and we now have it.** The person's own actions were already captured in real
   time in our own tables, and that capture is all Celebrus would sell us (§3.1). What was missing was the watcher that turns
   those rows into intent, plus one unified read with field-level provenance. Both are now built, at $0 vendor cost:
   `lib/enrichment/first-party-intent-watcher.ts` and `lib/enrichment/customer-360.ts` (contract C6).
3. **The material gap is licensing, not capability.** The owner requires a provider that "doesn't prohibit writing and reading
   all data to the profiles". None of the evaluated vendors grants that on its **standard** terms (§4). This includes the two we
   use today: Versium forbids caching or building a database from its data, and PDL limits how long data may be cached. The
   remedy is a negotiated Ordering Document or Enterprise data licence. It is **WAITING_EXTERNAL** and belongs to the owner (§7).
   Changing vendors does not fix it. The 360 already labels every vendor-sourced field `vendor_licensed`, so whatever licence is
   signed can be audited and enforced field by field.
4. **There is one optional addition, which needs counsel first:** USPS NCOA (change of address) through a licensed processor.
   It is the authoritative "moved" signal for people we already have a business relationship with, at **$20 per file**
   (TrueNCOA). USPS limits its use to correcting mailing lists, and that limit has to be squared with a multi-tenant platform
   before anything is built (§3.6).

## 2. Requirements, and which source meets each

The DealMachine column was added in wave 147 (lane 147D, owner ruling 17). It was read from DealMachine's own pages on
2026-10-31. The full capability-by-capability evaluation, with the quoted terms, is `docs/commercial/DEALMACHINE-EVALUATION.md`.

| Requirement (ruling 11 / 12) | Met by | Verified how | DealMachine (wave 147D, read 2026-10-31) |
|---|---|---|---|
| Identity resolution | First-party: `lib/kernel/person-identity.ts` (m697 evidence). Vendor: PDL person match, Versium contact append | code; §3.2 / §3.3 | Enrich by name, email or phone, at 1 people credit per matched person. Tenant data sent for enrichment falls under ToS §5(b), a perpetual, sublicensable licence to DealMachine |
| Property / homeowner records | RentCast AVM + property facts; BatchData property search / quickLists | `docs/commercial/PROVIDER-COST-REPORT.md` §3.3 | Yes: 150M+ properties with owner, mailing address, four mortgage slots, tax, liens and MLS status. **Already covered** by RentCast and BatchData |
| First-party behaviour (portal, search / view, site, forms, tours, communications) | **our own tables, written in real time** + the first-party watcher | code; `scripts/customer-360-guard.ts` | None |
| Third-party intent / life-event signals | Versium Online Presence Indicator – Real Estate, refinance / mortgage dates; PDL job / location history; OSINT life events; BatchData distress quickLists | `lib/enrichment/intent-signal-sources.ts` (wave 144E census) | **Modeled** flags only: likely to move, new mover and month, lease-ending window, potential first-time buyer, likely mortgage applicant. Source and accuracy not published. `marital_status = Divorced` is a modeled demographic, not a filing |
| Real-estate applicability | Versium real-estate indicators; BatchData; RentCast | §3.3 | Yes. An investor product ("For solo investors and small teams hunting off-market deals") |
| Update frequency | declared per source, honestly (§5) | §5 | Property data refreshed daily; owner and contact data monthly; DNC flag monthly ("not a live registry check") |
| Read API | all four current vendors | — | REST, 60 / min and 5,000 / day, **no sandbox** ("All API keys are live") |
| Write-back / export / storage rights | **not on standard terms from any evaluated vendor** — contract | §4 | Not on standard terms: internal use only, non-sublicensable, no making the Services available to any other party, one account per customer. No destroy-on-termination clause was found |
| Provenance | `enrichment_profile.field_provenance` (one writer) → the 360's field-level source / basis / ownership | code | No per-field source or date in the documented response. Only a `credits` object and an organization activity log (12 months) |
| Licensing / consent / privacy (FCRA, fair housing) | vendor AUPs forbid FCRA purposes. We do no tenant screening. Protected attributes are labelled and withheld from outreach | §4; ruling 13 | Owners "have not been asked for consent". Registered data broker (CA, TX). People filters expose gender, marital status, household composition, language and age as **audience selectors**. Credit-behaviour fields have no stated FCRA status |
| Tenant isolation | our code (every 360 / watcher read is brokerage-pinned) | `scripts/customer-360-guard.ts` | Cannot be isolated inside one account: dedupe, `exclude_previously_exported`, the activity log and export concurrency are organization-wide |
| Pay-per-use vs subscription; cost per useful update | §6 | §6 | Per-seat subscription. $0.0060 – $0.0099 per credit at full use. Monthly credits reset, with "no automatic per-credit overages" |

## 3. Providers evaluated

### 3.1 Celebrus (first-party behavioural capture / CDP)

| Fact | Source |
|---|---|
| Tag-free first-party capture across web, apps, kiosks and servers. Real-time identity stitching, including anonymous visitors. | <https://www.celebrus.com/data-platform/data-capture> |
| "Single customer view" / identity graph, built from **first-party** data only. It is not a third-party life-event or intent dataset. | <https://www.celebrus.com/data-platform/single-customer-view> |
| Celebrus Cloud is a single-tenant VPC ("your data stays in your environment"), with AWS, Azure and Google options. | <https://www.celebrus.com/data-platform/customer-data-management-cloud> |
| Revenue comes from "platform licenses, cloud services and support contracts" and professional services. Serves enterprises in banking, retail, travel and healthcare. | <https://www.celebrus.com/hubfs/FY26%20Files/FY26%20Investors/Celebrus%20Annual%20Report%202026%20FINAL%20Web.pdf> |
| **Price: not published.** Demo and quote on request (a third-party review, 2026-10-12, says the same). | <https://europeanpurpose.com/tool/celebrus> |

**Assessment.** Celebrus sells first-party capture and a single customer view. We already capture the same signals in our own
tables, in real time: `client_portal_activity`, `portal_access_logs`, `saved_properties`, `property_views`, `website_visitors`,
`form_submissions`, `showings`, `showing_requests` and `activities`. We also already have the identity graph (`person_identities`).
What we lacked was the **watcher** and the **unified read**, and both are now built. Celebrus would also mean an enterprise licence
with no published price, plus a second capture tag on tenant sites. **Not recommended.**

### 3.2 FullContact

| Fact | Source |
|---|---|
| Enrich API (`POST /v3/person.enrich`). Multi-field identity resolution to a persistent Person ID, with a selectable match confidence (LOW 60 % … MAX 98 %). | <https://docs.fullcontact.com/docs/getting-started-with-enrich-1>, <https://docs.fullcontact.com/docs/request-properties> |
| "Insights Bundles" (demographics, household, finances, triggers, purchases, MAIDs / HEMs …), each priced separately in the account's Plan & Billing. | <https://docs.fullcontact.com/docs/person-insights-bundles>, <https://docs.fullcontact.com/docs/individual-plus-insights> |
| The Individual Plus bundle returns age, gender, number of children, marital status, income, net worth, mortgage amount and length of residence. These are mostly **protected-class fields** under our classifier. | <https://docs.fullcontact.com/docs/individual-plus-insights> |
| **Price: not published.** The pricing URL is a contact form. | <https://www.fullcontact.com/pricing/> |
| Ownership: Ziff Davis completed an **asset acquisition of FullContact** in Q4 2024. | <https://investor.ziffdavis.com/news/news-details/2025/Ziff-Davis-Completes-One-Acquisition-in-Q4-2024/default.aspx> (2025-01-02) |
| A 2019 FullContact Services Agreement, filed as a court exhibit, lets the client integrate the data into its own application and show it to End Users "strictly for internal use". On termination the client must "irrecoverably delete … any and all FullContact Data", except Data Output already derived from it. **This is an old agreement. Current terms need a quote.** | <https://storage.courtlistener.com/recap/gov.uscourts.cod.188986/gov.uscourts.cod.188986.1.4.pdf> |

**Assessment.** FullContact mostly duplicates what PDL (person / employment) and Versium (demographic / household / online
identifiers) already give us. It has no published price, and no real-estate-specific intent signal was verified. Its strongest
bundle is the one with the most protected attributes, and those are the attributes we must keep out of targeting.
**Not recommended.**

### 3.3 The current stack — PeopleData (PDL) and Versium

| Fact | Source |
|---|---|
| PDL: Free tier of 100 credits / month. Pro "Starting at $98/mo" (350 records / month). Enterprise is custom. One credit per **successful** match only. | <https://www.peopledatalabs.com/pricing/person>, <https://docs.peopledatalabs.com/docs/create-an-account> |
| PDL per-credit tiers are **$0.28 / $0.265 / $0.25** monthly and **$0.224 → $0.20** annual. Booked at $0.25 / match (`lib/external/peopledata-client.ts`). | `docs/commercial/PROVIDER-COST-REPORT.md` §3.3 (read 2026-10-23) |
| PDL update cadence: the API index is updated **monthly**; flat files monthly or quarterly. | <https://docs.peopledatalabs.com/docs/data-updates> |
| PDL publishes a **Person Changelog** (added / deleted / merged / updated, with `fields_updated`) as flat files in a public AWS bucket, monthly and quarterly. | <https://docs.peopledatalabs.com/docs/id-changelog> |
| PDL Acceptable Data Use Policy: no FCRA purposes, no tenancy verification or rental applications, no "re-identifying" pseudonymous identifiers. | third-party quotation of the PDL agreement, <https://datacircle.dev/find-cached-phone-apis/people-data-labs/98-monthly-pro-tier-1-get-v5-person-enrich> |
| Versium: Pay-as-you-go **$0.075 – $0.05 / match credit** ($125 minimum per file, **no API**). Credit packages **from $250**, at **$0.05 – $0.02**, never expire, with API + MCP. Subscriptions **from $5,000 / yr**, below $0.02. Only successful matches are charged. | <https://versium.com/pricing> |
| Versium credit weights are published: Full Demographic (where the Online Presence Indicator – Real Estate lives) costs 3 credits; online audience costs 1. | `docs/commercial/VERSIUM-CAPABILITY-MATRIX.md` (wave 144E) |
| Versium refresh cadence of its underlying data: **not published**. The vendor does not push. | `lib/enrichment/intent-signal-sources.ts` header; no vendor page found |

### 3.4 DealMachine

| Fact | Source |
|---|---|
| Plans: **Basic $99 / seat / mo** (10,000 data credits), **Pro $149 / seat / mo** (20,000), **Scale $599 / package / mo** (100,000 records, 10 seats). Annual billing saves 17 %. Overage is billed "at your plan's per-credit rate". | <https://www.dealmachine.com/pricing>, <https://dealmachine.com/guides/current-vs-classic-pricing>, <https://dealmachine.com/guides/data-credits> |
| One credit per unique property and one per unique person, de-duplicated within the billing month. API, CLI and webhooks are on every plan. Default limits: 60 calls / min and 5,000 / day. | <https://www.dealmachine.com/guides/api-quickstart> |
| Data: owner, mailing address, vacancy, beds / baths, estimated value and equity, mortgage, tax, sale history. Phones, emails, phone type and DNC status for the people on a property. | <https://www.dealmachine.com/guides/api-quickstart> |
| **Terms (effective 2026-07-14):** the licence is "non-transferrable, non-sublicensable … limited to the Customer's internal, lawful use only". The customer may not "rent, lease, lend, sell, license, sublicense … or otherwise make available the Services to any other party", and may not use the Services to build a competing service. | <https://www.dealmachine.com/terms-of-service> |
| "Use and retain data according to the current terms of service and your agreement. Contact the team before using data beyond those terms." | <https://www.dealmachine.com/guides/api-quickstart> |

**Assessment.** DealMachine is an investor tool with per-seat pricing. Its data overlaps BatchData's (owner / property / distress /
skip trace). It offers no behavioural intent and no life events. On its standard terms it is an internal-use licence, which does not
fit a platform serving many tenant brokerages. **Not recommended** unless the owner negotiates a platform agreement and it beats
BatchData's per-record rate (and that rate is itself UNKNOWN, per `PROVIDER-COST-REPORT.md` §8).

**Re-evaluated in wave 147** (lane 147D, owner ruling 17). Read on 2026-10-31 from the full API documentation
(<https://api.docs.dealmachine.com/llms-full.txt>), the Terms of Service, the Privacy Policy (effective 2026-08-26) and the
guides. The detail is in `docs/commercial/DEALMACHINE-EVALUATION.md`. **The verdict holds, and no adapter is built.** Five facts
change or add to the rows above:

1. Overage. <https://www.dealmachine.com/guides/data-credits> now reads "Do not expect automatic per-credit overages. A chargeable
   request can stop at your remaining balance."
2. Freshness is published. Property data is refreshed daily, and owner and contact data monthly
   (<https://www.dealmachine.com/privacy-policy> §8). The DNC flag is refreshed monthly and is "not a live registry check".
3. Webhooks carry `prospect.*` / `list.*` workspace CRM events only, never property or owner data changes
   (<https://api.docs.dealmachine.com/webhooks/events>).
4. Two more clauses bear on a platform. ToS §2(a) allows one account per customer without written authorization. §5(b) grants
   DealMachine a "perpetual, irrevocable, transferrable, sublicensable license" over any Customer Data we submit.
5. "No behavioural intent" is narrowed. DealMachine sells **modeled** mover and renter flags (lease-ending window, new mover,
   likely to move, first-time buyer). Those are a real gap against the current stack, but the licence blocks them and their
   source and accuracy are unpublished.

At full plan use, DealMachine's per-credit price ($0.0060 – $0.0099) undercuts the booked BatchData skip trace ($0.07, UNVERIFIED).
That benefit is measurable but blocked by the licence.

### 3.5 Real-estate predictive / engagement products found by research

| Provider | What it is | Price | Source |
|---|---|---|---|
| Revaluate | Scores the tenant's own database nightly for "likely to move". Life-event triggers: "Death, Divorce, Diapers, Diamonds, Diplomas …". Has an API / CRM integration. | **not published** ("customized to the number of contacts") | <https://revaluate.com/docs/faq> |
| Likely.ai | Likely-seller predictions and 24/7 contact monitoring through the "REfresh Engine". Has an API. | **not published** by the vendor (≈ $0.80 / contact **reported** by a third party) | <https://likely.ai/>, <https://www.agentflowtools.com/likely-ai-vs-offrs> |
| Offrs / SmartZip (both Constellation1) | Predictive seller lists by territory | **not published** by the vendors (Offrs ≈ $0.05 / property / mo; SmartZip ≈ $500 – $1,500 / mo, **reported**) | <https://aitoolsbakery.com/blog/offrs-vs-smartzip/> (2026-07-20) |
| Homebot | Monthly home-value digest to homeowners. Fires "Likely to Sell" score, CMA-request and DM signals into a CRM. **Sends its own emails** (e.g. a "Likely to Sell" alert). | $75 / $200 per month as a Sierra Interactive bundle; direct pricing not verified | <https://www.sierrainteractive.com/partnerships/integrations/homebot-sierra-interactive-integration/> (2026-05-14), <https://help.homebotapp.com/en/articles/12601512-likely-to-sell-email-alert> |
| ATTOM | Property API. Assessor / recorder / foreclosure data updated daily, AVM monthly. Priced per API report against a contracted quota. | API price **not published** (quote). Property Navigator $499 / yr, with 200 reports / mo | <https://api.developer.attomdata.com/dlpv2docs>, <https://cloud-help.attomdata.com/article/684-api-report>, <https://www.attomdata.com/solutions/property-navigator/pricing/> |

**Assessment.** The predictive scorers are black boxes over the same public-record, demographic and life-event inputs we already
hold. Several of their named triggers (divorce, children, death) are protected-class proxies that we may use only as service topics,
never as segments. None publishes a price. Homebot duplicates our lifetime portal (equity card, value updates) and runs its **own**
email sender beside ours, which conflicts with the no-duplicate-sender ruling. ATTOM overlaps RentCast and BatchData. **None is
recommended now.**

### 3.6 USPS NCOA (change of address) — the authoritative "moved" signal

| Fact | Source |
|---|---|
| About 160 million permanent change-of-address records, kept 48 months and updated weekly. End-user licensees receive an 18-month set monthly. | <https://docs.precisely.com/docs/sftw/verimove/3.9/en-us/webhelp/Introduction/USPSRequiredText.html> |
| "The sole purpose of NCOALink processing is to provide a mailing list correction tool … may not be used to create, generate, or maintain new movers lists or as a source to any other proprietary database for the purpose of redistribution or sale." | same |
| A customer may keep the updated addresses "for individuals and entities with whom it has or has had a business relationship", for its own purposes only. It may not "transfer, disclose, license or distribute" them to any other entity. | <https://www.precisely.com/legal/licensing/verimove-verimove-express-terms-06-2021/> |
| NCOALink End User License Agreement v30 (2026-07-15) | <https://postalpro.usps.com/NCOALink/End_User_License> (2026-07-17) |
| TrueNCOA: **$20 per file processed**, "enough for a quarterly update". API link present. | <https://truencoa.com/pricing/> |

**Assessment.** NCOA is the cheapest authoritative life-change signal for people a tenant already serves. Using it has three
consequences. Each tenant's list has to be processed as that tenant's own list (no pooling across tenants). A Processing
Acknowledgement Form is needed per list owner. And the "moved" result may update the address and support communication with that
person, but must never seed a new-movers list. **Owner / counsel decision before any build** (§7).

## 4. Storage rights on standard terms (the material gap)

| Vendor | Standard-terms clause | Read |
|---|---|---|
| Versium ("Versar") | §3.3: may not "(b) redistribute, sublicense, transfer, sell … or disclose any of the Licensed Materials to any third party; (c) incorporate any of the Licensed Materials into your own products or services; … (g) … operate any timesharing, service bureau, or similar business; … (j) cache any data from Licensed Materials and/or build a database from the Licensed Materials". §7.3: on termination, "destroy any and all copies of Licensed Materials and any information you have obtained from the Licensed Materials". An Ordering Document may override these only where it is "expressly intended to modify these terms". Last updated **June 2026**. | <https://versium.com/terms-conditions/> |
| People Data Labs | "Data returned in API endpoints may not be saved in Customer databases ('Cached Data') for longer than necessary to perform actions permitted via Service License … Cached Data may not be provided or displayed to more than one End User … Upon termination … Customer must delete all Data". The licence covers "internal business purposes" and lets the customer display data to its "own clients … on Customer's platform". **Secondary source:** the primary SSA (<https://privacy.peopledatalabs.com/policies?name=services-subscription-agreement>) is client-rendered and could not be read by machine. This needs a human read before signing. | <https://datacircle.dev/cached-people-search-apis/people-data-labs/free> |
| FullContact | Delete on termination, except derived Data Output (2019 agreement; current terms by quote) | §3.2 |
| DealMachine | Internal use only, non-sublicensable, no making the Services available to any other party (2026-07-14). Also (read 2026-10-31): one account per customer unless authorized in writing (§2(a)); a perpetual, sublicensable licence to DealMachine over Customer Data we submit (§5(b)); no destroy-on-termination clause found; an Order Form overrides the ToS only where it says so expressly (§11(j)) | §3.4; `DEALMACHINE-EVALUATION.md` §4 |
| Celebrus | First-party data: "you own and control the data" (vendor statement) | §3.1 annual report |

**What this means in code today.** The enrichment rail persists Versium and PDL answers on `contacts.enrichment_profile` with a
provenance stamp per field (wave 100C). That is the right engineering. On the vendors' **standard** terms, though, it is
persistent caching that §3.3(j) and the PDL Cached-Data clause restrict. The 360 labels every such field `ownership:
"vendor_licensed"` with its source and retrieval time. A contract amendment, or a purge on termination, can therefore be executed
and audited exactly. No code silently changes that posture: deleting data to fit a contract that is still being negotiated would
itself be a defect.

## 5. Honest freshness — per source (generated from `CUSTOMER_360_SOURCES`, `lib/enrichment/customer-360.ts`)

| Source key | Tables | Mode | Cadence |
|---|---|---|---|
| record | contacts, leads | realtime_write | the canonical row, written by its own writers at the moment of the change |
| identity | person_identities, person_identity_evidence | realtime_write | evidence rows appended at each identity chokepoint (m697) |
| consent | contacts, leads, contact_consent_events | realtime_write | opt-in / opt-out recorded when given or withdrawn |
| portal | client_portal_activity, portal_access_logs | realtime_write | written at each portal visit; the watcher reads it on the 15-minute enrichment-processor tick |
| search | saved_properties, property_views, website_visitors | realtime_write | written at each save / view / site session; read by the watcher on the 15-minute tick |
| tours | showings, showing_requests, tours | realtime_write | written when a showing / tour is requested or scheduled |
| forms | form_submissions | realtime_write | written at each submission (the promise ledger and welcome belong to lanes 146F / 146C) |
| communications | context_spine, activities, agent_client_messages | realtime_write | touches written as they happen; the spine is recomposed by the context-spine-refresh cron |
| transactions | transactions | realtime_write | the deal row, written at each stage change |
| household | relationship_edges | realtime_write | edges derived at the survivor writers (m698) |
| behaviour | behavioral_signals, intelligence_signals_log, valuation_requests, isa_outreach_log | periodic_platform | a decayed score recomputed on read |
| versium | enrichment_profile.real_estate_indicators / online_audience | periodic_provider | stored only when our gap-only enrichment buys it; no push; answers the gap for 180 days |
| peopledata | enrichment_profile (person_profile) | periodic_provider | monthly API index; no push; answers the gap for 90 days |
| batchdata | motivated_seller_signals | periodic_provider | polled quickLists; Property Subscription **push** only once BatchData provisions it (WAITING_EXTERNAL) |
| signals | signal_reactivations | realtime_write | recorded by the ONE life-change responder |

No provider fact is ever labelled real-time. A monthly dataset is a monthly dataset (ruling 11).

## 6. Cost per useful update

A "useful update" is a stored change that can move a decision. The **rate of change is UNKNOWN**: the live tables held 0 rows on
2026-10-29, so no telemetry exists. That makes cost per useful update equal to the per-match price divided by the (unknown) change
rate. This report does not invent the denominator.

| Source | Unit price (verified) | Refresh rule in code | Useful-update cost |
|---|---|---|---|
| First-party watcher + 360 | $0 vendor (compute only) | every 15-minute tick, starts / resumptions only | $0 vendor |
| PDL person profile | $0.20 – $0.28 per successful match | gap-only, re-bought at most every 90 days | price ÷ change rate (UNKNOWN) |
| Versium Full Demographic (online presence) | 3 credits × $0.02 – $0.05 = **$0.06 – $0.15** per matched record (packages) | gap-only, 180-day window | price ÷ change rate (UNKNOWN) |
| BatchData Property Subscription | push. Subscription price is on the BatchData page; the per-record API rate is UNKNOWN | webhook once provisioned | UNKNOWN (contract) |
| NCOA (optional) | $20 per file (TrueNCOA) | quarterly per tenant list | $20 ÷ movers found (UNKNOWN) |
| FullContact / Celebrus / Revaluate / Likely / Offrs / SmartZip | not published | — | not computable |
| DealMachine | $99 – $149 / seat / mo or $599 / 100k records. $0.0060 – $0.0099 per credit at full use; credits reset monthly; no automatic overage (read 2026-10-31) | — (no adapter: licence) | credit price ÷ contact fill rate (UNKNOWN). Below break-even (Basic 1,415 / Scale 8,558 records a month against BatchData's booked $0.07) the seat fee costs more than today's stack (`DEALMACHINE-EVALUATION.md` §5) |

The cheapest lever available without a new vendor is the PDL Person Changelog: free flat files that name which persistent IDs
changed, and which fields. A monthly diff against `contacts.peopledata_id` would let the rail re-buy only profiles whose job or
location actually changed, instead of re-buying on the 90-day window. The files are large (about 100 MB parts) and are a batch job
for a worker, not a Vercel cron. **Proposal only — not built.** It needs an owner decision on where the batch runs.

## 7. Recommendation — the lowest-cost combination

1. **Keep:** PDL + Versium (person / real-estate intent, gap-only, per-match), BatchData + RentCast (property). The verified cost
   is unchanged.
2. **Built (wave 146D):** the Customer 360 read (C6) and the first-party intent watcher, at $0 vendor cost.
3. **Negotiate (WAITING_EXTERNAL, owner):** a Versium Ordering Document and a PDL Enterprise / product-embedded licence that
   **expressly** grant (a) persistent storage on tenant contact and lead profiles; (b) display to each tenant's authorised users;
   (c) multi-tenant (service-bureau) use; and (d) retention after termination, or a defined purge. This is the only route to
   "writing and reading all data to the profiles". No evaluated alternative offers it on standard terms.
4. **Optional, counsel first:** NCOA through a licensed processor (TrueNCOA $20 / file) for the "moved" life change on existing
   relationships, processed per tenant.
5. **Do not add:** Celebrus, FullContact, DealMachine, Revaluate, Likely.ai, Offrs / SmartZip, Homebot or ATTOM. Each either
   duplicates a capability we hold, publishes no price, conflicts with a ruling (duplicate sender, protected-class segments), or
   licenses its data for internal use only. DealMachine was re-evaluated in wave 147 (`DEALMACHINE-EVALUATION.md`, read
   2026-10-31) and is still not added. The blocker is the licence, not capability or price. It reopens only on a signed Order Form
   that expressly grants multi-tenant use (WAITING_EXTERNAL, owner and counsel).

## 8. Blind spots

- **No account, no key, no sandbox call** with any vendor. Capabilities come from the vendors' own documentation.
- **Prices change without notice.** Every row carries its read date. Negotiated discounts, taxes and minimum terms are not modelled.
- **PDL's agreement text** comes from a third-party quotation, because the primary page is client-rendered. FullContact's terms
  come from a 2019 court exhibit. Both need a human read of the current documents before any contract decision.
- **Reported prices** (Likely.ai, Offrs, SmartZip) are third-party claims. The recommendation does not rest on them.
- **Not evaluated in depth:** Experian, Epsilon and Acxiom life-event / new-mover files (enterprise contracts, no published price),
  Melissa, and consumer CDPs (Segment, RudderStack). The last are unnecessary because first-party capture already lands in our
  own tables.
- **The change rate is unmeasured,** so cost per useful update is a formula, not a number.
