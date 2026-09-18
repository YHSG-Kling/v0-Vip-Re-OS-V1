-- m486-a-meter-that-speaks-a-retired-vendors-name-records-nothing.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- AI-CALLING MINUTES WERE NEITHER CAPPED NOR BILLED, AND THE REFUSAL WAS A WARN.
--
-- Ruling #231: AI is platform-covered, and over-quota usage is SERVED AND BILLED
-- as overage per tier. That requires a meter. There was none — not a broken one,
-- an absent one, because every write into it was rejected by the database and the
-- rejection was discarded.
--
-- THE DEFECT, measured before this migration was written:
--   · usage_counters.metric CHECK and plan_limits.metric CHECK both admitted
--     'vapi_minutes' and did NOT admit 'ai_voice_minutes'.
--   · Every code site uses the vendor-neutral name: lib/usage/log-media-usage.ts
--     (the MediaMetric union), lib/usage/check-cap.ts (the cap switch and its
--     label), app/actions/usage-overview.ts (the display map and the metric list).
--   · So each counter write was refused 23514 — and log-media-usage.ts handed the
--     rejection to `.then(() => {}, e => console.warn(...))`, which is why a meter
--     that has never recorded a single minute looked healthy for its whole life.
--   · plan_limits held 4 rows keyed 'vapi_minutes': the per-tier CAPS. They were
--     configured, and unreachable, because the counter they bound could not exist.
--   · usage_counters held ZERO rows for either spelling. Not "few" — none.
--
-- WHY THE NAME IS THE THING THAT CHANGES. VAPI was retired outright: the
-- VOICE_ENGINE branches were collapsed to Twilio-only, the VAPI functions were
-- deleted, and vapi_voice_calls was dropped. m353 carried that retirement through
-- the code and never reached these two constraints, so a dead vendor's name
-- remained the ONLY value the database would accept for a live capability. The
-- repo's standing rule is one vocabulary per function; the surviving vocabulary
-- has to be the vendor-neutral one the product speaks, not the vendor that lost.
--
-- Adding 'ai_voice_minutes' ALONGSIDE 'vapi_minutes' was rejected as a fix: it
-- would leave the 4 configured caps sitting under a key nothing reads, so the
-- meter would start recording and STILL never hit a limit. The caps have to move.
--
-- ORDER MATTERS, and I got it backwards on the first attempt: the live DB
-- rejected it with 23514. DROP the old constraints FIRST. The value being moved
-- TO is the one the OLD constraint forbids, so repointing the rows while it still
-- stands is illegal — it is the old CHECK, not the new one, that governs an
-- UPDATE running before the swap.

begin;

-- ── 1. MEASURED BEFORE ──────────────────────────────────────────────────────
do $$
declare
  v_caps int;
  v_counters int;
begin
  select count(*) into v_caps     from public.plan_limits    where metric = 'vapi_minutes';
  select count(*) into v_counters from public.usage_counters where metric in ('vapi_minutes','ai_voice_minutes');
  raise notice 'm486 BEFORE: plan_limits vapi_minutes=%, usage_counters either-spelling=%', v_caps, v_counters;
end $$;

-- ── 2. DROP BOTH OLD CHECKS (before the repoint — see the note above) ───────
alter table public.usage_counters drop constraint if exists usage_counters_metric_check;
alter table public.plan_limits     drop constraint if exists plan_limits_metric_check;

-- ── 3. MOVE THE CAPS ONTO THE SURVIVING NAME ────────────────────────────────
update public.plan_limits
   set metric = 'ai_voice_minutes'
 where metric = 'vapi_minutes';

update public.usage_counters
   set metric = 'ai_voice_minutes'
 where metric = 'vapi_minutes';

-- ── 4. REBUILD BOTH CHECKS ON THE SURVIVING VOCABULARY ──────────────────────
-- Same 17 values, with the retired vendor's name replaced by the one the product
-- uses. Nothing else in either list changes.
alter table public.usage_counters add constraint usage_counters_metric_check
  check (metric = any (array[
    'llm_calls','video_minutes','active_users','contacts_count','active_transactions',
    'sms_sent','emails_sent','storage_gb','ai_tokens_monthly','live_avatar_minutes',
    'live_avatar_sessions','tts_characters','voice_clones_created','avatars_created',
    'ai_voice_minutes','live_assistant_minutes','live_assistant_sessions'
  ]));

alter table public.plan_limits add constraint plan_limits_metric_check
  check (metric = any (array[
    'llm_calls','video_minutes','active_users','contacts_count','active_transactions',
    'sms_sent','emails_sent','storage_gb','ai_tokens_monthly','live_avatar_minutes',
    'live_avatar_sessions','tts_characters','voice_clones_created','avatars_created',
    'ai_voice_minutes','live_assistant_minutes','live_assistant_sessions'
  ]));

-- ── 5. POSTCONDITIONS — the claims this migration makes, asserted ───────────
do $$
declare
  v_residue int;
  v_moved int;
  v_uc_ok boolean;
  v_pl_ok boolean;
begin
  -- 4a. No row anywhere still carries the retired name.
  select (select count(*) from public.plan_limits    where metric = 'vapi_minutes')
       + (select count(*) from public.usage_counters where metric = 'vapi_minutes')
    into v_residue;
  if v_residue <> 0 then
    raise exception 'm486: % row(s) still carry vapi_minutes', v_residue;
  end if;

  -- 4b. The caps survived the move — they were the point.
  select count(*) into v_moved from public.plan_limits where metric = 'ai_voice_minutes';
  if v_moved < 1 then
    raise exception 'm486: the AI-calling caps did not survive the repoint (found %)', v_moved;
  end if;

  -- 4c. Both constraints now ADMIT the name the code writes and REFUSE the dead one.
  select pg_get_constraintdef(oid) like '%ai_voice_minutes%'
     and pg_get_constraintdef(oid) not like '%vapi_minutes%'
    into v_uc_ok
    from pg_constraint where conname = 'usage_counters_metric_check'
      and conrelid = 'public.usage_counters'::regclass;
  select pg_get_constraintdef(oid) like '%ai_voice_minutes%'
     and pg_get_constraintdef(oid) not like '%vapi_minutes%'
    into v_pl_ok
    from pg_constraint where conname = 'plan_limits_metric_check'
      and conrelid = 'public.plan_limits'::regclass;
  if not coalesce(v_uc_ok, false) or not coalesce(v_pl_ok, false) then
    raise exception 'm486: constraint rebuild did not take (usage_counters=%, plan_limits=%)', v_uc_ok, v_pl_ok;
  end if;

  raise notice 'm486 AFTER: caps on ai_voice_minutes=%, vapi_minutes residue=%', v_moved, v_residue;
end $$;

-- ── 6. THE WRITE THAT COULD NOT LAND, PROVED TO LAND ────────────────────────
-- A constraint that merely LOOKS right is what this migration exists to correct,
-- so the insert the product performs is executed here against a real tenant and
-- then removed. If this fails, the migration fails.
--
-- period_end is NOT NULL and has no default. My first probe omitted it and was
-- refused 23502 — which would have proved the CHECK and nothing about whether a
-- real counter row can exist. The probe has to be the write the product makes.
do $$
declare
  v_brokerage uuid;
  v_id uuid;
  v_start date;
begin
  select id into v_brokerage from public.brokerages order by created_at limit 1;
  if v_brokerage is null then
    raise notice 'm486: no brokerage to probe with — skipping the live write proof';
    return;
  end if;
  v_start := date_trunc('month', now())::date;

  insert into public.usage_counters (brokerage_id, metric, value, period_start, period_end)
  values (v_brokerage, 'ai_voice_minutes', 1, v_start, (v_start + interval '1 month' - interval '1 day')::date)
  returning id into v_id;

  if v_id is null then
    raise exception 'm486: the ai_voice_minutes counter write still does not land';
  end if;

  delete from public.usage_counters where id = v_id;
  raise notice 'm486: ai_voice_minutes counter write PROVED (inserted then removed)';
end $$;

commit;
