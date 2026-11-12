> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Packet 4 — Schedule 4: Privacy Notice, Data Processing Addendum and Subprocessor List

Version: 0.1.0-draft (2026-11-09) · Document ID: VIP-LEGAL-P4 · Wave 151, lane 151A2 · Written against commit `b2c93720`

This packet holds three documents that travel together: **Part A**, the public privacy notice; **Part B**, the data processing addendum and service-provider terms that bind Platform to Subscriber; and **Part C**, the subprocessor list. Parts D through H are annexes to Part B: AI processing, retention and deletion, cross-tenant isolation, incident handling, and consumer requests and export. Every statement about what the Service holds, does or records is written from the code at this commit and cited to it. Where a promise would exceed the implementation, the text says what is implemented and marks the rest as a variable.

## Variables

| Variable | Meaning | Status |
|---|---|---|
| `[[PLATFORM_LEGAL_ENTITY]]` | The contracting platform entity and the business named in the privacy notice. | OPEN |
| `[[PLATFORM_PRODUCT_BRAND]]` | The product name shown to users. | OPEN |
| `[[PLATFORM_WEBSITE_URL]]` | The public website where this notice is published. | OPEN |
| `[[PLATFORM_NOTICE_ADDRESS]]` | Postal address for notices. | OPEN |
| `[[PRIVACY_CONTACT_EMAIL]]` | The address for privacy requests and questions. | OPEN |
| `[[SECURITY_CONTACT_EMAIL]]` | The address for reporting a security vulnerability or incident. | OPEN |
| `[[DPO_OR_PRIVACY_OFFICER]]` | The person or role accountable for privacy at the platform. | OPEN |
| `[[SUBSCRIBER_LEGAL_ENTITY]]` | The subscriber (Packet 1). | PER-SUBSCRIBER |
| `[[HOSTING_REGION]]` | The cloud regions in which the database, storage and functions run. The repository does not record a region. | OPEN |
| `[[BACKUP_RETENTION_DAYS]]` | How long database backups are retained by the hosting provider's managed backup. | OPEN |
| `[[INCIDENT_NOTICE_HOURS]]` | Hours within which Platform notifies Subscriber of a confirmed incident affecting Subscriber Content. | OPEN |
| `[[SUBPROCESSOR_NOTICE_DAYS]]` | Days of advance notice before a new subprocessor handles Subscriber's personal information. | OPEN |
| `[[AUDIT_RIGHTS_SCOPE]]` | The audit right Subscriber receives (questionnaire, third-party report, on-site). | OPEN |
| `[[DELETION_CERTIFICATION]]` | Whether Platform certifies deletion in writing on request. | OPEN |
| `[[POST_TERMINATION_RETENTION_DAYS]]` | Post-termination export window (Packet 1). | OPEN |
| `[[EXPORT_WINDOW_DAYS]]` | How long an export bundle stays downloadable (Packet 1). | OPEN |
| `[[DATA_RETENTION_YEARS_TRANSACTION]]` | Retention for transaction records (Packet 1). | OPEN |
| `[[SOURCE_RECORD_RETENTION_DAYS]]` | Retention for raw acquired records (Schedule 3). | OPEN |
| `[[LOG_RETENTION_DAYS]]` | Retention for operational logs (errors, API response logs, access logs). No code sets this. | OPEN |
| `[[DSR_RESPONSE_DAYS]]` | Response period for a data-subject request (forty-five days computed by the code; counsel confirms). | OPEN |
| `[[AI_VENDOR_RETENTION_TERMS]]` | The prompt and output retention terms of the AI gateway and the model vendors behind it, as confirmed by counsel. | OPEN |
| `[[CROSS_TENANT_AGGREGATE_USE]]` | Whether de-identified, aggregated usage data is used across Tenants (Packet 1 §9.2). | OPEN |
| `[[COOKIE_AND_ANALYTICS_DISCLOSURE]]` | The cookie and analytics disclosure for the public website and the app (first-party analytics is mounted; counsel confirms whether any other tracking exists). | OPEN |
| `[[STATE_LIST]]` | The states whose privacy laws the notice addresses by name. | OPEN |
| `[[EFFECTIVE_DATE]]` | The effective date of this version of the notice and addendum. | OPEN |

---

# Part A — Privacy Notice

*Effective `[[EFFECTIVE_DATE]]`. This notice describes how `[[PLATFORM_LEGAL_ENTITY]]` ("we", "us") collects, uses, discloses and protects personal information in connection with `[[PLATFORM_PRODUCT_BRAND]]` (the "Service") and the website at `[[PLATFORM_WEBSITE_URL]]`.*

## A.1 Who we are and the two roles we play

We operate a software service for real estate brokerages, teams and licensed agents (our "Subscribers"). We handle personal information in two different roles, and your rights depend on which one applies to you:

- **We are the business (or controller)** for information about Subscribers' users and prospective Subscribers — the people who sign up, sign in, pay and contact us — and for visitors to our own website. Sections A.2 through A.9 describe that processing.
- **We are a service provider (or processor)** for information that a Subscriber stores in the Service about its own clients, prospects, sphere and business relationships (its "Contacts" and "Leads"). We process that information only on the Subscriber's instructions under the data processing addendum in Part B. If you are a client or prospect of a brokerage that uses the Service, the brokerage is responsible for that information and its own privacy notice applies; you may send a request to us under §A.8 and we will route it to the brokerage and help fulfill it.

## A.2 Information we collect as the business

| Category | Examples | Source |
|---|---|---|
| Identifiers and account data | Name, email, phone, brokerage name, license identifiers, user type, office, team, profile photo | You, your brokerage, and the real estate license documents you upload |
| Commercial data | Subscription tier, billing cycle, payment status, invoices, seat counts, promotional codes | You and our payment processor (we do not store full card numbers) |
| Acceptance records | The version of the terms you accepted, when, and the network address and user agent of the accepting session | Recorded at sign-up and on re-acceptance |
| Usage and device data | Pages viewed, actions taken, feature usage, device and browser information, approximate location from network address | Collected automatically by the Service and our first-party analytics |
| Communications with us | Support tickets, emails, call notes, feedback | You |
| Voice and likeness assets | If you choose to create an AI voice clone or avatar of yourself for your own marketing, the voice sample and image you provide | You, by explicit choice |
| Prospect data | If you ask about the Service before subscribing: your name, contact details, brokerage, territory and the questions you asked | You |

## A.3 How we use it

We use the information in A.2 to provide, secure and support the Service; to create and manage your account and your brokerage's workspace; to bill and collect; to keep the acceptance records the law and our agreement require; to communicate with you about the Service, including billing notices, status notices, approval requests, incident notices and change logs; to detect, investigate and prevent fraud, abuse and security incidents; to comply with law; to improve the Service, including through de-identified and aggregated analysis where `[[CROSS_TENANT_AGGREGATE_USE]]` permits; and, with your choice, to produce your voice clone or avatar for your own use.

## A.4 Artificial intelligence

The Service uses artificial intelligence to draft, research, summarize, classify and recommend, and — within the authority a brokerage grants its AI managers — to carry out defined tasks. All inference runs through one platform AI gateway with per-tenant cost accounting; no Subscriber holds a model key. We do not use your information or a Subscriber's content to train general-purpose models. Prompts and outputs may be processed by the gateway and the model vendors named in Part C under `[[AI_VENDOR_RETENTION_TERMS]]`. Part D describes AI processing in detail, and Schedule 2 to the subscription agreement describes what an AI manager may and may not do.

## A.5 How we disclose information

We disclose personal information to: the **subprocessors** in Part C that host, store, transmit, analyze or deliver on our behalf; **Providers** a Subscriber connects from its own account, on the Subscriber's instruction; **payment processors**; **professional advisers**; **authorities** when required by law or to protect rights, safety or property; and a **successor** in a merger, acquisition or sale of assets, under this notice. We do not sell personal information and we do not share it for cross-context behavioral advertising.

## A.6 Cookies and analytics

`[[COOKIE_AND_ANALYTICS_DISCLOSURE]]`

> **Drafting note (not contract text).** The application mounts the hosting provider's first-party analytics (recorded in `docs/architecture/PRODUCTION-ARCHITECTURE.md` §15.1). Tenant websites may carry the Subscriber's own pixels and are the Subscriber's responsibility. Counsel confirms whether the platform's own site carries any third-party advertising tag before this section is finalized.

## A.7 Retention

We keep account and billing information for the life of your brokerage's subscription and for `[[POST_TERMINATION_RETENTION_DAYS]]` days after it ends so your brokerage can export its records, and longer where tax, accounting or legal obligations require. We keep acceptance records for as long as the agreement they evidence can be enforced. We keep operational logs for `[[LOG_RETENTION_DAYS]]` days. Part E describes retention for Subscriber content.

## A.8 Your rights and how to exercise them

Depending on where you live, you may have the right to know what personal information we hold about you, to access it or receive a copy, to correct it, to delete it, to opt out of sale or sharing, and not to be discriminated against for exercising a right. Residents of `[[STATE_LIST]]` have the rights their state's law provides.

You may submit a request at `[[PLATFORM_WEBSITE_URL]]/privacy/request` or by email to `[[PRIVACY_CONTACT_EMAIL]]`. We verify your identity before acting, record the method, and respond within `[[DSR_RESPONSE_DAYS]]` days, extending once with notice where the law allows. An authorized agent may submit a request with proof of authority. If your request concerns information a brokerage holds about you as its client or prospect, we will forward it to that brokerage and assist it; the brokerage decides and responds.

## A.9 Security, children, changes and contact

We protect personal information with the safeguards described in Part B §B.6, including encryption in transit, encryption of stored secrets, tenant isolation enforced in the database, verification of every inbound provider webhook, and audited staff access. The Service is for licensed professionals and is not directed to children under eighteen. We will post changes to this notice at `[[PLATFORM_WEBSITE_URL]]` with a new effective date and will notify account holders of material changes through the Service. Questions go to `[[DPO_OR_PRIVACY_OFFICER]]` at `[[PRIVACY_CONTACT_EMAIL]]` or `[[PLATFORM_NOTICE_ADDRESS]]`.

---

# Part B — Data Processing Addendum and Service-Provider Terms

*This Addendum forms part of the Platform Subscription and Services Agreement between `[[PLATFORM_LEGAL_ENTITY]]` ("Platform") and `[[SUBSCRIBER_LEGAL_ENTITY]]` ("Subscriber") and controls over the Agreement as to the processing of personal information (Packet 1 §24).*

## B.1 Definitions and roles

B.1.1 "**Personal Information**" means information that identifies, relates to, describes or could reasonably be linked with a particular natural person or household, and includes "personal data" under any applicable law. "**Process**" has the broadest meaning under applicable law. "**Applicable Data Protection Law**" means the privacy and data-security laws of the United States and its states that apply to a Party's processing, including the California Consumer Privacy Act as amended and the comprehensive privacy laws of `[[STATE_LIST]]`.

B.1.2 **Subscriber Personal Information** means Personal Information in Subscriber Content about Subscriber's Contacts, Leads, clients, vendors, partners and users that Platform processes to provide the Service. For Subscriber Personal Information, Subscriber is the business or controller and Platform is the service provider, contractor or processor.

B.1.3 **Platform Account Information** means Personal Information about Subscriber's users and signatories that Platform processes for its own account administration, billing, security and legal compliance. For Platform Account Information, Platform is the business or controller and Part A applies.

## B.2 Instructions and purpose limitation

B.2.1 Platform will process Subscriber Personal Information only (a) to provide the Service as described in the Agreement and the Schedules, including the AI Manager tasks and the Provider calls Subscriber enables; (b) on Subscriber's documented instructions given through the Service's settings, its administrators or in writing; (c) to comply with law, after notifying Subscriber where the law permits; and (d) as Applicable Data Protection Law otherwise permits a service provider to process, including to detect security incidents, protect against fraud and illegal activity, and build or improve the quality of the Service without using the information to build a profile of a person for another business.

B.2.2 Platform will not (a) sell or share Subscriber Personal Information; (b) retain, use or disclose it for any purpose other than the business purposes in the Agreement, including any commercial purpose other than those purposes; (c) retain, use or disclose it outside the direct business relationship between the Parties; or (d) combine it with Personal Information it receives from another business or collects from its own interaction with a person, except as Applicable Data Protection Law permits a service provider to combine it. Platform certifies that it understands these restrictions and will comply with them.

B.2.3 Platform will notify Subscriber if it determines it can no longer meet its obligations under Applicable Data Protection Law, and Subscriber may then take reasonable steps to stop and remediate unauthorized use.

## B.3 Details of processing

| Item | Description |
|---|---|
| Subject matter | Operation of a real estate business operating system for Subscriber. |
| Duration | The Subscription Term and the post-termination period in Part E. |
| Nature | Hosting, storage, retrieval, structuring, enrichment from Providers, analysis, drafting and classification by AI managers, transmission of communications, deletion. |
| Purposes | Those in B.2.1(a). |
| Data subjects | Subscriber's Contacts, Leads, clients, prospects, sphere members, vendors, lenders, referral partners, users and signatories. |
| Categories of Personal Information | Identifiers and contact details; property ownership and address information; transaction and financial information relevant to a real estate transaction (pre-approvals, proof of funds, closing figures); communications content and metadata; consent and preference records; demographic and household attributes obtained from Providers or supplied by the person (see Part D on sensitive and protected-class attributes); images, audio and video the Subscriber or person uploads; portal credentials; usage records. |
| Sensitive Personal Information | Government identifiers appear only in documents a person uploads for a transaction (for example, a driver's license image for identity verification) and are stored in private document buckets with signed access and logged reads; precise geolocation is not collected; financial account information appears in transaction documents; the Service does not collect health, biometric (other than a user's own voluntary voice sample for their own clone), sexual-orientation or religious information as data fields. |

## B.4 Subprocessors

B.4.1 Subscriber authorizes Platform to engage the subprocessors in Part C. Platform will give `[[SUBPROCESSOR_NOTICE_DAYS]]` days' notice through the Service's change log before a new subprocessor processes Subscriber Personal Information, and Subscriber may object in writing on reasonable data-protection grounds; if the Parties cannot resolve the objection, Subscriber may terminate the affected part of the Service under Packet 1 §15 with a pro-rata refund.

B.4.2 Platform will bind each subprocessor to written obligations no less protective than this Addendum and remains responsible for the subprocessor's performance.

B.4.3 A **Tenant-Connected Provider** (Schedule 6) is not Platform's subprocessor. It is a recipient Subscriber has chosen and contracted with directly; Platform transmits to it only what Subscriber's connection and instructions require.

## B.5 Confidentiality and personnel

Platform will ensure that personnel authorized to process Subscriber Personal Information are bound by confidentiality, receive appropriate training, and access Subscriber's Tenant only through the audited staff access described in Packet 1 §3.5.

## B.6 Security measures

Platform maintains, and will not materially reduce during the Term, the following measures:

| Measure | Implementation at this commit |
|---|---|
| Tenant isolation in the database | Row-level security enabled on every table in the public schema (live census: all tables, none without), with a database event trigger that enables it on every new table; policies scoped by the session's brokerage; the privileged service role used only after an application gate (`lib/auth/require-caller.ts::requireCallerTenant`). |
| Tenant from the session | The Tenant is resolved from the authenticated session, never from a request body or parameter. |
| Encryption in transit | HTTPS for every connection; webhooks verified per the inbound contract (`lib/providers/webhook-contract.ts::WEBHOOK_CONTRACT`). |
| Encryption of secrets at rest | Stored credentials and secrets are sealed with authenticated encryption under a required key; a missing key refuses new secret writes rather than storing plaintext (`lib/security/secret-crypto.ts::encryptSecret`); rotation is monitored (`lib/security/credential-rotation.ts::loadRotationRisks`). |
| Document storage | Documents live in private buckets served only by time-limited signed URLs; each governed read is logged with who, when and why (`lib/kernel/document-custody.ts::issueGovernedDocumentUrl`); marketing media intended for public display lives in public buckets by deliberate classification (`lib/storage/document-buckets.ts::PUBLIC_MEDIA_BUCKETS`). |
| Public write endpoints | Session-gated, rate-limited or classified with a reason (`lib/security/public-rate-limit.ts::checkPublicRateLimit`). |
| Credential-free exports | Every export scans for and excludes credential-shaped values (`lib/security/export-credential-scan.ts`). |
| Staff access | Impersonation sessions are mode-limited, time-limited and stamped with the real staff actor (`lib/platform/impersonation.ts::IMPERSONATION_TTL_MINUTES`). |
| Fail-closed gates | A gate that cannot read its inputs refuses: billing access, suppression, TCPA, seat limits, healing policy. |
| Error and operations telemetry | Errors are collected centrally for operations and never include credential values (`lib/errors/collect-error.ts::collectError`). |
| Hosting | Serverless application hosting and a managed Postgres, authentication and object-storage platform in `[[HOSTING_REGION]]`, with managed backups retained `[[BACKUP_RETENTION_DAYS]]` days. |

## B.7 Assistance with data-subject requests and compliance

Platform will (a) route any request it receives about Subscriber Personal Information to Subscriber within five business days; (b) provide the Service's privacy-request queue, export and de-identification tools for Subscriber to fulfill requests (Part H); (c) assist with data-protection assessments and regulator inquiries to the extent Subscriber cannot obtain the information itself from the Service; and (d) provide the Tenant-scoped evidence ledgers in Packet 1 §12.5 on reasonable request. Platform may charge a reasonable fee for assistance beyond the Service's own tools.

## B.8 Security incidents

Platform will notify Subscriber without undue delay and within `[[INCIDENT_NOTICE_HOURS]]` hours of confirming a Security Incident — unauthorized access to, or acquisition, disclosure, alteration or destruction of, Subscriber Personal Information — with the information in Part G, and will cooperate with Subscriber's notifications to persons and authorities. An unsuccessful attempt that does not compromise Subscriber Personal Information is not a Security Incident.

## B.9 Audit

Platform will make available the information reasonably necessary to demonstrate compliance with this Addendum, including the published architecture and security documentation, the results of the Service's own compliance proofs, and `[[AUDIT_RIGHTS_SCOPE]]`. Audits are limited to once a year except after a Security Incident or at a regulator's direction, are conducted on reasonable notice during business hours, and do not extend to another Tenant's data or Platform's trade secrets.

## B.10 Return and deletion

On termination, Platform will make Subscriber Personal Information available for export for `[[POST_TERMINATION_RETENTION_DAYS]]` days and will then delete or de-identify it as Part E describes, except for the retention Part E permits. Platform will `[[DELETION_CERTIFICATION]]`.

## B.11 Cross-border transfers

The Service is hosted in `[[HOSTING_REGION]]` and is offered for use in the United States. Subscriber will not instruct processing of personal information of persons outside the United States without first agreeing with Platform the transfer mechanism applicable law requires.

## B.12 Liability

Each Party's liability under this Addendum is subject to Packet 1 §18, including the higher cap for data-protection breaches where one is agreed.

---

# Part C — Subprocessors and other recipients

## C.1 Subprocessors

The entities below process Subscriber Personal Information on Platform's behalf. Each row's **Registry key** is the name under which the code's own provider registries declare the vendor; the build proof refuses a row whose key appears in no registry, so this list cannot name a vendor the code does not use. Only vendors the Service calls live are listed as subprocessors; a dormant Provider with no transport is listed in C.3 for transparency and processes nothing.

| Vendor | Registry key | Service and role | Data it may receive | Ownership model |
|---|---|---|---|---|
| Vercel, Inc. | `vercel` | Application hosting, edge middleware, serverless functions, scheduled dispatch, first-party analytics, background workflows. | All data in transit through the application. | Platform-owned infrastructure. |
| Supabase, Inc. | `supabase_storage` | Managed Postgres database, authentication, object storage for documents and media. | All stored Subscriber Content and account data. | Platform-owned infrastructure. |
| Vercel AI Gateway | `ai_gateway` | The single gateway through which every model call runs, with per-tenant cost accounting and the platform halt. | Prompts and outputs for the AI tasks Subscriber enables. | Platform-owned; Subscribers hold no model keys. |
| Anthropic, PBC | `anthropic` | Model vendor reachable through the gateway. | Prompts and outputs routed to its models. | Platform-owned via the gateway. |
| Google LLC (AI) | `google_ai` | Model vendor reachable through the gateway. | Prompts and outputs routed to its models. | Platform-owned via the gateway. |
| Twilio Inc. | `twilio` | Phone numbers, SMS and MMS, voice, carrier registration, conversational voice; one platform account with an isolated child account per Tenant. | Phone numbers, message content, call audio and transcripts, caller identity. | Platform master account with Tenant subaccounts; bring-your-own on the Multi-Location Tier. |
| SendGrid (Twilio) | `sendgrid` | Transactional email fallback where a user's own mailbox is not connected. | Recipient addresses, message content, delivery events. | Platform-owned fallback. |
| Lob.com, Inc. | `lob` | Direct-mail printing and mailing, address verification. | Recipient names and mailing addresses, piece artwork. | Platform-owned; system-only channel. |
| ElevenLabs Inc. | `elevenlabs` | Text-to-speech and per-agent voice clones. | Script text; a user's own voice sample by their explicit choice. | Platform-owned. |
| D-ID | `did` | Avatar video generation. | Script text; a user's own image by their explicit choice. | Platform-owned. |
| Simli | `simli` | Backup live face rendering. | Streamed audio and a user's own image by their choice. | Platform-owned. |
| RentCast | `rentcast` | Property facts, automated valuation, market data. | Property addresses; no person identifiers are required by the capability. | Platform-owned; never a Tenant key. |
| Versium | `versium` | Contact, demographic and property append; business identity; online-presence indicators; audience estimates; online-audience match. | Name, address, email, phone and property identifiers sent for matching. | Platform-owned under an existing contract. |
| Exa | `exa` | Neural search for buyer-intent and pre-listing discovery and research. | Search queries describing situations and territories; results are public text. | Platform-owned. |
| Tavily | `tavily` | Research harvesting for the platform's own marketing. | Topic queries. | Platform-owned. |
| Apify | `apify` | Scraper actors for direct-site source families. | Public listing and classified text in territory. | Platform-owned. |
| ZenRows | `zenrows` | Anti-bot page rendering for hard targets. | Public page content. | Platform-owned. |
| Zyte | `zyte` | Backup scraper lane. | Public page content. | Platform-owned. |
| Mapbox | `mapbox` | Static maps, tiles, travel-time matrix. | Coordinates. | Platform-owned. |
| Google LLC (Maps) | `google_maps` | Fallback static maps. | Coordinates. | Platform-owned. |
| Stripe, Inc. | `stripe` | Subscription billing, setup fees, overage, tax; Connect platform for payouts. | Billing contact, payment method tokens, invoices. | Platform account for amounts owed to Platform; a Tenant's own account for its own collections (Schedule 6). |
| Intuit Inc. (QuickBooks) | `quickbooks` | The platform's own books. | Platform revenue and expense records; a Tenant's own file only under its own connection (Schedule 6). | Platform-owned for the platform's books. |
| Pexels | `pexels` | Stock media search fallback. | Search queries. | Platform fallback; a Tenant may use its own key. |

## C.2 Tenant-connected recipients (not subprocessors)

These vendors receive data only when `[[SUBSCRIBER_LEGAL_ENTITY]]` connects its own account under Schedule 6 and only what that connection requires. Subscriber contracts with and pays each directly.

| Vendor | Registry key | Domain |
|---|---|---|
| IDX Broker | `idxbroker` | The Tenant's own MLS listing feed. |
| Google (Gmail and Calendar) | `gmail` | The user's own mailbox and calendar. |
| Microsoft (Outlook) | `outlook` | The user's own mailbox and calendar. |
| Telnyx | `telnyx` | Tenant phone carrier (bring-your-own). |
| Bandwidth | `bandwidth` | Tenant phone carrier (bring-your-own). |
| Meta (Facebook and Instagram) | `meta` | Social publishing and direct-message inbox. |
| LinkedIn | `linkedin` | Social publishing. |
| X | `twitter` | Social publishing. |
| TikTok | `tiktok` | Social publishing. |
| YouTube | `youtube` | Social publishing and live broadcast. |
| Pinterest | `pinterest` | Social publishing. |
| Google Business Profile | `google_business` | Business listing posts. |
| GoHighLevel | `gohighlevel` | CRM synchronization, outbound only. |
| Follow Up Boss | `followupboss` | CRM synchronization, outbound only. |
| Lofty | `lofty` | CRM synchronization, outbound only. |
| HubSpot | `hubspot` | CRM synchronization, outbound only. |
| Dotloop | `dotloop` | E-signature and transaction forms. |
| DocuSign | `docusign` | E-signature and transaction forms. |
| SkySlope | `skyslope` | E-signature and transaction forms. |
| Authentisign | `authentisign` | E-signature and transaction forms. |
| Form Simplicity | `formsimplicity` | E-signature and transaction forms. |
| Brokermint | `brokermint` | Transaction forms and back office. |
| ShowingTime | `showingtime` | Showing scheduling. |
| Transistor | `transistor` | Podcast distribution. |
| Zoom | `zoom` | Virtual events and meetings. |

## C.3 Dormant Providers (no data flows)

| Vendor | Registry key | State |
|---|---|---|
| BatchData | `batchdata` | Dormant survivor; live doors await owner confirmation. |
| PeopleData Labs | `peopledata` | Dormant survivor; live doors await owner confirmation. |
| Tracerfy | `tracerfy` | Dormant pending rights; no transport, no credential. |
| DataZapp | `datazapp` | Dormant pending rights; no transport, no credential. |
| PropertyRadar | `propertyradar` | Dormant pending rights; no transport. |
| Data Axle | `data_axle` | Dormant pending rights; no product chosen. |

## C.4 Public data sources (no personal information sent)

| Source | Registry key | Use |
|---|---|---|
| Socrata open-data portals | `socrata` | Permit and market records by place; attach-only facts. |
| ArcGIS public portals | `arcgis` | Permit records by place; attach-only facts. |

> **Drafting note (not contract text).** The lists above are derived from the code's registries: the tenancy matrix (`lib/providers/tenancy-matrix.ts::PROVIDER_TENANCY`), the connector registry (`lib/agentic-os/connector-registry.ts::CONNECTOR_REGISTRY`), the capability route table and activation state (`lib/ai-isa/property-lookup-rail.ts::CONTACT_PROVIDER_ROUTES`, `lib/ai-isa/property-lookup-rail.ts::PROVIDER_ACTIVATION`), the connection scope (`lib/connections/scope.ts::CONNECTOR_PROVIDERS`), the provider catalog (`lib/integrations/providers/catalog.ts`) and the inbound webhook contract (`lib/providers/webhook-contract.ts::WEBHOOK_CONTRACT`). Blind spots, published beside the list: a geocoding or address-verification helper that lives in `lib/external` without a registry row (for example a free geocoder) is not on this list because the registries do not declare it; counsel should ask engineering to add registry rows for any such helper that receives a person's address. Legal entity names for the vendors are the names in common use and must be confirmed against each vendor's current contracting entity.

---

# Part D — AI processing annex

D.1 **One gateway.** Every model call — text generation, extraction, classification, vision on uploaded documents, image generation and transcription — leaves through the platform AI gateway. Subscribers never hold model keys; a bare vendor key cannot reach a model. The gateway's token usage for each call is booked on the AI usage ledger (`lib/ai/cost-tracking.ts::logAIUsage`), which is the invoice; when the gateway reports no count the caller estimates and says so.

D.2 **What is sent.** The content of the task: the Contact's record fields the task needs, the conversation, the document being read, the brand voice settings, the territory and market facts. The Service does not send more of a record than the task requires and sends no credentials.

D.3 **What is not done.** Platform does not use Subscriber Content to train or fine-tune general-purpose models. Platform does not permit a model to write to the database or call a Provider directly; a model proposes, and domain services enforce. Retention of prompts and outputs by the gateway and model vendors is governed by `[[AI_VENDOR_RETENTION_TERMS]]`.

D.4 **Protected-class and demographic attributes.** The Service may hold demographic attributes a Provider supplies or a person states (age band, household composition, length of residence, estimated income band) because holding and using them to choose helpful content and a suitable channel is lawful; the Service labels which fields are protected-class rather than deleting them. The one act that is refused is defining or populating a housing-advertising audience by a protected class (`lib/lead-governance/protected-class-signals.ts::assertAudienceSegmentationAllowed`). A situation persona (a senior, a military family, a probate heir, a divorcing owner) may be used to choose the wording that fits the person's situation; a raw demographic criterion is never sent to an advertising platform as a targeting rule. Schedule 5 §4 states the rule for Subscribers.

D.5 **Sensitive inferences.** Signals about a sensitive life circumstance are stored with their evidence class and uncertainty and never trigger automatic outreach on their own (Schedule 2 §6.4).

D.6 **Output review.** AI output that reaches a person outside the Service passes the gates in Schedule 2 §5; output that would obligate money, sign or file never leaves a draft.

D.7 **Transparency to persons.** Where `[[STATE_LIST]]` law requires disclosure that a person is interacting with an automated system or receiving AI-generated content, the Subscriber enables the disclosure the Service offers for the channel (Schedule 2 §5.6).

---

# Part E — Retention and deletion schedule

| Data | Retention while subscribed | After termination | Deletion mechanism |
|---|---|---|---|
| Contacts, Leads, communications, listings, transactions, offers, documents, campaigns, assets | Life of the subscription. | Available for export for `[[POST_TERMINATION_RETENTION_DAYS]]` days, then deleted or de-identified, except as below. | Table-by-table through the Service's deletion and de-identification paths; recorded. |
| Transaction records the Subscriber must keep by law | Life of the subscription; the Service flags documents past their category default for review and never auto-deletes (`lib/kernel/document-custody.ts::RETENTION_DEFAULTS`, `lib/kernel/document-custody.ts::runRetentionScan`). | Retained in restricted form for `[[DATA_RETENTION_YEARS_TRANSACTION]]` years or exported to the Subscriber and then deleted, at the Subscriber's election. | Review-gated. |
| Consent, suppression and compliance records | Life of the subscription. | Retained: an opt-out must outlive the relationship to be honored; consent evidence must outlive the message it permitted. | Not deleted; de-identified where the person requests erasure, keeping the suppression key. |
| Action ledger, policy versions, audit and access logs | Life of the subscription. | Retained as Platform's record of its own operations, Tenant-scoped. | Not deleted by Subscriber request; subject to Platform's retention policy. |
| Raw acquired records that never became a Lead | `[[SOURCE_RECORD_RETENTION_DAYS]]` days. | Deleted. | Scheduled deletion. |
| Operational logs (errors, API response logs) | `[[LOG_RETENTION_DAYS]]` days. | Same. | Scheduled deletion. |
| Backups | Managed backup, `[[BACKUP_RETENTION_DAYS]]` days. | Expire on schedule. | Hosting provider's backup rotation. |
| A person's record after a verified deletion request | De-identified at once: personal fields replaced with irreversible markers, transaction linkage preserved (`lib/privacy/contact-pii-redaction.ts::contactRedactionPatch`). | Same. | The privacy-request queue. |
| Platform account and billing information | Life of the subscription. | `[[POST_TERMINATION_RETENTION_DAYS]]` days, then deleted except as tax and accounting law requires. | Platform's account deletion. |
| Acceptance records | Life of the subscription and as long as the agreement can be enforced. | Retained. | Not deleted. |

> **Drafting note (not contract text).** The constitution records data retention classes per table as **not yet enforced anywhere** (`docs/architecture/OS-CONSTITUTION.md`). What exists: the document-category defaults and the review-only retention scan; the DSAR de-identification; the tenant export; and the fail-safe that nothing auto-deletes. What does not exist: a scheduled deletion of raw records or logs, a post-termination deletion job, or a deletion certificate. Three variables above (`[[SOURCE_RECORD_RETENTION_DAYS]]`, `[[LOG_RETENTION_DAYS]]`, `[[BACKUP_RETENTION_DAYS]]`) are genuine gaps and the schedule must not be published with a promise the code cannot keep. The review packet lists the engineering work each would require.

---

# Part F — Cross-tenant isolation statement

F.1 Every Subscriber's data lives in one shared database and one shared object store, isolated by the following, each of which is enforced in code or in the database and proven by a build-time check:

- Row-level security on every table in the public schema; a database event trigger enables it on every new table (live census recorded in `docs/architecture/PRODUCTION-ARCHITECTURE.md` §5).
- The Tenant is read from the authenticated session, never from a request body, and the privileged role is used only after that gate (`lib/auth/require-caller.ts::requireCallerTenant`).
- Offices and teams within a Multi-Location Tenant are explicit memberships with their own scoped reads; a team sees only its own board.
- Document buckets are private and read only through signed, logged URLs; a bucket nobody has classified is treated as private (`lib/storage/document-buckets.ts::DOCUMENT_CLASS_BUCKETS`).
- A Tenant-Connected Provider's credential is resolved by its owner (agent, team, brokerage) and never falls back to another Tenant's or to the platform's (`lib/connections/resolve-scoped.ts::resolveScopedConnection`).
- Platform-pooled acquisition records carry no Tenant until an owner is resolved, and a suppressed person is distributed to no Tenant.
- Support queues, exports and privacy-request queues are Tenant-scoped.
- Platform staff reach a Tenant only through the audited impersonation session in Packet 1 §3.5.

F.2 Aggregated, de-identified operational telemetry (how often a feature is used, how long a workflow takes, how a Provider performs) is used across Tenants only as `[[CROSS_TENANT_AGGREGATE_USE]]` permits and never in a form that identifies a Subscriber's Contact.

---

# Part G — Security incident handling

G.1 **Detection.** The Service collects errors centrally, watches provider health, webhook failures, cron health and anomalies through its operating-system health supervisor (`lib/kernel/os-health.ts::runOsHealthSupervisor`), monitors credential rotation, and raises a platform incident when secret storage is unconfigured. Anything that crosses a Tenant boundary or looks like a security breach is classified forbidden for automatic action and routed to a person (`lib/kernel/self-healing.ts::classifyForbidden`).

G.2 **Response.** On a suspected Security Incident Platform will: contain it (revoke or rotate affected credentials, halt affected automation with the platform or Tenant halt, suspend affected access); investigate scope using the access logs, action ledger and provider logs; preserve evidence; and remediate the cause.

G.3 **Notice to Subscriber.** Within `[[INCIDENT_NOTICE_HOURS]]` hours of confirming a Security Incident affecting Subscriber Personal Information, Platform will notify Subscriber's recorded administrators and `[[SUBSCRIBER_LEGAL_ENTITY]]`'s notice address with: the nature of the incident; the categories and approximate number of persons and records affected; the likely consequences; the measures taken and proposed; a contact point; and the information Subscriber needs for its own notifications. Platform will supplement the notice as the investigation proceeds.

G.4 **Reporting a vulnerability.** Anyone may report a vulnerability to `[[SECURITY_CONTACT_EMAIL]]`. Platform will acknowledge the report and will not pursue a good-faith researcher who respects the Acceptable Use Policy.

> **Drafting note (not contract text).** No automated breach-notification workflow exists in the code; detection, halting and evidence rails exist, and the notification is a manual procedure the owner must staff. `[[INCIDENT_NOTICE_HOURS]]` should be set with that in mind, and state breach-notification deadlines (which run from discovery and differ by state) belong on the state checklist in the review packet.

---

# Part H — Consumer requests and export

H.1 **Where requests arrive.** The public privacy-request page (`app/privacy/request/page.tsx`) accepts access, export, portability, correction, deletion, opt-out-of-sale and opt-out-of-sharing requests from anyone without an account (`app/actions/privacy/data-subject-requests.ts::submitDataSubjectRequestAction`); the Service matches the email to a user or Contact where it can and records the Tenant when the requester names one. Email requests to `[[PRIVACY_CONTACT_EMAIL]]` are entered into the same queue by Platform staff.

H.2 **The queue.** Requests appear in the Tenant's privacy-requests queue with a due date of `[[DSR_RESPONSE_DAYS]]` days from receipt, overdue and due-soon indicators, and the identity-verification state (`app/dashboard/admin/privacy/requests/page.tsx`). Brokers, broker administrators, administrators and compliance officers of the Tenant may verify, fulfill or deny; the role set is fixed in code and a request is never fulfilled before verification.

H.3 **Export of a person's data.** The export bundles the person's records from the Tenant's tables and excludes any column whose name indicates authentication material, so a bundle never carries a credential (`app/actions/privacy/data-subject-requests.ts::fulfillExportRequestAction`).

H.4 **Deletion of a person's data.** De-identification replaces the person's names, email, phone, notes, addresses, demographic and financial bands, enrichment blobs, social links and external identifiers with irreversible markers while keeping the record's identity key, Tenant, transaction linkage and privacy-anonymization stamp (`lib/privacy/contact-pii-redaction.ts::contactRedactionPatch`). The suppression key survives so the person is not re-contacted.

H.5 **Export of a Subscriber's data.** Separately from a person's request, Subscriber may obtain its tenant export under Packet 1 §9.4 (`lib/platform/tenant-export.ts::buildTenantExport`): the core business tables, each capped per export with pagination offered, with counts and the list of capped tables stated in the bundle and credential-shaped values excluded. The bundle is available for `[[EXPORT_WINDOW_DAYS]]` days.

H.6 **No discrimination.** Neither Platform nor Subscriber will deny service, charge a different price or provide a different level of service to a person because they exercised a privacy right, except as the law permits.
