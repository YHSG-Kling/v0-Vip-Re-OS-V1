> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Packet 5 — Schedule 5: Acceptable Use and Marketing Compliance Policy

Version: 0.1.0-draft (2026-11-09) · Document ID: VIP-LEGAL-P5 · Wave 151, lane 151A2 · Written against commit `b2c93720`

This Schedule is incorporated into the Platform Subscription and Services Agreement (Packet 1). It states what `[[SUBSCRIBER_LEGAL_ENTITY]]` and its Authorized Users may and may not do with the Service, its sources, its communication channels, housing advertising, content, listing photographs and connected provider accounts. A breach of this Schedule is a material breach of the Agreement and the basis for suspension under Packet 1 §5.9.

**What this Schedule is not.** It is not a refusal of legitimate research about the people a brokerage serves, and it is not a rule that strips demographic or situational data from records. Holding and using such information to understand a person's situation and to choose helpful content and a suitable channel is lawful and is how the Service works. The rules below attach to **acts** — targeting a housing advertisement by a protected class, contacting a person without the consent the law requires, misstating a fact, using a photograph without rights — and never to the existence of a field or a label.

## Variables

| Variable | Meaning | Status |
|---|---|---|
| `[[PLATFORM_LEGAL_ENTITY]]` | The contracting platform entity (Packet 1). | OPEN |
| `[[SUBSCRIBER_LEGAL_ENTITY]]` | The subscriber (Packet 1). | PER-SUBSCRIBER |
| `[[SUBSCRIBER_BROKER_OF_RECORD]]` | The licensed broker responsible for the subscriber's real estate activity. | PER-SUBSCRIBER |
| `[[AI_DISCLOSURE_RULE]]` | The disclosure required when a consumer interacts with an automated system or receives AI-generated content, per state. | OPEN |
| `[[STATE_ADVERTISING_RULES]]` | The real estate advertising rules (license display, brokerage identification, team naming) of each state in which the subscriber operates; counsel supplies them. | OPEN |
| `[[STATE_SMS_RULES]]` | State telemarketing and text-message rules that exceed federal law (for example state telephone-solicitation acts with their own consent and quiet-hour rules). | OPEN |
| `[[QUIET_HOURS_WINDOW]]` | The hours during which calls and texts are not placed, by the person's local time; the code applies a window by state and this variable states it in the policy. | OPEN |
| `[[MLS_IDX_RULES]]` | The display, attribution, refresh and takedown rules of the subscriber's multiple-listing service for IDX content. | PER-SUBSCRIBER |
| `[[EQUAL_HOUSING_NOTICE]]` | The equal-housing logo and statement required on the subscriber's advertising. | OPEN |
| `[[ABUSE_CONTACT_EMAIL]]` | The address for reporting a violation of this Schedule. | OPEN |

---

## 1. Scope and responsibility

1.1 This Schedule binds `[[SUBSCRIBER_LEGAL_ENTITY]]`, every Authorized User, and every portal user Subscriber invites. Subscriber is responsible for their compliance as for its own.

1.2 `[[SUBSCRIBER_BROKER_OF_RECORD]]` is responsible for every advertisement, communication, estimate and document the Service produces or sends for Subscriber, whether a person or an AI Manager drafted it, and for supervising Subscriber's agents as the license law requires.

1.3 The Service enforces many of the rules below in code — consent, suppression, do-not-call, quiet hours, content checks, audience gates, photo provenance. Enforcement in code assists Subscriber; it does not transfer responsibility, and it cannot supply a consent, a license or a right Subscriber does not have.

## 2. Account and access rules

2.1 Each Authorized User uses their own credentials. Subscriber will not share credentials, share a producing Seat among several agents, or allow anyone who is not an Authorized User or an invited portal user to operate the Service.

2.2 Subscriber will not probe, scan or test the vulnerability of the Service except through the responsible-disclosure channel in Schedule 4 Part G; will not attempt to access another Tenant's data, a Platform staff surface or any record its role does not expose; will not circumvent a gate, a rate limit, an authority level, a suppression or a halt; and will not alter a policy row other than through the Service's own settings.

2.3 Subscriber will not copy, scrape, crawl, mirror, frame, reverse engineer, decompile or build a competing product from the Service, as stated in the copyright and licensing notice the Service displays (`lib/branding/platform-rights-notice.ts::platformRightsNotice`) and in Packet 1 §10.3.

2.4 Subscriber will not upload or transmit malware, unlawful content, or content that infringes a third party's rights; will not use the Service to harass, threaten, defraud or impersonate; and will not use the Service for any purpose other than its own lawful real estate business.

## 3. Source use

3.1 **Permitted sources.** Subscriber may use, through the Service, the sources the Service offers: Platform-Owned Provider data within the ceiling and the purpose of each capability; its own Tenant-Connected Provider data under that Provider's terms; its own first-party data; and consented inbound data. Schedule 3 §4 states the collection rules and the rights status of each Provider.

3.2 **Prohibited source use.** Subscriber will not (a) import or upload a list it does not have the right to use for the purpose; (b) use any Provider data, acquired record, enrichment or score as a consumer report or for any decision about a person's eligibility for credit, insurance, rental housing or employment — the data is non-FCRA and the Service is not a consumer reporting agency; (c) resell, sublicense, export in bulk to a third party or combine Provider data into a list for sale; (d) use Provider data to re-identify a person the Service has de-identified; (e) use a source in a territory where Subscriber is not licensed to practice; or (f) instruct the Service to collect from a source whose terms prohibit it or by bypassing an access control.

3.3 **Research is permitted; invention is not.** Subscriber may research the people and properties it serves, hold the situational and demographic facts the Service surfaces, and use them to understand needs and choose helpful content. Subscriber will not represent an inference as a fact the person stated, will not invent a personal identity, private event, intention or transaction date, and will not treat a market-level signal as identifying a person.

## 4. Marketing communications

4.1 **Consent before contact.** Subscriber will obtain and record the consent the law requires before the Service contacts a person on a channel, and will keep the evidence. The Service records a person's consent with the wording shown, its hash and version, the channels the wording names, the purposes agreed to, the source, the time and the network address (`lib/kernel/compliance/require-contact-consent.ts::persistContactConsent`). The standard consent wording the Service offers for its forms is `lib/kernel/compliance/require-contact-consent.ts::TCPA_CONSENT_TEXT`; Subscriber may use its own wording with counsel's approval and the Service will record whatever wording was shown.

4.2 **Texts and calls (TCPA and state law).** Subscriber will not text or call a person using the Service without the person's prior express written consent for marketing texts and calls, except as the law permits; will honor the national and state do-not-call registries and Subscriber's own internal do-not-call list; will not contact a number flagged as a litigator; will observe `[[QUIET_HOURS_WINDOW]]` by the person's local time and `[[STATE_SMS_RULES]]`; and will identify itself in every message. The Service enforces these at every send and before every AI-placed call: express written consent and do-not-call status, quiet hours by the person's state, reassigned-number staleness and a live re-verification of a stale verdict (`lib/communication/tcpa-gate.ts::enforceTCPACompliance`, `lib/communication/call-compliance.ts::checkQuietHours`). An unconverted Lead is never texted or called by the Service at all; Leads receive email and direct mail only until consent is recorded.

4.3 **Email (CAN-SPAM and state law).** Every marketing email the Service sends carries Subscriber's true identity, a valid physical postal address, a working unsubscribe link and the one-click unsubscribe header, and uses no deceptive subject line or header. Subscriber will honor an unsubscribe within the period the law requires; the Service honors it at the next send. Subscriber will not send to a purchased address list without a lawful basis for each address.

4.4 **Direct mail.** A mailer is printed on a blank layout carrying Subscriber's brand, Subscriber's license line and Subscriber's brokerage-of-record return address, and never Platform's address (`lib/direct-mail/piece-type.ts`). The Service suppresses a mailing address that has asked not to receive mail. Subscriber will include the disclosures its state requires on real estate solicitations.

4.5 **Honoring a request to stop.** A STOP, unsubscribe, do-not-call request, portal preference or verbal request is a withdrawal of consent for that channel. Subscriber will record it at once; the Service writes it before acknowledging and refuses every channel's next send that it covers (`lib/kernel/compliance/check-suppression.ts::addSuppression`, `lib/kernel/compliance/check-suppression.ts::checkSuppression`). A person on the platform-wide suppression list may not be contacted by any Subscriber on any channel (`lib/platform/suppression-list.ts`). Subscriber will not re-import, re-acquire or re-consent a suppressed person to get around the suppression.

4.6 **Frequency and de-confliction.** Subscriber will not over-contact a person. The Service limits touches per person across channels and senders within a window (`lib/kernel/deconflict/index.ts::evaluateDeconflict`); Subscriber will not split a person across records, senders or channels to defeat it.

4.7 **Automated and AI-assisted communications.** Where `[[AI_DISCLOSURE_RULE]]` requires it, Subscriber will disclose that a consumer is interacting with an automated system or receiving AI-generated content, using the disclosure the Service offers for the channel or its own. The Service's writing passes remove machine tells and apply Subscriber's voice; they never remove a legally required disclosure.

4.8 **Content checks on every send.** Every outbound message passes a content compliance check for fair-housing and consumer-protection violations (`lib/kernel/communication-compliance.ts::evaluateOutboundCompliance`) and, when sent unattended by an AI Manager, a second independent fair-housing backstop that hard-blocks (`lib/providers/content-safety.ts::contentSafetyBackstop`). A hard block is not sent; a warning is sent with its audit row. Subscriber will not rewrite a blocked message to evade the check.

## 5. Housing advertising delivery and fair housing

5.1 **The rule.** Subscriber will comply with the Fair Housing Act, the Equal Credit Opportunity Act where applicable, and state and local anti-discrimination law in every advertisement, listing description, communication and audience decision. Subscriber will not make, print or publish, or cause to be made, printed or published, any advertisement with respect to the sale or rental of a dwelling that indicates any preference, limitation or discrimination based on race, color, religion, sex, handicap, familial status or national origin, or any additional class protected by the law of the place where the dwelling is located or the advertisement is delivered, or that indicates an intention to make any such preference, limitation or discrimination.

5.2 **Audiences for housing advertisements.** Subscriber will not define, populate, include or exclude an advertising audience for a housing advertisement by a protected class or a proxy for one — including age (other than the broad adult range the platforms require), familial status, ZIP code or neighborhood used as a proxy, income, language, national origin, religion, disability or sex. The Service refuses, on both the define side and the populate side, any audience rule that segments on a protected-class source (`lib/lead-governance/protected-class-signals.ts::assertAudienceSegmentationAllowed`, `lib/lead-governance/protected-class-signals.ts::screenProtectedClassCriteria`) and refuses to launch an ad whose targeting narrows age or applies an income cut (`lib/ads/connectors/ad-payload.ts::validateAdReadiness`). An automation never excludes an audience on its own initiative; exclusion is an operator's declared decision and is gated when the operator makes it.

5.3 **Personas are permitted; demographic targeting is not.** A **situation persona** — a senior considering a smaller home, a military family facing a move, an heir to a probate property, an owner going through a divorce — is a label about the situation a person is in, and Subscriber may use it to choose the wording, the educational content and the tone that fit that situation, including as an inclusion basis at the Service's persona filter. That is not a prohibited preference; it is how the Service writes to people as themselves. What Subscriber may not do is send a raw demographic attribute — an age threshold, a marital-status flag, a senior-owner list, a household-income band — to an advertising platform as a targeting criterion, or express a preference for or against a protected class in the advertisement's content. The Service keeps the two apart by operation, not by deleting the data.

5.4 **Housing for older persons.** Subscriber will not describe a property or community as fifty-five-plus, senior living, active adult or similar unless the housing qualifies for the housing-for-older-persons exemption and Subscriber has recorded the verification. The Service checks such a claim in a marketing script against Subscriber's recorded exemption and does not assume it (`lib/compliance/fair-housing-older-persons.ts::assessOlderPersonsClaim`).

5.5 **Equal housing notice.** Subscriber will display `[[EQUAL_HOUSING_NOTICE]]` on its advertising as the law and its board require.

5.6 **Ad lead forms.** A lead form Subscriber runs on an advertising platform must carry the privacy disclosure and the consent language the law requires, and Subscriber will record that the form's legal content was verified; the Service records the verification state of each ad lead form and treats an unverified form as not provided (`supabase/migrations/m978-ad-lead-form-legal-content.sql`).

5.7 **Writing with fair housing in the prompt.** AI-drafted marketing copy and video scripts are written with the fair-housing directive in the writing prompt and checked after the draft (`lib/video/script-compliance.ts::precheckBriefForFairHousing`); a hard flag escalates to a person. Subscriber will not instruct an AI Manager to produce content a human could not lawfully write.

## 6. Content accuracy and professional advertising rules

6.1 **Truthful advertising.** Every statement about a property, a market, a price, a service, Subscriber's experience or results must be true and not misleading. Subscriber will not advertise a property it does not have authority to advertise, will not advertise a price other than the one the owner authorized, and will promptly withdraw an advertisement when the authority ends.

6.2 **License and brokerage identification.** Every advertisement and solicitation the Service produces for Subscriber will carry the identification `[[STATE_ADVERTISING_RULES]]` requires — the brokerage name as licensed, the agent's license identifier where required, team names in the form the state permits — and the Service's merge variables for the license line and brokerage identity exist for that purpose (`lib/direct-mail/piece-type.ts`). Subscriber supplies the correct values and keeps them current.

6.3 **Estimates.** A home value the Service produces is an automated estimate with a range and a source and must be presented as such; it is not an appraisal, a broker price opinion or a comparative market analysis unless a licensed person produces one and says so. Subscriber will not present an AI-drafted market narrative as an appraisal or deliver a model-authored document to an appraiser as if it were an opinion of value (`lib/avm/provider-chain.ts::requestPropertyValuation`).

6.4 **Testimonials and reviews.** Subscriber will not fabricate, purchase or incentivize reviews or testimonials in a manner the law or the platform hosting them prohibits, and will disclose any material connection.

6.5 **Agency and transaction disclosures.** The Service's drafts do not substitute for the agency, brokerage-relationship, property-condition, lead-paint, fair-housing and other disclosures the law requires at the times it requires them. Subscriber delivers them.

## 7. Listing photographs, IDX and MLS content

7.1 **Two lawful photo sources.** A listing photograph in the Service comes from exactly two sources: Subscriber's own IDX or multiple-listing feed, or an upload by a Subscriber user who owns the photo or holds the rights to use it (`lib/listings/owner-photo-upload.ts::LISTING_PHOTO_SOURCES`). On upload the user attests that they took the photographs, own them, or hold a license from the photographer permitting Subscriber's use to market the listing, and that the photographs show the property as it is; the attestation, its version, the uploader and the time are recorded with the photo (`lib/listings/owner-photo-upload.ts::OWNER_PHOTO_ATTESTATION_TEXT`). A property-data Provider is never a photo source.

7.2 **Rights in photographs.** Subscriber will not upload a photograph taken by another brokerage's photographer, pulled from another listing, scraped from a portal, or otherwise outside its rights, and will not alter a photograph in a way that misrepresents the property. A photographer Subscriber engages is a vendor; Subscriber's agreement with the photographer governs the license and Subscriber warrants it covers the Service's uses.

7.3 **IDX and MLS display.** IDX content is displayed only through Subscriber's own feed connection, under `[[MLS_IDX_RULES]]`: attribution to the listing brokerage, the refresh interval, the disclaimer text, the fields that may be shown, the exclusion of sold and withdrawn listings where the board requires, and takedown on request. Subscriber will not cache, redistribute or syndicate IDX content beyond what its board permits, and will not mix MLS data with another Provider's data in a way that misattributes it; the Service labels listing-feed results and property-data results distinctly.

7.4 **Sold data and market trends.** Where a Provider supplies sold records or market trends, Subscriber will present them with the Provider's attribution and will not present them as MLS data.

## 8. Provider terms and connected accounts

8.1 Subscriber will comply with the terms of every Tenant-Connected Provider it connects, including scopes, rate limits, content policies, publishing rules and data-use restrictions, and will not connect an account it is not authorized to connect. Schedule 6 governs each connection.

8.2 Subscriber will comply with the published terms of each Platform-Owned Provider whose output it uses as passed through in Packet 1 §11.3 and Schedule 3 §4.

8.3 Subscriber will not use a connected social, messaging or advertising account through the Service in a way that platform prohibits — including unsolicited direct messages, scraping the platform's users, or circumventing its housing-advertising special category.

## 9. Security and integrity of the Service

9.1 Subscriber will keep its users' credentials, two-factor devices and connected-provider tokens secure, will revoke access when a user leaves, and will notify Platform at `[[ABUSE_CONTACT_EMAIL]]` promptly of any compromise.

9.2 Subscriber will not interfere with the Service's evidence ledgers, consent records, suppression lists, policy versions or logs, and acknowledges that these records are kept as Platform's operational records as well as Subscriber's compliance evidence.

## 10. Enforcement

10.1 **Automatic.** The Service refuses at the act: a non-consented text or call does not go; a suppressed person is not contacted and not distributed; a protected-class audience is not created or populated; a narrowed housing ad does not launch; a photo without an attestation is not stored as an owner upload; a blocked message is not sent.

10.2 **Platform suppression.** Platform may add a person to the platform-wide suppression list on a spam complaint, a TCPA finding, a litigator pattern or an explicit opt-out detected by the AI ISA, and no Subscriber may then contact that person.

10.3 **Tenant halt.** Platform may pause autonomous AI operations for Subscriber's Tenant while it investigates a suspected violation (Schedule 2 §9.2).

10.4 **Suspension and termination.** Platform may suspend an Authorized User or the Tenant under Packet 1 §5.9 and may terminate under Packet 1 §15.1 for a material breach of this Schedule that is not cured, or at once where the breach creates a material legal risk to a person, another Subscriber or Platform.

10.5 **Cooperation.** Subscriber will cooperate with Platform's investigation of a complaint, including by producing its consent evidence, and with any regulator's inquiry.

## 11. Reporting a violation

Anyone may report a suspected violation of this Schedule to `[[ABUSE_CONTACT_EMAIL]]`. Platform will acknowledge, investigate and act proportionately, and will not retaliate against a good-faith reporter.

---

> **Drafting note (not contract text).** Three owner rulings shape this Schedule and are deliberately preserved: (1) "no persona is refused and no raw demographic attribute is refused — the rule lives at the ACTION (fair housing, ad platform, consent, license), never as data deletion or label rejection"; (2) military, senior, divorced and probate are permitted situation personas for them-first wording; (3) listing photos have exactly two lawful sources and a property-data Provider is never one. Counsel should check §5.2's proxy list against current HUD and state guidance and the advertising platforms' housing special-category rules, and should supply the state-by-state advertising rules for §6.2 rather than let this Schedule generalize them.
