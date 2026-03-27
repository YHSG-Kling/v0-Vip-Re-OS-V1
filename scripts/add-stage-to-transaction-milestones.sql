-- Add stage column to transaction_milestones
-- Stage tracks which transaction stage (e.g. UNDER_CONTRACT, INSPECTION, APPRAISAL, CLOSED)
-- a milestone belongs to, enabling stage-based filtering and milestone progression tracking.

ALTER TABLE public.transaction_milestones
  ADD COLUMN IF NOT EXISTS stage text;

-- Index for fast stage-based queries (e.g. "show all milestones for the UNDER_CONTRACT stage")
CREATE INDEX IF NOT EXISTS idx_transaction_milestones_stage
  ON public.transaction_milestones (transaction_id, stage);

-- Back-fill existing milestone rows using milestone_type as a proxy for stage
-- where a recognizable mapping exists; the rest stay NULL and can be patched manually
UPDATE public.transaction_milestones
SET stage = CASE
  WHEN milestone_type IN ('contract_signed', 'earnest_money', 'inspection_ordered') THEN 'UNDER_CONTRACT'
  WHEN milestone_type IN ('inspection_completed', 'repair_request', 'repair_resolution') THEN 'INSPECTION'
  WHEN milestone_type IN ('appraisal_ordered', 'appraisal_completed', 'appraisal_gap') THEN 'APPRAISAL'
  WHEN milestone_type IN ('financing_commitment', 'clear_to_close', 'final_walkthrough') THEN 'FINANCING'
  WHEN milestone_type IN ('closing_scheduled', 'closing_completed', 'keys_delivered') THEN 'CLOSING'
  ELSE NULL
END
WHERE stage IS NULL;
