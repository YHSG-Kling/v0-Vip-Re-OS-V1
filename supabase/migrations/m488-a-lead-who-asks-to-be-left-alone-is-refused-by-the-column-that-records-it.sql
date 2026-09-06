-- m488-a-lead-who-asks-to-be-left-alone-is-refused-by-the-column-that-records-it.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- EVERY LEAD OPT-OUT THIS SYSTEM HAS EVER RECEIVED WAS REFUSED BY POSTGREST AND
-- THE REFUSAL WAS RETURNED AS A FAILURE NOBODY READS.
--
-- THE DEFECT, spelled exactly.
--
-- `app/actions/ai-isa/process-opt-out.ts` is the TCPA suppression writer. It is
-- entity-generic: `const table = entityType === "contact" ? "contacts" : "leads"`,
-- and it builds ONE `updates` object for both. That object ALWAYS carries
--
--     opt_out_reason, opt_out_source            (process-opt-out.ts:100-101)
--
-- and, on the global branch, additionally
--
--     opt_out_channels                          (process-opt-out.ts:117)
--
-- All three columns exist on `contacts`. NONE of them exists on `leads` — verified
-- live against information_schema before this migration was written:
--
--     contacts: call_stop_flag, dnc_status, isa_reengage_allowed, opt_out_channels,
--               opt_out_reason, opt_out_source, opted_out_at
--     leads:    call_stop_flag, dnc_status, opted_out_at
--
-- PostgREST refuses an UPDATE that names a column the table does not have
-- (PGRST204). supabase-js RESOLVES that refusal into `{ error }` rather than
-- throwing. process-opt-out.ts DOES destructure it and returns
-- `{ success: false }` — and its two live callers both discard the result:
--
--     app/api/providers/inbound/route.ts:250  → `.catch(...)` on a promise that
--       never rejects; the returned `{success:false}` is dropped on the floor.
--
-- So the whole update is lost — `dnc_status`, `email_opt_out`, `sms_opt_out`,
-- `phone_opt_out`, `direct_mail_opt_out`, `opted_out_at`, every one of them —
-- because two columns that were only ever meant to be provenance went along for
-- the ride. A LEAD WHO TEXTS "STOP" IS NOT SUPPRESSED. A lead who writes "do not
-- contact me" is not suppressed. The compliance_events audit row still gets
-- written afterwards, so the ledger says the opt-out was honoured while none of
-- the flags that would honour it were ever set.
--
-- SECOND, QUIETER CONSEQUENCE. `lib/kernel/communication-compliance.ts:135`
-- Rule 5 is the ONLY gate in the tree that can block a DIRECT-MAIL send on a
-- recipient's request:
--
--     if (contact.opt_out_channels?.includes(channel)) → hard_block
--
-- `dispatchEmail`/`dispatchSms` feed it the LEAD row when `params.leadId` is set
-- (lib/providers/dispatch.ts:315, 533 — `const table = params.contactId ? "contacts" : "leads"`),
-- so the rule is evaluated against a row that cannot carry the column. For a lead
-- the field is `undefined` forever and the rule can never fire. `direct_mail_opt_out`
-- on `leads` is written by nothing and read by nothing — a suppression column with
-- no path to either end.
--
-- WHY COLUMNS AND NOT A REWRITE. The alternative was to special-case the lead
-- branch in process-opt-out.ts and drop the three fields. That keeps the two
-- entity classes diverging — the contact side would record WHY and WHERE an
-- opt-out came from and the lead side would not, so a lead's opt-out provenance
-- would be lost at exactly the moment it matters (a TCPA complaint is about the
-- message the consumer sent, and `opt_out_reason` is where that message is kept).
-- The types are copied verbatim from `contacts` so the two rows stay one shape
-- and the generic writer stays generic.
--
-- NO CHECK CONSTRAINT IS ADDED OR CHANGED BY THIS MIGRATION. scripts/check-vocabularies.ts
-- is untouched and does not need regenerating.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECOND, INDEPENDENT DEFECT CLOSED HERE: INBOUND LEAD MESSAGES HAD NO
-- IDEMPOTENCY KEY.
--
-- `lead_conversation_history` is the only lead-keyed inbound message table
-- (lead_id NOT NULL, brokerage_id, channel, direction, message_content, metadata,
-- occurred_at). It has exactly one index — `idx_lch_lead (lead_id, occurred_at)`
-- — and no uniqueness of any kind. Provider webhooks retry: Twilio re-POSTs on
-- any non-2xx, SendGrid/Postmark re-deliver, and the voice status callback races
-- the turn-route hangup. Without a key, a retried inbound message is evaluated
-- for intent twice, which means a second AI classification spend and a second
-- trip through the converter for the same words.
--
-- The conversion itself is already idempotent (accept-handoff.ts:63 returns the
-- existing `leads.contact_id` without creating anything), so a duplicate cannot
-- create a second contact. What a duplicate CAN do is bill for a second model
-- call and write a second nurture activity, and — worse — re-run an opt-out write
-- and a second suppression row for a message the consumer sent once. The unique
-- index makes the recorder itself the guard: the door records first, and a
-- duplicate provider_ref is refused by the database before any evaluation runs.
--
-- PARTIAL, on purpose. Rows with no provider reference (a UI-entered note, a
-- transcript with no provider id) are not deduplicable and must stay insertable;
-- the index only constrains rows that actually carry `metadata->>'provider_ref'`.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. MEASURED BEFORE ──────────────────────────────────────────────────────
do $$
declare
  v_leads               bigint;
  v_lead_optout_cols    int;
  v_contact_optout_cols int;
  v_lch_rows            bigint;
  v_lch_uniq            int;
begin
  select count(*) into v_leads from public.leads;

  select count(*) into v_lead_optout_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'leads'
    and column_name in ('opt_out_reason', 'opt_out_source', 'opt_out_channels');

  select count(*) into v_contact_optout_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'contacts'
    and column_name in ('opt_out_reason', 'opt_out_source', 'opt_out_channels');

  select count(*) into v_lch_rows from public.lead_conversation_history;

  select count(*) into v_lch_uniq
  from pg_indexes
  where schemaname = 'public' and tablename = 'lead_conversation_history'
    and indexdef ilike '%unique%';

  raise notice 'm488 BEFORE: leads rows=%; leads opt-out provenance columns present=%/3; contacts opt-out provenance columns present=%/3; lead_conversation_history rows=%, unique indexes=%',
    v_leads, v_lead_optout_cols, v_contact_optout_cols, v_lch_rows, v_lch_uniq;

  -- The premise this migration rests on. If `leads` already carried all three,
  -- the defect described above does not exist and this migration is wrong.
  if v_lead_optout_cols = 3 then
    raise exception 'm488: leads already carries all three opt-out provenance columns — the defect this migration describes is not present. Re-read before applying.';
  end if;

  if v_contact_optout_cols <> 3 then
    raise exception 'm488: contacts does not carry all three opt-out provenance columns (found %) — the shape being mirrored is not the shape assumed.', v_contact_optout_cols;
  end if;
end $$;

-- ── 2. DDL ──────────────────────────────────────────────────────────────────
-- Types copied verbatim from `contacts` so the entity-generic writer stays generic.
alter table public.leads
  add column if not exists opt_out_reason   text,
  add column if not exists opt_out_source   text,
  add column if not exists opt_out_channels text[] not null default '{}'::text[];

comment on column public.leads.opt_out_reason is
  'The consumer''s own words when they asked not to be contacted (truncated). Mirrors contacts.opt_out_reason; written by the lead opt-out authority (lib/lead-intent/lead-opt-out.ts) and by app/actions/ai-isa/process-opt-out.ts.';
comment on column public.leads.opt_out_source is
  'Which inbound door carried the opt-out: inbound_sms | inbound_email | inbound_call | inbound_direct_mail | agent | admin | portal. Mirrors contacts.opt_out_source.';
comment on column public.leads.opt_out_channels is
  'Channels the lead has opted out of. Read as a HARD BLOCK by lib/kernel/communication-compliance.ts Rule 5 — this is the only gate that can stop a direct_mail send on a recipient request, and before m488 it could never fire for a lead because the column did not exist.';

-- Idempotency key for inbound lead messages. Partial: only rows that actually
-- carry a provider reference are deduplicable.
create unique index if not exists lead_conversation_history_provider_ref_uniq
  on public.lead_conversation_history (lead_id, (metadata ->> 'provider_ref'))
  where (metadata ->> 'provider_ref') is not null;

comment on index public.lead_conversation_history_provider_ref_uniq is
  'One inbound lead message per (lead, provider message id). Provider webhooks retry; this makes the recorder the idempotency guard so intent is evaluated — and an opt-out written — exactly once per message the consumer actually sent.';

-- ── 3. ASSERTED POSTCONDITIONS ──────────────────────────────────────────────
do $$
declare
  v_cols int;
  v_uniq int;
  v_default text;
begin
  select count(*) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'leads'
    and column_name in ('opt_out_reason', 'opt_out_source', 'opt_out_channels');
  if v_cols <> 3 then
    raise exception 'm488 POSTCONDITION FAILED: leads carries %/3 opt-out provenance columns', v_cols;
  end if;

  select column_default into v_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'leads' and column_name = 'opt_out_channels';
  if v_default is null then
    raise exception 'm488 POSTCONDITION FAILED: leads.opt_out_channels has no default — an append-style writer would read NULL, not an empty array';
  end if;

  select count(*) into v_uniq
  from pg_indexes
  where schemaname = 'public'
    and tablename  = 'lead_conversation_history'
    and indexname  = 'lead_conversation_history_provider_ref_uniq';
  if v_uniq <> 1 then
    raise exception 'm488 POSTCONDITION FAILED: the inbound-message idempotency index is not present';
  end if;

  raise notice 'm488 POSTCONDITIONS: leads carries all 3 opt-out provenance columns (opt_out_channels default %), lead_conversation_history idempotency index present', v_default;
end $$;

-- ── 4. REAL WRITE PROOF ─────────────────────────────────────────────────────
-- Performs the product's OWN writes: the exact UPDATE process-opt-out.ts issues
-- for a global lead opt-out, and the exact INSERT the inbound door issues — then
-- proves the duplicate is refused. Probe rows are removed.
do $$
declare
  v_brokerage uuid;
  v_lead      uuid;
  v_msg       uuid;
  v_refused   boolean := false;
  v_channels  text[];
begin
  select id into v_brokerage from public.brokerages order by created_at limit 1;
  if v_brokerage is null then
    raise exception 'm488: no brokerage to probe against';
  end if;

  -- phone_digits is a GENERATED column (live-verified when this probe first ran:
  -- 428C9 "cannot insert a non-DEFAULT value into column phone_digits"), so the
  -- product never writes it and neither does this.
  insert into public.leads (brokerage_id, first_name, last_name, email, phone)
  values (v_brokerage, 'm488', 'Probe', 'm488-probe@example.invalid', '+15555550488')
  returning id into v_lead;

  -- THE WRITE THAT WAS BEING REFUSED. Field-for-field the `updates` object
  -- app/actions/ai-isa/process-opt-out.ts builds on its global branch for a lead.
  update public.leads
     set opted_out_at        = now(),
         opt_out_reason      = 'do not contact me',
         opt_out_source      = 'inbound_sms',
         dnc_status          = true,
         email_opt_out       = true,
         sms_opt_out         = true,
         phone_opt_out       = true,
         direct_mail_opt_out = true,
         opt_out_channels    = array['email','sms','phone','direct_mail'],
         updated_at          = now()
   where id = v_lead;

  select opt_out_channels into v_channels from public.leads where id = v_lead;
  if v_channels is null or not ('direct_mail' = any(v_channels)) then
    raise exception 'm488: the global lead opt-out write did not land direct_mail on opt_out_channels — Rule 5 still cannot fire for a lead';
  end if;

  if not (select dnc_status and email_opt_out and sms_opt_out and phone_opt_out and direct_mail_opt_out
            from public.leads where id = v_lead) then
    raise exception 'm488: the global lead opt-out write did not land every suppression flag';
  end if;

  -- The inbound door's own insert, then the retry of the same provider message.
  insert into public.lead_conversation_history
    (lead_id, brokerage_id, channel, direction, message_content, metadata)
  values
    (v_lead, v_brokerage, 'sms', 'inbound', 'do not contact me',
     jsonb_build_object('provider_ref', 'm488-probe-sid', 'source', 'inbound_sms'))
  returning id into v_msg;

  begin
    insert into public.lead_conversation_history
      (lead_id, brokerage_id, channel, direction, message_content, metadata)
    values
      (v_lead, v_brokerage, 'sms', 'inbound', 'do not contact me',
       jsonb_build_object('provider_ref', 'm488-probe-sid', 'source', 'inbound_sms'));
  exception when unique_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'm488: a retried provider message was accepted twice — the idempotency index does not bind';
  end if;

  -- And the half that keeps the index honest: a row with NO provider_ref must
  -- still be insertable more than once, or every transcript-only record breaks.
  insert into public.lead_conversation_history
    (lead_id, brokerage_id, channel, direction, message_content, metadata)
  values (v_lead, v_brokerage, 'voice', 'inbound', 'transcript, no provider id', '{}'::jsonb);
  insert into public.lead_conversation_history
    (lead_id, brokerage_id, channel, direction, message_content, metadata)
  values (v_lead, v_brokerage, 'voice', 'inbound', 'transcript, no provider id', '{}'::jsonb);

  delete from public.lead_conversation_history where lead_id = v_lead;
  delete from public.leads where id = v_lead;

  raise notice 'm488: the global lead opt-out UPDATE process-opt-out.ts issues PROVED to land (all five suppression flags + opt_out_channels), a retried provider message PROVED to be refused, and provider-ref-less rows PROVED to remain insertable (probe rows inserted then removed)';
end $$;

commit;
