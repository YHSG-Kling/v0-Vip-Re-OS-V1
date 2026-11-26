-- ── APPLIED LIVE 2026-10-31 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 147, lane 147H ──
--
-- m906 — vendor_portfolio_items: the store behind /vendor/portfolio (owner ruling 9, wave 147: "build the missing
-- capabilities and also ones that say 'not available yet'").
--
-- WHY (measured at 4d527cc3): /vendor/portfolio and /vendor/portfolio/upload said "Portfolio uploads are not available
-- yet" because NO store existed — scripts/schema-snapshot.ts lists vendor_marketplace_profiles, vendor_reviews,
-- vendor_jobs … and no portfolio / gallery table; no action wrote one (wave 146H routed it as MISSING). This adds the
-- missing half; the writer is app/actions/vendor-portfolio.ts (addVendorPortfolioItem / removeVendorPortfolioItem,
-- each under withActionLedger) and the readers are the vendor's own /vendor/portfolio page and the brokerage's vendor
-- directory (app/components/vendors/vendor-portfolio-strip.tsx in the Reviews dialog).
--
-- STORAGE: the media object lives in the PRIVATE `documents` bucket (storage_bucket_policy_readiness() = service_only,
-- measured 2026-10-31) under vendor-portfolio/<brokerage_id>/<vendor_id>/<uuid>.<ext>, written and signed (1 hour) by
-- the server action on the service client AFTER the session gate — no storage.objects policy is needed or added
-- (storage.objects is owner SQL-editor; m855/m875 remain the owner's release-blocking obligation).
--
-- TENANCY: vendors are per-brokerage rows (vendors.brokerage_id); brokerage_id here is stamped from the vendor's
-- grant (requireVendorActor), never a request body. RLS: authenticated users READ their own brokerage's published
-- items; there is NO insert/update/delete policy for authenticated — every write is the service-role server action.

CREATE TABLE IF NOT EXISTS public.vendor_portfolio_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id          uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  brokerage_id       uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  title              text NOT NULL CONSTRAINT vendor_portfolio_items_title_len CHECK (char_length(title) BETWEEN 1 AND 120),
  description        text CONSTRAINT vendor_portfolio_items_description_len CHECK (description IS NULL OR char_length(description) <= 2000),
  media_path         text NOT NULL,
  media_kind         text NOT NULL CONSTRAINT vendor_portfolio_items_media_kind_check CHECK (media_kind IN ('image', 'pdf')),
  media_bytes        integer CONSTRAINT vendor_portfolio_items_media_bytes_check CHECK (media_bytes IS NULL OR media_bytes > 0),
  content_sha256     text,
  status             text NOT NULL DEFAULT 'published' CONSTRAINT vendor_portfolio_items_status_check CHECK (status IN ('published', 'removed')),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz
);

CREATE INDEX IF NOT EXISTS vendor_portfolio_items_vendor_published_idx
  ON public.vendor_portfolio_items (vendor_id, created_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS vendor_portfolio_items_brokerage_idx
  ON public.vendor_portfolio_items (brokerage_id);
-- One upload of the same file per vendor while published (the server action's ledger key is the same pair).
CREATE UNIQUE INDEX IF NOT EXISTS vendor_portfolio_items_vendor_sha_uniq
  ON public.vendor_portfolio_items (vendor_id, content_sha256) WHERE status = 'published' AND content_sha256 IS NOT NULL;

ALTER TABLE public.vendor_portfolio_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_portfolio_items_tenant_read ON public.vendor_portfolio_items;
CREATE POLICY vendor_portfolio_items_tenant_read ON public.vendor_portfolio_items
  FOR SELECT TO authenticated
  USING (status = 'published' AND brokerage_id = public.current_user_brokerage_id());

REVOKE ALL ON public.vendor_portfolio_items FROM anon;
GRANT SELECT ON public.vendor_portfolio_items TO authenticated;
GRANT ALL ON public.vendor_portfolio_items TO service_role;

COMMENT ON TABLE public.vendor_portfolio_items IS
  'Vendor work samples (m906, wave 147 lane 147H). Writer: app/actions/vendor-portfolio.ts (service role, after requireVendorActor). Readers: /vendor/portfolio and the vendor directory. Media in the private documents bucket, served by 1-hour signed URLs.';
