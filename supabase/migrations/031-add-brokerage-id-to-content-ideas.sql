-- Migration 031: add brokerage_id to content_ideas
--
-- Missed in migration 030 because the audit pass keyed off agent_id /
-- contact_id / transaction_id / listing_id / lead_id, and this table only
-- carried created_by. Adding brokerage_id so AI-generated content ideas
-- roll up correctly into the superadmin per-brokerage cost view.
--
-- Applied: 2026-05-18

ALTER TABLE public.content_ideas
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_content_ideas_brokerage ON public.content_ideas(brokerage_id);

ALTER TABLE public.content_ideas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_ideas_tenant ON public.content_ideas;
CREATE POLICY content_ideas_tenant ON public.content_ideas FOR ALL
  USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());
