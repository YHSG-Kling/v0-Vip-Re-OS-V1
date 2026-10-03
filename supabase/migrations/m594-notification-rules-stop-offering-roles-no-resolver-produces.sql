-- m594 — notification_rules.recipient_role: two spellings nothing can produce
--        leave the CHECK
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: APPLIED to hrvaqgvukzxfskkcrwbt by the integrator, 2026-09-01, in the
-- same session that wrote it. Verified AFTER applying (bottom of file).
--
-- WHY. The notification engine matches rules against roles the resolver
-- actually produces (lib/kernel/notification-engine.ts) — and no resolver
-- branch has produced 'title_agent' (the role itself was removed by m307) or
-- 'closing_attorney' (its real home is transaction_communications.
-- recipient_role / the CDA upload lane, a different column's vocabulary) for
-- many waves. Wave 21 deleted both options from the rules form
-- (app/components/settings/NotificationRulesForm.tsx, tombstone there); this
-- migration executes the database half the owner asked to follow through:
-- a rule naming either spelling could only ever match nothing, forever.
--
-- MEASURED LIVE before writing (2026-09-01):
--   select recipient_role, count(*) from notification_rules group by 1;
--   → agent:26, TC:14, compliance_officer:2 — ZERO rows carry either retiring
--     value, so no backfill is needed and the narrowed CHECK strands no data.
--
-- 'TC' STAYS: for THIS column the Title-Case spelling is live vocabulary — the
-- resolver pushes role "TC" (notification-engine.ts:253) and 14 rows carry it.
-- The wave-21 correction that recorded this is in the form's tombstone.

BEGIN;

ALTER TABLE public.notification_rules
  DROP CONSTRAINT notification_rules_recipient_role_check;

ALTER TABLE public.notification_rules
  ADD CONSTRAINT notification_rules_recipient_role_check
  CHECK (recipient_role IN ('agent', 'broker', 'admin', 'TC', 'compliance_officer'));

COMMIT;

-- MEASURED AFTER APPLYING (2026-09-01, hrvaqgvukzxfskkcrwbt):
--   notification_rules_recipient_role_check
--   CHECK ((recipient_role = ANY (ARRAY['agent','broker','admin','TC','compliance_officer'])))
