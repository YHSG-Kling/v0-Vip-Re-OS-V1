> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Legal review packet — platform agreements, schedules and the path to publication

Version: 0.1.0-draft (2026-11-09) · Document ID: VIP-LEGAL-REVIEW · Wave 151, lane 151A2 · Written against commit `b2c93720`

## 1. Cover memorandum

**To:** the owner, and the qualified legal counsel the owner engages.
**From:** wave 151, lane 151A2 (the drafting lane).
**Re:** complete first drafts of the platform's customer legal agreements, what they are built on, what they wait on, and how they get published.

**What is in this packet.** Six complete drafts under `docs/legal/`: the Platform Subscription and Services Agreement (Packet 1) and its five schedules — Autonomous AI Operations and Authority (Packet 2), Acquisition, Enrichment, Data Rights and Third-Party Integration (Packet 3), the Privacy Notice, Data Processing Addendum and Subprocessor List (Packet 4), Acceptable Use and Marketing Compliance (Packet 5), and the reusable Tenant-Owned Provider Connection Schedule (Packet 6). Each is a full clause set a lawyer can redline, not an outline. This document carries the decision table, the consolidated placeholders, the state checklist, the risk summary, the version and redline ledger, the status table, the sign-off sheet, the publication and acceptance procedure, and an example of what a tenant will see.

**How the drafts were built.** Every statement about what the system does, holds, gates or records was written from the code at commit `b2c93720` and cited to the file and symbol that implements it. The drafting lane inspected the acceptance path, the privacy-request flow, the subscription and checkout code, the manager registry, the action ledger, the self-healing engine, the authority ladder and approval gates, the kill switches, the provider route table and activation state, the tenancy matrix, the consent model, the storage bucket roster and retention code, the row-level-security census, the tier and seat model, and the wave-150 truth ledger. Where the code does something the directive expected and does not yet do, the draft says what exists and marks the remainder as a variable or a drafting note; nowhere does a draft claim authority or a safeguard the code lacks.

**What is not claimed.** No attorney has reviewed any of these documents. No document is approved. No price appears anywhere; every price is a `[[PRICE_*]]` variable. No governing law, venue, liability cap, SLA, entity name or contact address has been chosen; each is a variable in the decision table below. The DRAFT banner on the first line of every file stays until the sign-off sheet is complete for that document, and a build-time proof (`scripts/legal-packets-guard.ts`, run as `npm run test:legal-packets`) fails the build if the banner is removed, a price literal appears, a cited gate disappears from the code, or the subprocessor list names a vendor the code's registries do not declare.

**The two gates before publication.** First, counsel's sign-off on the text, recorded in §8. Second, the acceptance wiring the directive assigns to lane 151A: the acceptance record must carry the version identifier and the content hash of the published text, the signatory's identity and authority, the subscriber entity, an immutable stored copy, a retrievable download and a re-acceptance path, and an ordinary seat user must not be able to sign for the corporate subscriber. §9 describes that procedure by concept. The live acceptance code today records email, version, network address, user agent and time — enough to show someone clicked, not enough to show what they agreed to or that they could bind the brokerage.

**Outside this lane.** Items this packet surfaces for other lanes or for engineering are listed in §5 (risk summary) and §9 (procedure) and are repeated in the lane's notes for the integrator: the acceptance wiring (lane 151A); a per-connection terms-confirmation and acceptance record (lane 151F); retention jobs for raw records and logs, a post-termination deletion job and a deletion certificate (no owner yet); a self-serve tenant export surface (no owner yet); registry rows for any free geocoding helper that receives a person's address (no owner yet); and reading RentCast's Terms of Use and Versium's signed terms (counsel).

## 2. Plain-English owner decision table

Each row is a decision only the owner (or counsel on the owner's instruction) can make. "Default if undecided" is what the draft does today, which in every case is to refuse publication rather than guess.

| # | Decision | Why it matters | Options | Default if undecided | Documents affected |
|---|---|---|---|---|---|
| D1 | Who is the contracting entity? (`[[PLATFORM_LEGAL_ENTITY]]`, `[[PLATFORM_ENTITY_TYPE_AND_STATE]]`) | A contract with no party is not a contract. The code has only a product brand; the copyright notice renders the brand as the rights holder because the entity was never recorded. | Name the operating company; record it in platform settings so the rights notice and the agreement agree. | Publication refused. | All six, the rights notice at `lib/branding/platform-rights-notice.ts`. |
| D2 | Governing law, venue and forum (`[[GOVERNING_LAW]]`, `[[VENUE]]`, `[[DISPUTE_FORUM]]`, `[[ARBITRATION_PROVIDER]]`, `[[CLASS_WAIVER]]`, `[[DISPUTE_INFORMAL_PERIOD_DAYS]]`) | Decides where disputes are heard and whether class claims are waived; interacts with state arbitration and consumer law and with where subscribers are licensed. | Home-state law and courts; arbitration with a small-claims carve-out; arbitration with class waiver. | Publication refused. | Packet 1 §20. |
| D3 | Liability caps (`[[LIABILITY_CAP]]`, `[[SUPER_CAP]]`, `[[INDEMNITY_CAP]]`) | The cap is the price of the risk the platform carries; a data-protection super-cap is market practice for a processor. | Fees paid in the prior twelve months; a multiple for data breaches; uncapped indemnities or capped. | Publication refused. | Packet 1 §18–19, Packet 4 §B.12. |
| D4 | Service level and support (`[[SLA]]`, `[[SLA_CREDIT_SCHEDULE]]`, `[[SUPPORT_HOURS]]`, `[[SUPPORT_RESPONSE_TARGETS]]`) | An SLA is a promise with a remedy; the deployment has no external liveness endpoint yet (architecture finding F-4), so an uptime number cannot be measured from outside today. | No SLA (commercially reasonable efforts only); an SLA once monitoring exists. | No SLA stated; §7.3 remains "commercially reasonable efforts". | Packet 1 §7. |
| D5 | Term, renewal and notice (`[[INITIAL_TERM]]`, `[[RENEWAL_TERM]]`, `[[NON_RENEWAL_NOTICE_DAYS]]`) | Auto-renewal is regulated by state law (see §4); the billing cycle in code is monthly or annual with automatic renewal through the processor. | Month-to-month; annual with thirty days' notice. | Publication refused. | Packet 1 §5.3, §14. |
| D6 | Payment terms (`[[PAYMENT_DUE_DAYS]]`, `[[LATE_FEE_RATE]]`, `[[TRIAL_LENGTH_DAYS]]`, `[[PAST_DUE_GRACE_DAYS]]`) | The code's grace period is seven days (`lib/billing/past-due-clock.ts`) and the dunning ladder runs at days 0, 3, 7 and 14; the contract should match or the code should change. | Match the code; or change the code. | Contract matches the code once counsel confirms. | Packet 1 §5.8–5.10. |
| D7 | Prices (`[[PRICE_SOLO_MONTHLY]]`, `[[PRICE_TEAM_MONTHLY]]`, `[[PRICE_BROKERAGE_MONTHLY]]`, `[[PRICE_MULTI_LOCATION]]`, `[[PRICE_ANNUAL_DISCOUNT]]`, `[[PRICE_SETUP_FEE]]`, `[[PRICE_SEAT_PACKAGE]]`, `[[PRICE_AI_OVERAGE_PER_UNIT]]`, `[[PRICE_VIDEO_OVERAGE_PER_UNIT]]`) | Owner rule: no price in code or documents. The administered catalog is the only home for a number. | Set the catalog; the agreement references "the price shown at checkout and in the Order". | No price anywhere; checkout refuses an unconfigured price. | Packet 1 §5.1, this packet §10. |
| D8 | Retention and deletion (`[[POST_TERMINATION_RETENTION_DAYS]]`, `[[EXPORT_WINDOW_DAYS]]`, `[[DATA_RETENTION_YEARS_TRANSACTION]]`, `[[SOURCE_RECORD_RETENTION_DAYS]]`, `[[LOG_RETENTION_DAYS]]`, `[[BACKUP_RETENTION_DAYS]]`) | A retention promise the code cannot keep is a breach on day one. Today: review-only document retention, DSAR de-identification, tenant export; no scheduled deletion of raw records or logs, no post-termination deletion job. | Choose periods and fund the jobs; or promise only what exists. | The drafts promise only what exists and mark the rest. | Packet 1 §9, §13; Packet 3 §7; Packet 4 Part E. |
| D9 | Incident notice and contacts (`[[INCIDENT_NOTICE_HOURS]]`, `[[SECURITY_CONTACT_EMAIL]]`, `[[PRIVACY_CONTACT_EMAIL]]`, `[[DPO_OR_PRIVACY_OFFICER]]`, `[[ABUSE_CONTACT_EMAIL]]`, `[[PLATFORM_NOTICE_ADDRESS]]`, `[[PLATFORM_NOTICE_EMAIL]]`) | No automated breach-notification workflow exists; the notice window is a staffing commitment. State deadlines run from discovery. | Seventy-two hours is common for a processor; shorter is a differentiator and a burden. | Publication refused until contacts exist. | Packet 1 §12.6, §13.1; Packet 4 Parts A, B, G. |
| D10 | Cross-tenant aggregate use (`[[CROSS_TENANT_AGGREGATE_USE]]`) | Whether the platform may learn from de-identified, aggregated telemetry across tenants. Per-tenant learning exists; cross-tenant is a product decision with privacy consequences. | None; aggregated and de-identified only; named categories. | Per-tenant only. | Packet 1 §9.2; Packet 4 Parts A, F. |
| D11 | AI vendor retention (`[[AI_VENDOR_RETENTION_TERMS]]`) | The gateway and model vendors retain prompts per their terms; the notice must say what they do, which counsel reads from the vendor terms. | Zero-retention tiers where available; standard terms disclosed. | Disclosed as "per vendor terms" only after counsel reads them. | Packet 1 §9.3; Packet 4 §A.4, Part D. |
| D12 | Hosting region and backups (`[[HOSTING_REGION]]`, `[[BACKUP_RETENTION_DAYS]]`) | The repository does not record the region or the backup window; both are project settings in the hosting consoles. | Read them from the consoles and record them. | Publication refused. | Packet 4 Part B §B.6, §B.11, Part E. |
| D13 | Subprocessor change notice and audit (`[[SUBPROCESSOR_NOTICE_DAYS]]`, `[[AUDIT_RIGHTS_SCOPE]]`, `[[DELETION_CERTIFICATION]]`) | Standard DPA levers; each is a cost. | Thirty days' notice; questionnaire-based audit; written deletion confirmation on request. | Publication refused. | Packet 4 Part B. |
| D14 | Publicity and insurance (`[[PUBLICITY_CONSENT]]`, `[[INSURANCE_REQUIREMENTS]]`, `[[CONFIDENTIALITY_TERM_YEARS]]`) | Commercial preferences. | Opt-in publicity; cyber insurance named or none. | No publicity; no insurance requirement. | Packet 1 §10.2, §12.2, §21. |
| D15 | Territory unit and acquisition ceiling (`[[TERRITORY_DEFINITION]]`, `[[ACQUISITION_MONTHLY_CEILING_BY_TIER]]`) | The ceiling is the per-tier vendor budget the gate enforces; stating it is a disclosure of included usage, not a price. | State by tier; or state "as shown in the Service". | "As shown in the Service". | Packet 3 §3.5, §6.2. |
| D16 | Provider terms confirmation (`[[PROVIDER_TERMS_CONFIRMATION_DATE]]`) | Two active providers' terms are unread (RentCast) or unverified as signed (Versium); the code records this honestly and so do the drafts. | Counsel reads and confirms; or the owner accepts the risk in writing. | Publication refused for Packet 3 §4. | Packet 3 §4.2; Packet 6. |
| D17 | AI and advertising disclosure rules (`[[AI_DISCLOSURE_RULE]]`, `[[STATE_ADVERTISING_RULES]]`, `[[STATE_SMS_RULES]]`, `[[QUIET_HOURS_WINDOW]]`, `[[EQUAL_HOUSING_NOTICE]]`, `[[MLS_IDX_RULES]]`, `[[STATE_LIST]]`) | State-specific; see §4. | Counsel supplies per state in `[[STATE_LIST]]`. | Publication refused for the affected sections. | Packets 2, 4, 5. |
| D18 | Key rotation period and connection acceptance (`[[KEY_ROTATION_PERIOD_DAYS]]`, `[[CONNECTION_ACCEPTANCE_RECORD]]`) | The rotation monitor exists; the per-connection acceptance record does not. | Ninety days; build the record in the Settings → Connections lane. | Packet 6 §5.2–5.3 stay flagged. | Packet 6. |
| D19 | Agreement version and hash scheme (`[[AGREEMENT_VERSION]]`, `[[AGREEMENT_HASH]]`, `[[EFFECTIVE_DATE]]`) | The acceptance wiring needs a version identifier and a content hash; today `platform_settings.tos_version` is a date string with a code fallback. | Semantic version plus SHA-256 of the published text. | Set by the acceptance wiring lane. | Packet 1 §22, §25; §9 below. |

## 3. Unanswered legal and commercial placeholders (the variables table)

Every variable used in any packet, grouped. Status is OPEN unless the decision table records an answer or the value is per-subscriber or per-connection by nature.

| Variable | Group | Where used | Status |
|---|---|---|---|
| `[[PLATFORM_LEGAL_ENTITY]]` | Entity and contacts | All packets | OPEN — D1 |
| `[[PLATFORM_ENTITY_TYPE_AND_STATE]]` | Entity and contacts | Packet 1 | OPEN — D1 |
| `[[PLATFORM_PRODUCT_BRAND]]` | Entity and contacts | Packets 1, 4 | OPEN — read from settings |
| `[[PLATFORM_WEBSITE_URL]]` | Entity and contacts | Packets 1, 4 | OPEN |
| `[[PLATFORM_NOTICE_ADDRESS]]` | Entity and contacts | Packets 1, 4 | OPEN — D9 |
| `[[PLATFORM_NOTICE_EMAIL]]` | Entity and contacts | Packet 1 | OPEN — D9 |
| `[[PLATFORM_AUTHORIZED_SIGNATORY]]` | Entity and contacts | Packet 1 | OPEN |
| `[[PRIVACY_CONTACT_EMAIL]]` | Entity and contacts | Packets 3, 4 | OPEN — D9 |
| `[[SECURITY_CONTACT_EMAIL]]` | Entity and contacts | Packet 4 | OPEN — D9 |
| `[[ABUSE_CONTACT_EMAIL]]` | Entity and contacts | Packet 5 | OPEN — D9 |
| `[[DPO_OR_PRIVACY_OFFICER]]` | Entity and contacts | Packet 4 | OPEN — D9 |
| `[[SUBSCRIBER_LEGAL_ENTITY]]` | Per subscriber | All packets | PER-SUBSCRIBER |
| `[[SUBSCRIBER_AUTHORIZED_SIGNATORY]]` | Per subscriber | Packet 1 | PER-SUBSCRIBER |
| `[[SUBSCRIBER_BROKER_OF_RECORD]]` | Per subscriber | Packets 1, 2, 3, 5 | PER-SUBSCRIBER |
| `[[SUBSCRIBER_NOTICE_ADDRESS]]` | Per subscriber | Packet 1 | PER-SUBSCRIBER |
| `[[EFFECTIVE_DATE]]` | Versioning | Packets 1, 4 | PER-SUBSCRIBER / per version |
| `[[AGREEMENT_VERSION]]` | Versioning | Packet 1 | OPEN — D19 |
| `[[AGREEMENT_HASH]]` | Versioning | Packet 1 | OPEN — D19 |
| `[[CHANGE_NOTICE_DAYS]]` | Versioning | Packet 2 | OPEN |
| `[[GOVERNING_LAW]]` | Legal terms | Packet 1 | OPEN — D2 |
| `[[VENUE]]` | Legal terms | Packet 1 | OPEN — D2 |
| `[[DISPUTE_FORUM]]` | Legal terms | Packet 1 | OPEN — D2 |
| `[[ARBITRATION_PROVIDER]]` | Legal terms | Packet 1 | OPEN — D2 |
| `[[DISPUTE_INFORMAL_PERIOD_DAYS]]` | Legal terms | Packet 1 | OPEN — D2 |
| `[[CLASS_WAIVER]]` | Legal terms | Packet 1 | OPEN — D2 |
| `[[LIABILITY_CAP]]` | Legal terms | Packet 1 | OPEN — D3 |
| `[[SUPER_CAP]]` | Legal terms | Packet 1 | OPEN — D3 |
| `[[INDEMNITY_CAP]]` | Legal terms | Packet 1 | OPEN — D3 |
| `[[CONFIDENTIALITY_TERM_YEARS]]` | Legal terms | Packet 1 | OPEN — D14 |
| `[[INSURANCE_REQUIREMENTS]]` | Legal terms | Packet 1 | OPEN — D14 |
| `[[PUBLICITY_CONSENT]]` | Legal terms | Packet 1 | OPEN — D14 |
| `[[SLA]]` | Service terms | Packet 1 | OPEN — D4 |
| `[[SLA_CREDIT_SCHEDULE]]` | Service terms | Packet 1 | OPEN — D4 |
| `[[SUPPORT_HOURS]]` | Service terms | Packet 1 | OPEN — D4 |
| `[[SUPPORT_RESPONSE_TARGETS]]` | Service terms | Packet 1 | OPEN — D4 |
| `[[INITIAL_TERM]]` | Commercial | Packet 1 | OPEN — D5 |
| `[[RENEWAL_TERM]]` | Commercial | Packet 1 | OPEN — D5 |
| `[[NON_RENEWAL_NOTICE_DAYS]]` | Commercial | Packet 1 | OPEN — D5 |
| `[[TERMINATION_FOR_CAUSE_CURE_DAYS]]` | Commercial | Packet 1 | OPEN |
| `[[PAYMENT_DUE_DAYS]]` | Commercial | Packet 1 | OPEN — D6 |
| `[[LATE_FEE_RATE]]` | Commercial | Packet 1 | OPEN — D6 |
| `[[TRIAL_LENGTH_DAYS]]` | Commercial | Packet 1 | OPEN — D6 |
| `[[PAST_DUE_GRACE_DAYS]]` | Commercial | Packet 1 | OPEN — D6 (code: seven days) |
| `[[PRICE_SOLO_MONTHLY]]` | Prices | Packet 1, this packet §10 | OPEN — D7, never written |
| `[[PRICE_TEAM_MONTHLY]]` | Prices | Packet 1, this packet §10 | OPEN — D7 |
| `[[PRICE_BROKERAGE_MONTHLY]]` | Prices | Packet 1, this packet §10 | OPEN — D7 |
| `[[PRICE_MULTI_LOCATION]]` | Prices | Packet 1, this packet §10 | OPEN — D7 |
| `[[PRICE_ANNUAL_DISCOUNT]]` | Prices | Packet 1, this packet §10 | OPEN — D7 |
| `[[PRICE_SETUP_FEE]]` | Prices | Packet 1, this packet §10 | OPEN — D7 |
| `[[PRICE_SEAT_PACKAGE]]` | Prices | Packet 1, this packet §10 | OPEN — D7 |
| `[[PRICE_AI_OVERAGE_PER_UNIT]]` | Prices | Packet 1, this packet §10 | OPEN — D7 |
| `[[PRICE_VIDEO_OVERAGE_PER_UNIT]]` | Prices | Packet 1, this packet §10 | OPEN — D7 |
| `[[POST_TERMINATION_RETENTION_DAYS]]` | Data and retention | Packets 1, 4 | OPEN — D8 |
| `[[EXPORT_WINDOW_DAYS]]` | Data and retention | Packets 1, 4 | OPEN — D8 |
| `[[DATA_RETENTION_YEARS_TRANSACTION]]` | Data and retention | Packets 1, 3, 4 | OPEN — D8 |
| `[[SOURCE_RECORD_RETENTION_DAYS]]` | Data and retention | Packets 3, 4 | OPEN — D8 (no code) |
| `[[LOG_RETENTION_DAYS]]` | Data and retention | Packet 4 | OPEN — D8 (no code) |
| `[[BACKUP_RETENTION_DAYS]]` | Data and retention | Packet 4 | OPEN — D12 |
| `[[HOSTING_REGION]]` | Data and retention | Packet 4 | OPEN — D12 |
| `[[DELETION_CERTIFICATION]]` | Data and retention | Packet 4 | OPEN — D13 |
| `[[INCIDENT_NOTICE_HOURS]]` | Security | Packets 1, 2, 4 | OPEN — D9 |
| `[[SUBPROCESSOR_NOTICE_DAYS]]` | Security | Packet 4 | OPEN — D13 |
| `[[AUDIT_RIGHTS_SCOPE]]` | Security | Packet 4 | OPEN — D13 |
| `[[KEY_ROTATION_PERIOD_DAYS]]` | Security | Packet 6 | OPEN — D18 |
| `[[CROSS_TENANT_AGGREGATE_USE]]` | AI and data use | Packets 1, 3, 4 | OPEN — D10 |
| `[[AI_VENDOR_RETENTION_TERMS]]` | AI and data use | Packets 1, 4 | OPEN — D11 |
| `[[AI_DISCLOSURE_RULE]]` | State rules | Packets 2, 5 | OPEN — D17 |
| `[[STATE_ADVERTISING_RULES]]` | State rules | Packet 5 | OPEN — D17 |
| `[[STATE_SMS_RULES]]` | State rules | Packet 5 | OPEN — D17 |
| `[[QUIET_HOURS_WINDOW]]` | State rules | Packet 5 | OPEN — D17 |
| `[[EQUAL_HOUSING_NOTICE]]` | State rules | Packet 5 | OPEN — D17 |
| `[[MLS_IDX_RULES]]` | State rules | Packet 5 | PER-SUBSCRIBER |
| `[[STATE_LIST]]` | State rules | Packet 4 | OPEN — D17 |
| `[[COOKIE_AND_ANALYTICS_DISCLOSURE]]` | Privacy notice | Packet 4 | OPEN |
| `[[DSR_RESPONSE_DAYS]]` | Privacy notice | Packets 3, 4 | OPEN (code: forty-five) |
| `[[TERRITORY_DEFINITION]]` | Acquisition | Packets 3, 6 | OPEN — D15 |
| `[[ACQUISITION_MONTHLY_CEILING_BY_TIER]]` | Acquisition | Packet 3 | OPEN — D15 |
| `[[PROVIDER_TERMS_CONFIRMATION_DATE]]` | Providers | Packets 3, 6 | OPEN — D16 |
| `[[PROVIDER_NAME]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[PROVIDER_TERMS_URL]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[PROVIDER_ACCOUNT_ID]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[CONNECTION_OWNER_NAME]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[CONNECTION_OWNER_SCOPE]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[CONNECTION_DATA_CATEGORIES]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[CONNECTION_REFRESH_SCHEDULE]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[CONNECTION_DELETION_TERMS]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[CONNECTION_INCIDENT_CONTACT]]` | Per connection | Packet 6 | PER-CONNECTION |
| `[[CONNECTION_ACCEPTANCE_RECORD]]` | Per connection | Packet 6 | OPEN — D18 (no code) |

## 4. State-specific review checklist

Counsel completes one column per state in `[[STATE_LIST]]`. Each row names the rule class, why it touches these documents, and which clause it lands in. The code behaviors in the right-hand column are what the Service does regardless of state; the state's rule may require more.

| # | Rule class | Why it matters here | Clause | What the code already does |
|---|---|---|---|---|
| S1 | Real estate license law — advertising: brokerage identification, agent license display, team naming, "coming soon" rules | Every mailer, email, ad and tenant site the Service produces is an advertisement by a licensee. | Packet 5 §6.2; Packet 1 §6.1 | Merge variables for brokerage identity and license line on mail pieces (`lib/direct-mail/piece-type.ts`). |
| S2 | Agency and brokerage-relationship disclosures (for example a state-mandated information-about-brokerage-services form or consumer-protection notice) | The Service drafts first contact; the disclosure timing is the licensee's. | Packet 5 §6.5 | Not automated; counsel decides whether a reminder belongs in the first-touch flow. |
| S3 | Record retention periods for transaction and brokerage records | Drives `[[DATA_RETENTION_YEARS_TRANSACTION]]` and the deletion schedule. | Packet 1 §13.2; Packet 4 Part E | Category defaults of five and seven years, review-only (`lib/kernel/document-custody.ts`). |
| S4 | Telemarketing and text-message acts beyond federal law (state consent standards, state do-not-call lists, state quiet hours, per-day limits, registration of telephone solicitors) | The AI ISA texts and calls on consent; several states have their own acts with private rights of action. | Packet 5 §4.2; `[[STATE_SMS_RULES]]`, `[[QUIET_HOURS_WINDOW]]` | Express written consent, federal do-not-call, litigator scrub, quiet hours by the person's state, restricted-state list (`lib/communication/tcpa-gate.ts`). |
| S5 | Email marketing (state anti-spam statutes) | Newsletters and sequences. | Packet 5 §4.3 | Unsubscribe link and one-click header, suppression at every send. |
| S6 | Comprehensive consumer privacy law (notice content, rights, response deadlines, sensitive data consent, service-provider contract terms, opt-out signals) | Packet 4 must name the states and the deadlines; the DPA must carry each state's required processor terms. | Packet 4 Parts A, B, H; `[[DSR_RESPONSE_DAYS]]` | Forty-five-day clock, identity verification, export, de-identification, denial with basis (`app/actions/privacy/data-subject-requests.ts`). |
| S7 | Data breach notification (definition of personal information, deadline from discovery, regulator and consumer notice, content) | Sets `[[INCIDENT_NOTICE_HOURS]]` so the platform's notice leaves the subscriber time to meet its own deadline. | Packet 1 §12.6; Packet 4 Part G | Detection and halt rails exist; notification is manual. |
| S8 | Electronic signatures and records (state adoption of the uniform electronic transactions act; any real-estate-specific e-signature rules) | Online acceptance of the agreement and the e-signature connections. | Packet 1 §25; Packet 6 Part 4 | Acceptance record (partial today); e-sign through the tenant's own account. |
| S9 | Automatic renewal and continuous-service laws (clear disclosure, affirmative consent, cancellation mechanism, renewal reminders) | Packet 1 §5.3 renews automatically. Several states require specific disclosures and a reminder before an annual renewal. | Packet 1 §5.3–5.4 | Cancellation through the billing page; price-change notice period is a variable. |
| S10 | Fair housing — state and local protected classes beyond federal (source of income, age, sexual orientation, gender identity, military status, and others by place) | Packet 5 §5.1's "additional class protected by the law of the place" needs the actual list per state and city. | Packet 5 §5 | Protected-class classifier and audience refusal (`lib/lead-governance/protected-class-signals.ts`); housing ads never narrow by age or income. |
| S11 | AI disclosure laws (bot-disclosure statutes, consumer-facing generative-AI disclosure, high-risk AI decision rules) | The AI ISA converses with consumers; some states require disclosure on request or proactively. | Packet 2 §5.6; Packet 5 §4.7; `[[AI_DISCLOSURE_RULE]]` | Disclosure available per channel; writing passes never remove it. |
| S12 | Automated valuation disclosures and appraisal law | Home-value estimates shown to consumers. | Packet 2 §6.2; Packet 5 §6.3 | Estimate with range, provider and time; nothing model-authored reaches an appraiser. |
| S13 | Team and branch office rules (branch licensing, broker of record per office, team advertising) | Multi-Location tier structures. | Packet 1 §4.5 | Locations, managing broker per location, explicit memberships (wave 150). |
| S14 | Referral and compensation rules (unlicensed referral fees, finder's fees) | Packet 3 §1.2 states no per-lead or commission term is owed to the platform; confirm no state treats included acquisition as a referral arrangement requiring disclosure. | Packet 3 §1 | No per-lead price exists in code. |
| S15 | Public records and skip-trace use restrictions (state limits on using driver, voter or court records for marketing) | The free public-records lane and dormant skip-trace providers. | Packet 3 §4.1, §4.5 | Attach-only permit facts; sensitive inferences never trigger outreach alone. |
| S16 | Direct mail solicitation disclosures (real estate solicitation statements, opt-out notices on mailers) | Every mailer. | Packet 5 §4.4 | Address-level suppression; brokerage-of-record return address. |
| S17 | Consumer-reporting law (state analogs to the federal act; "non-FCRA" boundary) | Provider data must never be used for eligibility decisions. | Packet 3 §4.3; Packet 5 §3.2 | Non-FCRA line recorded on the provider rows. |
| S18 | Sales and use tax on software-as-a-service | Packet 1 §5.5. | Packet 1 §5.5 | Tax collected through the processor where configured. |

## 5. Data-rights and autonomous-authority risk summary

| # | Risk | Where it comes from | Severity | What the code does today | What remains open |
|---|---|---|---|---|---|
| R1 | A seat user accepts the agreement for the brokerage | The live acceptance record keys on email and version only; it holds no signatory role, no entity and no hash (`app/actions/public/tos-acceptance.ts`). | High | Records who clicked and when. | Lane 151A's acceptance wiring: signatory identity and authority, entity, hash, immutable copy, download, re-acceptance. Packet 1 §25.2–25.3 is written to the target. |
| R2 | Two acceptance stores | `platform_tos_acceptances` (written by the app) and `privacy_acceptances` (exists live, written by nothing current) are two spellings of one record. | Medium | Both exist live. | Merge onto one survivor with a tombstone; lane 151A. |
| R3 | Active provider terms unread or unverified | RentCast's Terms of Use not read; Versium's signed partner terms unverified while its standard terms forbid caching and service-bureau use (`lib/ai-isa/property-lookup-rail.ts`). | High | Honestly recorded by name in the activation state. | Counsel reads both; D16. |
| R4 | Retention promises without jobs | No scheduled deletion of raw records or logs, no post-termination deletion job, no deletion certificate; retention classes per table are recorded as not yet enforced in the constitution. | Medium | Review-only document retention; DSAR de-identification; tenant export; nothing auto-deletes. | D8 decisions, then engineering. The drafts promise only what exists. |
| R5 | Export is staff-run, not self-serve | Tenant export is a superadmin-gated action (`lib/platform/tenant-export.ts`). | Low | The bundle exists and is honest about caps. | A self-serve surface, or "on request" wording accepted by counsel. |
| R6 | Vendor budget gate fails open | By design, so a broken budget read never silences a consented message (`lib/vendor-governance/budget-gate.ts`). | Low | Consumer-protection gates fail closed independently. | Stated plainly in Packet 2 §5.2 and §9.5; counsel confirms the description. |
| R7 | Ledger coverage is partial | Voice, push, portal and some AI tool calls are not yet through `withActionLedger` (constitution law 5: partial). | Medium | Email, text, direct mail and AI-placed calls are ledgered; waits are recorded. | Counsel may narrow Packet 2 §10.1's "every external action" until the coverage proof closes. |
| R8 | Reserved authority rungs | Levels 4 and 5 add no capability in code. | Low | Table says so. | None; do not promise them. |
| R9 | Halts fail open on infrastructure error | A transient fault never freezes or unfreezes the platform by accident (`lib/managers/autonomy-gate.ts`). | Low | Gates fail closed. | Disclosed in Packet 2 §9.5. |
| R10 | No per-connection terms confirmation or acceptance record | Packet 6 §5.2–5.3 describe records that do not exist. | Medium | Configuration, health, impact and rotation records exist. | Lane 151F (Settings → Connections). |
| R11 | Dormant provider doors | BatchData and PeopleData live doors await owner confirmation (wave 150). | Medium | Dormant survivor state recorded; no new transport. | Owner closes or keeps; Packet 3 lists both as dormant. |
| R12 | Protected-class data held on records | Demographic attributes are held and labeled, not deleted, by owner ruling. | Medium | Refusal only at ad-audience define and populate; housing ads never narrow by age or income. | Counsel checks the proxy list against current guidance (Packet 5 §5.2). |
| R13 | Sensitive inferences | Divorce, probate and distress signals are acquired from public records. | Medium | Stored with evidence class; never trigger outreach alone; situation personas govern wording only. | Confirm state restrictions on marketing from court records (S15). |
| R14 | No automated breach notification | Detection and halt rails exist; notification is a manual procedure. | Medium | Error collection, OS health supervisor, forbidden-class routing to a human. | Staff the procedure; set D9 accordingly. |
| R15 | Twin voice samples in a public bucket | The storage roster flags that a voice print is closer to biometric than to marketing and leaves the classification to the owner (`lib/storage/document-buckets.ts`). | Medium | Flagged in code as unresolved. | Owner decision; Packet 4 §B.3 describes the sample as voluntary and the user's own. |
| R16 | No model names in documents | Owner rule. | Low | Drafts name vendors only; the guard refuses model-name patterns. | None. |

## 6. Document versions and redline ledger

| Document | Version | Date | Author | Change |
|---|---|---|---|---|
| Packet 1 — Platform Subscription and Services Agreement | 0.1.0-draft | 2026-11-09 | lane 151A2 | First complete draft from code at `b2c93720`. |
| Packet 2 — Autonomous AI Operations and Authority Schedule | 0.1.0-draft | 2026-11-09 | lane 151A2 | First complete draft; every gate cited. |
| Packet 3 — Acquisition, Enrichment, Data Rights and Third-Party Integration Schedule | 0.1.0-draft | 2026-11-09 | lane 151A2 | First complete draft. |
| Packet 4 — Privacy Notice, DPA and Subprocessors | 0.1.0-draft | 2026-11-09 | lane 151A2 | First complete draft; subprocessor list derived from registries. |
| Packet 5 — Acceptable Use and Marketing Compliance | 0.1.0-draft | 2026-11-09 | lane 151A2 | First complete draft; persona and demographic rulings preserved. |
| Packet 6 — Tenant-Owned Provider Connection Schedule | 0.1.0-draft | 2026-11-09 | lane 151A2 | First complete draft; per-provider variations only where required. |
| This review packet | 0.1.0-draft | 2026-11-09 | lane 151A2 | First draft. |

**Redline procedure.** Counsel redlines in the Markdown files directly or in a copy. Each accepted redline bumps the document's patch version (0.1.1, 0.1.2 …) and adds a row here with the clause numbers changed and the reason. A change to a clause that cites code requires the engineer who owns that code to confirm the citation still holds; the guard checks the file and symbol exist, not that the sentence is still true. When counsel approves a document, its version becomes 1.0.0, the content hash is recorded in §7, and the banner is removed by the integrator in the same commit that records the approval.

## 7. Approved versus draft status

| Document | Status | Approved version | Content hash | Approval date | Approver |
|---|---|---|---|---|---|
| Packet 1 | DRAFT | — | — | — | — |
| Packet 2 | DRAFT | — | — | — | — |
| Packet 3 | DRAFT | — | — | — | — |
| Packet 4 (Part A — notice) | DRAFT | — | — | — | — |
| Packet 4 (Part B — DPA) | DRAFT | — | — | — | — |
| Packet 4 (Part C — subprocessors) | DRAFT | — | — | — | — |
| Packet 5 | DRAFT | — | — | — | — |
| Packet 6 | DRAFT | — | — | — | — |

Nothing in this table may read APPROVED until the sign-off sheet below is complete for that document and the acceptance wiring in §9 exists. Draft legal content cannot be activated as approved: the version the acceptance flow publishes must be one whose row here reads APPROVED, and the hash the flow records must equal the hash here.

## 8. Sign-off sheet

One block per document. A signature here is a statement that the signer has read the full text and approves it for publication in the version named, not a statement that the signer wrote it.

| Role | Name | Document(s) | Version approved | Date | Signature |
|---|---|---|---|---|---|
| Owner | | Packets 1–6 | | | |
| Qualified legal counsel (commercial) | | Packets 1, 2, 3, 5, 6 | | | |
| Qualified legal counsel (privacy) | | Packet 4 | | | |
| Qualified legal counsel (real estate regulatory) | | Packets 2, 3, 5 and the state checklist | | | |
| Privacy officer / data-protection lead | | Packet 4 | | | |
| Security lead | | Packet 4 Parts B, F, G; Packet 1 §12 | | | |
| Engineering lead (citations) | | Packets 2, 3, 4, 6 — every cited file and symbol still describes the behavior | | | |
| Product owner (pricing and tiers) | | Packet 1 §4–5; §10 of this packet | | | |

## 9. Publication and acceptance procedure

This section describes the procedure by concept. The acceptance wiring itself is lane 151A's work; the drafting lane writes no code for it.

**9.1 Preconditions.** For a document to be published: its §7 row reads APPROVED with a version and a content hash; every variable in §3 that the document uses has a recorded answer or is per-subscriber by nature; the DRAFT banner has been removed in the approval commit; and `npm run test:legal-packets` passes (it will then enforce the banner's absence being deliberate by reading the status table — the integrator adds that arm when the first document is approved).

**9.2 Versioning and hashing.** Each published agreement carries a version identifier (`[[AGREEMENT_VERSION]]`) and the SHA-256 hash of its published text (`[[AGREEMENT_HASH]]`). The current version identifier is held where the code already reads it (`platform_settings.tos_version`); the hash and the immutable copy are new fields the wiring adds. A change to the text is a new version with a new hash, never an edit in place.

**9.3 Who accepts.** The accepting identity must be the subscriber's authorized signatory: the broker of record, an owner, officer or manager, or a person they designated in writing. The flow must refuse acceptance by an ordinary seat user for the corporate subscriber and must record the signatory's role and the subscriber entity on the acceptance record. An office seat user cannot sign as a brokerage. Platform staff never accept for a subscriber, including under impersonation.

**9.4 The acceptance record.** Each acceptance stores: subscriber entity; signatory identity and role; version identifier; content hash; the time; the network address and user agent of the session; the document set accepted (the agreement and each schedule by version); and a pointer to the immutable stored copy. The record is append-only. A subscriber may download its accepted copy and its record from the Service.

**9.5 Re-acceptance.** When a new version is published, the Service notifies the subscriber, and the authorized signatory re-accepts before the new version binds the subscriber (Packet 1 §22). Ordinary seat users see the existing re-acceptance banner as notice; their acknowledgment is recorded as notice, not as the subscriber's acceptance. The current banner (`app/components/layout/tos-reacceptance-banner.tsx`) is the survivor the wiring extends.

**9.6 Separate consents stay separate.** The subscriber's acceptance is not a Contact's marketing consent (recorded by `lib/kernel/compliance/require-contact-consent.ts::persistContactConsent`), is not a brokerage listing, buyer-representation or referral agreement, and is not a per-connection provider acceptance (Packet 6). Each has its own record and the wiring must not conflate them.

**9.7 One acceptance store.** The two live stores (`platform_tos_acceptances`, `privacy_acceptances`) converge on one survivor with a tombstone naming it, per the orphan doctrine; which one survives is the wiring lane's call.

**9.8 Publication surface.** The approved text is published at `[[PLATFORM_WEBSITE_URL]]` beside the existing copyright and licensing notice (`app/legal/page.tsx`), with its version and hash shown. The sign-up flow links to the exact version it will record.

**9.9 PDF previews.** The repository already renders PDFs: `pdf-lib` is a dependency and `lib/documents/client-document-producer.ts` is the one producer that writes client PDFs into the private documents bucket. A preview of an approved packet would be produced by rendering the Markdown to text or HTML and handing it to that producer (or a one-off script using the same library), stored in the documents bucket and served by signed URL. This lane adds no renderer; the note records the path so nobody builds a second one.

**9.10 Proof.** `scripts/legal-packets-guard.ts` runs in the guard chain and checks: every packet file exists and is substantive (required sections present, word count above a stated floor); the DRAFT banner is on the first lines of every file; no price literal appears outside a `[[PRICE_*]]` variable; no British spelling of license appears; no model name appears; every variable used in a file is listed in that file's variables table; every cited file path exists and every cited symbol is defined in it, read from comment-stripped source; and the subprocessor list names only providers present in the code's own registries. Each finder has a positive control.

## 10. Example tenant-facing packet (placeholder pricing)

*What a Team-tier brokerage would see at sign-up once the documents are approved. Every price is a placeholder; no amount is stated.*

> ### Your subscription — Team tier
>
> **Who is agreeing.** `[[SUBSCRIBER_LEGAL_ENTITY]]`, through its authorized signatory `[[SUBSCRIBER_AUTHORIZED_SIGNATORY]]` (`[[SUBSCRIBER_BROKER_OF_RECORD]]` is the broker of record). Only a person authorized to bind the brokerage may accept; an ordinary seat user cannot.
>
> **What you get.** The full operating system for your brokerage — CRM, transactions, marketing, the AI managers, acquisition and enrichment — for your Tier. The Team tier includes ten producing seats; staff seats (broker administrators, transaction coordinators, compliance officers) are free. If you need more producers you can upgrade, move down if your business changes, or buy a seat package.
>
> **What it costs.** `[[PRICE_TEAM_MONTHLY]]` billed monthly (or `[[PRICE_ANNUAL_DISCOUNT]]` billed annually), plus a one-time setup fee of `[[PRICE_SETUP_FEE]]` on your first invoice. Seat packages are `[[PRICE_SEAT_PACKAGE]]`. AI usage and video minutes above your Tier's included allowance are billed at `[[PRICE_AI_OVERAGE_PER_UNIT]]` and `[[PRICE_VIDEO_OVERAGE_PER_UNIT]]`. Lead acquisition and enrichment are included — there is no charge per lead, per record or per closing, and no commission or referral fee is ever owed to us.
>
> **Your trial.** `[[TRIAL_LENGTH_DAYS]]` days. Nothing is charged until you complete checkout.
>
> **Billing and renewal.** Your subscription renews automatically each `[[RENEWAL_TERM]]` until you cancel from the billing page. If a payment fails we tell you the same day and again over the following two weeks; your access continues for `[[PAST_DUE_GRACE_DAYS]]` days and nothing is deleted.
>
> **What the AI may do.** Each AI manager works at an authority level you set (default: full, with human approval for anything consequential). It can never sign, file or spend your money. Messages to your clients pass consent, do-not-call, quiet-hours, content and over-contact checks every time, and anything held for approval waits in your queue. You can pause any manager, lower its authority, or turn its autonomy off at any time. Every action it takes is recorded and you can read the record.
>
> **Your data.** Your contacts, leads, documents and content are yours. We process them only to run the Service for you and never to train general models. You can export your records at any time and for `[[POST_TERMINATION_RETENTION_DAYS]]` days after you leave. Your clients can ask us for their data at `[[PLATFORM_WEBSITE_URL]]/privacy/request`.
>
> **Your responsibilities.** You are the licensed professional. You obtain the consents the law requires before we contact anyone for you, you follow fair-housing and advertising rules, and you review what the AI drafts before it reaches a person where the Schedule says a person must.
>
> **The documents.** Platform Subscription and Services Agreement v`[[AGREEMENT_VERSION]]` (hash `[[AGREEMENT_HASH]]`) with Schedules 2–6. Governed by the law of `[[GOVERNING_LAW]]`; disputes in `[[VENUE]]` by `[[DISPUTE_FORUM]]`.
>
> ☐ I am authorized to bind `[[SUBSCRIBER_LEGAL_ENTITY]]` and I accept the Agreement and its Schedules.

> **Drafting note (not contract text).** The summary above is an aid to understanding and must say so when published; the agreement controls. Two things in it are deliberately restated from code so they stay true: the ten-seat Team band (`lib/billing/plan-catalog.ts`) and the dunning timing (`lib/billing/dunning.ts`). If either moves, this example moves with it.
