# Wave 154 — owner demo plan (K5)

Lane 154K, 2026-11-18. This is a walkthrough for the owner to watch the OS work. It is not a deployment, and it involves no live
sends, no purchases and no provider calls.

**Honesty line.** No step below is LIVE-VERIFIED. A read-only count of the live project (hrvaqgvukzxfskkcrwbt, 2026-11-18) found
2 brokerages, 2 transactions, 0 commissions, 0 topic-pool rows, 0 point rows, 0 support tickets and 0 tenant provider credentials.
Every step is SIMULATED until the owner runs it once on a preview deployment and the named reader shows the row. "Ledger / proof" is
the guard that proves the path today (in memory), or the open-loop ledger row that records it.

## 0. Before the demo (owner actions; release-blocking)

| # | action | why it blocks the demo | where |
|---|---|---|---|
| O1 | run OWNER-SQL §F (m855) and §G (m875) as the storage owner | the live read shows five private buckets `open`: any signed-in user of any tenant can read or overwrite another tenant's documents | docs/operations/OWNER-SQL.md |
| O2 | link or remove the 4 portal contact seeds (§I) | live: 4 of 4 contact seats have no `contacts.contact_user_id`, so the portal shows them nothing | OWNER-SQL §I |
| O3 | one preview deployment (owner's hosting / domain) | nothing can be clicked until a build is served | owner |
| — | sign in as seats that exist (live user types: admin, broker, team_lead, tc, compliance_officer, agent, vendor, contact; 3 platform staff) | personas use the existing types; no test role is invented | — |

## 1. Walkthrough

Sample tenant: the brokerage that holds the broker, team_lead, tc and compliance_officer seats (the live roster has one of each in one
tenant). The second tenant is used for the cross-tenant check in step 12.

| # | seat | do this | expect on screen | ledger / proof | state |
|---|---|---|---|---|---|
| 1 | admin | Admin › Billing › seat door: pick a seat package | refused with a plain sentence. Stripe objects are not created (owner ruling) | test:seat-cap · WAVE154-PRODUCT-SURFACE-AUDIT "Onboarding · seats" | SIMULATED · OWNER-HELD (Stripe) |
| 2 | broker | Settings › Integrations › Lead sources: save a key for a source | "saved and active", never "connected"; a bad save reads as a sentence, not a stack trace | product-surface audit "Sources · connections" · test:tenant-facing-copy | SIMULATED · vendor AWAITING KEY |
| 3 | admin | Admin › Onboarding › CDA setup: switch CDA off, then on | the deal's no-CDA closing-proof card follows the brokerage's mode | product-surface audit "Closing · CDA on/off" | SIMULATED |
| 4 | agent | Contacts › a contact › Persona panel: "Read research attributes" with a purpose | allowed or refused by role × purpose; the read is ledgered | ledger 147A-SO-06 (closed) | SIMULATED |
| 5 | agent | Stale contacts › "Re-engage" | the arbiter picks an action and a channel, or a wait with a reason; the decision shows in the flight recorder | ledger 143E-SO-03 (closed) · product-surface "Arbitration" | SIMULATED · model SIMULATED |
| 6 | agent | Marketing › SEO › Market trends: "Refurbish" a competitor post | an ORIGINAL draft in the agent's voice; a synonym swap is rejected | product-surface "Refurbish" | SIMULATED · model SIMULATED |
| 7 | agent | Contact › Campaign bundle › Send | each channel is decided by the arbiter. Sends are blocked without provider keys. The SMS touch carries NO campaign identity from this door (see §2) | product-surface "Marketing bundles" (PARTIAL) | SIMULATED · PARTIAL |
| 8 | contact (after O2) | Portal › Search › "Share with family" | only the invited family member sees the picked homes | product-surface "Shopping Agent" | SIMULATED · IDX LICENSE-HELD |
| 9 | tc | Transaction › set inspection / closing dates | calendar events land at the tenant's local time, not UTC | ledger 143H-OL-02 (FIXED this wave) | SIMULATED |
| 10 | broker | Financials › Payouts › "Mark as Paid" on a commission whose funds are not recorded | the refusal asks for a reason AND now shows the field; a stated reason pays ahead and is kept as evidence | ledger 143C-OL-04 (FIXED) · test:product-surface-audit B1 | SIMULATED (live: 0 commissions) |
| 11 | agent with an admin grant | Admin › Transaction forms | the library opens with oversight (the code honours the grant, as SQL does); links are minted per view | ledger 145A-SO-06 (FIXED) | SIMULATED |
| 12 | compliance_officer | Settings › Required documents: open a template | a stored packet links to the library (minted link), never a stored bearer URL | ledger 145A-OL-05 (FIXED) | SIMULATED |
| 13 | agent (second tenant) | try to open a ticket or form from tenant 1 by id | refused; nothing from tenant 1 is shown | test:support-isolation · test:tenant-scope | SIMULATED |
| 14 | any seat | Help › raise a support ticket | the ticket appears under "My tickets" | product-surface "Errors · support tickets" | SIMULATED (live: 0 tickets) |
| 15 | agent | close a deal (event) | points awarded once; the Motivation board shows them; a replay adds nothing | product-surface "Gamification" · test:gamification | SIMULATED (live: 0 point rows) |

## 2. What the demo cannot show yet

- **Provider keys / LICENSES (owner):** e-sign (DocuSign), SMS / voice, Meta / Google Ads, IDX photos, RentCast, Datafiniti rights,
  D-ID / video, Trends / Search Console, Versium. Every leg is an injected seam in the proofs. No real provider call has been made.
- **Remotion:** the render-host company LICENSE and hosting are owner-held. Local render recovery is proved in memory only.
- **Topic pool:** 0 live rows. Some producers still write directly instead of through the one intake (lane 154G1, running at hand-off).
- **Campaign identity on a contact-card bundle send:** the door passes no campaign, so attribution stays empty. It is never guessed
  (lane 154H2 owns the fix).
- **10-year signed URLs** on the other document tables (ledger 146A-SO-02) stay open. They matter once O1 makes the buckets private.
- **Counsel:** the SaaS agreement drafts are unpublished until counsel approves them.

## 3. How a step becomes LIVE-VERIFIED

Run it on the preview deployment as the named seat. Then read the writer's row back through its reader (the "reader" column of
docs/operations/WAVE154-PRODUCT-SURFACE-AUDIT.md) and record the timestamp and row id in the wave report. Until that happens,
the word stays SIMULATED.
