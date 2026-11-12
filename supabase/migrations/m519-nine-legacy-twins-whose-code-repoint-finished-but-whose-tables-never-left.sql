-- m519 — NINE LEGACY TWINS WHOSE CODE REPOINT FINISHED BUT WHOSE TABLES NEVER LEFT
--
-- An earlier wave ("EIGHT LEGACY-TWIN REPOINTS", recorded in prose at
-- scripts/doc-kernel-simulator.ts:2150) moved every reader and writer off these
-- tables onto a named survivor. The CODE half landed. The SCHEMA half never did,
-- so nine retired tables have been sitting live ever since — empty, unreachable,
-- and indistinguishable at a glance from the survivors they were replaced by.
--
-- That is the exact hazard the orphan doctrine exists for. A retired twin with a
-- plausible name is not inert: it is the thing a future lane repoints ONTO by
-- mistake, because `.from("newsletters")` compiles, runs, returns [], and raises
-- nothing. supabase-js resolves rather than throws, so writing to the wrong twin
-- degrades silently — the failure mode this repo has paid for repeatedly.
--
-- ── EVIDENCE GATHERED BEFORE WRITING THIS, ALL AGAINST THE LIVE DATABASE ─────
--   · ROW COUNT is 0 for all nine. Nothing is being destroyed.
--   · INBOUND FOREIGN KEYS: zero. Queried pg_constraint for contype='f' with
--     confrelid in the nine — empty result. Nothing references them.
--   · SURVIVORS EXIST: all nine survivors named below were confirmed present in
--     information_schema.tables. A tombstone naming a survivor that does not
--     exist is worse than no tombstone.
--   · PRODUCTION TABLE ACCESS is zero. Measured at the `.from("<table>")` grain,
--     not by bare string match — a bare grep counts `doc_type:
--     "closing_disclosure"`, the nav tab id `"newsletters"` and the readiness
--     key `"social_accounts"`, none of which is a table reference. The naive
--     count said 4/1/0/0/23/7/0/0/0; the correct grain says 0 across all nine.
--   · POSITIVE CONTROL for that finder (CLAUDE.md §2 — "a broken regex and a
--     clean tree both report zero"): the same expression returns 15 hits for
--     `motivated_seller_signals` and 880 for `contacts`. It can still see.
--   · The only `.from()` matches anywhere are THREE GUARDS ASSERTING NON-USE:
--     scripts/external-signal-lanes-simulator.ts:213 (permit-signals must not
--     write the retired twin), scripts/agent-id-class-guard.ts:216 and :220 (a
--     test fixture string), scripts/doc-kernel-simulator.ts:2159 (the accounting
--     egress must not log to the retired twin). Those guards keep working after
--     this migration — they assert an absence, and the absence becomes total.
--
-- ── RESTRICT, NOT CASCADE — DELIBERATELY ────────────────────────────────────
-- CASCADE would silently drop any dependent object this investigation missed.
-- RESTRICT refuses instead. The FK sweep above says there is nothing to refuse
-- over, so RESTRICT costs nothing when the evidence is right and stops the
-- migration cold when it is wrong. Fail closed (CLAUDE.md §4): a drop that
-- "nobody checked" must not render as "checked and fine".
--
-- ── TOMBSTONES: EVERY DELETION NAMES ITS SURVIVOR (CLAUDE.md §1) ─────────────
-- Deleting to move a number is forbidden. None of these is a count reduction —
-- each names where its capability now lives.

-- NO EXPLICIT BEGIN/COMMIT. The migration runner already wraps this file in a
-- transaction; a nested BEGIN is a warning but a COMMIT would close the OUTER
-- transaction early, so the nine drops would stop being all-or-nothing.

-- lead_motivated_seller_signals → motivated_seller_signals
-- The scorer and both signal producers were repointed; m517 then gave the
-- survivor its contact_id column and the exactly-one CHECK, per the owner's
-- ruling that a motivated-seller source covers leads AND contacts. Tombstone
-- comments already stand at lib/services/lead-management.service.ts:203 and
-- :506, lib/lead-governance/seller-signal-strength.ts:30, and
-- lib/external/permit-signals.ts:18.
DROP TABLE IF EXISTS public.lead_motivated_seller_signals RESTRICT;

-- social_accounts → social_media_accounts
-- The one surviving string `social_accounts` in the tree is a setup-readiness
-- checklist KEY at lib/onboarding/setup-readiness.ts:174, not a table name.
DROP TABLE IF EXISTS public.social_accounts RESTRICT;

-- video_content → video_assets
DROP TABLE IF EXISTS public.video_content RESTRICT;

-- ai_content_outputs → ai_generated_content
DROP TABLE IF EXISTS public.ai_content_outputs RESTRICT;

-- closing_disclosure → transaction_documents, discriminated by doc_type.
-- Every remaining `closing_disclosure` in the tree is that doc_type VALUE
-- (app/actions/lender-portal-actions.ts:80 and :123 among them), never the
-- table. This twin is also where #193/#200 found "any broker can read AND WRITE
-- every brokerage's closing disclosures" — dropping the table retires that
-- surface outright rather than leaving a narrowed policy on an empty twin.
DROP TABLE IF EXISTS public.closing_disclosure RESTRICT;

-- newsletters → newsletter_campaigns
-- The remaining `newsletters` strings are nav ids and route segments
-- (app/config/navigation-config.ts:1027, the marketing-studio tab value), not
-- the table.
DROP TABLE IF EXISTS public.newsletters RESTRICT;

-- earnings_history → agent_monthly_earnings
DROP TABLE IF EXISTS public.earnings_history RESTRICT;

-- brand_asset_library → marketing_assets
DROP TABLE IF EXISTS public.brand_asset_library RESTRICT;

-- quickbooks_sync_log → accounting_sync_log
-- The twin that logged 'in_progress' rows and returned synced:true WITHOUT
-- calling Intuit — the "permanent silent-gap source". lib/finance/
-- accounting-egress.ts is the one egress now and logs to the survivor.
DROP TABLE IF EXISTS public.quickbooks_sync_log RESTRICT;

-- AFTER APPLYING: regenerate the schema caches. They are GENERATED, NEVER
-- HAND-EDITED (CLAUDE.md §3) — scripts/live-tables.ts:392 and
-- scripts/schema-fk-map.ts:406 both still name lead_motivated_seller_signals,
-- and will keep naming all nine until regenerated from live JSON.
