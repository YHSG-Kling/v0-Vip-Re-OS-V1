-- l53-s01 — "REASON FOR TODAY'S OUTREACH" (concierge A.9): every proposed
-- client touch carries its one-word why; vocabulary governed in code
-- (lib/kernel/outreach-reasons.ts) like the signal registry — no DB CHECK.
-- Ran live 2026-07-13.
alter table public.agent_client_messages add column if not exists outreach_reason text;
