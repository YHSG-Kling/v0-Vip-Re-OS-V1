-- m099 — Apify actor health registry (resilience layer).
--
-- Public Apify actors come and go. runApifyTask (lib/external/apify-actors.ts)
-- auto-switches across candidate actors at runtime; the actor-health cron
-- (/api/cron/actor-health) probes each candidate and records alive/dead here so
-- platform admins get proactive visibility when a registry entry needs a new
-- fallback. Platform-owned; only platform admins read it.
CREATE TABLE IF NOT EXISTS public.scraper_actor_health (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task         text NOT NULL,
  actor_id     text NOT NULL,
  alive        boolean NOT NULL DEFAULT true,
  last_checked timestamptz DEFAULT now(),
  last_error   text,
  UNIQUE (task, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_scraper_actor_health_alive ON public.scraper_actor_health (alive);

ALTER TABLE public.scraper_actor_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY scraper_actor_health_select ON public.scraper_actor_health
  FOR SELECT USING (is_platform_admin());
CREATE POLICY scraper_actor_health_write ON public.scraper_actor_health
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
