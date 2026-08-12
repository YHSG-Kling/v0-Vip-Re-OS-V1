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
