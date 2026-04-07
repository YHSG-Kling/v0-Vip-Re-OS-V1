CREATE TABLE IF NOT EXISTS public.deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  brokerage_id uuid REFERENCES public.brokerages(id),
  agent_id uuid REFERENCES public.agents(id),
  deposit_type text NOT NULL DEFAULT 'earnest_money'
    CHECK (deposit_type IN ('earnest_money', 'option_fee', 'additional_deposit')),
  amount numeric NOT NULL CHECK (amount > 0),
  received_date date NOT NULL,
  due_date date,
  escrow_company text,
  check_number text,
  wire_number text,
  held_by text,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('pending','received','delivered','disbursed','forfeited','returned')),
  delivered_to_escrow_at timestamptz,
  notes text,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS deposits_transaction_idx ON public.deposits(transaction_id);

CREATE TABLE IF NOT EXISTS public.compliance_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES public.transactions(id),
  agent_id uuid REFERENCES public.agents(id),
  brokerage_id uuid REFERENCES public.brokerages(id),
  task_type text NOT NULL,
  description text NOT NULL,
  due_date timestamptz,
  status text DEFAULT 'pending' CHECK (status IN ('pending','complete','overdue','waived')),
  completed_at timestamptz,
  completed_by uuid REFERENCES public.users(id),
  created_at timestamptz DEFAULT now()
);
