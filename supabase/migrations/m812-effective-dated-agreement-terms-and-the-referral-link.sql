-- ── APPLIED LIVE 2026-10-24 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 143, lane 143C; statement by statement where the MCP held a batch ──
--
-- m812 — EFFECTIVE-DATED AGREEMENT TERMS + THE REFERRAL LINK (wave 143, lane 143C).
--
-- Owner (2026-10-23): "The SIGNED contracts for teams and agents are kept on record so agreed percentages, fees and
-- residual payouts stay true … Calculations use the agreement applicable to the transaction's period — never today's
-- percentage on a historic deal."  and  "CDA payouts include referrals."
--
-- MEASURED LIVE 2026-10-23 (project hrvaqgvukzxfskkcrwbt, read-only catalog queries):
--   · agent_commission_profiles — UNIQUE (agent_id): ONE mutable row per agent, upserted in place by
--     app/actions/admin/agent-profile.ts. It has an `effective_date` and no history. 1 row.
--   · team_commission_profiles  — UNIQUE (team_id, effective_date), columns team_split_type / team_split_value /
--     referral_* / residual_* / effective_date / is_active. 0 rows, and NO reader and NO writer in code: the
--     effective-dated team store that was built and never connected. THIS MIGRATION CONNECTS IT (BUILD the missing
--     half, CLAUDE.md §1) rather than inventing a second one: it gains the team columns the engine prices on and a
--     writer (a trigger on `teams`).
--   · commission_calculations.engine_inputs (jsonb) — existed with no engine writer; stage 11 writes it from now on
--     (no schema change needed).
--   · referrals has NO link to the deal that consumed it, so one referral could pay on two closings.
--
-- WHAT THIS ADDS
--   1. public.agent_commission_profile_versions — the append-only history of an agent's terms. One row per
--      (agent_id, effective_from): `terms` is the profile row minus its identity columns (split_percent, caps, the five
--      fee schedules, royalty / referral / residual, team_override_percent, structure_type, is_active). Written ONLY by
--      the trigger below, so every writer of agent_commission_profiles (agent-profile.ts, users.ts, provisioning, the
--      SQL editor) is covered with no app change. Read by lib/commission/agreement-terms.ts loadAgentAgreementAsOf.
--   2. trigger record_agent_commission_profile_version on agent_commission_profiles (AFTER INSERT OR UPDATE).
--      effective_from: a brand-new profile -> its effective_date (default CURRENT_DATE); an edit that RE-DATES the
--      profile (effective_date changed to a non-null value) -> that date (a forward-dated or back-dated amendment);
--      any other edit of the terms -> today (UTC date): the change governs deals from today, never earlier ones.
--      Two edits landing on the same effective_from: the later one is the agreement (its predecessor never governed a
--      deal that closed after it was replaced). A save that changes nothing writes nothing.
--   3. team_commission_profiles gains cap_amount, team_fees_json, member_overrides_json, recorded_at, and the trigger
--      record_team_commission_profile_version on `teams` (AFTER INSERT OR UPDATE OF the term columns) upserts the
--      version on (team_id, effective_date) — terms_effective_date when it was changed, else today.
--   4. referrals.transaction_id — the deal a referral's fee was booked against (compare-and-swap by stage 11), so a
--      referral can never pay on two closings. FK transactions(id) ON DELETE SET NULL.
--   5. Backfill: one version per existing profile (source 'backfill' semantics: effective_from = its effective_date,
--      else 1900-01-01 = "from the start") and one team version per existing team.
--
-- HONEST LIMITS (said, not hidden): history starts at the backfill. A deal that closed before the first recorded
-- version resolves to the EARLIEST version (the best knowledge of what applied before history began) and the engine
-- says so in commission_calculations.engine_inputs. The trigger dates a change by the UTC calendar day.
--
-- SCHEMA CACHES TO REGENERATE AFTER APPLY (scripts/generate-*.ts, never hand-edit): schema-snapshot.ts
-- (new table agent_commission_profile_versions; team_commission_profiles now queried; referrals.transaction_id;
-- team_commission_profiles.cap_amount/team_fees_json/member_overrides_json/recorded_at), schema-fk-map.ts,
-- agent-fk-columns.ts, live-tables.ts. No CHECK is added here, so check-vocabularies.ts is unchanged.

-- ── PART 1 — the agent history table ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_commission_profile_versions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id       uuid        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  effective_from date        NOT NULL,
  terms          jsonb       NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_commission_profile_versions_agent_from_key UNIQUE (agent_id, effective_from)
);

COMMENT ON TABLE public.agent_commission_profile_versions IS
  'Append-only history of an agent''s commission terms (the agent_commission_profiles row as it stood from effective_from). Written ONLY by the record_agent_commission_profile_version trigger; read by lib/commission/agreement-terms.ts so a deal is priced on the agreement in force on its date, never today''s (m812, wave 143 lane 143C).';
COMMENT ON COLUMN public.agent_commission_profile_versions.terms IS
  'agent_commission_profiles row minus id / agent_id / brokerage_id / created_at / effective_date — keyed by the profile column names (lib/commission/agreement-terms.ts termsFromProfileRow).';

CREATE INDEX IF NOT EXISTS agent_commission_profile_versions_brokerage_idx
  ON public.agent_commission_profile_versions (brokerage_id, agent_id, effective_from DESC);

ALTER TABLE public.agent_commission_profile_versions ENABLE ROW LEVEL SECURITY;

-- READ: exactly who can read the profile (agent_commission_profiles_tenant_select, measured live). NO write policy: the
-- trigger is SECURITY DEFINER and the commission engine reads through the service role, so an authenticated session can
-- never rewrite history. Contacts, lenders and vendors see no financials (m433): they match neither arm.
DROP POLICY IF EXISTS agent_commission_profile_versions_tenant_select ON public.agent_commission_profile_versions;
CREATE POLICY agent_commission_profile_versions_tenant_select ON public.agent_commission_profile_versions
  FOR SELECT TO authenticated
  USING (public.can_read_tenant_financials() OR (public.has_brokerage_access(brokerage_id) AND public.can_read_agent_books(agent_id)));

-- ── PART 2 — the agent trigger ───────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_agent_commission_profile_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terms jsonb;
  v_from  date;
BEGIN
  IF NEW.brokerage_id IS NULL OR NEW.agent_id IS NULL THEN
    RETURN NEW;   -- a profile with no tenant / agent cannot carry a tenant-scoped version; never block the profile write
  END IF;
  v_terms := to_jsonb(NEW) - 'id' - 'agent_id' - 'brokerage_id' - 'created_at' - 'effective_date';

  IF TG_OP = 'UPDATE' THEN
    -- A save that changes nothing about the terms or their date writes nothing.
    IF (to_jsonb(OLD) - 'id' - 'agent_id' - 'brokerage_id' - 'created_at' - 'effective_date') = v_terms
       AND NEW.effective_date IS NOT DISTINCT FROM OLD.effective_date THEN
      RETURN NEW;
    END IF;
    IF NEW.effective_date IS NOT NULL AND NEW.effective_date IS DISTINCT FROM OLD.effective_date THEN
      v_from := NEW.effective_date;                       -- an explicit re-dating (forward- or back-dated amendment)
    ELSE
      v_from := (now() AT TIME ZONE 'utc')::date;         -- an in-place edit governs deals from today
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
$$;

DROP TRIGGER IF EXISTS record_agent_commission_profile_version ON public.agent_commission_profiles;
CREATE TRIGGER record_agent_commission_profile_version
  AFTER INSERT OR UPDATE ON public.agent_commission_profiles
  FOR EACH ROW EXECUTE FUNCTION public.record_agent_commission_profile_version();

-- ── PART 3 — the team store (team_commission_profiles) gets its missing columns and its missing writer ────────────
ALTER TABLE public.team_commission_profiles
  ADD COLUMN IF NOT EXISTS cap_amount            numeric,
  ADD COLUMN IF NOT EXISTS team_fees_json        jsonb,
  ADD COLUMN IF NOT EXISTS member_overrides_json jsonb,
  ADD COLUMN IF NOT EXISTS recorded_at           timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.team_commission_profiles.cap_amount IS
  'The team''s cap in force from effective_date (copied from teams.cap_amount by record_team_commission_profile_version; m812).';

CREATE OR REPLACE FUNCTION public.record_team_commission_profile_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from  date;
  v_type  text;
  v_value numeric;
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    RETURN NEW;   -- team_commission_profiles.brokerage_id is NOT NULL: never block the team write over it
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.team_split_type IS NOT DISTINCT FROM OLD.team_split_type
       AND NEW.team_split_percent IS NOT DISTINCT FROM OLD.team_split_percent
       AND NEW.team_split_value IS NOT DISTINCT FROM OLD.team_split_value
       AND NEW.team_fees_json IS NOT DISTINCT FROM OLD.team_fees_json
       AND NEW.member_overrides_json IS NOT DISTINCT FROM OLD.member_overrides_json
       AND NEW.cap_amount IS NOT DISTINCT FROM OLD.cap_amount
       AND NEW.terms_effective_date IS NOT DISTINCT FROM OLD.terms_effective_date THEN
      RETURN NEW;
    END IF;
    IF NEW.terms_effective_date IS NOT NULL AND NEW.terms_effective_date IS DISTINCT FROM OLD.terms_effective_date THEN
      v_from := NEW.terms_effective_date;
    ELSE
      v_from := (now() AT TIME ZONE 'utc')::date;
    END IF;
  ELSE
    v_from := COALESCE(NEW.terms_effective_date, (now() AT TIME ZONE 'utc')::date);
  END IF;

  -- The stage prices a flat team split from team_split_value and a percent split from team_split_percent
  -- (08-team-split.ts resolveTeamLeadAgreement): the version carries the ONE value that applies, with its type.
  v_type  := CASE WHEN NEW.team_split_type = 'flat' THEN 'flat' ELSE 'percent' END;
  v_value := CASE WHEN v_type = 'flat' THEN NEW.team_split_value ELSE NEW.team_split_percent END;

  INSERT INTO public.team_commission_profiles
    (team_id, brokerage_id, team_split_type, team_split_value, effective_date, is_active, cap_amount, team_fees_json, member_overrides_json, recorded_at)
  VALUES
    (NEW.id, NEW.brokerage_id, v_type, v_value, v_from, true, NEW.cap_amount, NEW.team_fees_json, NEW.member_overrides_json, now())
  ON CONFLICT (team_id, effective_date)
  DO UPDATE SET team_split_type = EXCLUDED.team_split_type, team_split_value = EXCLUDED.team_split_value,
                cap_amount = EXCLUDED.cap_amount, team_fees_json = EXCLUDED.team_fees_json,
                member_overrides_json = EXCLUDED.member_overrides_json, is_active = true, recorded_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS record_team_commission_profile_version ON public.teams;
CREATE TRIGGER record_team_commission_profile_version
  AFTER INSERT OR UPDATE OF team_split_type, team_split_percent, team_split_value, team_fees_json, member_overrides_json, cap_amount, terms_effective_date
  ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.record_team_commission_profile_version();

-- ── PART 4 — the referral link ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.referrals.transaction_id IS
  'The closing this referral''s fee was booked against (stage 11 of the commission engine claims it compare-and-swap, WHERE transaction_id IS NULL), so one referral can never pay on two deals (m812, wave 143 lane 143C).';

CREATE INDEX IF NOT EXISTS referrals_transaction_idx ON public.referrals (transaction_id) WHERE transaction_id IS NOT NULL;

-- ── PART 5 — backfill (idempotent) ───────────────────────────────────────────────────────────────────────────────
INSERT INTO public.agent_commission_profile_versions (brokerage_id, agent_id, effective_from, terms)
SELECT p.brokerage_id, p.agent_id, COALESCE(p.effective_date, DATE '1900-01-01'),
       to_jsonb(p) - 'id' - 'agent_id' - 'brokerage_id' - 'created_at' - 'effective_date'
FROM public.agent_commission_profiles p
WHERE p.brokerage_id IS NOT NULL AND p.agent_id IS NOT NULL
ON CONFLICT (agent_id, effective_from) DO NOTHING;

INSERT INTO public.team_commission_profiles
  (team_id, brokerage_id, team_split_type, team_split_value, effective_date, is_active, cap_amount, team_fees_json, member_overrides_json)
SELECT t.id, t.brokerage_id,
       CASE WHEN t.team_split_type = 'flat' THEN 'flat' ELSE 'percent' END,
       CASE WHEN t.team_split_type = 'flat' THEN t.team_split_value ELSE t.team_split_percent END,
       COALESCE(t.terms_effective_date, DATE '1900-01-01'), true, t.cap_amount, t.team_fees_json, t.member_overrides_json
FROM public.teams t
WHERE t.brokerage_id IS NOT NULL AND t.deleted_at IS NULL
ON CONFLICT (team_id, effective_date) DO NOTHING;

-- ── PART 6 — verify (raises, rolling the migration back, if the shape is wrong) ───────────────────────────────────
DO $$
DECLARE
  v_profiles int; v_versions int;
BEGIN
  SELECT count(*) INTO v_profiles FROM public.agent_commission_profiles WHERE brokerage_id IS NOT NULL AND agent_id IS NOT NULL;
  SELECT count(DISTINCT agent_id) INTO v_versions FROM public.agent_commission_profile_versions;
  IF v_versions < v_profiles THEN
    RAISE EXCEPTION 'm812: % agent profiles but only % agents carry a version after the backfill', v_profiles, v_versions;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'record_agent_commission_profile_version' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'm812: the agent profile version trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'record_team_commission_profile_version' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'm812: the team terms version trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'referrals' AND column_name = 'transaction_id') THEN
    RAISE EXCEPTION 'm812: referrals.transaction_id is missing';
  END IF;
END $$;
