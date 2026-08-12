# Wave 23 — fixing the writers because they are broken, not to unblock a migration

Wave 22 ruled that the `brokerage_id IS NULL` escape is removed everywhere
except the seven platform catalogues and `api_response_logs`, and recorded the
writer fixes as its precondition. Then W22-4 found the precondition is the
actual bug: **46 escape tables have both an unstamped writer and a reader that
filters `.eq("brokerage_id", …)`, across 108 sites.** `NULL = <uuid>` is NULL,
never true, so those rows are already invisible to their own surfaces — today,
with the escape still in place.

So the sequence inverts. **Fix the writers first because they are broken.** No
migration, no policy change, no blast radius. The escape removal comes after,
when it is redundant rather than load-bearing.

This wave takes the two heaviest, both confirmed by reading rather than by name.

## W23-1 — `notifications` (16 unstamped sites): the bell never lights

Three readers filter on brokerage equality, and one of them is the one every
user sees:

| reader | what it drives |
|---|---|
| `app/api/dashboard/badge-counts/route.ts:62` | **the unread badge count** |
| `app/api/cron/qbr-invitations/route.ts:98` | QBR invitation de-duplication |
| `lib/transactions/stranded-offer-reaper.ts:53` | stranded-offer re-notify suppression |

An unstamped notification is therefore **written and then never counted**. The
row exists, the bell stays dark. And the two cron readers use their reads to
decide *"have we already told them?"* — so an unstamped row also fails to
suppress a duplicate, which means the same QBR invitation and the same stranded
offer alert can be sent again.

**This is a merge onto a pattern that already exists in this table's own
writers.** `app/actions/portal-settings.ts:203` stamps
`brokerage_id: access.brokerageId` alongside `user_id`. Sixteen others do not.

## W23-2 — `automation_errors` (17 unstamped sites): the console cannot resolve them

`app/actions/workflows.ts:531` reads it `.eq("brokerage_id", brokerageId)` as an
**ownership check**, returning `"Forbidden"` when it misses.
`app/actions/system-health.ts:466` filters the same way for the health surface,
whose `HEALTH_READER_ROLES` is `["superadmin", "admin", "broker"]` — **broker is
a tenant role**, so this is not platform-only data.

So an untenanted automation error is invisible in the automations console **and
un-resolvable through it**: the retry/acknowledge path refuses every one of them.
Seventeen writers, all in `catch` blocks, are filing failures into a place their
own operator cannot reach.

**I had both of these leaning platform-class** on the strength of the table
names and a guess about `system-health` being platform-gated. Reading the role
list and the predicates reversed it. That is recorded in `docs/wave22-audit.md`
and is the reason this wave triages by reading the reader, never by the name.

## Method

For each site: resolve the tenant **through the record the row is filed
against**, the way waves 20–22 did — never guessed, never carried between id
spaces (`agents.id` / `users.id` / `contacts.id` / `leads.id` are DISJOINT).
Resolve once per action, not per row. Where no tenant resolves, **write nothing
and name the reason** — an untenanted row here is not a private row, it is an
invisible one.

`notifications` rows carry a `user_id` recipient, so the tenant resolves through
the recipient. `automation_errors` rows are written from `catch` blocks whose
enclosing action usually already holds a caller context; where it does not, the
anchor is whatever record the failing workflow was operating on.

## Not in this wave

- **The remaining ~75 sites across 44 tables.** Same class, but each needs its
  reader read before it is called broken — the 46/108 figure came from a
  proximity heuristic, and three tables were confirmed by hand. The rest are a
  signal to check, not a verified total.
- **The escape removal itself** (#156). Ruled, sequenced after the writers.
- **Platform-class exemptions.** `api_response_logs` is settled. Whether any
  other table genuinely belongs in that bucket is still open — and after being
  wrong twice, by reading only.

## Recorded, still owner rulings

- **`offer_strategy_templates`** — `FOR SELECT USING (is_active = true)` to
  PUBLIC. The first active template publishes a negotiation playbook.
- **Leads / raw-leads**, owner-sequenced.
- **`transcribeAudio`'s unvalidated `audioUrl`** (`ai-voice-transcription.ts:359`).
- **`calculateHomeValue` / `submitHomeValueRequest` rate limiting.**

## Rules (unchanged)

- supabase-js RESOLVES a refused query — destructure `error`. Gates fail CLOSED.
- Assert CONSTRUCTS in proofs; negative-control every assertion and confirm the
  control applied before believing green.
- A comment that asserts a gate is not evidence the gate exists.
- Census the callers before trusting that a signal reaches them.
- An authorization check that reads its subject from the request is not an
  authorization check.
- **New this wave:** a table's tenancy class is decided by its **readers**, not
  its name. Two "infrastructure" ledgers turned out to be broker-facing.

## Verification of the deferred set — the heuristic's error rate, measured

The W22-4 count (46 tables / 108 sites) came from a proximity heuristic: a
`.eq("brokerage_id", …)` within 400 characters of a non-insert `.from("<table>")`.
Three tables were confirmed by hand and became this wave's scope. Five more from
the deferred set have now been checked:

| table | brokerage-equality reader found by reading? |
|---|---|
| `sequence_step_executions` | **yes** — `lib/campaign-sequences/channel-order-runner.ts:23` |
| `open_house_attendees` | **yes** — `app/actions/seller-open-house.ts:359, :390` |
| `social_posts` | **yes** — `app/actions/social/generate-social-post.ts:301`, `social-publishing.ts:405` |
| `smart_assistant_suggestions` | **no** — not on a second pass |
| `open_house_invitations` | **no** — not on a second pass |

**Three of five hold; two do not.** So the heuristic runs roughly 60–70% true on
this sample, which is exactly why the 46/108 figure was published as *a signal to
check* rather than a total, and why nothing was dispatched on it wholesale.

The two that did not reproduce are not thereby cleared — a filter applied further
from the `.from()`, or through a helper, would be missed by both passes. They are
**unresolved**, not **fine**. Wave 24 reads them properly before deciding.

The eight confirmed tenant-class tables so far: `notifications`,
`automation_errors`, `cron_execution_logs`, `system_health_checks`,
`sequence_step_executions`, `open_house_attendees`, `social_posts`, and (from
waves 20–21) the `ai_insights` / `compliance_flags` / `ai_predictions` family.

## Outcome

The agent corrected this audit's census, my own re-check was the faulty
instrument, and the sharpest finding was one nobody had asked for.

### The counts

**`notifications` is 15, not 16.** `app/api/widget/intake/route.ts:228` was
already stamped — via a **shorthand property** (`brokerage_id,`), which the
scanner's `key:` pattern reported as a false red. **`automation_errors` is
exactly 17**, plus one the census could never have seen: **`lead-acquisition-
handlers.ts:34` was stamping `brokerage_id: null` explicitly**, which no
"unstamped writer" scan will ever flag.

**Neither table has a back-fill trigger** — zero non-internal triggers on both,
measured. Unlike the wave-21 tables there is no net at all; the application
stamp is the only mechanism.

### The correction that mattered most

`automation_errors` is **not** un-resolvable everywhere.
`app/actions/workflows.ts:531` is, but `lib/platform/ai-ops.ts:73` reads it
**cross-tenant with no brokerage predicate**, and the superadmin console
resolves **by id alone**. That asymmetry is load-bearing: it is what makes
**six deliberate untenanted writes defensible rather than lost** — five cron
*outer* catches and the Engine-1 distribution failure, all on failures no record
can attribute to a tenant, where stamping one would file a platform outage
inside a single brokerage's console. All six were proven readable and resolvable
on the platform console, all six replaced fire-and-forget with a destructured
insert that cannot mask the original error, and an allow-list pins them so a
seventh cannot quietly appear.

### The live proof is the one worth keeping

Two identical notifications to one agent: the badge counts **1, not 2** —
unstamped 0, stamped 1 — **while RLS admits both**. So the escape was never what
hid the row. **The reader's equality was.** That is the W22-4 thesis
demonstrated end to end rather than argued, and it is why this work needed no
migration.

### My own re-check was wrong

Checking the agent's count, a quick shell scan reported ~93 unstamped
`notifications` sites against its 15. Three spot-checks settled it: two stamp
`brokerage_id` on the **same line** as `user_id` and my regex required
line-start, and the third is `.insert(rows)` with the rows built above. **My
instrument was the broken one.** The agent's scanner had already been hardened
for exactly these shapes — and hardened by *its own controls failing*, not by
inspection: it had grepped only double quotes while 6 of 17 files use
`from('automation_errors')`, it ran its insert window past the next `.from(` and
invented 26 phantom sites, and it could not resolve `.map(… => ({…}))` fan-outs,
leaving 10 writers unprovable.

### Found beyond the brief

Two id-space defects fixed — `alert-notifier.ts:133` and
`cda-workflow-client.tsx:721` both put an `agents.id` into
`notifications.user_id`, reporting delivery for rows that never landed. And one
**not** fixed and correctly so: `handoff-queue-panel.tsx` receives an `agentId`
prop that one caller fills with an `agents.id` and another with a `users.id`,
while the component uses it as both. It is wrong in one caller either way, and
which one is a **contract decision** — named, not guessed.

**Readers repaired too:** `badge-counts` (a refused read silently rendered every
badge zero), and both suppression reads now fail **closed** rather than
re-sending.

**21 assertions · 34 negative controls red · 5 specificity controls green.**
Guard extended rather than added, so no `package.json` or `MAINTENANCE_DOMAINS`
change was needed — the registry entry was appended to record what it now holds.

### Verification

Typecheck EXIT=0. Guard chain **223/223** including `test:sweep`, run after the
last edit, in two halves.

## Post-wave: the two unresolved tables, read — and a number of mine corrected

Both were resolved by reading the actual predicate:

- **`smart_assistant_suggestions` — IS in the already-broken class.**
  `app/actions/contact-details.ts:193` reads `.eq("brokerage_id", brokerageId)`
  (alongside `agent_id` and a `metadata->>contact_id` link). Three unstamped
  writers; its untenanted rows are invisible to the contact detail surface.
- **`open_house_invitations` — is NOT.** Every read is **event-scoped**
  (`open-house-automation.ts:730` is `.select("*").eq("event_id", eventId)`),
  and the public RSVP page reads by `id` through the **service client**. No
  brokerage equality anywhere, so an untenanted invitation stays visible to its
  own surfaces. It is still an unstamped tenant row — a #156 concern — but not a
  live functional bug, and it should not be fixed as though it were.

**CORRECTION to my own figure.** I published the heuristic as "roughly 60–70%
true" on the strength of three of five reproducing. That was wrong, and wrong in
the *cautious* direction: `smart_assistant_suggestions` did reproduce, and the
second-pass grep that said otherwise was the faulty instrument — the same class
of error as the ~93-vs-15 miscount above, and the second time in one wave that
my quick shell check lost to a careful scan.

The honest figure is **4 of 5**, with `open_house_invitations` the single true
negative. That does not change the method — every table still gets its reader
read before it is called broken — but the record should say what was measured
rather than the more flattering-to-caution version.

**Running total of confirmed tenant-class tables: nine.** `notifications` and
`automation_errors` (fixed this wave), `cron_execution_logs`,
`system_health_checks`, `sequence_step_executions`, `open_house_attendees`,
`social_posts`, `smart_assistant_suggestions`, plus the
`ai_insights` / `compliance_flags` / `ai_predictions` family from waves 20–21.
One confirmed **not** in the class: `open_house_invitations`.
