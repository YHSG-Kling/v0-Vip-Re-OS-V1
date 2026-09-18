# Wave 32 — five rulings, and the two that were not the thing they looked like

Owner rulings, verbatim:

> "yes that gate STT needs to be turned on; any ai use is vercel ai gateway.
> please build the call recording player. platform needs the training/learning
> as well for the tenants. commission should be tenant only but not sure what to
> do with multiple location brokerages, need advice. submit quiz attempt for
> agentid auth."

Five asks. Researching each before dispatching changed the shape of two of them,
and the office ruling turned into the most interesting defect of the wave.

## Commission is tenant only — and the UPDATE hole nobody had reported

`commission_splits` carried the tenant predicate on **half** its policies. SELECT
and DELETE both used `has_brokerage_access(brokerage_id)`. The two write-side
checks did not:

| policy | clause | before |
|---|---|---|
| INSERT | WITH CHECK | `is_platform_admin() OR is_brokerage_admin()` ❌ |
| UPDATE | USING | `… has_brokerage_access(brokerage_id)` ✅ |
| UPDATE | WITH CHECK | `is_platform_admin() OR is_brokerage_admin()` ❌ |

The INSERT hole had been reported. **The UPDATE hole had not**, and it is the
same defect one step later: USING decides which rows you may act on, WITH CHECK
decides what the row may look like afterwards. With USING scoped and WITH CHECK
unscoped, a brokerage admin could take a split they legitimately own and **move
it** — rewrite `brokerage_id` to another tenant, or to NULL. Money crossing a
tenant boundary by UPDATE is the same leak as by INSERT.

A NULL `brokerage_id` is worse than a wrong one: `has_brokerage_access` rejects
NULL, so an untenanted split is invisible to every reader and sits in nobody's
books.

Both now use the helper the table already relied on. **Breaks no writer** — both
were read first and both already stamp the tenant (`app/actions/agents.ts:627`,
`lib/kernel/financial.ts:1167`); the other four call sites are status UPDATEs
keyed on `commission_id` that never touch `brokerage_id`.

m420 asserts the **construct** — no expression on this table, either clause of
any command, lacks the tenant — because the defect to prevent is a *fifth* policy
added later, and a list of four names cannot see one that does not exist yet. It
pins the **helper** rather than a shape on purpose: see the multi-location note
below.

The negative control raised at exactly 2, which is also what confirmed UPDATE's
USING was already correct.

## Multi-location: the office admin who could not exist

The advice question turned out to have a real defect behind it.

`resolveEgressScope` implements an **office admin**: an admin *with* a location
is pinned to that office; without one they see the whole brokerage. It reads
`agents.location_id`. But `requiresAgentRow()` deliberately gives a pure-admin
owner of a `brokerage` / `multi_location` tenant **no agents row** — they own no
listings, so one would be a fiction.

Together: **on the `multi_location` tier the office admin cannot exist.** The one
tier that has offices is the one whose admins have nowhere to record one.
Measured live: **8 of 13 non-client users have no agents row, including 2 of 3
admins**. The office assignment roster read `agents`, so it listed 5 of 13 people
and silently omitted the person the screen is for.

The office UI itself already existed — `app/actions/admin/locations.ts`,
`/dashboard/admin/locations`, linked in the nav. This was never a rebuild.

m423 puts the office on the **person**: `users.location_id`, nullable, FK to
`locations`, `ON DELETE SET NULL`. Not an agents row for admins — that would
contradict the provisioning spec on purpose and put fictitious agents into every
roster, seat count and production report. `agents.location_id` is kept as the
fallback, and **m424 asserts it survives**, because a later "cleanup" dropping it
would empty every office report rather than migrate it.

`lib/kernel/resolve-user-office.ts` is the one precedence rule — person wins over
agent record — exported both as an async resolver and as a pure `pickUserOffice`
for callers already holding both rows, so the rule cannot drift between them.

Proven live, then cleaned to zero leftovers:

| person | agents row | resolved via |
|---|---|---|
| team_lead | **no** | `users` — the case that was impossible before |
| admin | yes | `agents` — nothing that worked changed |
| agent | no | none — unassigned |

### Commission by office, derived

`generateBrokeragePnl` gains `byOffice` — GCI, closings, company dollar, payouts
— by joining the producing agent, because `commission_splits` carries no
`location_id`. `commission_splits` is read **once and folded twice** so the office
rows cannot disagree with the brokerage total they sum to. The null bucket is
**named** ("No office assigned") rather than dropped: an office report whose parts
do not sum to the whole is worse than none.

The trade is in the type doc, not hidden: deriving means **an agent who transfers
offices takes their whole history with them**. Stamping `location_id` at write
time is the fix when that matters, deliberately not done with no closed deals to
preserve — a writer-less column is the exact thing this codebase keeps cleaning up.

## submitQuizAttempt was a duplicate, not a missing gate

The wired implementation already had the gate.

**Survivor** — `lib/kernel/agent-onboarding.ts:submitQuizAttempt`. Calls
`assertCanAccessAgent`, derives `brokerageId` from it, stamps the tenant. Reached
from an action that resolves the user from the session and the agentId from
`getAgentContext`, so the caller cannot name an agent.

**Deleted** — `app/actions/ai-agent-onboarding.ts:submitQuizAttempt`. Took
`agentId` **from the caller** with no auth check, then looked the tenant up *from
that caller-supplied id*, so the stamp inherited the forgery. Exported as a server
action; no UI caller.

Merged before deleting: the survivor gains the richer return. `completeAISessionStep`
was deliberately **not** ported — the survivor has no session-derived `sessionId`,
and inventing a parameter for it would reintroduce exactly the caller-supplied
identity being removed.

`test:orphan-exports` went red with "CAPABILITY REMOVED", which is the guard
refusing a deletion until the survivor is **named**. Named, callers verified,
baseline re-set deliberately.

## The recording player: the disclosure was the risk

`voice_calls.recording_url` had no writer while six UI surfaces already read it.
The player was largely built; the producer was missing.

Outbound arms recording at dial time (a `Record` parameter, free, behind the
existing gate stack). Inbound cannot — its answer is TwiML, `<Gather>` has no
record attribute, and `<Record>` is a blocking verb that would replace the
conversation rather than capture it — so it creates a Recording resource against
the live call.

**The spoken disclosure said the call was NOT being recorded.** Turning recording
on without flipping that would have made the system lie about recording, on a
product with a TCPA surface, in two-party-consent states. It is now driven by
whether recording is actually armed, and the simulator asserts **both**
directions — a disclosure correct only in the default case is the shape that lies.

`test:egress-send-guard` flagged the new file as an unreviewed raw connector send.
That is a false positive — a POST to `/Calls/<sid>/Recordings.json` is call
control and sends nothing to anyone — but the guard demands a written reason
rather than an exemption. Supplied, and negative-controlled: entry removed → red
for that reason → restored byte-identical.

**Not smoke-tested.** No Twilio credentials in this environment, so no real
recorded call was placed. Only the wiring and the disclosure coupling are proven.

## STT and platform courses

The repurpose lane called the shared transcription primitive with no options, so
`checkVendorBudget` never pre-flighted and the cost ledger never recorded — while
its sibling passed both. The tenant is now resolved **server-side from the
session**, not accepted as an argument: that file carries a top-level
`"use server"`, so every export is an RPC endpoint any authenticated session can
call with any arguments, and widening the signature would have let a caller bill
another tenant's ledger.

`learning_modules.brokerage_id` was `NOT NULL`, making a platform-provided course
structurally impossible. m421/m422 move it onto the same catalogue shape m406–m409
established. **Both were already applied to the live database while their files
sat uncommitted** — the reproducibility problem the migration-ledger guard exists
to catch, in reverse.

## A miss of my own

CI went red on `be9cc05`: `test:schema-drift` compares every guarded column
reference against a committed snapshot, and m423 added `users.location_id`
without regenerating it. I ran the tenant, financial and wiring guards for that
change but **not the one guard whose whole job is noticing a new column**. The
guard was right and the code was right; only the snapshot was stale. Regenerated
from the live schema rather than hand-edited.

## Verification

Typecheck EXIT=0. Guard chain both halves — 28/28 and 457/457 with `test:sweep`
last and actually run. m419–m424 all confirmed in
`supabase_migrations.schema_migrations`, each assertion body run as a negative
control **before** its change. Live fixtures cleaned to 0 leftovers.

## Still open

- **Should a closed commission stay with the office that earned it** when an agent
  transfers? Cheap now, expensive once there are closings.
- `generateScriptContent` has no author-scoped home (#172).
- #156's nullable half: MIXED stratum in flight, ZERO stratum untouched.
