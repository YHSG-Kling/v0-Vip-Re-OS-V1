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
   multi-tenant platform. Its licence is "for its business purposes" and expressly anticipates "Customer Applications" built on
   its API, and its licence over our data is limited "solely to the extent necessary to provide the Lob Service" (§5). It is also
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
   signed DPA that narrows the content licence to providing the service (§9); and (b) the owner's decision on a measured pilot.
   No credential is requested. If the work reopens, the adapter would read `AMCARDS_ACCESS_TOKEN` (§9).

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
| Lob Terms of Service (Last Updated **2026-08-14**) | <https://www.lob.com/terms> | Licence, restrictions, Customer Applications, Customer Data |
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
| Licence | "limited, non-exclusive, non-transferable license to use and access the Lob Services for its business purposes". The API exists so customers can build "Customer Applications" | No licence grant over the service is stated. Content (which "includes all aspects of AMcards.com") is for "your information and personal use solely as intended through the provided functionality". You may not "copy, reproduce, distribute, transmit, broadcast, display, sell, license, or otherwise exploit any Content for any other purposes without the prior written consent of AMcards" |
| Third parties | May not "resell, sublicense … or otherwise provide access to the Lob Service to a third party (except Authorized Users …)". Our tenants never hold Lob access; the platform calls Lob | "You may never use another's account without express written permission". No resale clause for the service itself; the Content clause above is the open question |
| Licence over data we submit | "solely to the extent necessary to provide the Lob Service" | "worldwide, non-exclusive, royalty-free, sub-licensable and transferable license to use, reproduce, distribute, and display the Content" we submit |
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
| Data Processing Agreement | AMcards | The DPA its Subprocessors section references | A signed DPA. It must narrow the "sub-licensable and transferable" Content licence to providing the service, cover recipient PII and deletion, and confirm that AMcards does not use or contact recipients |
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
