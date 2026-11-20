-- ── APPLIED LIVE 2026-10-29 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 146, lane 146B ──
--
-- m876 — ONE INBOUND RECORD PER (tenant, provider, provider reference) ON THE CONTACT TIMELINE
--
-- Owner ruling 3 (2026-10-29): "communication should be able to track both incoming and outgoing no matter which channel
-- is used" — every inbound event lands in ONE canonical history, DEDUPLICATED. Contract C1
-- (lib/communications/inbound-record.ts recordInboundCommunication) writes an inbound to public.messages with
-- metadata.provider + metadata.provider_ref and reads for that pair before it writes. That read cannot stop two concurrent
-- deliveries of the same provider event (Meta, X, LinkedIn and Twilio all deliver at least once, and retry within seconds);
-- this index is the database's answer to the race: the second insert is refused 23505, which the record reads as
-- "duplicate" (never a second row, never a second reply).
--
-- The lead side already has its equivalent (m488: lead_conversation_history_provider_ref_uniq on
-- (lead_id, metadata->>'provider_ref')). The SMS recorder (lib/voice/sms-inbound.ts) keys on metadata.message_sid and
-- C1 writes message_sid beside provider_ref for Twilio, so both writers of an inbound text agree on one key.
--
-- PARTIAL: outbound rows and inbound rows without a provider reference are untouched (an outbound reply carries
-- provider_message_id, not provider_ref; a legacy inbound row carries neither).
--
-- PRECONDITION (read live 2026-10-29, hrvaqgvukzxfskkcrwbt): public.messages holds 0 rows — no existing duplicate can
-- fail the build. Re-check before applying:
--   SELECT brokerage_id, metadata->>'provider' AS provider, metadata->>'provider_ref' AS ref, count(*)
--     FROM public.messages
--    WHERE direction = 'inbound' AND metadata->>'provider_ref' IS NOT NULL
--    GROUP BY 1, 2, 3 HAVING count(*) > 1;            -- expect 0 rows
--
-- No table, column, CHECK or FK is added — schema-snapshot / check-vocabularies / schema-fk-map are unchanged.

CREATE UNIQUE INDEX IF NOT EXISTS messages_inbound_provider_ref_uniq
  ON public.messages (brokerage_id, (metadata->>'provider'), (metadata->>'provider_ref'))
  WHERE direction = 'inbound' AND (metadata->>'provider_ref') IS NOT NULL;

-- VERIFY:
--   SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'messages_inbound_provider_ref_uniq';
--   -- expect: CREATE UNIQUE INDEX messages_inbound_provider_ref_uniq ON public.messages USING btree (brokerage_id, ((metadata ->> 'provider'::text)), ((metadata ->> 'provider_ref'::text))) WHERE (((direction)::text = 'inbound'::text) AND ((metadata ->> 'provider_ref'::text) IS NOT NULL))
--
-- ROLLBACK (owner SQL-editor — DROP INDEX is owner-only per the preamble):
--   DROP INDEX IF EXISTS public.messages_inbound_provider_ref_uniq;
