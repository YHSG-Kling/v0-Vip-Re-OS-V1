-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145G ──
--
-- m867 — book_projects: A BOOK IS ITS OWN ENTITY, NOT A LEAD MAGNET (wave 145, lane 145G; owner ruling 19, 2026-10-27:
-- "A lead magnet is a guide, a video, etc. which is not a manuscript or book which has many sections/chapters and is created
-- for publication").
--
-- THE DEFECT. Waves 142-144 built the book pipeline (lib/lead-magnets/book-creator.ts research → outline → chapters → fact
-- check → edit → layout; lib/lead-magnets/book-publishing-produce.ts the KDP package) ON a lead magnet: every book was a
-- lead_capture_forms row (magnet_type buyer_guide / seller_guide) whose settings.book held the whole manuscript and whose
-- settings.book_publishing held the KDP package. A platform KDP book or a tenant's retail book was therefore a capture form
-- that happened to carry a manuscript — the two capabilities shared one entity and one lifecycle.
--
-- THE FIX (extend the survivor — the pipeline, its stages, its project record shape and its gates are unchanged): the project
-- record moves to its OWN row here, owned the way the ruling says (platform / brokerage / team / agent), with its own
-- editorial stage and publication context. A book DISTRIBUTED as a lead magnet keeps this entity and its workflow; the capture
-- form it rides carries only a pointer (lead_capture_forms.settings.book_id) and its landing copy. A KDP-only book needs no
-- capture form at all.
--
-- Writer: lib/lead-magnets/book-entity.ts (createBookProject / saveBookProject / attachDistribution), called by book-creator.ts
-- (start, advance, revise, sweep) and book-publishing-produce.ts (the KDP package). Readers: the same + lib/kernel/lead-magnets.ts
-- (the publish gate and the delivery of a distributed book) + app/actions/lead-magnets-actions.ts (the review surface).
-- Live 2026-10-27: lead_capture_forms rows carrying settings.book = 0, so PART 3's backfill is a no-op today; it is here so a
-- book started between this file and its application is carried, never stranded.
--
-- After applying: regenerate schema-snapshot, live-tables, the FK map AND scripts/check-vocabularies.ts (four CHECKs), and add
-- TABLE_MANAGER 'book_projects' -> campaign_orchestrator (co-owned with asset_manager, compliance_officer).

-- PART 1 — the entity.
CREATE TABLE IF NOT EXISTS public.book_projects (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the tenant it is MADE in (a platform book is made in the platform's house tenant — brokerages.is_demo; owner item)
  brokerage_id          uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  owner_scope           text        NOT NULL
    CONSTRAINT book_projects_owner_scope_check CHECK (owner_scope IN ('platform', 'brokerage', 'team', 'agent')),
  team_id               uuid        NULL REFERENCES public.teams(id) ON DELETE SET NULL,
  agent_id              uuid        NULL REFERENCES public.agents(id) ON DELETE SET NULL,
  created_by            uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  title                 text        NOT NULL,
  audience              text        NOT NULL
    CONSTRAINT book_projects_audience_check CHECK (audience IN ('buyer', 'seller')),
  publication_context   text        NOT NULL DEFAULT 'lead_magnet'
    CONSTRAINT book_projects_publication_context_check CHECK (publication_context IN ('lead_magnet', 'tenant_kdp', 'platform_kdp')),
  stage                 text        NOT NULL DEFAULT 'research'
    CONSTRAINT book_projects_stage_check CHECK (stage IN ('research', 'outline', 'chapters', 'fact_check', 'edit', 'layout', 'ready_for_review')),
  -- the manuscript project record (lib/lead-magnets/book-creator.ts BookProject — the shape is unchanged)
  project               jsonb       NOT NULL,
  -- the KDP package record (lib/lead-magnets/book-publishing-produce.ts KdpPackageRecord), null until built
  publishing            jsonb       NULL,
  -- the capture form that DISTRIBUTES this book (null = not distributed as a lead magnet)
  distribution_form_id  uuid        NULL REFERENCES public.lead_capture_forms(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- an agent-owned book names its agent; a platform book is never an agent's
  CONSTRAINT book_projects_owner_shape CHECK (
    (owner_scope <> 'agent' OR agent_id IS NOT NULL) AND (owner_scope <> 'team' OR team_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.book_projects IS
  'Wave 145 (145G, owner ruling 19): a BOOK — a multi-chapter manuscript made for publication — is its own entity, owned by the platform / brokerage / team / agent, with its own editorial stage and publication context (lead_magnet / tenant_kdp / platform_kdp). A book distributed as a lead magnet keeps this row; the capture form carries settings.book_id only. Writer: lib/lead-magnets/book-entity.ts.';

-- PART 2 — indexes + RLS.
CREATE UNIQUE INDEX IF NOT EXISTS book_projects_distribution_form_uidx
  ON public.book_projects (distribution_form_id) WHERE distribution_form_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS book_projects_tenant_stage_idx ON public.book_projects (brokerage_id, stage, updated_at);

ALTER TABLE public.book_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY book_projects_tenant_read ON public.book_projects
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

-- writes only through the service role behind the session-gated actions / the pipeline (entitlement + ledger evidence)
REVOKE INSERT, UPDATE, DELETE ON public.book_projects FROM authenticated, anon;
GRANT SELECT ON public.book_projects TO authenticated;

-- PART 3 — carry any book still living on a capture form onto its own row, then leave the form a pointer.
INSERT INTO public.book_projects (brokerage_id, owner_scope, agent_id, created_by, title, audience, publication_context, stage, project, publishing, distribution_form_id, created_at, updated_at)
SELECT f.brokerage_id,
       CASE COALESCE(f.settings->'book'->'publication'->>'owner', CASE WHEN f.agent_id IS NULL THEN 'brokerage' ELSE 'agent' END)
         WHEN 'platform' THEN 'platform' WHEN 'agent' THEN CASE WHEN f.agent_id IS NULL THEN 'brokerage' ELSE 'agent' END ELSE 'brokerage' END,
       f.agent_id,
       NULLIF(f.settings->'book'->>'started_by', '')::uuid,
       COALESCE(NULLIF(f.settings->'book'->>'title', ''), f.name, 'Untitled book'),
       CASE WHEN f.settings->'book'->>'audience' = 'buyer' THEN 'buyer' ELSE 'seller' END,
       COALESCE(NULLIF(f.settings->'book'->'publication'->>'context', ''), 'lead_magnet'),
       COALESCE(NULLIF(f.settings->'book'->>'stage', ''), 'research'),
       f.settings->'book',
       f.settings->'book_publishing',
       f.id,
       COALESCE(f.created_at, now()),
       now()
  FROM public.lead_capture_forms f
 WHERE f.settings ? 'book'
   AND NOT EXISTS (SELECT 1 FROM public.book_projects b WHERE b.distribution_form_id = f.id);

UPDATE public.lead_capture_forms f
   SET settings = (f.settings - 'book' - 'book_publishing') || jsonb_build_object('book_id', b.id::text)
  FROM public.book_projects b
 WHERE b.distribution_form_id = f.id
   AND f.settings ? 'book';

-- VERIFY (read-only, after applying):
--   SELECT count(*) FROM public.lead_capture_forms WHERE settings ? 'book';            -- 0
--   SELECT count(*) FROM public.lead_capture_forms f WHERE settings ? 'book_id'
--     AND NOT EXISTS (SELECT 1 FROM public.book_projects b WHERE b.id::text = f.settings->>'book_id');  -- 0
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.book_projects'::regclass ORDER BY 1;
