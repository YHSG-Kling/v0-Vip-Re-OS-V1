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
3. Decide chain initiation: keep agent-initiated, OR add a system-context, idempotent
   `KernelEvent → chain` bridge so the reactor can drive selected chains.
4. Fold the 9 dotted `lib/events` sites + the `lib/orchestrator` dispatcher onto the canonical spine
   (keep the orchestrator's chain engine; feed it from one emit path).

---

**Constitutional status:** binding on all current and future systems. Deviations require documented
broker/admin approval.

**END OF CONTRACT**
