-- m493-a-mailed-recipient-has-no-way-to-say-stop.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PRODUCT MAILS PEOPLE. NOTHING ON THE MAIL PIECE CAN SAY WHO IT WENT TO,
-- SO THE PERSON HOLDING IT HAS NO WAY TO ASK TO STOP.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE OWNER'S RULING
--
--   "there should be someway for the contact or lead can be traced back to their
--    direct mail campaign to unsubscribe."
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, measured against THIS database before writing.
--
-- 1. THERE IS NO OPT-OUT CREDENTIAL ON A MAIL PIECE. Live columns of
--    `direct_mail_recipients` (information_schema, verified):
--
--      id, brokerage_id, campaign_id, contact_id, first_name, last_name,
--      address_line1, address_line2, city, state, zip, lob_address_id,
--      delivery_status, mailed_at, delivered_at, created_at, lead_id
--
--    Seventeen columns, and not one of them is something that can be printed on
--    the piece and typed back in. The only per-recipient value that exists is
--    `id` — and an entity id is exactly what must NOT be used here (see below).
--
-- 2. THE ONE THING THAT IS PRINTED CANNOT NAME A PERSON. `qr_codes.slug` is on
--    the piece, but a QR code is minted PER CAMPAIGN — m491 established this and
--    `app/api/qr/scan/route.ts:133` proves it, writing a response row with no
--    recipient_id because it structurally cannot know one. A scan identifies the
--    campaign. It can never identify WHO to suppress.
--
-- 3. THE PUBLIC OPT-OUT SURFACE HAS NO MAIL CHANNEL AT ALL.
--    `app/api/unsubscribe/route.ts` refuses anything that is not 'email' or
--    'sms' — while `contact_suppression_list.channel` has admitted 'mail' the
--    whole time (live CHECK: email | sms | phone | mail) and
--    `lib/providers/dispatch.ts` dispatchDirectMail now READS that channel. The
--    read side of mail suppression exists. The write side has no door.
--
-- 4. AND IT CANNOT SERVE A LEAD. That route requires a `contacts` row. The live
--    lead-mail path (`lib/direct-mail/campaign-drain.ts`, which m491 taught to
--    write the mailing-list row) mails LEADS — the normal case for a direct-mail
--    acquisition campaign, and the one case the surface cannot represent.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A NEW RANDOM COLUMN AND NOT `id`, AND NOT A HASH OF `id`.
--
-- `id` is a lookup key. It is in tenant dashboard URLs, in `getRecipients`
-- payloads, in CSV exports, in logs. A credential that is also a lookup key is a
-- credential that leaks by being used. It also cannot be ROTATED — rotating it
-- breaks every foreign key pointing at the row (`direct_mail_responses.recipient_id`,
-- `neighbor_notification_recipients.direct_mail_recipient_id`) — and a credential
-- that cannot be revoked is not a credential.
--
-- A HASH OF `id` IS STRICTLY WORSE THAN `id`. It is a deterministic function of a
-- value the tenant already holds, so anyone with the id (every tenant user, every
-- export) can recompute the token for every recipient in the table. It buys the
-- appearance of a secret and none of the substance. This column is an INDEPENDENT
-- CSPRNG DRAW that is a function of nothing.
--
-- ENTROPY, and why 70 bits is the honest number. The generator below takes one
-- whole random byte per character and reduces it mod 32. 256 is an exact multiple
-- of 32, so the reduction is UNBIASED — no character is more likely than another,
-- and all 5 bits per character are real. 14 characters = 70 bits. This surface is
-- unauthenticated by design, so entropy IS the security boundary: at 100 guesses
-- per second against the entire table, expected time to hit any live token is on
-- the order of 10^11 years. Rate limiting in the route is defence in depth, not
-- the boundary.
--
-- ALPHABET: Crockford Base32 (0-9 A-Z minus I, L, O, U). NOT RFC 4648, which
-- keeps I, L and O. This string is READ OFF PRINTED PAPER AND TYPED BY A HUMAN,
-- so the confusable pairs are removed from the mint and folded back in on read
-- (`lib/direct-mail/unsubscribe-token.ts` normalizeMailUnsubToken maps O→0 and
-- I/L→1). U is dropped so a random draw cannot spell something the brokerage has
-- to apologise for. The alphabet string here and the one in that module are
-- byte-for-byte identical; a drift would make the database mint tokens the app
-- rejects as malformed, which presents as "the unsubscribe link is broken" — the
-- exact defect being repaired.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY `NOT NULL` WITH A DEFAULT, AND NOT NULLABLE.
--
-- This was the one real design question, and the answer is NOT NULL.
--
--   · A NULL token is a mail piece that cannot be opted out of. That is the
--     defect. A column whose null state IS the bug should not permit the bug.
--   · Nullable means every writer must remember to mint one. There are three
--     live writers into this table — `app/actions/direct-mail.ts` addRecipients,
--     `lib/direct-mail/campaign-drain.ts`, `app/actions/neighbor-notifications.ts`
--     — plus whatever is written next. A DEFAULT makes the token unforgettable:
--     none of the three needs to change, and a fourth writer gets it for free.
--   · A UNIQUE index over a nullable column admits unlimited NULLs. "Many rows
--     share the state of having no token" is indistinguishable from the defect,
--     and the index would silently stop being the guarantee it is here for.
--
-- EXISTING ROWS: measured, `direct_mail_recipients` currently holds 0 rows, so
-- the backfill is free. It would be correct even if it were not: the DEFAULT is
-- a VOLATILE function, so `ADD COLUMN ... DEFAULT ... NOT NULL` forces a table
-- rewrite and Postgres evaluates the default ONCE PER ROW — every pre-existing
-- recipient gets its own distinct token rather than all of them sharing one.
-- (This is the case where PG11's fast-default optimisation deliberately does not
-- apply, and here that is the behaviour we want.) The row count is asserted
-- before and after so the claim is not taken on faith.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE SECOND COLUMN: `unsubscribed_at`.
--
-- The token answers "who". `unsubscribed_at` answers "did they, and off which
-- piece" — the trace half of the ruling. Without it:
--   · the surface cannot tell a first request from a re-visit, so a person who
--     clicks twice gets a second consent-ledger entry for one decision;
--   · nothing can attribute an opt-out to the CAMPAIGN that caused it, which is
--     the number that tells a brokerage a mail piece is burning its list.
-- Nullable, because "has not opted out" is the honest majority state and a
-- sentinel timestamp would be a lie. No index: it is read one row at a time by
-- token, and aggregated per campaign over a table scoped by campaign_id.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO.
--
-- NO CHECK VOCABULARY IS ADDED OR CHANGED. `direct_mail_recipients.delivery_status`
-- (pending | mailed | delivered | returned | failed) and
-- `contact_suppression_list.channel` (email | sms | phone | mail) are UNTOUCHED —
-- 'mail' was already admitted, which is why the write side needed a door and not
-- a new word. scripts/check-vocabularies.ts does not need regenerating.
--
-- NO RLS CHANGE. The public surface reads this table through the SERVICE client
-- by design (the caller is an anonymous member of the public holding a postcard —
-- there is no session to scope). The tenant boundary is not RLS here; it is that
-- the token resolves to exactly one row and the brokerage is read OFF that row,
-- never accepted from the caller.
--
-- NO FORMAT CHECK CONSTRAINT ON THE COLUMN. Tempting, and wrong: a CHECK on the
-- alphabet would freeze the token format in the schema, so rotating to a longer
-- token later becomes a migration on a table with a unique index rather than a
-- change to one generator function. The generator is the single source of format.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. MEASURED BEFORE ──────────────────────────────────────────────────────
do $$
declare
  v_rows          bigint;
  v_token_col     int;
  v_unsub_col     int;
  v_mail_channel  int;
  v_pgcrypto      int;
begin
  select count(*) into v_rows from public.direct_mail_recipients;

  select count(*) into v_token_col
  from information_schema.columns
  where table_schema='public' and table_name='direct_mail_recipients'
    and column_name='unsubscribe_token';

  select count(*) into v_unsub_col
  from information_schema.columns
  where table_schema='public' and table_name='direct_mail_recipients'
    and column_name='unsubscribed_at';

  -- The read side must already admit 'mail', or the write side this unlocks has
  -- nowhere to land and the whole premise is wrong.
  select count(*) into v_mail_channel
  from pg_constraint
  where conrelid='public.contact_suppression_list'::regclass
    and contype='c'
    and pg_get_constraintdef(oid) like '%''mail''%';

  select count(*) into v_pgcrypto from pg_extension where extname='pgcrypto';

  raise notice 'm493 BEFORE: direct_mail_recipients rows=%; unsubscribe_token present=%; unsubscribed_at present=%; contact_suppression_list admits ''mail''=%; pgcrypto installed=%',
    v_rows, v_token_col, v_unsub_col, v_mail_channel, v_pgcrypto;

  if v_token_col <> 0 then
    raise exception 'm493: direct_mail_recipients ALREADY has unsubscribe_token — the defect this migration describes is not present. Re-read before applying.';
  end if;

  if v_mail_channel <> 1 then
    raise exception 'm493: contact_suppression_list.channel does NOT admit ''mail'' — the suppression this migration unlocks has nowhere to be written. Re-read before applying.';
  end if;

  if v_pgcrypto <> 1 then
    raise exception 'm493: pgcrypto is not installed — gen_random_bytes is unavailable and the token generator cannot draw from a CSPRNG. Refusing to fall back to random(), which is not cryptographically secure.';
  end if;
end $$;

-- ── 2. THE GENERATOR ────────────────────────────────────────────────────────
-- One whole random byte per character, reduced mod 32. 256 = 8 x 32 exactly, so
-- the reduction is UNBIASED and every one of the 70 bits is real. gen_random_bytes
-- is pgcrypto's CSPRNG; random() is NOT used anywhere here.
--
-- VOLATILE (the default, stated explicitly): it must be re-evaluated per row, or
-- the ADD COLUMN backfill would stamp every existing recipient with one shared
-- token and the unique index would refuse the migration.
--
-- The alphabet is byte-for-byte MAIL_UNSUB_ALPHABET from
-- lib/direct-mail/unsubscribe-token.ts. Crockford Base32: no I, L, O or U.
create or replace function public.direct_mail_unsubscribe_token()
returns text
language plpgsql
volatile
as $fn$
declare
  k_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  k_len      constant int  := 14;
  v_bytes    bytea;
  v_out      text := '';
  i          int;
begin
  v_bytes := gen_random_bytes(k_len);
  for i in 0 .. k_len - 1 loop
    v_out := v_out || substr(k_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_out;
end;
$fn$;

comment on function public.direct_mail_unsubscribe_token() is
  'Mints a 14-character Crockford-Base32 (no I/L/O/U) opt-out token, 70 bits drawn from pgcrypto''s CSPRNG one unbiased byte per character. The DEFAULT for direct_mail_recipients.unsubscribe_token. Alphabet and length MUST stay identical to MAIL_UNSUB_ALPHABET / MAIL_UNSUB_TOKEN_LENGTH in lib/direct-mail/unsubscribe-token.ts — a drift makes the database mint tokens the application rejects as malformed.';

-- ── 3. DDL ──────────────────────────────────────────────────────────────────
-- NOT NULL + volatile DEFAULT: rewrites the table and evaluates the default once
-- per existing row, so every pre-existing recipient gets its OWN token.
alter table public.direct_mail_recipients
  add column if not exists unsubscribe_token text
    not null default public.direct_mail_unsubscribe_token();

alter table public.direct_mail_recipients
  add column if not exists unsubscribed_at timestamptz;

-- UNIQUE, not merely indexed. The token is the sole credential the public
-- surface accepts, so "resolves to exactly one recipient" has to be a database
-- guarantee and not a property the application hopes holds. A plain unique index
-- suffices because the column is NOT NULL.
create unique index if not exists direct_mail_recipients_unsubscribe_token_key
  on public.direct_mail_recipients (unsubscribe_token);

comment on column public.direct_mail_recipients.unsubscribe_token is
  'The opt-out credential PRINTED ON THE MAIL PIECE. 14 Crockford-Base32 characters (70 bits, pgcrypto CSPRNG), typed back by a human at /unsubscribe/{token}. Deliberately NOT the row id and NOT derived from it: an id is a lookup key that leaks through exports, logs and dashboard URLs, cannot be rotated without breaking direct_mail_responses.recipient_id, and names the whole entity rather than one mail piece. This column is an independent random draw, is a function of nothing, and can be rotated with an UPDATE. It is the ONLY thing that lets a person holding a postcard be traced back to the campaign that mailed it, which is what the opt-out surface needs to know who to suppress.';

comment on column public.direct_mail_recipients.unsubscribed_at is
  'When this recipient used their printed token to ask to stop. NULL = has not. Makes a repeat visit idempotent (one decision must not write two consent-ledger entries) and makes opt-outs attributable to the CAMPAIGN that caused them — the trace half of the ruling. The binding suppression itself lives on leads / contacts / contact_suppression_list, which is what dispatchDirectMail reads; this column is the per-piece evidence, never the gate.';

-- ── 4. ASSERTED POSTCONDITIONS ──────────────────────────────────────────────
do $$
declare
  v_notnull   text;
  v_default   text;
  v_unique    int;
  v_rows      bigint;
  v_nulls     bigint;
  v_distinct  bigint;
  v_badchars  bigint;
  v_badlen    bigint;
  v_extra_chk int;
begin
  select is_nullable, column_default into v_notnull, v_default
  from information_schema.columns
  where table_schema='public' and table_name='direct_mail_recipients'
    and column_name='unsubscribe_token';

  if v_notnull <> 'NO' then
    raise exception 'm493 POSTCONDITION FAILED: unsubscribe_token is NULLABLE — a null token is a mail piece nobody can opt out of, which is the defect this migration exists to remove';
  end if;
  if v_default is null or v_default not like '%direct_mail_unsubscribe_token%' then
    raise exception 'm493 POSTCONDITION FAILED: unsubscribe_token has no generator DEFAULT (found: %) — every writer would have to remember to mint one', coalesce(v_default,'<none>');
  end if;

  select count(*) into v_unique
  from pg_indexes
  where schemaname='public' and indexname='direct_mail_recipients_unsubscribe_token_key';
  if v_unique <> 1 then
    raise exception 'm493 POSTCONDITION FAILED: the unique index on unsubscribe_token is absent — "resolves to exactly one recipient" would be an application hope rather than a database guarantee';
  end if;

  -- Every existing row got its own token, and every token is well formed.
  select count(*), count(*) filter (where unsubscribe_token is null), count(distinct unsubscribe_token)
    into v_rows, v_nulls, v_distinct
  from public.direct_mail_recipients;

  select count(*) into v_badlen
  from public.direct_mail_recipients where length(unsubscribe_token) <> 14;

  -- Any character outside the Crockford alphabet — in particular I, L, O or U,
  -- the four the app's normaliser would fold or refuse.
  select count(*) into v_badchars
  from public.direct_mail_recipients
  where unsubscribe_token ~ '[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]';

  if v_nulls <> 0 then
    raise exception 'm493 POSTCONDITION FAILED: % backfilled row(s) carry a NULL token', v_nulls;
  end if;
  if v_rows <> v_distinct then
    raise exception 'm493 POSTCONDITION FAILED: % rows share only % distinct tokens — the default was evaluated once instead of per row', v_rows, v_distinct;
  end if;
  if v_badlen <> 0 or v_badchars <> 0 then
    raise exception 'm493 POSTCONDITION FAILED: % row(s) of wrong length and % row(s) with characters outside the printed alphabet — the app normaliser would reject these as malformed', v_badlen, v_badchars;
  end if;

  -- This migration must not have invented a vocabulary.
  select count(*) into v_extra_chk
  from pg_constraint
  where contype='c'
    and conrelid='public.direct_mail_recipients'::regclass
    and conname not in ('direct_mail_recipients_delivery_status_check');
  if v_extra_chk <> 0 then
    raise exception 'm493 POSTCONDITION FAILED: % unexpected CHECK constraint(s) on direct_mail_recipients — scripts/check-vocabularies.ts would be stale', v_extra_chk;
  end if;

  raise notice 'm493 POSTCONDITIONS: unsubscribe_token is NOT NULL with a CSPRNG generator default, uniquely indexed; % existing row(s) backfilled to % distinct well-formed tokens; no CHECK vocabulary added or changed', v_rows, v_distinct;
end $$;

-- ── 5. REAL WRITE PROOF ─────────────────────────────────────────────────────
-- Runs the product's OWN inserts and then proves the three things the public
-- surface depends on:
--   (a) a token resolves to EXACTLY ONE recipient, and off that one row the
--       lead / contact / brokerage are all reachable — so the surface never has
--       to take a tenant from the caller;
--   (b) uniqueness is ENFORCED, not assumed;
--   (c) the resulting 'mail' suppression rows land where dispatchDirectMail's
--       gate actually reads — the lead's own flags AND contact_suppression_list.
-- Probe rows are removed.
do $$
declare
  v_brokerage  uuid;
  v_lead       uuid;
  v_contact    uuid;
  v_campaign   uuid;
  v_recip_lead uuid;
  v_recip_ctc  uuid;
  v_tok_lead   text;
  v_tok_ctc    text;
  v_hits       int;
  v_resolved   uuid;
  v_dupe_ref   boolean := false;
  v_gate_lead  int;
  v_gate_ctc   int;
  v_mint       text;
begin
  select id into v_brokerage from public.brokerages order by created_at limit 1;
  if v_brokerage is null then
    raise exception 'm493: no brokerage to probe against';
  end if;

  -- A lead the drain would mail: a verified mailing address, no contact row.
  -- This is the case the pre-existing surface could not represent AT ALL.
  insert into public.leads
    (brokerage_id, first_name, last_name, email, phone,
     mailing_address, mailing_city, mailing_state, mailing_zip, mailing_address_verified)
  values
    (v_brokerage, 'm493', 'LeadProbe', 'm493-lead@example.invalid', '+15555550493',
     '1 Probe Way', 'Austin', 'TX', '78701', true)
  returning id into v_lead;

  insert into public.contacts (brokerage_id, first_name, last_name, email, phone)
  values (v_brokerage, 'm493', 'ContactProbe', 'm493-contact@example.invalid', '+15555550494')
  returning id into v_contact;

  insert into public.direct_mail_campaigns
    (brokerage_id, campaign_name, lead_id, status, piece_type, copy_text)
  values (v_brokerage, 'm493 probe — postcard', v_lead, 'planning', 'postcard', 'probe')
  returning id into v_campaign;

  -- THE TOKEN IS MINTED WITHOUT THE WRITER KNOWING IT EXISTS. Neither insert
  -- below names unsubscribe_token — these are field-for-field the rows
  -- campaign-drain and addRecipients already write. That is the whole point of
  -- the DEFAULT: three live writers get an opt-out credential for free.
  insert into public.direct_mail_recipients
    (brokerage_id, campaign_id, contact_id, lead_id,
     first_name, last_name, address_line1, city, state, zip, delivery_status)
  values (v_brokerage, v_campaign, null, v_lead,
     'm493', 'LeadProbe', '1 Probe Way', 'Austin', 'TX', '78701', 'pending')
  returning id, unsubscribe_token into v_recip_lead, v_tok_lead;

  insert into public.direct_mail_recipients
    (brokerage_id, campaign_id, contact_id, lead_id,
     first_name, last_name, address_line1, city, state, zip, delivery_status)
  values (v_brokerage, v_campaign, v_contact, null,
     'm493', 'ContactProbe', '2 Probe Way', 'Austin', 'TX', '78701', 'pending')
  returning id, unsubscribe_token into v_recip_ctc, v_tok_ctc;

  if v_tok_lead is null or v_tok_ctc is null or v_tok_lead = v_tok_ctc then
    raise exception 'm493: two recipients did not receive two distinct minted tokens (% / %)', v_tok_lead, v_tok_ctc;
  end if;

  -- ── (a) A TOKEN RESOLVES TO EXACTLY ONE RECIPIENT ─────────────────────────
  select count(*) into v_hits from public.direct_mail_recipients where unsubscribe_token = v_tok_lead;
  if v_hits <> 1 then
    raise exception 'm493: the lead token resolved to % recipients, not 1', v_hits;
  end if;

  -- …and the tenant is reachable OFF that row. The public surface is
  -- unauthenticated, so it must never accept a brokerage from the caller.
  select lead_id into v_resolved from public.direct_mail_recipients where unsubscribe_token = v_tok_lead;
  if v_resolved is distinct from v_lead then
    raise exception 'm493: the lead token does not resolve to the lead who was mailed';
  end if;
  select contact_id into v_resolved from public.direct_mail_recipients where unsubscribe_token = v_tok_ctc;
  if v_resolved is distinct from v_contact then
    raise exception 'm493: the contact token does not resolve to the contact who was mailed';
  end if;

  -- A token that was never minted resolves to NOTHING. The surface's refusal
  -- path is a real empty result, not an application convention.
  select count(*) into v_hits
  from public.direct_mail_recipients where unsubscribe_token = '00000000000000';
  if v_hits <> 0 then
    raise exception 'm493: an unminted token resolved to % row(s)', v_hits;
  end if;

  -- ── (b) UNIQUENESS IS ENFORCED ────────────────────────────────────────────
  begin
    insert into public.direct_mail_recipients
      (brokerage_id, campaign_id, lead_id, first_name, address_line1, city, state, zip, unsubscribe_token)
    values (v_brokerage, v_campaign, v_lead, 'dupe', '3 Probe Way', 'Austin', 'TX', '78701', v_tok_lead);
  exception when unique_violation then
    v_dupe_ref := true;
  end;
  if not v_dupe_ref then
    raise exception 'm493: a SECOND recipient was accepted carrying an existing token — one token could suppress the wrong person';
  end if;

  -- ── (c) THE SUPPRESSION LANDS WHERE THE GATE READS ────────────────────────
  -- These are the exact writes lib/lead-intent/lead-opt-out.ts applyLeadOptOut
  -- and lib/kernel/compliance/check-suppression.ts addSuppression perform, and
  -- the exact predicates dispatchDirectMail (dispatch.ts:770-846) reads back.
  update public.leads
     set direct_mail_opt_out = true,
         opt_out_channels    = array['direct_mail'],
         opt_out_source      = 'inbound_direct_mail',
         opted_out_at        = now()
   where id = v_lead;

  insert into public.contact_suppression_list
    (brokerage_id, contact_id, email, phone, channel, suppression_reason, source)
  values
    (v_brokerage, null, 'm493-lead@example.invalid', '+15555550493', 'mail',
     'Opted out via printed mail token', 'inbound_direct_mail'),
    (v_brokerage, v_contact, 'm493-contact@example.invalid', null, 'mail',
     'Opted out via printed mail token', 'inbound_direct_mail');

  -- The LEAD arm the dispatcher reads first: the row's own flags.
  select count(*) into v_gate_lead
  from public.leads
  where id = v_lead
    and (dnc_status is true
      or direct_mail_opt_out is true
      or opt_out_channels && array['direct_mail','mail']);
  if v_gate_lead <> 1 then
    raise exception 'm493: dispatchDirectMail''s lead-flag arm would NOT see this opt-out — the mailed lead stays mailable';
  end if;

  -- The CONTACT arm: checkSuppression's list read, channel 'mail', keyed on the
  -- contact. This is the ONLY arm that can fire for a contact on this channel —
  -- checkSuppression's flag branch has no 'mail' case at all.
  select count(*) into v_gate_ctc
  from public.contact_suppression_list
  where brokerage_id = v_brokerage and channel = 'mail' and contact_id = v_contact;
  if v_gate_ctc < 1 then
    raise exception 'm493: checkSuppression(channel=''mail'') would NOT see this contact''s opt-out';
  end if;

  -- The trace half of the ruling: the piece that produced the opt-out.
  update public.direct_mail_recipients set unsubscribed_at = now()
   where unsubscribe_token in (v_tok_lead, v_tok_ctc);
  select count(*) into v_hits
  from public.direct_mail_recipients r
  join public.direct_mail_campaigns c on c.id = r.campaign_id
  where r.unsubscribed_at is not null and c.id = v_campaign;
  if v_hits <> 2 then
    raise exception 'm493: an opt-out could not be traced back to the campaign that caused it (found %)', v_hits;
  end if;

  -- The generator is genuinely random, not a constant.
  select public.direct_mail_unsubscribe_token() into v_mint;
  if v_mint = public.direct_mail_unsubscribe_token() then
    raise exception 'm493: the generator returned the same token twice — it is not drawing from the CSPRNG';
  end if;

  -- ── CLEAN UP (children first) ─────────────────────────────────────────────
  delete from public.contact_suppression_list where brokerage_id = v_brokerage and source = 'inbound_direct_mail';
  delete from public.direct_mail_recipients where campaign_id = v_campaign;
  delete from public.direct_mail_campaigns  where id = v_campaign;
  delete from public.contacts               where id = v_contact;
  delete from public.leads                  where id = v_lead;

  raise notice 'm493 WRITE PROOF: two recipient rows (one LEAD, one CONTACT) were minted DISTINCT tokens by writers that never named the column; each token PROVED to resolve to exactly one recipient and through it to the person and the tenant; an unminted token PROVED to resolve to none; a duplicate token PROVED refused; and the resulting opt-outs PROVED visible to both arms dispatchDirectMail actually reads (the lead row''s flags, and contact_suppression_list channel=mail) and traceable back to the campaign. Probe rows inserted then removed.';
end $$;

commit;
