> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Packet 3 — Schedule 3: Acquisition, Enrichment, Data Rights and Third-Party Integration Schedule

Version: 0.1.0-draft (2026-11-09) · Document ID: VIP-LEGAL-P3 · Wave 151, lane 151A2 · Written against commit `b2c93720`

This Schedule is incorporated into the Platform Subscription and Services Agreement (Packet 1). Capitalized terms have the meanings given there. It describes the acquisition and enrichment capabilities included in Subscriber's subscription, the Providers behind them, who owns and pays for each, what may be collected and how, how records are kept fresh and deduplicated, how suppression and privacy requests are honored, and what happens when a Provider is unavailable.

## Variables

| Variable | Meaning | Status |
|---|---|---|
| `[[PLATFORM_LEGAL_ENTITY]]` | The contracting platform entity (Packet 1). | OPEN |
| `[[SUBSCRIBER_LEGAL_ENTITY]]` | The subscriber (Packet 1). | PER-SUBSCRIBER |
| `[[SUBSCRIBER_BROKER_OF_RECORD]]` | The licensed broker responsible for the subscriber's real estate activity. | PER-SUBSCRIBER |
| `[[TERRITORY_DEFINITION]]` | The geographic unit a territory is defined in (ZIP codes, counties, a city and state, or a combination) and any limit on the number of territories per Tier. | OPEN |
| `[[ACQUISITION_MONTHLY_CEILING_BY_TIER]]` | The monthly Platform-Owned Provider spend ceiling per Tier that the budget gate enforces (a cap on included usage, not a price). | OPEN |
| `[[PROVIDER_TERMS_CONFIRMATION_DATE]]` | The date counsel confirmed each active Provider's terms permit the platform use described here. | OPEN |
| `[[SOURCE_RECORD_RETENTION_DAYS]]` | How long a raw acquired record that never becomes a Lead is kept before deletion. No code sets this today. | OPEN |
| `[[DSR_RESPONSE_DAYS]]` | The response period for a data-subject request (the code computes forty-five days by default; counsel confirms per state). | OPEN |
| `[[PRIVACY_CONTACT_EMAIL]]` | The address a person or Subscriber uses for privacy requests. | OPEN |
| `[[DATA_RETENTION_YEARS_TRANSACTION]]` | Retention for transaction records (Packet 1). | OPEN |
| `[[CROSS_TENANT_AGGREGATE_USE]]` | Whether de-identified, aggregated acquisition telemetry may be used across Tenants (Packet 1 §9.2). | OPEN |

---

## 1. Acquisition is an included subscription capability

1.1 **Included.** Lead acquisition, discovery research, enrichment and the AI ISA's qualification of acquired Leads are ordinary capabilities of Subscriber's monthly subscription, in the same way the CRM, the transaction system and the marketing tools are. They are provided for Subscriber's Tier within the capacity limits in Packet 1 §4 and the Provider spend ceiling in §3.5 below.

1.2 **No per-lead, per-record, per-delivery or per-closing charge.** Platform does not charge Subscriber for the creation, delivery, qualification, conversion or closing of any Lead or Contact acquired through the Service. No referral fee, commission, revenue share, success fee or similar amount is owed to Platform on any transaction Subscriber closes with a person the Service surfaced. The only amounts Subscriber pays are the Fees in Packet 1 §5.

1.3 **No separate commercial product.** Acquisition is not sold as a separate product, list, lead package or territory license. Nothing in the Service prices a lead, and the plan catalog carries no per-lead line.

> **Drafting note (not contract text).** This section restates an owner ruling that the code enforces by absence: the plan catalog (`lib/billing/plan-catalog.ts`) has no per-lead or per-record price, the raw-record cost column is recorded from the metered Provider ledger and never estimated (`lib/kernel/scraping.ts::ingestRawSourceBatch` divides a batch's real metered cost per record and leaves it null when none was metered), and platform acquisition spend is capped and recorded per Tenant. Counsel should confirm that stating "no per-lead charge" as a contract term does not, under any state's real estate license law, require a disclosure that the platform is not a licensed referral source.

## 2. The acquisition lifecycle and its vocabulary

2.1 **One door in.** Every externally acquired record — from a Platform-Owned Provider, a Tenant-Connected Provider, a neural-search discovery, a permitted scraper or a public-records source — enters the Service through one intake (`lib/kernel/scraping.ts::ingestRawSourceBatch`) as **RawData**: an observation with its source, source channel, source subtype, territory, retrieval time, recorded cost and a scoped idempotency key, so the same observation ingested twice is one row.

2.2 **Before a paid pull.** Before the Service pays a Provider for records it previews the territory, the freshness window, the capability and the cost; checks whether records it already holds are sufficient; and deduplicates against what it has, so it does not buy what it already owns. A paid pull is approved before it runs under the spend rules in §3.5.

2.3 **Raw Lead.** A RawData observation that resolves to an eligible person-level candidate — a viable identity, in territory, within the source's freshness window, not already a known person — becomes a **Raw Lead**. The Service deduplicates at this step against three tables: raw records, Leads and Contacts. It never overwrites a real Contact record with a lower-confidence acquired record.

2.4 **Promotion gate.** A Raw Lead becomes a **Lead** only when the existing promotion gate passes; a Raw Lead the gate holds or rejects is verified, suppressed or rejected with its reason recorded. The AI ISA is never assigned at the raw stage.

2.5 **AI ISA and conversion.** The AI ISA works the Lead under the authority in Schedule 2. The existing conversion rule creates or links a **Contact** when the person qualifies or shows positive intent, and only then does an authorized agent see the person — as a Contact, never as a Lead. A consented first-party inbound record (a website form, a QR code, a business card scan) keeps its direct-to-Contact path and never passes through acquisition.

2.6 **Distinctions the Service persists.** A property opportunity is not an identified person. A persona is not transaction intent. Audience qualification is not permission to contact. A vendor score is not a measured probability of closing. Public research is not a usable licensed marketing list. A market-level signal (an employer announcement, a permit volume, a military movement) does not by itself create a named-person Lead. The Service stores these as separate facts with separate evidence rather than collapsing them, and it neither refuses all potentially useful source data nor turns every observation into a marketed individual.

## 3. Providers: who owns, who pays, who may activate

3.1 **Two ownership models.** Each Provider the Service uses is either **Platform-Owned** — Platform holds the account, pays the vendor, meters the use to Subscriber's Tenant and caps it — or **Tenant-Connected** — Subscriber holds the account, pays the vendor directly, and connects it under Schedule 6. The decision is recorded once per Provider in the tenancy matrix (`lib/providers/tenancy-matrix.ts::PROVIDER_TENANCY`) and is not re-litigated per feature. The five recorded models are: platform metered; platform master account with an isolated child account per Tenant; the user's own connected account; a platform fallback the Tenant may replace with its own key when its own license makes the data or the usage its own; and bring-your-own credentials on the Multi-Location Tier only.

3.2 **Platform-Owned Providers for acquisition and enrichment.** As recorded at this version:

| Capability | Provider (platform account) | Model | Legal line recorded in the matrix |
|---|---|---|---|
| Property facts, valuation, market and listing data | RentCast | Platform metered; a Tenant never brings its own key and is never offered the option, so every call is metered and capped. | Terms of Use not yet read in full; the API page's statement is the only rights source on record (§4.2). |
| Contact append, demographic and property append, business identity, online-presence indicators, audience estimates, online-audience match | Versium | Platform metered under an existing contracted account. | Signed partner / SaaS rights unverified; the standard terms forbid caching and service-bureau use (§4.2). |
| Motivated-seller lists, skip trace, do-not-call and TCPA scrub, address and phone verification, comparables | BatchData | Platform metered; **dormant survivor** — live doors await owner confirmation. | Non-FCRA contact data: never for credit, tenancy, insurance or employment screening; every sourced contact stays behind the TCPA and do-not-call gates. |
| Person profile, employment, email validation | PeopleData Labs | Platform metered; **dormant survivor**. | Standard terms read: cache no longer than necessary, one end user, delete on termination; non-FCRA. |
| Buyer-intent and pre-listing discovery across public text; competitor research | Exa | Platform metered. | Sourced identities ride the same viability and consent gates as every other lane; public research never names a person on its own. |
| Topic and competitor harvesting for the platform's own marketing | Tavily | Platform metered. | Platform marketing only. |
| Direct-site source families (for-sale-by-owner, expired, rental, classified and similar) | Apify actors; ZenRows for anti-bot rendering; Zyte as the backup scraper lane | Platform metered. | Publicly available data only; robots and terms-of-service exposure carried at the platform level; every scraped record passes suppression and the do-not-call and TCPA scrub before any Tenant can touch it. |
| Court and public-records filings (divorce, probate, foreclosure, tax lien, eviction, bankruptcy) | Free open-source-intelligence lane; Socrata and ArcGIS public portals for permits | No vendor cost. | Permit-portal rows are attach-only facts about a property and never mint a Lead from a bare address. |
| Maps and travel time | Mapbox first, Google Maps fallback | Platform metered. | Cartography licensing per each vendor's commercial terms. |

3.3 **Dormant Providers pending rights.** Tracerfy, DataZapp, PropertyRadar and Data Axle are recorded as dormant pending rights (`lib/ai-isa/property-lookup-rail.ts::PROVIDER_ACTIVATION`). No transport exists for them, no credential is requested, no live call is made and no data flows. What exists is a pure response mapper over the fields each vendor documents (`lib/providers/dormant-adapters.ts::mapDormantProviderResponse`), used only in offline simulation. Activation requires, together and as one reviewed change: a contract or written platform-use confirmation, measured incremental coverage on real data, unit economics from a measured test, and a credential name (`lib/providers/provider-scorecard.ts::activationVerdict`). No manager and no self-healing playbook can flip a Provider from dormant to active.

3.4 **Tenant-Connected Providers.** The Providers a Tenant may connect from its own account are listed by domain in `lib/connections/scope.ts::CONNECTOR_PROVIDERS`: its own IDX or multiple-listing feed; its own email and calendar accounts; its own phone carrier accounts; its own social accounts; its own CRM for outbound synchronization only; its own accounting and payment accounts; its implemented e-signature and transaction-forms providers; its showing-scheduling, podcast-distribution and meeting providers. Subscriber pays those vendors directly, grants only the scopes the connection needs, and may disconnect at any time under Schedule 6. The platform budget never gates a Tenant-Connected Provider; the gate is whether the account is connected and healthy.

3.5 **Who pays, and the ceiling.** For Platform-Owned Providers, Platform pays the vendor. Each call is metered to Subscriber's Tenant and recorded on the vendor usage ledger (`lib/vendor-governance/meter-vendor.ts::meterVendorSpend`). Included use is capped at `[[ACQUISITION_MONTHLY_CEILING_BY_TIER]]` each month per Tier by the budget gate (`lib/vendor-governance/budget-gate.ts::checkVendorBudget`); when the ceiling is reached, paid pulls pause until the next period and the Service says so. A high-value opportunity may draw on an autonomy envelope Subscriber has set above the per-decision cap (Schedule 2 §7.3). Subscriber may configure its own territory budgets and record caps within the ceiling (`lib/kernel/scraping.ts`, the market's `monthly_budget_usd` and `max_records_per_run`). For Tenant-Connected Providers, Subscriber pays the vendor and the Service books nothing.

3.6 **Platform-pooled acquisition.** Where Platform runs scheduled, territory-driven acquisition from its own pool, the record is owned by no Tenant until the promotion gate or the distribution engine resolves an owner; the record's origin is recorded as platform or brokerage and never taken from a request body. A suppressed person is never distributed to any Tenant (`lib/platform/distribution-engine.ts`).

## 4. Source licensing, permitted collection and the rights each Provider grants

4.1 **Permitted collection — the rules.** The Service collects only (a) publicly available information, (b) information a Provider licenses for the purpose, (c) Subscriber's own first-party data (its website visitors, its inbound mail, its email engagement, its own Contacts), and (d) information a person supplied with consent. The Service does not bypass authentication, paywalls or access controls to collect; does not collect from a source whose terms of service the Platform has determined prohibit the collection; honors robots exclusion where the platform's legal review requires it; and never collects a person's government identifier, financial account number, health information or precise geolocation from an acquisition source.

4.2 **Rights status, recorded honestly.** The Service records, by name and never by value, what is known about each Provider's rights for this deployment — a multi-tenant SaaS with storage on Tenant records (`lib/ai-isa/property-lookup-rail.ts::PROVIDER_ACTIVATION`):

| Provider | Rights status recorded | Consequence in this Schedule |
|---|---|---|
| RentCast | Only the API page's statement of flexible licensing has been read; the Terms of Use have not. | Active by owner ruling; `[[PROVIDER_TERMS_CONFIRMATION_DATE]]` must record counsel's reading before publication. |
| Versium | Existing signed account; partner, SaaS and model-use rights in the signed terms unverified; standard terms forbid caching and service-bureau use. | §4.4 caching rule applies; counsel confirms the signed terms before publication. |
| BatchData | Terms not read in waves 146–150; plans are annual commitments. | Dormant survivor; no live calls until the owner confirms. |
| PeopleData Labs | Standard terms read: cache no longer than necessary, one end user, delete on termination. | Dormant survivor; §4.4 and §7 deletion rule apply on activation. |
| Tracerfy | Terms read: internal business use and lawful delivery to contracted end users; white-label use requires a contract. | Dormant pending rights. |
| DataZapp | Terms grant no license in writing; resale, platform and storage neither granted nor prohibited; prepaid API. | Dormant pending rights; no test deposit without a written license. |
| PropertyRadar | Partner and embedded-product rights for Tenant exposure unverified; the methodology is used without a purchase. | Dormant pending rights. |
| Data Axle | Product, fields, reseller license and quota unverified. | Dormant; only for a proven market-level gap. |

4.3 **Subscriber's use of Provider data.** Subscriber may use Provider data delivered through the Service only within Subscriber's own real estate business, for the purpose the capability names, and subject to the Provider's terms as passed through in Packet 1 §11.3. Subscriber will not resell, sublicense, export in bulk to a third party, or combine Provider data into a list for sale; will not use any Provider data as a consumer report or for any eligibility decision about credit, insurance, housing rental, or employment; and will not use a Provider's data to re-identify a person the Service has de-identified.

4.4 **Caching, redistribution and AI processing of source data.** Provider data is stored on the Tenant's own records only as long as it serves the purpose for which it was obtained and as the Provider's terms allow, and carries field-level provenance (source, retrieved time, confidence, purpose). Where a Provider's terms forbid caching beyond a request, the Service treats that Provider's output as a transient input and stores only the derived field with its provenance. Provider data is sent to the AI gateway only as part of the task Subscriber enabled and never to train a general model. Provider data is never redistributed to another Tenant.

4.5 **Scraped and public-record data.** A scraped or public record is a lead about a situation, not a verified fact about a person. It is labeled with its source and freshness, is never represented to a Contact as something they told Subscriber, and is never the sole basis for an automated intrusive outreach about a sensitive circumstance (Schedule 2 §6.4).

4.6 **Platform's own compliance line for sourced records.** Every sourced record passes the suppression check and the do-not-call and TCPA scrub before a Tenant can act on it (`lib/kernel/compliance/check-suppression.ts::checkSuppression`, `lib/communication/tcpa-gate.ts::enforceTCPACompliance`). A phone whose verdict is stale is re-verified live before a call or text; an unconfigured verifier with a stale verdict refuses rather than assumes clean.

## 5. Legal basis, notice and consent where necessary

5.1 **Roles.** For Lead and Contact personal information acquired or processed for Subscriber, Subscriber is the business or controller and Platform is its service provider or processor (Schedule 4 Part B). Subscriber decides the territories, the enabled sources and the purposes; Platform processes on those instructions.

5.2 **Lawful basis.** Subscriber is responsible for having a lawful basis, under the privacy law of each state in which it operates and in which the persons reside, to acquire and process the categories of personal information this Schedule describes, and for giving the notices those laws require, including at or before the first communication where the law requires notice of the source of the information.

5.3 **Consent for channels.** Acquisition does not supply consent. A Lead acquired from a source has given no consent to be texted or called; the Service therefore allows an unconverted Lead to be reached by email and direct mail only, each under its own law and suppression rules, and never by text or AI-placed call until express consent is recorded (Schedule 2 §5.3). Consent, when a person gives it, is recorded with its wording, hash, version, channels and purposes (`lib/kernel/compliance/require-contact-consent.ts::persistContactConsent`) and a later preference change supersedes the earlier record.

5.4 **Children.** The Service is not directed to persons under eighteen and the Service does not knowingly acquire or enrich a record of a minor. A record identified as a minor's is suppressed and deleted on identification.

## 6. Accuracy, freshness and duplicates

6.1 **Freshness windows.** Each source has a recency window appropriate to its type (`lib/lead-pipeline/source-intent-map.ts::recencyWindowForSource`); an observation outside its window is not ingested as fresh (`lib/lead-pipeline/raw-record-types.ts::isWithinRecencyWindow`). A stale observation is handled according to its actual age and type: it may update a research plan, lower a confidence, or be discarded, but it does not create a fresh Lead. Newer or contrary evidence about a person suppresses a stale acquisition signal.

6.2 **Territory match.** A record is kept only if it matches the Tenant's configured territory (`lib/lead-pipeline/source-intent-map.ts::recordMatchesTerritory`, over `lib/lead-pipeline/scrape-territories.ts::resolveScrapeTerritoriesFrom`); the territory unit is `[[TERRITORY_DEFINITION]]`.

6.3 **Duplicates.** The Service deduplicates before a paid pull, at intake by scoped idempotency key, and at Raw Lead creation by identity and property keys across raw records, Leads and Contacts. An existing Contact's evolving behavior triggers a helpful evaluation of that Contact; it is never re-purchased as a new Lead and never assigned to a second agent.

6.4 **Provenance on every field.** Every enriched field carries its source, retrieval time, confidence and purpose, and a person's own statements outrank a Provider's inference. A field a Provider did not document is never guessed into a record.

6.5 **Accuracy disclaimer.** Platform does not warrant the accuracy, completeness or currency of any acquired or enriched record. Subscriber verifies before relying on a record in any communication, offer, disclosure or transaction.

## 7. Source retention and deletion

7.1 **Raw records.** A raw acquired record that never becomes a Raw Lead or a Lead is retained for `[[SOURCE_RECORD_RETENTION_DAYS]]` days for deduplication and audit and is then deleted.

7.2 **Provider-specific deletion.** Where a Provider's terms require deletion on termination of Platform's relationship with that Provider, the Service deletes or de-identifies the fields sourced from that Provider on Tenant records and keeps the provenance record of the deletion.

7.3 **Leads and Contacts.** Leads and Contacts are Subscriber Content and are retained and deleted under Packet 1 §9 and Schedule 4 Part E, including the de-identification path for a person's deletion request and the `[[DATA_RETENTION_YEARS_TRANSACTION]]` retention of transaction records.

## 8. Contact and suppression rules

8.1 **Two suppression lists.** A Tenant suppression list records a person's opt-out by contact, email, phone and mailing address for that Tenant; a platform-wide suppression list records persons no Tenant may contact on any channel — explicit opt-outs detected by the AI ISA, TCPA violations, federal do-not-call imports, spam complaints, litigator patterns and manual platform additions (`lib/platform/suppression-list.ts`). Both are read before every send and before any distribution of a Lead.

8.2 **Honoring a request.** A STOP, unsubscribe, do-not-call request or portal preference is written to the flags and the list before it is acknowledged, and every channel's next send reads it first (`lib/kernel/compliance/check-suppression.ts::addSuppression`). A refusal of the suppression read answers SUPPRESSED, never "not on the list".

8.3 **Over-contact.** The de-confliction rail limits touches per person across channels and senders within a window, so two managers or two agents cannot both reach the same person the same week.

8.4 **Quiet hours and state rules.** Calls and texts honor quiet hours by the person's state and the additional restrictions of states the Service lists as restricted; email honors unsubscribe within the period the law requires; direct mail honors the address-level suppression.

## 9. Data-subject requests

9.1 **Intake.** Any person may submit a request for access, export, portability, correction, deletion, opt-out of sale or opt-out of sharing through the public privacy-request page (`app/privacy/request/page.tsx`, `app/actions/privacy/data-subject-requests.ts::submitDataSubjectRequestAction`) or by email to `[[PRIVACY_CONTACT_EMAIL]]`. A request is recorded with its type, the requester's identifiers, the Tenant it concerns where known, and a due date of `[[DSR_RESPONSE_DAYS]]` days from receipt.

9.2 **Verification.** Identity is verified before fulfillment and the method is recorded. A request about another person's record requires the requester's authority.

9.3 **Fulfillment.** An export produces a machine-readable bundle of the person's records with credential-shaped values excluded (`app/actions/privacy/data-subject-requests.ts::fulfillExportRequestAction`). A deletion de-identifies the Contact by replacing every personal field with an irreversible marker while preserving the transaction linkage Subscriber's retention law requires (`lib/privacy/contact-pii-redaction.ts::contactRedactionPatch`). A denial records its lawful basis. Subscriber's compliance staff and brokers fulfill requests about their Tenant's records from the privacy-requests queue (`app/dashboard/admin/privacy/requests/page.tsx`); Platform fulfills requests about platform-held account data and assists Subscriber with the rest.

9.4 **Sale and sharing.** Platform does not sell personal information and does not share it for cross-context behavioral advertising. An opt-out-of-sale or opt-out-of-sharing request is honored by recording the preference and suppressing the person from any audience match or online-audience append.

## 10. Permitted visibility

10.1 Leads belong to the brokerage. The Lead and Raw Lead queues are visible to Subscriber's lead desk — brokers, broker owners, administrators, team leads and the AI ISA system actor — and never to an ordinary agent seat (`lib/auth/lead-visibility.ts`). Agents see Contacts. A team sees only its own board. An office on a Multi-Location Tenant sees only its own members' records. Contacts, lenders and vendors see only their own records and no financials. Platform staff see all Tenants only under the audited access in Packet 1 §3.5.

10.2 Row-level security enforces each of these boundaries in the database; the Service's application gates enforce them again before any privileged read.

## 11. Provider unavailability and disconnection

11.1 **Failover.** A capability served by more than one Provider routes around a Provider in a failing cool-down to the next in the route table (`lib/ai-isa/property-lookup-rail.ts::routeCapability`, `lib/ai-isa/property-lookup-rail.ts::CONTACT_PROVIDER_ROUTES`). Where the owner has ordered the Providers for a capability, that order controls instead of cost.

11.2 **Graceful degradation.** A research capability with a single Provider degrades: the field is left empty with the reason recorded and the run continues. A compliance capability with a single Provider sends the incident to a person rather than guessing. The Service's provider posture is shown honestly as configured, unconfigured, degraded or failing (`lib/platform/provider-posture.ts`).

11.3 **Disconnection of a Tenant-Connected Provider.** When Subscriber disconnects a Provider or its credential expires, the capability that depended on it stops with an honest refusal; the Service never substitutes another Tenant's account or the platform's own account for a Tenant-owned one, and the data already acquired through it stays on Subscriber's records subject to the Provider's terms (§4.4).

11.4 **No fabricated ingestion.** An unsupported, unlicensed or unavailable Provider returns an actionable status. The Service does not simulate records, counts or deliveries from a Provider it did not call.

## 12. No guaranteed number or quality of leads

12.1 Platform makes no representation or warranty about the number, quality, accuracy, currency, contactability, consent status, intent, responsiveness or conversion of any Lead, Raw Lead, signal or audience estimate; about the availability or coverage of any source in any territory; or about the effect of any acquisition on Subscriber's revenue. A preview count is an estimate from the Provider's own count and is not a promise of records. Packet 1 §17.2 applies in full.

## 13. Subscriber's obligations under this Schedule

13.1 Subscriber will configure only territories in which it is licensed to practice; will enable only sources it is permitted to use in those territories; will not instruct the Service to collect in a manner §4.1 prohibits; will honor every suppression and privacy request the Service surfaces; will not export acquired records in bulk for resale; and will treat every acquired record as unconsented for text and voice until the person's consent is recorded.

13.2 `[[SUBSCRIBER_BROKER_OF_RECORD]]` is responsible for the use its agents make of acquired Contacts and for the communications sent to them.

---

> **Drafting note (not contract text) — open items this Schedule surfaces for the owner.** (1) RentCast's Terms of Use and Versium's signed terms must be read by counsel; both are active Providers and the Schedule can only record what the code records. (2) No code sets a retention period for a raw record that never becomes a Lead; `[[SOURCE_RECORD_RETENTION_DAYS]]` is a genuine gap, not a placeholder for a known number. (3) The BatchData and PeopleData live doors are owner decisions carried from wave 150; until the owner closes or keeps them, this Schedule lists both as dormant survivors. (4) `[[ACQUISITION_MONTHLY_CEILING_BY_TIER]]` is the per-Tier vendor budget the gate enforces today; it is a cap on included usage and must be stated without turning it into a published price.
