-- ── APPLIED LIVE 2026-11-12 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 152, lane 152C ──
--
-- qr_codes — the ONE QR registry (lib/marketing/tracked-qr.ts mintTrackedQr is its one writer of new rows) gains the
-- facts the owner's ruling needs and the table could not hold. Owner (verbatim, 2026-11-11): "qr minted bar code has a
-- destination url and each bar code needs is unique and needs tracking, creating one and managing."
--
-- CENSUS (live, read-only, 2026-11-11): qr_codes has id, brokerage_id, agent_id, label, slug (UNIQUE), target_url,
-- purpose, listing_id, scan_count, lead_count, is_active, expires_at, created_at, marketing_campaign_id,
-- destination_type — and 0 rows. Missing, each with its writer and reader:
--   created_by_user_id   — the SESSION user who minted it (users.id; agent_id is agents.id and is null for a broker with
--                          no agents row). Writer: mintTrackedQr (from mintGovernedQr). Reader: the QR board (creator name)
--                          and any ROI reader of qr_codes (provenance: creator · campaign · asset · placement).
--   mint_context         — the mint's provenance: minted_via, label_kind, token_scope (per_design | per_piece), tracking,
--                          channel, source, placement (marketing_asset_qr_links.placement_type vocabulary), mail_layout
--                          (the mail layout library's keys), asset_id, team_id, location_id, purpose_context,
--                          consent_context, print_size_in, idempotency_key, duplicated_from. Shape: QrMintContext
--                          (lib/marketing/qr-contract.ts). Writer: mintTrackedQr. Readers: /api/qr/scan (tracking flag),
--                          the QR board, duplicateQrDesign.
--   destination_history  — APPEND-ONLY destination versions (QrDestinationVersion). Writers: mintTrackedQr (v1) and
--                          editQrDestination (lib/marketing/qr-governance.ts). Readers: the board's Details panel.
--   retired_at, retired_reason — TERMINAL retirement ('retired' | 'revoked_unsafe' — QR_RETIRED_REASONS is the one code
--                          source of this CHECK). Pause stays is_active = false. A retired row is never deleted: a code
--                          printed on mailed pieces is the record of what was mailed. Writer: changeQrLifecycle. Readers:
--                          the scan door, the landing page, the capture door, the board (qrLifecycleState).
-- No new table: the version history is evidence ON the row (the action ledger keeps WHO/WHY per change — Law 5); the
-- tokens and idempotency ride existing machinery (slug UNIQUE; agent_action_ledger.idempotency_key UNIQUE).
--
-- The trigger makes the history evidence-grade (the m986 / m689 pattern): a retired code stays retired, history only
-- grows and never rewrites a version, and a destination change must carry a new version. Every live writer complies:
-- the minter writes target_url once at INSERT (no post-insert patch since wave 152); the board's edit appends a version;
-- the counters (scan_count / lead_count), the reuse backfill (null-only columns) and the brokerage transfer touch
-- neither target_url nor retirement.
--
-- ROLLBACK: DROP TRIGGER qr_codes_guard_history_and_retirement ON public.qr_codes; DROP FUNCTION
-- public.qr_codes_guard_history_and_retirement(); ALTER TABLE public.qr_codes DROP CONSTRAINT qr_codes_retired_reason_check,
-- DROP CONSTRAINT qr_codes_retirement_pair_check, DROP CONSTRAINT qr_codes_retired_never_routes_check, DROP CONSTRAINT
-- qr_codes_destination_history_is_array_check, DROP CONSTRAINT qr_codes_mint_context_is_object_check. Removing the five
-- columns or the index is DROP COLUMN / DROP INDEX — owner SQL. The code degrades without them (isAbsentColumnRefusal):
-- automated mints write the earlier shape, governed mints and destination edits refuse with a tenant-facing sentence.

BEGIN;

ALTER TABLE public.qr_codes
  ADD COLUMN IF NOT EXISTS created_by_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mint_context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS destination_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS retired_at          timestamptz,
  ADD COLUMN IF NOT EXISTS retired_reason      text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qr_codes_retired_reason_check') THEN
    ALTER TABLE public.qr_codes ADD CONSTRAINT qr_codes_retired_reason_check
      CHECK (retired_reason IS NULL OR retired_reason IN ('retired', 'revoked_unsafe'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qr_codes_retirement_pair_check') THEN
    ALTER TABLE public.qr_codes ADD CONSTRAINT qr_codes_retirement_pair_check
      CHECK ((retired_at IS NULL) = (retired_reason IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qr_codes_retired_never_routes_check') THEN
    ALTER TABLE public.qr_codes ADD CONSTRAINT qr_codes_retired_never_routes_check
      CHECK (retired_at IS NULL OR is_active IS NOT TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qr_codes_destination_history_is_array_check') THEN
    ALTER TABLE public.qr_codes ADD CONSTRAINT qr_codes_destination_history_is_array_check
      CHECK (jsonb_typeof(destination_history) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qr_codes_mint_context_is_object_check') THEN
    ALTER TABLE public.qr_codes ADD CONSTRAINT qr_codes_mint_context_is_object_check
      CHECK (jsonb_typeof(mint_context) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_qr_codes_brokerage_creator
  ON public.qr_codes (brokerage_id, created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.qr_codes_guard_history_and_retirement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- 1. Retirement is terminal: a retired / revoked code never routes again and never changes its retirement.
  IF OLD.retired_at IS NOT NULL
     AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at
          OR NEW.retired_reason IS DISTINCT FROM OLD.retired_reason
          OR NEW.is_active IS TRUE) THEN
    RAISE EXCEPTION 'qr_codes %: a retired code stays retired (duplicate it to print a new code)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- 2. Destination history is append-only: every earlier version survives, unchanged.
  IF jsonb_array_length(NEW.destination_history) < jsonb_array_length(OLD.destination_history)
     OR NOT (NEW.destination_history @> OLD.destination_history) THEN
    RAISE EXCEPTION 'qr_codes %: destination history is append-only', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- 3. A destination change carries a new version (printed copies follow it; the old one stays on the record).
  IF NEW.target_url IS DISTINCT FROM OLD.target_url
     AND jsonb_array_length(NEW.destination_history) <= jsonb_array_length(OLD.destination_history) THEN
    RAISE EXCEPTION 'qr_codes %: a destination change must append a version to destination_history', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER qr_codes_guard_history_and_retirement
  BEFORE UPDATE ON public.qr_codes
  FOR EACH ROW EXECUTE FUNCTION public.qr_codes_guard_history_and_retirement();

COMMENT ON COLUMN public.qr_codes.created_by_user_id IS 'wave 152 (152C): the session user (users.id) who minted the code — provenance, never agents.id';
COMMENT ON COLUMN public.qr_codes.mint_context IS 'wave 152 (152C): mint provenance — shape QrMintContext in lib/marketing/qr-contract.ts';
COMMENT ON COLUMN public.qr_codes.destination_history IS 'wave 152 (152C): append-only destination versions (QrDestinationVersion); the trigger refuses a shrink, a rewrite or an unversioned target change';
COMMENT ON COLUMN public.qr_codes.retired_at IS 'wave 152 (152C): terminal retirement time; a retired row is never deleted (it records what was printed and mailed)';
COMMENT ON COLUMN public.qr_codes.retired_reason IS 'wave 152 (152C): retired | revoked_unsafe — QR_RETIRED_REASONS (lib/marketing/qr-contract.ts) is the one code source';

COMMIT;

-- READ-BACK (after apply):
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'qr_codes'
--      AND column_name IN ('created_by_user_id','mint_context','destination_history','retired_at','retired_reason');   -- 5 rows
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.qr_codes'::regclass
--      AND (conname LIKE 'qr_codes_retire%' OR conname IN ('qr_codes_destination_history_is_array_check','qr_codes_mint_context_is_object_check','qr_codes_created_by_user_id_fkey'));   -- 6 rows
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.qr_codes'::regclass AND NOT tgisinternal;               -- qr_codes_guard_history_and_retirement
-- Then regenerate scripts/schema-snapshot.ts, schema-fk-map.ts (qr_codes.created_by_user_id → users) and
-- check-vocabularies.ts (qr_codes.retired_reason), and lower NOT_APPLIED_BASELINE in scripts/migration-claim-guard.ts.
