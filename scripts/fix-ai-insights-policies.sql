-- Drop the conflicting policies added by create-ai-insights-table.sql.
-- The correct policy is the open ai_insights_all from 403-create-ai-predictions-schema.sql.
-- The brokerage-isolation policy blocks inserts because the user JWT does not carry brokerage_id.

DROP POLICY IF EXISTS ai_insights_brokerage_isolation ON public.ai_insights;
DROP POLICY IF EXISTS ai_insights_service_role ON public.ai_insights;

-- Ensure the correct open policy from 403 is in place
DROP POLICY IF EXISTS "ai_insights_all" ON public.ai_insights;
CREATE POLICY "ai_insights_all" ON public.ai_insights
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
