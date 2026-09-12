-- m582 — the DSAR 45-day clock lives in a trigger the repo never recorded.
--
-- RECORD-ONLY, ALREADY LIVE — APPLIED 2026-08-28 hrvaqgvukzxfskkcrwbt (the
-- integrator verified this file's function body byte-equivalent to
-- pg_get_functiondef's live output BEFORE applying, so the apply recorded the
-- migration in the ledger without changing production behavior). Verified via
-- pg_trigger / pg_get_functiondef: trg_set_dsr_due_at and set_dsr_due_at()
-- exist and enforce the statutory clock on every insert. This file brings the
-- DDL into the repository so the source tree carries the truth the database
-- already enforces.
--
-- WHY THIS MATTERED BEYOND HYGIENE. data_subject_requests.due_at is the CCPA/
-- CPRA 45-day deadline. It is READ everywhere the queue renders — the
-- fulfilment queue orders by it (app/actions/privacy/data-subject-requests.ts:225),
-- the portal confirmation quotes it (app/actions/portal-settings.ts:188), the
-- staff notification names it — and WRITTEN by no TypeScript at all, because
-- the writer is this trigger. With the DDL absent from the repo, every static
-- sweep (opposite-missing census category 1b, whose trigger scan reads
-- supabase/migrations) reported the column as "read by code, written by
-- NOBODY": a false accusation against a live compliance control, inviting the
-- next lane to build a second app-side writer of a value the database already
-- computes — a second opinion about a statutory deadline. CLAUDE.md §3 names
-- this exact trap: a column written only by a DB trigger reads as writerless
-- without being writerless.
--
-- The function body is the live one, verbatim: due_at defaults to
-- received_at + 45 days ONLY when the writer did not supply one (a request
-- arriving under a different statute may carry its own deadline), and
-- updated_at is stamped on every write.

-- Spelled body-first ($$ … $$ LANGUAGE plpgsql), the form the census's trigger
-- scan parses (scripts/opposite-missing-census.ts:triggerWrittenColumns) — the
-- point of recording this file is that the scanners can finally see the writer.
CREATE OR REPLACE FUNCTION public.set_dsr_due_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.due_at IS NULL THEN NEW.due_at := NEW.received_at + interval '45 days'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_dsr_due_at ON public.data_subject_requests;
CREATE TRIGGER trg_set_dsr_due_at
  BEFORE INSERT OR UPDATE ON public.data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_dsr_due_at();
