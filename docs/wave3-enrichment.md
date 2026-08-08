# Wave 3 — Contact Enrichment Lane

Owner's ruling (verbatim):

> "contact enrichment should happen as soon as a new contact comes in and also check
> if a life change or other change happens for the contact but not if they have an
> active listing or an active transaction; just before or after."

Acceptance criteria:
1. Enrichment fires on contact create (event-driven).
2. Re-check for life change / material change on existing contacts.
3. Suppressed while the contact has an ACTIVE LISTING or ACTIVE TRANSACTION.

## Status log

- [x] Read `app/actions/contact-enrichment.ts` — confirmed exports as briefed.
- [ ] Enumerate contact-create doors
- [ ] Verify listing/transaction vocabulary (live DB + guards)
- [ ] Build suppression predicate
- [ ] Wire create-time hook
- [ ] Wire re-check signal
- [ ] Cron decision

## Confirmed baseline

`app/actions/contact-enrichment.ts` exports (verified by read):
`enrichContact`, `enrichContactsBatch`, `checkContactLifeChanges`,
`getUnenrichedContacts`, `getContactsNeedingLifeChangeCheck`, `getRecentLifeChanges`,
`markLifeChangeNotified`, `enrichContactData`, `getContactInsights`.

- `getUnenrichedContacts` / `getContactsNeedingLifeChangeCheck` both begin
  `const ctx = await getAgentContext(); if (!ctx.brokerageId) return { contacts: [], count: 0 }`
  — confirmed session-gated, so the cron gets zero rows. Comment at line ~382 admits it.
- No suppression check of any kind in this file. Criterion 3 absent — confirmed.
- `enrichContactsBatch` is gated + tenant-filtered + capped at `ENRICH_BATCH_MAX = 200` (Wave 2). Do not regress.

## Live-verified vocabulary (Supabase project hrvaqgvukzxfskkcrwbt)

`listings_status_check`  = draft | listing_signed | coming_soon | active | pending | withdrawn | cancelled | off_market | expired | sold
`listings_lifecycle_stage_check` = 34 values, LEAD … MLS_ACTIVE … UNDER_CONTRACT … CLOSED | LIFETIME_CUSTOMER | LISTING_CANCELLED | LISTING_EXPIRED. NOT NULL.
`transactions_status_check` = lead | qualifying | active | under_contract | pending | clear_to_close | closed | funded | lost | archived
`transactions_stage_check`  = NULL or UNDER_CONTRACT | INSPECTION | APPRAISAL | FINANCING_PENDING | CLOSING_PREP | CLOSED | LOST

These match `scripts/check-vocabularies.ts` exactly (listings @854, transactions @1481) — the settled snapshot is current.

### Contact linkage (live FKs → contacts.id)
- `listings.contact_id`, `listings.seller_contact_id`
- `transactions.contact_id`, `transactions.buyer_contact_id`, `transactions.seller_contact_id`

### contacts enrichment columns (live)
`enriched_at`, `enrichment_source`, `enrichment_confidence`, `enrichment_profile` (jsonb),
`last_enriched_at`, `last_life_change_check`, `last_life_event_detected`, `life_events` (jsonb).
NOTE: `enriched_at` (Lane B) and `last_enriched_at` (Lane A) are DIFFERENT columns owned by different lanes.

## THE BIG FINDING — there are TWO enrichment lanes, and only one is alive

### Lane A — queue-based, ALIVE
- `lib/kernel/crm.ts:enrichContactAfterIntake` writes a `lead_enrichment_queue` row.
  Called (voided, non-blocking) from `createOrUpdateContactFromDirectIntake` step 5.
- Drained by `lib/lead-pipeline/enrichment-orchestrator.ts:processEnrichmentQueue(brokerageId)`
  — takes the tenant EXPLICITLY as an argument, no session.
- Unattended door: `app/api/cron/enrichment-processor/route.ts` loops brokerages and calls it.
  **This is already the exact pattern item 4 asks for.**
- Does: PeopleData skip trace, phone scrub/DNC election, vendor cost tracking, retries, writes
  `contacts.enrichment_profile` + `last_enriched_at`.

### Lane B — `app/actions/contact-enrichment.ts`, DEAD
- Does what Lane A does NOT: OSINT life events, email/phone validation, demographic columns,
  `life_events` / `last_life_change_check`.
- Its cron is dead (session gate). Criterion 3 (suppression) absent from BOTH lanes.

=> Not a delete/merge: Lane B holds real capability Lane A lacks. The seam is what is missing.

## The create-doors — ENUMERATED (18 distinct `contacts` INSERT sites in app/ + lib/)

| # | Door | emits CONTACT_CREATED/CAPTURED | queues enrichment |
|---|------|---|---|
| 1 | `lib/kernel/crm.ts:298` (`createOrUpdateContactFromDirectIntake`) — canonical kernel command; `createContactManually` wraps it | yes | yes (`enrichContactAfterIntake`) |
| 2 | `lib/contact-pipeline/contact-capture.ts:171` + `:415` (`captureContact`) | yes | yes (own inline insert) |
| 3 | `app/actions/home-value.ts:159` + `:337` — AVM / home-value capture | yes | no |
| 4 | `app/actions/seller-open-house.ts:708` | yes | no |
| 5 | `app/api/widget/intake/route.ts:138` — embeddable widget | no | yes (own inline insert) |
| 6 | `lib/ghl-integration.ts:282` — GHL CRM sync | no | yes (own inline insert) |
| 7 | `app/actions/agent-public-profile.ts:62` — public agent profile form | no | no |
| 8 | `app/api/open-house/attend/route.ts:85` — public open-house sign-in | no | no |
| 9 | `app/api/webhooks/twitter/route.ts:131` | no | no |
| 10 | `app/api/webhooks/linkedin/route.ts:110` | no | no |
| 11 | `app/api/webhooks/meta/route.ts:119` | no | no |
| 12 | `app/api/webhooks/whatsapp/route.ts:162` | no | no |
| 13 | `lib/ads/ad-lead-intake.ts:77` — paid-ad lead intake | no | no |
| 14 | `lib/application/lead-application-service.ts:332` | no | no |
| 15 | `lib/contact-promotion/contact-creator.ts:217` — lead → contact promotion | no | no |
| 16 | `lib/kernel/lead-magnets.ts:435` — lead-magnet capture | no | no |
| 17 | `lib/kernel/listings.ts:301` — seller contact auto-created with a listing | no | no |
| 18 | `lib/kernel/open-house.ts:184` | no | no |
| 19 | `lib/services/contact-management.service.ts:86` (`createContact`) — CRM manual add | no | no |

**There is no single code-level chokepoint.** 4 of 19 queue enrichment today; 15 do not.

## Built so far

1. `lib/enrichment/deal-suppression.ts` — THE predicate. `isContactInLiveDeal({contactId, brokerageId})`
   + batch form `contactsInLiveDeals`. Pure classifiers `isListingLive` / `isTransactionLive`.
   Vocabulary partitioned EXHAUSTIVELY (BEFORE/ACTIVE/AFTER) and verified to cover the live
   CHECK exactly (34/10/10/7, disjoint, no gaps). Fails CLOSED on any read error.
   - NOT reused: `lib/transactions/closing-overdue-policy.ts:TERMINAL_TXN_STATUSES` — it omits
     `funded` and `archived` (both terminal) and contains 4 literals the live CHECK cannot hold.
     Negating it would suppress every funded/archived deal's contact forever.
2. `lib/enrichment/contact-enrichment-core.ts` — the WORK, tenant passed in.
   `enrichContactRecord`, `runLifeChangeCheck`, `listUnenrichedContacts`,
   `listContactsDueForLifeChangeCheck`. Suppression + `checkVendorBudget` pre-flight +
   `trackVendorUsageService` ledger (house rails, nothing invented).
3. `app/actions/contact-enrichment.ts` — now the SESSION door; same 9 exports, same shapes.
   Also closed two leaks found en route: `getRecentLifeChanges` had NO brokerage filter at all
   (cross-tenant life events incl. divorce/bankruptcy), and `getContactInsights` was a bare PK
   lookup (cross-tenant household income / court records).
4. `app/api/cron/contact-enrichment/route.ts` — KEPT, rebuilt as the UNATTENDED door.
   Iterates active brokerages, passes brokerage_id explicitly, never reads a tenant from the
   request. Bounded per-brokerage (25/25) and globally (RUN_VENDOR_CALL_BUDGET = 500 vendor
   calls per run). GHL third pass deleted — strict subset of pass 1.

## TODO
- [ ] create-time hook at the chokepoint(s)
- [ ] life-change re-check on a real signal (deal end)
- [ ] suppression on the OTHER lane (enrichment-orchestrator + enrichContactAfterIntake)
- [ ] guard script

## FINAL SHAPE

### The lane
```
CREATE (19 doors)
  ├─ doors that emit CONTACT_CREATED / CONTACT_CAPTURED
  │     → lib/kernel/event-reactor.ts (D-quinquies)  ← THE CHOKEPOINT
  ├─ 8 doors hooked directly (they emit no kernel event)
  └─ everything else → the nightly net
        ↓
  lib/enrichment/contact-enrichment-core.ts:queueContactEnrichment
     · required tenant · freshness (BOTH stamps) · pending-row idempotency
     · live-deal suppression · identifier guard
        ↓  lead_enrichment_queue (pending)
  lib/lead-pipeline/enrichment-orchestrator.ts:processEnrichmentQueue  (cron, 15 min)
     · RE-checks suppression before spending  · routes 'osint_profile' → life-change check
        ↓
  enrichContactRecord  /  runLifeChangeCheck
     · suppression · checkVendorBudget pre-flight · trackVendorUsageService ledger

DEAL ENDS (TRANSACTION_CLOSED / *_STAGE_CHANGED)
  → event-reactor (D-sexies) → queueContactLifeChangeRecheck → same queue

NIGHTLY NET  app/api/cron/contact-enrichment  (unattended door, tenant explicit)
  → listUnenrichedContacts / listContactsDueForLifeChangeCheck per brokerage
```

### Definition of "active" (verified live + against scripts/check-vocabularies.ts)
- **Listing is live** iff `lifecycle_stage ∉ {CLOSED, LIFETIME_CUSTOMER, LISTING_CANCELLED,
  LISTING_EXPIRED, SELLER_DECLINED}` AND (`lifecycle_stage ∈` the 19 stages from
  `LISTING_AGREEMENT_SIGNED` through `CLOSING_PREP`, OR `status ∈ {listing_signed, coming_soon,
  active, pending}`). Terminal stage is DECISIVE — `status` can only add suppression.
- **Transaction is live** iff `status ∉ {closed, funded, lost, archived}` AND
  (`status ∈ {active, under_contract, pending, clear_to_close}` OR
  `stage ∈ {UNDER_CONTRACT, INSPECTION, APPRAISAL, FINANCING_PENDING, CLOSING_PREP}`).
  Terminal status is DECISIVE (stage is nullable and not cleared on close).
- Linkage: all FIVE live FKs to contacts(id).
- Fails CLOSED on any read error.

### Cron decision: KEPT, rebuilt as the unattended door + safety net
15 of 19 create doors reach no kernel event; retiring the cron would leave those contacts
never enriched. It now iterates active brokerages and passes brokerage_id explicitly, reads no
tenant from the request, verifies CRON_SECRET, asserts no fake identity, and is bounded
per-brokerage (25/25) and globally (RUN_VENDOR_CALL_BUDGET = 500 vendor calls/run).

### Deletion
`lib/ghl-integration.ts:queueContactEnrichment` (private, no caller) —
survivor `lib/enrichment/contact-enrichment-core.ts:queueContactEnrichment`.
It omitted `brokerage_id`; the drain filters `.eq('brokerage_id', …)`, so every row it wrote
was invisible to every drain. Bad implementation not ported; the class is fixed at the
survivor (tenant REQUIRED). Its surface (inbound CRM import) is already wired via
lib/crm/import-pull.ts → processImportRows → captureContact.

### Deliberately left
- The 4 social-DM webhooks (meta/whatsapp/twitter/linkedin) create a
  `{first_name:"Social", last_name:"Lead"}` stub with no email/phone. `hasUsableIdentifier`
  refuses them — a PeopleData record + 6 ZenRows scrapes for a guaranteed miss. They enrich
  automatically once the conversation yields a real identifier.
- The 15 doors that emit no CONTACT_CREATED also miss notifications, sequences, portal cards
  and concierge spawn. That is a much wider wiring defect than this slice; recorded, not fixed.

### Guards
`npm run test:enrichment-suppression` (scripts/enrichment-suppression-simulator.ts) —
83 assertions, added to the `guard` chain. Re-ran green: check-vocabulary, use-server-exports,
no-orphan-actions, orphan-exports (contact-enrichment 2→0), no-dead-components,
client-server-only, tenant-scope, session-rails, vocabulary-drift, cron-dispatch,
event-dispatch, agent-id-class, orphan-routes.
