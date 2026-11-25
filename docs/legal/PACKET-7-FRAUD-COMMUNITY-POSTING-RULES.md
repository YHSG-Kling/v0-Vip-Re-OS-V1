> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Packet 7 — Schedule 7: Fraud & Trust Network Community Posting Rules (DRAFT — NOT PUBLISHED)

Version: 0.1.0-draft (2026-11-25) · Document ID: VIP-LEGAL-P7 · Wave 156, lane 156J · Written against commit `b261c474` plus lane 156J

This Schedule would be incorporated into the Platform Subscription and Services Agreement (Packet 1). It states how `[[SUBSCRIBER_LEGAL_ENTITY]]` and its Authorized Users may report suspected real estate fraud to `[[PLATFORM_LEGAL_ENTITY]]`, how shared warnings are written and published, and how a person or business named in a warning may ask for a correction. It is a draft for counsel. It is not published, and nothing in the Service presents it to a subscriber as binding text until the sign-off procedure in `docs/operations/LEGAL-REVIEW-PACKET.md` is complete for it.

> **Drafting note.** The owner asked for "a community area that all tenants can share any known fraudsters in real estate". A list of people labelled as fraudsters invites defamation claims, can amount to a consumer report under the Fair Credit Reporting Act (15 U.S.C. §1681a(d), which defines a consumer report as a communication bearing on a person's character, general reputation or personal characteristics used or expected to be used for eligibility decisions — read at law.cornell.edu on 2026-11-25), and invites automatic denial of housing or service. The design below therefore shares scam TACTICS, keeps every report private, and admits a name only as a faithful official government warning after legal review. The Federal Trade Commission's FCRA overview page could not be read on 2026-11-25 (not verified); counsel should confirm the analysis against the current statute and agency guidance.

## Variables

| Variable | Meaning | Status |
|---|---|---|
| `[[PLATFORM_LEGAL_ENTITY]]` | The contracting platform entity (Packet 1). | OPEN |
| `[[SUBSCRIBER_LEGAL_ENTITY]]` | The subscriber (Packet 1). | PER-SUBSCRIBER |
| `[[CASE_RETENTION_PERIOD]]` | How long a private incident case is kept before deletion. The code default is 730 days (`lib/fraud-network/network.ts::FRAUD_CASE_RETENTION_DAYS`); counsel confirms or changes it. | OPEN |
| `[[CORRECTION_RESPONSE_DAYS]]` | The number of days within which platform safety staff answer a correction or dispute request. | OPEN |
| `[[CORRECTIONS_CONTACT]]` | The postal and email address a person outside the platform uses to request a correction. | OPEN |
| `[[GOVERNING_LAW]]` | The law governing this Schedule (Packet 1). | OPEN |
| `[[AUTHORITATIVE_SOURCE_POLICY]]` | Which official sources count as authoritative for a named warning. The code accepts https government hosts only (`lib/fraud-network/network.ts::isAuthoritativeCitation`). | OPEN |

---

## 1. Purpose and what this is not

1.1 The Fraud & Trust Network lets subscribers protect their clients by (a) reporting a suspected fraud incident privately to platform safety staff and (b) reading moderated warnings that describe how a scam works and how to verify safely.

1.2 The Network is not a list of people, businesses or addresses, is not a reputation or credit service, and must not be used to decide whether any person is eligible for housing, credit, insurance, employment or any service. No warning, report or match causes the Service to deny, block or cancel a transaction, a vendor relationship or an account; the Service has no such function (`lib/fraud-network/network.ts::proposeWireVerificationTasks` only proposes a verification task).

1.3 Information in the Network is never marketing data. It is not used to enrich contacts, build audiences, score people or acquire leads.

## 2. Who may take part

2.1 Authorized Users holding a tenant staff seat may read published warnings, file private reports, follow their own reports and subscribe to warnings by type or place (`lib/fraud-network/network.ts::FRAUD_NETWORK_PARTICIPANT_USER_TYPES`). Client and vendor portal users do not take part.

2.2 A private report is readable only by the person who filed it, the subscriber's designated case reviewers (`lib/fraud-network/network.ts::FRAUD_CASE_REVIEWER_USER_TYPES`) and platform safety staff (`lib/fraud-network/network.ts::mayReadCase`).

## 3. Filing a private report

3.1 A report describes what happened, when, through which channel, whether a loss occurred, the steps already taken and any police, IC3, FTC or regulator report numbers. A report may name a transaction or listing only if the reporting user may already work that record.

3.2 Users must not enter full bank account, routing, card or government identification numbers; at most the last four digits of an account may be recorded (`lib/fraud-network/network.ts::validateIncident`).

3.3 Evidence files stay with the subscriber. The Service records a cryptographic fingerprint of each file, its kind and a short label. A storage location for evidence files is not yet enabled, and the Service says so to the user (`lib/fraud-network/network.ts::EVIDENCE_STORAGE_NOT_ENABLED`).

3.4 A report is deleted at the end of `[[CASE_RETENTION_PERIOD]]`, together with its fingerprints and its links to any warning (`lib/fraud-network/network.ts::purgeExpiredFraudCases`). A subscriber's departure deletes its reports; a warning that drew on them keeps no link to them.

3.5 The reporter may withdraw a report while it is under review and may appeal a moderation outcome.

## 4. How a shared warning is written and published

4.1 Only platform safety staff publish a warning, through one recorded publication step (`lib/fraud-network/network.ts::publishBulletin`). No automated system writes, classifies, names or publishes a warning.

4.2 Each warning carries one claim class: an unverified report, a verified operational pattern, or an official public warning (`lib/fraud-network/network.ts::FRAUD_CLAIM_CLASSES`). A report is never presented as proof.

4.3 A warning describes a tactic, its red flags and how to verify safely. It must not contain an email address, phone number, account or identity number, web link in its text, or street address, and the publishing staff member confirms that it identifies no private person, client, account or home address (`lib/fraud-network/network.ts::publicationRefusal`).

4.4 A warning may name a person or business only when an official public agency has specifically named it, the warning reproduces that official description faithfully, an authoritative citation is stored, and legal review is recorded (`supabase/migrations/m1035-fraud-intelligence-network.sql`, constraint fraud_bulletins_named_entity_rule).

4.5 The reporting subscriber is not identified in a warning unless it chose to be credited when filing.

4.6 Several reports count as corroboration only when they come from different subscribers with different evidence (`lib/fraud-network/network.ts::independentCorroboration`). Repeated reports from one subscriber, reads and clicks never raise corroboration. There is no voting, ranking of people or search of allegations by person.

## 5. Corrections, disputes and takedown

5.1 Any subscriber may request a correction of a published warning from the warning itself. A person or business named in a warning, or anyone outside the platform, may request a correction through platform support or at `[[CORRECTIONS_CONTACT]]`; staff record each request (`lib/fraud-network/network.ts::recordSubjectCorrection`).

5.2 Platform safety staff answer within `[[CORRECTION_RESPONSE_DAYS]]` days by correcting the warning, taking it down, or declining with reasons. Every earlier version is kept in the correction history (`lib/fraud-network/network.ts::correctBulletin`).

5.3 A takedown removes the warning from every subscriber's view and withdraws every educational topic the Network created from it (`lib/fraud-network/network.ts::takeDownBulletin`).

## 6. Using a warning safely

6.1 A match between a warning and a live transaction is a reason to verify, never a conclusion about anyone. The Service proposes a high-priority task to call the title company, escrow holder or closing attorney back on a number obtained independently of the suspicious message, and to confirm before any funds move.

6.2 A subscriber may add a published warning's general consumer-protection question to its own content topic pool; no detail from the warning or any report is carried over (`lib/fraud-network/network.ts::addBulletinToTopicPool`).

## 7. Subscriber obligations

7.1 Subscriber reports in good faith, states only facts it has, and does not use the Network to harass, retaliate against or disparage any person or competitor.

7.2 Subscriber remains responsible for its own legal reporting obligations (for example to law enforcement, regulators and its errors-and-omissions carrier); filing a report in the Network does not satisfy them.

7.3 This Schedule is governed by `[[GOVERNING_LAW]]`.

> **Drafting note — what counsel must decide.** (1) Whether any warning class or field could make the platform a consumer reporting agency, and whether the design above is sufficient to avoid that. (2) The retention period and the correction response time. (3) Defamation exposure for unverified-report warnings that name no one but describe a recognizable event, and whether unverified reports should be published at all. (4) The authoritative-source policy for named warnings. (5) State privacy law treatment of incident evidence and alleged-contact indicators. (6) Whether a named subject's correction channel needs a published address and notice text before the Network is opened to subscribers.
