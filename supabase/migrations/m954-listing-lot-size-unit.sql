-- ── APPLIED LIVE 2026-11-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 149, lane 149J ──
--
-- m954 — THE LOT-SIZE UNIT IS RECORDED, never inferred (wave-148 final report §2, lane E: "`listings.lot_size` unit
-- unrecorded (needs a `lot_size_unit` column + form writer, deferred by Z for lack of a migration number)").
--
-- WHAT IS THERE (audited at 08712fef). `listings.lot_size numeric` (m206) carries NO unit. The buyer explanation
-- (lib/buyer-search/explanation-evidence.ts lotFactsFrom, owner ruling 5 / C27 — "the buyer decides the yard and acreage
-- minimum") can therefore read a stored value as acres ONLY when it cannot be square feet, and says "unknown" otherwise.
-- RentCast's market rows carry `lotSizeSquareFeet` (a unit by name), so only in-house rows are ambiguous.
--
-- SURVIVOR KEPT (LAW 1): lot_size stays the one lot-size value; this adds ONLY its unit.
--   lot_size_unit   'square_feet' | 'acres'; NULL = not recorded (unknown — never assumed; existing rows stay NULL)
-- Writer: app/actions/listings-kernel.ts saveListingDraftAction (the allow-listed hand edit — the unit is accepted only
-- with a value it describes, validated against this CHECK's list before the write). Reader (lane 149B — Outside-lane in
-- $S/lane149J-notes.md): lotFactsFrom reads the stated unit before its magnitude rule; search-engine selects it.
--
-- BACKFILL: none — a unit nobody recorded is not invented (§5). Live listings rows at 2026-11-03 with lot_size set: the
-- integrator's VERIFY 2 reports the count, which stays unit-NULL.

ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS lot_size_unit text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listings_lot_size_unit_check') THEN
    ALTER TABLE public.listings
      ADD CONSTRAINT listings_lot_size_unit_check CHECK (lot_size_unit IS NULL OR lot_size_unit IN ('square_feet', 'acres'));
  END IF;
END $$;

COMMENT ON COLUMN public.listings.lot_size_unit IS
  'Unit of listings.lot_size as recorded at the hand edit (square_feet | acres); NULL = not recorded — never inferred (wave 149, lane 149J, m954).';

-- VERIFY 1 (expect 1 row: lot_size_unit, text, YES):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'lot_size_unit';
-- VERIFY 2 (informational — rows whose unit stays unknown):
--   SELECT count(*) FROM public.listings WHERE lot_size IS NOT NULL AND lot_size_unit IS NULL;
-- VERIFY 3 (expect an error 23514 — the CHECK refuses an unknown unit; run inside a transaction and ROLL BACK):
--   BEGIN; UPDATE public.listings SET lot_size_unit = 'hectares' WHERE id = (SELECT id FROM public.listings LIMIT 1); ROLLBACK;
-- After apply: regenerate scripts/schema-snapshot.ts and scripts/check-vocabularies.ts (listings.lot_size_unit).
