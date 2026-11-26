-- m491-a-lead-can-be-mailed-but-there-is-no-column-that-can-say-who-answered.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PRODUCT MAILS LEADS. THE DIRECT-MAIL TABLES CANNOT NAME A LEAD. SO A LEAD
-- WHO ANSWERS A MAILER IS RECORDED AS NOBODY, AND THE CONVERSION DOOR THAT WOULD
-- READ THAT ANSWER HAS NOTHING TO BE CALLED WITH.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, spelled exactly, measured against this database before writing.
--
-- The owner's ruling: "the inbound messages from a lead has to be received for
-- intent and needs to be evaluated in case they are ready for an agent to convert
-- or doesn't want to be contacted. leads converting should be automatic as soon
-- as positive feedback is returned or a positive response from inbound calls/
-- texts, email or direct mail."
--
-- Three of those four channels can name a lead. DIRECT MAIL cannot, structurally.
--
--   `lib/providers/dispatch.ts` dispatchDirectMail takes `leadId` and has an
--   explicit LEAD branch whose own comment reads: "leads are unconsented for most
--   channels; the only outbound touches permitted to a lead row are direct_mail
--   and email." So mailing a LEAD is a first-class, intended, spend-incurring
--   product behaviour — not an accident.
--
--   And yet, live columns before this migration (information_schema, verified):
--
--     direct_mail_recipients : id, brokerage_id, campaign_id, contact_id,
--                              first_name, last_name, address_line1,
--                              address_line2, city, state, zip, lob_address_id,
--                              delivery_status, mailed_at, delivered_at,
--                              created_at
--     direct_mail_responses  : id, brokerage_id, campaign_id, recipient_id,
--                              contact_id, response_type, response_metadata,
--                              created_at
--     mail_response_tracking : id, brokerage_id, campaign_id, contact_id,
--                              response_type, response_metadata, created_at
--
--   NOT ONE `lead_id` among them. `contact_id` on all three; `lead_id` on none.
--
-- So when a lead answers a mailer — scans the QR, returns the reply card, calls
-- the printed number, fills the form on the landing page — the row that records
-- the answer has no column that can say who answered. The response is written
-- attached to NOBODY (contact_id NULL, recipient_id NULL) and the conversion
-- chain the ruling demands can never start, because its entry point
-- `app/actions/lead-signal-ingest.ts:326 ingestDirectMailResponseSignalAction`
-- requires a `leadId` that nothing in the mail tables can produce.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY BOTH TABLES, AND NOT JUST `direct_mail_recipients.lead_id`.
--
-- The tempting minimal fix is one column on `direct_mail_recipients` and let
-- `direct_mail_responses` reach the lead by joining through its `recipient_id`.
-- That fails for four separate, checkable reasons, each on its own sufficient:
--
--   1. `direct_mail_responses.recipient_id` IS NULLABLE, and the only unattended
--      writer in the tree never supplies it. `app/api/qr/scan/route.ts:133`
--      inserts a `qr_scan` response with brokerage_id, campaign_id, response_type
--      and response_metadata — and NO recipient_id. It cannot supply one: the QR
--      code is minted PER CAMPAIGN (`qr_codes.slug` → the campaign whose
--      `qr_code_id` matches), so a scan identifies the campaign and never the
--      individual recipient. Every QR response this system has ever been capable
--      of writing would join through recipient_id to NULL.
--
--   2. `app/actions/direct-mail.ts logResponse` declares `recipientId?: string`
--      — optional, in the type. A join that is only sometimes possible is not a
--      lead anchor; it is a lead anchor that silently disappears.
--
--   3. AND THE DECIDING ONE: the path that ACTUALLY MAILS A LEAD TODAY WRITES NO
--      RECIPIENT ROW AT ALL. `lib/direct-mail/campaign-drain.ts`
--      runDirectMailCampaignDrain walks approved `direct_mail_campaigns` rows
--      carrying `lead_id`, resolves the lead's verified mailing address, and
--      dispatches via `lib/direct-mail/orchestrate-send.ts` →
--      `dispatchDirectMail`. Neither the drain nor the orchestrator nor the
--      dispatcher inserts into `direct_mail_recipients`. The recipient of a
--      lead mailing is named ONLY on `direct_mail_campaigns.lead_id` (a column
--      that already exists — live-verified — which is itself the proof that this
--      product intends 1:1 lead mail). So for the live lead-mail path there is no
--      recipient row to join THROUGH.
--
--   4. `contact_id` is ALREADY denormalized onto all three tables for exactly
--      this reason. Anchoring the lead on one table and the contact on three is
--      how the two entity classes drift until one of them stops being reachable —
--      which is the state this migration is repairing.
--
-- `mail_response_tracking` gets the column too. Both response writers
-- (`logResponse`, and the QR route) write `direct_mail_responses` and
-- `mail_response_tracking` in lockstep, from the same values, one line apart.
-- Anchoring one and not the other reproduces the split in miniature: the
-- Responses tab would know a lead answered and the ROI ledger would not.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY *NOT* ADDED.
--
-- NO `check (num_nonnulls(contact_id, lead_id) <= 1)` XOR CONSTRAINT. A converted
-- lead keeps BOTH rows — `leads.contact_id` points at the contact the conversion
-- chain created (`createContactFromLead`), and the lead row is not deleted. A
-- response that arrives after conversion legitimately names both: the lead it was
-- mailed to, and the contact that lead became. An XOR check would refuse exactly
-- the row the conversion chain produces, and refuse it at the moment the system
-- is most sure of the answer.
--
-- FK IS `on delete set null`, copied verbatim from each table's existing
-- `contact_id` FK (live: `FOREIGN KEY (contact_id) REFERENCES contacts(id) ON
-- DELETE SET NULL`). Deleting a lead must not cascade away a campaign's response
-- history: those rows are spend evidence and per-campaign cost-per-response is
-- computed from them.
--
-- INDEXES on `direct_mail_recipients.lead_id` and `direct_mail_responses.lead_id`,
-- because both become lookup paths the moment this lands: the response sites
-- resolve a leadId from a recipient row, and lead-timeline / conversion-audit
-- reads go the other way. Partial (`where lead_id is not null`) — the overwhelming
-- majority of rows in a contact-first CRM will never carry one, and a partial
-- index on the sparse arm is the honest shape. `mail_response_tracking` gets NO
-- index: nothing looks a lead up in the ROI ledger, it is aggregated by campaign.
--
-- NO CHECK CONSTRAINT IS ADDED OR CHANGED BY THIS MIGRATION. The live CHECK sets
-- on `direct_mail_responses.response_type` (qr_scan | landing_visit | call |
-- form_submit | reply | appointment), `direct_mail_recipients.delivery_status`
-- (pending | mailed | delivered | returned | failed) and
-- `contact_suppression_list.channel` (email | sms | phone | mail) are UNTOUCHED.
-- scripts/check-vocabularies.ts does not need regenerating.
--
-- NAMING NOTE: this file is m491, not m490. m490
-- ("two-uniqueness-rules-the-code-promised-and-only-the-code-enforced") was
-- claimed by a concurrent lane in the same wave before this one was written.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. MEASURED BEFORE ──────────────────────────────────────────────────────
do $$
declare
  v_recip_rows        bigint;
  v_resp_rows         bigint;
  v_mrt_rows          bigint;
  v_resp_no_recipient bigint;
  v_resp_no_contact   bigint;
  v_lead_cols         int;
  v_contact_cols      int;
  v_campaign_lead_col int;
begin
  select count(*) into v_recip_rows from public.direct_mail_recipients;
  select count(*) into v_resp_rows  from public.direct_mail_responses;
  select count(*) into v_mrt_rows   from public.mail_response_tracking;

  select count(*) into v_resp_no_recipient from public.direct_mail_responses where recipient_id is null;
  select count(*) into v_resp_no_contact   from public.direct_mail_responses where contact_id  is null;

  -- How many of the three mail tables can name a LEAD (expected: 0).
  select count(*) into v_lead_cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('direct_mail_recipients', 'direct_mail_responses', 'mail_response_tracking')
    and column_name = 'lead_id';

  -- How many can name a CONTACT (expected: 3 — the asymmetry being repaired).
  select count(*) into v_contact_cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('direct_mail_recipients', 'direct_mail_responses', 'mail_response_tracking')
    and column_name = 'contact_id';

  -- The column that proves 1:1 lead mail is intended (expected: 1).
  select count(*) into v_campaign_lead_col
  from information_schema.columns
  where table_schema = 'public' and table_name = 'direct_mail_campaigns' and column_name = 'lead_id';

  raise notice 'm491 BEFORE: direct_mail_recipients rows=%, direct_mail_responses rows=% (recipient_id null=%, contact_id null=%), mail_response_tracking rows=%; mail tables that can name a LEAD=%/3; mail tables that can name a CONTACT=%/3; direct_mail_campaigns.lead_id present=%',
    v_recip_rows, v_resp_rows, v_resp_no_recipient, v_resp_no_contact, v_mrt_rows,
    v_lead_cols, v_contact_cols, v_campaign_lead_col;

  -- The premise. If any of the three already carried lead_id, the defect
  -- described above is not the defect present, and this migration is wrong.
  if v_lead_cols <> 0 then
    raise exception 'm491: % of the three direct-mail tables ALREADY carries lead_id — the defect this migration describes is not present. Re-read before applying.', v_lead_cols;
  end if;

  -- The asymmetry is the whole argument. If contacts were not already anchored
  -- on all three, "mirror the contact anchor" is not the right shape.
  if v_contact_cols <> 3 then
    raise exception 'm491: only %/3 direct-mail tables carry contact_id — the shape being mirrored is not the shape assumed.', v_contact_cols;
  end if;

  -- If campaigns could NOT name a lead either, then nothing in the schema
  -- intends 1:1 lead mail and the argument in the header is wrong.
  if v_campaign_lead_col <> 1 then
    raise exception 'm491: direct_mail_campaigns has no lead_id — the claim that this product intends 1:1 lead mail does not hold. Re-read before applying.';
  end if;
end $$;

-- ── 2. DDL ──────────────────────────────────────────────────────────────────
-- Types and FK actions copied verbatim from each table's existing contact_id.

alter table public.direct_mail_recipients
  add column if not exists lead_id uuid;

alter table public.direct_mail_responses
  add column if not exists lead_id uuid;

alter table public.mail_response_tracking
  add column if not exists lead_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.direct_mail_recipients'::regclass
      and conname  = 'direct_mail_recipients_lead_id_fkey'
  ) then
    alter table public.direct_mail_recipients
      add constraint direct_mail_recipients_lead_id_fkey
      foreign key (lead_id) references public.leads(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.direct_mail_responses'::regclass
      and conname  = 'direct_mail_responses_lead_id_fkey'
  ) then
    alter table public.direct_mail_responses
      add constraint direct_mail_responses_lead_id_fkey
      foreign key (lead_id) references public.leads(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.mail_response_tracking'::regclass
      and conname  = 'mail_response_tracking_lead_id_fkey'
  ) then
    alter table public.mail_response_tracking
      add constraint mail_response_tracking_lead_id_fkey
      foreign key (lead_id) references public.leads(id) on delete set null;
  end if;
end $$;

create index if not exists idx_direct_mail_recipients_lead
  on public.direct_mail_recipients (lead_id)
  where lead_id is not null;

create index if not exists idx_direct_mail_responses_lead
  on public.direct_mail_responses (lead_id)
  where lead_id is not null;

comment on column public.direct_mail_recipients.lead_id is
  'The LEAD this mail piece is addressed to, when the audience member is an unconverted lead rather than a contact. Nullable and non-exclusive with contact_id: a converted lead legitimately carries both. dispatchDirectMail explicitly permits mailing a lead row, so this is the column that lets the mailing list say who was mailed.';

comment on column public.direct_mail_responses.lead_id is
  'The LEAD who answered this mail piece. NOT derivable by joining recipient_id: the QR route (app/api/qr/scan/route.ts) writes responses with no recipient_id at all because a QR code is per-campaign, and the live lead-mail path (lib/direct-mail/campaign-drain.ts) writes no recipient row at all. This is the column app/actions/lead-signal-ingest.ts ingestDirectMailResponseSignalAction is called with, and therefore the column on which automatic direct-mail conversion depends.';

comment on column public.mail_response_tracking.lead_id is
  'The LEAD who answered, mirroring direct_mail_responses.lead_id. Both response writers write both tables in lockstep from the same values; anchoring one and not the other would leave a lead visible in the Responses tab and invisible in the ROI ledger.';

-- ── 3. ASSERTED POSTCONDITIONS ──────────────────────────────────────────────
do $$
declare
  v_cols      int;
  v_fks       int;
  v_bad_fks   int;
  v_indexes   int;
  v_extra_chk int;
begin
  select count(*) into v_cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('direct_mail_recipients', 'direct_mail_responses', 'mail_response_tracking')
    and column_name = 'lead_id';
  if v_cols <> 3 then
    raise exception 'm491 POSTCONDITION FAILED: %/3 direct-mail tables carry lead_id', v_cols;
  end if;

  -- Every one of the three must actually REFERENCE leads(id). A bare uuid column
  -- would let a response name a lead id that does not exist, which is the same
  -- "attached to nobody" failure wearing a different mask.
  select count(*) into v_fks
  from pg_constraint c
  where c.contype = 'f'
    and c.conrelid in (
      'public.direct_mail_recipients'::regclass,
      'public.direct_mail_responses'::regclass,
      'public.mail_response_tracking'::regclass)
    and c.confrelid = 'public.leads'::regclass;
  if v_fks <> 3 then
    raise exception 'm491 POSTCONDITION FAILED: only %/3 lead_id columns are foreign keys onto leads(id)', v_fks;
  end if;

  -- and must NOT cascade. A deleted lead must not take a campaign's spend
  -- evidence with it.
  select count(*) into v_bad_fks
  from pg_constraint c
  where c.contype = 'f'
    and c.conrelid in (
      'public.direct_mail_recipients'::regclass,
      'public.direct_mail_responses'::regclass,
      'public.mail_response_tracking'::regclass)
    and c.confrelid = 'public.leads'::regclass
    and c.confdeltype <> 'n';   -- 'n' = SET NULL
  if v_bad_fks <> 0 then
    raise exception 'm491 POSTCONDITION FAILED: % lead_id foreign key(s) are not ON DELETE SET NULL — deleting a lead would destroy direct-mail response history', v_bad_fks;
  end if;

  select count(*) into v_indexes
  from pg_indexes
  where schemaname = 'public'
    and indexname in ('idx_direct_mail_recipients_lead', 'idx_direct_mail_responses_lead');
  if v_indexes <> 2 then
    raise exception 'm491 POSTCONDITION FAILED: %/2 lead lookup indexes present', v_indexes;
  end if;

  -- This migration must not have invented a vocabulary. The three CHECK sets the
  -- app reasons about stay exactly as they were found.
  select count(*) into v_extra_chk
  from pg_constraint
  where contype = 'c'
    and conrelid in ('public.direct_mail_recipients'::regclass, 'public.direct_mail_responses'::regclass)
    and conname not in ('direct_mail_recipients_delivery_status_check', 'direct_mail_responses_response_type_check');
  if v_extra_chk <> 0 then
    raise exception 'm491 POSTCONDITION FAILED: % unexpected CHECK constraint(s) on the direct-mail tables — scripts/check-vocabularies.ts would be stale', v_extra_chk;
  end if;

  raise notice 'm491 POSTCONDITIONS: all 3 direct-mail tables carry lead_id, all 3 are FK onto leads(id) ON DELETE SET NULL, both lead lookup indexes present, and no CHECK vocabulary was added or changed';
end $$;

-- ── 4. REAL WRITE PROOF ─────────────────────────────────────────────────────
-- Performs the product's OWN inserts, in the product's own shapes:
--   · the 1:1 lead campaign runDirectMailCampaignDrain stages and dispatches;
--   · the recipient row addRecipients writes for a lead audience member;
--   · the response row logResponse writes (recipient_id present);
--   · the response row app/api/qr/scan/route.ts writes (recipient_id ABSENT —
--     the shape that proves the join-through-recipient design would have failed);
--   · the mail_response_tracking row both writers write one line later.
-- Then it resolves the leadId the conversion door needs from each, both ways,
-- and proves the FK binds. Probe rows are removed.
do $$
declare
  v_brokerage   uuid;
  v_lead        uuid;
  v_campaign    uuid;
  v_recipient   uuid;
  v_resp_form   uuid;
  v_resp_scan   uuid;
  v_resolved    uuid;
  v_via_join    uuid;
  v_fk_refused  boolean := false;
begin
  select id into v_brokerage from public.brokerages order by created_at limit 1;
  if v_brokerage is null then
    raise exception 'm491: no brokerage to probe against';
  end if;

  -- A lead the drain would consider mailable: a CASS-verified mailing address.
  -- phone_digits is GENERATED, so the product never writes it and neither does this.
  insert into public.leads
    (brokerage_id, first_name, last_name, email, phone,
     mailing_address, mailing_city, mailing_state, mailing_zip, mailing_address_verified)
  values
    (v_brokerage, 'm491', 'Probe', 'm491-probe@example.invalid', '+15555550491',
     '1 Probe Way', 'Austin', 'TX', '78701', true)
  returning id into v_lead;

  -- The 1:1 lead campaign the drain picks up (direct_mail_campaigns.lead_id).
  insert into public.direct_mail_campaigns
    (brokerage_id, campaign_name, lead_id, status, piece_type, copy_text)
  values
    (v_brokerage, 'm491 probe — lead postcard', v_lead, 'planning', 'postcard', 'probe')
  returning id into v_campaign;

  -- ── THE WRITE THAT WAS IMPOSSIBLE (1/3): a mailing-list row naming a LEAD.
  -- Field-for-field the row app/actions/direct-mail.ts addRecipients builds,
  -- with contact_id NULL because the audience member is not a contact.
  insert into public.direct_mail_recipients
    (brokerage_id, campaign_id, contact_id, lead_id,
     first_name, last_name, address_line1, city, state, zip, delivery_status)
  values
    (v_brokerage, v_campaign, null, v_lead,
     'm491', 'Probe', '1 Probe Way', 'Austin', 'TX', '78701', 'pending')
  returning id into v_recipient;

  -- ── THE WRITE THAT WAS IMPOSSIBLE (2/3): logResponse's row for a lead who
  -- returned the reply card. recipient_id IS supplied here.
  insert into public.direct_mail_responses
    (brokerage_id, campaign_id, recipient_id, contact_id, lead_id, response_type, response_metadata)
  values
    (v_brokerage, v_campaign, v_recipient, null, v_lead, 'form_submit',
     jsonb_build_object('source', 'm491_probe', 'message', 'Yes, please call me'))
  returning id into v_resp_form;

  -- ── THE WRITE THAT WAS IMPOSSIBLE (3/3): the QR route's row. recipient_id is
  -- NULL — exactly as app/api/qr/scan/route.ts writes it, because a QR code
  -- identifies the CAMPAIGN and never the individual recipient. This row is the
  -- proof that lead_id on direct_mail_responses is NOT redundant with a join
  -- through recipient_id: there is nothing here to join through.
  insert into public.direct_mail_responses
    (brokerage_id, campaign_id, recipient_id, contact_id, lead_id, response_type, response_metadata)
  values
    (v_brokerage, v_campaign, null, null, v_lead, 'qr_scan',
     jsonb_build_object('source', 'qr_scan_route', 'slug', 'm491-probe'))
  returning id into v_resp_scan;

  -- The ROI ledger's twin write, one line later in both writers.
  insert into public.mail_response_tracking
    (brokerage_id, campaign_id, contact_id, lead_id, response_type, response_metadata)
  values
    (v_brokerage, v_campaign, null, v_lead, 'form_submit', jsonb_build_object('source', 'm491_probe'));

  -- ── RESOLVE THE leadId THE CONVERSION DOOR NEEDS ──────────────────────────
  -- ingestDirectMailResponseSignalAction({ brokerageId, leadId, responseType,
  -- providerRef: <this response's id> }) — the leadId must come off the response
  -- row itself, for BOTH shapes.
  select lead_id into v_resolved from public.direct_mail_responses where id = v_resp_form;
  if v_resolved is distinct from v_lead then
    raise exception 'm491: the reply-card response does not resolve to the lead who answered';
  end if;

  select lead_id into v_resolved from public.direct_mail_responses where id = v_resp_scan;
  if v_resolved is distinct from v_lead then
    raise exception 'm491: the QR-scan response does not resolve to the lead who answered — the recipient_id-less shape is exactly the one that must work';
  end if;

  -- And the other direction: from a recipient row, which is how logResponse
  -- resolves a leadId when the caller supplied only recipientId.
  select r.lead_id into v_via_join
  from public.direct_mail_responses resp
  join public.direct_mail_recipients r on r.id = resp.recipient_id
  where resp.id = v_resp_form;
  if v_via_join is distinct from v_lead then
    raise exception 'm491: a lead is not reachable from a response through its recipient row';
  end if;

  -- The join that the "recipients.lead_id alone is enough" design would have
  -- relied on returns NOTHING for the QR shape. Demonstrated, not asserted.
  if exists (
    select 1
    from public.direct_mail_responses resp
    join public.direct_mail_recipients r on r.id = resp.recipient_id
    where resp.id = v_resp_scan
  ) then
    raise exception 'm491: the QR-scan probe unexpectedly has a recipient row — the probe no longer models the live writer';
  end if;

  -- ── THE FK BINDS ──────────────────────────────────────────────────────────
  -- A response naming a lead that does not exist must be refused outright; a
  -- bare uuid column would let "attached to nobody" back in through the front.
  begin
    insert into public.direct_mail_responses
      (brokerage_id, campaign_id, lead_id, response_type)
    values (v_brokerage, v_campaign, '00000000-0000-0000-0000-000000000491', 'reply');
  exception when foreign_key_violation then
    v_fk_refused := true;
  end;
  if not v_fk_refused then
    raise exception 'm491: a response naming a non-existent lead was ACCEPTED — lead_id is not bound to leads(id)';
  end if;

  -- ── CLEAN UP (children first; the campaign FK cascades but be explicit) ───
  delete from public.mail_response_tracking where campaign_id = v_campaign;
  delete from public.direct_mail_responses   where campaign_id = v_campaign;
  delete from public.direct_mail_recipients  where campaign_id = v_campaign;
  delete from public.direct_mail_campaigns   where id = v_campaign;
  delete from public.leads                   where id = v_lead;

  raise notice 'm491 WRITE PROOF: a LEAD mailing-list row, a reply-card response WITH a recipient_id, a QR-scan response WITHOUT one, and the ROI-ledger twin were all PROVED insertable and all PROVED to resolve back to the lead who answered; the recipient-join PROVED empty for the QR shape (which is why direct_mail_responses.lead_id is not redundant); a response naming a non-existent lead PROVED refused. Probe rows inserted then removed.';
end $$;

commit;
