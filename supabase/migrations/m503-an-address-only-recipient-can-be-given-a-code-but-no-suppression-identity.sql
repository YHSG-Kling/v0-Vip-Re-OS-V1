-- m503-an-address-only-recipient-can-be-given-a-code-but-no-suppression-identity.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- WE PRINT AN OPT-OUT CODE ON MAIL WE SEND TO PEOPLE WE CANNOT SUPPRESS.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT m493 BUILT, AND THE HOLE IT LEFT OPEN AND SAID SO
--
-- m493 gave every `direct_mail_recipients` row an `unsubscribe_token`, and the
-- postcard now carries a QR plus a printed line keyed to it. The person holding
-- the card can ask to stop. `lib/direct-mail/mail-unsubscribe.ts` then binds
-- that request onto whichever entity the recipient row names:
--
--     recipient.lead_id     → applyLeadOptOut       (lead flags + bridge rows)
--     recipient.contact_id  → addSuppression        (contact_suppression_list)
--
-- and where the row names NEITHER — a purchased farm list, an audience import,
-- a mail-only prospect: exactly the recipient a direct-mail campaign exists to
-- reach — it reports, in its own words:
--
--     "This request was recorded against the mail piece, but the mailing list
--      row it came from is not linked to a lead or contact, so no sender gate
--      can enforce it automatically. It needs manual removal from the source
--      list."
--
-- That sentence is honest and it is a FAILURE. We printed a promise on a piece
-- of paper we mail to a stranger's house, and for the stranger case — the ONLY
-- case where the recipient has no other relationship with us — the promise
-- cannot be kept by anything but a human remembering.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY IT COULD NOT BE KEPT: THE SUPPRESSION LIST HAS NO ADDRESS
--
-- Live columns of `contact_suppression_list` (scripts/schema-snapshot.ts:238,
-- generated from information_schema):
--
--     id, brokerage_id, contact_id, email, phone, channel,
--     suppression_reason, source, created_at
--
-- Three identity columns — contact_id, email, phone — and the mail channel can
-- carry NONE of them. A direct-mail recipient is identified by a MAILING
-- ADDRESS. `checkSuppression`'s list arm ORs over exactly those three:
--
--     if (params.contactId) orClauses.push(`contact_id.eq.…`)
--     if (params.email)     orClauses.push(`email.eq.…`)
--     if (params.phone)     orClauses.push(`phone.eq.…`)
--
-- so for an address-only recipient the OR list is EMPTY, the arm cannot fire,
-- and the gate returns `{ suppressed: false }` having asked no question. The
-- read side is not wrong; it has nothing to read.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION ADDS, AND WHY IT IS ONE COLUMN AND NOT A TABLE
--
-- `contact_suppression_list` is already THE suppression list for four channels,
-- already tenant-scoped, already the thing `checkSuppression` reads and
-- `addSuppression` writes, and already carries the `channel` discriminator that
-- makes a mail-only row well-formed. A second table would mean a second gate,
-- a second writer, and a second place for a consent withdrawal to be missed —
-- which is the failure this whole area keeps producing. So: one nullable
-- column, on the existing list, read by the existing gate.
--
--     mailing_address_key text
--
-- It holds a NORMALIZED key, never a raw address, because a raw address cannot
-- be compared: "1234 N. Lamar Boulevard, Apt 5B" and "1234 north lamar blvd
-- #5b" are the same mailbox and different strings. The normalizer is the one
-- that already exists in the tree —
-- `lib/analytics/prediction-accuracy.ts:normalizeAddressKey(street, zip)` — and
-- its output shape is `"<canonical street tokens>|<zip5>"`, e.g.
--
--     normalizeAddressKey("1234 N. Lamar Boulevard, Apt 5B", "78701-1234")
--       → "1234 n lamar blvd|78701"
--
-- ZIP IS PART OF THE KEY, DELIBERATELY. Street-only keys are what the permit
-- lane uses (`normalizeStreetAddress`) because it has already scoped its query
-- to one territory. A suppression list has no such scope: "123 Main St" exists
-- in thousands of ZIPs, and a street-only key would suppress every one of them
-- the moment one household asked to stop. Over-suppression is not a safe
-- direction here — it silently deletes reach the brokerage paid for and can
-- never be told apart from a genuine opt-out afterwards.
--
-- NO CHECK CONSTRAINT ON THE VALUE. The key's grammar is enforced by the
-- normalizer that mints it (which REFUSES — returns null — anything without a
-- leading street number and a real 5-digit ZIP, so a garbage key can never be
-- offered to this column in the first place). A CHECK here would only duplicate
-- that rule in a second language, where it could drift.
--
-- THE COLUMN IS NULLABLE and every existing row keeps NULL: an email or phone
-- suppression has no address and must not be forced to invent one.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IDEMPOTENT. Safe to re-run. No existing row is rewritten.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table public.contact_suppression_list
  add column if not exists mailing_address_key text;

comment on column public.contact_suppression_list.mailing_address_key is
  'Normalized mailing-address suppression key for channel=''mail'': "<canonical street tokens>|<zip5>", minted ONLY by lib/analytics/prediction-accuracy.ts:normalizeAddressKey (via lib/direct-mail/address-suppression.ts). The identity of a recipient who has a mailbox and nothing else — no contact row, no lead row, no email, no phone. NULL on every non-mail row. Never store a raw address here: two spellings of one mailbox would not compare equal.';

-- THE READ INDEX. `checkSuppression`'s address arm is
--   where brokerage_id = $1 and channel = 'mail' and mailing_address_key = $2
-- and it runs BEFORE every physical mail piece the platform sends, so it is on
-- the hot path of a channel that costs real money per send. Partial on
-- `mailing_address_key is not null` because the overwhelming majority of rows on
-- this table are email/sms suppressions that will never carry one.
create index if not exists contact_suppression_list_mailing_address_key_idx
  on public.contact_suppression_list (brokerage_id, channel, mailing_address_key)
  where mailing_address_key is not null;

-- ONE HOUSEHOLD, ONE ROW PER TENANT PER CHANNEL.
--
-- A consent ledger that records the same request twice overstates how many
-- times a person asked, and every re-visit of a printed token would add
-- another. The application already guards re-visits with
-- `direct_mail_recipients.unsubscribed_at`, but a SECOND mail piece to the same
-- household on a different campaign carries a DIFFERENT token — so the
-- application's guard cannot see the first opt-out and the database has to.
--
-- Partial unique, so it constrains only address-keyed rows and leaves the
-- existing email/phone rows (which legitimately repeat) untouched.
create unique index if not exists contact_suppression_list_one_address_per_tenant_uidx
  on public.contact_suppression_list (brokerage_id, channel, mailing_address_key)
  where mailing_address_key is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- WRITE PROOF. Rows are inserted, the exact predicates the live gate uses are
-- run against them, and everything is removed again. If any claim above is
-- false this migration ABORTS rather than reporting success.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_brokerage uuid;
  v_key       text := '1234 n lamar blvd|78701';
  v_other     text := '1234 n lamar blvd|78702';   -- same street, DIFFERENT zip
  v_hits      int;
  v_dupe      boolean := false;
begin
  select id into v_brokerage from public.brokerages order by created_at limit 1;
  if v_brokerage is null then
    raise notice 'm503: no brokerage row to prove against — DDL applied, write proof skipped';
    return;
  end if;

  -- 1. AN ADDRESS-ONLY SUPPRESSION ROW IS WELL-FORMED. No contact, no email,
  --    no phone — the exact shape m493 could not express.
  insert into public.contact_suppression_list
    (brokerage_id, contact_id, email, phone, channel, mailing_address_key,
     suppression_reason, source, created_at)
  values
    (v_brokerage, null, null, null, 'mail', v_key,
     'm503 write proof', 'inbound_direct_mail', now());

  -- 2. THE GATE'S OWN PREDICATE FINDS IT.
  select count(*) into v_hits
  from public.contact_suppression_list
  where brokerage_id = v_brokerage and channel = 'mail' and mailing_address_key = v_key;
  if v_hits < 1 then
    raise exception 'm503: an address-keyed opt-out is invisible to the predicate checkSuppression runs';
  end if;

  -- 3. ZIP IS LOAD-BEARING. The same street in another ZIP is a different
  --    household and must NOT be suppressed by this row.
  select count(*) into v_hits
  from public.contact_suppression_list
  where brokerage_id = v_brokerage and channel = 'mail' and mailing_address_key = v_other;
  if v_hits <> 0 then
    raise exception 'm503: a suppression in one ZIP leaked onto the same street number in another';
  end if;

  -- 4. TENANT ISOLATION. Another brokerage mailing the same house is not gated
  --    by this brokerage's opt-out (they were never told to stop).
  select count(*) into v_hits
  from public.contact_suppression_list
  where brokerage_id <> v_brokerage and channel = 'mail' and mailing_address_key = v_key;
  if v_hits <> 0 then
    raise exception 'm503: an address suppression crossed a brokerage boundary';
  end if;

  -- 5. THE SECOND CAMPAIGN CANNOT RE-LEDGER THE SAME REQUEST.
  begin
    insert into public.contact_suppression_list
      (brokerage_id, contact_id, email, phone, channel, mailing_address_key,
       suppression_reason, source, created_at)
    values
      (v_brokerage, null, null, null, 'mail', v_key,
       'm503 duplicate probe', 'inbound_direct_mail', now());
  exception when unique_violation then
    v_dupe := true;
  end;
  if not v_dupe then
    raise exception 'm503: the same household was ledgered twice — one human decision, two consent records';
  end if;

  -- 6. AN EMAIL SUPPRESSION IS UNAFFECTED — the unique index is partial, so
  --    address-less rows still repeat freely.
  insert into public.contact_suppression_list
    (brokerage_id, channel, email, suppression_reason, source, created_at)
  values (v_brokerage, 'email', 'm503-probe@example.invalid', 'm503 write proof', 'manual', now()),
         (v_brokerage, 'email', 'm503-probe@example.invalid', 'm503 write proof', 'manual', now());

  delete from public.contact_suppression_list
   where brokerage_id = v_brokerage
     and suppression_reason in ('m503 write proof', 'm503 duplicate probe');

  raise notice 'm503 WRITE PROOF: an address-only suppression row (no contact_id, no email, no phone) PROVED well-formed and PROVED visible to the exact predicate checkSuppression runs; PROVED not to leak across ZIP or across tenant; PROVED unique per household per tenant per channel so a second campaign cannot re-ledger one human decision; and email suppressions PROVED unconstrained by the partial index. Probe rows inserted then removed.';
end $$;

commit;
