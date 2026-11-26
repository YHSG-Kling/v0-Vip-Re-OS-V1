-- APPLIED LIVE 2026-11-25 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) (wave 156, lane 156O) — applied by the integrator (additive: one nullable column + a shape CHECK on each of two tables).
--
-- m1066 — AN ACCEPTANCE RECORD CARRIES THE SHA-256 OF THE TEXT THAT WAS ACCEPTED (directive 156O blocker 7: "Version/hash/
-- timestamp acceptance when active"). Before this, platform_tos_acceptances and privacy_acceptances stored a version and a time
-- but no content hash, so nobody could later prove WHICH text a subscriber accepted.
--
-- Live definitions read 2026-11-25 (project hrvaqgvukzxfskkcrwbt, catalog only): platform_tos_acceptances (id, email, tos_version,
-- accepted_at, ip_address, user_agent; UNIQUE (email, tos_version)); privacy_acceptances (id, user_id, contact_id, brokerage_id,
-- policy_type, policy_version, accepted_at, accepted_ip, accepted_ua, acceptance_text; CHECK user_id or contact_id; policy_type
-- CHECK). Both hold 0 rows. Neither has a trigger or an rpc writing it.
--
-- WRITER: app/actions/public/tos-acceptance.ts (recordTosAcceptanceAction, acceptCurrentTosAsCurrentUserAction) computes the
-- hash SERVER-SIDE from the canonical served text (lib/branding/platform-rights-notice.ts servedTermsDocument), never from the
-- browser. Before this column exists the writer's insert is refused with PGRST204 / 42703; it re-writes the row without the
-- column (the acceptance is never lost) and the hash rides the platform evidence row (superadmin_audit_log details) instead.
-- privacy_acceptances has NO writer in app/, lib/ or the database today (writerless, measured 2026-11-25); its column is added
-- so the writer that is eventually built records the hash from its first row — the column is not "used" until then.
--
-- Tenant column / row security: no table is created and no policy changes. platform_tos_acceptances is the platform's pre-account
-- record (no tenant column by design); privacy_acceptances keeps its brokerage_id and its existing policies.
-- Rollback: ALTER TABLE … DROP CONSTRAINT … ; ALTER TABLE … DROP COLUMN content_sha256 (owner SQL — destructive).

ALTER TABLE public.platform_tos_acceptances ADD COLUMN IF NOT EXISTS content_sha256 text;
ALTER TABLE public.platform_tos_acceptances DROP CONSTRAINT IF EXISTS platform_tos_acceptances_content_sha256_check;
ALTER TABLE public.platform_tos_acceptances ADD CONSTRAINT platform_tos_acceptances_content_sha256_check
  CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE public.privacy_acceptances ADD COLUMN IF NOT EXISTS content_sha256 text;
ALTER TABLE public.privacy_acceptances DROP CONSTRAINT IF EXISTS privacy_acceptances_content_sha256_check;
ALTER TABLE public.privacy_acceptances ADD CONSTRAINT privacy_acceptances_content_sha256_check
  CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.platform_tos_acceptances.content_sha256 IS
  'Wave 156O: sha256 (lowercase hex) of the canonical terms document served for tos_version at acceptance, computed server-side (lib/branding/platform-rights-notice.ts servedTermsDocument). NULL = recorded before m1066.';
COMMENT ON COLUMN public.privacy_acceptances.content_sha256 IS
  'Wave 156O: sha256 (lowercase hex) of the exact policy text accepted, computed server-side. No writer exists yet (measured 2026-11-25).';
