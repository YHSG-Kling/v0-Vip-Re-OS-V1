# LIFECYCLE EVENT CONTRACT (AUTHORITATIVE)

**VERSION:** 2.0.0
**STATUS:** Constitutional — must be obeyed by all systems
**LAST UPDATED:** 2026-05-29
**SUPERSEDES:** 1.0.0 (the v1 "event-sourced / state-computed-from-`activities`" model was never the
implementation; this version documents what the system actually does and is binding going forward.)

---

## 0. WHY THIS REWRITE

v1.0.0 declared an event-sourced model: state stored only in `activities`, computed from the event
sequence, with dotted (`buyer.under_contract`) event types. **The implementation diverged**: state is
stored in **dedicated columns on each entity**, transitions **emit a typed `KernelEvent`**, and
`activities` / `lifecycle_events` are the **append-only audit log**, not the state source. v2 blesses
the implemented model (it is dominant, working, and TypeScript-enforced) and records the remaining
drift to consolidate. Any system that still assumes the v1 model is non-conformant.

---

## 1. CANONICAL STATE MODEL (STORED, NOT COMPUTED)

Lifecycle state lives in entity **columns**. Each state machine is defined in
`lib/kernel/lifecycle.ts` (`STAGE_EVENT_MAP` + `ENTITY_MAP`).

| Entity | Table.Column | Values |
|---|---|---|
| Contact (CRM) | `contacts.status` | raw CRM lead/contact state |
| Buyer journey | `contacts.buyer_stage` | 13-state: `prospect → pre_approval_pending → financially_verified → search_configured → searching → touring → tour_completed → offer_strategy → buyer_under_contract → buyer_closed / buyer_disengaged / buyer_lifetime` |
| Listing | `listings.lifecycle_stage` | uppercase machine `… → MLS_ACTIVE → UNDER_CONTRACT → CLOSED` (+ terminal `SELLER_DECLINED / LISTING_CANCELLED / LISTING_EXPIRED`) |
| Transaction | `transactions.stage` | transaction stage machine |
| Generic journey | `journey_states.current_stage` | buyer/seller journey rollups |

**Rule:** the column is the source of truth. `activities` (canonical audit per this contract) and
`lifecycle_events` (legacy log) record history; they do **not** define current state.

---

## 2. CANONICAL EVENT VOCABULARY

There are two event vocabularies in the codebase. **`KernelEvent` (underscore) is canonical.**

| Vocabulary | Example | Emitted by | Consumed by | Status |
|---|---|---|---|---|
| **`KernelEvent`** (underscore, `lib/kernel/events.ts`, ~410 values) | `offer_accepted`, `listing_published`, `buyer_financially_verified` | state-machine transitions via `STAGE_EVENT_MAP` → `processKernelEvent` (89 sites) | notifications + the **kernel reactor** (marketing enrollment) + workflow `triggers.ts` + `marketing_campaign_triggers.trigger_value` | **CANONICAL** |
| **Dotted** (`<namespace>.<action>`) | `listing.appointment_set`, `compliance.listing_agreement_passed`, `lead.created` | `lib/events` helpers (9 sites) + direct server-action calls | the **orchestrator** (`lib/orchestrator`) and the **chain engine** (`lib/workflow-orchestrator`) | **TO CONSOLIDATE** — keep as the chain-trigger surface, mapped to `KernelEvent` |

**Known drift to fix (do not add more):**
- `lifecycle_events.event_type` is written in **both** vocabularies; the `marketing-trigger-engine`
  cron matches it against underscore `trigger_value`, so it silently misses dotted rows. (The kernel
  reactor does not have this bug — it matches the `KernelEvent` value directly.)
- Three UI trigger pickers (`automations-client`, `workflow-builder`, `SequenceBuilder`) hardcode
  ad-hoc values; only `SequencesListClient` uses the canonical `WORKFLOW_TRIGGERS` catalog.

---

## 3. EVENT → REACTION: TWO INTENTIONAL INITIATION MODELS

Reactions to lifecycle events run through **two deliberately separate** paths. They are NOT one spine
and must not be naively merged.

### 3a. System reactor (no session) — `processKernelEvent` → `dispatchKernelEvent`
- Fires automatically on every state-machine transition.
- Does: (1) human **notifications** (`notification-engine`), (2) **marketing enrollment** via the
  shared `processOneLifecycleEvent` (the same path the safety-net `marketing-trigger-engine` cron
  uses — cooldown-idempotent, so the two never double-enroll).
- Reaction is **enroll/notify only**; actual sends stay behind the channel adapters' compliance gates.

### 3b. Agent-initiated chains (session-bound) — `triggerChainsForEvent` → `lib/workflow-orchestrator`
- Multi-step "revolutionizing" automations, **triggered by an agent action** through a server action
  (session-scoped via `getAgentContext`; tenant-ownership verified per referenced row).
- Registered chains (`triggerEvent`):
  - **`listing.appointment_set` → `listing-appt-prep`**: CMA → listing presentation → per-chapter
    avatar videos (DID + cloned voice) → enroll each as a **pre-appointment drip** timed before the
    appointment. *(This is the flagship "sell the seller before you set foot in the home" flow.)*
  - `compliance.listing_agreement_passed` → auto-create the listing record.
  - `compliance.executed_offer_passed` → auto-create the transaction.
- CMA + presentation steps may be **human-gated** if the brokerage opts in; chain runs are recorded in
  `workflow_runs`.

**Why separate:** chains spend real money (AVM calls, video renders) and encode agent intent (booking
the appointment). The system reactor must not auto-fire them without an agent in the loop. Bridging
3a→3b requires (i) a system-context trigger that bypasses `getAgentContext` with a resolved brokerage,
(ii) chain-run **idempotency** keyed on (chain, entity, trigger), and (iii) a `KernelEvent → dotted
trigger` map — all three are prerequisites and a **broker/admin decision**, not a silent change.

---

## 4. BUSINESS-PROCESS DEFINITIONS (THE RULES THAT GATE EVERYTHING)

### Raw lead → lead → contact
- `raw_scraped_leads` — raw, platform-owned (RLS: platform admin + per-brokerage AI-ISA system actor).
- `leads` — produced by the enrichment pipeline (`lib/lead-pipeline`).
- `contacts` — created by `promoteLeadToContactService` (`validatePromotionEligibility →
  createContactFromLead → deactivateLead`). **A "contact" = a promoted lead that passed eligibility**;
  the source lead is deactivated. The contact then carries `status` (CRM) + `buyer_stage` (journey).

### When the AI-ISA may act, and on whom
Every outbound SMS/call passes the **fail-closed TCPA gate** (`lib/communication/tcpa-gate.ts`):
- requires `contacts.tcpa_consent` (express written) — except `transactional` notices may bypass
  *marketing* consent;
- blocks on `dnc_status`, opt-out, quiet hours, and stale/invalid/reassigned phone (90-day RND safe
  harbor); **DNC + quiet hours apply even to transactional**;
- plus `isa_reengage_allowed` for re-engagement. Decisions are logged to
  `outbound_message_compliance_log` for audit. **The ISA may only reach contacts that pass this gate.**

### What constitutes a listing / when it's "active"
A `listings` row with a `lifecycle_stage`. Created after the compliance gate
(`compliance.listing_agreement_passed`). **"Active listing" = `lifecycle_stage = MLS_ACTIVE`** (emits
`LISTING_PUBLISHED`); earlier stages are coming-soon / prep.

### When an offer/listing becomes a transaction
On `compliance.executed_offer_passed` → a `transactions` row is created (`transactions.stage` machine),
and the listing reaches `UNDER_CONTRACT`. Per §1, `transaction.created` **freezes** the buyer & seller
journeys at `*_UNDER_CONTRACT` until close or termination.

### What happens when a seller listing appointment is booked
The agent schedules it → `listing.appointment_set` → the `listing-appt-prep` chain runs (§3b):
CMA → presentation → chapter videos → pre-appointment drip. The `listing-presentation-prep` **cron**
also pre-builds the presentation for any appointment in the next 24h as a safety net (idempotent on an
existing `listing_presentations` row).

---

## 5. INVARIANTS (UNCHANGED FROM v1, STILL BINDING)

- **Append-only audit**: events in `activities` are immutable; corrections emit new events.
- **Tenant isolation**: every event/reaction is scoped by `brokerage_id`; the reactor's matching is
  brokerage-isolated (no cross-tenant trigger leak).
- **Dedup**: window-based (60s) + optional idempotency key; marketing enrollment is cooldown-idempotent.
- **Gating**: no autonomous send without passing compliance/TCPA/brand gates; mutating MCP/agent
  actions return a confirmation plan, never auto-fire.

---

## 6. CONSOLIDATION BACKLOG (REQUIRES BROKER/ADMIN SIGN-OFF PER §3)

1. Normalize `lifecycle_events.event_type` writes to `KernelEvent` values + add a dotted→KernelEvent
   compatibility map so the marketing cron stops missing dotted rows.
2. Point the three ad-hoc UI trigger pickers at the canonical `WORKFLOW_TRIGGERS` catalog.
   *(DONE for the two `campaign_sequences`-backed pickers: `workflow-builder`, `SequenceBuilder`.
   `automations-client` feeds a separate `workflow_automations` system — pending its own migration.)*
3. Decide chain initiation: keep agent-initiated, OR add a system-context, idempotent
   `KernelEvent → chain` bridge so the reactor can drive selected chains.
   *(Chain-run idempotency landed — `lib/workflow-orchestrator/run-dedupe.ts` — so the bridge is now
   safe to add once approved.)*
4. Fold the 9 dotted `lib/events` sites + the `lib/orchestrator` dispatcher onto the canonical spine
   (keep the orchestrator's chain engine; feed it from one emit path).

### 6a. DISPATCHER FRAGMENTATION — ✅ RESOLVED (investigated 2026-05-29; resolved + verified 2026-06-09)

`fanOutKernelEvent` (`lib/kernel/event-fanout.ts`) was the original "what happens when a kernel event
fires" router, running THREE channels: (1) staff notifications, (2) `campaign_sequences` enrollment
(`enrollMatchingSequences`), (3) **client portal updates** (`transparency_updates` +
`client_portal_messages` + contact notifications). The 2026-05-29 drift was that only ~10 of ~98
emitters called it; the rest called `processKernelEvent` directly and skipped enrollment + portal.

**Resolution shipped (the "thin context-forwarder" option):** all three channels now live BEHIND the
reactor, so every path converges:

```
emit.ts ──► fanOutKernelEvent ──► processKernelEvent ──► dispatchKernelEvent
~79 direct processKernelEvent callers ───────────────────┘        │
                                                                  ├─ resolveEventContacts  (bare-caller resolution)
                                                                  ├─ enrollMatchingSequences (drip)
                                                                  └─ writePortalUpdate       (portal card + bell)
```

- `dispatchKernelEvent` (`lib/kernel/event-reactor.ts`) resolves the contact(s) from the entity via
  the shared `resolveEventContacts` (`lib/kernel/resolve-event-contacts.ts` — transaction/offer/
  listing/contact, returning BOTH represented sides) when the emitter didn't pass them, then fans out
  enrollment + portal for EVERY known event. `fanOutKernelEvent` is now a thin forwarder.
- Idempotency: `enrollMatchingSequences` skips active enrollments; `writePortalUpdate` uses the
  app-layer SELECT (10-min window) + the DEPLOYED partial unique index `transparency_updates_dedupe_idx`
  (`contact_id, update_type, md5(title), date_trunc('minute', created_at)`).
- Regression-locked by `scripts/portal-fanout-simulator.ts` (`npm run test:portal-fanout`) +
  live MCP verification (bare transaction emit → buyer + seller cards, idempotent).

**Dedupe consolidation (2026-06-09):** two competing idempotency designs existed — `m105`
(`dedupe_key` column + `(contact_id, dedupe_key)` index, which the writer targeted) and `1093`
(the md5/minute index above). Only `1093` was ever deployed, so the writer's `dedupe_key`/`onConflict`
upsert **failed silently and NO portal card was ever written**. Resolved by aligning the writer to a
plain insert on the deployed `1093` index and **retiring `m105` to a no-op** so it can't reintroduce
the column. `1093` is canonical; `m105` is dead.

### 6b. CAMPAIGN ENROLLMENT — ✅ RESOLVED (folded B into A, 2026-06-13; broker/admin sign-off on record)

`campaign_sequences` (System A) is now the **SOLE enrollment spine**. The legacy marketing-trigger
enrollment (System B) was folded into A in two steps, after a full dependency trace confirmed
production was empty/pre-launch (0 triggers, 0 touchpoints, 0 attribution credits, 0 enrollments).

| System | Tables | Enrolled by | Status |
|---|---|---|---|
| **A — Sequences** (canonical) | `campaign_sequences` / `sequence_enrollments` | `dispatchKernelEvent → enrollMatchingSequences` (matches `trigger_event = KernelEvent`) | **SOLE ENROLLMENT SPINE** |
| **B — Marketing triggers** | `marketing_campaign_triggers` | ~~`marketing-trigger-engine` cron + reactor branch~~ | **RETIRED** |

**Step 1 — the bridge (m1098):** System A's step-executor now records each send into the SHARED
`marketing_campaign_touchpoints` ledger (nullable `campaign_id` + `sequence_id` + `source='sequence'`),
so de-confliction (the over-messaging frequency cap), attribution, and team-query keep working — and
the canonical drip engine's sends are finally visible to the frequency cap (proof `test:touchpoint-bridge`).

**Step 2 — the retirement (m1099):** removed the reactor's marketing-trigger branch,
`lib/marketing/trigger-engine.ts`, and the `marketing-trigger-engine` cron (route + `cron-dispatch`
+ health-registry row). KEPT: `marketing_campaign_touchpoints` / `marketing_attribution_credits` and
the `marketing-campaign-scheduler` / `marketing-attribution-engine` crons (the send/attribution layer,
orthogonal to enrollment, now fed by System A). KEPT: `lib/marketing/trigger-match.ts` (pure matcher
still exercised by `test:scrapers`). The empty `marketing_campaign_triggers` table is left in place
(unused, harmless) for a later non-urgent drop.

---

**Constitutional status:** binding on all current and future systems. Deviations require documented
broker/admin approval.

**END OF CONTRACT**
