-- Add widget_enabled flag to brokerages so the loader route can gate access.
-- Default TRUE so existing brokerages get the widget automatically.
ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS widget_enabled boolean NOT NULL DEFAULT true;
