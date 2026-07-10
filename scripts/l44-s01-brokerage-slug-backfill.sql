-- l44-s01 — brokerages.slug BACKFILL (applied live 2026-07-10).
-- The tenant-website audit found ZERO live brokerages carried a slug —
-- /recruiting/[slug] had been unreachable for every real tenant, and the
-- new /site/[slug] tenant website (the "website with zero hosting" loop
-- closer) keys on the same column. Backfilled kebab(name) + a 4-char id
-- suffix (uniqueness by construction); signup now sets slug at insert so
-- every future tenant has their website live from day one.
UPDATE brokerages SET slug =
  left(regexp_replace(lower(coalesce(name, 'brokerage')), '[^a-z0-9]+', '-', 'g'), 48)
  || '-' || left(replace(id::text, '-', ''), 4)
WHERE slug IS NULL AND deleted_at IS NULL;
