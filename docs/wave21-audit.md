# Wave 21 — the carried items, and how researching them changed all four

Wave 20 closed the anonymous door and left four things written down. Checking
them before dispatching changed the shape of every one — two are smaller than
recorded, one is bigger, and one is not the fix I described.

## W21-1 — `ai_predictions`: three writers, and one of them already does it right

Two of the three `ai_predictions` inserts omit `brokerage_id`.

**CORRECTION (mine, caught by the agent before it wrote anything).** I named
them as `:301` and `:1984`. The count is right and one line number is wrong:
**`:301` was already stamped** in commit `f25e8a5`, and the second unstamped
writer is **`:857`** in `predictDealCloseProbability` — wave 20's edits shifted
it. So two writers already did this correctly in-tree, not one.

**The third one stamps it.** `lib/analytics/ai-prediction-outcomes.ts:89` writes
`brokerage_id: input.brokerageId` alongside the rest of the row. So this is a
**merge onto a pattern that already exists in this codebase**, not a new policy —
the same footing wave 19's budget-tier fix stood on, and the reason it is
dispatchable rather than a question.

`ai_predictions` **carries the escape**, so this is the same exposure class
`ai_insights` was: an untenanted prediction is readable by every tenant, and was
readable by `anon` until m394. The reader at `:422` filters `.eq("entity_id",
leadId).in("entity_type", ["lead","contact"])` and carries **no brokerage
predicate at all** — so the only thing standing between one tenant's deal-close
prediction and another's is a uuid nobody can guess. That is not a boundary.

`lib/analytics/prediction-accuracy.ts:863` and the three reads in
`ai-prediction-outcomes.ts` go through the **service client**, which bypasses
RLS — so they are unaffected either way, and must be checked rather than assumed
before anything is called "fixed".

## W21-2 — `ai_autopilot_plans` / `conversation_intelligence`: the rollup I was worried about does not exist

I recorded these as "a visibility question that touches the brokerage rollup,
audit before changing." Audited: **there is no rollup.** All six call sites for
both tables live in `app/actions/ai-predictions.ts` — one writer and two readers
each — and every reader is already narrow:

| read | filter |
|---|---|
| `ai_autopilot_plans:693` | `.eq("agent_id", agentId).eq("is_active", true)` |
| `ai_autopilot_plans:712` | `.eq("id", planId)` (an update) |
| `conversation_intelligence:1199` | `.eq("lead_id", leadId)` |
| `conversation_intelligence:1218` | `.eq("agent_id", agentId)` |

So the defect is **the opposite of what I assumed**. Both tables' SELECT policies
are `is_platform_admin() OR has_brokerage_access(brokerage_id) OR (is_agent_role()
AND agent_id = current_user_agent_id())`. `has_brokerage_access` explicitly
guards `target_brokerage_id IS NOT NULL`, so on an untenanted row **that middle
lane is dead**. The rows are not leaking — they are **invisible to the broker**,
visible only to the one agent who happens to be the writer.

**CORRECTION (mine).** I wrote "invisible to the broker *and to platform admin*".
That is wrong: `is_platform_admin()` is the policy's **first** disjunct and never
reads `brokerage_id`, so a platform admin sees untenanted rows fine. Measured —
broker of the owning brokerage **0**, platform admin **1**. Only the broker half
of the claim survives, and it is the half the fix revives.

Stamping the tenant therefore has **no reader to update and nothing to break**:
the readers already filter by agent or by lead, and the change only revives the
broker lane the policy was written to provide. That makes this smaller and safer
than recorded, not riskier.

*(Noted in passing, not in scope: `updateAutopilotPlan` at `:710` updates
`.eq("id", planId)` with no ownership predicate of its own. It is protected by
RLS today and would stay protected — but it is leaning entirely on the policy.)*

## W21-3 — `resolveConnection`: "just make it throw" is not a one-liner, and two callers would swallow it

The recorded fix was: make it throw on a refusal but not on an absence, since
`resolve-scoped.ts` already maps a throw to `unreadable`. **The first half of
that is true and the second half is only true for one of five callers.**

`lib/integrations/connection-manager.ts:resolveConnection` performs **three
reads** — `agent_api_credentials` (agent), then `platform_credentials` at agent
scope and brokerage scope — and **every one destructures only `data`**. A refused
read is indistinguishable from an empty one at each of the three tiers, and the
function descends to the next.

The caller census, which is the part that changes the plan:

| caller | today | if `resolveConnection` throws |
|---|---|---|
| `lib/connections/resolve-scoped.ts:204` | `try/catch` → returns `status: "unreadable"` | **works** — this is the one the fix was designed for |
| `lib/providers/vibe.ts:33` | `.catch(() => null)` | **swallowed** — refusal becomes "not connected" again |
| `lib/providers/vibe.ts:174` | `.catch(() => null)` | **swallowed** — campaign silently "staged" instead of dispatched |
| `app/api/cron/connector-health/route.ts:61` | no catch | **newly throws** into a cron route |
| `lib/agentic-os/resolve-app-capability.ts:191` | no catch | **newly throws** into capability resolution |
| `lib/agentic-os/resolve-connected-capability.ts:44` | no catch | **newly throws** into capability resolution |

Shipping the throw alone would fix one caller, be silently undone at two, and
turn three into uncaught exceptions. `resolve-scoped.ts:213` already says this
out loud in a comment — *"`resolveConnection` itself destructures only `data`, so
a REFUSED legacy read still reaches us as an honest-looking null"* — and the two
`.catch(() => null)` sites in `vibe.ts` are exactly the collapse wave 19 spent
its whole budget removing one layer up.

**The shape that actually works:** give `resolveConnection` a discriminated
sibling the way `resolve-scoped.ts` got one — `connected` / `not_connected` /
`unreadable`, stopping the descent on a refusal instead of continuing it — and
keep the existing export as a thin projection so the five callers keep their
current contract. Then repoint the callers that can act on the distinction, and
give the two `vibe.ts` sites an honest refusal instead of a `null` that means
two different things. That is the same fix wave 19 applied one layer up, applied
to the layer underneath it, which is where it should have gone first.

## W21-4 — `redactBudgetForActor`: the flags are already at the call site, and the signature throws them away

Recorded as "takes `VendorBudgetEval` so it cannot see the degradation flags."
True, and the reason is worth stating precisely: **`VendorBudgetResult extends
VendorBudgetEval`**. Both production callers pass a `VendorBudgetResult` straight
from `checkVendorBudget` into a parameter typed as the narrower supertype, so
TypeScript accepts it structurally and **the flags are discarded at the boundary
by the signature, not missing from the data**. Nothing needs plumbing; the call
sites already hold what the view needs.

The consequence, in order of sharpness:

1. **`PlatformBudgetView` renders `spent`, `budget` and `percent` as measured
   fact.** When `degradedTier` is set, `budget` is the assumed `solo_agent`
   ceiling and `percent` is computed against it — so the support console
   (`app/actions/vendor-budget.ts:83` → `vendor-breakdown-row.tsx`) shows
   platform staff a ceiling and a percentage that were **never read**, formatted
   identically to ones that were. Wave 19 built these flags with the explicit
   intent that *"a surface that has to tell a brokerage 'you are over budget' can
   say whether the limit was read or assumed"* — and the only such surface
   discards them.
2. **A degraded verdict renders as `"ok"` to the brokerage.** The gate fails
   OPEN by design, so a degraded verdict has `allowed: true`, so `budgetLevel`
   returns `"ok"`. The brokerage is shown a clean bill of health for a verdict
   that measured nothing. That is the reassuring direction, which is the harder
   one to notice.

**This does not fight the privacy contract, and the contract is not to be
touched.** The file's header is explicit: brokerage users see no dollar amounts,
no ceiling, no percentages, no vendor names. A degradation flag is none of those
— it says *how well the answer is known*, not *what the answer is* — so it can
reach `BrokerageBudgetView` without leaking a single number. Any fix that starts
surfacing amounts to brokerages to "explain" the degradation has broken the
contract and is wrong.

## W21-5 — RECORDED, not built: m394's qualifier left 38 tenant tables anon-insertable

Found while verifying W21-2, not by looking for it. `ai_autopilot_plans` and
`conversation_intelligence` both carry `FOR INSERT WITH CHECK (true)` granted to
**PUBLIC** — and both are still that way after m394, because m394's qualifier is
*"an INSERT-true-to-PUBLIC policy on a table that ALSO carries the escape"* and
neither table carries the escape.

That qualifier was the right call and I would take it again — it is what saved
`listing_inquiries`, the real public inquiry form, from being narrowed. But it
draws the line at the escape, and the escape is not the same thing as being a
tenant table. Measured:

| | |
|---|---|
| `INSERT WITH CHECK (true)` to PUBLIC, total | **74** |
| narrowed by m394 (on escape-carrying tables) | 16 |
| left standing | **58** |
| of those, on tables that carry a `brokerage_id` column | **38** |

Thirty-eight tenant tables where an anonymous caller can still insert. The list
includes `agent_monthly_earnings`, `agent_points_log`, `communications`,
`document_requests`, `document_downloads`, `automation_logs`,
`push_notification_queue`, `transaction_pending_actions` and
`newsletter_scheduled_sends` — none of which is a public write surface, and one
of which is an earnings ledger.

`listing_inquiries` is also in that 38, which is exactly why this is **not**
dispatchable as a blanket narrowing. It needs the same per-table census W20-3
got — *does any anonymous writer actually exist for this table* — which for the
sixteen came back "fifteen no, one yes".

### The census, run — so wave 22 starts from data rather than re-deriving it

**34 of the 38 have no browser-client file touching them at all.** Six have no
call site anywhere in `app/` or `lib/` (`agent_metrics`, `agent_notifications`,
`appointments`, `lead_conversation_history`, `lead_external_behavior`,
`lead_social_intelligence`) — an anonymous-insert grant protecting a table
nothing writes.

Four are touched by a browser client, and three of those resolve immediately:

| table | browser surface | logged out? |
|---|---|---|
| `ai_autopilot_actions` | `app/dashboard/agent/page.tsx` | no — agent dashboard |
| `closing_gifts` | `app/transactions/[transactionId]/page.tsx` | no — transaction detail |
| `newsletter_scheduled_sends` | `app/dashboard/marketing/studio/marketing-studio-client.tsx` | no — marketing studio |
| `listing_inquiries` | `app/listings/[listingId]/public-info-form.tsx` | **YES** |

A browser client on an authenticated page carries the user's JWT and queries as
`authenticated`, not `anon` — so the first three do not need the grant either.

On the browser-client axis the ratio is **37 no, 1 yes**, and the one is the
inquiry form m394's qualifier was written to protect.

### …then I ran the step I had just said was still owed, and it moved the number

**CORRECTION, mine, one paragraph after making the claim.** "37 no, 1 yes" was
one step too confident. A browser client is not the only way to reach the
database as `anon` — **a session server client on a logged-out route runs as
`anon` too**, which is exactly why `tool_usage_sessions` is a carve-out in m394.
So the browser-client census is necessary and not sufficient.

Classifying all 34 by client type: every one is written from server code, none
from a browser client. Eight are session-client-only, and of those, **two are
genuine candidates that are not yet settled**:

| table | call site | why it is open |
|---|---|---|
| `calculator_history` | `app/actions/calculators.ts:587 saveCalculatorResult` | Same file as `tool_usage_sessions`, session client, takes a bare `leadId`, performs no auth check of its own. It sits *above* the `// PUBLIC TOOLS (Zero Friction, No Email Required)` header rather than inside it — but that is a positional inference, not proof. Needs its callers read. |
| `document_downloads` | `app/api/external-portal/documents/download/route.ts:88` | Session client on an **external-portal** route. If portal visitors (vendors, title) are token-authenticated rather than Supabase-authenticated, this runs as `anon` and genuinely needs the grant. Needs the portal's auth model read. |

So the honest state is **32 settled, 2 open, 1 known carve-out** — and wave 22
is still a narrowing with named carve-outs, but the count of them is not yet
one. Resolving those two is the first thing that wave does, before it writes a
line of SQL.

This is the same failure mode the wave logged as its own rule, committed one
turn earlier: *before shipping a fix that depends on a signal reaching a caller,
census the callers.* I wrote the browser-client census, called the question
closed, and the second axis was still unmeasured. It cost nothing here because
nothing had been dispatched — which is the entire argument for auditing before
writing.

## Recorded, NOT to be built — still owner rulings (task #156)

- **The `brokerage_id IS NULL` escape itself.** m394 closed the anonymous half;
  the cross-tenant half is open, and it has three different correct resolutions
  depending on the table (read-only global grant for genuine platform
  catalogues; a platform-admin policy for `api_response_logs`, which writes
  `brokerage_id: null` deliberately; removal everywhere else, which would start
  failing every writer that omits the column). Three resolutions for one
  predicate is a ruling.
- **`offer_strategy_templates`** — `FOR SELECT USING (is_active = true)` to
  `PUBLIC`. Zero rows today; the first template marked active publishes a
  brokerage's negotiation playbook to the internet. "Active" may well have meant
  *published to this tenant's agents*.
- **Leads / raw-leads.** Owner-sequenced for after the loops and orphans.
- **`transcribeAudio`'s unvalidated `audioUrl`** (`ai-voice-transcription.ts:359`)
  — SSRF surface, uncapped Whisper call. Recorded since wave 2.
- **`calculateHomeValue` / `submitHomeValueRequest` have no rate limit**
  (`calculators.ts:659`). Public surfaces, real provider spend.

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.**
- supabase-js RESOLVES a refused query — destructure `error`; a bare `try/catch`
  around a supabase call catches NOTHING. Gates fail CLOSED.
- `agents.id` / `users.id` / `contacts.id` / `leads.id` are DISJOINT. RESOLVE.
- Assert CONSTRUCTS in proofs, never spellings; strip comments before structural
  assertions; negative-control every assertion **and** confirm the control
  actually applied before believing green.
- **Carried from wave 20:** a comment that asserts a gate is not evidence the
  gate exists.
- **New this wave:** before shipping a fix that depends on a signal reaching a
  caller, **census the callers**. Three of this wave's four items were mis-sized
  because the earlier note described the defect without checking who consumes it
  — and W21-3's recorded fix would have been undone at two call sites by a
  `.catch(() => null)` nobody had looked at.
