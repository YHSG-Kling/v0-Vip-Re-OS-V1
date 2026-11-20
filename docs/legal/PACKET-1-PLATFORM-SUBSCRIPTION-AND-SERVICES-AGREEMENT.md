> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Packet 1 — Platform Subscription and Services Agreement

Version: 0.1.0-draft (2026-11-09) · Document ID: VIP-LEGAL-P1 · Wave 151, lane 151A2 · Written against commit `b2c93720`

## Variables

Every bracketed variable below is a decision the owner or counsel must make before this document can be published. A variable's status is OPEN until the review packet's decision table records the answer.

| Variable | Meaning | Status |
|---|---|---|
| `[[PLATFORM_LEGAL_ENTITY]]` | The full legal name of the entity that owns and operates the platform and is the contracting party. The code carries only a product brand (`platform_settings.product_brand`); the legal entity has never been recorded. | OPEN |
| `[[PLATFORM_ENTITY_TYPE_AND_STATE]]` | Entity type and state of organization (for example, "a Delaware limited liability company"). | OPEN |
| `[[PLATFORM_PRODUCT_BRAND]]` | The product name shown to users (today read from `platform_settings.product_brand`, defaulting to the brand kit). | OPEN |
| `[[PLATFORM_WEBSITE_URL]]` | The canonical public website where the current terms are published. | OPEN |
| `[[PLATFORM_NOTICE_ADDRESS]]` | Postal address for legal notices to the platform. | OPEN |
| `[[PLATFORM_NOTICE_EMAIL]]` | Email address for legal notices to the platform. | OPEN |
| `[[PLATFORM_AUTHORIZED_SIGNATORY]]` | Name and title of the officer who may sign for the platform. | OPEN |
| `[[SUBSCRIBER_LEGAL_ENTITY]]` | The subscribing brokerage, team entity or individual licensee, as entered at acceptance. | PER-SUBSCRIBER |
| `[[SUBSCRIBER_AUTHORIZED_SIGNATORY]]` | The natural person who accepts for the subscriber and who must hold authority to bind it. | PER-SUBSCRIBER |
| `[[SUBSCRIBER_BROKER_OF_RECORD]]` | The licensed broker responsible for the subscriber's real estate activity. | PER-SUBSCRIBER |
| `[[SUBSCRIBER_NOTICE_ADDRESS]]` | Postal and email address for notices to the subscriber. | PER-SUBSCRIBER |
| `[[EFFECTIVE_DATE]]` | The date the subscriber's authorized signatory accepts. | PER-SUBSCRIBER |
| `[[AGREEMENT_VERSION]]` | The published version identifier of this agreement (the value held in `platform_settings.tos_version`). | OPEN |
| `[[AGREEMENT_HASH]]` | The content hash of the published text, recorded on the acceptance record once the acceptance wiring ships. | OPEN |
| `[[GOVERNING_LAW]]` | The state whose law governs. | OPEN |
| `[[VENUE]]` | The county and state of exclusive venue for court proceedings. | OPEN |
| `[[DISPUTE_FORUM]]` | Binding arbitration, courts, or arbitration with a small-claims carve-out. | OPEN |
| `[[ARBITRATION_PROVIDER]]` | The arbitration administrator and rules, if arbitration is chosen. | OPEN |
| `[[DISPUTE_INFORMAL_PERIOD_DAYS]]` | Days of good-faith negotiation required before a formal proceeding. | OPEN |
| `[[CLASS_WAIVER]]` | Whether a class-action and representative-action waiver is included. | OPEN |
| `[[SLA]]` | The monthly uptime commitment, if any. | OPEN |
| `[[SLA_CREDIT_SCHEDULE]]` | Service credits by uptime band, if an SLA is offered. | OPEN |
| `[[SUPPORT_HOURS]]` | Support availability window and time zone. | OPEN |
| `[[SUPPORT_RESPONSE_TARGETS]]` | Target first-response times by severity. | OPEN |
| `[[LIABILITY_CAP]]` | The general cap on each party's aggregate liability. | OPEN |
| `[[SUPER_CAP]]` | The higher cap for data-protection and confidentiality breaches, if one is offered. | OPEN |
| `[[INDEMNITY_CAP]]` | Whether indemnities are capped, and at what. | OPEN |
| `[[INITIAL_TERM]]` | The initial subscription term (monthly or annual, matching the chosen billing cycle). | OPEN |
| `[[RENEWAL_TERM]]` | The length of each automatic renewal. | OPEN |
| `[[NON_RENEWAL_NOTICE_DAYS]]` | Days before a renewal by which non-renewal must be given. | OPEN |
| `[[TERMINATION_FOR_CAUSE_CURE_DAYS]]` | The cure period for a material breach. | OPEN |
| `[[PAYMENT_DUE_DAYS]]` | Days after invoice by which payment is due where invoicing (rather than card-on-file) applies. | OPEN |
| `[[LATE_FEE_RATE]]` | Interest on late amounts, if any. | OPEN |
| `[[TRIAL_LENGTH_DAYS]]` | The trial length offered on the trial funnel. | OPEN |
| `[[PAST_DUE_GRACE_DAYS]]` | The grace period before access is restricted after a failed payment (the code constant `lib/billing/past-due-clock.ts::PAST_DUE_GRACE_DAYS` is the implemented value; counsel confirms it is the contractual one). | OPEN |
| `[[POST_TERMINATION_RETENTION_DAYS]]` | How long after termination the platform keeps the subscriber's content available for export before deletion begins. | OPEN |
| `[[EXPORT_WINDOW_DAYS]]` | How long after a request the export bundle stays downloadable. | OPEN |
| `[[DATA_RETENTION_YEARS_TRANSACTION]]` | The retention period for transaction records the subscriber must keep by law (the code's defaults are five and seven years by document category). | OPEN |
| `[[CONFIDENTIALITY_TERM_YEARS]]` | How long confidentiality obligations survive. | OPEN |
| `[[INSURANCE_REQUIREMENTS]]` | Insurance each party must carry, if any. | OPEN |
| `[[PUBLICITY_CONSENT]]` | Whether the platform may name the subscriber as a customer. | OPEN |
| `[[CROSS_TENANT_AGGREGATE_USE]]` | Whether and how the platform may use de-identified, aggregated usage data across tenants to improve the service. | OPEN |
| `[[AI_VENDOR_RETENTION_TERMS]]` | The prompt and output retention terms of the AI gateway and the model vendors behind it, as confirmed by counsel (Schedule 4 §7 and Part D). | OPEN |
| `[[INCIDENT_NOTICE_HOURS]]` | Hours within which the platform notifies the subscriber of a confirmed security incident affecting Subscriber Content (§12.6). | OPEN |
| `[[PRICE_SOLO_MONTHLY]]` | Monthly subscription fee for the Solo tier. | OPEN — NEVER WRITTEN IN CODE OR DOCUMENTS |
| `[[PRICE_TEAM_MONTHLY]]` | Monthly subscription fee for the Team tier. | OPEN |
| `[[PRICE_BROKERAGE_MONTHLY]]` | Monthly subscription fee for the Brokerage tier. | OPEN |
| `[[PRICE_MULTI_LOCATION]]` | Custom pricing for the Multi-Location tier. | OPEN |
| `[[PRICE_ANNUAL_DISCOUNT]]` | The annual-cycle price or discount per tier, if offered. | OPEN |
| `[[PRICE_SETUP_FEE]]` | The one-time setup fee charged on the first invoice. | OPEN |
| `[[PRICE_SEAT_PACKAGE]]` | The price and size of an additional seat package per tier. | OPEN |
| `[[PRICE_AI_OVERAGE_PER_UNIT]]` | The AI usage overage rate per unit above the tier's included allowance. | OPEN |
| `[[PRICE_VIDEO_OVERAGE_PER_UNIT]]` | The video-minutes overage rate per unit above the tier's included allowance. | OPEN |

---

## Preamble

This Platform Subscription and Services Agreement (the "**Agreement**") is entered into as of the `[[EFFECTIVE_DATE]]` between `[[PLATFORM_LEGAL_ENTITY]]`, `[[PLATFORM_ENTITY_TYPE_AND_STATE]]` ("**Platform**", "**we**", "**us**"), and the subscriber identified at acceptance, `[[SUBSCRIBER_LEGAL_ENTITY]]` ("**Subscriber**", "**you**"). Platform and Subscriber are each a "**Party**" and together the "**Parties**".

Platform operates `[[PLATFORM_PRODUCT_BRAND]]`, a software-as-a-service operating system for real estate brokerages, teams and licensed agents that combines a customer-relationship, transaction and marketing system with governed artificial-intelligence managers that research, draft, coordinate and — within the authority Subscriber grants and the gates described in Schedule 2 — execute defined tasks (the "**Service**").

Subscriber is a licensed real estate brokerage, a team operating under a licensed brokerage, or an individually licensed real estate professional, and wishes to subscribe to the Service for its own business.

> **Drafting note (not contract text).** The code has no record of the platform's legal entity. The copyright notice at `app/legal/page.tsx` renders `platform_settings.product_brand` as the rights holder for exactly this reason (`lib/branding/platform-rights-notice.ts::platformRightsNotice`). `[[PLATFORM_LEGAL_ENTITY]]` must be answered before any of these documents can be published, and the rights notice should then be updated to name the entity rather than the brand.

## 1. Definitions

1.1 "**Affiliate**" means an entity that controls, is controlled by, or is under common control with a Party, where control means ownership of more than fifty percent of the voting interests.

1.2 "**AI Manager**" means one of the governed autonomous software agents listed in the manager registry (`lib/kernel/manager-registry.ts::MANAGERS`) — including the Deal Coordinator, Shopping Agent, Listing Concierge, Sphere Manager, Campaign Orchestrator, Asset Manager, Ads Manager, AI ISA, Data Steward, Recruiting Manager, Compliance Officer, Finance Manager and Cron Manager — that performs tasks within the Service under the authority described in Schedule 2.

1.3 "**Authorized User**" means an individual whom Subscriber has invited to the Service under a user type the Service admits for Subscriber's tier, including licensed agents, team leads, brokers, broker owners, broker administrators, transaction coordinators, compliance officers and administrators, and the vendor and contact portal users Subscriber invites.

1.4 "**Contact**" means a natural person whose personal information Subscriber holds in the Service as a prospective, current or past client, sphere member, or other business relationship. A "**Lead**" is a person-level record that has entered the Service through acquisition or inbound channels and has not yet been converted to a Contact; Leads belong to the brokerage, not to an individual agent, as described in §6.5.

1.5 "**Documentation**" means the in-product help, the published guides and the schedules to this Agreement, as updated from time to time.

1.6 "**Fees**" means the subscription fees, setup fee, seat-package fees and usage-based fees described in §5 and the Order.

1.7 "**Order**" means the tier, billing cycle, seat count, add-ons and any custom terms Subscriber selects at checkout or that Platform and Subscriber agree in a written order form, as recorded against Subscriber's subscription in the Service.

1.8 "**Platform Data**" means the Service's software, interface, templates, prompts, workflows, model routing, scorecards, registries, aggregate and de-identified operational telemetry, and every other asset Platform owns or licenses, excluding Subscriber Content.

1.9 "**Provider**" means a third-party service the Service calls or connects to. A "**Platform-Owned Provider**" is one Platform contracts with and pays for and meters to Subscriber under its subscription; a "**Tenant-Connected Provider**" is one Subscriber contracts with directly and connects to the Service under Schedule 6. Schedule 3 lists the models the Service uses for each.

1.10 "**Schedules**" means Schedule 2 (Autonomous AI Operations and Authority), Schedule 3 (Acquisition, Enrichment, Data Rights and Third-Party Integration), Schedule 4 (Privacy Notice, Data Processing Addendum and Subprocessors), Schedule 5 (Acceptable Use and Marketing Compliance) and Schedule 6 (Tenant-Owned Provider Connection), each incorporated by reference.

1.11 "**Seat**" means a licensed producing user position counted against Subscriber's tier, as defined in §4.3.

1.12 "**Subscriber Content**" means all data, documents, images, recordings, listings, brand assets, communications, Contact and Lead records, and other materials that Subscriber or its Authorized Users or Contacts submit to or generate in the Service, together with the outputs the Service generates for Subscriber from them, excluding Platform Data.

1.13 "**Subscription Term**" means the Initial Term and each Renewal Term under §14.

1.14 "**Tenant**" means Subscriber's isolated workspace in the Service, identified by its brokerage record and bounded by row-level security as described in §12.3.

1.15 "**Tier**" means one of the Service's subscription plans: Solo, Team, Brokerage or Multi-Location (`lib/kernel/tier-role-matrix.ts::TIER_LABELS`).

## 2. The Service

2.1 **Provision.** Subject to this Agreement, Platform will make the Service available to Subscriber and its Authorized Users during the Subscription Term in the Tier and configuration recorded in the Order.

2.2 **What the Service is.** The Service is a software tool operated for the use of licensed real estate professionals. It is not a real estate brokerage, a licensed agent, an appraiser, a lender, a title agent, a law firm or an accountant, and it does not perform any of those regulated functions. Every real estate activity conducted through the Service is conducted by Subscriber under Subscriber's own license, supervision and responsibility.

2.3 **Changes to the Service.** Platform may modify the Service, including by adding, changing or removing features, AI Managers, Providers or model routing, provided the modification does not materially reduce the core functionality of Subscriber's Tier during a paid term without Subscriber's consent. Platform publishes material changes through the Service's change log (`lib/platform/changelog.ts`) and status notice (`lib/platform/status-notice.ts`).

2.4 **Trial.** Where Subscriber starts on a trial, the trial lasts `[[TRIAL_LENGTH_DAYS]]` days from the date recorded on Subscriber's subscription (`subscriptions.trial_end`), during which the Service is provided without charge and this Agreement applies in full. The trial converts to a paid subscription only when Subscriber completes checkout under §5.2; a trial that reaches its end date without checkout is treated as expired and access is routed to the billing page (`lib/billing/billing-access.ts::mayUseAndAfford`).

2.5 **Beta and preview features.** Features marked in the Service as beta, preview, pilot, dormant or not yet activated are provided as-is, may be withdrawn at any time, and carry no commitment. A Provider the Service lists as dormant makes no live calls and produces no data until Platform activates it under Schedule 3 §4.

## 3. Account, Authorized Users and Access

3.1 **Account creation.** Subscriber's account is created when `[[SUBSCRIBER_AUTHORIZED_SIGNATORY]]` completes the sign-up flow and accepts this Agreement under §25. The signatory represents that they are authorized to bind `[[SUBSCRIBER_LEGAL_ENTITY]]`.

3.2 **Authorized Users.** Subscriber may invite Authorized Users through the Service's invitation flows. Subscriber controls each user's user type and permission roles and is responsible for every act and omission of its Authorized Users as if it were Subscriber's own. Platform staff identities are never available to a Subscriber as workspace seats.

3.3 **Credentials.** Each Authorized User must have their own credentials. Sharing credentials, sharing a Seat among multiple producing agents, or allowing a person who is not an Authorized User to operate the Service is prohibited.

3.4 **Portal users.** Subscriber may grant Contacts, vendors (including lenders and title agents, which the Service treats as vendor categories rather than user types) and referral partners access to limited portals. Portal users see only the records the Service's access rules expose to them and never another Contact's or another vendor's data or any of Subscriber's financials.

3.5 **Platform staff access.** Platform's support staff may access Subscriber's Tenant only (a) with Subscriber's request or consent for support, (b) to investigate a suspected security incident, abuse or legal violation, or (c) as required by law. Staff access runs through an audited impersonation session that records the real staff actor on every action, is limited to a read-only or full mode chosen for the purpose, and expires automatically after the period set in `lib/platform/impersonation.ts::IMPERSONATION_TTL_MINUTES`. An impersonation grant never exceeds the access the impersonated account itself has.

## 4. Tiers, Capacity and Seats

4.1 **Tiers.** Subscriber subscribes to one Tier. Every Tier gives Subscriber's Authorized Users access to all features pertaining to their user types; a Tier does not withhold user types, it sets capacity (`lib/kernel/tier-role-matrix.ts::TIER_INVITABLE_ROLES`).

4.2 **Seat bands.** Each Tier includes a number of Seats drawn from the plan catalog (`lib/billing/plan-catalog.ts::TIER_SEAT_BANDS`, mirrored in `lib/kernel/tier-role-matrix.ts::TIER_SEAT_LIMITS`): the Solo Tier includes two Seats, the Team Tier includes ten Seats, the Brokerage Tier includes thirty Seats, and the Multi-Location Tier's Seat count is negotiated and recorded on Subscriber's subscription (`subscriptions.custom_seat_limit`). The administered catalog value (`subscription_tiers.max_agents`) controls if it differs from these defaults.

4.3 **What counts as a Seat.** A Seat is a licensed producing user. The following consume a Seat (`lib/kernel/tier-role-matrix.ts::roleConsumesSeat`): an agent or team lead always (`PRODUCER_SEAT_ROLES`); a broker or broker owner unless Subscriber records them as non-producing (`LICENSED_SEAT_ROLES`), except that the managing broker of record for a location is always a Seat; an administrator only while they hold an active agent record. The following never consume a Seat: broker administrators, transaction coordinators and compliance officers (`FREE_STAFF_ROLES`); vendor and portal users; Contacts; and the Service's own AI ISA system actor.

4.4 **Reaching the Seat limit.** When Subscriber attempts to add a producing user past its effective limit (the band or negotiated count, plus any purchased seat packages, or a staff-set override), the Service refuses the addition and offers the paths that are genuinely open (`lib/kernel/tier-role-matrix.ts::seatDecision`): upgrading to the next Tier whose band fits; moving to a lower Tier that still fits the producers Subscriber already has; purchasing one or more seat packages at `[[PRICE_SEAT_PACKAGE]]` where the catalog offers one for Subscriber's Tier; or contacting Platform where pricing is custom. The gate that enforces the limit is `lib/kernel/seat-usage.ts::seatGate`; it refuses rather than guesses when the subscription, the count or the catalog cannot be read.

4.5 **Multi-Location Tier.** Subscriber on the Multi-Location Tier may create separately identifiable offices (locations), teams within offices, and explicit office and team memberships, each isolated as described in §12.3. Seats are allocated across locations within the negotiated total.

4.6 **Capacity other than Seats.** Each Tier includes a monthly allowance of AI usage and video minutes recorded in the plan catalog (`plan_limits`). Usage above the allowance is billed as overage under §5.6 where the catalog permits overage for the Tier, and is otherwise paused until the next period.

## 5. Fees, Billing, Renewal and Suspension

5.1 **Fees.** Subscriber will pay the Fees for its Tier and billing cycle as recorded in the Order: `[[PRICE_SOLO_MONTHLY]]`, `[[PRICE_TEAM_MONTHLY]]`, `[[PRICE_BROKERAGE_MONTHLY]]` or `[[PRICE_MULTI_LOCATION]]`, with the annual-cycle terms at `[[PRICE_ANNUAL_DISCOUNT]]`, the one-time setup fee at `[[PRICE_SETUP_FEE]]`, seat packages at `[[PRICE_SEAT_PACKAGE]]`, and usage overage at `[[PRICE_AI_OVERAGE_PER_UNIT]]` and `[[PRICE_VIDEO_OVERAGE_PER_UNIT]]`. Fees are stated in United States dollars and exclude taxes.

> **Drafting note (not contract text).** No price appears in the code or in these documents by rule. The only place a price lives is the administered catalog (`subscription_tiers.monthly_price_cents`, `annual_price_cents`, `setup_fee_cents`, seat package rows), and a checkout is refused outright when the catalog row holds no configured price (`lib/billing/subscription-activation.ts::planPriceNotConfigured`). The published agreement should reference the price shown at checkout and in the Order rather than restate it.

5.2 **Checkout and payment method.** Fees are collected through Platform's payment processor. At checkout Subscriber authorizes a recurring charge for the plan and a one-time charge for the setup fee on the first invoice (`lib/billing/subscription-activation.ts::createActivationCheckout`). Payment on the platform's own merchant account is for amounts owed to Platform; amounts a Subscriber collects from its own clients or pays to its vendors run on Subscriber's own processor account and never on Platform's (`lib/billing/stripe-account-scope.ts::stripeAccountSideFor`).

5.3 **Billing cycle and renewal.** The subscription is billed in advance on a monthly or annual cycle as selected. The Initial Term is `[[INITIAL_TERM]]`. At the end of each term the subscription renews automatically for a `[[RENEWAL_TERM]]` unless either Party gives notice of non-renewal at least `[[NON_RENEWAL_NOTICE_DAYS]]` days before the renewal date, or Subscriber cancels through the billing page before the renewal date.

5.4 **Price changes.** Platform may change Fees for a Renewal Term by notice given at least `[[NON_RENEWAL_NOTICE_DAYS]]` days before that Renewal Term begins. A change never applies mid-term to a prepaid term.

5.5 **Taxes.** Subscriber is responsible for sales, use, value-added and similar taxes on the Fees, other than taxes on Platform's income. Where Platform is required to collect tax it will add it to the invoice.

5.6 **Usage overage.** AI usage and video minutes are metered on the usage ledger the Service keeps (`ai_tool_usage` through `lib/ai/cost-tracking.ts::logAIUsage`; the billed metrics are `lib/billing/plan-catalog.ts::OVERAGE_BILLED_METRICS`). Usage above the Tier's included allowance in a billing period is charged at the overage rate for that metric where the catalog permits overage for the Tier. Platform-Owned Provider spend for acquisition, enrichment, communications and media is included in the subscription and metered against a per-Tier monthly ceiling; Platform does not charge Subscriber per lead, per record, per message or per closing, and no commission or revenue share is owed to Platform on any transaction Subscriber closes (Schedule 3 §1).

5.7 **Discounts.** Promotional codes applied at checkout are governed by the code's own terms as recorded in the Service (`lib/billing/discount-codes.ts`). A discount is personal to Subscriber and may not be combined unless the code says so.

5.8 **Failed payment and grace.** If a payment fails, Platform will notify Subscriber's commerce administrators on the day of failure and again at the intervals of the dunning schedule (`lib/billing/dunning.ts::DUNNING_LADDER`). Subscriber's access continues for a grace period of `[[PAST_DUE_GRACE_DAYS]]` days after the first failure. After the grace period, sign-ins are routed to the billing page until payment is restored; Subscriber Content is retained intact during this period and nothing is deleted. If the processor exhausts its retries without a successful payment, the subscription cancels and §15 applies.

5.9 **Suspension.** Platform may suspend Subscriber's access, or the access of a specific Authorized User, immediately and without liability if (a) Fees remain unpaid after the grace period, (b) Subscriber or an Authorized User is in material breach of Schedule 5, (c) Platform reasonably believes continued access would cause a security incident, legal violation or harm to a Contact, another Subscriber or a Provider, or (d) a Provider or regulator requires it. Platform will give notice of the suspension and its reason and will restore access when the cause is cured. Platform may also pause autonomous AI operations for Subscriber's Tenant alone under Schedule 2 §9.2 without suspending access.

5.10 **Disputed charges.** Subscriber must dispute a charge in writing within sixty days of the invoice date, stating the reason. Undisputed amounts remain payable. Where invoicing rather than card-on-file applies, amounts are due `[[PAYMENT_DUE_DAYS]]` days from invoice and late amounts bear interest at `[[LATE_FEE_RATE]]`.

## 6. Subscriber Responsibilities

6.1 **Licensed activity.** Subscriber is solely responsible for conducting its real estate business in compliance with the license law, advertising rules, agency-disclosure rules, trust-account rules, record-retention rules and professional standards of every jurisdiction in which it operates, and for supervising its Authorized Users as its broker of record is required to do. `[[SUBSCRIBER_BROKER_OF_RECORD]]` is responsible for every communication, advertisement, estimate, offer and document the Service produces or sends on Subscriber's behalf, whether drafted by a person or by an AI Manager.

6.2 **Consent and marketing law.** Subscriber is responsible for obtaining, recording and honoring every consent the law requires before contacting a person by call, text, email or mail; for honoring every opt-out, do-not-call request and unsubscribe; and for the accuracy and lawfulness of every marketing communication, as detailed in Schedule 5. The Service records consent and suppression evidence Subscriber supplies and enforces suppression at every send, but it cannot supply consent Subscriber never obtained.

6.3 **Fair housing.** Subscriber is responsible for compliance with the Fair Housing Act, the Equal Credit Opportunity Act where applicable, and state and local anti-discrimination law in every advertisement, communication, listing description and audience decision. The Service's writing prompts, outbound checks and advertising-audience gates assist compliance; they do not transfer Subscriber's responsibility.

6.4 **Accuracy of Subscriber Content.** Subscriber is responsible for the accuracy of the information it enters, including listing facts, pricing, availability, brand identity, license numbers, office addresses and the identity of its users, and for correcting inaccuracies promptly.

6.5 **Leads belong to the brokerage.** Leads acquired through the Service belong to Subscriber as the brokerage. The Service shows individual agents Contacts, not the Lead queue; a Lead reaches an agent as a Contact only once the Service's qualification and conversion rules pass or the person shows positive intent. Subscriber's internal arrangements with its agents about Contact ownership on departure are Subscriber's own and are not altered by this Agreement.

6.6 **Reviewing AI output.** Subscriber acknowledges that AI Managers generate drafts, estimates, research and recommendations that may be incomplete or wrong, and that Subscriber is responsible for reviewing every output that a person outside the Service will see or rely on in the manner Schedule 2 describes for each class of action.

6.7 **Backups of records required by law.** The Service retains Subscriber Content as described in §9 and Schedule 4, and flags documents past their retention window for review rather than deleting them. Subscriber remains responsible for keeping the records its license law requires for the period it requires, including by exporting them under §9.4 before terminating.

6.8 **Prohibited use.** Subscriber will not, and will not permit anyone to, use the Service in breach of Schedule 5 or of §10.3.

## 7. Platform Responsibilities and the Division of Roles

7.1 **Platform's role.** Platform provides, hosts, secures, maintains and supports the Service; operates the Platform-Owned Providers; routes AI Manager work through the gates in Schedule 2; keeps the evidence ledgers described in §12.5; and processes Subscriber Content only as a service provider or processor on Subscriber's instructions as set out in Schedule 4.

7.2 **What Platform does not do.** Platform does not supervise Subscriber's agents, does not hold a real estate, mortgage, appraisal or legal license, does not give legal, tax, appraisal, lending or brokerage advice, does not determine the value of any property (the Service's valuation feature is an automated estimate under §8.4), and does not make any representation that a Lead will respond, qualify, transact or close.

7.3 **Reliability.** Platform will use commercially reasonable efforts to make the Service available `[[SLA]]` in each month, excluding scheduled maintenance announced through the status notice, emergencies, Provider outages, and causes outside Platform's reasonable control. Where an SLA is offered, Subscriber's sole remedy for a shortfall is the service credit in `[[SLA_CREDIT_SCHEDULE]]`, claimed in writing within thirty days of the month in question.

7.4 **Support.** Platform provides support during `[[SUPPORT_HOURS]]` through the in-product support ticket flow and `[[PLATFORM_NOTICE_EMAIL]]`, with first-response targets of `[[SUPPORT_RESPONSE_TARGETS]]`. Support queues are isolated per Tenant.

7.5 **Self-healing.** The Service detects and repairs certain operational failures on its own (retries, backoff, provider failover, resuming a stalled workflow, re-queuing a provably undelivered step) within declared playbooks and bounded attempts. It never corrects money, never crosses a Tenant boundary, never changes a security rule, never deletes data and never edits production code on its own; those classes go to a person. Schedule 2 §8 describes the playbooks and their limits.

7.6 **Provider dependence.** The Service depends on Providers. Platform is not responsible for a Provider's unavailability, rate limits, data quality or changes to its terms, but will route around a failing Provider where a second one is configured for the same capability and will report an unconfigured or unavailable capability honestly rather than fabricating a result.

## 8. Autonomous Operations and Human Approval

8.1 **Authority ladder.** Each AI Manager operates for Subscriber's Tenant at an authority level from 0 (read only) to 6 (full, with human approval for consequential actions) that Subscriber's brokers and administrators set for each manager and that defaults to level 6 (`lib/ai-isa/persona-tool-policy.ts::AUTHORITY_LEVEL_LABELS`, set through `app/actions/admin/manager-evals.ts::setManagerAuthorityLevel`). Every change to a manager's authority or autonomy posture is versioned with who changed it and why.

8.2 **Human approval for consequential acts.** No AI Manager may, under any authority level, sign a document, file anything with a government or multiple-listing body, obligate Subscriber to pay money, or take an action the Service classes as legal or irreversible. Actions the Service classes as financial are available only at the highest authority level and only through a named human-approval gate. The complete map of automatic actions, held actions and their enforcing gates is Schedule 2, which controls over this section if they differ.

8.3 **Communications.** An AI Manager may send a message to a Contact only when (a) the manager's authority level and autonomy posture permit communication, (b) the outbound policy chain in Schedule 2 §5 has passed — consent, suppression, do-not-call, quiet hours, content compliance, over-contact de-confliction and budget — and (c) no platform-wide or Tenant halt is in force. A manager held for approval places its draft in Subscriber's approval queue; a human then sends it or discards it. Human-approved sends still pass every consumer-protection gate.

8.4 **Estimates and research are not advice.** Property value estimates are automated valuation outputs with a stated range and provenance (`lib/avm/provider-chain.ts::requestPropertyValuation`), not appraisals. Market research, readiness and timing signals are inferences with stated evidence classes and uncertainty; an inferred possibility is never presented as a verified intention and a market-level signal never identifies a person. Nothing the Service produces for a licensed appraiser is authored by a model.

8.5 **Kill switches and overrides.** Platform may halt autonomous AI operations platform-wide (emergency mode or AI engine off) or for Subscriber's Tenant alone. Subscriber may set any manager to approval-required, lower its authority level, freeze experiments, and honor any Contact's opt-out at once; a Contact's opt-out is honored at every authority level without exception. Schedule 2 §9 names the switches and the code that reads them.

8.6 **Evidence.** Every external action an AI Manager takes, and every decision to wait or do nothing, leaves a ledger row recording who or what initiated it, why, on what evidence, which policy permitted it, which tool and provider were used, what it cost and what happened (`lib/kernel/action-ledger.ts::withActionLedger`). Subscriber's administrators may read this evidence in the Service.

## 9. Subscriber Content, Data Ownership and Permitted Processing

9.1 **Ownership.** As between the Parties, Subscriber owns all Subscriber Content. Platform acquires no rights in Subscriber Content other than the limited license in §9.2.

9.2 **License to Platform.** Subscriber grants Platform a non-exclusive, worldwide, royalty-free license during the Subscription Term and the post-termination period in §15.3 to host, copy, process, transmit, display, analyze and create derivative works of Subscriber Content solely to provide, secure, support and improve the Service for Subscriber, to perform the AI Manager tasks Subscriber enables, to comply with law, and as otherwise instructed by Subscriber. Subscriber Content is used to improve the Service only for Subscriber's own Tenant (for example, a manager's learned adjustments for Subscriber's market), except as `[[CROSS_TENANT_AGGREGATE_USE]]` permits de-identified, aggregated use.

9.3 **AI processing.** Subscriber Content may be sent to the AI gateway and the model vendors behind it, and to Providers, to perform the tasks Subscriber enables. Platform does not use Subscriber Content to train general-purpose models. Vendor retention of prompts and outputs is governed by Schedule 4 §7 and the variable `[[AI_VENDOR_RETENTION_TERMS]]` recorded there.

9.4 **Export.** Subscriber may obtain an export of its core business records at any time during the Subscription Term and for `[[POST_TERMINATION_RETENTION_DAYS]]` days after termination, in a machine-readable bundle covering the tables listed in `lib/platform/tenant-export.ts::TENANT_EXPORT_TABLES` (`lib/platform/tenant-export.ts::buildTenantExport`). Each table in the bundle is capped per export at the row limit stated in the bundle, with pagination offered for the remainder. An export never deletes anything, and never includes credentials or secrets (`lib/security/export-credential-scan.ts`). Individual persons may obtain their own data through the privacy-request flow in Schedule 4 §11.

> **Drafting note (not contract text).** The tenant export today runs as a platform-staff action on a superadmin-gated surface, not as a self-serve button in the Subscriber's settings. The clause promises the export, not the button. Counsel should confirm that "available on request" is acceptable, or the owner should direct a self-serve surface in a later lane.

9.5 **Deletion.** After the post-termination period Platform will delete or de-identify Subscriber Content, except (a) records Platform must retain by law, (b) transaction, consent, suppression and compliance records that Subscriber's own retention obligations or a Contact's opt-out require to be kept for `[[DATA_RETENTION_YEARS_TRANSACTION]]` years or the period the law sets, which are retained in de-identified or restricted form, (c) ledger and audit rows that document what the Service did, which are retained as records of Platform's own operations, and (d) copies in routine backups that expire on their own schedule. De-identification of a Contact replaces the personal fields with irreversible markers while preserving transaction linkage (`lib/privacy/contact-pii-redaction.ts::contactRedactionPatch`).

9.6 **Subscriber's instructions and lawful basis.** Subscriber instructs Platform to process Contact and Lead personal information as described in this Agreement and the Schedules, warrants that it has a lawful basis and the notices and consents the law requires for that processing, and will not instruct processing that would cause Platform to violate law.

9.7 **Platform Data and feedback.** Platform owns Platform Data. Subscriber grants Platform a perpetual, irrevocable license to use suggestions and feedback Subscriber provides about the Service without obligation.

## 10. Intellectual Property and Subscriber Branding

10.1 **Platform's rights.** The Service and Platform Data are protected by copyright, trade secret and other laws and are licensed, not sold. Subscriber receives only the limited right to use the Service under this Agreement. The copyright and licensing notice displayed in the Service (`lib/branding/platform-rights-notice.ts::platformRightsNotice`) is incorporated here.

10.2 **Subscriber's brand.** Subscriber retains all rights in its names, logos, trade dress, license identifiers, custom domains and brand assets. Subscriber grants Platform a license to display them in the Service, on Subscriber's tenant site and white-label domain, in communications and materials the Service produces for Subscriber, and — only if `[[PUBLICITY_CONSENT]]` is yes — in Platform's customer lists. Materials the Service produces for Subscriber carry Subscriber's identity; direct-mail pieces carry Subscriber's brokerage-of-record return address and never Platform's.

10.3 **Restrictions.** Subscriber will not copy, modify, translate, create derivative works of, reverse engineer, decompile or disassemble the Service except as law expressly permits; scrape, crawl or extract the Service's interface, content or data by automated means; frame or mirror the Service; remove or obscure proprietary notices; resell, sublicense, rent, lend, time-share or make the Service available to any third party other than Authorized Users and portal users; use the Service to build a competing product; or access the Service to monitor its availability, performance or functionality for competitive purposes.

10.4 **Generated output.** As between the Parties, Subscriber owns the outputs the Service generates for Subscriber from Subscriber Content, subject to third-party rights in any licensed stock media, Provider data or listing content used in them. Platform makes no warranty that generated output is original or non-infringing and Subscriber is responsible for reviewing output before publishing it.

10.5 **Third-party materials.** Listing photographs, multiple-listing data, stock media, map tiles, public records and Provider data are licensed to Subscriber by their owners under terms that may be narrower than this Agreement. Schedule 5 §7 states the listing-photo and IDX rules; Schedule 3 states each Provider's rights status as the Service records it.

## 11. Third-Party Providers and Licensing

11.1 **Platform-Owned Providers.** Platform contracts with, pays for and operates the Platform-Owned Providers listed in Schedule 3 §3, meters their use to Subscriber's Tenant, and caps that use at the per-Tier monthly ceiling. Subscriber receives the output of these Providers as part of the Service and acquires no direct relationship with the Provider. Platform may add, replace or retire a Platform-Owned Provider for a capability without notice where the capability continues to be served.

11.2 **Tenant-Connected Providers.** Subscriber may connect its own accounts with the Providers the Service offers for connection (`lib/connections/scope.ts::CONNECTOR_PROVIDERS`) under Schedule 6. Subscriber is responsible for its contract with each such Provider, for the fees it charges, for the scopes it grants, and for the accuracy of the data the Provider supplies. A Tenant-Connected Provider's credential is encrypted at rest, resolved by ownership scope (agent, team, brokerage) and never shared across Tenants; a missing or revoked credential produces an honest refusal rather than a fallback to another account.

11.3 **Provider terms pass-through.** Subscriber will comply with the published terms of each Provider whose output it uses through the Service, including restrictions on redistribution, caching, resale, consumer-reporting use and permitted purpose stated in Schedule 3 §4, and will not use Provider data for credit, tenancy, insurance or employment eligibility decisions.

11.4 **Multiple-listing and IDX data.** Where Subscriber connects an IDX or multiple-listing feed, Subscriber's board rules govern display, attribution, refresh and takedown; Subscriber is responsible for complying with them and Platform will follow Subscriber's configured display rules.

11.5 **Payment processing.** Platform's payment processor handles Subscriber's payment credentials under its own terms; Platform does not store full card numbers. Subscriber's own processor account for client payments and vendor payouts is a Tenant-Connected Provider under Schedule 6.

## 12. Confidentiality, Security, Isolation and Evidence

12.1 **Confidential Information.** "Confidential Information" means non-public information a Party discloses to the other that is marked confidential or that a reasonable person would understand to be confidential, including Subscriber Content, Platform Data, pricing, security details and the terms of any custom Order. It excludes information that is or becomes public without breach, was already known to the recipient without restriction, is independently developed, or is rightfully received from a third party without restriction.

12.2 **Obligations.** The recipient will use Confidential Information only to perform this Agreement, protect it with at least reasonable care, disclose it only to employees, contractors and Providers who need it and are bound by comparable obligations, and return or destroy it on request when the Agreement ends, subject to §9.5. These obligations survive for `[[CONFIDENTIALITY_TERM_YEARS]]` years after termination, and for trade secrets as long as they remain trade secrets. A recipient may disclose Confidential Information as required by law after giving the discloser notice and a chance to object where lawful.

12.3 **Tenant isolation.** The Service isolates each Tenant by row-level security on every table in its public schema, by resolving the Tenant from the authenticated session and never from a request body, and by using its privileged database role only after an authorization gate has run (`lib/auth/require-caller.ts::requireCallerTenant`). Storage buckets that hold documents are private and served only through time-limited signed URLs with an access log; buckets that hold marketing media meant for public display are public by design (`lib/storage/document-buckets.ts::DOCUMENT_CLASS_BUCKETS`, `lib/storage/document-buckets.ts::PUBLIC_MEDIA_BUCKETS`). Teams see only their own board; offices on a Multi-Location Tenant see only their own members and records; Platform sees all Tenants for operation and support under §3.5.

12.4 **Security program.** Platform maintains administrative, technical and physical safeguards appropriate to the sensitivity of Subscriber Content, including encryption in transit, encryption of stored credentials and secrets with authenticated encryption (`lib/security/secret-crypto.ts::encryptSecret`), credential rotation monitoring, verification of every inbound provider webhook, rate limiting of public write endpoints, and a fail-closed posture where a gate cannot run. Schedule 4 §9 describes the program in more detail. Platform will not reduce the overall protection of the security program during the Subscription Term.

12.5 **Evidence ledgers.** The Service keeps the action ledger (§8.6), the consent ledger, the suppression lists, the outbound-compliance log, the document access log, the policy-version history and the AI usage ledger. These records are Platform's operational records and Subscriber's compliance evidence; Platform will make Subscriber's Tenant-scoped rows available to Subscriber through the Service and on reasonable request.

12.6 **Security incidents.** Platform will notify Subscriber without undue delay, and in any event within `[[INCIDENT_NOTICE_HOURS]]` hours of confirming it, of any unauthorized access to or disclosure of Subscriber Content, with the information Schedule 4 §10 lists, and will cooperate with Subscriber's own notification obligations. Subscriber will notify Platform promptly at `[[PLATFORM_NOTICE_EMAIL]]` of any compromise of an Authorized User's credentials or any suspected misuse of the Service.

## 13. Notices, Retention, Export and Deletion Mechanics

13.1 **Notices.** Legal notices must be in writing and delivered by courier or certified mail to `[[PLATFORM_NOTICE_ADDRESS]]` or `[[SUBSCRIBER_NOTICE_ADDRESS]]`, with a copy by email to `[[PLATFORM_NOTICE_EMAIL]]` or the subscriber's recorded administrator email. Operational notices — billing, dunning, status, change log, approval requests, incident alerts — are given through the Service and to the administrators' recorded email addresses and are effective when sent.

13.2 **Record retention by Platform.** Platform retains Subscriber Content for the Subscription Term and the period in §15.3. Documents in Subscriber's transaction files carry a retention default by category (`lib/kernel/document-custody.ts::RETENTION_DEFAULTS`) that the Service uses only to flag documents past their window for Subscriber's review (`lib/kernel/document-custody.ts::runRetentionScan`); the Service never deletes a transaction document automatically. The defaults are a starting point, not a statement of any state's law; Subscriber confirms the periods its state and brokerage policy require.

13.3 **Export mechanics.** An export under §9.4 is produced as a structured bundle that states the tables and row counts it contains, identifies any table that reached its row cap, and excludes credential-shaped values. The bundle remains available for `[[EXPORT_WINDOW_DAYS]]` days.

13.4 **Deletion mechanics.** Deletion under §9.5 proceeds table by table through the Service's own deletion and de-identification paths, is recorded, and is confirmed to Subscriber in writing on request. Backup copies expire on the backup schedule described in Schedule 4 §8.

## 14. Term and Renewal

14.1 The Agreement begins on the Effective Date and continues for the Initial Term and each Renewal Term under §5.3 until terminated under §15.

14.2 A trial under §2.4 is part of the Term; its expiry without checkout ends the Agreement under §15.1(c) subject to §15.3.

## 15. Termination

15.1 **Termination events.** This Agreement ends (a) when Subscriber cancels through the billing page effective at the end of the current paid period; (b) when either Party terminates for the other's material breach that remains uncured `[[TERMINATION_FOR_CAUSE_CURE_DAYS]]` days after written notice describing the breach; (c) when a trial expires without checkout, or a subscription cancels for non-payment under §5.8; (d) immediately by either Party if the other becomes insolvent, makes an assignment for the benefit of creditors, or is the subject of a bankruptcy proceeding not dismissed within sixty days; or (e) immediately by Platform if Subscriber's real estate license is revoked or suspended, or Subscriber uses the Service in a way that Platform reasonably believes creates a material legal risk to Platform, a Contact or another Subscriber that cannot be cured by suspension.

15.2 **Effect.** On termination Subscriber's right to use the Service ends, autonomous AI operations for the Tenant stop, Fees accrued remain payable, and prepaid Fees are not refunded except where Subscriber terminates for Platform's uncured material breach, in which case Platform refunds the unused prepaid portion.

15.3 **Post-termination access.** For `[[POST_TERMINATION_RETENTION_DAYS]]` days after termination Platform will keep Subscriber Content available for export under §9.4 and will then proceed under §9.5. During that period the Tenant is in read-only or export-only mode and no Fees accrue.

15.4 **Survival.** Sections 1, 5 (as to accrued amounts), 6.7, 9, 10, 12, 13, 15, 16, 17, 18, 19, 20, 21 and 24 survive termination, as does any Schedule provision that by its nature should survive.

## 16. Representations and Warranties

16.1 **Mutual.** Each Party represents that it is duly organized and in good standing, has the authority to enter into this Agreement, and that its performance will not breach any other agreement by which it is bound.

16.2 **Subscriber.** Subscriber represents and warrants that (a) it and its Authorized Users hold every license the law requires for the activity they conduct through the Service; (b) it has the right to submit Subscriber Content and to instruct the processing in §9; (c) it has obtained every consent and given every notice the law requires before it or the Service contacts a person; (d) it will not use Provider data for consumer-reporting purposes; and (e) the signatory who accepts this Agreement is authorized to bind it.

16.3 **Platform.** Platform warrants that (a) the Service will perform materially in accordance with the Documentation during the Subscription Term; (b) it will provide the Service with reasonable skill and care; (c) it will not materially decrease the security of the Service during the Subscription Term; and (d) it will comply with laws applicable to its provision of the Service as a service provider. Subscriber's exclusive remedy for breach of (a) is Platform's correction of the non-conformity or, if Platform cannot correct it within a reasonable time, termination under §15.1(b) and refund of prepaid Fees for the period after termination.

## 17. Disclaimers

17.1 **As-is beyond the express warranties.** EXCEPT AS EXPRESSLY STATED IN §16, THE SERVICE, THE SCHEDULES, THE DOCUMENTATION, ALL AI MANAGER OUTPUT AND ALL PROVIDER DATA ARE PROVIDED "AS IS" AND "AS AVAILABLE", AND PLATFORM DISCLAIMS ALL OTHER WARRANTIES, EXPRESS, IMPLIED OR STATUTORY, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, AND ANY WARRANTY ARISING FROM COURSE OF DEALING OR USAGE OF TRADE.

17.2 **No guarantee of results.** PLATFORM DOES NOT WARRANT OR GUARANTEE THAT SUBSCRIBER WILL OBTAIN ANY NUMBER OR QUALITY OF LEADS, CONTACTS, APPOINTMENTS, LISTINGS, OFFERS, TRANSACTIONS, CLOSINGS, COMMISSIONS, REVIEWS, FOLLOWERS, RANKINGS, SEARCH POSITIONS OR ADVERTISING RESULTS; THAT ANY LEAD IS ACCURATE, CURRENT, CONTACTABLE, CONSENTED OR INTERESTED; OR THAT ANY ESTIMATE, SIGNAL, SCORE, TIMING WINDOW OR RECOMMENDATION IS CORRECT. A READINESS OR PROPENSITY SCORE IS NEVER A PROBABILITY OF CLOSING.

17.3 **AI output.** AI MANAGER OUTPUT IS GENERATED BY STATISTICAL MODELS AND MAY BE INACCURATE, INCOMPLETE, OUT OF DATE, BIASED OR UNSUITABLE FOR SUBSCRIBER'S PURPOSE. SUBSCRIBER IS RESPONSIBLE FOR REVIEWING OUTPUT BEFORE RELYING ON IT OR SENDING IT, IN THE MANNER SCHEDULE 2 DESCRIBES. NOTHING THE SERVICE PRODUCES IS LEGAL, TAX, LENDING, APPRAISAL, INSURANCE OR BROKERAGE ADVICE.

17.4 **Providers and the internet.** PLATFORM IS NOT RESPONSIBLE FOR THE ACTS, OMISSIONS, DATA, AVAILABILITY OR TERMS OF ANY PROVIDER, FOR DELAYS OR FAILURES OF THE INTERNET, TELECOMMUNICATIONS CARRIERS, EMAIL RECEIVING SYSTEMS, ADVERTISING PLATFORMS OR MULTIPLE-LISTING SERVICES, OR FOR SUBSCRIBER'S OR ITS USERS' DEVICES AND CONNECTIVITY.

17.5 **Jurisdictions.** Some jurisdictions do not allow certain disclaimers; in those jurisdictions the disclaimers apply to the fullest extent permitted.

## 18. Limitation of Liability

18.1 **Exclusion of indirect damages.** TO THE FULLEST EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE TO THE OTHER FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOST COMMISSIONS, LOST BUSINESS, LOST DATA (OTHER THAN THE COST OF RESTORING FROM AN AVAILABLE EXPORT OR BACKUP), OR THE COST OF SUBSTITUTE SERVICES, ARISING OUT OF OR RELATED TO THIS AGREEMENT, HOWEVER CAUSED AND UNDER ANY THEORY OF LIABILITY, EVEN IF ADVISED OF THE POSSIBILITY.

18.2 **Cap.** TO THE FULLEST EXTENT PERMITTED BY LAW, EACH PARTY'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT WILL NOT EXCEED `[[LIABILITY_CAP]]`. FOR PLATFORM'S BREACH OF §12 (CONFIDENTIALITY AND SECURITY) OR SCHEDULE 4 (DATA PROCESSING), THE CAP IS `[[SUPER_CAP]]`.

18.3 **Exceptions.** The exclusions and caps in §18.1 and §18.2 do not apply to (a) a Party's indemnification obligations under §19 except as `[[INDEMNITY_CAP]]` provides; (b) Subscriber's payment obligations; (c) a Party's gross negligence, willful misconduct or fraud; (d) Subscriber's breach of §10.3 or Schedule 5 §2 through §6; or (e) liability that cannot be limited by law.

18.4 **Allocation.** The Parties agree that the Fees reflect this allocation of risk and that Platform would not provide the Service without it.

## 19. Indemnification

19.1 **By Subscriber.** Subscriber will defend, indemnify and hold harmless Platform, its Affiliates and their officers, directors, employees and agents from and against any third-party claim, regulatory proceeding, fine, penalty, loss, cost and expense (including reasonable attorneys' fees) arising out of or related to (a) Subscriber Content; (b) Subscriber's or an Authorized User's real estate activity, advertising, communications, consent practices or compliance with license, fair-housing, telemarketing, anti-spam, privacy or consumer-protection law; (c) Subscriber's breach of §6, §10.3, §11.3, §16.2 or Schedule 5; (d) Subscriber's use of Provider data in breach of a Provider's terms; (e) a message, call, mailer or advertisement sent by or for Subscriber, including one an AI Manager sent within the authority Subscriber granted; or (f) a dispute between Subscriber and its agents, Contacts, clients, vendors or another brokerage.

19.2 **By Platform.** Platform will defend, indemnify and hold harmless Subscriber and its officers, directors and employees from and against any third-party claim alleging that the Service as provided by Platform (excluding Subscriber Content, Provider data, Tenant-Connected Providers, and combinations or modifications not made by Platform) infringes a United States patent, copyright or trademark or misappropriates a trade secret, and will pay damages finally awarded or agreed in settlement. If such a claim is made or likely, Platform may procure the right for Subscriber to continue using the Service, modify the Service to be non-infringing, or terminate the affected part and refund prepaid Fees for the period after termination. This §19.2 states Platform's entire liability for infringement.

19.3 **Procedure.** The indemnified Party will give prompt notice of the claim (delay relieves the indemnifying Party only to the extent prejudiced), give the indemnifying Party sole control of the defense and settlement (except that a settlement imposing non-monetary obligations on or admitting fault of the indemnified Party requires its consent), and provide reasonable cooperation at the indemnifying Party's expense. Indemnities are subject to `[[INDEMNITY_CAP]]`.

## 20. Dispute Resolution and Governing Law

20.1 **Informal resolution.** Before beginning any proceeding other than one for injunctive relief, the complaining Party will give written notice describing the dispute, and the Parties will negotiate in good faith for `[[DISPUTE_INFORMAL_PERIOD_DAYS]]` days.

20.2 **Forum.** Disputes not resolved informally will be resolved by `[[DISPUTE_FORUM]]`. If arbitration: administered by `[[ARBITRATION_PROVIDER]]` under its then-current commercial rules, by a single arbitrator, seated in `[[VENUE]]`, with the arbitrator empowered to award any relief a court could award, and judgment on the award enterable in any court of competent jurisdiction; either Party may seek interim injunctive relief in court to protect intellectual property or Confidential Information; and `[[CLASS_WAIVER]]` governs whether claims may be brought only on an individual basis. If courts: the state and federal courts located in `[[VENUE]]` have exclusive jurisdiction and each Party consents to personal jurisdiction there.

20.3 **Governing law.** This Agreement is governed by the laws of `[[GOVERNING_LAW]]` without regard to its conflict-of-laws rules. The United Nations Convention on Contracts for the International Sale of Goods does not apply.

20.4 **Attorneys' fees.** In any proceeding to enforce this Agreement the prevailing Party may recover its reasonable attorneys' fees and costs to the extent the forum permits.

20.5 **Time limit.** To the extent permitted by law, a claim arising out of this Agreement must be brought within one year after it accrues.

> **Drafting note (not contract text).** Governing law, venue, forum, class waiver and informal period are each a decision for counsel; the choice interacts with state consumer-protection and arbitration law and with where Subscribers are licensed. This draft takes no position.

## 21. General

21.1 **Independent contractors.** The Parties are independent contractors. Nothing creates a partnership, joint venture, agency, franchise, fiduciary or employment relationship. Platform is not a party to any transaction between Subscriber and its clients, agents or vendors.

21.2 **Assignment.** Neither Party may assign this Agreement without the other's prior written consent, except that either Party may assign it without consent to an Affiliate or to a successor in a merger, acquisition or sale of substantially all its assets, provided the assignee assumes the Agreement in writing. Any other assignment is void.

21.3 **Subcontractors and subprocessors.** Platform may use subcontractors and subprocessors to provide the Service and remains responsible for their performance. Subprocessors that handle personal information are listed in Schedule 4 §6 and changes to that list are notified as Schedule 4 §6 describes.

21.4 **Force majeure.** Neither Party is liable for failure or delay caused by events beyond its reasonable control, including acts of God, war, terrorism, labor disputes, government action, pandemic, utility or internet failure, or Provider outage, provided the affected Party uses reasonable efforts to mitigate and resumes performance promptly. Payment obligations are not excused.

21.5 **Compliance with law; export.** Each Party will comply with laws applicable to its performance. The Service is offered for use in the United States; Subscriber will not use or permit use of the Service in violation of United States export control or sanctions law.

21.6 **Insurance.** Each Party will maintain `[[INSURANCE_REQUIREMENTS]]`.

21.7 **Publicity.** Neither Party will use the other's name or marks in publicity without consent, except as `[[PUBLICITY_CONSENT]]` and §10.2 provide.

21.8 **Severability; waiver.** If a provision is held unenforceable it will be enforced to the maximum extent permitted and the remainder will continue in effect. A waiver is effective only in writing and only for the instance given.

21.9 **Interpretation.** Headings are for convenience. "Including" means "including without limitation". No rule of construction against the drafter applies.

21.10 **Counterparts and electronic signatures.** This Agreement may be accepted electronically under §25 and in counterparts, each of which is an original.

## 22. Changes to this Agreement

22.1 Platform may update this Agreement and its Schedules by publishing a new version identifier (`[[AGREEMENT_VERSION]]`) with its content hash (`[[AGREEMENT_HASH]]`) and giving Subscriber notice through the Service at least thirty days before the new version takes effect for Subscriber, except that a change required by law or by a Provider's terms, or that only adds a feature or reduces Subscriber's obligations, may take effect on notice.

22.2 A new version applies to Subscriber on the earlier of the date Subscriber's authorized signatory re-accepts it in the Service and the first renewal after the notice period. If Subscriber does not accept a materially adverse change, Subscriber may terminate under §15.1(a) effective at the end of the current paid period and the prior version governs until then.

22.3 The Service prompts every Authorized User whose recorded acceptance predates the current version to acknowledge the current version before continuing (`app/actions/public/tos-acceptance.ts::checkCurrentUserTosStatusAction`). A seat user's acknowledgment is an acknowledgment of notice; only the authorized signatory's acceptance binds `[[SUBSCRIBER_LEGAL_ENTITY]]` to a new version under §25.

## 23. Entire Agreement

This Agreement, including the Order and the Schedules, is the entire agreement between the Parties on its subject and supersedes all prior or contemporaneous proposals, representations and agreements, written or oral. No terms in a Subscriber purchase order, vendor registration form or similar document apply. Amendments must be in writing and signed or accepted under §25 by both Parties, except as §22 provides.

## 24. Order of Precedence

If documents conflict, the following order controls, the earlier prevailing over the later: (1) a written custom order form signed by both Parties, as to the terms it expressly varies; (2) Schedule 4 (Data Processing Addendum) as to the processing of personal information; (3) Schedule 2 (Authority) as to what an AI Manager may do; (4) the body of this Agreement; (5) Schedules 3, 5 and 6; (6) the Order as recorded in the Service; (7) the Documentation. A Schedule never expands Platform's liability beyond §18.

## 25. Acceptance and Signatures

25.1 **Online acceptance.** This Agreement is accepted when `[[SUBSCRIBER_AUTHORIZED_SIGNATORY]]`, acting for `[[SUBSCRIBER_LEGAL_ENTITY]]`, affirmatively indicates acceptance in the Service's sign-up or billing flow by an action the Service presents as acceptance of the version then published. Acceptance is effective as the signature of `[[SUBSCRIBER_LEGAL_ENTITY]]` under the Electronic Signatures in Global and National Commerce Act and the applicable state electronic-transactions law.

25.2 **Who may accept.** Only a person with authority to bind `[[SUBSCRIBER_LEGAL_ENTITY]]` — its broker of record, an owner, officer or manager, or a person they have designated in writing — may accept for it. An Authorized User who holds only an ordinary seat is not, by holding that seat, authorized to accept, amend or renew this Agreement for `[[SUBSCRIBER_LEGAL_ENTITY]]`, and their acknowledgment of a version under §22.3 is notice only. Platform may rely on the signatory's representation of authority.

25.3 **Acceptance record.** Platform keeps a record of each acceptance containing the version identifier accepted, the date and time, the accepting identity, and the network address and user agent of the accepting session, and — once the acceptance wiring described in the review packet ships — the content hash of the accepted text, the signatory's identity and role, the subscriber entity, and an immutable copy of the accepted text available for download. Subscriber may obtain its acceptance record on request. The record is evidence of acceptance and of the text accepted.

25.4 **Separate consents.** Acceptance of this Agreement is not consent by any Contact to receive marketing communications, is not a brokerage listing, buyer-representation, referral or commission agreement, and does not substitute for any of them. Each of those is a separate instrument with its own parties, record and law.

25.5 **Signatures.** Where the Parties execute a written order form, it is signed by `[[PLATFORM_AUTHORIZED_SIGNATORY]]` for Platform and `[[SUBSCRIBER_AUTHORIZED_SIGNATORY]]` for Subscriber.

> **Drafting note (not contract text) — the acceptance record as implemented today.** The live acceptance path is `app/actions/public/tos-acceptance.ts::recordTosAcceptanceAction`, called from the trial funnel at `app/get-started` before the tenant is provisioned, and `app/actions/public/tos-acceptance.ts::acceptCurrentTosAsCurrentUserAction` from the re-acceptance banner in the app shell. It writes `platform_tos_acceptances` (email, version, network address, user agent, timestamp), keyed on email and version, with the current version read from `platform_settings.tos_version`. Platform staff can export the rows (`app/actions/public/tos-acceptance.ts::listTosAcceptancesAction`). What the record does **not** yet hold: the content hash of the accepted text, the signatory's authority or role, the subscriber entity (the table has no tenant column), an immutable stored copy of the text, or a retrievable download. There is also a second, older acceptance store, `privacy_acceptances` (policy_type includes terms_of_service), that exists live and is written by nothing in the current app — two spellings of one record. Lane 151A owns the acceptance wiring; §25.3 is written to the target record, and the review packet's publication procedure lists exactly what must ship before §25.3 is true. Until then this Agreement must not be published.

---

### Schedules

- Schedule 2 — `PACKET-2-AUTONOMOUS-AI-OPERATIONS-AND-AUTHORITY-SCHEDULE.md`
- Schedule 3 — `PACKET-3-ACQUISITION-ENRICHMENT-DATA-RIGHTS-AND-INTEGRATION-SCHEDULE.md`
- Schedule 4 — `PACKET-4-PRIVACY-NOTICE-DPA-AND-SUBPROCESSORS.md`
- Schedule 5 — `PACKET-5-ACCEPTABLE-USE-AND-MARKETING-COMPLIANCE.md`
- Schedule 6 — `PACKET-6-TENANT-OWNED-PROVIDER-CONNECTION-SCHEDULE.md`
