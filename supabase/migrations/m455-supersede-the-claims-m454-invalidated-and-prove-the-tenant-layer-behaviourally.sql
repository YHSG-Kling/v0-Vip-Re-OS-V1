-- m455 — asserts m454, and SUPERSEDES two claims m454 made wrong plus one that
-- was a time bomb. Both defects were in MY OWN earlier migrations and were found
-- by an adversarial audit pass, which is the only reason they are being fixed
-- before they fired rather than after.
--
-- ── SUPERSEDED (1): m451 claim 4b and m453 claim 4's prohibited_phrases half ──
--
-- Both raise if the SELECT qual matches the regex
--     (brokerage_id|current_user_brokerage_id|has_brokerage_access)
-- on the reasoning that a tenant predicate on a FEDERAL catalogue means some
-- brokerage stops being scanned. That was right when the table was platform-only.
-- m454 deliberately gave it a tenant layer, so the live qual is now
--     ((brokerage_id IS NULL) OR has_brokerage_access(brokerage_id))
-- which matches that regex TWICE. MEASURED: those claims return true today —
-- they would raise against the very schema they are meant to protect.
--
-- A fresh in-order replay still passes, because m451/m453 run BEFORE m454. That
-- is precisely what makes it dangerous: CI never sees it, and it only bites the
-- person who re-runs an assertion against a live database — which is exactly
-- when someone reaches for one. Superseded here rather than edited in place,
-- because an applied migration is a historical record, not a document.
--
-- ── SUPERSEDED (2): m453 claim 1's `n_missing > 8` ceiling ──────────────────
--
-- It counts rows with a NULL suggested_alternative across the WHOLE table with
-- RLS bypassed. Five federal phrases legitimately have none ("no children",
-- "adults only", "ethnic area", "able-bodied", "kickback" — there is no
-- compliant rewrite, only removal). Tenant-added words will normally have none
-- either, because a brokerage banning its own competitor's name has no
-- alternative to offer.
--
-- MEASURED: 5 NULL today against a ceiling of 8, so the FOURTH tenant word added
-- anywhere on the platform turns m453 red. A guard that fails because the feature
-- is working is worse than no guard: it trains people to ignore it. Re-scoped
-- below to the federal catalogue, which is the only set whose contents this
-- repository controls.

-- ── CLAIM 1 — THE FEDERAL CATALOGUE IS STILL COMPLETE (re-scoped) ───────────
do $$
declare n_fed int; n_alt int; n_missing int; n_crit int;
begin
  select count(*),
         count(*) filter (where suggested_alternative is not null),
         count(*) filter (where suggested_alternative is null),
         count(*) filter (where severity = 'critical')
    into n_fed, n_alt, n_missing, n_crit
  from public.prohibited_phrases
  where is_active and brokerage_id is null;   -- <<< the re-scope

  if n_fed < 25 then
    raise exception 'm455: the federal catalogue holds only % active phrases. m450 seeded 25; a tenant cannot make up the difference because their rows are invisible to every other brokerage.', n_fed;
  end if;
  if n_alt < 15 then
    raise exception 'm455: only % federal phrases carry a suggested alternative (m452 backfilled 20).', n_alt;
  end if;
  if n_missing > 8 then
    raise exception 'm455: % FEDERAL phrases lack a suggested alternative. Only the five with no compliant rewrite should. (Tenant rows are excluded by construction — counting them was m453 claim 1''s defect.)', n_missing;
  end if;
  if n_crit = 0 then
    raise exception 'm455: no federal phrase is severity critical, so nothing in the platform catalogue can fail a scan.';
  end if;
end $$;

-- ── CLAIM 2 — THE FEDERAL LIST REACHES EVERY TENANT (BEHAVIOURAL) ──────────
--
-- The specific way this breaks is subtle and worth pinning by BEHAVIOUR rather
-- than by policy text: has_brokerage_access(NULL) returns FALSE, so a policy
-- written as `has_brokerage_access(brokerage_id)` alone — which reads perfectly
-- reasonable — hides all 25 federal phrases from every tenant and silently
-- reopens the gate m450 closed. Asserting the OR-NULL branch by reading the
-- policy text would just be pinning a spelling; this reads the catalogue as a
-- real tenant instead.
do $$
declare seen_a int; seen_b int;
begin
  if public.has_brokerage_access(null) then
    raise exception 'm455: has_brokerage_access(NULL) is TRUE. The federal branch of the read policy now depends on a function that admits NULL, which would let an unstamped row reach every tenant for reasons nobody intended.';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  select count(*) into seen_a from public.prohibited_phrases where is_active and brokerage_id is null;
  perform set_config('request.jwt.claims', '{"sub":"a011f424-9fe0-4473-af2f-f6d38af046ec","role":"authenticated"}', true);
  select count(*) into seen_b from public.prohibited_phrases where is_active and brokerage_id is null;
  reset role;

  if seen_a < 25 or seen_b < 25 then
    raise exception 'm455: a real tenant reads only % / % federal phrases (two different brokerages). The Fair Housing catalogue must reach every tenant — anything less means some brokerage stops being scanned.', seen_a, seen_b;
  end if;
end $$;

-- ── CLAIM 3 — NO TENANT CAN TOUCH THE FEDERAL LIST (BEHAVIOURAL) ───────────
--
-- Graded on OUTCOME, and the outcome differs by command in a way worth stating:
-- a USING refusal FILTERS (zero rows, error NULL — silent), while a WITH CHECK
-- refusal RAISES (42501). A claim that only watched for an exception would pass
-- while a federal row quietly vanished under DELETE; a claim that only counted
-- rows would miss nothing here but would be fragile. Both are accepted as
-- "blocked" below, and the federal row count is the backstop for either.
do $$
declare fed_before int; fed_after int; escalated int := 0; inserted_null bool := false;
begin
  select count(*) into fed_before from public.prohibited_phrases where brokerage_id is null;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);

  begin
    insert into public.prohibited_phrases (phrase, phrase_pattern, category, severity, brokerage_id)
    values ('m455-probe-federal', 'm455-probe-federal', 'fair_housing', 'critical', null);
    inserted_null := true;
  exception when others then inserted_null := false; end;

  -- USING refusal: filters to zero rows, no error. The count check below is what
  -- actually proves nothing was removed.
  delete from public.prohibited_phrases where brokerage_id is null;

  insert into public.prohibited_phrases (phrase, phrase_pattern, category, severity, brokerage_id)
  values ('m455-probe-own', 'm455-probe-own', 'brand', 'warning', 'b0000000-0000-0000-0000-000000000001');

  -- WITH CHECK refusal: raises 42501. Caught so the migration can report the
  -- verdict rather than dying on the strongest possible outcome.
  begin
    update public.prohibited_phrases set brokerage_id = null where phrase = 'm455-probe-own';
    get diagnostics escalated = row_count;
  exception when insufficient_privilege then escalated := 0; end;

  reset role;

  select count(*) into fed_after from public.prohibited_phrases where brokerage_id is null;
  delete from public.prohibited_phrases where phrase in ('m455-probe-own','m455-probe-federal');

  if inserted_null then
    raise exception 'm455: a brokerage admin INSERTED a brokerage_id NULL row. That publishes their private word list to every tenant and lets them edit the federal catalogue.';
  end if;
  if fed_after <> fed_before then
    raise exception 'm455: the federal catalogue moved from % to % rows under a tenant session. A brokerage that can delete a federal phrase can delete the one that flags its own copy.', fed_before, fed_after;
  end if;
  if escalated > 0 then
    raise exception 'm455: a tenant UPDATEd its own row onto the federal list (% row(s)). WITH CHECK must forbid brokerage_id NULL, not just USING.', escalated;
  end if;
end $$;

-- ── CLAIM 4 — ONE TENANT'S WORDS ARE INVISIBLE TO ANOTHER (BEHAVIOURAL) ────
do $$
declare owner_sees int; other_sees int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  insert into public.prohibited_phrases (phrase, phrase_pattern, category, severity, brokerage_id)
  values ('m455-probe-isolation', 'm455-probe-isolation', 'brand', 'warning', 'b0000000-0000-0000-0000-000000000001');
  select count(*) into owner_sees from public.prohibited_phrases where phrase = 'm455-probe-isolation';

  perform set_config('request.jwt.claims', '{"sub":"a011f424-9fe0-4473-af2f-f6d38af046ec","role":"authenticated"}', true);
  select count(*) into other_sees from public.prohibited_phrases where phrase = 'm455-probe-isolation';

  reset role;
  delete from public.prohibited_phrases where phrase = 'm455-probe-isolation';

  if owner_sees <> 1 then
    raise exception 'm455: a brokerage cannot see its OWN added word (saw %). The settings screen would list nothing back.', owner_sees;
  end if;
  if other_sees <> 0 then
    raise exception 'm455: brokerage B can see brokerage A''s private prohibited word. A word list names competitors and disputes — it is not shareable.';
  end if;
end $$;

-- ── CLAIM 5 — THE SEVERITY VOCABULARY BINDS TENANT ROWS TOO ────────────────
--
-- Deliberately NOT re-scoped to federal. m453 claim 2 checked the whole table and
-- that is right here: the CHECK is what stops a settings screen writing
-- 'blocking' (the seeder's spelling, and a 23514), and the reader maps only
-- 'critical' onto a blocking grade. A tenant row with an off-vocabulary severity
-- would be scanned and then silently fail to stop anything.
do $$
declare bad text; residue int;
begin
  select string_agg(distinct severity, ', ') into bad
  from public.prohibited_phrases
  where severity not in ('info', 'warning', 'critical');
  if bad is not null then
    raise exception 'm455: prohibited_phrases holds severity value(s) outside the column vocabulary: %.', bad;
  end if;

  -- Every claim above cleans up after itself; this proves it rather than trusting it.
  select count(*) into residue from public.prohibited_phrases where phrase like 'm455-probe%';
  if residue > 0 then
    raise exception 'm455: % probe row(s) survived this migration. An assertion that leaves fixtures behind is a data defect wearing a test.', residue;
  end if;
end $$;

do $$
begin
  raise notice 'm455: federal catalogue complete and reaching every tenant; no tenant can insert, delete or escalate onto it; tenant words stay private to their own brokerage; severity binds every row; zero probe residue.';
end $$;
