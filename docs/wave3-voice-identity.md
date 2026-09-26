# Wave 3 — Voice Identity (session-resolved, never caller-supplied)

## The ruling

> "can only get their contacts but anytime there is someone using voice, they are not
> going to know what their id is so there has to be another way to check who the user is."

Identity must be resolved by the system from the session. Never taken from the spoken
sentence, never from a caller-supplied parameter. And a caller may only reach THEIR OWN
contacts.

---

## VERIFIED FACTS (read from disk, wave 3)

### 1. `dispatchCommand` is a second public door — CONFIRMED

`app/actions/voice-assistant/core/dispatch-command.ts` line 1 is `'use server'`, and
`dispatchCommand` is exported. Next.js turns every exported async function in a
`'use server'` module into its own POST-able server-action endpoint. The function does:

- NO `getAgentContext()`
- NO `validateAuthority()`
- NO `validateReadiness()`

It reads `target_action`, `parameters`, `entities` straight off the request and calls the
executor. `{target_action:'admin_override_financial_gate', parameters:{buyer_id, user_id, reason}}`
reaches `adminOverrideFinancialVerification` with a caller-declared admin id.

### 2. Callers of `dispatchCommand`

`grep -rn dispatchCommand` (excluding node_modules) returns exactly three lines:

- `app/actions/voice-assistant/handle-voice-command.ts:23` — the import
- `app/actions/voice-assistant/handle-voice-command.ts:242` — the ONLY call
- `app/actions/voice-assistant/core/dispatch-command.ts:27` — the definition

So there is exactly ONE in-repo caller, and it is the governed lane.

### 3. `buildActionParams` spread order — CONFIRMED, and the consequence

`dispatch-command.ts:78-81`:

```ts
const params: Record<string, any> = {
  ...parameters,
  ...entities
}
```

`entities` is spread LAST. `handleVoiceCommand` injects the session identity into
`parameters` (line 245-250) and passes `intent.entities` — which is **LLM output from the
spoken sentence** — as `entities`. So an entity key named `user_id` / `brokerage_id` /
`role` extracted by the intent parser **silently overwrites the session-injected identity**.
Consequence: even on the GOOD lane, a spoken sentence can substitute a different actor id,
because the untrusted model output wins the merge. This is exactly the thing the ruling
forbids.

### 4. snake→camel bridging — the param_mapping DOES bridge it

`helpers/command-map.ts` param_mapping for the buyer commands maps the injected snake key
onto the executor's camel key, and DELETES the snake key:

| target_action | param_mapping | effect on injected `user_id` |
|---|---|---|
| `query_buyer_stage` | `buyer_id→contactId`, `user_id→userId` | becomes `userId` |
| `configure_buyer_search` | `buyer_id→contactId`, `user_id→agentId` | becomes `agentId` |
| `lender_confirm_financials` | `buyer_id→contactId`, `user_id→lenderId` | becomes `lenderId` |
| `admin_override_financial_gate` | `buyer_id→contactId`, `user_id→adminId` | becomes `adminId` |

So the injected identity is NOT silently dropped on this lane — `buildActionParams`
(dispatch-command.ts:84-93) renames it. The executor in `helpers/command-executors.ts:42`
(`p.userId ?? p.user_id`) is belt-and-braces for the same thing.

**But note what that mapping means**: `user_id → adminId` takes whatever `user_id` is in
params and declares it the admin. Combined with fact 3, a voice-extracted `user_id` entity
becomes the `adminId` that overrides a financial gate. And `buyer-execution.ts`
`adminOverrideFinancialVerification` only checks `isValidUUID(adminId)` — it never checks
that this person holds an admin/broker role. A session alone (let alone a spoken id) is not
authority to override a financial gate.

### 5. `buyer-execution.ts` current state

Wave 2 already gated three exports via `requireContactAccess`:
`handleBuyerVoiceAssistant`, `getBuyerUpdateHistory`, `logBuyerAction`.

Still fully unauthenticated / caller-declared actor (wave 3 targets):

- `getBuyerJourney({contactId, userId?})` — no session, no tenant scope
- `checkBuyerCanPerformAction({contactId, action, userId?})` — no session
- `lenderConfirmBuyerFinancials({contactId, lenderId, ...})` — caller declares lender
- `agentConfigureBuyerSearch({contactId, agentId, ...})` — caller declares agent
- `adminOverrideFinancialVerification({contactId, adminId, reason})` — caller declares admin
- `agentAdvanceBuyer({contactId, agentId, targetState})` — caller declares agent

---

### 6. THE UNATTENDED CALLER — `app/api/agent-assistant/tool-call/route.ts`

This is the ElevenLabs Conversational-AI webhook, and it is **the actual voice surface
the owner's ruling is about**. It has NO Supabase cookie session — it authenticates with
`x-elevenlabs-tool-secret` and then resolves the speaker from the
`agent_assistant_sessions` row keyed on ElevenLabs' `conversation_id`. That row carries
`user_id`, `brokerage_id`, `agent_id`, written when the authenticated user opened the
assistant.

That is exactly the owner's ruling already working: the talker never says an id; the
system looks up who they are from the SESSION.

It calls two of the buyer-execution server actions:

- line 298-299 `getBuyerJourney({ contactId, userId: session.user_id, source: 'voice_assistant' })`
- line 329-330 `lenderConfirmBuyerFinancials({ contactId, lenderId: session.user_id, ... })`

**If a cookie-session gate is added to those server actions, this webhook breaks** —
`auth.getUser()` returns null, every voice buyer query answers "Unauthorized". This is the
wave-2 `facebook-audience-sync` lesson exactly. The route already documents the same trap
for `query_listing_status` (lines 279-285: "This webhook is unauthenticated (secret-header
only, no Supabase user session), so an RLS client has no auth.uid()"). So the precedent for
the fix already exists IN THIS FILE: give the webhook its own door onto the `lib/` function,
with its own brokerage gate, and a REAL identity from the session row — never a fake one.

### 7. THE ROLE CHECKS IN `lib/buyer-execution/multi-party-updates.ts` ARE DEAD

Three functions verify authority by reading the **legacy `users.role` column**:

- `agentAssistSearchConfiguration` (line ~135) `['agent','team_lead','broker','admin'].includes(user.role)`
- `adminOverrideFinancialGate` (line ~210) `['admin','broker'].includes(user.role)`
- `agentAdvanceBuyerStage` (line ~273) `['agent','team_lead','broker','admin'].includes(user.role)`

`lib/auth/resolve-user-role.ts` header says: *"`user_type` is the single source of truth.
The legacy `role` column is being retired; new code MUST NOT read or write it."*
`lenderConfirmFinancialVerification` in the SAME FILE was already migrated to `user_type`
in an earlier wave, with a comment saying the old `role` check "silently rejected genuine
lenders". The other three were missed.

**Verified against the live database** (project `hrvaqgvukzxfskkcrwbt`):

```
select count(*) total, count(role) role_set, count(user_type) user_type_set from users;
-> total 23, role_set 4, user_type_set 23
```

and the distribution:

| role | user_type | n |
|---|---|---|
| `<null>` | agent | 5 |
| `<null>` | contact | 4 |
| `<null>` | admin | 2 |
| `<null>` | vendor | 2 |
| `<null>` | system | 2 |
| `<null>` | tc / compliance_officer / lender / broker | 1 each |
| `agent` | agent | 1 |
| `Lender` | lender | 1 |
| `Admin` | admin | 1 |
| `team_lead` | team_lead | 1 |

So: 19 of 23 users have `role = NULL`, and the ones that are set are **title-cased**
(`'Admin'`, `'Lender'`) which no `includes()` list matches. Consequences, factually:

- `adminOverrideFinancialGate` refuses **every user in the database**. The only
  `user_type='broker'` user has `role = NULL`; both `user_type='admin'` users are NULL or
  `'Admin'`. The emergency financial-gate override is dead code that can never succeed.
- `agentAdvanceBuyerStage` — the "Advance stage" button in
  `app/crm/contacts/[contactId]/components/buyer-stage-progress.tsx:50` — refuses 22 of 23
  users. Only the one `role='agent'` user can advance a buyer.
- `agentAssistSearchConfiguration` — same, refuses all but one.

It fails CLOSED, so it is not a security hole; it is a **feature that has never worked**.
Under the method that is "an advanced feature worth having → finish it", not a deletion.

### 8. `agentAdvanceBuyer`'s `agentId` is a `users.id`, not an `agents.id`

Traced: `app/crm/contacts/[contactId]/page.tsx:396` passes `agentUserId={user.id}` (a
`users.id` from `auth.getUser()`) → `buyer-overview-client.tsx:671` `agentId={agentUserId}`
→ `buyer-stage-progress.tsx:50` `agentAdvanceBuyer({ agentId })` →
`agentAdvanceBuyerStage` queries `users` by it. So despite the name it has always been a
`users.id`. Deriving it from the session's `users.id` preserves the semantics exactly —
no id-space crossing.

---

## DECISION — question 1: (b), make `dispatchCommand` internal

`dispatchCommand` has exactly ONE in-repo caller and it is `handleVoiceCommand`, which
already resolves identity from the session, checks the authority matrix, and checks
readiness. Option (a) would mean duplicating `getAgentContext` + `validateAuthority` +
`validateReadiness` inside the dispatcher, producing TWO governed paths that must be kept
in agreement forever — and the brief says prefer whichever leaves ONE. Option (b) deletes
the door outright: drop `'use server'` from `core/dispatch-command.ts`, add
`import 'server-only'`, and the module stops being an HTTP endpoint while
`handleVoiceCommand` (itself `'use server'`) imports it unchanged.

Additionally the signature is changed so identity **cannot** be omitted: `dispatchCommand`
now takes a required `identity: { userId, brokerageId, role }` argument, separate from
`parameters`/`entities`, and strips every identity-bearing key out of both before merging.
Structurally there is no longer a way to call it without a resolved identity, and no way
for a spoken entity to supply one.

---

## WORK LOG — WHAT CHANGED

### 1. `app/actions/voice-assistant/core/dispatch-command.ts` — the second door is closed

- `'use server'` REMOVED, `import "server-only"` added. The module is no longer an HTTP
  endpoint. `handleVoiceCommand` (itself `'use server'`) imports it unchanged.
- `dispatchCommand` now takes a REQUIRED `identity: { userId, brokerageId, role }`
  argument and fails closed (`Unauthorized: no resolved identity for dispatch`) if it is
  absent. There is no longer a call shape that omits identity.
- New `IDENTITY_KEYS` set: `user_id, userId, agent_id, agentId, admin_id, adminId,
  lender_id, lenderId, brokerage_id, brokerageId, role, user_role`. `stripIdentity()`
  removes all of them from `parameters` AND from `entities` before either is merged.
- The entities-last bug is fixed by ORDER: strip both → merge (entities still last, so a
  resolved entity still beats a stale parameter) → **apply session identity after both
  spreads** → only then run COMMAND_MAP's `param_mapping`, which renames the snake-case
  identity onto each action's own spelling (`user_id → adminId`, etc.).
- `buildActionParams` deliberately NOT exported — an exported helper here would create a
  new orphan export in a file the baseline records as having zero.

### 2. `app/actions/voice-assistant/handle-voice-command.ts`

Line ~242: identity moved out of `parameters` into the new `identity` argument. Nothing
else on this lane changed — `getAgentContext`, `validateAuthority`, `validateReadiness`
and the audit events are untouched.

### 3. `app/actions/voice-assistant/helpers/command-executors.ts`

`query_buyer_stage` no longer does `userId: p.userId ?? p.user_id`. Identity cannot arrive
in params any more, and `getBuyerJourney` derives its actor from the session regardless; a
fallback reaching for a caller-supplied id would only imply params can carry identity.
Now passes `source: 'voice_assistant'`, which is what it actually is.

### 4. `lib/portal/require-contact-access.ts`

- Returns `userType` (the caller's `users.user_type`) on the `ok: true` branch — purely
  additive, no existing caller breaks. Callers needing a SECOND, stronger decision than
  "may you touch this contact" (e.g. admin/broker for a financial-gate override) now get
  it without a second `users` query and without reaching for the retired `role` column.
- Both reads now DESTRUCTURE `error`. supabase-js resolves a refused query, so
  `const { data }` reported a refusal as "Contact not found" — a clean-looking negative.
  New outcome `"Access check failed"`. Still fails closed either way; the API-route
  callers that map `error === 'Unauthorized' ? 401 : 403` put it on 403.
- The contact read and the caller read now run in parallel (the self-branch previously
  returned before fetching the caller row).

### 5. `lib/buyer-execution/multi-party-updates.ts` — three dead authority checks revived

Added `resolveActorType()` + `AGENT_LEVEL_TYPES` / `OVERRIDE_LEVEL_TYPES`, and replaced
the `users.role` reads in `agentAssistSearchConfiguration`, `adminOverrideFinancialGate`
and `agentAdvanceBuyerStage` (see finding 7 — these refused 22-of-23 and 23-of-23 live
users respectively; the admin override had never once been able to succeed).
`resolveActorType` destructures `error` and returns null on a refused read, so every
caller still fails closed. The three `actor_role:` metadata fields now log the resolved
`user_type` instead of the null/title-cased legacy value.

`lenderConfirmFinancialVerification` was already migrated in an earlier wave and is
untouched — it is the shape the other three now match.

### 6. `app/actions/buyer-execution.ts` — every actor comes from the session

| export | before | now |
|---|---|---|
| `getBuyerJourney` | no session, caller's `userId` | `requireContactAccess` + `access.userId` |
| `checkBuyerCanPerformAction` | no session, caller's `userId` | `requireContactAccess` + `access.userId` |
| `lenderConfirmBuyerFinancials` | caller-declared `lenderId` | `access.userId`; lib still proves lender/vendor + assignment |
| `agentConfigureBuyerSearch` | caller-declared `agentId` | `access.userId`, staff-only (`isContactSelf` refused) |
| `adminOverrideFinancialVerification` | caller-declared `adminId` | `access.userId` + `isAdminOrBroker(access.userType)` + the lib's own re-check |
| `agentAdvanceBuyer` | caller-declared `agentId` | `access.userId`, staff-only (`isContactSelf` refused) |

All six keep the identity parameter on their signature, typed optional and documented as
ignored — the house pattern already used by `handleBuyerVoiceAssistant` and
`logBuyerAction` in this same file. No call site had to change its arguments.

`adminOverrideFinancialVerification` is the one the ruling was written about: a session
alone is not authority to lift a financial gate, so it needs TWO independent facts —
tenant membership resolved from the contact row, AND an admin/broker `user_type` on the
session user, checked here and again inside `adminOverrideFinancialGate`.

### 7. THE UNATTENDED LANES — two doors opened so nothing was turned away

**(a) `app/api/agent-assistant/tool-call/route.ts`** (ElevenLabs webhook, no cookies).
Both of its buyer calls were re-pointed at the `lib/buyer-execution` functions:

- `query_buyer_stage` → `getBuyerJourneyStatus` + `getBuyerFriendlyMessage`. The tenant
  check the server action would have done is the entity_owner gate the route already
  performs six lines above against `session.brokerage_id`.
- `lender_confirm_financials` → `lenderConfirmFinancialVerification`. The authority that
  matters (lender/vendor `user_type` + `vendor_contact_assignments` with `financial`
  scope) lives inside that function and is unchanged.

Neither is given a fake identity: `session.user_id` is the real user from the
`agent_assistant_sessions` row. This mirrors the pattern the route already documents for
`query_listing_status`.

**(b) `lib/buyer-execution/showing-financial-policy.ts` → the voice showing lane.**
`guardShowingFinancialGate` calls `checkBuyerCanPerformAction`, which I had just gated on
cookies. Two of its three call sites are ordinary server actions and are fine; the third
is not — `app/actions/showings.ts:requestShowing` carries an explicit **sessionless-caller
overload** for the voice webhook (`lib/voice/showing-request.ts:voiceRequestShowing` ←
`lib/voice/team-commands.ts:329` ← the tool-call route's `run_team_command`). On that lane
the cookie gate would have answered "Unauthorized", `check.success` would be false, and
**every voice-booked showing at a brokerage that opted into the financial gate would have
come back "financial verification unavailable"** — a gate failure invented by plumbing.
This is the wave-2 `facebook-audience-sync` failure exactly, caught before shipping.

Fix: `guardShowingFinancialGate` gains an optional `caller?: { actorUserId }`, mirroring
the overload `requestShowing` itself already uses. When present it runs the private
`runGateSessionless()` — the SAME `enforceFinancialGate` + `buyer.tour.blocked` log, with
the real actor the caller already resolved. `requestShowing` forwards its own `caller`.
`createShowing` and `bookShowingSlotAction` are cookie lanes and pass nothing, so their
behaviour is byte-identical.

### Call sites changed

- `app/actions/voice-assistant/handle-voice-command.ts:242` — new `identity` argument.
- `app/actions/voice-assistant/helpers/command-executors.ts:42` — `query_buyer_stage`.
- `app/api/agent-assistant/tool-call/route.ts` ~298 and ~329 — action → lib.
- `app/actions/showings.ts:96` — forwards `caller` into `guardShowingFinancialGate`.
- `lib/buyer-execution/showing-financial-policy.ts:161` — branches on `caller`.

Unchanged and verified still type-compatible (identity params retained-and-ignored):
`app/crm/contacts/[contactId]/page.tsx:151` (`getBuyerJourney`),
`app/crm/contacts/[contactId]/components/buyer-stage-progress.tsx:50` (`agentAdvanceBuyer`),
`app/actions/showings.ts:427` + `app/actions/self-book-showing.ts:61` (cookie lanes).

---

## ORPHAN BURN-DOWN — the touched files

**NO DELETIONS.** Nothing in this wave was a duplicate, so no survivor had to be named.

### `checkBuyerCanPerformAction` — NOT an orphan, and I nearly broke its only caller

A first grep suggested it had no callers. It does:
`lib/buyer-execution/showing-financial-policy.ts:161` (my earlier grep filtered
`^./lib/buyer-execution` out of its own results). It is the wrapper
`guardShowingFinancialGate` was written to use — same gate as `enforceFinancialGate` plus
the `buyer.tour.blocked` trail. Left in place, gated, and given the sessionless twin above
so its caller keeps working on every lane. Worth stating plainly: had I trusted the first
grep and treated it as dead, I would have deleted a live enforcement point.

### The three revived authority checks — "advanced feature worth having → finish it"

`adminOverrideFinancialGate`, `agentAdvanceBuyerStage`, `agentAssistSearchConfiguration`
were reachable, wired, and *incapable of succeeding* (finding 7). Under the method that is
not a deletion candidate — it is unfinished work. Finished: they now read the canonical
`user_type`. The emergency financial-gate override goes from 0 of 23 live users able to
use it to the 3 who hold `user_type` in `{admin, broker}`; "Advance stage" goes from 1 of
23 to all staff-typed users.

### `lib/voice-admin/plan-voice-command.ts` — left, with what finishing needs

`planVoiceCommand` and `planLines` have no product caller (the module is named by
`scripts/voice-kernel-surface-simulator.ts`, which passes 64/64). Under the method this is
NOT a duplicate — `kernel-command-surface.ts`'s own header is explicit that it does not
replace `handleVoiceCommand`, and the simulator asserts the kernel lane never imports the
direct lane's executors. It is an ADVANCED FEATURE that needs wiring, and I deliberately
did not wire it in this wave because doing it carelessly would reopen the exact door I
just closed. Precisely what finishing needs:

1. A server action (or a route on the ElevenLabs lane) that calls `planVoiceCommand`.
2. **That surface must NOT pass `userId` / `brokerageId` / `scopes` through from the
   caller.** `PlanVoiceCommandInput` takes all three as plain inputs, which is correct for
   a `lib/` function but is precisely the shape that made `dispatchCommand` a hole once it
   became `'use server'`. The surface must resolve `userId`/`brokerageId` from
   `getAgentContext()` and derive `scopes` from that user's grants — never accept them.
3. A two-turn confirm path: `buildVoicePlan` marks mutating steps `needs_confirmation`
   and only a second call with `confirmed: true` dispatches. The surface has to carry
   that turn state, and the confirmation must be re-authorized on the second turn rather
   than trusted from the first.
4. A place to render `planLines(plan)` — the Command Center is the surface the module's
   header names.

### Guard results after the change

| guard | result |
|---|---|
| `scripts/use-server-export-guard.ts` | 3 passed, 0 failed |
| `scripts/client-server-only-guard.ts` | pass — no client module reaches server-only |
| `scripts/server-only-boundary-guard.ts` | 6 passed, 0 failed |
| `scripts/voice-kernel-surface-simulator.ts` | 64 passed, 0 failed |
| `scripts/voice-command-coverage-simulator.ts` | 216 passed, 0 failed |
| `scripts/persona-journey-wiring-simulator.ts` | 93 passed, 0 failed |
| `scripts/role-vocabulary-guard.ts` | 13 passed, 0 failed — incl. "no file filters public.users on the legacy role column" |
| `scripts/orphan-export-guard.ts` | FAILS, **not from this wave** — see below |

Central typecheck is the orchestrator's; not run here by instruction.

#### The orphan-export failure is not from this wave

`scripts/orphan-export-guard.ts` reports `category C grew 349 → 351`. It is not mine, and
this was established rather than assumed:

- The working tree contains three agents' concurrent work (`git diff --stat` shows
  contact-enrichment, twin-studio, assistant-settings, avatar/voice files alongside
  mine). Census is 8916 exports against a baseline of 8904 — twelve added, of which only
  two TypeScript `interface`s are mine.
- I did briefly introduce one new export (`buildActionParams`). Un-exporting it moved the
  totals **B 208 → 207, C unchanged at 351** — proving it had landed in category B
  ("internal helper of a REACHED module"), never in C.
- The actual +2: `getUnenrichedContacts` and `getContactsNeedingLifeChangeCheck` in
  `app/actions/contact-enrichment.ts`. `grep -rn` finds them referenced **only inside
  comments** — including in `app/api/cron/contact-enrichment/route.ts:7`, which says it
  "called" them in the past tense. The cron route no longer calls them. That is the
  concurrent enrichment wave's item to finish, not a deletion candidate.
- No file this wave touched appears in category C.
