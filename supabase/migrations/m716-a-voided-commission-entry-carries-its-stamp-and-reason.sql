-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m716 — a VOIDED commission entry carries its stamp and its reason (wave 105, lane 105E; owner ruling 1,
-- 2026-10-06: "VOID action on the existing commission correction screen … stamps voided_at, REQUIRES
-- voided_reason, preserves the original row … can NEVER change a paid distribution").
--
-- Live read (schema snapshot, wave 104 integrator census): commission_distributions already has
-- voided_at timestamptz and voided_reason text — live columns with NO writer. Wave 105E gives them their
-- writer (lib/kernel/financial.ts voidCommissionDistribution: status 'voided' + voided_at + voided_reason
-- on the SAME row, finance-admin gate, session tenant, withActionLedger FINANCIAL evidence). This
-- migration makes the rule hold at the database too: a row cannot read 'voided' without saying when and
-- why, and the reason is bounded (the code's MAX_VOID_REASON_LENGTH = 500). No voided_by column is
-- added on purpose — the actor rides the agent_action_ledger row (finance.commission_distribution.void),
-- the same way corrected_by was ruled an audit stamp and not a FK ledger child.
--
-- A PAID entry is never voided: m689's trigger refuses any UPDATE of a posted row, and the void UPDATE's
-- own predicate (`status NOT IN ('paid','voided') AND paid_at IS NULL`) never matches one — so this
-- CHECK does not need to (and does not) restate that; it governs the SHAPE of a voided row only.
--
-- Apply in TWO parts: PART 1 adds the constraint NOT VALID (no table scan, no lock held over rows);
-- PART 2 validates it (a scan under SHARE UPDATE EXCLUSIVE — 0 live rows today, so instant, but kept
-- separate so a populated table never blocks writes behind the DDL).
--
-- Code depending on it: none fails without it — the kernel command already refuses an empty / over-long
-- reason before the UPDATE, and stamps all three columns together. The CHECK is the database's half of
-- that rule. After apply: regenerate scripts/check-vocabularies.ts (CLAUDE.md §3) — this CHECK is a
-- shape constraint, not an enum, so the generator should report no vocabulary change for the table.

-- ════ PART 1 — the constraint, NOT VALID ═══════════════════════════════════════════════════════

ALTER TABLE public.commission_distributions
  DROP CONSTRAINT IF EXISTS commission_distributions_voided_shape_check;
ALTER TABLE public.commission_distributions
  ADD CONSTRAINT commission_distributions_voided_shape_check
  CHECK (
    status <> 'voided'
    OR (
      voided_at IS NOT NULL
      AND voided_reason IS NOT NULL
      AND length(btrim(voided_reason)) > 0
      AND length(voided_reason) <= 500
    )
  ) NOT VALID;

COMMENT ON COLUMN public.commission_distributions.voided_at IS
  'When the entry was voided (wave 105E). Stamped with status ''voided'' and voided_reason by lib/kernel/financial.ts voidCommissionDistribution — unpaid entries only; a paid entry is corrected by a reversal/adjustment row (m690), never voided (m689).';
COMMENT ON COLUMN public.commission_distributions.voided_reason IS
  'Why the entry was voided (wave 105E) — required, 1..500 characters (commission_distributions_voided_shape_check). The actor is on agent_action_ledger (action finance.commission_distribution.void).';

-- ════ PART 2 — validate (scans existing rows; separate so it never holds the DDL lock over them) ═══

ALTER TABLE public.commission_distributions
  VALIDATE CONSTRAINT commission_distributions_voided_shape_check;
