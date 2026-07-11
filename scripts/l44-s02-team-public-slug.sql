-- l44-s02 — teams.public_slug (applied live 2026-07-10).
-- The tier audit found TEAMS had no public web presence at all (brokerages
-- got /site/[slug], agents have /p/[agentSlug] — the middle tier was
-- skipped). teams.public_slug powers /team/[slug]: the team's own site
-- (brand, roster, listings) served on the platform origin with zero
-- hosting, same as the brokerage site. Backfilled kebab(name) + id suffix.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS public_slug text;
UPDATE teams SET public_slug =
  left(regexp_replace(lower(coalesce(name, 'team')), '[^a-z0-9]+', '-', 'g'), 48)
  || '-' || left(replace(id::text, '-', ''), 4)
WHERE public_slug IS NULL AND deleted_at IS NULL;
