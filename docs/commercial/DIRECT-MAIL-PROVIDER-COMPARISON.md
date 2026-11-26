# Direct mail — Lob vs AMcards for birthday, anniversary, appreciation and lifecycle cards

Wave 148, lane 148J. Owner ruling 19 (2026-11-01): "AMcards could be evaluated to be another direct mail provider." The brief
adds the constraint: one canonical direct-mail routing fabric, capability-routed, and an adapter only on confirmed value and
confirmed terms. This report is **INTERNAL**. It names vendors, their terms and their prices.

**Method.** Every vendor fact below was read from the vendor's own pages on **2026-11-01**, unless another date is given. No
account was opened, no access token was generated, no card was sent (not even with AMcards' `is_test`) and nothing was bought.
Lob was re-read on the same day so that both columns carry the same read date. Survivors in this repo are cited at `file:line`
on base `ebed6c44`. A price that comes from a secondary source is labelled **reported**, and no verdict rests on one.

## 1. Verdict

1. **Lob stays the one active direct-mail provider, and the only one wired.** It is platform-paid under terms that fit a
   multi-tenant platform. Its license is "for its business purposes" and expressly anticipates "Customer Applications" built on
   its API, and its license over our data is limited "solely to the extent necessary to provide the Lob Service" (§5). It is also
   2.6× to 3.7× cheaper per piece than an AMcards card (§6).
2. **AMcards fills one real product gap, and only one.** It sells a folded greeting card in an envelope, with a handwriting-style
   font, a signature, photo panels and an optional gift. Lob sells no folded greeting card: its price list is postcards,
   self-mailers, letters, snap packs and checks (§5). Today our "handwritten" card is a Lob **postcard** carrying a notecard
   design (`app/actions/reputation-kernel.ts:287`, template `LOB_NOTECARD_ID` at `:316`). A postcard shows a personal message to
   everyone who handles it. The product gap is **confirmed**. The outcome value of closing it is **unmeasured** (§8).
3. **No AMcards adapter is built.** Neither of the brief's two conditions holds yet:
   - **Terms are not confirmed in writing for platform use.** AMcards' Terms let its Content be used only "for your information
     and personal use", and forbid otherwise exploiting it "without the prior written consent of AMcards". They also take a
     "worldwide, non-exclusive, royalty-free, sub-licensable and transferable license" over whatever we submit, which would
     include tenant brand assets, agent signatures, photos and message text. The Data Processing Agreement those terms mention
     is not published (§5).
   - **Value is not confirmed by evidence.** The only way to confirm it is a measured pilot, which is a purchase and therefore
     the owner's decision (§8).
4. **If both conditions clear, AMcards joins the existing fabric as one format's provider, never as a second fabric.** The
   format is `handwritten_card`, which is piece type `thank_you_note` / `handwritten_letter`. The door stays
   `dispatchDirectMail`, so every gate, the ledger and outcome reconciliation still apply. AMcards' own drip campaigns, contact
   manager, reminders, text and voicemail drops and gifts are refused by design, because each one is a second scheduler, a second
   sender or a breach of an owner rule (§7).
5. **WAITING_EXTERNAL (owner):** (a) AMcards' written authorization for platform use on behalf of tenant brokerages, plus a
   signed DPA that narrows the content license to providing the service (§9); and (b) the owner's decision on a measured pilot.
   No credential is requested. If the work reopens, the adapter would read `AMCARDS_ACCESS_TOKEN` (§9).

6. **Wave 149 (lane 149I, owner ruling 19, read 2026-11-03): a handwritten-card provider is not justified now** (§11).
   AMcards' prices are unchanged. A member card still costs about 2.6× a Lob color letter, the license questions in §5 are still
   open, and the outcome value is still unmeasured. Ruling 19 says that if no handwritten-card provider is justified, the platform
   adjusts to another branded format through existing providers. That format is the **personal letter**: a Lob color letter in an
   envelope, with the tenant's brand, a personal-note typeface and the agent's signature. It is sent through the existing
   `dispatchDirectMail` door, which already sends color letters (`lib/providers/dispatch.ts:1347`). §11 specifies what exists and
   what to add. AMcards stays WAITING_EXTERNAL. No adapter is built.

7. **Wave 150 (lane 150R, owner ruling R5, read 2026-11-06): four distinct global Lob templates, brand as data; the cost
   comparison across six providers is §12.** The format router is `lib/direct-mail/piece-type.ts`. A typeface is never called
   handwriting: the personal letter is a PRINTED note. **Correction:** AMcards is not a genuine-handwriting provider. Its home page
   says "You Click, We Print, Stuff, Stamp, and Mail", so it is a printed card set in a handwriting-style font. Only Handwrytten
   ("robots that hold real pens") and LettrLabs ("write each card with a ball point pen") claim a pen. Lob stays the default and
   the only wired provider. Every other provider stays dormant behind the format router.

## 2. Sources read (2026-11-01)

| Source | URL | Notes |
|---|---|---|
| AMcards API documentation index | <https://amcards.com/docs/> | Page dated "We updated our docs July 6, 2023" |
| AMcards REST resources and webhooks | <https://amcards.com/docs/developers-only/> | Card statuses, users, contacts, campaigns, gifts; the "webhooks" are calls we would make to AMcards |
| Send a card (credentials / access token) | <https://amcards.com/docs/1st-example/>, <https://amcards.com/docs/2nd-example/> | `send_date`, `initiator`, `update_url`, `is_test`, `gift_id`, `third_party_contact_id`, fonts, panels |
| Trigger a drip campaign | <https://amcards.com/docs/campaign/> | `birth_date`, `anniversary_date`, `phone_number` ("If Text and Voicemail Drop permissions are enabled the recipient will recieve them") |
| Send a template to many recipients | <https://amcards.com/docs/open-mailing-form/> | Bulk mailing, JSON body, header token |
| AMcards Terms, Privacy Policy, Subprocessors | <https://amcards.com/legal/> | No effective date shown; Florida law |
| AMcards pricing | <https://amcards.com/pricing/> (also on <https://amcards.com/>) | Pay as you go $3.82 / card + postage; $29 / mo membership → $1.57 + postage |
| AMcards gifts | <https://amcards.com/gifts/> | Gift catalogue (seasonal) |
| AMcards Python package (linked from AMcards' home page) | <https://python-amcards.readthedocs.io/en/latest/> | There is no Node SDK |
| Lob Terms of Service (Last Updated **2026-08-14**) | <https://www.lob.com/terms> | License, restrictions, Customer Applications, Customer Data |
| Lob Service-Specific Terms (Last Updated **2026-07-06**) | <https://www.lob.com/service-specific-terms> | Address-verification and API terms |
| Lob pricing and unit prices | <https://www.lob.com/pricing>, <https://help.lob.com/print-and-mail/ready-to-get-started/pricing-details> | Unit prices "take effect on 11/01/2026", inclusive of print and postage |
| Lob API reference | <https://docs.lob.com/> | `send_date` up to 180 days ahead; "Scheduling and cancellation is a premium feature" |
| USPS Forever stamp, July 2026 (**reported**, secondary) | <https://money.com/stamp-price-increase-july-2026/>, <https://nna.org/usps-announces-new-rates-for-july-2026> | $0.78 → $0.82 from 2026-07-12. Used only to estimate AMcards' "plus postage" |

## 3. The canonical direct-mail fabric today (survivor census)

This is the one fabric a second provider would have to join. Nothing here is a proposal: it is what the code on `ebed6c44`
does.

| Layer | Survivor | What it does |
|---|---|---|
| Provider resolution | `lib/kernel/providers.ts:82` (`direct_mail: "lob"`), `:101` (in `SYSTEM_ONLY_TYPES`), `resolveProvider` at `:245` | Direct mail is **platform-only**: one vendor for the whole app, superadmin may swap it, no tenant override |
| The one door | `lib/providers/dispatch.ts:991` `dispatchDirectMail`, inside `withActionLedger("comms.direct_mail.send")` at `:996` | Every physical send goes through here |
| Gates, in order | autonomy `:998`; suppression (`checkSuppression`, including the address arm) `:1092`; the send-time CASS gate `:1152` (`lib/providers/mailing-cass-gate.ts:46` `needsCassCheck`); physical-touch de-conflict `:1186`; fair-housing content backstop on the merge copy `:1197`; vendor budget pre-flight `:1251` | A refusal at any gate returns before Lob is called, inside the ledgered action |
| Booking and outcome | `logVendorUsage` `:1295`; `recordOutcomeClaim` (claimed `accepted_by_lob`) `:1319`; delivery proved by `/api/webhooks/lob-events` (shared secret `LOB_WEBHOOK_SECRET`, `app/api/webhooks/lob-events/route.ts:42`) | A Lob accept is not a delivery: the webhook proves or contradicts it |
| Unit cost | `lib/vendor-governance/cost-normalizer.ts:63` `DIRECT_MAIL_PIECE_COST_USD` (letter $1.20, postcard $0.78, self-mailer $1.05) | The one booked price |
| Channel declaration | `lib/providers/channel-provider-matrix.ts:255` `direct_mail` (`providers: ["lob"]`, verdict BUILT) | What the readiness board and the arbiter read |
| Piece vocabulary | `lib/direct-mail/piece-type.ts:23` `CAMPAIGN_PIECE_TYPES` = postcard, letter, handwritten_letter, thank_you_note | The one spelling set (CLAUDE.md §6) |
| Arbiter formats | `lib/ai-isa/followup-arbiter.ts:111` `ARBITER_FORMATS`; `:116` the direct-mail channel carries `printed_letter`, `postcard`, `handwritten_card` | A format is never a channel. The arbiter already tells a card apart from a postcard |
| Handwritten card | `lib/agentic-os/app-capability-registry.ts:203` `handwritten_note_send` (`requires: { platform: ["lob"] }`) → `app/actions/reputation-kernel.ts:287` → `dispatchDirectMail` with piece type postcard and `LOB_NOTECARD_ID` (`:316`) | Owner ruling: "handwritten notes run the same line as a postcard or card" |
| Address validation | `lib/providers/lob/client.ts:96` `verifyUsAddress` | Lob US verification (CASS) |

**Who sends lifecycle touches today**, because a card provider would serve these moments:

| Moment | Survivor | Channel today |
|---|---|---|
| Birthday | `app/actions/lifetime-customer-touchpoints.ts:141` `sendBirthdayMessage` | SMS through `dispatchSms` (consent, DNC, quiet hours) |
| Home anniversary | `app/actions/lifetime-customer-touchpoints.ts:51` `sendAnniversaryMessage`; the date-driven cron owns it (`lib/sphere/followup-moments.ts:60`) | Email through `dispatchEmail`; also the anniversary equity report and video |
| Closing / review thank-you note | `app/actions/reputation-kernel.ts:287` | Email, SMS, or the Lob notecard **postcard** |
| Referral appreciation | `lib/kernel/referral-appreciation.ts:84` (default kind "handwritten card + small gift"); `app/referrals/pipeline/draft-thank-you-button.tsx:74` ("Copy this into the handwritten card — nothing is sent automatically.") | **Manual.** The agent writes the card |
| Gift | `lib/workflow/adapters/send-gift.ts:158` | Owner rule: "no fulfillment provider in the middle — the agent buys personally" |
| Age data | `lib/ai-isa/followup-arbiter.ts:1332` | Birthday / birth date is for "cards and the education format only, never a targeting or follow-up input" |

## 4. Use case by use case

| Use case | Lob (today) | AMcards (evaluated) | Better fit | Why |
|---|---|---|---|---|
| Birthday card to a past client | 4×6 postcard with a notecard design. The greeting is visible on the outside | Folded card in an envelope, handwriting font, signature, optional photo. Scheduled by `send_date` | **AMcards**, if terms and pilot clear | A birthday is personal, and an envelope keeps it private. **We schedule**, not AMcards: a birth date never leaves our database (§7 rule 4) |
| Home / closing anniversary | Postcard; today's touch is email + equity report + video | Card in an envelope | AMcards for a personal note; Lob or email for the equity content | The equity report is data content, which the portal and email carry better. A card is the personal layer |
| Closing thank-you / review thank-you | Notecard postcard (`reputation-kernel.ts:287`) | Card in an envelope with a signature | **AMcards** | This is exactly the gap: a "handwritten" note that is really a postcard |
| Referral appreciation | Manual (the agent copies the AI draft into a card) | Automatable card. A gift would also be possible, but is refused (owner gifting rule) | **AMcards** for the card; the gift stays the agent's own purchase | It closes a manual loop without breaking the gifting rule |
| Holiday / seasonal sphere card | Postcard or letter at scale | Card catalogue ordered by the next holiday (`/category/` API) | Either. Lob is cheaper at volume | Broadcast, not 1:1. Cost decides |
| Just listed / just sold, farm and neighbour mail, prospecting | Postcard, letter or self-mailer with CASS, bulk sends and delivery tracking | Not designed for this | **Lob** | Lob's price, CASS gate and signed delivery events. AMcards adds nothing |
| Raw-lead nurture postcards (`lib/ai-isa/lead-nurture.ts`) | Postcard | Not appropriate | **Lob** | A purchased lead is not a relationship that warrants a personal card |

## 5. Capability and terms, side by side

| Dimension | Lob | AMcards |
|---|---|---|
| Products | Postcards (4×6, 5×7, 6×9, 6×11), self-mailers, letters (B/W, color), snap packs, checks. **No folded greeting card** (pricing details, 2026-11-01) | Folded greeting cards (premium paper optional, `is_premium`), handwriting-style fonts (default "Reenie Beanie"; 12 named), up to 4 panel messages, photos per panel, signature vectors, gifts |
| Personalisation | `merge_variables` into a Lob HTML template | `extra_data` JSON into template merge fields (AMcards' `data.<key>` merge syntax, with template defaults) plus `message` / `panel_messages` (≤ 700 chars) |
| Scheduling | `send_date` up to 180 days ahead; "Scheduling and cancellation is a premium feature" | `send_date` per card; drip campaigns triggered by stored `birth_date` / `anniversary_date` |
| Test mode | Test API keys | `is_test: "yes"` → status "Testing", not mailed |
| Delivery evidence | Event webhooks (created … delivered, re-routed, returned to sender), consumed at `/api/webhooks/lob-events` and authenticated by our shared secret (`LOB_WEBHOOK_SECRET`) | Per-card `update_url` POST on every status change, carrying `card_id`, `status`, `status_text`, `tracking_id`, `fulfilled`, `third_party_contact_id`. **No signature is documented.** Statuses run 0–12, including "Delivered!" and "Return to Sender" |
| Address quality | US verification (CASS) and our send-time CASS gate | Status "Verifying Address" (internal). No exposed verification API |
| Multi-user on one account | Authorized Users (named people) | `initiator` is "unique identifier of user for application so if multiple users use a single AMcards.com account". Users "that you are authorized to view"; a third-party "downgrade-to-free" webhook keyed by `third_party_id` |
| SDK | Official Node SDK, already in the repo (`lob@^6.6.3`) | Python package only. Plain HTTPS form / JSON POSTs |
| Auth | API key | Access token (generated in the account, "Connected Applications"). Example 1 takes the account username and password, which we would never use |
| Second sender inside the vendor | None | **Yes.** Drip campaigns can send text messages and voicemail drops to `phone_number`; text and email reminders exist; Twilio and SendGrid are listed subprocessors |
| License | "limited, non-exclusive, non-transferable license to use and access the Lob Services for its business purposes". The API exists so customers can build "Customer Applications" | No license grant over the service is stated. Content (which "includes all aspects of AMcards.com") is for "your information and personal use solely as intended through the provided functionality". You may not "copy, reproduce, distribute, transmit, broadcast, display, sell, license, or otherwise exploit any Content for any other purposes without the prior written consent of AMcards" |
| Third parties | May not "resell, sublicense … or otherwise provide access to the Lob Service to a third party (except Authorized Users …)". Our tenants never hold Lob access; the platform calls Lob | "You may never use another's account without express written permission". No resale clause for the service itself; the Content clause above is the open question |
| License over data we submit | "solely to the extent necessary to provide the Lob Service" | "worldwide, non-exclusive, royalty-free, sub-licensable and transferable license to use, reproduce, distribute, and display the Content" we submit |
| Privacy / DPA | A DPA (with the EU Standard Contractual Clauses) is incorporated for personal data under EU law | "AMcards does not use or access any contact data stored in the user's Contact Manager unless specifically requested". A "Data Processing Agreement" is referenced but **not published**. Subprocessors listed: DigitalOcean, Braintree / PayPal, Twilio, SendGrid, Sentry, GoHighLevel, Google Workspace, Zendesk, Google Analytics, Cloudflare |
| Change of terms | Effective as dated at the top | "AMcards may, in its sole discretion, modify or revise these Terms of Use … at any time". **No effective date shown** |
| Prepaid value | Plan fee monthly | Credits "good for twelve (12) months … after which they expire"; "All sales are FINAL" |

## 6. Cost per card — published prices, nothing bought

**Lob**, unit prices effective 2026-11-01, inclusive of print, postage and envelope. The plan fee is not included in the
per-piece rate:

| Piece | Developer ($0 / mo, ≤ 6,000 / yr) | Startup ($260 / mo, ≤ 75,000) | Growth ($550 / mo, ≤ 150,000) |
|---|---|---|---|
| 4×6 postcard, First Class | $0.909 | $0.649 | $0.619 |
| 5×7 postcard, First Class | $1.001 | $0.701 | $0.651 |
| Letter, B/W, First Class | $1.066 | $0.896 | $0.866 |
| Letter, color, First Class | $1.226 | $0.936 | $0.896 |

The repo books $0.78 per postcard (`cost-normalizer.ts:63`). That sits between Developer and Startup, as
`docs/commercial/PROVIDER-COST-REPORT.md` §3 already records.

**AMcards**, card plus postage. Postage is billed separately at the account's rate, which we could not read without an account.
The USPS Forever stamp is **reported** at $0.82 from 2026-07-12:

| Plan | Card | + postage (reported $0.82) | Per card |
|---|---|---|---|
| Pay as you go ($0 / mo) | $3.82 | $0.82 | ≈ **$4.64** |
| Membership ($29 / mo, "NO CONTRACTS") | $1.57 | $0.82 | ≈ **$2.39** |

- **The membership pays for itself at 13 cards a month:** $29 ÷ ($3.82 − $1.57) = 12.9.
- **Against Lob Startup:** an AMcards member card costs about **$1.74 more than a 4×6 postcard** (3.7×) and about **$1.45 more
  than a color letter in an envelope** (2.6×).
- **At 100 personal cards a month:** AMcards ≈ $29 + $239 = **$268**, against Lob Startup postcards **$64.90** (the plan fee is
  already carried once direct mail is sold, per `PROVIDER-COST-REPORT.md` §3).
- **At 500 a month:** ≈ **$1,224** against **$324.50**.
- **Premium paper and gifts cost extra.** Gifts are refused anyway (§7 rule 5).

The premium buys a different product (an enveloped card), not a better postcard. That is why §8 asks for evidence before money.

## 7. One routing fabric — the design if this reopens (NOT built)

These rules apply only if the §9 conditions clear. No new rail, no second dispatcher, no vendor-side automation:

1. **One door.** AMcards becomes a provider branch inside `dispatchDirectMail` (`lib/providers/dispatch.ts:991`), chosen by
   **format**. Every gate in §3 runs first: autonomy, suppression, CASS, de-confliction, the fair-housing backstop and the budget
   pre-flight. The action stays `comms.direct_mail.send` in the action ledger. There is no sibling dispatcher (no AMcards
   `dispatch` module of its own); an AMcards client, if one is ever written, is a transport that only `dispatchDirectMail` calls.
2. **Capability-routed, not vendor-named.** Callers keep asking for a format (`handwritten_card`) or a piece type
   (`thank_you_note` / `handwritten_letter`), never for "AMcards" (LAW 3). The format-to-provider order is data in one table,
   held by a proof. AMcards comes first for `handwritten_card` by **owner ruling** (a product choice, not the cheapest route).
   The Lob notecard postcard stays the declared fallback when AMcards is unconfigured or failing. `SYSTEM_DEFAULTS.direct_mail`
   stays `lob`, so every other piece is unchanged.
3. **We schedule, AMcards prints.** The lifetime cron, `followup-moments` and the arbiter decide the moment, the format and the
   words. AMcards gets one card at a time with `send_date`. **AMcards drip campaigns, its contact manager and its reminders are
   never used.** Each would be a second scheduler holding our clients' dates.
4. **Data minimisation.** We send name, mailing address, the card copy and opaque `initiator` / `third_party_contact_id` values
   (tenant and agent ids hashed, never an email). We **never** send `phone_number`, which would open AMcards' text and voicemail
   drops: a second sender outside the TCPA gate. We also never send email, `birth_date` or `anniversary_date`. Age data is
   "cards … only, never a targeting or follow-up input" (`followup-arbiter.ts:1332`), and the card does not need the date to
   travel.
5. **No gifts through AMcards.** `gift_id` is refused at the adapter. The owner's gifting rule ("no fulfillment provider in the
   middle — the agent buys personally", `send-gift.ts:158`) stands.
6. **Outcome evidence.** The claim opens as pending against `card_id`. `update_url` points to a route that carries a per-card,
   unguessable token, because AMcards documents no signature. A callback is a claim, not a proof: the route re-reads
   `GET /.api/v1/card/{id}/` with our token before it settles the outcome ledger. "Return to Sender" feeds the same address
   suppression Lob's returns feed.
7. **Cost.** The card plus postage is booked on accept through the same `logVendorUsage` / vendor-budget path. Its price is
   added to `DIRECT_MAIL_PIECE_COST_USD`, the one table. Credits expire after 12 months, so prepaid balances are a
   procurement-policy item, not code.
8. **Readiness.** `lib/providers/channel-provider-matrix.ts:255` would list `amcards` beside `lob`. The capability contract
   `handwritten_note_send` would declare `platform: ["amcards", "lob"]` (any-of).
9. **Proof.** Only then the proof the brief names, provider-consolidation-guard (`test:provider-consolidation`; not created, because
   no code landed). It would assert one door
   (no AMcards call outside `dispatch.ts`, scanned on stripped source); no `phone_number` / `birth_date` / `anniversary_date` /
   `gift_id` / campaign endpoint in the adapter; the format route held as data; and a refused gate refusing the AMcards branch
   too. Each assertion would carry a positive control.

## 8. Value — what would confirm it

- **Confirmed today:** the product gap. Lob has no folded greeting card. Our "handwritten" thank-you is a postcard. Referral
  appreciation is a manual task.
- **Not confirmed:** that an enveloped card changes anything we measure. The arbiter already records `handwritten_card` and
  `postcard` as different formats (`followup-arbiter.ts:111`), so the existing format and outcome learning can attribute the
  results once both formats exist.
- **The pilot that would confirm it (owner decision; it is a purchase):** one AMcards membership ($29 / mo, no contract) with a
  bounded number of past-client cards. Compare it against the Lob notecard postcard on the outcomes we already record: replies,
  referrals, reviews and return-to-sender rate. This lane does not open the account.

## 9. WAITING_EXTERNAL — what would let the adapter be built

| Item | Provider | Where | How verified |
|---|---|---|---|
| Written authorization for platform use | AMcards (185 Middle Street Suite #1301, Lake Mary, FL 32746; (407) 676-3272; the support address on <https://amcards.com/legal/>) | AMcards, in writing | A signed letter or order form. It must confirm that one platform account (or per-tenant sub-users via `initiator`) may send cards on behalf of tenant brokerages, with costs covered by the platform. That is AMcards' "prior written consent" under the Content clause |
| Data Processing Agreement | AMcards | The DPA its Subprocessors section references | A signed DPA. It must narrow the "sub-licensable and transferable" Content license to providing the service, cover recipient PII and deletion, and confirm that AMcards does not use or contact recipients |
| Pilot decision | Owner | — | The owner approves a bounded pilot (§8) |
| Credential (requested **only** after the three above) | AMcards | The account's access-token page, <https://amcards.com/user/generate-access-token/> | `AMCARDS_ACCESS_TOKEN`. Verified with a free `GET /.api/v1/user/` and one `is_test: "yes"` card (status "Testing", not mailed). No value is in code or env docs today, deliberately |

## 10. Blind spots

- **No account.** AMcards' postage rate, its real per-card total, its volume pricing and any enterprise or partner terms are
  unread. The $0.82 stamp is a secondary report.
- **AMcards' docs are dated 2023-07-06.** Endpoints may have moved since. The `update_url` payload example is dated 2026, so at
  least that part is current.
- **The callback is unsigned on paper.** Whether AMcards signs callbacks, or can, is unknown. The design treats every callback as
  a claim to be re-read.
- **This is not legal advice.** Both terms readings are procurement readings, and counsel reads before any signature. AMcards'
  terms show no effective date and can change at any time.
- **Delivery quality and speed are unmeasured.** Neither vendor publishes a delivery-time distribution, and no piece was sent.
- **The value is unmeasured** (§8). The cost comparison is exact on Lob's side and estimated on AMcards' postage.

## 11. Wave 149 — is a handwritten-card provider justified? (lane 149I, read 2026-11-03)

Owner ruling 19 (2026-11-03): "if no handwritten-card provider is justified, adjust to another branded direct-mail format through
existing providers. No purchases." Every vendor fact below was re-read on **2026-11-03**. No account, no access token, no card and
no purchase. Survivors are cited at `file:line` on base `08712fef`.

### 11.1 What changed since 2026-11-01

| Source | Fact (2026-11-03) | Change |
|---|---|---|
| <https://amcards.com/pricing/> | Pay as you go "$0 Monthly Membership", "$3.82/card (plus postage)". Membership "$29 Monthly Membership", "Savings of over 50% Off Cards Retail ( $1.57 + Postage )", "NO CONTRACTS" | none |
| <https://amcards.com/signup/199-license/> | "$199 one-time, then $39/month"; "BONUS: $40 In Credits Per Month"; "All Credits Roll Over For 12 Months" | **new to this report**: a licensed tier. Its per-card price is not stated on the page (**unconfirmed**) |
| <https://amcards.com/signup/pro/> | "$495 one-time, then $39/month". The page lists a "System License: $199", "Back of Card Branding: $125", "The ability to have your handwriting as a font $175". "United States only" | **new to this report**: the agent's own handwriting as a font is a paid, per-account option |
| <https://amcards.com/> | Zapier, Salesforce AppExchange, a Follow Up Boss embedded app, "API Access to Use Contacts from Other CRMs" | integrations are per-agent account connections, not a platform license |
| <https://help.followupboss.com/hc/en-us/articles/4402371465111-AMcards> (third-party help page, not AMcards') | "Cards will be delivered in 2-5 business days"; message "maximum of 700 characters"; OWN vs SHARED account | a delivery window, **reported** (secondary) |
| <https://help.lob.com/print-and-mail/ready-to-get-started/pricing-details> | Prices "take effect on 11/01/2026": letter, color, First Class $1.226 / $0.936 / $0.896 (Developer / Startup / Growth); 4×6 postcard $0.909 / $0.649 / $0.619; custom return envelope $0.05 | none (§6) |
| <https://help.lob.com/print-and-mail/designing-mail/mail-piece-design-specs/letter-add-ons> | Card affix: "The minimum send quantity is 5,000 cards per letter campaign"; "Static, non-personalized artwork"; "We do not support … Dynamic, personalized artwork designs that are unique to the recipient"; $250 / day setup if fewer than 5,000 card-affix letters in a print day. Custom envelopes: "limited customization" of the #10 outer envelope; card-affix letters "cannot be sent with custom envelopes" | **new to this report**: Lob's "cards" are promotional inserts, **not** a greeting card. They cannot serve 1:1 notes |

### 11.2 Verdict: AMcards is not justified now

Ruling 19's test is "justified". Each condition §1 set is re-checked here:

| Condition | 2026-11-01 | 2026-11-03 | Holds? |
|---|---|---|---|
| A real product gap (a folded card in an envelope) | confirmed | unchanged. Lob's only "card" is a 5,000-minimum static insert (§11.1) | gap stands |
| Terms permit platform use | not confirmed (the Content clause needs "prior written consent"; a sub-licensable license over what we submit; DPA unpublished) | unchanged. The new license tiers are per-account system licenses, not platform terms | **no** |
| Cost | member ≈ $2.39 a card (reported $0.82 postage) | unchanged | 2.55× a Lob Startup color letter ($0.936), 3.7× a 4×6 postcard |
| Value measured | no | no (a pilot is a purchase) | **no** |

**Not justified.** Two of the four conditions fail, and the cost premium buys an envelope and a fold that a Lob letter gets mostly
right at 39 % of the price. Ruling 19 therefore points to the alternative.

### 11.3 The branded format through the existing provider: the personal letter

**Definition.** A **personal letter** is one sheet, color, First Class, mailed in an envelope. It carries the tenant's letterhead
(logo, colours, brokerage line, website), and the person's name and a short note set in a personal-note typeface (a script face; wave 150 R5: a typeface is never called handwriting). It closes
with the agent's scanned signature and a hand-feel "P.S." line. It is private in the envelope, which is the one thing the notecard
postcard lacks. It is personal in tone, and it is a lawful, ordinary letter. It is **never** presented as handwritten by a person
when it is printed: the copy says "a note from <agent>", not "handwritten by".

**What exists today (no code needed to send one):**

| Piece | Survivor | State |
|---|---|---|
| Color letter in an envelope through the one door | `dispatchDirectMail` letter branch, `lob.letters.create({ file, merge_variables, color })` (`lib/providers/dispatch.ts:1347`); pieceType `"letter"` and `color` (`:1033`, `:1050`) | BUILT |
| Every gate (autonomy, suppression, CASS, de-confliction, the fair-housing backstop on merge copy, budget) and the ledger `comms.direct_mail.send` | `lib/providers/dispatch.ts:1061` onward (§3) | BUILT |
| Booked unit | `DIRECT_MAIL_PIECE_COST_USD.letter = 1.2` (`lib/vendor-governance/cost-normalizer.ts:63`). That sits at or above Lob's published color First Class letter on every plan ($0.896 – $1.226), so the budget pre-flight cannot under-reserve | BUILT (conservative) |
| Delivery evidence | `/api/webhooks/lob-events` (§3) | BUILT |
| The arbiter tells formats apart | `ARBITER_FORMATS` includes `printed_letter` and `handwritten_card`; the direct-mail channel carries both (`lib/ai-isa/followup-arbiter.ts:115`, `:120`) | BUILT |
| Piece vocabulary | `CAMPAIGN_PIECE_TYPES` includes `handwritten_letter` and `thank_you_note` (`lib/direct-mail/piece-type.ts:23`) | BUILT |

**What to add (specified; NOT built in this lane, because each item is configuration or another lane's file):**

1. **Route the `handwritten_card` format to the letter, with the postcard as the fallback.** Today the thank-you path sends a
   postcard with `LOB_NOTECARD_ID` (`app/actions/reputation-kernel.ts:287` onward, the `templateId` read near `:316`). It should
   send `pieceType: "letter", color: true` with a personal-letter template id, and fall back to today's notecard postcard only
   when that template is not configured. That file is outside lane 149I's domain. The exact change is in the lane notes under
   Outside-lane.
2. **A personal-letter template (configuration, platform-owned).** One Lob HTML letter template, with merge variables for tenant
   brand, recipient name, note body, agent name, signature image URL and website. The template id is held in an env var whose
   proposed name is `LOB_PERSONAL_LETTER_TEMPLATE_ID`. That is a **name only**: no value, and no Vercel change. Whether Lob
   renders a hosted handwriting web font in an HTML letter is **unconfirmed** (the Lob template font docs were not read). If it
   does not, the typeface is embedded as an image of the rendered note, which the template's PDF path accepts.
3. **The note itself.** It is written by the existing draft writer under the prompt standard: kind, specific to the moment
   (closing, review, referral appreciation, home anniversary), never naming a private or inferred life event (the C20 screen).
   The words pass through the same fair-housing backstop on merge copy. Timing comes from the arbiter (C29), never a fixed
   schedule.
4. **Lifecycle moments that should offer it:** closing and review thank-you (`reputation-kernel.ts`), referral appreciation (today
   a manual card, `lib/kernel/referral-appreciation.ts:84`), and a home anniversary note beside the equity email. Each is chosen as
   a format by the arbiter, never a second scheduler. The birthday stays on its current consented channel. A birth date never
   becomes a mail trigger outside the arbiter (`followup-arbiter.ts` age-data rule).
5. **Readiness.** The capability `handwritten_note_send` (`lib/agentic-os/app-capability-registry.ts:203`, `requires: { platform:
   ["lob"] }`) is unchanged: same provider, same door.

**Cost at volume** (Lob Startup, color letter First Class, $0.936; the plan fee is already carried once direct mail is sold):

| Personal notes a month | Lob personal letter | AMcards member (≈ $2.39, reported postage) | Lob notecard postcard (4×6, $0.649) |
|---|---|---|---|
| 100 | $93.60 | ≈ $268 | $64.90 |
| 500 | $468 | ≈ $1,224 | $324.50 |
| 1,000 | $936 | ≈ $2,419 | $649 |

### 11.4 WAITING_EXTERNAL (unchanged from §9)

AMcards stays WAITING_EXTERNAL by name. Three things are needed first: written authorization for platform use, a signed DPA that
narrows the content license, and the owner's pilot decision. Only after them would the credential be requested:
`AMCARDS_ACCESS_TOKEN`. There is no adapter, no credential read and no AMcards host in code. The personal letter needs no new
vendor. Its only external item is the platform's Lob template, held by name in `LOB_PERSONAL_LETTER_TEMPLATE_ID`: configuration,
no value.

### 11.5 Blind spots

- **The handwriting typeface in a Lob HTML letter is unverified.** Lob's font guidance was not read, so the template may need the
  rendered-image fallback.
- **The window envelope.** A Lob letter mails in a #10 window envelope. Custom envelopes are "limited customization", and their
  price did not render. So "private in an envelope" holds, but "looks like a greeting card" does not.
- **Delivery time is unmeasured** for both vendors. The AMcards 2 – 5 day figure is a third-party help page.
- **Response lift is unmeasured.** The arbiter's format attribution (`printed_letter` against `postcard` against
  `handwritten_card`) is the instrument, once both formats are sent.

## 12. Wave 150 — distinct formats, brand as data, and printed + postage + minimum + platform fee across six providers (lane 150R, read 2026-11-06)

Owner ruling R5 (2026-11-06). Lob stays the default. The letter, the personal letter, the postcard front and the postcard back
are **distinct** Lob template ids. There are a few **global** format templates, and every tenant, sending-user and office detail
is merge data. Genuine handwritten cards and bulk providers stay optional behind the router, with price and license proof. Nothing
is bought.

**Method.** Every price below comes from the vendor's own page, read on 2026-11-06 unless another date is given. No account was
opened, no quote was requested and no order was placed. When a page does not publish a figure, the cell says **unconfirmed**.
Lob's figures are the 2026-11-01 unit prices already sourced in §6 and §11.1.

### 12.1 Sources (official pages only)

| Provider | URL (read 2026-11-06) | What it says |
|---|---|---|
| Lob pricing | <https://help.lob.com/print-and-mail/ready-to-get-started/pricing-details> (read 2026-11-03, §11.1) | Prices "take effect on 11/01/2026", inclusive of print and postage. Plans: Developer $0 / mo, Startup $260 / mo, Growth $550 / mo (§6) |
| Lob test environment | <https://help.lob.com/account-management/api-keys> | Test keys start `test_`. In test mode "a digital proof and thumbnails will be rendered, but the mail piece will not actually be printed and mailed", with no charge |
| Lob idempotency | <https://docs.lob.com/> ("Idempotent Requests") | `Idempotency-Key` header (postcards also accept `idempotency_key` as a query parameter), up to 256 characters. Key lifetime: **unconfirmed** (the appendix did not render) |
| Lob tracking | <https://help.lob.com/print-and-mail/getting-data-and-results/tracking-your-mail> | "Delivered" is generated "when the carrier's GPS unit leaves the delivery area". "USPS does not guarantee every event". "Processed for Delivery is more reliable" |
| Lob fonts / merge variables | <https://help.lob.com/print-and-mail/designing-mail-creatives/maximizing-engagement/dynamic-personalization> | Hosted fonts through `@font-face` (TTF, Google web fonts; OTF and Typekit refused). `merge_variables` are capped at 25,000 characters, and names may not contain whitespace or special characters |
| LettrLabs pricing | <https://www.lettrlabs.com/pricing> | "Postage is Always Included". Handwritten Postcard $1.66 / $1.26 / $0.88; Card & Envelope $2.86 / $2.05 / $1.27; Handwritten Envelope & Printed Letter $1.56 / $1.22 / $0.81 (Starter pay-as-you-go / Premium monthly / Enterprise annual). Premium "$399 /month" (a "$449 /month" figure also appears, unlabelled). Printed 4×6 postcard $0.76 on Starter |
| LettrLabs order of operations | <https://docs.lettrlabs.com/order-of-operations/> | `POST /v1/order` "creates a new order every time". Checkout is `POST /v1/order/{id}/checkout`; payment settles **asynchronously**. "Do not retry a checkout that returned `200`". A second checkout while `Payment Needed` returns `400` |
| LettrLabs product | <https://www.lettrlabs.com/> | "write each card with a ball point pen" (robotic) |
| Handwrytten pricing | <https://handwrytten.com/pricing/> | Retail "$3.75" per card, "Postage extra". Business: Pro $1.99, Enterprise $1.49, Elite $1.29, Agency $1.19 per card; plan fees Pro $449 / $374, Enterprise $649 / $540, Elite $849 / $707, Agency $2,499 / $2,082 a month (the two figures are unlabelled, likely monthly vs annual). "Domestic Postage: Billed at the current USPS rate". API access on business plans |
| Handwrytten product | <https://handwrytten.com/> | "robots that hold real pens" |
| AMcards product | <https://amcards.com/> | "You Click, We Print, Stuff, Stamp, and Mail". Signatures are drawn on a device. This is a **printed** card in a handwriting-style font, not pen-written |
| PostcardMania pricing | <https://www.postcardmania.com/pricing/>, <https://www.postcardmania.com/price/> | **HTTP 403** to the fetcher. No figure is taken from them. Their bulk-mail page, as summarised by search, lists print-only rates and a custom quote for postage. That is **unconfirmed**: it was not read first-hand |
| PCM Integrations pricing | <https://www.pcmintegrations.com/pricing/> | "To request pricing details, please contact us". "No sign-up fees", "No integration fees", "No technology fees". No per-piece price is published |

### 12.2 Cost table: printed + postage + minimum + platform fee

All figures are USD per piece unless stated. **Platform fee** is the vendor's monthly plan fee. VIPAgents' own fee to tenants is
not set (the commercial ruling sets no SaaS prices), so it is listed as **not set**, never invented.

| Provider · format | Printed / written | Postage | All-in per piece | Minimum | Vendor platform fee | Genuine pen? |
|---|---|---|---|---|---|---|
| **Lob** · 4×6 postcard, First Class | incl. | incl. | $0.909 Dev · $0.649 Startup · $0.619 Growth | none published | $0 · $260 · $550 / mo | no (printed) |
| **Lob** · letter, color (= the personal letter) | incl. | incl. | $1.226 · $0.936 · $0.896 | none published | same plans | no (printed, personal-note typeface) |
| **Lob** · letter, B/W | incl. | incl. | $1.066 · $0.896 · $0.866 | none published | same plans | no |
| **LettrLabs** · handwritten postcard | incl. | **incl.** | $1.66 Starter · $1.26 Premium · $0.88 Enterprise | **unconfirmed** | $0 Starter · $399 / mo Premium (also "$449", unlabelled) · Enterprise annual **unconfirmed** | **yes** (ball-point pen) |
| **LettrLabs** · card & envelope | incl. | incl. | $2.86 · $2.05 · $1.27 | unconfirmed | same | yes |
| **LettrLabs** · handwritten envelope + printed letter | incl. | incl. | $1.56 · $1.22 · $0.81 | unconfirmed | same | envelope only. The letter is printed and must be labelled so |
| **Handwrytten** · card | $3.75 retail; $1.99 Pro · $1.49 Enterprise · $1.29 Elite · $1.19 Agency | **extra** (USPS rate) | card + current USPS stamp (the stamp rate itself was not re-read; §6 cites a **reported** $0.82) | none stated | $0 retail; $374–$2,499 / mo | **yes** (robots with real pens) |
| **AMcards** · greeting card | $3.82 PAYG · $1.57 member (§11.1) | extra | ≈ $4.64 · ≈ $2.39 with the reported stamp (§6) | none stated | $0 · $29 / mo; license tiers $199 + $39 / mo, $495 + $39 / mo | **no** (printed font) |
| **PostcardMania** · postcard | **unconfirmed** (page 403) | **unconfirmed** | **unconfirmed** (custom quote) | **unconfirmed** | **unconfirmed** | no |
| **PCM Integrations** · postcard / letter / handwritten | **unconfirmed** ("contact us") | **unconfirmed** | **unconfirmed** | none mentioned | "No sign-up / integration / technology fees" | unconfirmed |
| VIPAgents platform fee to the tenant | — | — | **not set** (commercial ruling: no SaaS prices) | — | — | — |

**Reading the table.**

1. **Lob stays the default on price and on fit.** A personal letter on Lob Startup ($0.936) costs less than any pen-written
   piece except LettrLabs Enterprise ($0.88 postcard, an annual plan whose fee is unpublished). It is also the only provider
   already wired through every gate.
2. **For a genuine handwritten piece, LettrLabs is the cheapest published option with postage included.** Its Premium
   handwritten postcard costs $1.26 all-in, plus $399 / mo. That pays back against Handwrytten Pro ($1.99 + stamp + $374–$449 /
   mo) at any volume. It remains **dormant**: there is no adapter, no written platform license and no owner pilot decision.
3. **LettrLabs checkout is a charge trap for a naive adapter.** `POST /v1/order` makes a new order every time, and a second
   checkout after a `200` "charges again". Any future adapter must (a) key one order per piece through the action ledger
   (`mailPieceIdempotencyKey`), (b) never retry a checkout that returned 200, and (c) settle asynchronously by polling
   `paidDate`. This is recorded in `OPTIONAL_MAIL_PROVIDERS.lettrlabs.needs`. Canary 13 proves that no LettrLabs call exists in
   code today.
4. **AMcards drops out of the genuine-handwriting comparison.** It prints a font, so under R5 it cannot be sold as handwritten.
   It remains a possible printed greeting-card format, also dormant.
5. **PostcardMania and PCM cannot be compared.** Neither publishes an all-in price that we could read. Both stay
   **unconfirmed** until a written quote is in hand. Requesting one is outreach, so it is the owner's call.

### 12.3 What the code now holds (lane 150R)

| Requirement | Survivor |
|---|---|
| Four distinct template ids, by name; aliasing refused; a format with none refused | `lib/direct-mail/piece-type.ts` `LOB_TEMPLATE_ENV`, `lobTemplatesForFormat` (legacy names `LOB_POSTCARD_FRONT_ID`, `LOB_POSTCARD_BACK_ID`, `LOB_NOTECARD_ID`, `LOB_DEFAULT_TEMPLATE_ID`, `LOB_DEFAULT_LETTER_TEMPLATE_ID` are read after the canonical names and flagged `legacy`) |
| Brand as data (logo, colours, hosted font CSS, office, sending agent, license, return address, tagline, QR, art, disclosures verbatim) | `buildMailMergeVariables` / `resolveMailBrandMergeVariables` over `resolveBrandContext` and `resolveUserOffice` |
| Preview with zero spend | `lib/providers/lob/client.ts` `createLobProof` (a non-`test_` key is refused); `sendCampaign({ previewOnly: true })` |
| No double charge | `mailPieceIdempotencyKey` on the action ledger (`withActionLedger` replays a second claim) |
| Delivery outcomes per piece; a scan is never receipt | `mailOutcomeFromLobEvent`; `trackDelivery` settles onto `direct_mail_recipients.provider_piece_id` (m985) |
| Genuine handwriting only from a pen provider | `routeMailFormat("handwritten_card")` refuses while every provider is dormant; never downgraded silently |

## 13. Wave 151 — blank layouts, the tenant's return address, handwriting-style printed mail, delivery truth (lane 151H, 2026-11-09)

Owner corrections (verbatim): "direct mail, the rendered pieces should not use the platform return address"; "the direct mail templates
should be blank templates with just layout"; "handwritten font by computer can be a substitute".

### 13.1 What the code now holds

| Requirement | Survivor |
|---|---|
| Global templates are **blank layouts** — structure and merge-variable names only; no brand, no address, no platform identity | `lib/direct-mail/piece-type.ts` `MAIL_LAYOUT_LIBRARY` (letter · personal note · postcard front · postcard back · notecard), `layoutContentViolations` (run by `render-letter.ts` on its own output); the proof scans the in-repo layouts and the library |
| Distinct template ids by NAME; one `letterTemplateId` never reused for an incompatible format | unchanged `LOB_TEMPLATE_ENV` / `routeMailFormat` (wave 150); the personal-note row of a campaign now falls back to the GLOBAL personal-note layout, never the letter's and never a tenant template (`fallbackLobTemplates`) |
| Per-piece rendering from the AUTHORIZED tenant/user: logo, tagline, colors, approved font, photos, personal message, QR, destination URL, the Contact's identity, creator attribution, the sender's legal identity | `buildMailMergeVariables` — now also `sender_legal_identity`, `creator_attribution`, `recipient_first_name`, `note_font_family` / `note_font_css_url` |
| **The tenant's return address, never the platform's** | `direct_mail_sender_addresses` (m980): one default per scope (tenant / team / sending user), CASS-verified once, approved by a tenant admin. `resolveTenantSenderAddress` (user > team > tenant default > the brokerage of record's own business address, verified at resolve time when a key exists). `lib/providers/mailing-cass-gate.ts` `decideSenderAddress` REFUSES a missing / incomplete / unverified / undeliverable address and the platform's (a saved Lob address id, or the platform's name) BY NAME. The dispatcher's `: process.env.LOB_RETURN_ADDRESS_ID` fallback is gone; `LOB_RETURN_ADDRESS_ID` is read only to recognize and refuse it. Settings → Direct mail → Return address is where a tenant configures, verifies and approves addresses |
| **Handwriting-style printed mail** | `HANDWRITING_STYLE_TYPEFACE` (a Google-hosted script family — a LAYOUT constant, not a brand value); `MAIL_FORMAT_LABELS.personal_letter` = "Handwriting-style printed note …"; `render-letter.ts noteStyle: "handwriting_style"` sets the body and prints "Printed in a handwriting-style typeface" in the footer; every owned surface says handwriting-style / printed, and "handwritten" is reserved for a pen provider (still dormant) |
| Delivery truth: API accepted ≠ charge settled ≠ printed ≠ mailed ≠ delivered ≠ returned | `mailPieceTruth` (six separate truths; "printed" is `implied_by_mailed` because Lob reports no print event; "delivered" is `carrier_scan` only); the Tracking tab shows them; `trackDelivery` hands a `returned_to_sender` piece to `applyReturnedMailHandling` — the lead / contact address record is un-verified with source `lob_returned_to_sender`, pending siblings to the same mailbox are stopped, an address-only mailbox is suppressed for mail (m981 `return_handling`) |
| Proof preview retained; tenant approval before send; spend guard | `sendCampaign({ previewOnly })` (TEST key) now carries the tenant's `from`; `campaignSendGate` refuses a campaign whose `approval_status` is pending / pending_review / rejected and asks the ONE billing resolver (`mayUseAndAfford`) for pieces × the ONE Lob price BEFORE the first piece; the verdict is kept as `spend_preview` (m981) |
| Sender-voice copy from the first draft | `draft-copy.ts SenderVoiceBrief` + `readSenderVoiceBrief` (the 151I HOOK — lane 151I's reader replaces its body); the orchestrator stamps the brief on `copyCtx` before any render |

### 13.2 Cost strategy — EVALUATED—NOT IMPLEMENTED

A small **global library** of five format-specific blank layouts with dynamic branding serves every tenant; no Lob template is
made per tenant (the only per-tenant objects are DATA rows: sender addresses, brand facts, copy). Nothing was bought and **no quote
was requested** — outreach is the owner's.

| Candidate | Verdict | Why (from the §12 readings, no new figures) |
|---|---|---|
| **Folded notecard** on Lob | EVALUATED—NOT IMPLEMENTED | Lob prints postcards, letters, self-mailers, snap packs, booklets and checks — no folded notecard product. The handwriting-style printed note (`personal_letter`) is the substitute (`MAIL_LAYOUT_LIBRARY.notecard`) |
| **AMcards** (printed greeting card) | EVALUATED—NOT IMPLEMENTED | It prints a handwriting-style font — the same thing the Lob personal note already does at $0.936 (Startup) versus ≈ $2.39–$4.64 all-in (§12.2). No cost advantage; the only format advantage (a folded card) does not justify a second provider, a second credential scope and a second checkout path. Stays `dormant` |
| **PostcardMania** (bulk postcards) | EVALUATED—NOT IMPLEMENTED | No readable published all-in price (§12.1: HTTP 403; custom quote). A real cost advantage cannot be shown without a written quote, which is outreach — the owner's call. Stays `dormant` |
| **Pen-written providers** (LettrLabs, Handwrytten) | unchanged, dormant | Only justified for a GENUINE pen-written piece; the owner's substitute is the computer-generated handwriting-style font. Rights, price proof and the pilot decision remain the owner's (§12) |

### 13.3 WAITING_EXTERNAL (by NAME only)

`LOB_LETTER_TEMPLATE_ID`, `LOB_PERSONAL_LETTER_TEMPLATE_ID`, `LOB_POSTCARD_FRONT_TEMPLATE_ID`, `LOB_POSTCARD_BACK_TEMPLATE_ID` — four
BLANK Lob HTML layouts on the platform's Lob account whose merge variables are the `MAIL_LAYOUT_LIBRARY[slot].mergeVariables` names;
`LOB_TEST_API_KEY` — one TEST-key proof per format then shows each layout printing a tenant's data and the tenant's return address.
`LOB_RETURN_ADDRESS_ID` is no longer needed for tenant mail at all.
