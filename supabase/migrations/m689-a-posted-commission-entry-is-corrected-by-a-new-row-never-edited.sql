-- ── APPLIED LIVE 2026-10-02 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — function as m689a (apply_migration), trigger via execute_sql (apply_migration timed out twice; nothing was left behind) ──
--
-- m689 — commission_distributions is the commission ENTRIES ledger (one row per recipient per deal:
-- calculated_amount, distribution_type, status pending → approved → paid, voided). A POSTED entry
-- (status 'paid' — the money left at disbursement, lib/commission/payment-tracker.ts markCommissionPaid /
-- markDistributionPaid, lib/commission/reconcile-tracking.ts) is now APPEND-ONLY: a direct UPDATE or
-- DELETE of it is refused, and a correction is a NEW row (owner blueprint, wave 96: "immutable entries,
-- derived balances"; gap map row 16). Entries that are not yet posted stay editable — that is the
-- pending/approved posting lifecycle, not a correction.
--
-- Live read 2026-10-02 (lane 97C): 0 rows; no trigger on the table; no public function updates or deletes
-- it. FKs: commission_id + transaction_id ON DELETE CASCADE, agent_id / team_id / rule_id ON DELETE SET
-- NULL. Those referential actions run INSIDE the parent's RI trigger, so this trigger sees
-- pg_trigger_depth() > 1 for them and lets them through — deleting a deal / agent / tenant keeps working;
-- only a DIRECT statement (depth 1) against a posted entry is refused.
--
-- The one metadata stamp a posted entry may still take: accounting_export_id set ONCE (null → value),
-- every other column unchanged — the export receipt, not the money.
--
-- Code depending on it (same lane): the three posting UPDATEs filter `status not in ('paid','voided')`
-- so no live path hits the refusal (payment-tracker.ts ×2, cda-workflow-client.tsx). Proof:
-- scripts/commission-set-in-stone-simulator.ts (npm run test:commission-set-in-stone).

CREATE OR REPLACE FUNCTION public.commission_distribution_posted_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Referential actions (cascade / set null from a deleted parent) arrive nested in the RI trigger.
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF OLD.status IS DISTINCT FROM 'paid' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.accounting_export_id IS NULL
     AND NEW.accounting_export_id IS NOT NULL
     AND (to_jsonb(NEW) - 'accounting_export_id') = (to_jsonb(OLD) - 'accounting_export_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'commission_distributions % is POSTED (paid) and append-only: % refused — record a correction as a NEW adjustment row', OLD.id, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS commission_distribution_posted_is_append_only ON public.commission_distributions;
CREATE TRIGGER commission_distribution_posted_is_append_only
  BEFORE UPDATE OR DELETE ON public.commission_distributions
  FOR EACH ROW EXECUTE FUNCTION public.commission_distribution_posted_is_append_only();
