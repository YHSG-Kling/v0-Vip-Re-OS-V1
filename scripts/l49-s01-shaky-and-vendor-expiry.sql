-- l49-s01 — "deal feels shaky" flag (concierge micro-detail: toggled = the
-- trust system slows down: earned grants suspend, everything goes back to
-- proposals) + time-limited vendor access (concierge §1.7). Ran live 2026-07-13.
alter table public.transactions add column if not exists deal_shaky boolean not null default false;
alter table public.vendors add column if not exists access_expires_at timestamptz;
