-- ── APPLIED LIVE 2026-09-29 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m678 — (A) lead_imports.list_cost_usd: what the TENANT paid for a purchased list, so it can
--             flow into tenant-paid spend; (B) global_settings.zapier_api_key retired
--             (wave 89, lane 89E — the two schema halves of wave 88's open items).
--
-- LIVE, READ 2026-09-29 (project hrvaqgvukzxfskkcrwbt, before writing this):
--   · lead_imports columns: id, brokerage_id, agent_id, file_name, file_url, total_rows,
--     created_count, merged_count, skipped_count, failed_count, field_map, error_details,
--     status (CHECK pending|processing|completed|failed), created_at, completed_at.
--     NO cost column. 0 rows live (nothing to backfill).
--   · global_settings.zapier_api_key text NULL — 0 rows in global_settings, 0 non-null keys.
--     Its only reader was the inbound Zapier door deleted in wave 87 (owner: "zapier zaps are
--     only allowed out from this platform, never to the platform"; tombstone in
--     lib/providers/webhook-contract.ts). No runtime code selects it by name (the row type
--     lib/kernel/global-settings.ts::GlobalSettingsRow named it and is corrected in the same
--     patch; scripts/zapier-outbound-only-guard.ts and the sessionless census keep the
--     `.eq("zapier_api_key"` shape only as the POSITIVE CONTROL for the retired lookup).
--
-- (A) WHY A COLUMN AND NOT JSONB. Lane 88B (wave 88, owner ruling "spend should be what the
--     tenant spent for that lead") left ONE tenant-paid part unrepresented: a purchased list
--     (a CSV the brokerage BOUGHT and imported). Owner, wave 89: "you should add any fields
--     necessary if their is a beneficial reason to add." lead_imports has no jsonb settings
--     bag (field_map is the column→field map; error_details is per-row errors), and the
--     figure is summed by reports, so it is a typed, CHECKed numeric — never a negative,
--     never "this list paid us".
--
--     WRITER: app/actions/lead-import/import-actions.ts::createImportRecord (the import page's
--     optional "What did this list cost you?" field). READERS: the same file's
--     processImportRows spreads it per row onto contacts.acquisition_cost through the ONE payer
--     vocabulary (lib/lead-pipeline/source-conversion-learning.ts LEAD_COST_PAYER,
--     purchasedListShare → tenant) via lib/lead-import/list-cost-stamp.ts; listImports and the
--     import-history table show it; every tenant spend report already sums acquisition_cost
--     (tenantPaidLeadSpend), so the list cost reaches source analytics / ROI / the lead page
--     with no second reader.
--
-- (B) The column is DROPPED, not left nullable: a secret column nothing reads is a secret
--     column something can still be written into by a hand `select("*")`/update path, and the
--     config-snapshot forbidden list (lib/platform/config-snapshots.ts) had to keep naming it
--     forever. lib/kernel/global-settings.ts's row type stops declaring it in the same patch.
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (a column added, a column dropped — the
-- generator's SQL is in its header). No CHECK vocabulary change (the CHECK below is numeric,
-- not an enum): scripts/check-vocabularies.ts needs no regen.
--
-- Idempotent: safe to re-run.

-- ── (A) the purchased-list cost ─────────────────────────────────────────────────────────────
ALTER TABLE public.lead_imports
  ADD COLUMN IF NOT EXISTS list_cost_usd numeric(12,2);

ALTER TABLE public.lead_imports DROP CONSTRAINT IF EXISTS lead_imports_list_cost_usd_nonnegative;
ALTER TABLE public.lead_imports
  ADD CONSTRAINT lead_imports_list_cost_usd_nonnegative
  CHECK (list_cost_usd IS NULL OR list_cost_usd >= 0);

COMMENT ON COLUMN public.lead_imports.list_cost_usd IS
  'What the TENANT paid for this purchased list (USD, whole import). Spread per row onto contacts.acquisition_cost at import (tenant-paid part purchasedListShare; lib/lead-pipeline/source-conversion-learning.ts). NULL = not a purchased list / not stated. m678.';

-- ── (B) the retired inbound-Zapier key ──────────────────────────────────────────────────────
ALTER TABLE public.global_settings DROP COLUMN IF EXISTS zapier_api_key;

-- ── POSTCONDITION (asserts the RULE, not a count) ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lead_imports' AND column_name = 'list_cost_usd'
  ) THEN
    RAISE EXCEPTION 'm678: lead_imports.list_cost_usd is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.lead_imports'::regclass AND conname = 'lead_imports_list_cost_usd_nonnegative'
  ) THEN
    RAISE EXCEPTION 'm678: lead_imports_list_cost_usd_nonnegative CHECK is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'global_settings' AND column_name = 'zapier_api_key'
  ) THEN
    RAISE EXCEPTION 'm678: global_settings.zapier_api_key still exists';
  END IF;
END $$;
