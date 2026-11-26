-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m719 — THE ONE MEDIA ASSET RECORD EXTENDS marketing_assets (wave 106, lane 106C; owner:
-- "Asset Manager = media intelligence system … structured media asset {asset_id, tenant, subject,
-- campaign, property, person, asset_type, purpose, audience, brand, rights, source_assets,
-- generation_model, cost, variants, performance, expires, approved}; 'existing media is sufficient';
-- creative lineage photos → video → social cut → email thumbnail → seller campaign").
-- OWNER LAWS 1/2/4/5. Additive only.
--
-- SURVIVORS EVALUATED (LAW 1 — extend before replacing; LAW 2 — one canonical path):
--   · marketing_assets — THE reusable media library already: brokerage_id / agent_user_id / team_id,
--     campaign_id (FK marketing_campaigns), asset_type (CHECK: video | image | graphic | ad_creative |
--     social_post | …), approval_status, visibility_scope, source_table + source_id (every render is
--     captured into it: lib/marketing/capture-render-asset.ts; every readiness-created image too:
--     lib/video/plan-asset-readiness.ts), tags, metadata; stewarded by asset_manager (TABLE_MANAGER);
--     read as the creative source by the ads lane (ad_creative_variations.source_marketing_asset_id)
--     and the readiness ladder. It IS the survivor — it lacks only the owner's columns below.
--   · ai_video_projects — ONE video's production row (script, provider, render status). A video
--     becomes a library asset through the capture above (source_table/source_id is the lineage hop),
--     so the asset record is not a second video table.
--   · listing_media — the listing's own photo set (MLS-facing, is_primary, usage_intent). A photo is
--     a SOURCE of a derived asset (source_assets names it by marketing_assets id once captured) — not
--     the asset record.
--   · content_asset_persona_performance — topic × persona scores with NO brokerage_id and no asset
--     id; per-asset performance belongs on the asset row (performance jsonb below).
--   · brand_asset_library — a writer-less twin already retired from the asset manager's loop
--     (lib/agents/asset-manager-actions.ts).
-- So: NO new table. marketing_assets gains the missing columns; every generator writes the record
-- through lib/kernel/media-intelligence.ts recordMediaAsset (lineage + rights + cost on ai_tool_usage).
--
-- Apply in TWO parts (wave 98 rule): PART A (columns + CHECKs), PART B (indexes, comments, the
-- improvement_proposals proposer widening). AFTER APPLYING: regenerate scripts/schema-snapshot.ts,
-- scripts/schema-fk-map.ts and scripts/check-vocabularies.ts (two new CHECK vocabularies on
-- marketing_assets + one widened on improvement_proposals), add the marketing_assets purpose
-- MIRROR to scripts/check-vocabulary-guard.ts (MEDIA_PURPOSES — it cannot be mirrored before the
-- live CHECK exists), and restamp this header's line 1 (one provenance line, dated).

-- ══════════════════════════════ PART A — columns, CHECKs ══════════════════════════════

ALTER TABLE public.marketing_assets
  -- what the asset is ABOUT (a listing address, a topic, a seller's equity moment) — the sufficiency match key
  ADD COLUMN IF NOT EXISTS subject           text,
  -- property / person the asset was made for (campaign_id already exists: FK marketing_campaigns)
  ADD COLUMN IF NOT EXISTS listing_id        uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id        uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  -- why it exists (lib/kernel/media-intelligence.ts MEDIA_PURPOSES — one vocabulary, CHECKed below)
  ADD COLUMN IF NOT EXISTS purpose           text,
  -- who it is for (buyer | seller | investor | renter | relocation | sphere | lead | agent | public)
  ADD COLUMN IF NOT EXISTS audience          text,
  -- the brand block it was produced under ({brokerage_name, primary_color, logo_url, team_id})
  ADD COLUMN IF NOT EXISTS brand             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- provenance / licence: {source: generated|render|tenant_upload|stock|external, licence, provenance_url,
  -- attribution, verified_at} — an EXTERNAL source without licence + provenance is refused (CHECK below)
  ADD COLUMN IF NOT EXISTS rights            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- LINEAGE: the marketing_assets rows this asset was derived from (photos → video → social cut → …)
  ADD COLUMN IF NOT EXISTS source_assets     uuid[] NOT NULL DEFAULT '{}'::uuid[],
  -- which model / pipeline produced it (gpt-image-1, video_director:<composition>, did, remotion:<composition>)
  ADD COLUMN IF NOT EXISTS generation_model  text,
  -- what it cost to produce (USD) — the SAME number booked on ai_tool_usage (CLAUDE.md §5 cost ledger)
  ADD COLUMN IF NOT EXISTS cost_usd          numeric(10,4),
  -- the variant set this asset belongs to: {set_id, index, angle, siblings: [ids]}
  ADD COLUMN IF NOT EXISTS variants          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- learned performance: {impressions, clicks, leads, spend_usd, samples, score, market, last_source, updated_at}
  ADD COLUMN IF NOT EXISTS performance       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- rights / relevance expiry (a stock licence window, a listing that left the board)
  ADD COLUMN IF NOT EXISTS expires_at        timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at       timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by       uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- One purpose vocabulary (mirrors MEDIA_PURPOSES in lib/kernel/media-intelligence.ts). NOT VALID →
-- VALIDATE so the existing rows (purpose NULL) are admitted without a rewrite.
ALTER TABLE public.marketing_assets DROP CONSTRAINT IF EXISTS marketing_assets_purpose_check;
ALTER TABLE public.marketing_assets ADD CONSTRAINT marketing_assets_purpose_check
  CHECK (purpose IS NULL OR purpose IN (
    'listing_promo', 'seller_equity', 'buyer_education', 'market_update', 'brand', 'social',
    'ad', 'email_thumbnail', 'campaign', 'recruiting', 'lead_intro', 'anniversary')) NOT VALID;
ALTER TABLE public.marketing_assets VALIDATE CONSTRAINT marketing_assets_purpose_check;

-- Rights are REQUIRED for anything externally sourced (owner: "rights/provenance required for anything
-- externally sourced"): an external asset names its licence and where it came from; stock names its licence.
ALTER TABLE public.marketing_assets DROP CONSTRAINT IF EXISTS marketing_assets_external_rights_check;
ALTER TABLE public.marketing_assets ADD CONSTRAINT marketing_assets_external_rights_check
  CHECK (
    (rights->>'source') IS DISTINCT FROM 'external'
      OR (rights ? 'licence' AND rights ? 'provenance_url')
  ) NOT VALID;
ALTER TABLE public.marketing_assets VALIDATE CONSTRAINT marketing_assets_external_rights_check;

-- An asset never names itself as its own source.
ALTER TABLE public.marketing_assets DROP CONSTRAINT IF EXISTS marketing_assets_lineage_not_self_check;
ALTER TABLE public.marketing_assets ADD CONSTRAINT marketing_assets_lineage_not_self_check
  CHECK (NOT (id = ANY (source_assets))) NOT VALID;
ALTER TABLE public.marketing_assets VALIDATE CONSTRAINT marketing_assets_lineage_not_self_check;

-- ══════════════════════════════ PART B — indexes, comments, proposer ══════════════════════════════

-- the sufficiency read: approved, this tenant, this purpose / audience, newest first
CREATE INDEX IF NOT EXISTS idx_marketing_assets_sufficiency
  ON public.marketing_assets (brokerage_id, purpose, audience, created_at DESC)
  WHERE approval_status = 'approved';

-- lineage walks (which assets derive from X)
CREATE INDEX IF NOT EXISTS idx_marketing_assets_source_assets
  ON public.marketing_assets USING GIN (source_assets);

COMMENT ON COLUMN public.marketing_assets.source_assets IS
  'Creative lineage (wave 106, m719): the marketing_assets ids this asset was derived from. Written only by lib/kernel/media-intelligence.ts recordMediaAsset / recordAssetLineage.';
COMMENT ON COLUMN public.marketing_assets.rights IS
  'Provenance / licence (wave 106, m719): {source, licence, provenance_url, attribution, verified_at}. source=external requires licence + provenance_url (CHECK).';
COMMENT ON COLUMN public.marketing_assets.performance IS
  'Learned per-asset performance (wave 106, m719): written by lib/kernel/media-intelligence.ts learnFromPerformance from ad_performance (ads manager) / outcome results; feeds the media-kind improvement proposal.';

-- The media learner is a PROPOSER on the one controlled-learning object (m709). Mirrors
-- lib/kernel/improvement-proposals.ts PROPOSERS (test:check-vocabulary reads this pending widening).
ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_proposer_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_proposer_check
  CHECK (proposer IN ('copy_learning', 'predictor_learning', 'prompt_calibrator', 'outcome_autopsy', 'human', 'media_intelligence')) NOT VALID;
ALTER TABLE public.improvement_proposals VALIDATE CONSTRAINT improvement_proposals_proposer_check;
