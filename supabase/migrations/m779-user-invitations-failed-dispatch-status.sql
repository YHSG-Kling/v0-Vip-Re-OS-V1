-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m779 — user_invitations.status admits 'failed' (wave 141, lane 141B; owner ruling 2026-10-14:
-- "Invitations dispatch immediately after a successful valid creation … NEVER report success when
-- the immediate post-condition already failed. Nobody waits a day/week for an error.")
--
-- WHY. lib/kernel/users.ts inviteTenantMember attempts the auth invite (the email) in the SAME
-- request as the creation and READS its result. When the dispatch is refused, no auth user and no
-- users row exist — and until now no user_invitations row either, so the admin's invitations panel
-- (app/dashboard/admin/users/invitations) showed NOTHING for an invite that never left; the only
-- trace was the error toast of the moment. The dashboard must show the pending / FAILED invite
-- state (ruling), so the ledger row is written with status 'failed' and the row's Resend re-attempts
-- the dispatch through the ONE redispatch semantic (lib/kernel/users.ts redispatchInvitation).
--
-- ONE statement, atomic (wave 108 lesson: DROP CONSTRAINT IF EXISTS + ADD inside one ALTER passes the
-- MCP; a standalone DROP is held for owner confirmation). The constraint name is the one
-- scripts/1058-user-invitations-onboarding-state.sql created inline (Postgres names an unnamed
-- inline CHECK <table>_<column>_check). After applying, regenerate scripts/check-vocabularies.ts
-- (CLAUDE.md §3) so check-vocabulary-guard reads 'failed' from the live cache instead of from this
-- file's queued declaration.
--
-- Code that depends on it (WRITTEN before it is applied — the write is read and the refusal logged,
-- never silent; the evidence row + the routed signal carry the failure regardless):
--   lib/kernel/users.ts recordInviteDispatchFailure / redispatchInvitation
--   app/actions/admin/invitations.ts InvitationRow.status
--   app/dashboard/admin/users/invitations/invitations-table.tsx (the Failed badge + Resend)

ALTER TABLE public.user_invitations
  DROP CONSTRAINT IF EXISTS user_invitations_status_check,
  ADD CONSTRAINT user_invitations_status_check CHECK (status IN ('pending', 'accepted', 'expired', 'revoked', 'failed'));

COMMENT ON COLUMN public.user_invitations.status IS
  'pending | accepted | expired | revoked | failed — failed = the invite email could not be dispatched in the creating request (m779); Resend re-attempts it.';
