-- Phase 4 audit: ai-financial-management.ts inserts into financial_reports
-- (P&L reports) and budgets (annual budget plans). Both tables missing.

CREATE TABLE IF NOT EXISTS public.financial_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id uuid REFERENCES public.brokerages(id),
  report_type text NOT NULL,
  period_start date,
  period_end date,
  total_income numeric(14,2),
  total_expenses numeric(14,2),
  net_profit numeric(14,2),
  expenses_by_category jsonb,
  deductible_expenses jsonb,
  ai_analysis jsonb,
  generated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_financial_reports_agent ON public.financial_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_financial_reports_period ON public.financial_reports(period_start, period_end);

CREATE TABLE IF NOT EXISTS public.budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id uuid REFERENCES public.brokerages(id),
  year integer NOT NULL,
  income_goal numeric(14,2),
  budget_data jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_agent_year ON public.budgets(agent_id, year);

ALTER TABLE public.financial_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service role manages financial_reports' AND tablename = 'financial_reports') THEN
    CREATE POLICY "Service role manages financial_reports" ON public.financial_reports FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service role manages budgets' AND tablename = 'budgets') THEN
    CREATE POLICY "Service role manages budgets" ON public.budgets FOR ALL USING (true);
  END IF;
END$$;
