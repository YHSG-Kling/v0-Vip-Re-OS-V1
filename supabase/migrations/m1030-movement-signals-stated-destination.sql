-- m1030 — A STATED RELOCATION PLAN CARRIES A STRUCTURED DESTINATION (wave 156, lane 156I round 3 — WRITTEN, NOT APPLIED).
--
-- Directive 156I row 3: a local employer expansion becomes a relocation explainer that reaches consented people whose STATED
-- plans align. The person's own plan is recorded by the PCS / relocation door (lib/relocation/pcs-portal-door.ts) through the
-- canonical movement writer as a movement_signals row (known_deadline_kind 'relocation_start', captured_by 'person'), but the
-- destination they typed lived only inside the free-text quote of that row's evidence — nothing could match it to a market.
-- These three NULLABLE columns hold what the person typed, structured; the door fills them on its own row (tenant-pinned, by
-- id) and the free-text quote stays. Reader: the Campaign Orchestrator's corridor_radar_brief consumer
-- (lib/kernel/manager-signals.ts, foot) — it matches ONLY rows with a stated destination; a person with no stated plan is
-- never matched, and nobody is inferred to be moving.
--
-- Additive only: three nullable columns, one CHECK on a NEW column (two upper-case letters or null), one partial index.
-- No existing row changes; movement_signals keeps its existing row security (m892) — no policy is added or altered.

ALTER TABLE public.movement_signals ADD COLUMN IF NOT EXISTS stated_destination_label text;
ALTER TABLE public.movement_signals ADD COLUMN IF NOT EXISTS stated_destination_city text;
ALTER TABLE public.movement_signals ADD COLUMN IF NOT EXISTS stated_destination_state text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movement_signals_stated_destination_state_check') THEN
    ALTER TABLE public.movement_signals
      ADD CONSTRAINT movement_signals_stated_destination_state_check
      CHECK (stated_destination_state IS NULL OR stated_destination_state ~ '^[A-Z]{2}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS movement_signals_stated_destination_idx
  ON public.movement_signals (brokerage_id, stated_destination_state, stated_destination_city)
  WHERE stated_destination_state IS NOT NULL;

COMMENT ON COLUMN public.movement_signals.stated_destination_label IS 'What the person typed as their destination (city or installation), verbatim, trimmed — wave 156 lane 156I m1030.';
COMMENT ON COLUMN public.movement_signals.stated_destination_city IS 'The destination city the person stated (null when they named only an installation) — wave 156 lane 156I m1030.';
COMMENT ON COLUMN public.movement_signals.stated_destination_state IS 'The two-letter destination state the person stated — wave 156 lane 156I m1030.';
