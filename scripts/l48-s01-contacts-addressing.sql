-- l48-s01 — ADDRESSING MEMORY (the luxury-details doc: "name-pronunciation and
-- preferred-salutation memory — capture how clients prefer to be addressed,
-- then ensure every message aligns with that"). Ran live 2026-07-13.
alter table public.contacts
  add column if not exists preferred_name text,
  add column if not exists name_pronunciation text,
  add column if not exists salutation_style text;
