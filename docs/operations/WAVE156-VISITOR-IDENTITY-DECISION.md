# Wave 156: identifying anonymous website visitors (decision)

Lane 156F, 25 November 2026. Proof: `scripts/wave156-f-visitor-truth-guard.ts`.

## Recommendation: do not offer

The owner's rule was: "the anonymous visitor sometimes can be identified using a provider, and if you can't do it, we don't need to include it."

No provider met all three tests: lawful, reliable and contractable for a multi-tenant product that serves consumers in the United States. **So the product does not include anonymous-visitor identification.** Anonymous visits stay anonymous.

The product keeps the aggregate value:

- which pages hold readers, and for how long;
- which listing pages draw return visits;
- which campaigns refer readers;
- trending questions;
- first-party events from visitors who identify themselves.

Changing this needs an owner decision. The steps are in the "What the owner would have to approve" section below. Nothing in the codebase is switched on, dormant or half-built for it.

This is not legal advice. Any future change needs review by counsel.

## What the product does today (after this lane)

| Surface | What it really does | Can an anonymous visit become a person? |
|---|---|---|
| `app/api/track/pixel/route.ts` | Records a session: the page, the referrer, the campaign and the brokerage's agent id. The session id is a random value kept in the visitor's browser storage for that one site. | No. Since wave 156, a session id can no longer be moved to another tenant (see the defects below). |
| `app/api/track/dwell/route.ts` | Records seconds on page for a session that the tenant's own pixel created. | No. |
| `app/api/track/identify/route.ts` + the installer snippet | When a visitor submits a form on the tenant's site, the snippet sends back the email or phone they typed. The route links the session to a Contact or an active Lead the tenant **already** holds. It never creates anyone. | Only by a first-party act (the visitor typed their own contact point). Since wave 156, the route links only a certain match. |
| `lib/lead-intelligence/visitor-email-capture.ts` (through `/api/track/visitor` and the widget) | Stores an email only together with a consent record, then links it to the one Contact holding it. | Only with consent. Since wave 156, the route links only a certain match. |
| `lib/lead-pipeline/site-visitor-sourcer.ts` (lead-scraping cron) | **Was:** each anonymous high-dwell session became a Raw Lead row (`username = session_id`, subject kind `person`, a "buyer" score). **Now:** it produces an anonymous aggregate only, and no raw record. | No. |
| `lib/kernel/intent-campaign.ts` territory phase | **Was:** it attributed a newly found off-site Zillow listing "view" to up to five anonymous visitors whose city matched, and raised their intent score. **Now:** removed (tombstone in the file). | No. |
| `app/actions/lead-intelligence.ts` `trackBehavior` | Writes visit analytics (pages, IP address, user agent) on an anonymous signal. A model's intent annotation is added after more than one session. The city is written as "Unknown": there is no IP-geolocation. | Only through the consented capture above. |
| `lib/kernel/site-traffic-insights.ts` | A weekly per-tenant report of pages and sources. | Aggregate only. |
| Versium `visitor_to_company` (IP-to-domain) | Listed in the provider catalog as `NOT_APPLICABLE`. It has no capability and no caller. It is company-level only, and a home buyer browsing from a residential internet connection resolves to no one. | Not wired. |
| Live database (read-only counts, 25 November 2026) | `website_visitors`, `behavioral_signals`, `site_activity`, `raw_scraped_leads` (site-visitor rows) and the off-site "view" rows in `external_behavior` all hold **0** rows. | Every defect below was latent. No real visitor was affected. |

The product has no reverse-IP lookup, no device fingerprinting, no IP-geolocation and no adapter for any visitor-identification vendor. Check C2 of the guard confirms this, with a positive control.

## Defects fixed in this lane

1. **Raw Lead created from a browser cookie.** The site-visitor lane wrote an anonymous session into the lead pipeline as a "person". It now reports only an anonymous aggregate, and its `identityPolicy` is `analytics_only`.
2. **Invented off-site behavior.** The territory phase attributed listing views that nobody observed. The code is removed and a tombstone left in its place.
3. **Cross-tenant session move.** The pixel's upsert on the globally unique `session_id` rewrote `brokerage_id`. A second tenant's id could carry the first tenant's identified session, including its contact link. Now a session id owned by another tenant is refused.
4. **Wrong-person match.** Both link doors read `.limit(1)` and took the first row. That linked a shared household email, or an email and a phone belonging to two different people, to an arbitrary contact. Now an ambiguous or conflicting match links nobody, and an uncertain contact match does not fall through to the Leads table. The rule lives in `lib/lead-intelligence/visitor-link-decision.ts`.
5. **Erasure missed visitor data.** A right-to-delete request was closed as "anonymized" while the subject's captured email, visit IP addresses, pages read and identified sessions remained. Now those rows are deleted in the request's tenant, every delete is counted, and the request fails closed if any delete is refused. The code is in `lib/privacy/visitor-data-erasure.ts`, wired into `fulfillDeleteRequestAction`.
6. **Snippet read password and hidden fields.** The snippet could pick up a password or hidden field that contained "@". It now skips both.

## Research: is there a provider that would qualify?

The question: is there a lawful, reliable, contractable provider that identifies anonymous **consumer** (B2C) web traffic in the United States at the person level? All sources were fetched on 25 November 2026. A vendor's numbers are its own marketing claims, not quotes or tested results. No vendor was contacted and no data was sent.

| Candidate | Level | Published match rate (vendor claim) | Independent evidence | Notes |
|---|---|---|---|---|
| identified.ai | Person (B2C) and company | "identify 50% of anonymous US website visitors at the person level" ([identified.ai](https://identified.ai/)) | None found | Lists "Real Estate" as a use case |
| LeadNavigator SuperPixel | Person | "up to 80%", "90%+ email match rate", graph of 308M+ US profiles ([leadnavigator.ai/superpixel](https://leadnavigator.ai/superpixel)) | None found | |
| Untitled ID Tag | Person (B2C and B2B) | "about 55%". Matches on "hashed emails, mobile advertising IDs, device IDs and IP signals" ([getuntitled.ai](https://getuntitled.ai/product/identify-website-visitors/)) | None found | Says itself: "Compliance isn't automatic." Advises a consent management platform (CMP) and opt-out; excludes EU visitors and California residents who opt out through the CMP |
| Uncoverfy | Person | Price: $0.15 to $0.17 per identified visitor, $170 to $750 a month ([uncoverfy.com](https://uncoverfy.com/)) | None found | Claims "the most accurate data available", with no evidence |
| unGhost | Person | "50–60% of US visitors"; $297 a month ([unghost.com](https://unghost.com/identity-resolution)) | None found | |
| Opensend | Person (ecommerce) | Its own article puts typical B2C person-level identification at "20–40%", and itself at 25–35% overall ([opensend.com](https://www.opensend.com/post/visitor-identification-software-ecommerce)) | Vendor-written comparison | |
| Retention.com | Person | Offers to "embed identity … into the products you already ship" (a platform or resale route) ([retention.com](https://www.retention.com/)) | Buyer complaints below | Multi-tenant and resale terms: **not verified** (no public contract read) |
| RB2B | Person, **B2B** (LinkedIn profiles, work identities) | "70–80% … with Pro+" ([rb2b.com](https://www.rb2b.com/)) | None found | Built for business visitors. A home buyer is a consumer, so it does not fit this need |
| Versium IP-to-Domain | **Company** | Not applicable | Not applicable | Already in the catalog as `NOT_APPLICABLE` |

**Independent evidence on reliability.** No independent audit of person-level match accuracy or false-positive rate was found for any of these vendors: **not verified**. The one independent source found is Alium Research, a buyer-interview study dated 28 October 2026 ([alium.io](https://www.alium.io/research/top-complaints-identity-resolution)). In it, users of Retention.com, Opensend and Black Crow most often complain that they cannot prove incremental value, and about "permissions, consent and perceived compliance risk". About two in three completed exits ended without a replacement identity vendor. Vendors describe their own methods as matching against hashed emails, device and advertising ids, and IP addresses. Several devices often share one household IP address, so a match can name the wrong person in the household. The vendors publish no false-positive rate.

**Litigation risk (session replay, pixels and wiretap law).**

- *Camplisson v. adidas America*, S.D. Cal. No. 25-cv-603, order of 18 November 2025 ([govinfo](https://www.govinfo.gov/content/pkg/USCOURTS-casd-3_25-cv-00603/pdf/USCOURTS-casd-3_25-cv-00603-0.pdf)). The court denied the motion to dismiss. Third-party trackers that collect IP addresses and fingerprints plausibly count as "pen registers" under the California Invasion of Privacy Act (CIPA) §638.51. A privacy-policy link in the footer was not consent.
- *Torres v. SeatGeek*, N.D. Cal. No. 25-cv-07118, order of 21 May 2026 ([govinfo](https://www.govinfo.gov/content/pkg/USCOURTS-cand-3_25-cv-07118/pdf/USCOURTS-cand-3_25-cv-07118-1.pdf)). The case was dismissed for lack of standing, with leave to amend. The court noted that "the overwhelming majority of courts" treat third-party internet trackers as pen registers.
- *Riganian v. LiveRamp*, N.D. Cal. No. 25-cv-00824, order of 18 July 2025 ([govinfo](https://www.govinfo.gov/content/pkg/USCOURTS-cand-4_25-cv-00824/pdf/USCOURTS-cand-4_25-cv-00824-0.pdf)). Claims under the federal Wiretap Act and CIPA §631 survived. They rest on an identity graph that matches visitors to profiles and on "event listeners" that capture emails typed into partner sites.
- *Price v. WeWork*, S.D.N.Y. No. 26-cv-06436, complaint filed 28 July 2026 ([PacerMonitor](https://www.pacermonitor.com/public/filings/DGJWM2TI/Price_v_WeWork_Inc_et_al__nysdce-26-06436__0001.0.pdf)). It alleges that a registered data broker's code was installed "to deanonymize" website visitors. The website operator is the defendant.

The pattern is clear: the **website operator**, here the tenant, is the party sued. A multi-tenant platform that supplied the tag would put that exposure on every tenant that turned it on.

**California data-broker law.** Since 1 August 2026, registered data brokers must process deletion requests from the Delete Request and Opt-out Platform (DROP) at least every 45 days. They must also pass those deletions to their service providers ([privacy.ca.gov](https://privacy.ca.gov/drop-for-data-brokers/); [cppa.ca.gov](https://cppa.ca.gov/data_brokers/); statute text in [Civ. Code §1798.99.86](https://cppa.ca.gov/regulations/pdf/data%5Fbroker%5Freg%5Fdelete%5Fact%5Fstatute%5Feff%5F20260101.pdf)). A visitor-identification vendor is typically a data broker: it sells personal information about people it has no direct relationship with. Its matches would carry that obligation.

**Not verified in this lane (no primary source read):**

- whether passing visitor signals to such a vendor is a "sale" or "sharing" under CCPA/CPRA (Civ. Code §1798.140);
- how the other state privacy acts apply (Virginia, Colorado, Connecticut, Texas, Oregon and others);
- each vendor's contract terms on resale, multi-tenant use and permitted marketing use;
- cross-device accuracy.

**Fair housing.** The vendors above return income, age, gender and household attributes. Using those to decide which consumer a real-estate business follows up with would need the same fair-housing review the product already applies to ad audiences.

**Conclusion.** Every candidate fails at least one of the tests:

- **Reliability:** no independent accuracy or false-positive evidence, and household IP addresses invite wrong-person matches.
- **Lawfulness:** active CIPA and wiretap litigation aimed at exactly this tag pattern, plus data-broker deletion duties.
- **Contractability:** no verified multi-tenant or resale terms.

Under the owner's rule, the product does not include it.

## What the owner would have to approve before this could ever be switched on

1. **Contract.** A signed agreement that grants:
   - multi-tenant or resale rights;
   - a data-processing agreement naming each tenant as controller;
   - permitted marketing uses;
   - a ban on the vendor reusing tenant visitor data in its graph;
   - DROP and deletion pass-through;
   - per-match pricing that fits the existing tier economics.
2. **Independent accuracy test.** Run against ground truth (known, consented visitors) before launch. It must publish the match rate *and* the wrong-person rate, and set a minimum confidence below which a match is dropped.
3. **Legal review.** Covering CIPA §631 and §638.51, the federal Wiretap Act, CCPA/CPRA "sale/share" and the opt-out of sale and sharing (including the Global Privacy Control signal), other state acts, and the vendor's data-broker registration.
4. **Consent text and a consent management platform (CMP).** Shown on each tenant site **before** the tag loads, with opt-out honored, and with tenant privacy-notice language approved by counsel.
5. **Product rules.** These already hold in the code and would bind any future adapter:
   - The adapter is dormant unless licensed and approved.
   - A match enters only through the existing RawData → Raw Lead producer, with provenance and pre-pull dedup, as `analytics_only` / evidence.
   - A probabilistic match is **never** made a Contact and **never** shown to an agent as a known person.
   - A low-confidence or ambiguous match is suppressed.
   - Identifiers are never linked across tenants.
   - Deletion and opt-out propagate to the vendor.

## Owner-held item that applies today, without any vendor

The installer snippet (`app/dashboard/admin/visitor-tracking/page.tsx`) listens for form submits on the tenant's site and sends the typed email or phone to this platform, which links it to an existing record. That is a first-party act on the tenant's own site, and the platform acts as the tenant's processor. It is the same "event listener" shape that *Riganian* allowed to proceed.

Before the snippet is promoted, counsel should decide two things:

- the tenant privacy-notice wording that discloses it;
- whether to honor the Global Privacy Control signal by not sending the beacon.
