-- m1012 — THE THREE CLOSING-CHECK STATUSES GET ONE CHECK EACH (wave 156, lane 156D round 3 — APPLIED LIVE 2026-11-25 via Supabase MCP (project hrvaqgvukzxfskkcrwbt); applied by the integrator).
--
-- m1010 declared ONE CHECK over three columns (transaction_title_escrow_closing_check_statuses: payoff_status, hoa_estoppel_status,
-- recording_status). The generated vocabulary cache (scripts/check-vocabularies.ts) holds single-column CHECKs only, so those three
-- vocabularies were invisible to every vocabulary guard (test:vocabulary-snapshot red). This splits it into three single-column CHECKs
-- with the SAME five values each — no value added, none removed. m1010 is applied and is not edited.
--
-- Live definition read 2026-11-25 (pg_get_constraintdef, project hrvaqgvukzxfskkcrwbt):
--   transaction_title_escrow_closing_check_statuses:
--   CHECK (((payoff_status IS NULL) OR (payoff_status = ANY (ARRAY['not_applicable','needed','requested','received','verified'])))
--      AND ((hoa_estoppel_status IS NULL) OR (hoa_estoppel_status = ANY (ARRAY[...same five...])))
--      AND ((recording_status IS NULL) OR (recording_status = ANY (ARRAY[...same five...]))))
-- The table's three columns hold no non-null value live (rows satisfy either form), so the swap rejects nothing.
--
-- New constraint names: transaction_title_escrow_payoff_status_check, transaction_title_escrow_hoa_estoppel_status_check,
-- transaction_title_escrow_recording_status_check. Idempotent: each is added only if absent; the combined one is dropped if present.
-- The code vocabulary (lib/transactions/closing-parties.ts CLOSING_CHECK_STATUSES) is unchanged. After applying, regenerate
-- scripts/check-vocabularies.ts.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_title_escrow_payoff_status_check') THEN
    ALTER TABLE public.transaction_title_escrow ADD CONSTRAINT transaction_title_escrow_payoff_status_check
      CHECK (payoff_status IS NULL OR payoff_status = ANY (ARRAY['not_applicable','needed','requested','received','verified']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_title_escrow_hoa_estoppel_status_check') THEN
    ALTER TABLE public.transaction_title_escrow ADD CONSTRAINT transaction_title_escrow_hoa_estoppel_status_check
      CHECK (hoa_estoppel_status IS NULL OR hoa_estoppel_status = ANY (ARRAY['not_applicable','needed','requested','received','verified']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_title_escrow_recording_status_check') THEN
    ALTER TABLE public.transaction_title_escrow ADD CONSTRAINT transaction_title_escrow_recording_status_check
      CHECK (recording_status IS NULL OR recording_status = ANY (ARRAY['not_applicable','needed','requested','received','verified']));
  END IF;
  -- the three single-column CHECKs now hold exactly what the combined one held; drop it last
  ALTER TABLE public.transaction_title_escrow DROP CONSTRAINT IF EXISTS transaction_title_escrow_closing_check_statuses;
END $$;

-- READBACK: SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.transaction_title_escrow'::regclass AND contype = 'c' ORDER BY 1;
-- ROLLBACK: re-add the combined CHECK above, then drop the three single-column ones.
