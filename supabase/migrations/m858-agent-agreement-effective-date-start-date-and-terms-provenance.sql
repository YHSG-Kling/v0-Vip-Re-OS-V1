-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145C; a DROP TRIGGER / DROP POLICY IF EXISTS of an object that did not yet exist was skipped where the MCP would have held the batch ──
--
-- m858 — THE AGENT'S START DATE AND MONEY STRUCTURE COME FROM THE EXECUTED AGENT AGREEMENT (wave 145, lane 145C).
--
-- Owner rulings (2026-10-27), verbatim:
--   3. "There has to be an agents.start date which comes from the agents agreement and the agreement dictates the money
--       structure."  Source of truth: the executed agent agreement (effective date + amendment history) — never account
--       creation, first login, subscription date or a team-join timestamp unless the agreement says so. The cap anniversary
--       may be defined separately in the agreement (m850 agent_commission_profiles.cap_anniversary_date already holds it).
--   4. "No platform-default percentages when a signed agreement governs … Signed agent and team agreements are versioned and
--       retained; an executed change applies from its effective date."
-- Cross-lane contract C6: agents.start_date (+ agents.start_date_source = the agreement id) is the ONLY start date; nobody
-- else writes it.
--
-- AUDIT FIRST (CLAUDE.md §1) — measured live 2026-10-27, project hrvaqgvukzxfskkcrwbt, read-only catalog queries:
--   · agents: NO start_date column. agents.anniversary_date exists but is the SEAT-PROVISIONING stamp (app/actions/agents.ts
--     writes `new Date()` at seat creation) — exactly the "account creation" ruling 3 rules out. 5 rows, all anniversary_date
--     NULL. It stays what it is (work-anniversary celebrations read it); every MONEY reader prefers start_date from now on
--     (lib/commission/cap-resolver.ts).
--   · contract_signatures (m481): THE signed ledger of the agency contract family — contract_type commission_agreement |
--     independent_contractor | team_agreement (+ sale-contract types), esign_status, fully_signed_at, field_values, form_id,
--     team_id. It records WHEN the paper was signed, never the date the agreement says it TAKES EFFECT, and has no amendment
--     link, so "an executed change applies from its effective date" had nowhere to live. 0 rows live. FKs: agent_id → agents
--     ON DELETE CASCADE, brokerage_id, team_id. No triggers.
--   · agent_commission_profiles (UNIQUE agent_id) + agent_commission_profile_versions (m812, trigger-written, effective_from):
--     the versioned terms history EXISTS — but no version says WHICH executed agreement it came from, and an in-place edit of
--     a profile whose effective_date did not move was dated "today" by the trigger even when the change was an agreement
--     with its own effective date. 1 profile, 1 version live.
--   · Nothing here duplicates a survivor: the effective date and the amendment link EXTEND contract_signatures; the start
--     date is the column contract C6 names; the terms provenance EXTENDS the profile (and therefore every version, because
--     the m812 trigger copies the whole row into `terms`).
--
-- WHAT THIS ADDS
--   1. contract_signatures.effective_date (date) — the date the EXECUTED agreement says it takes effect, recorded by a
--      finance admin from the signed paper (lib/agreements/agent-agreements.ts recordAgreementEffectiveDate). Settable only on
--      a fully signed row, and IMMUTABLE once set (an executed change is a NEW row: the amendment, below).
--      + effective_date_recorded_by (FK users, ON DELETE SET NULL) + effective_date_recorded_at.
--   2. contract_signatures.amends_contract_signature_id (FK contract_signatures, NO ACTION) — the amendment history: an
--      executed amendment is its own row of the SAME contract family pointing at the agreement it amends; the original is
--      never edited. CHECK: a row never amends itself; the trigger refuses a cross-agent / cross-family / cross-tenant link.
--   3. agents.start_date (date) + agents.start_date_source (FK contract_signatures, NO ACTION — an agreement that is a
--      start-date source cannot be deleted out from under it). CHECK both-or-neither. BEFORE trigger: the source must be a
--      FULLY SIGNED brokerage-level agent agreement (independent_contractor or commission_agreement — NEVER team_agreement:
--      a team-join is not a start date) of THIS agent in THIS brokerage, whose recorded effective_date IS the start date.
--   4. agent_commission_profiles.agreement_signature_id (FK contract_signatures, NO ACTION) — the executed agreement the
--      current terms were VERIFIED against (ruling 6: AI proposes, a human verifies). BEFORE trigger: a fully signed
--      commission_agreement / independent_contractor row of the same agent + brokerage, with an effective date, and the
--      profile's effective_date MUST equal it — so the m812 version is dated by the AGREEMENT, not by the clock.
--   5. record_agent_commission_profile_version() REPLACED (same body as live, measured above) with one added branch: a profile
--      that names its agreement is versioned FROM THAT AGREEMENT'S EFFECTIVE DATE on every save, never "today".
--
-- NOT A DROP COLUMN / DROP INDEX. Additive and inert for existing rows (every new column NULL; no row is rewritten).
--
-- AFTER APPLYING (CLAUDE.md §3 — generated caches, never hand-edited): regenerate scripts/schema-snapshot.ts (agents +2,
-- contract_signatures +4, agent_commission_profiles +1), scripts/schema-fk-map.ts (+5 FKs: agents.start_date_source,
-- contract_signatures.amends_contract_signature_id, contract_signatures.effective_date_recorded_by,
-- agent_commission_profiles.agreement_signature_id → contract_signatures; agent-fk-columns.ts unchanged — no new agents FK).
-- No IN-list CHECK is added, so scripts/check-vocabularies.ts is unchanged. Flip line 1 to the APPLIED LIVE stamp.

-- ══ PART 1 — the agreement's own effective date and its amendment history ═════════════════════════════════════════════
ALTER TABLE public.contract_signatures
  ADD COLUMN IF NOT EXISTS effective_date               date        NULL,
  ADD COLUMN IF NOT EXISTS effective_date_recorded_by   uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS effective_date_recorded_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS amends_contract_signature_id uuid        NULL REFERENCES public.contract_signatures(id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_signatures_amendment_not_self') THEN
    ALTER TABLE public.contract_signatures
      ADD CONSTRAINT contract_signatures_amendment_not_self CHECK (amends_contract_signature_id IS NULL OR amends_contract_signature_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS contract_signatures_amends_idx
  ON public.contract_signatures (amends_contract_signature_id) WHERE amends_contract_signature_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contract_signatures_agent_family_effective_idx
  ON public.contract_signatures (brokerage_id, agent_id, contract_type, effective_date) WHERE esign_status = 'fully_signed';

COMMENT ON COLUMN public.contract_signatures.effective_date IS
  'm858 (wave 145, lane 145C — owner rulings 3/4): the date the EXECUTED agreement says it takes effect, recorded by a finance admin from the signed paper (lib/agreements/agent-agreements.ts). Set only on a fully_signed row; immutable once set — an executed change is a NEW row that amends this one (amends_contract_signature_id).';
COMMENT ON COLUMN public.contract_signatures.amends_contract_signature_id IS
  'm858: the agreement this executed AMENDMENT amends (same agent, same contract family, same brokerage). The original is never edited; the history is the chain.';

CREATE OR REPLACE FUNCTION public.contract_signatures_agreement_dates_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_base public.contract_signatures%ROWTYPE;
BEGIN
  -- the effective date belongs to an EXECUTED agreement only
  IF NEW.effective_date IS NOT NULL AND NEW.esign_status IS DISTINCT FROM 'fully_signed'
     AND (TG_OP = 'INSERT' OR OLD.effective_date IS DISTINCT FROM NEW.effective_date) THEN
    RAISE EXCEPTION 'contract_signatures %: an effective date is recorded only on a fully signed agreement (esign_status is %)', NEW.id, NEW.esign_status
      USING ERRCODE = '23514';
  END IF;
  -- once recorded it never moves: an executed change is an amendment row, never an edit of the signed record
  IF TG_OP = 'UPDATE' AND OLD.effective_date IS NOT NULL AND NEW.effective_date IS DISTINCT FROM OLD.effective_date THEN
    RAISE EXCEPTION 'contract_signatures %: the effective date % is already recorded — an executed change is recorded as an amendment (amends_contract_signature_id), never by editing the signed agreement', NEW.id, OLD.effective_date
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.amends_contract_signature_id IS NOT NULL AND NEW.amends_contract_signature_id IS DISTINCT FROM OLD.amends_contract_signature_id THEN
    RAISE EXCEPTION 'contract_signatures %: the agreement an amendment amends cannot be changed', NEW.id USING ERRCODE = '23514';
  END IF;
  -- an amendment amends an agreement of the same agent, the same family, the same brokerage
  IF NEW.amends_contract_signature_id IS NOT NULL THEN
    SELECT * INTO v_base FROM public.contract_signatures WHERE id = NEW.amends_contract_signature_id;
    IF NOT FOUND OR v_base.agent_id IS DISTINCT FROM NEW.agent_id OR v_base.brokerage_id IS DISTINCT FROM NEW.brokerage_id
       OR v_base.contract_type IS DISTINCT FROM NEW.contract_type THEN
      RAISE EXCEPTION 'contract_signatures %: an amendment must amend an agreement of the same agent, contract family and brokerage', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contract_signatures_agreement_dates_guard ON public.contract_signatures;
CREATE TRIGGER contract_signatures_agreement_dates_guard
  BEFORE INSERT OR UPDATE OF effective_date, amends_contract_signature_id, esign_status ON public.contract_signatures
  FOR EACH ROW EXECUTE FUNCTION public.contract_signatures_agreement_dates_guard();

-- ══ PART 2 — agents.start_date, from the executed agent agreement only (contract C6) ══════════════════════════════════
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS start_date        date NULL,
  ADD COLUMN IF NOT EXISTS start_date_source uuid NULL REFERENCES public.contract_signatures(id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_start_date_has_agreement_source') THEN
    ALTER TABLE public.agents
      ADD CONSTRAINT agents_start_date_has_agreement_source CHECK ((start_date IS NULL) = (start_date_source IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.agents.start_date IS
  'm858 (wave 145, lane 145C — owner ruling 3, contract C6): THE agent''s start date — the effective date of the EXECUTED brokerage-level agent agreement named by start_date_source. Never account creation, first login, subscription or a team join. Written only by lib/agreements/agent-agreements.ts setAgentStartDateFromAgreement; the trigger refuses any value its source does not state.';
COMMENT ON COLUMN public.agents.start_date_source IS
  'm858: the contract_signatures row (independent_contractor or commission_agreement, fully signed, this agent + brokerage) whose effective_date IS agents.start_date.';

CREATE OR REPLACE FUNCTION public.agents_start_date_from_agreement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_src public.contract_signatures%ROWTYPE;
BEGIN
  -- A MOVE TO ANOTHER BROKERAGE (lib/kernel/users.ts assignUserToBrokerage, the transfer rail): the old brokerage's
  -- agreement does not govern at the new one, so the start date it sourced is released in the same statement (the signed
  -- record itself stays on contract_signatures); the new brokerage records its own executed agreement. A move that ALSO
  -- names a new source is judged below like any other write.
  IF TG_OP = 'UPDATE' AND NEW.brokerage_id IS DISTINCT FROM OLD.brokerage_id
     AND NEW.start_date_source IS NOT DISTINCT FROM OLD.start_date_source THEN
    NEW.start_date := NULL;
    NEW.start_date_source := NULL;
    RETURN NEW;
  END IF;
  IF NEW.start_date_source IS NULL THEN
    RETURN NEW;   -- the CHECK keeps start_date NULL with it
  END IF;
  SELECT * INTO v_src FROM public.contract_signatures WHERE id = NEW.start_date_source;
  IF NOT FOUND
     OR v_src.agent_id IS DISTINCT FROM NEW.id
     OR v_src.brokerage_id IS DISTINCT FROM NEW.brokerage_id
     OR v_src.contract_type NOT IN ('independent_contractor', 'commission_agreement')
     OR v_src.esign_status IS DISTINCT FROM 'fully_signed'
     OR v_src.effective_date IS NULL
     OR v_src.effective_date IS DISTINCT FROM NEW.start_date THEN
    RAISE EXCEPTION 'agents %: start_date % must be the effective date of a fully signed brokerage-level agent agreement of this agent (independent_contractor / commission_agreement) — source %', NEW.id, NEW.start_date, NEW.start_date_source
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agents_start_date_from_agreement ON public.agents;
CREATE TRIGGER agents_start_date_from_agreement
  BEFORE INSERT OR UPDATE OF start_date, start_date_source, brokerage_id ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.agents_start_date_from_agreement();

-- ══ PART 3 — which executed agreement the current terms were verified against ═════════════════════════════════════════
ALTER TABLE public.agent_commission_profiles
  ADD COLUMN IF NOT EXISTS agreement_signature_id uuid NULL REFERENCES public.contract_signatures(id);

COMMENT ON COLUMN public.agent_commission_profiles.agreement_signature_id IS
  'm858 (wave 145, lane 145C — owner rulings 4/6): the EXECUTED agreement (contract_signatures) a human verified these terms against. When set, effective_date equals that agreement''s effective date and every m812 version of the row is dated by it. NULL = terms not yet verified against an executed agreement (a finding the closing verification names).';

CREATE OR REPLACE FUNCTION public.agent_commission_profiles_agreement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_src public.contract_signatures%ROWTYPE;
BEGIN
  IF NEW.agreement_signature_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_src FROM public.contract_signatures WHERE id = NEW.agreement_signature_id;
  IF NOT FOUND
     OR v_src.agent_id IS DISTINCT FROM NEW.agent_id
     OR v_src.brokerage_id IS DISTINCT FROM NEW.brokerage_id
     OR v_src.contract_type NOT IN ('commission_agreement', 'independent_contractor')
     OR v_src.esign_status IS DISTINCT FROM 'fully_signed'
     OR v_src.effective_date IS NULL
     OR NEW.effective_date IS DISTINCT FROM v_src.effective_date THEN
    RAISE EXCEPTION 'agent_commission_profiles %: terms verified against agreement % must carry that fully signed agreement''s effective date (%) for the same agent and brokerage', NEW.id, NEW.agreement_signature_id, v_src.effective_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_commission_profiles_agreement_guard ON public.agent_commission_profiles;
CREATE TRIGGER agent_commission_profiles_agreement_guard
  BEFORE INSERT OR UPDATE OF agreement_signature_id, effective_date, agent_id, brokerage_id ON public.agent_commission_profiles
  FOR EACH ROW EXECUTE FUNCTION public.agent_commission_profiles_agreement_guard();

-- ══ PART 4 — the m812 version writer: an agreement-verified profile is versioned FROM THE AGREEMENT'S EFFECTIVE DATE ══════
-- Same body as live (pg_get_functiondef, 2026-10-27) plus the one branch marked NEW.
CREATE OR REPLACE FUNCTION public.record_agent_commission_profile_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_terms jsonb;
  v_from  date;
BEGIN
  IF NEW.brokerage_id IS NULL OR NEW.agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_terms := to_jsonb(NEW) - 'id' - 'agent_id' - 'brokerage_id' - 'created_at' - 'effective_date';
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - 'id' - 'agent_id' - 'brokerage_id' - 'created_at' - 'effective_date') = v_terms
       AND NEW.effective_date IS NOT DISTINCT FROM OLD.effective_date THEN
      RETURN NEW;
    END IF;
    IF NEW.agreement_signature_id IS NOT NULL AND NEW.effective_date IS NOT NULL THEN
      v_from := NEW.effective_date;                       -- NEW (m858): the executed agreement's effective date governs
    ELSIF NEW.effective_date IS NOT NULL AND NEW.effective_date IS DISTINCT FROM OLD.effective_date THEN
      v_from := NEW.effective_date;
    ELSE
      v_from := (now() AT TIME ZONE 'utc')::date;
    END IF;
  ELSE
    v_from := COALESCE(NEW.effective_date, DATE '1900-01-01');
  END IF;
  INSERT INTO public.agent_commission_profile_versions (brokerage_id, agent_id, effective_from, terms)
  VALUES (NEW.brokerage_id, NEW.agent_id, v_from, v_terms)
  ON CONFLICT (agent_id, effective_from)
  DO UPDATE SET terms = EXCLUDED.terms, recorded_at = now();
  RETURN NEW;
END;
$function$;

-- ══ POSTCONDITIONS ═════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'start_date_source') THEN
    RAISE EXCEPTION 'm858 postcondition: agents.start_date_source missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contract_signatures' AND column_name = 'amends_contract_signature_id') THEN
    RAISE EXCEPTION 'm858 postcondition: contract_signatures.amends_contract_signature_id missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_commission_profiles' AND column_name = 'agreement_signature_id') THEN
    RAISE EXCEPTION 'm858 postcondition: agent_commission_profiles.agreement_signature_id missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agents_start_date_from_agreement' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'm858 postcondition: the start-date trigger is missing — agents.start_date would be writable without an agreement';
  END IF;
END $$;
