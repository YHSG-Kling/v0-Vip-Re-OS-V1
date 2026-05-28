-- =====================================================
-- MIGRATION 040: User-uploaded video for marketing
-- =====================================================
-- Agents need to upload personal videos from their computer to use
-- in marketing channels. This sits alongside the AI-rendered video
-- pipeline (D-ID / HeyGen) — same downstream consumers, but the
-- source is a Storage object instead of a render job.
-- =====================================================

CREATE TABLE IF NOT EXISTS public.user_uploaded_videos (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,           -- uploader (auth.users.id)
  brokerage_id    UUID,                            -- tenant scope; nullable for platform-admin uploads
  storage_path    TEXT        NOT NULL,           -- supabase storage object key
  storage_bucket  TEXT        NOT NULL DEFAULT 'marketing-uploads',
  mime_type       TEXT,
  duration_sec    NUMERIC(10, 2),
  size_bytes      BIGINT,
  label           TEXT,
  channels        TEXT[]      NOT NULL DEFAULT '{}',  -- which marketing channels can use it
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_uploaded_videos_user
  ON public.user_uploaded_videos (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_uploaded_videos_brokerage
  ON public.user_uploaded_videos (brokerage_id, created_at DESC);

ALTER TABLE public.user_uploaded_videos ENABLE ROW LEVEL SECURITY;

-- SELECT: uploader sees their own; brokerage admin sees brokerage's;
-- platform admin sees all.
CREATE POLICY user_uploaded_videos_select ON public.user_uploaded_videos
  FOR SELECT
  USING (
    public.is_platform_admin()
    OR user_id = auth.uid()
    OR (public.is_brokerage_admin() AND brokerage_id = public.current_user_brokerage_id())
  );

-- INSERT: an authenticated user can create their own rows; must be
-- within their own brokerage (or NULL for platform admin).
CREATE POLICY user_uploaded_videos_insert ON public.user_uploaded_videos
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (
      public.is_platform_admin()
      OR brokerage_id = public.current_user_brokerage_id()
    )
  );

-- UPDATE: uploader, or brokerage admin within brokerage, or platform admin.
CREATE POLICY user_uploaded_videos_update ON public.user_uploaded_videos
  FOR UPDATE
  USING (
    public.is_platform_admin()
    OR user_id = auth.uid()
    OR (public.is_brokerage_admin() AND brokerage_id = public.current_user_brokerage_id())
  )
  WITH CHECK (
    public.is_platform_admin()
    OR user_id = auth.uid()
    OR (public.is_brokerage_admin() AND brokerage_id = public.current_user_brokerage_id())
  );

-- DELETE: uploader, brokerage admin, or platform admin.
CREATE POLICY user_uploaded_videos_delete ON public.user_uploaded_videos
  FOR DELETE
  USING (
    public.is_platform_admin()
    OR user_id = auth.uid()
    OR (public.is_brokerage_admin() AND brokerage_id = public.current_user_brokerage_id())
  );

-- Note: the matching Storage bucket policies on the
-- `marketing-uploads` bucket are configured separately via the
-- Supabase Dashboard (Storage RLS lives on storage.objects). The
-- application-side upload route signs URLs scoped by user_id /
-- brokerage_id so the storage path mirrors the table row.
