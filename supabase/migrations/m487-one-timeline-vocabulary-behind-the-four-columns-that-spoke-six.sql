-- m487-one-timeline-vocabulary-behind-the-four-columns-that-spoke-six.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- "HOW SOON WILL THEY TRANSACT" WAS SPELLED SIX WAYS AND THE DATABASE ACCEPTED
-- ALL SIX, SO EVERY SCORE THAT CLAIMED TO WEIGH IT WEIGHED NOTHING.
--
-- One concept — a person's intent horizon — was written and read as six
-- different vocabularies across FOUR columns, none of which had a CHECK. Every
-- consumer is a string equality test against free text, so a comparison that can
-- never be true does not raise, does not log, and does not show up anywhere: the
-- factor simply contributes 0 forever and the score still looks like a score.
--
-- THE SIX SPELLINGS, each read out of the tree before this was written:
--   1. `immediate | 1-3 months | 3-6 months | 6-12 months`   (SPACES)
--      lib/lead-promotion/initial-scorer.ts:69, lib/lead-governance/multi-factor-scorer.ts:100,
--      lib/agent-orchestration/action-plan-generator.ts:138 — all on `leads.timeline`
--   2. `immediate | 1-3_months | 3-6_months | 6-12_months`   (UNDERSCORES)
--      lib/services/lead-management.service.ts:455, on `lead_intelligence.timeline`
--   3. `0-3_months | 3-6_months | 6-12_months | 12+_months`
--      types/contact.ts:43, lib/domain/types.ts:131, lib/lifecycle/offer-lifecycle.ts:187
--   4. `immediate | 30_days | 60_days | 90_days | 6_months | 12_months | 12_plus_months`
--      constants/crm-standards.ts:55
--   5. `asap | urgent`                       app/actions/copilot.ts:757, on `contacts.timeline`
--   6. `immediate | 1-3months | 3-6months`   (NO SEPARATOR) app/actions/lead-intelligence.ts:1435,
--      and this one was a LIVE GATE: it REFUSED every other spelling onto
--      `unified_lead_profile.estimated_timeline`, including the one the very same
--      file writes into `lead_intelligence.timeline` twenty lines earlier.
--
-- WHICH ONE SURVIVES, AND WHY IT IS NOT A GUESS. Two separate things were tangled
-- together: the BUCKET BOUNDARIES and the SPELLING. Only the spelling was ever in
-- dispute. Boundaries `immediate | 1-3 | 3-6 | 6-12 | 12+` are what five of the
-- six spellings encode, what all the live readers score against, and what BOTH
-- CHECK constraints ever written for these columns encode —
-- scripts/010-create-contacts-schema.sql:21 (contacts.timeline) and
-- scripts/310-create-comprehensive-lead-intelligence-system.sql:14
-- (lead_intelligence.timeline). Collapsing five spellings onto one snake_case
-- rendering of those boundaries changes no bucket and no point value. snake_case
-- because every other vocabulary in this database is snake_case, and because it is
-- the spelling of the only writer/reader pair in the system that already agreed —
-- app/actions/lead-intelligence.ts:1342 writes it, lib/services/lead-management.service.ts:455
-- reads it — so that pair keeps working untouched.
--
-- `researching` is kept because it is not an invention: it is the value every
-- lead_intelligence row is initialised to (app/actions/lead-intelligence.ts:1308)
-- and scripts/310 admitted it. It means "stated no horizon"; NULL still means
-- "never asked".
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DECIDE: spelling #4, the 30/60/90-day
-- granularity in constants/crm-standards.ts. That is not a spelling — it splits
-- `1-3_months` into three buckets and reframes every member from a WINDOW
-- ("between 3 and 6 months") to a DEADLINE ("by 90 days"), which changes what a
-- broker is told and requires new point values in three scoring ladders. It is a
-- product decision and it is left for the owner. The evidence for not adopting it
-- by default: `STANDARD_TIMELINES` and `TIMELINE_LABELS` had ZERO importers
-- anywhere in the tree, no writer has ever produced a 30/60/90 value, and the only
-- rows carrying one are in the demo seed
-- scripts/351-create-demo-contacts-simple.sql.
--
-- FOUR COLUMNS, NOT THREE. `lead_intelligence.timeline` was found during the
-- sweep and belongs to the same concept: it is written by
-- app/actions/lead-intelligence.ts:1342 and scored by
-- lib/services/lead-management.service.ts:455. Leaving it out would have left a
-- fifth spelling alive on the same page of the product.
-- `prospect_context.timeline` is NOT included and was checked: it sits beside
-- `emotion`, `situation`, `pain_point`, `life_context` and `what_helps`
-- (supabase/migrations/059) and is narrative prose, not a bucket.
--
-- WHY `leads.timeline` AND `contacts.timeline` MUST CARRY THE IDENTICAL LIST:
-- promotion copies one straight into the other with no mapping at all —
-- lib/contact-promotion/contact-creator.ts:137 is literally
-- `timeline: data.lead.timeline`. Two different vocabularies either side of a
-- verbatim copy is the defect, not a design.
--
-- ORDER. m486's trap does not apply here and that was verified rather than
-- assumed: `pg_constraint` carries NO check constraint mentioning any of these
-- four columns, so there is no OLD constraint governing a repoint, and there are
-- no non-conforming rows to repoint — leads, lead_intelligence and
-- unified_lead_profile are empty and all 4 contacts rows carry NULL. Both facts
-- are MEASURED in section 1 and ASSERTED in section 2 before any DDL runs, so if
-- this file is ever replayed against a database that has since acquired rows, it
-- fails loudly instead of dropping them on the floor.

begin;

-- ── 1. MEASURED BEFORE ──────────────────────────────────────────────────────
do $$
declare
  v_leads int; v_leads_nn int;
  v_contacts int; v_contacts_nn int;
  v_li int; v_li_nn int;
  v_ulp int; v_ulp_nn int;
  v_existing_checks int;
begin
  select count(*), count(timeline)            into v_leads,    v_leads_nn    from public.leads;
  select count(*), count(timeline)            into v_contacts, v_contacts_nn from public.contacts;
  select count(*), count(timeline)            into v_li,       v_li_nn       from public.lead_intelligence;
  select count(*), count(estimated_timeline)  into v_ulp,      v_ulp_nn      from public.unified_lead_profile;

  select count(*) into v_existing_checks
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
   where n.nspname = 'public' and con.contype = 'c'
     and rel.relname in ('leads','contacts','lead_intelligence','unified_lead_profile')
     and pg_get_constraintdef(con.oid) ilike '%timeline%';

  raise notice 'm487 BEFORE: leads rows=% timeline non-null=%; contacts rows=% non-null=%; lead_intelligence rows=% non-null=%; unified_lead_profile rows=% estimated_timeline non-null=%; pre-existing timeline CHECKs=%',
    v_leads, v_leads_nn, v_contacts, v_contacts_nn, v_li, v_li_nn, v_ulp, v_ulp_nn, v_existing_checks;
end $$;

-- ── 2. NOTHING NON-CONFORMING MAY BE STANDING ───────────────────────────────
-- A CHECK added over rows it would reject fails the whole transaction with a
-- bare 23514 that names no row. This says which column and how many, first.
do $$
declare
  v_bad int;
  v_vocab text[] := array['immediate','1-3_months','3-6_months','6-12_months','12+_months','researching'];
begin
  select (select count(*) from public.leads                where timeline          is not null and not (timeline          = any(v_vocab)))
       + (select count(*) from public.contacts             where timeline          is not null and not (timeline          = any(v_vocab)))
       + (select count(*) from public.lead_intelligence    where timeline          is not null and not (timeline          = any(v_vocab)))
       + (select count(*) from public.unified_lead_profile where estimated_timeline is not null and not (estimated_timeline = any(v_vocab)))
    into v_bad;

  if v_bad <> 0 then
    raise exception 'm487: % row(s) carry a timeline outside the surviving vocabulary. Repoint them BEFORE adding the constraint — do not widen the constraint to fit them.', v_bad;
  end if;
  raise notice 'm487: 0 non-conforming rows across all four columns — safe to constrain';
end $$;

-- ── 3. THE VOCABULARY, BEHIND THE DATABASE ──────────────────────────────────
-- NULL is admitted on all four: "we never asked" is a real state and is distinct
-- from `researching`, which is a stated absence of horizon. Matches the shape
-- this schema already uses for nullable vocabularies (leads_lender_status_check,
-- contacts_lead_temperature_check).
-- `drop … if exists` first, in that order, so a replay is a swap and never an
-- add-over-an-add.
alter table public.leads drop constraint if exists leads_timeline_check;
alter table public.leads add constraint leads_timeline_check
  check (timeline is null or timeline = any (array[
    'immediate','1-3_months','3-6_months','6-12_months','12+_months','researching'
  ]::text[]));

alter table public.contacts drop constraint if exists contacts_timeline_check;
alter table public.contacts add constraint contacts_timeline_check
  check (timeline is null or timeline = any (array[
    'immediate','1-3_months','3-6_months','6-12_months','12+_months','researching'
  ]::text[]));

alter table public.lead_intelligence drop constraint if exists lead_intelligence_timeline_check;
alter table public.lead_intelligence add constraint lead_intelligence_timeline_check
  check (timeline is null or timeline = any (array[
    'immediate','1-3_months','3-6_months','6-12_months','12+_months','researching'
  ]::text[]));

alter table public.unified_lead_profile drop constraint if exists unified_lead_profile_estimated_timeline_check;
alter table public.unified_lead_profile add constraint unified_lead_profile_estimated_timeline_check
  check (estimated_timeline is null or estimated_timeline = any (array[
    'immediate','1-3_months','3-6_months','6-12_months','12+_months','researching'
  ]::text[]));

-- ── 4. POSTCONDITIONS — the claims this file makes, asserted ────────────────
do $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conname in (
       'leads_timeline_check',
       'contacts_timeline_check',
       'lead_intelligence_timeline_check',
       'unified_lead_profile_estimated_timeline_check')
  loop
    v_count := v_count + 1;

    -- 4a. Every surviving member is admitted.
    if r.def not like '%immediate%'
       or r.def not like '%1-3_months%'
       or r.def not like '%3-6_months%'
       or r.def not like '%6-12_months%'
       or r.def not like '%12+_months%'
       or r.def not like '%researching%' then
      raise exception 'm487: % does not admit the full vocabulary: %', r.conname, r.def;
    end if;

    -- 4b. None of the five retired spellings survived into any list.
    if r.def like '%1-3 months%' or r.def like '%3-6 months%' or r.def like '%6-12 months%'
       or r.def like '%1-3months%' or r.def like '%3-6months%'
       or r.def like '%0-3_months%'
       or r.def like '%30_days%' or r.def like '%60_days%' or r.def like '%90_days%'
       or r.def like '%12_plus_months%'
       or r.def like '%asap%' or r.def like '%urgent%' then
      raise exception 'm487: % still admits a retired spelling: %', r.conname, r.def;
    end if;

    -- 4c. NULL stays legal — "never asked" is not a vocabulary violation.
    if r.def not ilike '%is null%' then
      raise exception 'm487: % would reject NULL: %', r.conname, r.def;
    end if;
  end loop;

  if v_count <> 4 then
    raise exception 'm487: expected 4 timeline constraints, found %', v_count;
  end if;
  raise notice 'm487 AFTER: 4 constraints installed, all admitting the same 6 members + NULL, none admitting a retired spelling';
end $$;

-- ── 5. THE WRITES THE PRODUCT MAKES, PROVED TO LAND — AND THE OLD ONES,
--      PROVED TO BE REFUSED ────────────────────────────────────────────────
-- A constraint that merely LOOKS right is what this migration exists to prevent,
-- so the product's own inserts run here against a real tenant and are then
-- removed. The values are chosen to be the ones that COULD NOT WORK before:
-- `1-3_months` on leads (spelling #1 territory — the scorers' second-highest
-- urgency bucket), the same value copied to contacts exactly as
-- contact-promotion/contact-creator.ts:137 copies it, `researching` on
-- lead_intelligence (the value every row is initialised to), and `6-12_months`
-- on unified_lead_profile — a value the old app-code gate at
-- app/actions/lead-intelligence.ts:1435 refused outright.
do $$
declare
  v_brokerage uuid;
  v_lead uuid;
  v_contact uuid;
  v_li uuid;
  v_ulp uuid;
  v_refused boolean := false;
begin
  select id into v_brokerage from public.brokerages order by created_at limit 1;
  if v_brokerage is null then
    raise notice 'm487: no brokerage to probe with — skipping the live write proof';
    return;
  end if;

  -- leads.timeline
  insert into public.leads (brokerage_id, first_name, last_name, email, timeline)
  values (v_brokerage, 'm487', 'Probe', 'm487-probe@example.invalid', '1-3_months')
  returning id into v_lead;
  if v_lead is null then
    raise exception 'm487: leads.timeline = 1-3_months does not land';
  end if;

  -- contacts.timeline — the promotion copy, verbatim, exactly as the product does it.
  insert into public.contacts (brokerage_id, first_name, last_name, email, contact_type, timeline)
  values (v_brokerage, 'm487', 'Probe', 'm487-probe@example.invalid', 'buyer', '1-3_months')
  returning id into v_contact;
  if v_contact is null then
    raise exception 'm487: the promoted contacts.timeline copy does not land';
  end if;

  -- lead_intelligence.timeline
  insert into public.lead_intelligence (lead_id, brokerage_id, timeline)
  values (v_lead, v_brokerage, 'researching')
  returning id into v_li;
  if v_li is null then
    raise exception 'm487: lead_intelligence.timeline = researching does not land';
  end if;

  -- unified_lead_profile.estimated_timeline
  insert into public.unified_lead_profile (brokerage_id, estimated_timeline)
  values (v_brokerage, '6-12_months')
  returning id into v_ulp;
  if v_ulp is null then
    raise exception 'm487: unified_lead_profile.estimated_timeline = 6-12_months does not land';
  end if;

  -- And the half that matters just as much: a retired spelling is now REFUSED.
  -- Without this the constraint could be admitting everything and every assertion
  -- above would still pass.
  begin
    update public.leads set timeline = '1-3 months' where id = v_lead;
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'm487: leads.timeline still accepts the retired spaced spelling';
  end if;

  v_refused := false;
  begin
    update public.contacts set timeline = 'asap' where id = v_contact;
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'm487: contacts.timeline still accepts the retired asap spelling';
  end if;

  v_refused := false;
  begin
    update public.unified_lead_profile set estimated_timeline = '1-3months' where id = v_ulp;
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'm487: unified_lead_profile still accepts the retired no-separator spelling';
  end if;

  delete from public.unified_lead_profile where id = v_ulp;
  delete from public.lead_intelligence    where id = v_li;
  delete from public.contacts             where id = v_contact;
  delete from public.leads                where id = v_lead;

  raise notice 'm487: all four product writes PROVED to land, and the spaced / asap / no-separator spellings PROVED to be refused (probe rows inserted then removed)';
end $$;

commit;
