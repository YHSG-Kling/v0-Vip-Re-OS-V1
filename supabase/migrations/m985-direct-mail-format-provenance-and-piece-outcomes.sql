-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150R ──
--
-- m985 — FORMAT + TEMPLATE-ID PROVENANCE, PROOF / PREVIEW AND PER-PIECE DELIVERY OUTCOMES ON THE ONE MAIL LEDGER
-- (owner ruling R5, contract C40).
--
-- The ONE direct-mail ledger is direct_mail_campaigns (the campaign / the 1:1 piece) + direct_mail_recipients
-- (the mailing list, one row per printed piece). Before this migration it could not say:
--   · which FORMAT a piece was (letter / personal_letter / postcard / handwritten_card) — piece_type is the
--     campaign vocabulary (lib/direct-mail/piece-type.ts), not the print format;
--   · which GLOBAL Lob template ids (by env NAME, never a value) and which brand tiers a piece mailed with;
--   · whether a proof was rendered (Lob TEST key, zero spend) and who approved the send;
--   · which Lob piece each recipient became — lob_order_id on the campaign names only the FIRST piece, so
--     every later piece's tracking events had nowhere to land;
--   · what each tracking event PROVES. There is deliberately no "received": a carrier scan is evidence about
--     the piece, never household receipt (lib/direct-mail/piece-type.ts mailOutcomeFromLobEvent).
--
-- WRITERS: app/actions/direct-mail.ts sendCampaign (format, provenance, proof, approval, provider_piece_id,
--   idempotency_key) and trackDelivery (delivery_outcome, last_provider_event[_at], expected_delivery_date).
-- READERS: trackDelivery's per-piece settle reads provider_piece_id; the Tracking tab reads the recipient rows
--   (getRecipients selects *). Proof: scripts/direct-mail-formats-guard.ts (test:direct-mail-formats).
-- After apply: regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts and scripts/check-vocabularies.ts
--   (two new CHECKs below) from the live catalog.

begin;

-- ── direct_mail_campaigns ─────────────────────────────────────────────────────
alter table public.direct_mail_campaigns
  add column if not exists mail_format          text,
  add column if not exists template_provenance  jsonb,
  add column if not exists proof_status         text,
  add column if not exists proof_url            text,
  add column if not exists proof_rendered_at    timestamptz,
  add column if not exists approved_by_user_id  uuid references public.users(id) on delete set null,
  add column if not exists approved_at          timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'direct_mail_campaigns_mail_format_check') then
    alter table public.direct_mail_campaigns add constraint direct_mail_campaigns_mail_format_check
      check (mail_format is null or mail_format in ('letter', 'personal_letter', 'postcard', 'handwritten_card'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'direct_mail_campaigns_proof_status_check') then
    alter table public.direct_mail_campaigns add constraint direct_mail_campaigns_proof_status_check
      check (proof_status is null or proof_status in ('rendered', 'refused', 'unavailable'));
  end if;
end $$;

comment on column public.direct_mail_campaigns.mail_format is
  'The PRINT format (piece-type.ts MAIL_FORMATS). personal_letter is a printed note set in a personal-note typeface — never handwriting; handwritten_card only through an active handwriting provider (none is active).';
comment on column public.direct_mail_campaigns.template_provenance is
  'Which global Lob template slots by env NAME (never a value), whether a legacy env name was read, the brand tiers (resolveBrandContext.source) and missing brand fields the piece mailed with. household_receipt_claimed is always false.';
comment on column public.direct_mail_campaigns.proof_url is
  'The signed Lob proof PDF rendered with the TEST key (lib/providers/lob/client.ts createLobProof — a live key is refused). No spend.';

-- ── direct_mail_recipients ────────────────────────────────────────────────────
alter table public.direct_mail_recipients
  add column if not exists provider_piece_id       text,
  add column if not exists idempotency_key         text,
  add column if not exists delivery_outcome        text,
  add column if not exists last_provider_event     text,
  add column if not exists last_provider_event_at  timestamptz,
  add column if not exists expected_delivery_date  date;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'direct_mail_recipients_delivery_outcome_check') then
    alter table public.direct_mail_recipients add constraint direct_mail_recipients_delivery_outcome_check
      check (delivery_outcome is null or delivery_outcome in (
        'accepted', 'rendered', 'mailed', 'in_transit', 'in_local_area', 'processed_for_delivery',
        'delivered_per_carrier_scan', 're_routed', 'returned_to_sender', 'cancelled', 'unknown'));
  end if;
end $$;

-- One piece per key, and one recipient per provider piece (the settle target).
create unique index if not exists direct_mail_recipients_idempotency_key_uq
  on public.direct_mail_recipients (idempotency_key) where idempotency_key is not null;
create index if not exists direct_mail_recipients_provider_piece_idx
  on public.direct_mail_recipients (brokerage_id, provider_piece_id) where provider_piece_id is not null;

comment on column public.direct_mail_recipients.delivery_outcome is
  'What the latest Lob tracking event PROVES about the piece (piece-type.ts mailOutcomeFromLobEvent). delivered_per_carrier_scan is the carrier''s scan, never household receipt; there is no received/read value on purpose.';

-- Read-back (the integrator runs it after apply):
--   select column_name from information_schema.columns where table_schema='public'
--     and table_name in ('direct_mail_campaigns','direct_mail_recipients')
--     and column_name in ('mail_format','template_provenance','proof_status','proof_url','proof_rendered_at',
--       'approved_by_user_id','approved_at','provider_piece_id','idempotency_key','delivery_outcome',
--       'last_provider_event','last_provider_event_at','expected_delivery_date');   -- expect 13 rows
--   select conname from pg_constraint where conname in ('direct_mail_campaigns_mail_format_check',
--     'direct_mail_campaigns_proof_status_check','direct_mail_recipients_delivery_outcome_check'); -- expect 3

commit;
