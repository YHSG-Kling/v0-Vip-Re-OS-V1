# Wave 5 — Lead Enrichment Lane (Track A door coverage)

Owner's rulings (verbatim):

> "enrichment also needs to still happen with raw leads"

> "no ghl on when a contact is syncing to it. we only enrich the contact in this system."

Reading of the second: enrichment must NOT be TRIGGERED by a GHL sync, and enrichment
output stays in THIS system — never pushed outward to GHL. (GHL is sync-out only,
settled law.) **CONFIRMED against the code — see "GHL" below.**

## Baseline verified by read (2026-08-09)

- `lib/lead-pipeline/enrichment-orchestrator.ts` line 2 confirms: "Processes BOTH lead_id
  rows (Track A) and contact_id rows (Track B)." `entityType = entry.lead_id ? 'lead' : 'contact'`
  at :99, both-null rows failed at :84, `peopleDataProfileToLeadColumns` at :295.
  CONFIRMED — the drain already supports both tracks. The gap is door coverage.
- `lib/enrichment/contact-enrichment-core.ts:78` — `EnrichmentSource` includes `"ghl_sync"`. CONFIRMED.
- `queueContactEnrichment` takes `contactId` only, writes `lead_id: null` at :208. CONFIRMED.
- Orchestrator :116 asks suppression only `if (entityType === 'contact')`.

## LIVE SCHEMA (project hrvaqgvukzxfskkcrwbt, queried 2026-08-09)

`lead_enrichment_queue` columns: id, **lead_id (uuid, NULL ok, FK→leads)**, trigger_type,
status, enrichments_needed, enrichment_results, confidence_score, error_message,
retry_count, max_retries, enrichment_cost, queued_at, completed_at, brokerage_id,
**contact_id (uuid, NULL ok)**, enrichment_type.
Only CHECK on the table: `lead_enrichment_queue_enrichment_type_check` =
`skip_trace | property_match | phone_validation | osint_profile | duplicate_check`.
No CHECK on `status` or `trigger_type`.

`leads` CHECKs: lifecycle_state = raw | unconsented | isa_qualifying | consented | assigned |
appointment | representation | long_term_nurture. source_family = raw | lead | contact_direct.
source_origin = platform | brokerage. urgency_level = hot|warm|cool|cold.
**There is NO CHECK on `leads.enrichment_status`.**

`leads` enrichment columns: `enrichment_confidence` (numeric), `enrichment_profile`
(jsonb, **NOT NULL**, defaults `{}`), `enrichment_provider` (text), `enrichment_status`
(text), `last_enriched_at` (timestamp). Plus `contact_id` (uuid, NULL ok).

### THE DECISIVE FK FACT (item 3)

FKs *referencing* `leads` — 37 tables. **`listings` is not one of them. `transactions` is
not one of them.** Column scan confirms: `listings` has only `contact_id` /
`seller_contact_id`; `transactions` has only `contact_id` / `buyer_contact_id` /
`seller_contact_id`. There is no `listings.lead_id` and no `transactions.lead_id`.

FKs *from* `leads`: agent_id→agents, brokerage_id→brokerages,
campaign_attribution_id→marketing_campaigns, **contact_id→contacts**,
distribution_brokerage_id→brokerages.

=> **A raw lead CANNOT be in a live deal directly.** The only bridge is
`leads.contact_id`. See the suppression decision below.

## THE LEAD-CREATE DOORS — ENUMERATED

Method: `rg` for `.from('leads')` + `.insert` (multiline), then a second, differently-shaped
search for indirect writers — `TABLE`/`LEADS` constants, `.rpc(` with "lead", and
`from(table)`/`from(tableName)`/`from(\`` template forms. Both searches agree: there are
**exactly THREE `leads` INSERT sites in app/ + lib/** (everything else is `scripts/`).

| # | Door | live caller? | enriches today | emits a kernel event | hooked by this wave |
|---|------|---|---|---|---|
| 1 | `lib/lead-pipeline/pipeline-processor.ts:457` — the automatic raw→lead pipeline | **YES — the only live door** | inline `enrichWithPeopleData` ONCE, before insert; result discarded on miss | `RAW_RECORD_PROMOTED` (entityType `raw_scraped_lead`, `metadata.lead_id`) | via the reactor chokepoint |
| 2 | `lib/kernel/crm.ts:431` `createLeadOnlyRecordForAcquisitionSource` | no production caller (exported via `lib/kernel/index.ts:99`) | no | no | DIRECT hook |
| 3 | `lib/lead-promotion/lead-promoter.ts:82` `promoteRawRecordToLead` | none, and `scripts/lead-pipeline-simulator.ts:204` ASSERTS it must have none | no | no | DIRECT hook |

Existing `lead_id` queue writers (verified):
- `lib/kernel/lead-acquisition-handlers.ts:74` (`handleLeadCaptured`) — **no production
  caller** (only re-exported at `lib/kernel/index.ts:145`). A bare INSERT: no freshness
  check, no pending-row idempotency, no identifier gate, no suppression, no budget gate.
- `lib/lead-pipeline/persona-drift-runner.ts:39` (`requeueOne`) — has idempotency, but it
  is a REFRESH sweep for already-enriched records, not a create-time door.

**So neither existing lead_id writer covers lead creation at all.** Door 1 — the only live
one — never queues anything; it enriches inline exactly once and then stamps the lead as
finished whether or not the provider matched.

### The "already enriched" lie (why a freshness check on `last_enriched_at` alone is wrong)

`pipeline-processor.ts:486` and `lead-promoter.ts:107` both write, unconditionally at INSERT:
`enrichment_status: 'completed'` + `last_enriched_at: new Date().toISOString()`.
`enrichWithPeopleData` is called `.catch(() => ({ data: null }))` and on a miss returns a
base object with `enrichmentConfidence: 0.3` and nothing else. So a lead PeopleData never
matched — or that threw — is born stamped "enriched just now, completed". Any freshness gate
keyed on `last_enriched_at` would refuse to ever queue it.

The honest test, and the one this wave uses: a lead is fresh iff `last_enriched_at` is recent
**AND `enrichment_profile` is a non-empty object**. `enrichment_profile` is NOT NULL with
default `{}`; neither create door writes it, and only a real drain success populates it
(`enrichment-orchestrator.ts:301`). This needs no edit to either create door.

### Adjacent defect found, RECORDED NOT FIXED (different owner surface)

`enrichment_status` vocabulary is split. The two create doors write `'completed'`
(pipeline-processor:486, lead-promoter:107) while the drain writes `'complete'`
(enrichment-orchestrator:297) — and BOTH gates read `'complete'`:
`lib/lead-governance/promotion-readiness.ts:37` and
`lib/lead-governance/routing-evaluator.ts:70`. Every pipeline-born lead therefore fails the
promotion-readiness and routing-eligibility gates until something re-enriches it.
Not fixed here: flipping the literal changes routing eligibility for every existing lead,
which is a lead-governance decision, not an enrichment one. Wiring the lead track FIXES it
as a side effect for new leads — the drain writes `'complete'` on success.

## SUPPRESSION — the lead-side decision (item 3)

**Decision: a raw lead is never suppressed on its own account; it is suppressed only through
a RESOLVED `leads.contact_id`.**

Reasoning, from the live schema rather than from analogy:
1. "Active listing" and "active transaction" are the owner's two suppression conditions.
   Neither table can point at a lead — there is no `listings.lead_id` and no
   `transactions.lead_id` (FK scan + column scan above). So the question "is THIS LEAD in a
   live deal" is unanswerable in the lead's own id space, and answering it as "no" would be
   a guess, not a fact.
2. `leads.contact_id` (FK→contacts) is the only bridge, and it is exactly the case that
   matters: `handleLeadAssigned` converts a lead to a contact and stamps `leads.contact_id`
   (`lead-acquisition-handlers.ts:413`). A converted lead whose contact then signs a listing
   MUST be suppressed, or the lead-side lane pays to enrich a client mid-deal — the precise
   thing the ruling forbids.
3. `leads.id` and `contacts.id` are disjoint. The lead-side predicate therefore RESOLVES
   `leads.contact_id` and passes the CONTACT id to `isContactInLiveDeal`. It never passes a
   lead id to a contact-keyed predicate and never coerces one to the other with `??` or `""`.
4. Fails CLOSED, same as the contact side: if the `leads` row cannot be read, or the
   resolved contact's deal read fails, the verdict is "suppressed".

## GHL — what was actually found (item 4)

Both halves of the owner's rule were checked separately.

**TRIGGER — one dead vocabulary entry, no live path.**
- `lib/ghl-integration.ts:77 syncContactFromGHL` is already DISABLED (returns
  `"Inbound CRM sync is disabled — GHL is sync-out only"`).
- `app/api/webhooks/gohighlevel/route.ts:45-49` verifies the signature and then ignores the
  event — "GHL is one-way OUT only".
- Wave 3 deleted `lib/ghl-integration.ts:queueContactEnrichment` and the cron's GHL third pass.
- What REMAINED is vocabulary that admits the trigger back: `EnrichmentSource` at
  `contact-enrichment-core.ts:78` still listed `"ghl_sync"`, and the `triggerType` docstring
  at :133 still advertised `'ghl_sync'` as an example. **REMOVED both.** Nothing referenced
  the member (second search over `app/`, `lib/`, `scripts/` for `ghl_sync` returns only the
  unrelated `messages.metadata.ghl_synced` flag at ghl-integration.ts:190/209).
- The one live GHL→enrichment path is `lib/crm/import-pull.ts:pullGoHighLevel` → the bulk
  CRM MIGRATION importer → `processImportRows` → `captureContact` → enrichment. That is a
  one-off tenant-initiated migration import, not "a contact syncing to GHL", and the
  contacts it creates are enriched FOR THIS SYSTEM. Left alone deliberately — the owner's
  carve-out ("a GHL-linked contact still needing enrichment for OUR system is fine").

**DESTINATION — nothing to remove; verified clean.**
- The canonical egress choke point is `lib/crm/sync.ts:syncContactToCRM`. Its
  `CRMContactPayload` is `firstName, lastName, email, phone, tags, source, brokerageId,
  agentId` — no enrichment column, no `enrichment_profile`, no `life_events`. Its three
  callers are `app/actions/contacts.ts:205`, `app/actions/lead-lifecycle.ts:205`,
  `app/actions/crm-connect.ts:143`. **No enrichment module calls it.**
- The second, non-canonical egress `lib/ghl-integration.ts:84` pushes
  `status / intent / them_first_score / temperature` — scores, not enrichment output — and is
  reached only from inside its own class.
- So: the finding is **a trigger-side vocabulary leak, not a destination leak.**

## BUDGET (item 5)

Leads outnumber contacts, so the lead track gets its own admission control at the QUEUE, and
inherits the drain's existing per-tenant ceiling:

1. `checkVendorBudget` PRE-FLIGHT at queue time (the same house rail the contact core uses).
   An over-budget tenant queues ZERO lead rows — the flood is stopped before it reaches the
   drain, not after.
2. `MAX_PENDING_LEAD_ENRICHMENTS = 200` per tenant — a hard backlog cap on
   pending/processing `lead_id` rows. Bounds committed-but-unspent lead enrichment to
   ~$32/tenant at the repo's own $0.16/record figure.
3. `hasUsableIdentifier` at the queue (leads are far likelier to be stubs than contacts).
4. The drain's ceiling is UNCHANGED: `processEnrichmentQueue` takes `BATCH_SIZE = 10` per
   tenant per 15-minute tick and both tracks share those slots. Adding the lead track cannot
   raise the per-tenant spend ceiling; it can only compete for the same slots.
5. The cron top-up pass is bounded at `LEAD_NET_PER_BROKERAGE = 25` per run.

RECORDED, NOT FIXED (parallel agent owns the drain's provider path): `processEnrichmentQueue`
has NO `checkVendorBudget` pre-flight of its own before `skipTraceWithPeopleData`. That is
pre-existing and applies to both tracks; the queue-time gate above is what this wave adds.

## FINAL SHAPE

```
LEAD CREATE (3 doors)
  ├─ lib/lead-pipeline/pipeline-processor.ts   → emits RAW_RECORD_PROMOTED
  │      → lib/kernel/event-reactor.ts (D-septies)   ← THE CHOKEPOINT
  │        reads metadata.lead_id (entityId is the RAW RECORD, a different id space)
  ├─ lib/kernel/crm.ts:createLeadOnlyRecordForAcquisitionSource  → DIRECT hook
  └─ lib/lead-promotion/lead-promoter.ts:promoteRawRecordToLead  → DIRECT hook
                                                (queues under initialBrokerageId,
                                                 never the scraping brokerage)
LEAD_CAPTURED  → same reactor branch
  (lib/kernel/lead-acquisition-handlers.ts:handleLeadCaptured — its bare INSERT
   is gone; it now calls the guarded writer)
        ↓
  lib/enrichment/lead-enrichment-core.ts:queueLeadEnrichment
     · tenant REQUIRED  · hasUsableIdentifier  · freshness BY EVIDENCE
     · pending-row idempotency  · live-deal suppression via leads.contact_id
     · backlog cap (200)  · checkVendorBudget pre-flight  · NEVER THROWS
        ↓  lead_enrichment_queue (pending, lead_id set / contact_id null)
  lib/lead-pipeline/enrichment-orchestrator.ts:processEnrichmentQueue
     (unchanged — it already ran Track A; BATCH_SIZE 10 per tenant per 15 min)
        ↓  peopleDataProfileToLeadColumns + raw_scraped_leads back-fill + handleLeadScored

THE NET  app/api/cron/enrichment-processor  (unattended door, tenant from the DB)
  → listLeadsNeedingEnrichment per brokerage, LEAD_NET_PER_BROKERAGE = 25
    (keys on enrichment_profile evidence, not on a null last_enriched_at;
     skips is_active=false leads the contact lane already owns;
     stops asking a tenant the moment it returns 'backlog' or 'budget')
```

### Files added
- `lib/enrichment/lead-freshness.ts` — PURE (no `server-only`), the evidence-based
  freshness rule. Guard-importable.
- `lib/enrichment/lead-enrichment-core.ts` — `server-only`, the guarded writer + the net.

### Files changed
- `lib/enrichment/deal-vocabulary.ts` — added the PURE `leadDealLinkage` + the FK evidence.
- `lib/enrichment/deal-suppression.ts` — added `isLeadInLiveDeal` (resolves, never substitutes).
- `lib/enrichment/contact-enrichment-core.ts` — `ghl_sync` removed from `EnrichmentSource`
  and from the `triggerType` docstring.
- `lib/kernel/event-reactor.ts` — new branch D-septies (the chokepoint).
- `lib/kernel/crm.ts` / `lib/lead-promotion/lead-promoter.ts` — direct hooks.
- `lib/kernel/lead-acquisition-handlers.ts` — bare queue INSERT replaced by the writer.
- `app/api/cron/enrichment-processor/route.ts` — the lead net top-up pass.
- `scripts/enrichment-suppression-simulator.ts` — extended (see below).

### Deletion
`lib/kernel/lead-acquisition-handlers.ts:74` — the bare
`supabase.from('lead_enrichment_queue').insert({ lead_id, brokerage_id, status,
enrichment_type, trigger_type, queued_at })`.
Survivor: **`lib/enrichment/lead-enrichment-core.ts:queueLeadEnrichment`**.
MERGED FIRST: the capability ("a captured lead gets enriched") is preserved exactly, and
the survivor adds every guard the copy lacked — freshness, idempotency, identifier gate,
suppression, backlog cap, budget pre-flight. The bad implementation was not ported.
"No caller" was not the rationale; the rationale is that a second unguarded writer for the
same queue is the defect wave 3 removed four times on the contact side.

### NOT deleted, deliberately
`lib/lead-promotion/lead-promoter.ts:promoteRawRecordToLead` has no production caller and
`scripts/lead-pipeline-simulator.ts:204` ASSERTS it must have none ("the automatic pipeline
is the ONLY door"). It is not an orphan — it is wired to a surface (that proof) and parked
on purpose. It is a lead-create door, so it is hooked; it is not removed.

### Guard
`npm run test:enrichment-suppression` — **91 → 198 assertions** (the contact lane's are
untouched; a parallel wave-5 lane added its own in the same run). New lead-lane coverage:
the `leadDealLinkage` resolution incl. the empty/whitespace 22P02 cases; the
evidence-vs-stamp freshness trap; `isLeadInLiveDeal` resolving and failing closed with no
`??` coercion; every guard inside `queueLeadEnrichment`; the never-throws contract; the
budget + backlog bounds; the reactor chokepoint reading `metadata.lead_id` rather than
`entityId`; **each direct lead door named individually**; the promoter's tenant choice; the
cron net's bounds and unattended-door properties; and both halves of the GHL rule (no
`ghl_sync` trigger vocabulary anywhere in `lib/enrichment`, and `CRMContactPayload`
carrying no enrichment field). A new LIVE assertion proves the schema fact the whole
suppression decision rests on by ASKING for `listings.lead_id` / `transactions.lead_id` —
PostgREST answers a missing column with 42703, so absence is provable and an empty table
cannot produce a false pass.

Re-ran green alongside: orphan-exports (burn-down, no new unwired export),
client-server-only, server-only-boundary, no-orphan-actions, use-server-exports,
check-vocabulary, tenant-scope, silent-write, orphan-writes, event-dispatch, cron-dispatch,
simulator-wiring, agent-id-class, session-rails, lead-lifecycle, persona-drift,
lead-pipeline (114).

## Status log
- [x] Read the contact lane end to end
- [x] Enumerate lead-create doors (3) + existing lead_id queue writers (2)
- [x] Lead-side suppression decision (resolve leads.contact_id; fail closed)
- [x] GHL audit — trigger-side vocabulary leak found, destination verified clean
- [x] Budget bound decided and applied
- [x] Build `lib/enrichment/lead-enrichment-core.ts` + `lead-freshness.ts`
- [x] Hook the doors (1 chokepoint + 2 direct + 1 re-routed writer + 1 net)
- [x] Extend the simulator
- [x] Orphan burn-down in the touched files
