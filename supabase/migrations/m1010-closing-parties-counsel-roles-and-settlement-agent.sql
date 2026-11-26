-- m1010 — WHO ACTUALLY CLOSES THE DEAL, WHOM EACH LAWYER REPRESENTS, AND WHO OWNS EACH CLOSING DOCUMENT AND TASK
-- (wave 156, lane 156D — APPLIED LIVE 2026-11-25 via Supabase MCP (project hrvaqgvukzxfskkcrwbt); applied by the integrator).
--
-- Owner (2026-11-25, verbatim): "in many states, it is a closing attorney not title."
-- The closing may be run by a closing attorney, a title company, an escrow company or another authorized entity,
-- depending on the jurisdiction and the deal. A lender, a title company and a closing attorney are VENDOR CATEGORIES
-- under the existing vendor seat (CLAUDE.md §4) — this migration adds NO user type, NO new table and NO policy.
--
-- SURVIVORS EXTENDED (nothing parallel — CLAUDE.md §1, LAW 2):
--   · public.transaction_participants — the per-deal roster (role is free text, written by the deal page and the offer
--     bridge). It gains the STRUCTURED closing role, whom the party represents, the vendor seat it is (when it is on the
--     platform), and where its facts came from. A row with no vendor_id is an OFF-PLATFORM party: nobody forges a seat.
--   · public.transaction_title_escrow — the one per-deal settlement record (title + escrow officer, escrow number,
--     appointment, date). It gains WHICH KIND of entity is the settlement agent, WHICH roster row it is, on what basis,
--     the title file number, and the payoff / HOA estoppel / recording checks.
--   · public.transaction_documents / public.transaction_tasks — each gains the roster row RESPONSIBLE for it, so the deal
--     team knows which ACTUAL party owns a required document and the current task.
--
-- REPRESENTATION IS NEVER INFERRED. `represents` is NULL until someone records it; an attorney with represents NULL means
-- "not yet known — ask", never "everyone". The vocabulary has no value meaning "all parties".
--
-- Every column is NULLABLE with no default that asserts a fact; every CHECK admits NULL. Readers written before this
-- migration keep working (they select named columns). Writers: lib/application/transactions.ts (the deal-desk writers,
-- dealDeskWriteContext — the desk first, then the service client). The vocabularies are stated ONCE in code at
-- lib/transactions/closing-parties.ts and must equal the CHECKs below (scripts/wave156-d-closing-parties-guard.ts reads both).
--
-- ROW SECURITY: unchanged. No table is added and no policy is written; the four tables keep their live policies. The new
-- columns are written only through the service client after the deal desk (lib/transactions/role-guard.ts decideDealDesk).
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS; each CHECK is added only if absent.

-- ── 1 · transaction_participants: the structured closing role, representation, seat and fact provenance ───────────────
ALTER TABLE public.transaction_participants
  ADD COLUMN IF NOT EXISTS party_role         text,
  ADD COLUMN IF NOT EXISTS represents         text,
  ADD COLUMN IF NOT EXISTS vendor_id          uuid REFERENCES public.vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fact_source        text,
  ADD COLUMN IF NOT EXISTS fact_confirmed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS fact_confirmed_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fact_evidence      text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_participants_party_role_check') THEN
    ALTER TABLE public.transaction_participants ADD CONSTRAINT transaction_participants_party_role_check
      CHECK (party_role IS NULL OR party_role = ANY (ARRAY['buyer_attorney','seller_attorney','lender_attorney','settlement_attorney','title_company','escrow_company','lender','other_settlement_entity']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_participants_represents_check') THEN
    ALTER TABLE public.transaction_participants ADD CONSTRAINT transaction_participants_represents_check
      CHECK (represents IS NULL OR represents = ANY (ARRAY['buyer','seller','lender','neutral_settlement_agent']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_participants_fact_source_check') THEN
    ALTER TABLE public.transaction_participants ADD CONSTRAINT transaction_participants_fact_source_check
      CHECK (fact_source IS NULL OR fact_source = ANY (ARRAY['vendor_seat','party_confirmed','agent_entered']));
  END IF;
  -- A confirmation names who confirmed it, when, and on what evidence — never a bare flag.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_participants_confirmation_shape') THEN
    ALTER TABLE public.transaction_participants ADD CONSTRAINT transaction_participants_confirmation_shape
      CHECK (fact_source IS DISTINCT FROM 'party_confirmed'
             OR (fact_confirmed_at IS NOT NULL AND fact_confirmed_by IS NOT NULL AND length(btrim(coalesce(fact_evidence, ''))) >= 5));
  END IF;
  -- A side-specific attorney cannot be recorded as representing a different side.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_participants_role_represents_agree') THEN
    ALTER TABLE public.transaction_participants ADD CONSTRAINT transaction_participants_role_represents_agree
      CHECK (represents IS NULL
             OR (party_role IS DISTINCT FROM 'buyer_attorney'  OR represents = 'buyer')
             AND (party_role IS DISTINCT FROM 'seller_attorney' OR represents = 'seller')
             AND (party_role IS DISTINCT FROM 'lender_attorney' OR represents = 'lender'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS transaction_participants_vendor_id_idx ON public.transaction_participants (vendor_id) WHERE vendor_id IS NOT NULL;

-- ── 2 · transaction_title_escrow: the settlement agent and the closing checks ──────────────────────────────────────────
ALTER TABLE public.transaction_title_escrow
  ADD COLUMN IF NOT EXISTS settlement_agent_kind            text,
  ADD COLUMN IF NOT EXISTS settlement_agent_participant_id  uuid REFERENCES public.transaction_participants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS settlement_agent_basis           text,
  ADD COLUMN IF NOT EXISTS title_file_number                text,
  ADD COLUMN IF NOT EXISTS payoff_status                    text,
  ADD COLUMN IF NOT EXISTS hoa_estoppel_status              text,
  ADD COLUMN IF NOT EXISTS recording_status                 text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_title_escrow_settlement_agent_kind_check') THEN
    ALTER TABLE public.transaction_title_escrow ADD CONSTRAINT transaction_title_escrow_settlement_agent_kind_check
      CHECK (settlement_agent_kind IS NULL OR settlement_agent_kind = ANY (ARRAY['attorney','title_company','escrow_company','other_authorized_entity']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_title_escrow_settlement_agent_basis_check') THEN
    ALTER TABLE public.transaction_title_escrow ADD CONSTRAINT transaction_title_escrow_settlement_agent_basis_check
      CHECK (settlement_agent_basis IS NULL OR settlement_agent_basis = ANY (ARRAY['contract_named','party_confirmed','agent_entered']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_title_escrow_closing_check_statuses') THEN
    ALTER TABLE public.transaction_title_escrow ADD CONSTRAINT transaction_title_escrow_closing_check_statuses
      CHECK ((payoff_status IS NULL OR payoff_status = ANY (ARRAY['not_applicable','needed','requested','received','verified']))
         AND (hoa_estoppel_status IS NULL OR hoa_estoppel_status = ANY (ARRAY['not_applicable','needed','requested','received','verified']))
         AND (recording_status IS NULL OR recording_status = ANY (ARRAY['not_applicable','needed','requested','received','verified'])));
  END IF;
END $$;

-- ── 3 · who owns a required document and the current task ─────────────────────────────────────────────────────────────
ALTER TABLE public.transaction_documents
  ADD COLUMN IF NOT EXISTS responsible_participant_id uuid REFERENCES public.transaction_participants(id) ON DELETE SET NULL;
ALTER TABLE public.transaction_tasks
  ADD COLUMN IF NOT EXISTS responsible_participant_id uuid REFERENCES public.transaction_participants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transaction_documents_responsible_participant_idx ON public.transaction_documents (responsible_participant_id) WHERE responsible_participant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transaction_tasks_responsible_participant_idx ON public.transaction_tasks (responsible_participant_id) WHERE responsible_participant_id IS NOT NULL;

-- READBACK (after applying):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname LIKE 'transaction_participants_%' OR conname LIKE 'transaction_title_escrow_%' ORDER BY 1;
--   SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
--    AND column_name IN ('party_role','represents','vendor_id','fact_source','settlement_agent_kind','responsible_participant_id')
--    AND table_name IN ('transaction_participants','transaction_title_escrow','transaction_documents','transaction_tasks');
-- Then regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts and scripts/check-vocabularies.ts (CLAUDE.md §3).
-- ROLLBACK (owner SQL, destructive): ALTER TABLE ... DROP COLUMN ... for each column above (no data is written by this file).
