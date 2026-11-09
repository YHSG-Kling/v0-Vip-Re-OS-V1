-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151H ──
--
-- m981 — DELIVERY TRUTH EVIDENCE: THE SPEND PREVIEW THAT CLEARED A SEND, AND WHAT A RETURNED PIECE CHANGED
-- (directive 151H: "Separate 'API accepted', 'charge settled', 'printed', 'mailed', 'delivered' and 'returned'; a successful
-- HTTP response is not proof of delivery. … spend guard, … returned-mail handling.")
--
-- WHAT THE CODE NOW WRITES:
--   · public.direct_mail_campaigns.spend_preview — the whole-batch spend verdict taken BEFORE the first piece (pieces × the ONE
--     Lob price, the tenant's budget verdict from lib/billing/billing-access.ts mayUseAndAfford, the remaining budget, and after
--     the send the dispatched / failed counts). WRITER: app/actions/direct-mail.ts sendCampaign (piece-type.ts campaignSendGate;
--     a SEPARATE write). READER: the campaigns tab (getMailCampaigns selects *) and the preview response.
--   · public.direct_mail_recipients.return_handling — what a returned_to_sender piece changed: the lead / contact address record
--     un-verified with source lob_returned_to_sender, the pending siblings to the same mailbox stopped, an address-only
--     recipient's mailbox suppressed, with counts and errors. WRITER: lib/direct-mail/piece-type.ts applyReturnedMailHandling
--     (called by app/actions/direct-mail.ts trackDelivery from the Lob webhook). READER: getRecipients (selects *) → the
--     Recipients / Tracking tabs.
--
-- The six delivery truths themselves need no new column: they are READ off direct_mail_recipients.delivery_outcome (m985) by
-- piece-type.ts mailPieceTruth — accepted ≠ printed (Lob reports no print event) ≠ mailed ≠ delivered-per-carrier-scan ≠
-- returned, and the charge is the action ledger's settlement (agent_action_ledger.cost_usd / settled_at), never the outcome.
--
-- Live rows before (2026-11-09): direct_mail_campaigns 0 rows with a spend preview (no column); direct_mail_recipients 0 rows with
-- return handling (no column). Nothing to backfill.
--
-- After apply: regenerate scripts/schema-snapshot.ts from the live catalog (no CHECK, no FK here).

begin;

alter table public.direct_mail_campaigns
  add column if not exists spend_preview jsonb;

comment on column public.direct_mail_campaigns.spend_preview is
  'The whole-batch spend verdict taken before the first piece (pieces, unit_cost_usd, estimated_cost_usd, budget_reason, remaining_budget_usd, budget_degraded, previewed_at; after the send pieces_dispatched / pieces_failed). lib/direct-mail/piece-type.ts campaignSendGate (wave 151, lane 151H).';

alter table public.direct_mail_recipients
  add column if not exists return_handling jsonb;

comment on column public.direct_mail_recipients.return_handling is
  'What a returned_to_sender piece changed (lib/direct-mail/piece-type.ts applyReturnedMailHandling): entity address record un-verified (source lob_returned_to_sender), pending siblings to the same mailbox stopped, address-only mailbox suppressed; counts, errors, handled_at (wave 151, lane 151H).';

-- Read-back (the integrator ran it 2026-11-09: 2 rows):
--   select table_name, column_name from information_schema.columns where table_schema='public'
--     and ((table_name='direct_mail_campaigns' and column_name='spend_preview')
--       or (table_name='direct_mail_recipients' and column_name='return_handling'));   -- expect 2 rows

commit;
