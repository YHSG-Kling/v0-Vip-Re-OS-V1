# Wave 10 — obligation 5: terms saved on the deal, every party told

> once the transaction is created, the terms/dates need to be saved to the
> transaction and all parties of the transaction notified of such info, dates,
> contingencies, parties contact info etc.

Two halves. The brief said the SAVE half was "largely built — verify it, do not
rebuild it". Verified field by field against the LIVE schema
(Supabase MCP, project `hrvaqgvukzxfskkcrwbt`). **The brief is wrong on the save
half**, and the correction is the larger finding of this slice.

---

## 1. The SAVE half — field-by-field verdict against the live schema

The audit doc (and my brief) claim the bridge "already writes `purchase_price`,
`closing_date`, `earnest_money`, `earnest_money_due_at`/`_days`, the three
contingency-day columns". Reading `lib/transactions/offer-bridge.ts` and the live
`transactions` table, only two of those were true.

### Persisted BEFORE this slice

| Ruling term | Column / row | Status |
|---|---|---|
| purchase price | `transactions.purchase_price` | ✅ written from `offers.offer_price` |
| earnest deposit AMOUNT | `transactions.earnest_money` | ✅ written |
| contract (execution) date | `transactions.contract_date` | ✅ written |
| compliance stamp | `transactions.compliance_passed_at` | ✅ written |
| earnest-money DUE DATE | `transaction_milestones` (`earnest_money_due`) | ✅ derived TZ-safely by `deriveEarnestDueDate`. **There is no earnest-due column on `transactions`** — the milestone IS the persistence, correctly |
| NON-standard contingencies | `transaction_deadlines` (`contingency_*`) | ✅ via `ensureContingencyDeadlines` |
| standard contingencies | `transaction_milestones` | ✅ via `ensureRequiredMilestones` |
| e-sign provider tracking | `external_provider_*` | ✅ |

### DROPPED ON THE FLOOR (now fixed)

| Ruling term | Live column | Before | Evidence |
|---|---|---|---|
| closing date | `transactions.close_date` (date) | **NULL forever.** `offers.closing_date` was `SELECT`ed by the bridge's offer query and never referenced again; the value only reached a milestone | grep: no writer of `transactions.close_date` on the offer→deal path (`lib/kernel/offers.ts:533` writes it on a *different* creation path; `demo-tenant.ts` seeds it) |
| inspection deadline | `transactions.inspection_deadline` (date) | **NULL forever** | same |
| appraisal deadline | `transactions.appraisal_deadline` (date) | **NULL forever** | same |
| financing deadline | `transactions.financing_deadline` (date) | **NULL forever** | same |

Those four are not decorative. **Six live readers** key off them and were reading
NULL on every offer-created deal:
`lib/kernel/fire-drills.ts:182`, `lib/kernel/team-query.ts:104`,
`lib/kernel/client-pulse.ts:148` and `:199`, `lib/managers/deliberation.ts:333`,
`lib/workflow/intelligence/proactive-checks.ts:391` (plus every `close_date`
reader: commission waterfall, team P&L, agent scorecard, negotiation bands).

### A second, worse defect inside the same fields: the deadlines were CLOCK-anchored

Every caller computed the contingency deadlines as `Date.now() + days`:

- `app/actions/buyer-offer/submit-to-compliance.ts` — its local `fromContract`
  helper is named for the contract and computed from `Date.now()`
- `app/actions/seller-offers.ts` — `acceptOffer`'s `contractTerms` block
- `lib/kernel/transactions.ts` — `createTransactionFromCompliantAcceptedOffer`

A contract says "inspection within 10 days **of execution**". Days-from-button-click
equals days-from-execution only when the contract was executed today — which is
exactly what an INBOUND offer (this whole wave) is not. A contract executed 6 days
before it is processed got every deadline pushed 6 days late, silently.

`lib/kernel/transactions.ts` was worse still: `earnestMoneyDue: earnestMoney ? now + 3 days : undefined`
— a money deadline invented from the mere existence of a dollar amount.

### What this slice changed (save half)

- New pure `deriveContractDeadlines()` in `lib/transactions/offer-bridge.ts`:
  contract_date + the offer's own day columns via TZ-safe UTC math
  (`addDaysToDateString`), falling back to the caller's term **only when it is a
  real calendar date** (`isCalendarDate` refuses a mis-passed `"$5000"`).
- The bridge now selects `inspection_period_days`, `appraisal_contingency_days`,
  `financing_contingency_days` and persists `close_date`, `estimated_close_date`,
  `inspection_deadline`, `appraisal_deadline`, `financing_deadline`.
- The milestone seeder is fed from the **same** derivation, so a deal row and its
  milestone card can no longer disagree.
- `lib/kernel/transactions.ts` no longer carries a second copy of the date math —
  it imports `deriveContractDeadlines` from the bridge (duplicate merged onto the
  survivor: `offer-bridge.ts:deriveContractDeadlines` beats the inline
  `Date.now()` math in `kernel/transactions.ts:createTransactionFromCompliantAcceptedOffer`)
  and no longer invents an earnest-money due date.

### Still dropped — schema gap, NOT fixed here (no column exists)

`offers.financing_type`, `down_payment_amount`/`_percent`,
`closing_cost_contribution`, `due_diligence_fee`, `possession_terms`,
`escalation_clause`/`escalation_cap`, `appraisal_gap` have **no corresponding
`transactions` column** (`transactions.loan_amount` exists but is a lender figure,
not the offer's down-payment). Persisting them needs DDL; inventing a home for
them in `metadata` would have created a second vocabulary. They are named here so
the next slice can decide deliberately. They DO reach the notice through the
offer row where relevant (contingencies) — nothing in the ruling's list is
unsaved *and* untold.

---

## 2. The NOTIFY half — it did not exist

Confirmed: no `transaction_created` notification anywhere in `app/` or `lib/`.
Worse than absent — the one path that *looks* like it notifies staff cannot:

> `lib/kernel/notification-engine.ts:183-196` resolves recipients for
> `entityType='transaction'` by pushing `transactions.agent_id` straight into
> `notifications.user_id`. Live FKs: `transactions.agent_id → agents(id)`,
> `notifications.user_id → users(id)`. **Disjoint id spaces.** Every such insert is
> an FK violation, caught by the inner `try/catch` and logged. The deal's own agent
> has never received a transaction-entity notification.
> *(Reported, not fixed — `notification-engine.ts` is outside this slice's file
> scope. The new fan-out resolves the hop itself and does not depend on it.)*

### WHO — recipient resolution and its evidence

| Recipient | Source of truth | Id hop |
|---|---|---|
| deal agent | `transactions.agent_id` | agents.id → `resolveAgentRecordToUserId` → users.id |
| listing (seller-side) agent | `listings.agent_id` | agents.id → users.id |
| the deal's TC | `transactions.coordinator_id` **and** `transaction_assignments.coordinator_id` | → `transaction_coordinators.user_id` (users.id) |
| the brokerage TC bench | `users.user_type ∈ rawRoleVariantsFor(['tc'])` | users.id (reused from `notifyComplianceFlag`, so the historic `'TC'` vs `'tc'` bug stays fixed in one place) |
| our buyer / our seller | `transactions.buyer_contact_id` / `seller_contact_id` | contacts.id |
| outside professionals | `transaction_participants` rows with an email that resolve to no staff user | email |

Both coordinator sources are read on purpose: `MAINTENANCE_DOMAINS.client_journey_and_coordinator_split`
records that one surface writes only the column and another only the junction —
reading one would drop half the TCs.

**Roster verification (the brief asked me to check the submit-to-compliance
docblock's claim of buyer / buyer_agent / seller / seller_agent):** the claim is
*understated*. `lib/transactions/participant-populator.ts` seeds up to SIX roles —
`buyer`, `buyer_agent`, `seller` (only with an in-house listing), `seller_agent`
(same), plus `lender` (from the buyer's most recent `pre_approval_letter` scan)
and `title_company` (from the `signed_contract` scan). `lib/documents/auto-populate-participants.ts`
adds `lender`/`title_company` later, post-scan, when the transaction already
exists. `lib/application/transactions.ts` only offers manual CRUD
(`addParticipant`/`updateParticipant`/`removeParticipant`) — it is not an
automatic writer. Notification therefore runs AFTER `populateInitialParticipants`
in the bridge: that roster is both the recipient list and the contact-info block.

### WHAT each audience is told, and why

All three payloads are composed by the pure
`lib/notifications/transaction-parties-packet.ts` (no I/O, no `server-only`, so
the boundary is provable without a database).

| Audience | Channel | Terms/dates/contingencies | Roster |
|---|---|---|---|
| **Staff** (deal agent, listing agent, TC bench) | in-app `notifications` (users.id), priority high | full | **complete** — both principals with email + phone. They are the file's custodians |
| **Our principal** (buyer or seller CONTACT) | portal card `transparency_updates` + portal bell `notifications.contact_id` | full, their side's wording | professionals + **their own row only**. The counterparty principal is dropped whole — no name, no email, no phone |
| **Outside professional** (cooperating agent, outside lender/title) | email via `dispatchEmail` (THE gate) | full | **professionals only** — no principal from either side |
| **Outside buyer / outside seller** | **deliberately none** | — | — |

Justifications:
- A CONTACT is not staff, so nothing internal (compliance timestamps, commission,
  net-sheet, participant notes) is in the client payload.
- One side's private CRM data is not the other side's to receive. The executed
  contract discloses whatever it discloses; our copy of the counterparty's mobile
  number is not part of that. When the viewer's own side cannot be resolved,
  **both** principals are dropped — an unresolved viewer is never a reason to leak.
- The outside buyer/seller is represented by another brokerage. Contacting them
  directly around their agent is an ethics problem and a consent we do not hold;
  they are returned in `skipped_outside_principals` with the reason, never
  silently dropped. Their agent — who is on the roster — is told, and tells them.
- Anything leaving the building rides `lib/providers/dispatch.ts:dispatchEmail`,
  which runs suppression (`contact_suppression_list` + contact flags), outbound
  compliance and de-confliction; the participant's address is resolved to a
  `contacts` row first, when one exists, precisely so those gates have something
  to key on. No raw `lib/providers/messaging` sender is imported
  (`test:egress-send-guard` green, allowlist untouched).

### Idempotency

1. **Global marker** — `activities(activity_type='transaction_parties_notified',
   transaction_id)`. Checked first; a hit returns `already_notified: true` and
   fans out nothing. The read **fails closed**: a refused query returns without
   notifying rather than treating "no rows" as "not yet notified".
2. **Per recipient** — staff recipients already holding a
   `notifications` row of this type for this transaction are filtered out; the
   client bell is deduped the same way; the portal card relies on the DEPLOYED
   `transparency_updates_dedupe_idx`, and a `23505` from it is treated as
   *already delivered*, not as a failure.
3. **Per outbound recipient** — email has no row of its own to dedupe on, so each
   accepted send writes a `transaction_parties_emailed` activity carrying the
   address, and that row is checked before the next send. Also fails closed: a
   refused lookup skips the send rather than risk a duplicate. Without it, a
   crash between the send and the marker would email the cooperating agent twice.
4. **The marker is written only after real delivery.** A run that reached nobody
   writes no marker, so a retry can still notify. A run that delivered writes the
   marker, so a retry is a no-op.

### Zero-recipient honesty

`sent` is computed from the actual delivered sets
(`staff_user_ids ∪ contact_ids ∪ emailed`), never assumed. Zero recipients ⇒
`sent:false`, a reason pushed onto `errors`, and a `console.error` naming the
transaction. The bridge re-reports it (`[offer-bridge] transaction … created but
NO party was notified`) and surfaces `partiesNotified` on its return value. Every
Supabase write in the fan-out destructures its `error` (proved structurally, 4/4).

---

## 3. Surfaces

| Surface | What changed |
|---|---|
| Staff notification bell (`notifications`, `user_id`) | receives the internal packet — terms, dates, contingencies, full roster with contact details |
| Client portal (`app/portal/[contactId]/{buyer,seller}-home.tsx` → `transparency_updates`, `is_visible_to_client`) | receives the client packet as a card (+ `next_step` / `next_step_date` = earnest-money due) and a bell ping |
| Client portal "team" panel (`lib/application/transactions.ts:getClientPortalData`) | **pre-existing leak closed.** It mapped the whole `transaction_participants` table into `team` — the buyer could read the seller's personal email and phone, and vice versa. It now runs the same `rosterForPrincipal` redaction the notice uses. One rule, one implementation |
| Transaction detail pages | already render `transaction_participants`; unchanged (staff surface, full roster is correct there) |

No new UI was needed: every audience already has a live surface that reads the
tables written here.

---

## 4. Proof

`npm run test:parties-notify` → `scripts/transaction-parties-notify-simulator.ts`
(registered in the `guard` chain before `test:silent-write`, owned by
`deal_coordinator` via `MAINTENANCE_DOMAINS.transaction_parties_notification`).
56 assertions across pure / source / live(creds-gated) layers. Constructs, not
spellings: the redaction assertions are computed from the *data of the withheld
row*, so re-wording any copy cannot break them; the column assertions are scoped
to the `transactions` INSERT block.

### Negative controls (every new assertion class)

| # | Bug reintroduced | Result | Restored |
|---|---|---|---|
| 1 | `close_date` removed from the transactions insert | **first run stayed GREEN** — the regex `close_date:` was satisfied by `estimated_close_date:`. Assertion hardened to a word-boundary key match, then RED (2 failures) | green |
| 2 | `deriveContractDeadlines` switched back to `Date.now() + days` | RED (5) | green |
| 3 | `rosterForPrincipal` stops dropping the counterparty | RED (4) | green |
| 4 | one Supabase write left without `const { error }` | RED (1: "4 writes, 1 bare") | green |
| 5 | zero-recipient guard removed (marker written regardless) | RED (1) | green |
| 6 | notify moved BEFORE `populateInitialParticipants` (blocks physically swapped) | RED (1) | green |
| 7 | outbound per-recipient dedupe short-circuit removed (`if (alreadyEmailed) continue`) | RED (1) | green |

NC #1 is the point of running negative controls: the assertion passed for the
wrong reason and would have shipped a proof that could not fail.

---

## 5. Corrections to the brief / audit doc

1. **`offer-bridge.ts` did NOT save `closing_date`, `earnest_money_due_at/_days`
   or "the three contingency-day columns" to the transaction.** `transactions` has
   no earnest-due column and no contingency-DAY columns at all — it has four
   DATE columns, and all four were writerless on this path. `offers.closing_date`
   was selected and discarded.
2. **All four accept flows computed contingency deadlines from the clock, not the
   contract** — the exact failure mode the inbound lane triggers.
3. **`lib/kernel/transactions.ts` fabricated an earnest-money due date**
   (`now + 3 days`) from the existence of a deposit amount.
4. **`transaction_participants` is written by three modules, not two** — the brief
   named `lib/application/transactions.ts` (manual CRUD only) and
   `lib/documents/auto-populate-participants.ts` (post-scan), but the automatic
   creation-time writer is `lib/transactions/participant-populator.ts`, and it
   seeds six roles, not four.
5. **The staff notification path was not merely missing — it is broken by an
   id-class bug.** `notification-engine.ts:resolveRecipients` writes
   `transactions.agent_id` (agents.id) into `notifications.user_id` (users FK).
   Outside this slice's file scope; reported for the next one.
6. **The client portal's team panel leaked the counterparty's contact details**
   (`getClientPortalData`). Same boundary this obligation is about; closed here.
