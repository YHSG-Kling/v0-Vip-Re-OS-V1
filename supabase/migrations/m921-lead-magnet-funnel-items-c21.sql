-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148G ──
--
-- m921 — lead_magnet_funnel_items: THE C21 FUNNEL PACKAGE'S ITEMS (wave 148, lane 148G — owner ruling 11, 2026-11-01:
-- "the lead magnets first create the landing pages, forms … and then what the deliverables will need to be … it could be an
-- education video and deliverables can be a funnel with a thank-you, video along with a calendar link, etc. … Some magnet assets
-- can be staged.").
--
-- WHY A TABLE (and not lead_capture_forms.settings, and not more rows in lead_magnet_deliverables):
--   · lead_magnet_deliverables (m898, C11) is THE primary asset of a magnet — one READY per magnet (its partial unique index) —
--     and the C4 promise is made against it. It stays exactly that: a funnel's PRIMARY is still produced there (m898's trigger,
--     extended below, still requires it). Widening it to many assets per magnet would need DROP INDEX (owner SQL) and would blur
--     "the asset the promise delivers" with the bonuses and arrangements around it.
--   · a funnel's OTHER deliverables and its thank-you steps each need a status, a promise flag, the arrangement that keeps a
--     non-asset promise (a scheduled session, a sequence enrolment, an agent's due task), FKs to the produced asset (document /
--     video project) and a ready / arranged SHAPE the publish gate and the activation trigger can read without parsing jsonb.
--
-- WRITER: lib/lead-magnets/magnet-funnel.ts (createMagnetFunnel, refreshFunnelItems, recordFunnelApproval,
-- recoverMagnetFunnelAssets). READERS: the same module's publish gate (lib/kernel/lead-magnets.ts publishLeadMagnet), the C4
-- delivery bundle (lib/lead-magnets/promised-deliverables.ts deliverPromised) and the follow-through.
--
-- After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts (FKs: brokerages,
-- lead_capture_forms, generated_documents, ai_video_projects, lead_magnet_deliverables, users) and scripts/check-vocabularies.ts
-- (role, kind, fulfilment, status). scripts/agent-fk-columns.ts is unchanged (no agents FK).

CREATE TABLE IF NOT EXISTS public.lead_magnet_funnel_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id     uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  form_id          uuid        NOT NULL REFERENCES public.lead_capture_forms(id) ON DELETE CASCADE,
  item_key         text        NOT NULL,
  role             text        NOT NULL
    CONSTRAINT lead_magnet_funnel_items_role_check CHECK (role IN ('primary', 'deliverable', 'step')),
  -- FUNNEL_DELIVERABLE_KINDS (the C4 / C11 asset kinds + calculator, webinar, mini_course, consultation) + FUNNEL_STEP_KINDS
  kind             text        NOT NULL
    CONSTRAINT lead_magnet_funnel_items_kind_check
    CHECK (kind IN ('guide', 'book', 'report', 'valuation', 'checklist', 'video', 'calculator', 'webinar', 'mini_course', 'consultation',
                    'personal_video', 'calendar_link', 'portal_task', 'education_sequence')),
  fulfilment       text        NOT NULL
    CONSTRAINT lead_magnet_funnel_items_fulfilment_check CHECK (fulfilment IN ('asset', 'arrangement', 'human')),
  status           text        NOT NULL DEFAULT 'planned'
    CONSTRAINT lead_magnet_funnel_items_status_check
    CHECK (status IN ('planned', 'producing', 'staged', 'ready', 'arranged', 'failed', 'withdrawn')),
  -- named on the public page (only ready / arranged secondaries are promised; the primary always is)
  promised         boolean     NOT NULL DEFAULT false,
  position         integer     NOT NULL DEFAULT 0,
  title            text        NULL,
  promise_line     text        NULL,
  -- the mechanism that keeps a non-asset promise (calendar_offer · agent_callback · agent_prepared_value · scheduled_session ·
  -- sequence_enrollment · portal_financial_tools · portal_card · personal_reel_staged) and its enforcement
  arrangement      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  asset_url        text        NULL,
  document_id      uuid        NULL REFERENCES public.generated_documents(id) ON DELETE SET NULL,
  video_project_id uuid        NULL REFERENCES public.ai_video_projects(id) ON DELETE SET NULL,
  deliverable_id   uuid        NULL REFERENCES public.lead_magnet_deliverables(id) ON DELETE SET NULL,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  validation       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  approver         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  approved_by      uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at      timestamptz NULL,
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NULL,
  error            text        NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_magnet_funnel_items_form_key_unique UNIQUE (form_id, item_key),
  -- `ready` is never a bare flag: validated, and (for a system asset) hosted over https
  CONSTRAINT lead_magnet_funnel_items_ready_shape
    CHECK (status <> 'ready' OR ((validation ->> 'ok') = 'true' AND (fulfilment <> 'asset' OR asset_url ~ '^https://'))),
  -- `arranged` is never a bare flag either: a non-asset fulfilment with its mechanism
  CONSTRAINT lead_magnet_funnel_items_arranged_shape
    CHECK (status <> 'arranged' OR (fulfilment IN ('arrangement', 'human') AND arrangement ? 'mechanism')),
  -- a planned / withdrawn item is never promised on the page
  CONSTRAINT lead_magnet_funnel_items_promised_shape
    CHECK (NOT promised OR status NOT IN ('planned', 'withdrawn'))
);

COMMENT ON TABLE public.lead_magnet_funnel_items IS
  'Wave 148 (148G, owner ruling 11, contract C21): the items of a lead-magnet funnel package — the primary (mirroring its C11 deliverable), the other deliverables of any kind (staged allowed, never promised before ready) and the thank-you steps (personal video, calendar, portal task, education sequence) with the arrangement that keeps each non-asset promise. A funnel magnet activates only when every promised item is ready or arranged (trigger lead_capture_forms_require_ready_deliverable). Writer: lib/lead-magnets/magnet-funnel.ts.';

CREATE INDEX IF NOT EXISTS lead_magnet_funnel_items_tenant_form_idx
  ON public.lead_magnet_funnel_items (brokerage_id, form_id, position);
-- the recovery's queue (staged / failed / producing primaries and deliverables, oldest first)
CREATE INDEX IF NOT EXISTS lead_magnet_funnel_items_recovery_idx
  ON public.lead_magnet_funnel_items (status, updated_at) WHERE status IN ('staged', 'failed', 'producing');

ALTER TABLE public.lead_magnet_funnel_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_magnet_funnel_items_tenant_read ON public.lead_magnet_funnel_items;
CREATE POLICY lead_magnet_funnel_items_tenant_read ON public.lead_magnet_funnel_items
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.lead_magnet_funnel_items FROM authenticated, anon;
GRANT SELECT ON public.lead_magnet_funnel_items TO authenticated;

-- THE DATABASE GATE, EXTENDED FOR FUNNELS (C11 + C21). m898's rule is kept byte-for-byte in meaning — an asset-promising magnet
-- type never activates without its own ready deliverable — and two funnel rules are added:
--   (1) a funnel (settings.funnel.primary declared) needs its ready primary deliverable whatever routing type it carries;
--   (2) a funnel never activates while any PROMISED item is not ready / arranged.
-- SECURITY DEFINER so the check sees the rows regardless of the writer's RLS; search_path pinned.
CREATE OR REPLACE FUNCTION public.lead_capture_forms_require_ready_deliverable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active IS TRUE AND (TG_OP = 'INSERT' OR OLD.is_active IS DISTINCT FROM TRUE) THEN
    IF (NEW.magnet_type IN ('buyer_guide', 'seller_guide', 'market_report', 'home_valuation')
        OR (NEW.settings -> 'funnel' -> 'primary') IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM public.lead_magnet_deliverables d
         WHERE d.form_id = NEW.id AND d.brokerage_id = NEW.brokerage_id AND d.status = 'ready'
       )
    THEN
      RAISE EXCEPTION 'lead magnet % cannot be published: its delivery asset is not ready (owner ruling 5 — the asset is created with the magnet)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.lead_magnet_funnel_items i
      WHERE i.form_id = NEW.id AND i.brokerage_id = NEW.brokerage_id AND i.promised AND i.status NOT IN ('ready', 'arranged')
    )
    THEN
      RAISE EXCEPTION 'lead magnet funnel % cannot be published: a promised deliverable is not ready or arranged (owner ruling 11 — contract C21)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.lead_capture_forms_require_ready_deliverable() FROM PUBLIC, anon, authenticated;
-- the trigger itself (m898) is unchanged: BEFORE INSERT OR UPDATE OF is_active ON public.lead_capture_forms

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.lead_magnet_funnel_items'::regclass ORDER BY 1;
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.lead_magnet_funnel_items'::regclass;
--   SELECT prosrc LIKE '%lead_magnet_funnel_items%' AS funnel_rule FROM pg_proc WHERE proname = 'lead_capture_forms_require_ready_deliverable';
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.lead_capture_forms'::regclass AND NOT tgisinternal;
--   -- live census before / after (no row changes): every active magnet is untouched by this migration
--   SELECT count(*) FILTER (WHERE is_active) AS active, count(*) FILTER (WHERE settings ? 'funnel') AS funnels FROM public.lead_capture_forms;
