# Wave 27 — the migrations were never applied

Waves 20 and 22 wrote the RLS remediation. This wave found that **none of it was
ever in the database.** m392 through m397 existed only as files.

## How it surfaced, and the proof

Ruling 4 was "migration should be finished". Scoping #156 meant asking the live
database what the escape surface actually looked like, and the answer did not
match what waves 20/22 had recorded as done.

| check | expected if m392–m397 had applied | actual |
|---|---|---|
| newest row in `supabase_migrations.schema_migrations` | `m399` | **`m391`** |
| escape policies granted to `PUBLIC` (m394's target) | 0 | **1,025** |

The ledger alone is suggestive; the second row is decisive and independent of it.
m394's entire job is `ALTER POLICY … TO authenticated` over every policy carrying
`brokerage_id IS NULL`. Had it run, none could still be `TO PUBLIC`. All 1,025
were. There is also **no CI or deploy step anywhere in the repo that applies
migrations** — nothing in the four workflows, nothing in `package.json`.

So every wave-20/22 claim of the form "narrowed 1,025 policies across 320 tables"
was a claim about a **file**. The live database still handed `anon` — the key
shipped in the browser bundle — SELECT, INSERT, UPDATE and DELETE on every
untenanted row of 324 tables, for the entire time those waves were recorded as
complete.

### A third proof I published and then had to retract

I first offered a third: m392 drops every `FOR ALL / USING (true) / TO PUBLIC`
policy, and the database still had **309** `ALL`-to-public policies, so m392
looked unapplied-and-not-a-no-op too.

**That was my measurement, not the schema.** m392 additionally requires
`USING (true)`; I had counted `cmd='ALL' AND roles ~ public` without it. Re-run
with m392's own predicate, the candidate set is **empty** — those 309 carry real
predicates and are fine. m392's author had predicted a no-op here and was right.
Dry-running each migration's *own* selection before applying is what caught it,
and it is why the two proofs above were dry-run the same way before anything
was applied.

## Applied, in order, each verified

Every one of these is a **pure narrowing** — `ALTER POLICY … TO authenticated`,
expressions untouched, no `USING`, no `WITH CHECK`, no `CREATE`. Reversal is
`ALTER POLICY … TO public`. The 4 escape policies that were *already*
`authenticated` before m394 were captured first so any rollback could not
over-reach: `chat_templates.tenant_read_chat_templates`,
`content_topic_bank.content_topic_bank_select_brokerage`,
`content_topic_sources.content_topic_sources_select_brokerage`,
`content_topic_uses.content_topic_uses_select_brokerage`.

| migration | effect |
|---|---|
| m392 | no-op, as its author predicted — recorded so m393 can assert it |
| m393 | green: no policy grants ALL to PUBLIC |
| **m394** | **1,025 escape policies → `authenticated`, across 324 tables** |
| m395 | green: escape-to-PUBLIC = 0 |
| m396 | anon INSERT-true on `brokerage_id` tables → `authenticated` |
| m397 | green: 2 remain, and they are exactly the two named carve-outs |

Carve-outs are **named with their call sites**, never silently spared:
`tool_usage_sessions_insert` (`app/actions/calculators.ts:607 trackToolUsage`,
under "PUBLIC TOOLS (Zero Friction, No Email Required)") and
`listing_inquiries_insert` (`app/listings/[listingId]/public-info-form.tsx`, a
logged-out page).

Independent post-check, not the assertions re-reading themselves:
`escape_still_public = 0`, `anon_insert_on_tenant_tables = 2` (both carve-outs),
ledger head now past m397.

## What #156 actually needs, now that it can be scoped honestly

The ruling is per table: 7 catalogues get a read-only global grant,
`api_response_logs` a platform-admin policy, escape removed everywhere else. The
blocker on "removed everywhere else" was never the DDL — it is that removing the
`IS NULL` disjunct from a `WITH CHECK` turns an unstamped INSERT into a
**refusal**, and supabase-js resolves a refusal, so a writer that does not
destructure `error` reports success over a row that never existed (wave 26).

Measured rather than assumed, the 324 tables stratify:

- **127 — `brokerage_id` is `NOT NULL`.** The `IS NULL` disjunct can never match
  a row, so removing it is a **provable no-op**. Zero writer risk.
- **149 of the 196 nullable — no unstamped writer** (119 fully stamped + 30 with
  no `.insert()`/`.upsert()` in `app/` or `lib/` at all).
- **47 nullable tables carry 56 unstamped sites**, 19 of them with an equality
  reader — already broken today. 15 sites across 10 tables are UNRESOLVED and
  must be read, not counted.
- **1 — `prospect_context`** has no `brokerage_id` at all; its escape is a
  **joined** one, inheriting `prospects.brokerage_id IS NULL` through an EXISTS.
  Its fate follows `prospects`.

So **276 of 324 tables can have the escape removed without breaking a writer**,
and the remaining 47 are the burn-down waves 21–26 have been working through.

### One scope gap in that number, stated

The enumerator scans `app/` and `lib/` only. `services/supabaseService.ts` — 23
write sites, live (imported by `app/actions/communications.ts` and
`app/api/vendors/list/route.ts`) — is outside it. It resolves its key as
`SUPABASE_SERVICE_ROLE_KEY || NEXT_PUBLIC_SUPABASE_ANON_KEY`, so it is
service-role (RLS bypassed) wherever the service key is present, and the
fallback is a **fail-open**: a function named `getSupabaseAdmin` silently becomes
an anon client if the env var is missing. Not the tenant class, but it is a
config-shaped downgrade with no stated skip.

## Beyond the ruling — reported, not acted on

m396 covers tables that HAVE a `brokerage_id`. **20 INSERT-true-to-PUBLIC
policies remain on tables that do not**, so `anon` can still insert into them:

`assistant_queries, audit_log, call_whisper_logs, campaign_sequence_steps,
cma_comparables, cma_price_adjustments, conversation_audit_flags,
document_access_log, document_audit_trail, embedding_queue, long_form_videos,
marketing_stats, newsletter_seo_scores, notification_queue,
objection_training_turns, tool_shares, transparency_videos, user_activity,
video_generation_queue, workflow_run_steps`

**Four of those are the audit trail**: `audit_log`, `document_audit_trail`,
`document_access_log`, `conversation_audit_flags`. An anonymous caller cannot
erase history there, but can **forge and flood it**, which damages the same
property the tables exist to provide. Narrowing them needs the call-site census
m396 did for its own set — a carve-out that is not named with a call site is not
a carve-out — so this is the next wave, not a bolt-on here.

## The durable lesson

A migration file is not a migration. Nothing in this repo applies them, so
"wrote the migration" and "the database changed" were two different facts that
six waves treated as one. Every future wave that ships DDL must **verify the
effect against the live catalog**, the way the two proofs above were run — and
the assertion migrations only help if someone applies them too.
