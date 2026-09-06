-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m536_…`. It was one of TWENTY files in this directory whose header said
--    it had never run; all twenty were in the ledger. Nobody came back to
--    update the headers after applying them.
--
--    THE EVIDENCE IS ONE-DIRECTIONAL, AND THAT IS STATED RATHER THAN GLOSSED:
--    presence in the ledger PROVES a migration ran. ABSENCE PROVES NOTHING —
--    the ledger only records migrations applied through the migration tool, and
--    m599 and m602–m605 are all applied and all absent from it, because they
--    were executed as direct SQL. So this banner is written only onto files the
--    ledger positively vouches for.
--
--    The original header is preserved below unedited. It is the record of what
--    its author believed when they wrote it, and CLAUDE.md §3 is the reason the
--    belief was wrong: "a migration that exists as a .sql file has not been
--    applied" — which is true, and cuts both ways. A file cannot tell you it
--    ran, and it cannot tell you it did not.
--
--    scripts/migration-claim-guard.ts now holds this class shut.
-- ═════════════════════════════════════════════════════════════════════════════

-- m536 — message_threads IS A SECOND SPELLING OF TWO TABLES THAT ALREADY WORK
--
-- WRITTEN, NOT APPLIED. Lanes write migrations; only the integrator applies
-- them (CLAUDE.md §3).
--
-- ══ THE FINDING ══════════════════════════════════════════════════════════════
--
-- `message_threads` is live in the schema and has NO `.from("message_threads")`
-- anywhere in the tree. Not one reader, not one writer, not one embed. It was
-- already named as the last UNRESOLVED entry in
-- lib/contact-promotion/history-carry.ts:CONVERSION_CARRY_OMISSIONS, where the
-- conversion lane declined to carry rows into "a table nothing queries" and
-- explicitly handed the question to the orphan sweep. This is that answer.
--
-- CLAUDE.md §1 says an unreferenced thing is not automatically dead, and cron
-- routes / webhooks / public endpoints are unreferenced by design. THIS IS NOT
-- ONE OF THOSE. A table is not reachable "from outside": there is no route, no
-- RPC and no view over it. Checked before proposing the drop:
--
--   · no `.from("message_threads")`, no `.rpc(` naming it
--   · it appears in exactly four GENERATED schema caches (live-tables.ts,
--     schema-fk-map.ts, agent-fk-columns.ts, check-vocabularies.ts) and in two
--     m478 RLS table lists — every one of those is a description OF the table,
--     never a use of it
--   · 0 live rows on hrvaqgvukzxfskkcrwbt, 2026-08-23
--   · 0 inbound foreign keys — nothing in the schema is its child, so the drop
--     cannot orphan anything
--
-- ══ THE DOCTRINE BRANCH: (C) DELETE, NAMING WHERE THE FUNCTIONALITY WENT ═════
--
-- Not (A) merge-onto-survivor, because there is nothing on it to merge — the
-- table is empty and every COLUMN it carries is already served, in a table that
-- has real readers and writers. Its ten columns split cleanly across TWO
-- survivors, which is why it never acquired a caller: it was a third spelling
-- of a job two tables were already doing.
--
--   message_threads column   →  SURVIVOR
--   ──────────────────────────────────────────────────────────────────────────
--   id, contact_id           →  conversations.id / .contact_id
--   agent_user_id            →  conversations.agent_id
--                               (NOTE THE IDENTITY CLASS, it is not a rename:
--                               message_threads.agent_user_id references USERS,
--                               conversations.agent_id references AGENTS, and
--                               CLAUDE.md §3 records that agents.id and users.id
--                               are DISJOINT. Crossing is via agents.user_id.
--                               A carry would have had to translate, not copy —
--                               another reason nothing ever wrote this table.)
--   brokerage_id             →  conversations.brokerage_id
--   last_message_at          →  conversations.last_message_at (same name)
--   unread_count             →  conversations.unread_count   (same name)
--   channel                  →  conversations.type, and messages.type per message
--   subject                  →  messages.subject — a subject belongs to a
--                               message in this product; `conversations` has
--                               deliberately never had one
--   created_at               →  conversations.created_at
--   lead_id                  →  isa_outreach_log.lead_id
--
-- THE lead_id COLUMN IS THE ONLY ONE THAT NEEDS AN ARGUMENT, because
-- `conversations` has no lead_id and so cannot absorb it. It does not need to:
-- `isa_outreach_log` is the lead-side outreach ledger and carries `lead_id`,
-- `contact_id` AND `channel` — it is dual-keyed exactly the way a lead→contact
-- lifecycle needs, and it is live and written. So the two halves of what
-- message_threads described are BOTH already built:
--
--     the CONTACT-side thread  →  conversations (48 `.from()` sites) + messages
--     the LEAD-side outreach   →  isa_outreach_log
--
-- Adding `lead_id` to `conversations` was considered and REJECTED. It would put
-- a lead-keyed row on a contact-keyed table that 48 call sites read without a
-- lead predicate, which is how a lead reaches an agent surface that CLAUDE.md
-- §5 says must show CONTACTS only. The lead side already has its table.
--
-- ══ NOTHING IS LOST — VERIFY BEFORE APPLYING ═════════════════════════════════
--
-- The guard below re-counts rows AT APPLY TIME rather than trusting the 0 this
-- file measured on 2026-08-23. A table that gained a writer between writing and
-- applying must not be dropped on the strength of a stale reading.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.message_threads') IS NULL THEN
    RAISE NOTICE 'm536 — message_threads already absent; nothing to do';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.message_threads' INTO n;

  -- FAIL CLOSED (CLAUDE.md §4). If a row exists, something started writing this
  -- table after this migration was reasoned about, and the whole argument above
  -- — "no writer, nothing to carry" — is no longer true. Refuse rather than
  -- destroy the evidence.
  IF n > 0 THEN
    RAISE EXCEPTION
      'm536 ABORTED: message_threads holds % row(s). It held 0 on 2026-08-23 and the '
      'drop was argued on that. A writer appeared; re-do the analysis before dropping.', n;
  END IF;

  -- Also refuse if anything became its child in the meantime — the drop would
  -- either cascade or fail, and neither should happen by surprise.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'public.message_threads'::regclass
  ) THEN
    RAISE EXCEPTION 'm536 ABORTED: message_threads has gained inbound foreign key(s); it is no longer childless.';
  END IF;

  -- RESTRICT, not CASCADE: if anything at all depends on this table, the drop
  -- must fail loudly rather than quietly take the dependant with it.
  EXECUTE 'DROP TABLE public.message_threads RESTRICT';
  RAISE NOTICE 'm536 — message_threads dropped (0 rows, 0 readers, 0 writers, 0 inbound FKs)';
END $$;

COMMIT;

-- ══ INTEGRATOR — AFTER APPLYING ══════════════════════════════════════════════
--
--   1. REGENERATE the four schema caches; they are generated, never hand-edited
--      (CLAUDE.md §3). Each generator's header carries its exact SQL:
--        scripts/live-tables.ts · scripts/schema-fk-map.ts
--        scripts/agent-fk-columns.ts · scripts/check-vocabularies.ts
--      All four currently name `message_threads`; none of them USES it.
--
--   2. REMOVE the `message_threads` key from
--      lib/contact-promotion/history-carry.ts:CONVERSION_CARRY_OMISSIONS.
--      It is left in place until then ON PURPOSE: that map is consumed by
--      scripts/orphaned-child-census.ts:280 and
--      scripts/auto-conversion-history-carry-simulator.ts:272, both of which
--      require every LIVE dual-keyed table to be either carried or omitted with
--      a reason. Deleting the entry while the table is still live would fail
--      both. Its text has been updated to record this verdict instead.
--
--   3. m478's two RLS table lists name `message_threads` inside a literal array
--      of table names. They are historical migrations and must not be edited;
--      a dropped table simply drops out of the policy loop.
