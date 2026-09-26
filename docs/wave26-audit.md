# Wave 26 — `activities` was never the invisible-row class

Continues waves 22–25. The enumerator (`--enumerate`, added in wave 25) named
`activities` as the heaviest remaining table by a factor of ten — **42 unstamped
sites of 193, with 28 brokerage-equality readers** — and absent from every
earlier heaviest-first list, because it is trigger-covered and each census
bucketed it as netted and stopped looking.

## The premise was wrong, and the correction changes what the defect IS

I briefed this as the wave-22/23/24 class: an untenanted row that its own reader
filters out. It is not.

**`activities.brokerage_id` is `NOT NULL`, no default** — verified live, with
zero NULL rows because there cannot be one. So where `activities_set_brokerage`
resolves nothing, the insert is **REFUSED, SQLSTATE 23502**. And supabase-js
*resolves* a refusal, so a writer that does not destructure `error` — or wraps it
in a `try/catch`, which catches nothing — **reports success over a row that never
existed.**

Not a hidden row. A hidden **non-row**. Every fix below stamps *and* reads its
result.

## The net has exactly two holes

`activities_set_brokerage()` is `BEFORE INSERT`, `SECURITY INVOKER`, and tests
eight anchors in an `ELSIF` chain: `contact_id`, `entity_type='contact'`,
`listing_id`, `entity_type='listing'`, `transaction_id`,
`entity_type='transaction'`, `agent_id`, `agent_user_id`.

### BRANCH GAP — 7 fixed

| site | what it files | why the net misses |
|---|---|---|
| `lib/lead-governance/sla-monitor.ts:88` | **no anchor at all** | did not even reference its lead — **every SLA breach escalation ever raised was refused** |
| `lib/lead-readiness/readiness-logger.ts:51` | `entity_type:"lead"` | no `lead` branch; the tenant was already resolved four lines above for its own fallback and never reached the row |
| `lib/brand-template-registry/registry-logger.ts:22,64,109` | `entity_type:"content"` | its only other anchor is an **optional `userId` the single live caller does not pass** — which is why the brand compliance history panel has always been empty |
| `app/actions/documents.ts:1107` | `entity_type:"document"` | no `document` branch; the refusal was swallowed by `.then(()=>{},()=>{})` |
| `app/api/cron/referral-asks/route.ts:55` | `contact_id`/`agent_id` | **conditional** gap — both nullable on `transactions`; it also counted every refused insert as `processed++`, its `catch` being unreachable |

### SECURITY INVOKER — 3 fixed

`prosecdef = false`, so each lookup runs under the **inserting caller's** RLS,
and `contacts` gives a `user_type='agent'` caller `agent_read_own_contacts` and
nothing wider. Fixed at `net-sheet-calculator.ts:155,191` and
`ai-voice-transcription.ts:196`.

**Demonstrated, not asserted, and sharper than the brief described.** A row
carrying **both** `contact_id` (unreadable to this caller) and `listing_id`
(readable — `listings` RLS is brokerage-wide) is **refused 23502**: the `ELSIF`
matched the contact branch, resolved nothing, and **stopped** rather than falling
through to the anchor the caller could have read. The identical row with an
explicit stamp lands, `WITH CHECK` admits it, and the real reader returns 1 under
the same session with RLS on.

### ALREADY COVERED — 32, deliberately untouched

Three quarters of the sites needed nothing. 22 on a **service** client (RLS
bypassed, trigger resolves); 10 on a **session** client whose anchor is proven
readable — an early-return guard on the same row, or the anchor *is* the caller,
or a conditional spread every caller fills.

**Stamping a covered site is churn**, and wave 24 nearly did it to `social_posts`.
"The site is fine" was an explicit allowed outcome, and it was the answer most of
the time.

## The 28 readers do not all compute the same expression

26 compare the **caller's** `users.brokerage_id`. Two compare the **record's
own**: `respond-to-counter.ts:58` (`offer.brokerage_id`) and
`deal-room-reel.ts:107`. They coincide under the tenancy invariant, and the
record-based answer is also what the trigger computes — so **resolving through
the record satisfies both families**, which is what every stamp here does.

## What the checks caught that the report did not

- **Typecheck.** A second tenant guard was added inside the error branch that the
  first guard makes unreachable; TypeScript narrowed `tenant` to `never` and
  `tenant.reason` failed to compile. **Removed rather than cast around** — the
  tenant is non-null there by construction.
- **E5 was a FALSE GREEN.** A control aliasing `createClient as
  createServiceClient` left the identifier intact, so the assertion passed over
  exactly the substitution it exists to catch. It now asserts the **import
  source**, not a name. A second control stayed green because its target also
  carried `agent_user_id` — the assertion was right, the control was wrong.

**56 assertions · 56 negative controls red · 4 specificity controls green.**

## Beyond the brief — reported, not switched on

**`lib/security/rbac.ts:187` has never written a row.** The insert is neither
awaited nor `.then()`ed, and a `PostgrestBuilder` only issues its request from
`then()`. **Five audit call sites, zero rows, ever.** Turning it on means five
writes per permission check — a product decision, not a tenant one. **Owner
ruling.**

Also noted: `transactions` has no broker read policy (only `agent_read_own`,
`team_leader`, `platform_admin`, `vendor`) — pre-existing.

**Behaviour change, flagged:** `analyzeCallTranscript` now refuses when it cannot
read the contact, instead of prompting the model with `undefined undefined` and
writing an undefined tenant onto `call_analyses`.

## Verification

Typecheck EXIT=0. Guard chain **223/223** including `test:sweep`, run after the
last edit. `--enumerate` confirms `activities` **42 → 32**.

## Still owner rulings

- `rbac.ts` audit writes (above) · `offer_strategy_templates` `is_active = true`
  to PUBLIC · `handoff-queue-panel.tsx`'s `agentId` prop contract ·
  `open-house.ts:352` stamping the caller's brokerage rather than the event's ·
  cron history readable by brokers through two no-predicate readers ·
  `checkInAttendee`'s missing `contact_id` · whether trigger coverage belongs
  *in* the enumerator's number or beside it · leads / raw-leads ·
  `transcribeAudio`'s unvalidated `audioUrl` · calculator rate limiting.
