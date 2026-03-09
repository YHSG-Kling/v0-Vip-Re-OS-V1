-- ============================================================
-- L11-S02: Brand Setup Storage Bucket
-- VIP Real Estate AI OS — Layer 11
-- ============================================================

-- Create storage bucket for brokerage assets (logos, etc.)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'brokerage-assets',
  'brokerage-assets',
  TRUE,
  5242880, -- 5MB limit
  ARRAY['image/png', 'image/svg+xml', 'image/jpeg']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Storage policy: Allow authenticated users to upload to their brokerage folder
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Brokerage members can upload assets' AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Brokerage members can upload assets"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'brokerage-assets' AND
      (storage.foldername(name))[1] IN (
        SELECT brokerage_id::text FROM public.users WHERE id = auth.uid()
      )
    );
  END IF;
END $$;

-- Storage policy: Allow public read access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can view brokerage assets' AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Anyone can view brokerage assets"
    ON storage.objects FOR SELECT
    TO public
    USING (bucket_id = 'brokerage-assets');
  END IF;
END $$;

-- Storage policy: Allow authenticated users to update their brokerage's assets
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Brokerage members can update assets' AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Brokerage members can update assets"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
      bucket_id = 'brokerage-assets' AND
      (storage.foldername(name))[1] IN (
        SELECT brokerage_id::text FROM public.users WHERE id = auth.uid()
      )
    );
  END IF;
END $$;

-- Storage policy: Allow authenticated users to delete their brokerage's assets
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Brokerage members can delete assets' AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Brokerage members can delete assets"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'brokerage-assets' AND
      (storage.foldername(name))[1] IN (
        SELECT brokerage_id::text FROM public.users WHERE id = auth.uid()
      )
    );
  END IF;
END $$;
