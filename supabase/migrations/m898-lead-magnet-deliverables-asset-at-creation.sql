-- ── APPLIED LIVE 2026-10-31 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 147, lane 147E ──
--
-- m898 — lead_magnet_deliverables: THE ASSET IS CREATED WITH THE LEAD MAGNET (wave 147, lane 147E — owner ruling 5,
-- 2026-10-31: "when lead magnets are created, the asset for delivery is always created at the same time"; contract C11).
--
-- WHY A NEW TABLE (orphan doctrine §1.2, audited live 2026-10-31 — to_regclass('public.lead_magnet_deliverables') is null;
-- lead_capture_forms has 1 row, magnet_type NULL; lead_magnet_promises 0; generated_documents 0):
--   · lead_magnet_promises (m883, C4) is PER REQUEST — one row per person who asked. The deliverable is PER MAGNET (and per
--     version): produced once when the magnet is created, validated, approved, then delivered to every requester. Putting it on
--     the promise would mean no row exists until the first person asks — exactly the state ruling 5 forbids.
--   · lead_capture_forms.settings (jsonb) could hold a status, but it cannot carry a one-ready-per-magnet index, a shape CHECK,
--     an FK to the hosted document, or be read by the activation trigger below without parsing the whole bag; and every
--     settings writer would have to preserve it.
--   · generated_documents is the hosted file's library row (document_id below FKs it); it has no status, version, approval or
--     validation, and a valuation deliverable (a person fulfils it) has no file at all.
--
-- THE INVARIANT, in the database (not only in the app): an asset-promising magnet (buyer_guide, seller_guide, market_report,
-- home_valuation — lib/lead-magnets/deliverable-asset.ts ASSET_PROMISING_MAGNET_TYPES, held equal by
-- scripts/lead-magnet-asset-invariant-guard.ts) cannot become ACTIVE (INSERT active, or is_active false → true) without a
-- `ready` deliverable of its own in its own tenant. Legacy magnets already active stay active (no transition happens) and keep
-- C4's recovery path; pausing and resuming one requires the asset.
--
-- Writer + readers: lib/lead-magnets/deliverable-asset.ts (produceLeadMagnetDeliverable / ensureDeliverableForPublish /
-- recordDeliverableApproval / readyDeliverableFor / deliverableById), called by lib/kernel/lead-magnets.ts createLeadMagnet /
-- publishLeadMagnet and lib/lead-magnets/promised-deliverables.ts. Service-role writes only; tenant members read their own.
--
-- After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts (4 FKs below) and
-- scripts/check-vocabularies.ts (kind, fulfilment, status), and add TABLE_MANAGER 'lead_magnet_deliverables' ->
-- campaign_orchestrator (lane 147I). agent-fk-columns.ts unchanged (no agents FK).

CREATE TABLE IF NOT EXISTS public.lead_magnet_deliverables (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  form_id       uuid        NOT NULL REFERENCES public.lead_capture_forms(id) ON DELETE CASCADE,
  version       integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- the C4 promise kinds — one vocabulary with lead_magnet_promises.asset_kind (m883)
  kind          text        NOT NULL
    CONSTRAINT lead_magnet_deliverables_kind_check
    CHECK (kind IN ('guide', 'book', 'report', 'valuation', 'checklist', 'video')),
  -- 'asset' = a hosted file the system produced; 'human' = a person prepares each one (an agent-prepared value)
  fulfilment    text        NOT NULL DEFAULT 'asset'
    CONSTRAINT lead_magnet_deliverables_fulfilment_check CHECK (fulfilment IN ('asset', 'human')),
  status        text        NOT NULL DEFAULT 'producing'
    CONSTRAINT lead_magnet_deliverables_status_check
    CHECK (status IN ('producing', 'staged', 'ready', 'failed', 'superseded')),
  title         text        NULL,
  asset_url     text        NULL,
  document_id   uuid        NULL REFERENCES public.generated_documents(id) ON DELETE SET NULL,
  -- the note that carries the asset ({ subject, title, body }) — passes the C4 final phase at delivery
  cover_note    jsonb       NULL,
  -- what was produced: the market report's territory / topic + evidence / counts / staged video; the guide's provenance
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- the validator's verdict ({ ok, checks | counts, warnings }) — `ready` requires ok
  validation    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- C5: who may approve it (basis, tier, reason) and who did
  approver      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  approved_by   uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at   timestamptz NULL,
  -- deliberately NO FK: one caller (app/actions/creative-playbooks.ts) passes an agents.id as createdBy (Outside-lane in the
  -- 147E notes) — an FK would refuse the deliverable record and roll the magnet back; provenance, not authority
  produced_by   uuid        NULL,
  error         text        NULL,
  produced_at   timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_magnet_deliverables_form_version_unique UNIQUE (form_id, version),
  -- `ready` is never a bare flag: validated, produced, and (for a system asset) hosted over https with its cover note
  CONSTRAINT lead_magnet_deliverables_ready_shape
    CHECK (status <> 'ready' OR (
      produced_at IS NOT NULL
      AND (validation ->> 'ok') = 'true'
      AND (fulfilment = 'human' OR (asset_url ~ '^https://' AND cover_note IS NOT NULL))
    ))
);

COMMENT ON TABLE public.lead_magnet_deliverables IS
  'Wave 147 (147E, owner ruling 5, contract C11): the delivery asset of a lead magnet, produced and validated when the magnet is created (one row per version; one ready per magnet). An asset-promising magnet cannot activate without a ready deliverable (trigger lead_capture_forms_require_ready_deliverable). Writer: lib/lead-magnets/deliverable-asset.ts.';

-- ONE ready version per magnet (the writer supersedes the previous ready version before marking the new one ready).
CREATE UNIQUE INDEX IF NOT EXISTS lead_magnet_deliverables_one_ready_idx
  ON public.lead_magnet_deliverables (form_id) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS lead_magnet_deliverables_tenant_form_idx
  ON public.lead_magnet_deliverables (brokerage_id, form_id, version DESC);

ALTER TABLE public.lead_magnet_deliverables ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_magnet_deliverables_tenant_read ON public.lead_magnet_deliverables
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.lead_magnet_deliverables FROM authenticated, anon;
GRANT SELECT ON public.lead_magnet_deliverables TO authenticated;

-- THE DATABASE GATE (C11): no asset-promising magnet becomes active without its own ready deliverable, whoever writes it.
-- SECURITY DEFINER so the check sees the deliverable rows regardless of the writer's RLS (a check that cannot see is a check
-- that refuses everything — or, worse, one someone weakens); search_path pinned.
CREATE OR REPLACE FUNCTION public.lead_capture_forms_require_ready_deliverable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active IS TRUE
     AND NEW.magnet_type IN ('buyer_guide', 'seller_guide', 'market_report', 'home_valuation')
     AND (TG_OP = 'INSERT' OR OLD.is_active IS DISTINCT FROM TRUE)
     AND NOT EXISTS (
       SELECT 1 FROM public.lead_magnet_deliverables d
       WHERE d.form_id = NEW.id AND d.brokerage_id = NEW.brokerage_id AND d.status = 'ready'
     )
  THEN
    RAISE EXCEPTION 'lead magnet % cannot be published: its delivery asset is not ready (owner ruling 5 — the asset is created with the magnet)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.lead_capture_forms_require_ready_deliverable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS lead_capture_forms_require_ready_deliverable ON public.lead_capture_forms;
CREATE TRIGGER lead_capture_forms_require_ready_deliverable
  BEFORE INSERT OR UPDATE OF is_active ON public.lead_capture_forms
  FOR EACH ROW EXECUTE FUNCTION public.lead_capture_forms_require_ready_deliverable();

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.lead_magnet_deliverables'::regclass ORDER BY 1;
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.lead_magnet_deliverables'::regclass;
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.lead_capture_forms'::regclass AND NOT tgisinternal;
--   -- the live legacy magnet (magnet_type NULL, active) is untouched: no transition, not an asset-promising type
--   SELECT count(*) FILTER (WHERE is_active) AS active, count(*) FILTER (WHERE magnet_type IN ('buyer_guide','seller_guide','market_report','home_valuation') AND is_active) AS active_asset_magnets FROM public.lead_capture_forms;
