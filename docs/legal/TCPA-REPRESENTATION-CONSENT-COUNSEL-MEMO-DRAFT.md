> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Memo for counsel: a signed representation agreement and consent to text or call

Version: 0.1.0-draft (2026-11-25) · Document ID: VIP-LEGAL-MEMO-TCPA-REP · Wave 156, lane 156N

This is a memo FOR counsel. It describes what the code does and asks the questions counsel must answer. It is not legal advice and states no conclusion of law as settled. No external legal source was read for it (not verified); every statement below is about the code.

## 1. What the code did before wave 156

`lib/kernel/compliance/active-representation.ts::hasActiveRepresentation` answers true when a Contact has an open transaction, an active buyer-broker agreement, a fully signed listing agreement or a live offer. Both outbound gates treated that answer as a substitute for a missing `contacts.tcpa_consent` flag on every SMS, phone and voicemail send, whatever the message was for:

- the content gate `lib/kernel/compliance.ts::evaluateOutbound` (Gate 2);
- the dispatch gate `lib/kernel/communication-compliance.ts::evaluateOutboundCompliance` (rules 6 and 7), which `lib/providers/dispatch.ts::dispatchSms` calls before every text.

The campaign-purpose check in `lib/providers/dispatch.ts::dispatchSms` asks the consent record (`lib/kernel/compliance/require-contact-consent.ts::answerConsentQuestion`) whether a recorded consent covers marketing, but when there is no consent record at all it defers to the gate above. So a fully signed listing agreement, with no other consent evidence, cleared an automated campaign text.

## 2. What the code does now

`lib/kernel/compliance/active-representation.ts::representationConsentCovers` separates the purposes, using the one channel-purpose vocabulary `lib/providers/dispatch.ts::channelPurposeFor` already uses (conversation, update, transactional, campaign):

| Purpose of the send | May an active representation stand in for missing consent? |
|---|---|
| `conversation` (one-to-one) | Yes, unchanged |
| `update` (servicing updates; also what a "nurture" system source infers to) | Yes, unchanged; see question 4 |
| `transactional` (recipient-initiated) | Yes, unchanged |
| `campaign` (marketing) | **No.** The send needs its own consent evidence for that channel |
| not stated by the caller | Yes, unchanged, so urgent servicing contact is never cut off by a caller that did not say |

Do-not-call status, channel opt-outs and the suppression list are untouched: they still block every purpose, servicing included.

The code change is narrow on purpose. It does not decide what the law permits; it stops the one reading counsel's question already rules out (an agreement as a blanket exemption for marketing) and keeps everything else as it was until counsel answers.

## 3. Known gaps the code cannot close without counsel or the owner

- Many text senders do not state a purpose, and the inference reads their system source: `sequence`, `lifetime_touchpoints`, `property_alerts` and `review_request` texts all infer to `conversation`, so a representation still covers them. Whether each is servicing or marketing is a legal classification, not a code one.
- The dispatch gate receives the purpose only once `lib/providers/dispatch.ts::dispatchSms` passes it through (an integrator change requested by lane 156N; that file belongs to another lane).
- The ad-audience upload in `lib/audiences/audience-sync.ts` also accepts an active representation in place of consent. Uploading a person to an advertising audience is not a text or a call; whether representation is a sufficient basis for it is a privacy and platform-terms question, left unchanged.
- `hasActiveRepresentation` reads only OPEN relationships. A comment in `lib/audiences/audience-sync.ts` says a closed deal (a past client) clears that gate; the code does not do that.

## 4. Questions counsel must answer

1. Does a signed listing agreement or buyer-broker agreement, by itself, supply the consent required for autodialed or prerecorded SERVICING texts and calls about that representation (deadlines, showings, signatures, closing logistics)? Does the answer differ between texts and calls, or by state (`[[STATE_SMS_RULES]]` in Packet 5)?
2. If the agreement contains a phone number and communication clause, is that "prior express consent" for informational messages, "prior express written consent" for marketing, both, or neither? What wording would make it sufficient, and should the platform's recorded-consent flow (`lib/kernel/compliance/require-contact-consent.ts::persistContactConsent`) capture it at signing?
3. Which purposes are marketing? In particular: drip sequences, lifetime / past-client touch points, saved-search property alerts, review requests, newsletters and "home value" updates sent to a current client.
4. Is an automated "update" to a current client (for example, a nurture message during the listing period) servicing or marketing?
5. When the representation ends (closed, canceled, expired), how long, if at all, may servicing contact continue without separate consent?
6. Does an "established business relationship" concept apply to any of these channels for this business, and if so with what time limit? (The code applies none.)
7. Must an opt-out received on one channel be honored on the other channels for marketing, for servicing, or both? (The code honors per-channel opt-outs and the global do-not-contact flag on every purpose.)
8. Is uploading a represented client to an advertising audience permitted without a separate consent, and under which state privacy laws?
9. Is any servicing message urgent enough to be sent during quiet hours (`[[QUIET_HOURS_WINDOW]]`)? The code does not exempt any.

## 5. What happens with each answer

Each answer is a change to one table in the code: the purpose list in `lib/kernel/compliance/active-representation.ts::REPRESENTATION_SERVICING_PURPOSES`, or the purpose each sender states. No answer requires a new consent store; the recorded-consent store already exists.
