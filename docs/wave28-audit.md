# Wave 28 — four rulings executed, and three of my briefs were wrong

Wave 27 found the migrations had never been applied. This wave executes the
owner's rulings on top of a database that now matches its files, and the most
useful thing in it is the list of places the agents corrected me.

## Where my briefs were wrong

**The handoff column.** I briefed `ai_isa_qualifications.assigned_to_agent_id`
as an `agents.id`. It **FKs `users(id)`**. `tasks.assigned_to_agent_id` — same
column name, different table — really does FK `agents`. The repo had already
recorded the trap in `scripts/agent-fk-columns.ts:258` under
`USERS_FK_AGENTISH_COLUMNS`, "columns that FK public.users(id) but whose NAME
reads agent-ish". Verified against the catalog.

So the panel never needed two identities; all three columns want a `users.id`,
including a third the brief did not mention (`lifecycle_events.actor_user_id`).
And the defect was worse than described: `voice/isa/page.tsx:389` passed
`getAgentContext().agentId`, so every click was **three refused writes (23503)**
— assignment, kernel event, notification. Two destructured nothing and the
enclosing `try/catch` caught nothing, so the row was optimistically dropped from
the queue and the router navigated on. **A completed-looking handoff that
assigned nobody and notified nobody.**

**The rbac mechanism.** I said the `activities` trigger was why no audit rows
existed. It was not. Proven live: a tenanted caller's OLD row shape **lands** —
the `agent_user_id → users` branch resolves fine under invoker RLS, because
`requirePermission` has already proven that user can read their own row. **The
missing `await` was the whole defect.** The stamp still earns its place, but for
a different reason: `users.brokerage_id` is nullable, and for a user with no
brokerage both shapes are refused 23502.

I also said five audit call sites. There are **six** — and the wrong count had
already propagated into `manager-registry.ts`.

**The cron ruling's premise.** The owner ruled "a broker sees their OWN tenant's
runs". Taken literally that shows a broker an **empty page**: 0 of 130
`createCronRunContextAction` routes pass a `brokerage_id`, both direct writers
stamp an explicit `brokerage_id: null`, and the live ledger holds 0 tenanted
rows. That is architecture, not oversight — a Vercel cron fires **once,
platform-wide**, and `daily-briefing` sweeps every brokerage in one run.

The reconciliation shipped instead: own tenant **plus** the untenanted platform
sweeps, never another tenant's. An `.eq()` would have been *wrong*, not merely
stricter, because `NULL = <uuid>` is NULL.

| | rows visible to broker A |
|---|---|
| old (no predicate) | 3 — **including tenant B's job name and failure text** |
| new (broker A) | 2 — tenant A's run + the platform sweep |
| new (platform admin) | 3 |
| **RLS session as broker A** | **2 — the identical set** |

That last row is the point: the service-client predicate and the table's own
policy now compute the same thing and cannot drift.

Smaller corrections: `open-house.ts:352` was the wrong line (474), and it was
**not** stamping the wrong brokerage — a guard 25 lines above proves the two
values equal. Changed anyway per the ruling; behaviour-identical today, still
correct if that guard is loosened. And a rate limiter **already existed**
(`lib/security/public-rate-limit.ts`) behind a stale comment claiming none did.

## Two things that had never worked at all

**Open-house kiosk check-in.** `open_house_attendees.contact_id` is `uuid NOT
NULL`, no default, no trigger — so the insert was **refused 23502**, not hidden.
Fixed the **schema**, not the writer: stamping a contact at check-in would
permanently break `convertAttendeeToContact`, which exists for that transition,
guards on `contact_id` being NULL, and is wired to a live button — and
auto-creating contacts from an unauthenticated kiosk is a spam vector. The FK is
deliberately kept, and m401 asserts it, because dropping the FK would *also*
make check-in work and pass the nullable assertion.

**`cron_health_snapshot`.** Its single policy was `FOR ALL TO PUBLIC`, so any
broker or team_lead **of any tenant** could UPDATE or DELETE the platform cron
ledger. It cannot be tenant-scoped — no `brokerage_id`, one row per cron — so
m400 makes it SELECT-only for admin roles, with its free-text
`last_error_message` withheld from non-platform-admins behind an explicit
redaction flag rather than a null that reads as healthy.

## The transcript reached nothing

`transcribeAudio` wrote one `call_transcriptions` leaf row read by two
dashboards. It never touched `voice_calls.transcription` — the column
`sweepVoiceCallIntelligence` actually selects on — so `call_analyses` and
`contact_memory` never saw it. It now stamps the one voice-transcript ledger
(only when empty, so the turn loop's live transcript survives), analyzes through
the shared extractor, and embeds into `contact_memory` with the tenant resolved
**through the contact row**. ElevenLabs Scribe preferred; the existing Whisper
path only when unconfigured; honest refusal when neither is set, and a provider
*error* is never silently re-billed to the second vendor.

Live: sweep candidates **0 → 1**, memory recalled at similarity **1.0** through
the real RPC, `probe_leftovers` 0.

## Playbooks are not published to the internet

`offer_strategy_templates."Read active templates"` was `PUBLIC :: (is_active =
true)`. Now `authenticated` with the tenant conjunct, `is_active` kept — the
ruling is that active means published to the tenant, not that active stops
meaning anything.

**`TO authenticated` alone would not have been a fix**, and that is the half a
role narrowing misses: in a rolled-back transaction, another brokerage's
*logged-in* user read the playbook too. anon 1 → 0, other brokerage 1 → 0,
owning brokerage 1 → 1.

## #156 stratum A — 507 policies, 127 tables, provably a no-op

Where `brokerage_id` is `NOT NULL` the escape is **dead**: `IS NULL` is never
true of an existing row, and a NEW row carrying NULL is refused by the
constraint whatever RLS says.

One measured shape, so the rewrite substitutes a known constant rather than
parsing: qual exact 381 + qual null 126 = 507; with_check exact 252 + null 255 =
507; commands `a,d,r,w`, no `FOR ALL`. Three guards on the selection —
`is_nullable='NO'`, no subquery (a `brokerage_id IS NULL` inside an EXISTS refers
to **another table's** column; `prospect_context` is exactly that, and all 11
such policies are excluded), and whole-string equality.

m403's negative control ran **before** m402 and raised at 507 as required.
After: stratum A **507 → 0**, nullable population **510 untouched**, subquery
population **11 untouched**, tenant-escape tables **324 → 196**.

**The nullable half is deliberately not done.** Removing the escape there turns
an unstamped INSERT into a refusal that supabase-js resolves as success, and 47
of those tables still carry unstamped writers.

## A guard that was asserting the opposite of the ruling

`ai-insight-tenant-guard.ts` D5 required the cron readers to carry **no**
brokerage predicate, and control #48 broke them by *adding* one. Both rewritten:
D5 now asserts the disjunction (reading the function body, because the read is
built across two statements the chain walker cannot follow); #48 collapses the
`.or()` into an `.eq()`; new 48b removes the scope entirely.

`lib/security/rbac.ts` was **removed** from `W25_TRIGGER_COVERED` — its entry
existed to record a defect it was not authorised to fix, and the ruling switched
the write on, so it is no longer trigger-covered.

## The process failure worth keeping

`d75e28c` shipped a TS error I had already fixed. I ran `git add` on the file
**before** fixing it, edited it, then staged only the remaining files. `git
status` said `AM` — staged, then modified again — and I read past it. **tsc reads
the working tree; `git commit` ships the index.** The green typecheck I reported
was true of a tree that was never pushed.

The fix is the check, not the edit: after the last change, confirm `git diff` is
empty for everything staged before committing. CI caught it, and the cause was
reproduced against the committed tree in a temp worktree rather than guessed at.

## Verification

Typecheck EXIT=0. Guard chain **224/224** in two halves, `test:sweep` last and
actually run (457 proofs). All 13 migrations written this session — m392–m403
and m410 — confirmed present in `supabase_migrations.schema_migrations`, which
is the thing wave 27 existed to make non-optional.
