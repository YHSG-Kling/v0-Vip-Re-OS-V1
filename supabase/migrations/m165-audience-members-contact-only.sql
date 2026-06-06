-- m165 — audience_members CORRECTION (Wave 38 compliance fix).
--
-- The Wave 38 c34484c1 commit shipped a LEAD_CAPTURED → FB audience
-- hook. That violates Meta's Custom Audiences policy: recipients must
-- be consented; leads on this platform are explicitly unconsented at
-- capture (lifecycle_state='unconsented'). Audience membership now
-- begins ONLY when a lead becomes a contact AND consent is verified.
--
-- This migration:
--   1. Marks any existing lead_id-only audience_members rows as
--      sync_status='removed' so the runner cron skips them. Doesn't
--      delete — keeps the audit trail of what was incorrectly staged.
--   2. Removes lead_id from the unique constraint so the contact-only
--      path is canonical.

-- 1. Mark pending lead-only rows as removed.
update public.audience_members
   set sync_status = 'removed',
       removed_at  = now()
 where lead_id is not null
   and contact_id is null
   and sync_status = 'pending';

-- 2. Re-shape the unique constraint to (audience_id, contact_id).
--    Contact-id IS the canonical recipient post-conversion. The old
--    constraint allowed (audience_id, NULL, lead_id) tuples; the new
--    one requires contact_id.
alter table public.audience_members
  drop constraint if exists audience_members_audience_id_contact_id_lead_id_key;

create unique index if not exists uq_audience_members_audience_contact
  on public.audience_members (audience_id, contact_id)
  where contact_id is not null;
