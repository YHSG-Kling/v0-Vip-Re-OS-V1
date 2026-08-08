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

## WORK LOG

(appended as it happens)
