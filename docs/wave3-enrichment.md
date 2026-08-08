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
