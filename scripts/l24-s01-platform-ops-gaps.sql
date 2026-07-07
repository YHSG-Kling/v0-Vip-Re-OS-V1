-- l24-s01-platform-ops-gaps.sql — four flagged commercial/ops gap closures.
--
-- 1) SHARED ASSET LIBRARY: marketing_assets already allows visibility_scope
--    'platform' but brokerage_id was NOT NULL — a platform-curated shared
--    library row (stock photo / AI image every tenant can use) was impossible.
--    Relax it ONLY for platform scope; tenant rows stay brokerage-keyed.
ALTER TABLE public.marketing_assets ALTER COLUMN brokerage_id DROP NOT NULL;
ALTER TABLE public.marketing_assets
  ADD CONSTRAINT marketing_assets_platform_scope_check
  CHECK (brokerage_id IS NOT NULL OR visibility_scope = 'platform');
-- 'image' joins the asset-type vocabulary (stock photos / AI stills).
ALTER TABLE public.marketing_assets DROP CONSTRAINT marketing_assets_asset_type_check;
ALTER TABLE public.marketing_assets
  ADD CONSTRAINT marketing_assets_asset_type_check
  CHECK (asset_type = ANY (ARRAY['video','snippet','script','graphic','template','social_post',
                                 'newsletter','blog','podcast','mailer','ad_creative','qr','image']));

-- 2) SUPPORT CSAT: rating captured once, post-resolution, by the tenant.
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS satisfaction_rating integer
  CHECK (satisfaction_rating BETWEEN 1 AND 5);
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS satisfaction_comment text;
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS satisfaction_at timestamptz;

-- 3) DUNNING LEDGER: which recovery step already went to which subscription —
--    the dedupe + audit spine for past-due payment recovery.
CREATE TABLE IF NOT EXISTS public.platform_dunning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES public.brokerages(id),
  subscription_id uuid REFERENCES public.subscriptions(id),
  step integer NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dunning_events_sub ON public.platform_dunning_events(subscription_id, step);

-- 4) STRIPE TAX: off by default — flipping it on requires a live Stripe Tax
--    registration; the checkout reads this flag, never a hardcode.
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS collect_tax boolean NOT NULL DEFAULT false;
