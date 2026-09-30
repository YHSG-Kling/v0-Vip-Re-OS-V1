-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m681 — two NOT NULL columns that refuse writes the code is RIGHT to make
-- (lane 91D, wave 91 full-platform walkthrough; both measured against the live
-- database with the real functions, not inferred).
--
-- 1. superadmin_audit_log.actor_user_id IS NOT NULL, but three SYSTEM writers
--    legitimately have no user behind them and say so in actor_email:
--      lib/platform/prospect-conversion.ts stampProspectConversion  (actor_email 'system:tenant_creation')
--      lib/platform/prospect-conversion.ts convertProspectToSubscriber (actor_email 'system:prospect_conversion:<channel>')
--      lib/platform/prospect-followup.ts                              (actor_email 'system:prospect_followup')
--    Live, during the walkthrough, the prospect → trial-subscriber conversion's
--    audit insert was refused twice:
--      23502 null value in column "actor_user_id" of relation "superadmin_audit_log" violates not-null constraint
--    and the code only console.warns it — so EVERY self-serve / chat / voice
--    conversion and every prospect follow-up has left no audit row at all.
--    Fix: the column admits NULL exactly when the actor is a named system actor.
--    The CHECK keeps "a person did this" rows honest: no NULL actor without a
--    'system:' actor_email.
--
-- 2. user_invitations.invited_by IS NOT NULL, but its FK to users is
--    ON DELETE SET NULL (pg_constraint.confdeltype = 'n', read live). So a user
--    who ever sent an invitation cannot be deleted — the FK action itself raises
--      23502 null value in column "invited_by" of relation "user_invitations" violates not-null constraint
--    (hit live while removing the walkthrough's broker seat). Offboarding a
--    broker/admin who invited agents is blocked by the schema. The FK's own
--    declared intent (SET NULL: the invitation outlives its inviter) wins; the
--    column becomes nullable. Readers of invited_by were NOT audited for a
--    null inviter in this lane (blind spot published in the lane-91D notes).
--
-- No vocabulary change (neither is a single-column IN-list CHECK), so
-- scripts/check-vocabularies.ts does not need regenerating; the schema snapshot
-- nullability does (scripts/generate-schema-snapshot.ts) once applied.

BEGIN;

ALTER TABLE public.superadmin_audit_log
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE public.superadmin_audit_log
  DROP CONSTRAINT IF EXISTS superadmin_audit_log_system_actor_named;
ALTER TABLE public.superadmin_audit_log
  ADD CONSTRAINT superadmin_audit_log_system_actor_named
  CHECK (actor_user_id IS NOT NULL OR actor_email LIKE 'system:%')
  NOT VALID;
-- NOT VALID: every existing row has a non-null actor_user_id (the column was
-- NOT NULL until this migration), so validation is a formality; it is run
-- separately so the ALTER takes no long lock on a large audit table.
ALTER TABLE public.superadmin_audit_log
  VALIDATE CONSTRAINT superadmin_audit_log_system_actor_named;

ALTER TABLE public.user_invitations
  ALTER COLUMN invited_by DROP NOT NULL;

COMMIT;
