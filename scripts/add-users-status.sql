-- add-users-status.sql — applied via Supabase migration `add_users_status`.
-- The admin user-management feature (app/actions/admin/update-user.ts + app/admin/users/[userId])
-- reads/writes a users.status (account lifecycle: active/suspended/deactivated). The column did not
-- exist, so the admin select/update silently errored. Distinct from user_type/role (not account
-- state) and deleted_at (hard removal) — no duplication. Backing column added.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
