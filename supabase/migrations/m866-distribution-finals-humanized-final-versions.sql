-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145G ──
--
-- m866 — distribution_finals: THE HUMANIZED FINAL VERSION OF EVERY AI-GENERATED PUBLIC ASSET, and which approved version
-- actually went out (wave 145, lane 145G — contract C4; owner ruling 20, 2026-10-27: "All distributions of material created by
-- ai should have a last phase of removing any ai typical wording and adds the user's tagline … human approval is the
-- publication gate … track the approved final version actually sent/published").
--
-- WHY A NEW TABLE (orphan doctrine §1.2, audited against the live schema 2026-10-27): no table records a VERSION of a piece of
-- copy, its hash, or which version a human approved and a door sent. approval_items carries status + review_notes only (and the
-- approve step overwrites review_notes); the per-channel logs (social_publish_log, podcast_distribution_log,
-- learning_module_channel_publications) record a send per channel but not the text; marketing_assets is the MEDIA library
-- (asset_url, thumbnails) — a text final there would be a file-less library row. The approval itself stays where it is (each
-- asset's own approval_status / the lead-magnet publish / the KDP attestation): this table only records the evidence of which
-- version that approval covered (approval_basis + approved_by/at copied at the door), never a second approval state machine.
--
-- Writer: lib/marketing/humanize-final.ts — stageDistributionFinal (the AI creators: lib/kernel/content-creators.ts newsletter /
-- blog / podcast; lib/video/youtube-publish.ts; lib/video/community-video-publish.ts; lib/marketing/ctv-lane.ts) and
-- recordDistributionPublication (the publication doors). Readers: loadLatestFinal / checkDistributionPublication (the doors,
-- before an external send). Service-role writes only; tenant members read their own brokerage's rows.
--
-- PART 2 widens content_topic_uses.asset_type with 'ctv_ad' (contract C5: a TV spot made from an APPROVED topic claims the topic
-- like every other asset — lib/marketing/ctv-lane.ts).
--
-- After applying: regenerate schema-snapshot, live-tables, the FK map AND scripts/check-vocabularies.ts (three new CHECKs here +
-- the widened content_topic_uses.asset_type), and add TABLE_MANAGER 'distribution_finals' -> campaign_orchestrator.

-- PART 1 — the table.
CREATE TABLE IF NOT EXISTS public.distribution_finals (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  asset_kind        text        NOT NULL
    CONSTRAINT distribution_finals_asset_kind_check
    CHECK (asset_kind IN ('newsletter', 'email_campaign', 'blog_post', 'social_post', 'ad_creative', 'lead_magnet', 'book',
                          'video_script', 'podcast_script', 'video_description', 'ctv_ad', 'listing_creative', 'direct_mail')),
  -- the asset row the final belongs to (polymorphic on purpose: newsletter_campaigns, blog_posts, podcast_episodes,
  -- social_posts, ai_video_projects, ad_campaigns, lead_capture_forms, books …) — no FK, the door verifies it in-tenant.
  asset_table       text        NOT NULL CHECK (asset_table ~ '^[a-z][a-z0-9_]{1,62}$'),
  asset_id          uuid        NOT NULL,
  version           integer     NOT NULL CHECK (version >= 1),
  final_text        text        NOT NULL,
  content_sha256    text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256     text        NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  authored_by       text        NOT NULL DEFAULT 'ai'
    CONSTRAINT distribution_finals_authored_by_check CHECK (authored_by IN ('ai', 'human')),
  findings          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  blockers          text[]      NOT NULL DEFAULT '{}',
  -- the open items the approving human accepted (superlatives, testimonials, phrasing) — recorded at the door
  acknowledged      text[]      NOT NULL DEFAULT '{}',
  tagline           text        NULL,
  logo_url          text        NULL,
  status            text        NOT NULL DEFAULT 'awaiting_approval'
    CONSTRAINT distribution_finals_status_check
    CHECK (status IN ('awaiting_approval', 'approved', 'published', 'superseded')),
  approval_basis    text        NULL
    CONSTRAINT distribution_finals_approval_basis_check
    CHECK (approval_basis IS NULL OR approval_basis IN ('asset_approval', 'derived_from_approved_asset', 'human_edit')),
  approved_by       uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at       timestamptz NULL,
  notified_user_id  uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  notified_at       timestamptz NULL,
  published_at      timestamptz NULL,
  published_via     text        NULL,
  published_ref     text        NULL,
  published_sha256  text        NULL CHECK (published_sha256 IS NULL OR published_sha256 ~ '^[0-9a-f]{64}$'),
  created_by        uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT distribution_finals_asset_version_unique UNIQUE (asset_table, asset_id, version),
  -- a published row names what went out and through which door
  CONSTRAINT distribution_finals_published_shape
    CHECK (status <> 'published' OR (published_at IS NOT NULL AND published_via IS NOT NULL AND published_sha256 IS NOT NULL AND approval_basis IS NOT NULL))
);

COMMENT ON TABLE public.distribution_finals IS
  'Wave 145 (145G, owner ruling 20): the humanized FINAL version of an AI-generated public asset (machine phrasing removed, approved tagline, disclosures + material terms preserved, open items named), the human it was announced to, and — at the publication door — which approved version went out (sha256, door, provider ref). Writer: lib/marketing/humanize-final.ts. The approval itself stays on the asset; this table records the evidence.';

CREATE INDEX IF NOT EXISTS distribution_finals_tenant_status_idx ON public.distribution_finals (brokerage_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS distribution_finals_asset_idx ON public.distribution_finals (brokerage_id, asset_table, asset_id, version DESC);

ALTER TABLE public.distribution_finals ENABLE ROW LEVEL SECURITY;

CREATE POLICY distribution_finals_tenant_read ON public.distribution_finals
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.distribution_finals FROM authenticated, anon;
GRANT SELECT ON public.distribution_finals TO authenticated;

-- PART 2 — content_topic_uses.asset_type gains 'ctv_ad' (a streaming-TV spot made from an approved topic).
ALTER TABLE public.content_topic_uses DROP CONSTRAINT IF EXISTS content_topic_uses_asset_type_check;
ALTER TABLE public.content_topic_uses ADD CONSTRAINT content_topic_uses_asset_type_check
  CHECK (asset_type IN ('blog_post', 'direct_mail_postcard', 'marketing_plan_item', 'newsletter_campaign', 'newsletter_video',
                        'podcast_episode', 'situational_reel', 'social_post', 'ctv_ad'));

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.distribution_finals'::regclass ORDER BY 1;
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'content_topic_uses_asset_type_check';
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.distribution_finals'::regclass;
