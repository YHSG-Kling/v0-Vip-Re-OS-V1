-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151K ──
--
-- m986 — CONTRACT TERM VERSIONS ARE IMMUTABLE HISTORY (wave 151, lane 151K).
--
-- Owner (wave 151, binding): "addenda can happen during the transaction". Directive 151K: "Do not overwrite historical contract
-- evidence … preserve the original executed contract, accepted counteroffers, every superseding addendum and effective dates."
--
-- AUDIT FIRST (CLAUDE.md §1): the versioned record EXISTS — public.contract_term_versions (m797, live since 2026-10-24) holds every
-- executed instrument's terms with its document, execution instant and evidence, and lib/offers/governing-terms.ts is its ONE
-- writer (precedence computed at read time, originals never mutated BY THE CODE). What the database did not hold: the promise
-- itself. The service role could UPDATE an executed version's terms or DELETE it, and nothing refused. This migration is the
-- m689 / m696 pattern applied to that table — an executed version's evidence can never be rewritten or removed:
--   · DELETE of any row is refused (history is never removed; a mistaken version is marked `void`, a new state, not an erasure);
--   · UPDATE of an EXECUTED row may change ONLY status executed → void, and may only ADD to `evidence` (the new jsonb must contain
--     the old one) — terms, document_id, executed_at, source, version_no, root_offer_id, offer_id, brokerage_id are frozen;
--   · a PROPOSED row keeps its one legitimate transition: the promotion freeze (governing-terms.ts snapshotExecutedTerms) sets
--     status executed with the executed terms and the transaction — that path is a `proposed` row and is untouched;
--   · a referential action nested in an RI trigger (brokerage ON DELETE CASCADE, document / user ON DELETE SET NULL) is let through
--     (pg_trigger_depth() > 1), so deleting a tenant or a user keeps working.
-- Also: an EXECUTED addendum / amendment must name its executed document — code-enforced since m797 (recordContractTermsVersion
-- refuses otherwise); the CHECK below makes the database hold the same rule.
--
-- PRE-CHECK (read-only — ran 2026-11-09: 0 rows; expect 0):
--   SELECT count(*) FROM public.contract_term_versions WHERE status = 'executed' AND source IN ('addendum','amendment') AND document_id IS NULL;
--
-- Apply in TWO parts (wave 98 rule): PART A (function + CHECK), then PART B (trigger, with lock_timeout). Idempotent.

-- ══════════════════════════════ PART A — the guard function and the document CHECK ══════════════════════════════
CREATE OR REPLACE FUNCTION public.contract_term_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- a referential action from a deleted parent runs nested; let it through
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contract_term_versions is immutable history: a version is never deleted (mark it void instead) — id %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE
  IF OLD.status = 'executed' THEN
    IF NEW.terms IS DISTINCT FROM OLD.terms
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.executed_at IS DISTINCT FROM OLD.executed_at
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.version_no IS DISTINCT FROM OLD.version_no
       OR NEW.root_offer_id IS DISTINCT FROM OLD.root_offer_id
       OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
       OR NEW.brokerage_id IS DISTINCT FROM OLD.brokerage_id
       OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'contract_term_versions is immutable history: an executed version''s terms, document, instant and anchors are never rewritten — id %', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'void' THEN
      RAISE EXCEPTION 'contract_term_versions: an executed version may only become void (never proposed again) — id %', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW.evidence @> OLD.evidence) THEN
      RAISE EXCEPTION 'contract_term_versions: evidence on an executed version may only be added to, never removed — id %', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.contract_term_versions_immutable() IS
  'm986 (wave 151, lane 151K): contract_term_versions is immutable history — no DELETE; an executed version may only become void and only add evidence; terms / document / instant / anchors frozen. Nested RI actions pass.';

-- an EXECUTED addendum / amendment names the executed document it came from (the writer has refused otherwise since m797)
ALTER TABLE public.contract_term_versions
  DROP CONSTRAINT IF EXISTS contract_term_versions_executed_addendum_has_document_check;
ALTER TABLE public.contract_term_versions
  ADD CONSTRAINT contract_term_versions_executed_addendum_has_document_check
  CHECK (status <> 'executed' OR source NOT IN ('addendum', 'amendment') OR document_id IS NOT NULL);

-- ══════════════════════════════ PART B — the trigger (execute_sql with lock_timeout) ══════════════════════════════
DROP TRIGGER IF EXISTS contract_term_versions_immutable_trg ON public.contract_term_versions;
CREATE TRIGGER contract_term_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON public.contract_term_versions
  FOR EACH ROW EXECUTE FUNCTION public.contract_term_versions_immutable();

-- READ-BACK (ran 2026-11-09: trigger contract_term_versions_immutable_trg tgenabled O; the CHECK present):
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.contract_term_versions'::regclass AND tgname = 'contract_term_versions_immutable_trg';
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.contract_term_versions'::regclass AND conname = 'contract_term_versions_executed_addendum_has_document_check';
-- No schema-cache change: no column, FK or CHECK vocabulary is added (the CHECK above carries no new value list).
