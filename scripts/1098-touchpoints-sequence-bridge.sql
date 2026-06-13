-- 1098: Shared touch ledger bridge — let the canonical System A sequence engine record its
-- sends in marketing_campaign_touchpoints, the SAME ledger de-confliction / attribution /
-- team-query already read. Today only System B (marketing triggers) writes touchpoints, so the
-- canonical drip engine's sends are invisible to the over-messaging frequency cap. A sequence
-- send has no marketing_campaign — it carries sequence_id instead.
--
-- Additive + backward compatible (campaign-origin rows unchanged). Applied to an EMPTY table
-- (0 rows in production — pre-launch) so there is zero data risk.
-- Applied live via Supabase MCP migration `widen_marketing_touchpoints_for_sequence_sends`.

ALTER TABLE marketing_campaign_touchpoints ALTER COLUMN campaign_id DROP NOT NULL;

ALTER TABLE marketing_campaign_touchpoints
  ADD COLUMN IF NOT EXISTS sequence_id uuid REFERENCES campaign_sequences(id) ON DELETE CASCADE;

ALTER TABLE marketing_campaign_touchpoints DROP CONSTRAINT IF EXISTS marketing_campaign_touchpoints_source_check;
ALTER TABLE marketing_campaign_touchpoints ADD CONSTRAINT marketing_campaign_touchpoints_source_check
  CHECK (source = ANY (ARRAY['launch'::text,'trigger'::text,'manual'::text,'retarget'::text,'sequence'::text]));

-- Every touchpoint must originate from a campaign OR a sequence (never orphaned).
ALTER TABLE marketing_campaign_touchpoints DROP CONSTRAINT IF EXISTS marketing_campaign_touchpoints_origin_check;
ALTER TABLE marketing_campaign_touchpoints ADD CONSTRAINT marketing_campaign_touchpoints_origin_check
  CHECK (campaign_id IS NOT NULL OR sequence_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_mct_sequence ON marketing_campaign_touchpoints(sequence_id);
