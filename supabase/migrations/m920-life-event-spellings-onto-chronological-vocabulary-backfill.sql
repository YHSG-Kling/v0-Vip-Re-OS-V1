-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148F ──
--
-- m920 — THE LIFE-EVENT BACKFILL onto the chronological vocabulary (wave 148, lane 148F — owner ruling 5; contract C20; the
-- backfill lane 147Z recorded in its notes, widened from two spellings to the whole map). DATA ONLY — no DDL.
--
-- Every element of contacts.life_events and leads.life_events (jsonb arrays) is rewritten onto lib/enrichment/life-event-vocabulary.ts
-- LIFE_EVENT_VOCAB, exactly as the ONE write rule (mergeLifeEvents) now writes new elements:
--   · the spelling becomes canonical (every alias of the map 87 spellings, the 147Z retired `divorce` / `death_in_family` included);
--   · the element key becomes `type` (the OSINT rung's `{ event }` shape is folded in; `event` is removed);
--   · `observed_at` is stamped from the element's own detected_at / detectedAt, else the row's last_life_event_detected, else now();
--   · `event_at` is stamped from the element's own event date keys (event_at / event_date / date / source_date / publishedDate /
--     published_date) when one reads as an ISO date — never guessed;
--   · `sequence` is the element's position in the stored array when it has none (the stored order IS the order it was kept in);
--   · `supersedes` is NOT computed for history (it predates the chronology): new records link to the earlier one they supersede.
-- Elements the map does not know are left exactly as they are (not ours to drop), and so are PROHIBITED tokens (pregnancy / health
-- inferences): those are LISTED by VERIFY 3 for the owner — removing a stored inference is a deletion that needs the owner's word.
-- IDEMPOTENT: a second run changes nothing (canonical stays canonical; stamped stays stamped).
-- LIVE COUNT 2026-11-01 (read-only): contacts with a non-empty life_events array = 0 (4 rows hold []), leads = 0 — this touches
-- no row today; it is written so the rows stored before C20 land on the map the day they exist.
--
-- THE MAPPING BELOW IS GENERATED from LIFE_EVENT_VOCAB (scripts/life-event-engagement-guard.ts asserts the pairs equal the map's
-- alias index — a spelling added to the map without this file, or here without the map, is a red guard).

-- A session temp table (gone at session end; dropped explicitly below) — never a vocabulary table in the schema.
CREATE TEMP TABLE IF NOT EXISTS m920_life_event_spelling (token text PRIMARY KEY, canonical text NOT NULL);
INSERT INTO m920_life_event_spelling (token, canonical) VALUES
    ('job_change', 'job_change'),
    ('new_job', 'job_change'),
    ('job_start', 'job_change'),
    ('started_new_job', 'job_change'),
    ('new_role', 'job_change'),
    ('new_position', 'job_change'),
    ('promotion', 'job_change'),
    ('promoted', 'job_change'),
    ('career_change', 'job_change'),
    ('new_employer', 'job_change'),
    ('new_company', 'job_change'),
    ('job_change_to_non_local', 'job_change_to_non_local'),
    ('job_change_non_local', 'job_change_to_non_local'),
    ('out_of_area_job', 'job_change_to_non_local'),
    ('job_transfer', 'job_change_to_non_local'),
    ('transferred', 'job_change_to_non_local'),
    ('relocation_for_work', 'job_change_to_non_local'),
    ('work_relocation', 'job_change_to_non_local'),
    ('marriage', 'marriage'),
    ('married', 'marriage'),
    ('wedding', 'marriage'),
    ('engaged', 'marriage'),
    ('engagement_announcement', 'marriage'),
    ('newlywed', 'marriage'),
    ('marriage_announcement', 'marriage'),
    ('spouse', 'marriage'),
    ('new_baby', 'new_baby'),
    ('baby', 'new_baby'),
    ('birth', 'new_baby'),
    ('newborn', 'new_baby'),
    ('new_child', 'new_baby'),
    ('child_born', 'new_baby'),
    ('birth_announcement', 'new_baby'),
    ('kids_graduated', 'kids_graduated'),
    ('graduation', 'kids_graduated'),
    ('kids_graduating', 'kids_graduated'),
    ('child_graduated', 'kids_graduated'),
    ('college_bound', 'kids_graduated'),
    ('empty_nester', 'empty_nester'),
    ('empty_nest', 'empty_nester'),
    ('kids_moved_out', 'empty_nester'),
    ('kids_left_home', 'empty_nester'),
    ('retirement', 'retirement'),
    ('retired', 'retirement'),
    ('retiring', 'retirement'),
    ('divorce_filing', 'divorce_filing'),
    ('divorce', 'divorce_filing'),
    ('dissolution', 'divorce_filing'),
    ('dissolution_of_marriage', 'divorce_filing'),
    ('separation', 'divorce_filing'),
    ('legal_separation', 'divorce_filing'),
    ('divorced', 'divorce_filing'),
    ('foreclosure_filing', 'foreclosure_filing'),
    ('foreclosure', 'foreclosure_filing'),
    ('pre_foreclosure', 'foreclosure_filing'),
    ('preforeclosure', 'foreclosure_filing'),
    ('notice_of_default', 'foreclosure_filing'),
    ('lis_pendens', 'foreclosure_filing'),
    ('trustee_sale', 'foreclosure_filing'),
    ('death_in_household', 'death_in_household'),
    ('death_in_family', 'death_in_household'),
    ('death', 'death_in_household'),
    ('deceased', 'death_in_household'),
    ('obituary', 'death_in_household'),
    ('passed_away', 'death_in_household'),
    ('bereavement', 'death_in_household'),
    ('widowed', 'death_in_household'),
    ('inheritance', 'inheritance'),
    ('probate', 'inheritance'),
    ('probate_filing', 'inheritance'),
    ('estate', 'inheritance'),
    ('estate_of', 'inheritance'),
    ('inherited', 'inheritance'),
    ('inherited_property', 'inheritance'),
    ('executor', 'inheritance'),
    ('heir', 'inheritance'),
    ('bankruptcy', 'bankruptcy'),
    ('bankruptcy_filing', 'bankruptcy'),
    ('chapter_7', 'bankruptcy'),
    ('chapter_13', 'bankruptcy'),
    ('bankrupt', 'bankruptcy'),
    ('relocation', 'relocation'),
    ('relocating', 'relocation'),
    ('relocated', 'relocation'),
    ('relocation_announcement', 'relocation'),
    ('new_mover', 'relocation'),
    ('change_of_address', 'relocation')
ON CONFLICT (token) DO NOTHING;

-- One element → its canonical, chronologically stamped form (or itself, untouched).
CREATE OR REPLACE FUNCTION pg_temp.m920_life_event_element(el jsonb, ord bigint, fallback_observed timestamptz)
RETURNS jsonb LANGUAGE sql STABLE AS $fn$
  WITH t AS (
    SELECT CASE WHEN jsonb_typeof(el) = 'string' THEN jsonb_build_object('type', el #>> '{}') ELSE el END AS e
  ), k AS (
    SELECT e, lower(regexp_replace(trim(coalesce(e->>'type', e->>'event', '')), '[\s-]+', '_', 'g')) AS token FROM t
  ), m AS (
    SELECT k.e, s.canonical FROM k LEFT JOIN m920_life_event_spelling s ON s.token = k.token
  )
  SELECT CASE
    WHEN m.canonical IS NULL THEN el
    ELSE (m.e - 'event' - 'type')
      || jsonb_build_object('type', m.canonical)
      || jsonb_build_object('observed_at', coalesce(m.e->>'observed_at', m.e->>'detected_at', m.e->>'detectedAt', to_char(coalesce(fallback_observed, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      || jsonb_build_object('event_at', coalesce(
           CASE WHEN m.e->>'event_at' ~ '^\d{4}-\d{2}-\d{2}' THEN m.e->>'event_at' END,
           CASE WHEN m.e->>'event_date' ~ '^\d{4}-\d{2}-\d{2}' THEN m.e->>'event_date' END,
           CASE WHEN m.e->>'date' ~ '^\d{4}-\d{2}-\d{2}' THEN m.e->>'date' END,
           CASE WHEN m.e->>'source_date' ~ '^\d{4}-\d{2}-\d{2}' THEN m.e->>'source_date' END,
           CASE WHEN m.e->>'publishedDate' ~ '^\d{4}-\d{2}-\d{2}' THEN m.e->>'publishedDate' END,
           CASE WHEN m.e->>'published_date' ~ '^\d{4}-\d{2}-\d{2}' THEN m.e->>'published_date' END))
      || jsonb_build_object('sequence', CASE WHEN m.e->>'sequence' ~ '^[0-9]+$' THEN (m.e->>'sequence')::int ELSE ord::int END)
      || CASE WHEN m.e ? 'supersedes' THEN '{}'::jsonb ELSE jsonb_build_object('supersedes', NULL) END
  END
  FROM m
$fn$;

-- contacts
UPDATE public.contacts c SET life_events = (
  SELECT jsonb_agg(pg_temp.m920_life_event_element(el, ord, c.last_life_event_detected) ORDER BY ord)
  FROM jsonb_array_elements(c.life_events) WITH ORDINALITY AS a(el, ord)
)
WHERE jsonb_typeof(c.life_events) = 'array' AND jsonb_array_length(c.life_events) > 0
  AND c.life_events IS DISTINCT FROM (
    SELECT jsonb_agg(pg_temp.m920_life_event_element(el, ord, c.last_life_event_detected) ORDER BY ord)
    FROM jsonb_array_elements(c.life_events) WITH ORDINALITY AS a(el, ord)
  );

-- leads (no last_life_event_detected column on leads: now() is the observed fallback)
UPDATE public.leads l SET life_events = (
  SELECT jsonb_agg(pg_temp.m920_life_event_element(el, ord, NULL) ORDER BY ord)
  FROM jsonb_array_elements(l.life_events) WITH ORDINALITY AS a(el, ord)
)
WHERE jsonb_typeof(l.life_events) = 'array' AND jsonb_array_length(l.life_events) > 0
  AND l.life_events::text ~ '"(type|event)"'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(l.life_events) el
    WHERE jsonb_typeof(el) = 'object' AND NOT (el ? 'observed_at' AND el ? 'sequence')
  );

DROP FUNCTION IF EXISTS pg_temp.m920_life_event_element(jsonb, bigint, timestamptz);
DROP TABLE IF EXISTS m920_life_event_spelling;

-- ── VERIFY (integrator, after apply) ─────────────────────────────────────────────────────────────────────────────────────────
-- 1. No retired / alias spelling remains as a stored type (expect 0):
--    SELECT count(*) FROM public.contacts c, jsonb_array_elements(c.life_events) el
--     WHERE jsonb_typeof(c.life_events)='array' AND el ? 'event';
-- 2. Every canonical element is stamped (expect 0):
--    SELECT count(*) FROM public.contacts c, jsonb_array_elements(c.life_events) el
--     WHERE jsonb_typeof(c.life_events)='array' AND el->>'type' IN ('job_change','job_change_to_non_local','marriage','new_baby',
--       'kids_graduated','empty_nester','retirement','divorce_filing','foreclosure_filing','death_in_household','inheritance',
--       'bankruptcy','relocation') AND NOT (el ? 'observed_at' AND el ? 'sequence');
-- 3. Prohibited inferences still stored (expect 0; any row is for the OWNER to rule on — never deleted here):
--    SELECT c.id, el FROM public.contacts c, jsonb_array_elements(c.life_events) el
--     WHERE jsonb_typeof(c.life_events)='array' AND lower(coalesce(el->>'type', el->>'event', '')) IN
--       ('pregnancy','pregnant','expecting','illness','diagnosis','diagnosed','hospice','hospitalized','medical','disability','rehab','pregnancy_announcement');
-- 4. Once 1–2 read 0 on the live database, lib/enrichment/life-event-vocabulary.ts LEGACY_LIFE_EVENT_ALIASES may be retired with
--    a tombstone (its aliases stay in LIFE_EVENT_VOCAB for provider input).
