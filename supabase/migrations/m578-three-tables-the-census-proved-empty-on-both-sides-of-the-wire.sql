-- m578 — THREE TABLES THE CENSUS PROVED EMPTY ON BOTH SIDES OF THE WIRE
--
-- WRITTEN, NOT APPLIED (lane CD, 2026-08-28). Lanes write migrations; only the
-- integrator applies them (CLAUDE.md §3).
--
-- Lane CB's orphan tranche (2026-08-27) deleted the three types that restated
-- these rows — AIPromptTemplate, CreditConversationLog, EventRegistration — and
-- left each tombstone saying the live table "stays recorded on the
-- opposite-missing wire list for the table-retirement lane". This is that lane.
-- Each table was adjudicated under §1: the capability is BUILT ANOTHER WAY, the
-- survivor is named, so the schema half retires too.
--
-- ── EVIDENCE, ALL AGAINST THE LIVE DATABASE (2026-08-28, read-only) ──────────
--   · ROW COUNT: 0 for all three. Nothing is destroyed.
--   · TRIGGERS: none (pg_trigger, tgisinternal excluded).
--   · PROCEDURES: no pg_proc body in schema public mentions any of the three —
--     so no migration-backfill/.rpc()/trigger writer hides behind the zero
--     (the §3 "one-sided without being one-sided" check).
--   · INBOUND FKs: zero (pg_constraint contype='f', confrelid in the three).
--   · OUTBOUND FKs only: →brokerages, →contacts (credit_conversation_logs,
--     real_estate_events); ai_prompt_templates has none — it never even got a
--     tenant column (it is absent from migration 030's 44-table tenant list).
--   · CODE: 0 `.from("<table>")` call sites and 0 bare-token mentions across
--     app/lib/components/services/workflows/hooks/contexts/constants/remotion/
--     tools/types on COMMENT-STRIPPED source (scripts/strip-comments.ts
--     stripComments — a tombstone is not a call site, §2). POSITIVE CONTROLS on
--     the same run: content_ideas 7 call sites, contacts 969; a synthetic
--     `.from("ai_prompt_templates")` specimen is still seen by the finder.
--   · m413/m414 already took anon/PUBLIC read off ai_prompt_templates as one of
--     the "tables that nothing reads" (0 readers, 0 rows recorded there).
--
-- ── RESTRICT, NOT CASCADE — same ruling as m519 ─────────────────────────────
-- CASCADE would silently drop any dependent this census missed; RESTRICT
-- refuses instead. The sweep says there is nothing to refuse over, so RESTRICT
-- is free when the evidence is right and stops the migration cold when wrong.
--
-- NO EXPLICIT BEGIN/COMMIT: the migration runner wraps this file in a
-- transaction; a nested COMMIT would break the all-or-nothing (per m519).

-- ai_prompt_templates → prompts live in CODE on the gateway rail:
-- lib/ai/models.ts (MODEL_CONFIG + AI_TASK_ROUTING) routes every feature to its
-- model, and each feature's writing prompt lives beside its action. That is a
-- ruling, not an accident: §5 requires compliance-first prompts (fair housing
-- IN the writing prompt), which means prompts change through code review — a
-- runtime-editable, tenantless, UI-less template table is the bypass shape.
-- 6 columns, 0 rows, no admin surface, no reader ever written. Type tombstone:
-- types.ts (AIPromptTemplate, lane CB 2026-08-27).
DROP TABLE IF EXISTS public.ai_prompt_templates RESTRICT;

-- credit_conversation_logs → conversation_logs (+ activities for credit
-- milestones). The general conversation ledger conversation_logs (writer:
-- app/actions/conversation-analytics.ts logConversationMetadata) carries
-- contact_id, brokerage_id, channel, conversation_type and a RICHER sentiment
-- model (sentiment_start/end/journey) than this table's single {log_entry,
-- sentiment}; credit-lane milestones write activities
-- (app/actions/credit-copilot.ts:657) and contacts.credit_pipeline_stage.
-- The credit lane itself already ruled on this table: its own rebuild script
-- (scripts/060-enhance-credit-copilot-ai-sidekick.sql:7) DROPs it CASCADE and
-- deliberately does not recreate it — the live copy survived only because the
-- 020 bootstrap is IF NOT EXISTS and ran around it. The lane is covered by
-- test:lender-in-transaction (package.json:245). Type tombstone: types.ts
-- (CreditConversationLog, lane CB 2026-08-27).
DROP TABLE IF EXISTS public.credit_conversation_logs RESTRICT;

-- real_estate_events → open_house_events + open_house_attendees (attendance,
-- via lib/kernel/open-house.ts) and calendar_events (any dated, located,
-- titled event per entity — a superset of this table's {contact_id,
-- event_type, event_title, event_date, location, description}, with the
-- tenancy and status columns this table never grew). It was scaffolding for
-- the deleted Events.tsx; its registration half (EventRegistration) fell in
-- lane CB's tranche with the open-house lane named as survivor. Type
-- tombstone: types.ts (EventRegistration, lane CB 2026-08-27).
DROP TABLE IF EXISTS public.real_estate_events RESTRICT;

-- ── ASSERT THE DROPS LANDED (fail closed, §4) ───────────────────────────────
do $$
declare
  still_here text[];
begin
  select coalesce(array_agg(table_name order by table_name), '{}')
  into   still_here
  from   information_schema.tables
  where  table_schema = 'public'
    and  table_name in ('ai_prompt_templates', 'credit_conversation_logs',
                        'real_estate_events');
  if array_length(still_here, 1) is not null then
    raise exception 'm578: retired tables still present: %', still_here;
  end if;
end $$;

-- INTEGRATOR, after applying: regenerate the schema caches (§3 —
-- schema-snapshot.ts, schema-fk-map.ts, live-tables.ts; no CHECK was touched so
-- check-vocabularies.ts is unaffected), and remove the three names from the
-- hand-kept guard lists that carry them so no retired name sits in a list
-- reading as enforced (§2): scripts/writerless-read-sweep.ts:38
-- (ai_prompt_templates in SEEDED_REFERENCE), scripts/child-tenant-scope-
-- simulator.ts:53 (ai_prompt_templates in ALLOWED), scripts/agent-fk-columns.ts
-- :340/:417 (credit_conversation_logs, real_estate_events).
