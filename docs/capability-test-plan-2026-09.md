# Capability test plan — wave 57

For the integrator, who holds the only credentials against `hrvaqgvukzxfskkcrwbt`
(CLAUDE.md §3 — lanes have none). Every statement below is checked against the
real column names in `scripts/schema-snapshot.ts`, the real FK graph in
`scripts/schema-fk-map.ts`, and the real CHECK vocabularies in
`scripts/check-vocabularies.ts` as of HEAD `1aca7946`. Nothing here has been
run against the live database — that is exactly what this plan is for.

Every row is tagged **`ZZ-WAVE57-TEST`** (the brokerage's `name` and `slug`)
and keyed on **fixed, literal UUIDs** so the whole plan is copy-paste
reproducible and the final zero-count check needs no variable capture. Run
part 1, then as many of part 2's checks as you want proof for, then **part 3
in the order given** (children before parents), then part 4. Do not leave
part 1's rows in the database after part 4 has run clean.

Fixed IDs used throughout:

| Row | UUID |
|---|---|
| brokerage | `aaaaaaaa-5700-4a57-a000-000000000001` |
| agent's `users` row | `aaaaaaaa-5700-4a57-a000-000000000002` |
| `agents` row | `aaaaaaaa-5700-4a57-a000-000000000003` |
| buyer `contacts` row | `aaaaaaaa-5700-4a57-a000-000000000004` |
| `listings` row | `aaaaaaaa-5700-4a57-a000-000000000005` |
| `offer_intents` row | `aaaaaaaa-5700-4a57-a000-000000000006` |
| `tasks` (callback) row | `aaaaaaaa-5700-4a57-a000-000000000007` |
| `ai_video_projects` row | `aaaaaaaa-5700-4a57-a000-000000000008` |
| `agent_intro_videos` row | `aaaaaaaa-5700-4a57-a000-000000000009` |

BLIND SPOT, named rather than guessed around: `scripts/schema-snapshot.ts`
does not carry column nullability (CLAUDE.md §2 records this as a standing
gap). The INSERTs below fill every column a live NOT NULL is plausible on;
if one still refuses with `23502`, the read error names the column — add it
with any value of the right type and re-run.

---

## 1. Seed — create the tagged demo rows

```sql
-- 1. Brokerage (root of the tenant graph)
INSERT INTO public.brokerages
  (id, name, slug, status, plan_tier, email, phone, is_active, is_demo)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000001', 'ZZ-WAVE57-TEST', 'zz-wave57-test',
   'active', 'solo_agent', 'zz-wave57-test@example.invalid', '+15555550100',
   true, true);

-- 2. The agent's own users row (agents.id and users.id are DISJOINT —
--    CLAUDE.md §3 — so this row exists purely to be the FK target of
--    agents.user_id below, never read by agent_id anywhere).
INSERT INTO public.users
  (id, brokerage_id, first_name, last_name, email, user_type, status)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000002', 'aaaaaaaa-5700-4a57-a000-000000000001',
   'ZZ-Wave57', 'Agent', 'zz-wave57-agent@example.invalid', 'agent', 'active');

-- 3. The agent row itself
INSERT INTO public.agents
  (id, user_id, brokerage_id, is_active, onboarding_status)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000003', 'aaaaaaaa-5700-4a57-a000-000000000002',
   'aaaaaaaa-5700-4a57-a000-000000000001', true, 'completed');

-- 4. One buyer contact, preferred_language 'es' (contacts.preferred_language
--    CHECK vocabulary includes 'es' — scripts/check-vocabularies.ts:547;
--    m620 APPLIED per LANE_RULES wave-51 state).
INSERT INTO public.contacts
  (id, brokerage_id, agent_id, first_name, last_name, email, phone,
   contact_type, status, preferred_language)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000004', 'aaaaaaaa-5700-4a57-a000-000000000001',
   'aaaaaaaa-5700-4a57-a000-000000000003', 'ZZ-Wave57', 'Buyer',
   'zz-wave57-buyer@example.invalid', '+15555550101', 'buyer', 'active', 'es');

-- 5. One listing (agent's own, so offer_intents.agent_id below matches it)
INSERT INTO public.listings
  (id, brokerage_id, agent_id, address, city, state, zip, status,
   property_type, list_price)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000005', 'aaaaaaaa-5700-4a57-a000-000000000001',
   'aaaaaaaa-5700-4a57-a000-000000000003', '1 ZZ Wave57 Test Ln', 'Testville',
   'TX', '75001', 'active', 'single_family', 450000);

-- 6. One offer_intents row, status 'requested' (CHECK vocabulary:
--    ["acknowledged","converted","dismissed","requested"] —
--    scripts/check-vocabularies.ts:1046)
INSERT INTO public.offer_intents
  (id, brokerage_id, agent_id, contact_id, listing_id, property_address,
   status, source)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000006', 'aaaaaaaa-5700-4a57-a000-000000000001',
   'aaaaaaaa-5700-4a57-a000-000000000003', 'aaaaaaaa-5700-4a57-a000-000000000004',
   'aaaaaaaa-5700-4a57-a000-000000000005', '1 ZZ Wave57 Test Ln',
   'requested', 'buyer_portal');

-- 7. One pending ai_callback task, due 1 minute ago (tasks carries NO CHECK
--    constraint on source/assignee_type/status — verified: no `tasks:` entry
--    in scripts/check-vocabularies.ts, and lib/ai-isa/callback-task.ts's own
--    header records the same audit). description is the EXACT shape
--    encodeCallbackNote() writes (lib/ai-isa/callback-task.ts) — a
--    "[CALLBACK] " human line, a newline, then the JSON blob
--    decodeCallbackNote() parses back.
INSERT INTO public.tasks
  (id, brokerage_id, contact_id, assignee_type, source, status, title,
   description, due_date)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000007', 'aaaaaaaa-5700-4a57-a000-000000000001',
   'aaaaaaaa-5700-4a57-a000-000000000004', 'ai_isa', 'ai_callback', 'pending',
   'Call back ZZ-Wave57 Buyer',
   E'[CALLBACK] Call back +15555550101 — wave57 capability test. Requested: "call me back in five minutes".\n' ||
   '{"phone":"+15555550101","reason":"wave57 capability test","rawPhrase":"call me back in five minutes","voiceCallId":null,"attempts":0}',
   now() - interval '1 minute');

-- 8. One ai_video_projects row carrying narration_budget_seconds inside
--    video_metadata (NOT a top-level column — lib/video/script-structure.ts:328
--    and app/api/cron/poll-did-videos/route.ts:597-609 both read it as
--    video_metadata->>'narration_budget_seconds'). duration_seconds (42) is
--    deliberately larger than the 30s budget, so §2's overrun check has a
--    real 12s gap to prove against, matching what D-ID actually returning
--    more audio than the script was trimmed for looks like.
INSERT INTO public.ai_video_projects
  (id, brokerage_id, agent_id, contact_id, listing_id, status, video_type,
   video_provider, duration_seconds, video_metadata)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000008', 'aaaaaaaa-5700-4a57-a000-000000000001',
   'aaaaaaaa-5700-4a57-a000-000000000003', 'aaaaaaaa-5700-4a57-a000-000000000004',
   'aaaaaaaa-5700-4a57-a000-000000000005', 'completed', 'welcome', 'did', 42,
   '{"narration_budget_seconds": 30}'::jsonb);
```

---

## 2. Checks — the exact query each capability runs

### 2a. Offer-intents agent queue (`listPendingOfferIntentsForAgent`, app/actions/offer-intents.ts:81-99)

The agent branch (`scope.isAdmin === false`) adds `.eq("agent_id", scope.agentId)`
on top of the tenant + status filter shown below — this is that predicate,
literally:

```sql
SELECT id, contact_id, listing_id, property_address, status, source, offer_id,
       created_at, acknowledged_at
FROM public.offer_intents
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
  AND status IN ('requested', 'acknowledged')
  AND agent_id = 'aaaaaaaa-5700-4a57-a000-000000000003'
ORDER BY created_at DESC
LIMIT 100;
```

**Expect:** exactly the row seeded in step 6 comes back. If it does not, the
agent's own work queue is broken at the predicate level, not just for this
test row.

### 2b. Callback dispatch selection (`app/api/cron/ai-callback-dispatch/route.ts:74-84`)

Literal copy of the cron's own `.from("tasks")` query:

```sql
SELECT id, brokerage_id, contact_id, description, due_date
FROM public.tasks
WHERE source = 'ai_callback'
  AND assignee_type = 'ai_isa'
  AND status = 'pending'
  AND due_date <= now()
ORDER BY due_date ASC
LIMIT 100;
```

**Expect:** the row from step 7 (due 1 minute in the past, so it is already
"due"). If the cron is fired for real (`GET /api/cron/ai-callback-dispatch`
with the cron secret) it will CLAIM this row (`status: 'pending' -> 'in_progress'`)
and attempt to dial `+15555550101` through the tenant's own Twilio
credentials — **this brokerage has none configured**, so the outbound-call
gate chain (lib/voice/outbound-call-gates.ts) will refuse it and the task
will not be left `in_progress` forever; it is still real outbound-call
plumbing being exercised, so prefer proving the predicate with the SELECT
above over actually firing the cron against this row.

### 2c. Welcome dedupe ledger (`agent_intro_videos`, `uq_agent_intro_videos_per_trigger`)

The unique index is `(contact_id, agent_id, trigger, coalesce(trigger_year,0))`
(lib/contact-promotion/welcome-avatar-video.ts:90-91). `trigger` for a
conversion welcome is the literal `'contact_agent_assigned'`
(lib/video/intro-video-reactor.ts:322, `agent_intro_videos_status_check`
vocabulary — scripts/check-vocabularies.ts:118-122).

```sql
-- First send — this is what deliverConversionWelcome's video step stamps
-- on success (lib/contact-promotion/conversion-welcome.ts step 2).
INSERT INTO public.agent_intro_videos
  (id, brokerage_id, agent_id, contact_id, status, trigger, delivery_channel)
VALUES
  ('aaaaaaaa-5700-4a57-a000-000000000009', 'aaaaaaaa-5700-4a57-a000-000000000001',
   'aaaaaaaa-5700-4a57-a000-000000000003', 'aaaaaaaa-5700-4a57-a000-000000000004',
   'delivered', 'contact_agent_assigned', 'both');

-- Second send attempt for the SAME (contact, agent, trigger, year) — this is
-- what MUST be refused for the dedupe to be real.
INSERT INTO public.agent_intro_videos
  (id, brokerage_id, agent_id, contact_id, status, trigger, delivery_channel)
VALUES
  (gen_random_uuid(), 'aaaaaaaa-5700-4a57-a000-000000000001',
   'aaaaaaaa-5700-4a57-a000-000000000003', 'aaaaaaaa-5700-4a57-a000-000000000004',
   'delivered', 'contact_agent_assigned', 'both');
```

**Expect:** the first INSERT succeeds; the second is refused with `23505`
(unique violation) naming `uq_agent_intro_videos_per_trigger`. A refusal
there is the PASS — it is the ledger doing its job. If the second INSERT
instead succeeds, the dedupe index is gone or was never applied and this is
a real defect to report, not a test artifact to ignore.

### 2d. Language resolver tiers (`resolveContactLanguageFromDb`, lib/video/multilingual-reel.ts:158-208)

Tier 1 (`contacts.preferred_language`) is what this demo row exercises:

```sql
SELECT preferred_language, metadata
FROM public.contacts
WHERE id = 'aaaaaaaa-5700-4a57-a000-000000000004';
```

**Expect:** `preferred_language = 'es'`. Tier 1 short-circuits the resolver —
`resolveContactLanguage` (the pure decision function) returns `'es'` without
reaching tier 2 (`voice_calls` -> `call_transcriptions.language`, newest
`transcribed_at` first) or tier 3 (`contacts.metadata->>'captured_language'`).
To prove tiers 2/3 as well, `UPDATE contacts SET preferred_language = NULL
WHERE id = '...0004'` first — with no `voice_calls` row for this contact
(none was seeded) tier 2 has nothing to find, so the resolver falls to tier 3
(also empty here) and returns the ruled default `'en'`
(lib/video/language-vocabulary.ts `DEFAULT_LANGUAGE`). Restore
`preferred_language = 'es'` afterward if you run this variant, so step 2c's
proof and the cleanup counts in part 4 stay consistent with part 1.

### 2e. Video overrun stamp (`app/api/cron/poll-did-videos/route.ts:594-628`)

Prove the READ half — the exact JSON-path expression the poller evaluates:

```sql
SELECT id, duration_seconds,
       video_metadata->>'narration_budget_seconds' AS narration_budget_seconds
FROM public.ai_video_projects
WHERE id = 'aaaaaaaa-5700-4a57-a000-000000000008';
```

**Expect:** `duration_seconds = 42`, `narration_budget_seconds = '30'`. The
poller's pure calculator, `avatarDurationOverrunSeconds(duration, budget)`
(lib/video/script-structure.ts), reduces to `42 - 30 = 12` for these two
numbers. Simulate the WRITE half — the poller's own merge pattern
(`{...existing_metadata, avatar_duration_overrun_seconds: overrun}`, never a
bare `video_metadata: {...}` that would erase `narration_budget_seconds`):

```sql
UPDATE public.ai_video_projects
SET video_metadata = video_metadata || jsonb_build_object('avatar_duration_overrun_seconds', 12)
WHERE id = 'aaaaaaaa-5700-4a57-a000-000000000008';

SELECT video_metadata FROM public.ai_video_projects
WHERE id = 'aaaaaaaa-5700-4a57-a000-000000000008';
```

**Expect:** `{"narration_budget_seconds": 30, "avatar_duration_overrun_seconds": 12}`
— BOTH keys present. If `narration_budget_seconds` is gone after the UPDATE,
the merge pattern this code relies on to avoid clobbering the budget has
regressed.

---

## 3. Teardown — DELETE in FK order, children first

FK order taken from `scripts/schema-fk-map.ts` (each table listed only after
every table that references it):

```sql
-- 1. agent_intro_videos (FKs: agent_id -> agents, brokerage_id -> brokerages,
--    contact_id -> contacts, video_project_id -> ai_video_projects)
DELETE FROM public.agent_intro_videos
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;

-- 2. ai_video_projects (FKs: agent_id, brokerage_id, contact_id, listing_id)
DELETE FROM public.ai_video_projects
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;

-- 3. tasks (FKs: assigned_to_agent_id/created_by_agent_id -> agents,
--    brokerage_id -> brokerages, contact_id -> contacts, listing_id -> listings)
DELETE FROM public.tasks
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;

-- 4. offer_intents (FKs: agent_id, brokerage_id, contact_id, listing_id, offer_id)
DELETE FROM public.offer_intents
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;

-- 5. listings (FKs: agent_id, brokerage_id, contact_id, ...)
DELETE FROM public.listings
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;

-- 6. contacts (FKs: agent_id -> agents, brokerage_id -> brokerages, ...)
DELETE FROM public.contacts
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;

-- 7. agents (FKs: brokerage_id -> brokerages, user_id -> users)
DELETE FROM public.agents
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;

-- 8. users (FK: brokerage_id -> brokerages)
DELETE FROM public.users
WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;

-- 9. brokerages (root — no incoming FK left once 1-8 have run)
DELETE FROM public.brokerages
WHERE id = 'aaaaaaaa-5700-4a57-a000-000000000001'
RETURNING id;
```

CLAUDE.md §3's own trap: a DELETE that matches nothing still resolves with
`error: null`. Every statement above `RETURNING id` for exactly this reason —
read back what actually came out, do not trust a clean `error` alone. Step 1
(`agent_intro_videos`) should return **two** rows if you ran the duplicate-
insert variant in 2c (its second INSERT was refused, so only one ledger row
ever actually exists — expect **one** row back from step 1, not two).

---

## 4. Final proof — zero `ZZ-WAVE57-TEST` rows remain

Run this AFTER part 3 completes. It re-checks every table part 3 touched by
the same fixed `brokerage_id`/id, plus a name/slug check on `brokerages`
independent of the id (in case the literal UUID above ever collides with a
real row — vanishingly unlikely, but the tag string is the actual promise
being verified, not the UUID):

```sql
SELECT
  (SELECT count(*) FROM public.agent_intro_videos WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001') AS agent_intro_videos,
  (SELECT count(*) FROM public.ai_video_projects  WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001') AS ai_video_projects,
  (SELECT count(*) FROM public.tasks              WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001') AS tasks,
  (SELECT count(*) FROM public.offer_intents      WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001') AS offer_intents,
  (SELECT count(*) FROM public.listings           WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001') AS listings,
  (SELECT count(*) FROM public.contacts           WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001') AS contacts,
  (SELECT count(*) FROM public.agents             WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001') AS agents,
  (SELECT count(*) FROM public.users              WHERE brokerage_id = 'aaaaaaaa-5700-4a57-a000-000000000001') AS users,
  (SELECT count(*) FROM public.brokerages         WHERE id = 'aaaaaaaa-5700-4a57-a000-000000000001'
                                                      OR slug = 'zz-wave57-test'
                                                      OR name = 'ZZ-WAVE57-TEST') AS brokerages;
```

**Pass condition:** every column reads `0`. Any nonzero column names exactly
which table's teardown statement (part 3, same position in the list) did not
run, was refused, or matched nothing — re-run that one statement, read its
`RETURNING`, and re-check before considering the sweep done. Per the owner's
wave-56 ruling ("you can use test data as long as you remove it after your
testing"), this file's job is not finished until this query returns all
zeroes.
