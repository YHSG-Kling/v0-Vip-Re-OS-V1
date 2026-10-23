# Wave 5 — Financing Gate Override Authority

Owner ruling (verbatim): **"admin or agent can override the finiancing gate"**

## 1. The two layers as found (pre-change)

### Action layer — `app/actions/buyer-execution.ts:adminOverrideFinancialVerification` (L382)

```ts
const access = await requireContactAccess(contactId)
if (!access.ok) return { success: false, error: access.error }
if (!isAdminOrBroker({ user_type: access.userType })) { ...refuse... }
return await adminOverrideFinancialGate({ contactId, adminId: access.userId, reason, expiresAt })
```

`isAdminOrBroker` (`lib/auth/resolve-user-role.ts`) tests
`BROKER_LEVEL_TYPES = {admin, broker, broker_owner, broker_admin, superadmin, super_admin}`.

### Lib layer — `lib/buyer-execution/multi-party-updates.ts:adminOverrideFinancialGate` (L250)

```ts
const OVERRIDE_LEVEL_TYPES = new Set(['admin','broker','broker_owner','superadmin'])
const actorType = await resolveActorType(supabase, adminId)   // users.user_type, role only as fallback
if (!actorType || !OVERRIDE_LEVEL_TYPES.has(actorType)) return { success:false, error:... }
```

CONFIRMED: the earlier wave DID migrate this off the retired `users.role` column.
`resolveActorType` selects `user_type, role` and uses `row.user_type ?? row.role`, lowercased,
destructures `error`, and returns null (fail-closed) on refusal. `user_type` is primary today.

The two layers were NOT identical: `isAdminOrBroker` additionally admits legacy spellings
`broker_admin` / `super_admin`, which `OVERRIDE_LEVEL_TYPES` does not. Neither spelling exists in
the live CHECK constraint, so the divergence is inert — but the action layer was the looser one.

## 2. Live `user_type` vocabulary — VERIFIED, not assumed

`pg_constraint` on `public.users`, project `hrvaqgvukzxfskkcrwbt`, constraint
`users_user_type_check`, **convalidated = true**:

```
admin, agent, broker, broker_owner, compliance_officer, contact,
isa, lender, superadmin, support, system, tc, team_lead, vendor
```

Notes:
- `broker_admin`, `super_admin`, `title_agent` are NOT admissible values. (`title_agent` appears
  in the `UserRole` union in `lib/auth/resolve-user-role.ts` but cannot exist in the DB.)
- `platform_role` is a SEPARATE column with its own constraint:
  `superadmin, admin, marketing, support, ai_isa_system`.

## 3. The hazard — `requireContactAccess` admits the contact themselves

`lib/portal/require-contact-access.ts` returns `ok:true, isContactSelf:true` when
`contacts.contact_user_id === auth.uid` **or** the contact email equals the auth user email —
and it returns that **before** the staff branch, so a self-match short-circuits the
brokerage + user_type test entirely.

Consequence: a caller can be `isContactSelf:true` while carrying **any** `users.user_type`,
including a staff one, whenever a `contacts` row shares their email address. Admitting `agent`
on user_type alone would let a person who is both an agent and a contact-of-record lift their
**own** financing gate. The allow-list is therefore ANDed with an explicit `isContactSelf`
refusal (the same shape `agentAdvanceBuyer` already uses at L455).

## 4. Agent scope semantics — CHOSEN: the agent OF RECORD on that contact

`requireContactAccess` proves tenant access only. Its staff branch admits **any** `agent` in the
same brokerage regardless of assignment, so "agent" via that gate alone would mean
*any agent in the brokerage*.

Chosen the tighter reading — **the agent assigned to that contact** — because:
1. The only live surface for this command (the voice lane) ALREADY encodes exactly that split:
   `app/actions/voice-assistant/core/validate-authority.ts:validateContactAccess` gives
   admin/broker/team_lead brokerage-wide reach and restricts a plain agent to
   `contact.agent_id === <caller>`. Matching it keeps the lanes in agreement.
2. A financing gate is a consumer-protection control. Lifting it for a buyer the agent has no
   relationship with is not a capability an agent needs.
3. The brief: "Do not silently pick the looser one."

Admin / broker / broker_owner / superadmin keep brokerage-wide reach, unchanged.

### 4a. ID-SPACE LANDMINE — `contacts.agent_id` is an `agents.id`, NOT a `users.id`

Verified live:

```
contacts_agent_id_fkey  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
```
```
contacts_with_agent = 4 | agent_id_matches_users = 0 | agent_id_matches_agents = 4
```

So the assignment test MUST bridge `users.id → agents.id`. Canonical bridge chosen:
`lib/kernel/agent-identity.ts:resolveAgentIdInBrokerage(supabase, userId, brokerageId)` — the
brokerage-scoped variant, correct for a user holding agents rows in several tenants, and
`requireContactAccess` already hands back the resolved `brokerageId`.

**PRE-EXISTING DEFECT FOUND (reported, not silently fixed):**
`validate-authority.ts:validateContactAccess` ends with `return contact.agent_id === userId`,
comparing an `agents.id` against a `users.id`. That can never be true — a plain `agent` has
never been able to pass voice entity-level contact access. It fails CLOSED (denies), so it is
not an exposure, but the capability has never worked. Same bug in `validateListingAccess`
(`listing.agent_id === userId`) — `listings.agent_id` needs the same verification.

## 5. Expiry — IS honoured on the enforcement path; two readers ignore it

Write path: `adminOverrideFinancialGate` → `emitFinancialVerificationEvent`. NOTE the barrel
(`lib/buyer-lifecycle/index.ts:138`) exports the **extensions** version
(`extensions/financial-verification-schema.ts`), not the same-named one in
`financial-verification.ts`. It writes `activity_type = 'buyer.financial.verification'` with
`metadata.expires_at`.

Read path: `checkFinancialVerification` DOES include `buyer.financial.verification` in its
`.in(activity_type, [...])` list, and lifts `metadata.expires_at` into `result.expiresAt`.

- `lib/buyer-execution/buyer-execution-engine.ts:231 enforceFinancialGate` — **HONOURS expiry**
  (`if (verification.expiresAt && new Date() > verification.expiresAt) return { allowed:false }`).
  This is the gate that `showing-financial-policy` and the voice search/tour paths run.
- `buyer-execution-engine.ts:72 getBuyerJourneyStatus` — **IGNORES expiry**. `canSearch/canTour/
  canOffer` are computed from `financialVerification.isVerified` alone. Status/UI surface only.
- `lib/agents/shopping-agent.ts:170` — **IGNORES expiry** (`hasPreApproval = !!isVerified`).
  Advisory phase computation only.

Also note `checkFinancialVerification` returns `isVerified:true` for the most recent matching
event **regardless of `metadata.status`** — a `status:'rejected'` event still reads as verified.
Out of scope here; recorded.

### 5a. REAL BUG — `checkBuyerGovernance` expiry check throws

`lib/buyer-execution/governance-guards.ts:54`:

```ts
if (financialCheck.isVerified && isVerificationExpired(
      financialCheck as unknown as FinancialVerificationEvent & { created_at: string })) {
```

`financialCheck` is a `FinancialVerificationResult` — `{isVerified, verificationType, verifiedAt,
verifiedBy, expiresAt, signals}`. It has **no `metadata` property**. The `isVerificationExpired`
reached through the barrel is the **extensions** one, whose body is
`if (!event.metadata.expires_at) return false`. So `event.metadata` is `undefined` and this
throws `TypeError: Cannot read properties of undefined (reading 'expires_at')` on **every**
call where the buyer is verified. `checkBuyerGovernance` has no try/catch. The `as unknown as`
cast is what hid it from tsc.

There are two same-named functions and the barrel deliberately exports only the event-shaped
one (`lib/buyer-lifecycle/index.ts:33` comment). The result-shaped one
(`financial-verification.ts:179`) is the correct predicate for this call site.
FIX APPLIED: import the result-shaped predicate directly and drop the cast.

## 6. Unattended-caller sweep (hard-won lesson 1) — CLEAN

```
grep -rn 'OverrideFinancial|override_financial|financial_gate|FinancialGate' \
     app/api/cron app/api/webhooks workers lib/workers lib/jobs   -> no matches
```
Second-shape confirmation: the only files mentioning `OverrideFinancial` at all are
`app/actions/buyer-execution.ts`, the three voice-assistant helper files, and
`lib/buyer-execution/{index,multi-party-updates}.ts`. **No cron/webhook/worker caller exists**,
so no separate unattended door is needed. The voice lane is a *session* lane:
`dispatchCommand` requires an injected `DispatchIdentity` resolved from the session and strips
every identity key out of caller/LLM input.

## 7. Surfaces that must agree

`app/actions/voice-assistant/helpers/authority-matrix.ts:28` had
`admin_override_financial_gate: ['admin', 'broker']`. Left un-widened would have kept the voice
lane refusing agents regardless of the action-layer change.

## 8. Non-inclusions, stated deliberately

- **`team_lead`, `isa`, `tc`, `compliance_officer`** — NOT admitted. The ruling names exactly
  "admin or agent"; inventing a wider staff set is not mine to do. `team_lead` is the one most
  likely to be wanted next (it already has brokerage-wide contact reach in the voice matrix) —
  flagged for an owner ruling rather than assumed.
- **`support`** — platform-support tier, not brokerage authority, and `requireContactAccess`
  does not admit it anyway.
- **`broker_owner`** — kept in both override allow-lists, but note it is UNREACHABLE at the
  action layer today: `requireContactAccess`'s staff branch admits only
  `["agent","team_lead","tc","admin","broker","superadmin"]`, so a `broker_owner` gets
  `Forbidden` before the override check runs. Not changed here — that gate is shared by every
  portal read and widening it has blast radius well beyond this task. Recorded as work needed.

## 9. THE WRITE PATH WAS DEAD — the override reported success and wrote nothing

Found while checking that the audit record is reconstructable.

`activities.brokerage_id` is **NOT NULL with no default** (verified live).
`extensions/financial-verification-schema.ts:emitFinancialVerificationEvent` — the barrel's
`emitFinancialVerificationEvent`, and the function that writes the event which *lifts the gate*
— never supplied `brokerage_id`. So every call failed on a not-null violation.

Live confirmation:

```
activity_type in (buyer.financial.verification, buyer.pre_approval.uploaded,
  buyer.proof_of_funds.uploaded, buyer.lender.introduced,
  agent.confirms.buyer.financial, buyer.financial.gate_overridden)
  ->  0 rows

total activities = 24,  activity_type like 'buyer.%' = 0
```

Worse, `adminOverrideFinancialGate` **awaited the emit and dropped its result**, then returned
`{ success: true }`. So the override answered "done" while the gate stayed shut and no
verification record existed. (The sibling `lenderConfirmFinancialVerification` at L250 already
checked `result.success` — only the override path dropped it.)

FIXES APPLIED:
- `emitFinancialVerificationEvent` now resolves `brokerage_id` from the contact (same shape and
  reasoning as m377's fix to `logBuyerExecutionEvent`), resolves `agent_user_id` against `users`
  and records `unresolved_actor_id` in metadata rather than taking the row down on an FK
  violation, sets `contact_id`, and destructures `error` on every read so it fails closed.
- `adminOverrideFinancialGate` propagates the emit failure instead of claiming success.

## 10. Audit record — actor, reason, scope

- **Actor** is the real session actor throughout: `requireContactAccess` derives `access.userId`
  from `auth.getUser()`, the action passes it as `adminId`, and the `adminId` on the public
  signature is ignored. The voice lane cannot inject one — `dispatchCommand` strips every
  identity key from both `parameters` and LLM-extracted `entities` and re-applies the session's.
- **`verifiedBy`** was hard-coded `'admin'`. Now derived from the granted scope
  (`assigned_agent` → `'agent'`, else `'admin'`), so an agent override is not filed as an admin
  one in the very record meant to reconstruct who lifted the gate.
- **Reason** is now written to BOTH rows: `metadata.override_reason` on
  `buyer.financial.gate_overridden` (as before) and `metadata.verification_notes` on the
  `buyer.financial.verification` event — the latter being the row
  `checkFinancialVerification` actually reads back, so the explanation travels with the state.
- **`override_scope`** and **`expires_at`** added to the audit metadata.

## 11. Changes applied

| File | Change |
|---|---|
| `lib/buyer-execution/multi-party-updates.ts` | New `resolveFinancialGateOverrideAuthority` — the single definition of the rule; allow-lists; self-override refusal; agent-of-record bridge. Override now propagates emit failure, derives `verifiedBy`, records scope + expiry. |
| `app/actions/buyer-execution.ts` | Calls the shared rule instead of `isAdminOrBroker`; explicit `isContactSelf` refusal first. Dropped the now-unused `isAdminOrBroker` import; added `createServiceClient`. |
| `lib/buyer-execution/index.ts` | Exports `resolveFinancialGateOverrideAuthority`. |
| `app/actions/voice-assistant/helpers/authority-matrix.ts` | `admin_override_financial_gate: ['admin','broker','agent']`. Verified `user_role` is `ctx.userType` (session-resolved) at `handle-voice-command.ts:95`, so `agent` genuinely matches. |
| `lib/buyer-lifecycle/extensions/financial-verification-schema.ts` | `brokerage_id` / actor resolution fix (section 9). |
| `lib/buyer-execution/governance-guards.ts` | Crash fix (section 5a): import the Result-shaped `isVerificationExpired`, drop both `as unknown as` casts. |

Both layers now enforce the SAME rule from ONE function while reading the user_type FACT
independently (action: from the session via `requireContactAccess`; lib: a fresh `users` read via
`resolveActorType`). Defence in depth kept, drift eliminated.

Live data sanity check (read-only, no test data created): all 4 contacts carrying an `agent_id`
resolve through `agents` to user `a0000000-…-005`, `user_type='agent'` — so exactly that agent is
admitted for those contacts and no other agent is.

## 12. Orphan burn-down

**No deletions made.** Nothing I touched was a duplicate whose loser could be retired.

- `lib/buyer-execution/governance-guards.ts:checkAdminOverride` — **orphan** (exported from the
  barrel, zero callers, confirmed by two differently-shaped searches). NOT deleted, and not a
  duplicate of `resolveFinancialGateOverrideAuthority`: it answers a broader question
  (governance override generally — frozen state and lifecycle gates, not only the financing
  gate) and it carries a capability mine lacks — it honours `platform_role === 'superadmin'` as
  an alternative authority path. Per the method I would MERGE before deleting; I deliberately
  did **not** port `platform_role` in, because that would widen financing-gate authority beyond
  the owner's explicit "admin or agent" ruling, and silently widening a financial gate is the
  one thing this task said must not happen. **To finish:** an owner ruling on whether platform
  staff (`platform_role` superadmin/admin) override tenant financing gates, then either port it
  in and delete `checkAdminOverride`, or wire `checkAdminOverride` to the override UI as the
  pre-flight "should I show the override control?" check — there is no override UI today.
- The two same-named `isVerificationExpired` functions are **not** duplicates — they are
  adapters over two different representations (event-shaped vs result-shaped) and each has a
  legitimate in-file caller. The bug was a wrong import, now fixed; neither is deletable.

## 13. Open items for the owner

1. **`team_lead`** — not admitted (ruling names admin and agent only). It already has
   brokerage-wide contact reach in the voice matrix, so it is the most likely next request.
2. **`broker_owner` is unreachable** at the action layer: `requireContactAccess`'s staff branch
   admits only `["agent","team_lead","tc","admin","broker","superadmin"]`. It is in both
   override allow-lists but gets `Forbidden` first. Fixing means widening a gate shared by every
   portal read — deliberately not done here.
3. **`validate-authority.ts` id-space bug** (section 4a) — `contact.agent_id === userId` and
   `listing.agent_id === userId` compare `agents.id` to `users.id`. Fails closed, but plain
   agents have never passed voice entity-level access. Now load-bearing, since agents are
   admitted to this command.
4. **`checkFinancialVerification` ignores `metadata.status`** — a `status:'rejected'` event still
   reads as `isVerified:true`.
5. **Two readers ignore expiry** (section 5): `getBuyerJourneyStatus` and `shopping-agent`. Both
   advisory; the enforcing readers (`enforceFinancialGate`, `checkBuyerGovernance`) honour it.
6. **No UI surface** for the override at all — the only live lane is voice, and the coverage
   simulator marks it deliberately not voice-speakable.
