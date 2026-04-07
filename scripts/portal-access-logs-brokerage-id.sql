-- Add brokerage_id to portal_access_logs (referenced by grantPortalAccess spec)
ALTER TABLE public.portal_access_logs
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_portal_access_logs_brokerage_id
  ON public.portal_access_logs (brokerage_id);
