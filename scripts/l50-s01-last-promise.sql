-- l50-s01 — "LAST PROMISE MADE" (concierge A.3: a single field storing the
-- last explicit promise to each client; the OS will not let it silently age
-- out). Ran live 2026-07-13.
alter table public.contacts
  add column if not exists last_promise text,
  add column if not exists last_promise_at timestamptz;
