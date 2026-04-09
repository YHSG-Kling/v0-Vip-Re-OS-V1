-- Lead Magnets Tables Migration
-- Creates tables for lead magnet functionality

-- Create lead_magnets table
CREATE TABLE IF NOT EXISTS public.lead_magnets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  magnet_type TEXT NOT NULL CHECK (magnet_type IN ('ebook', 'guide', 'checklist', 'calculator', 'video', 'webinar', 'template', 'report', 'other')),
  file_url TEXT,
  download_format TEXT CHECK (download_format IN ('pdf', 'docx', 'xlsx', 'video', 'link')),
  thumbnail_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  download_count INTEGER NOT NULL DEFAULT 0,
  conversion_rate NUMERIC(5,2),
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create lead_magnet_downloads table
CREATE TABLE IF NOT EXISTS public.lead_magnet_downloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_magnet_id UUID NOT NULL REFERENCES public.lead_magnets(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL,
  brokerage_id UUID NOT NULL,
  downloaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  source_channel TEXT,
  converted_to_lead BOOLEAN NOT NULL DEFAULT FALSE,
  converted_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_lead_magnets_brokerage_id ON public.lead_magnets(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_lead_magnets_status ON public.lead_magnets(status);
CREATE INDEX IF NOT EXISTS idx_lead_magnets_created_at ON public.lead_magnets(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_magnet_downloads_magnet_id ON public.lead_magnet_downloads(lead_magnet_id);
CREATE INDEX IF NOT EXISTS idx_lead_magnet_downloads_contact_id ON public.lead_magnet_downloads(contact_id);
CREATE INDEX IF NOT EXISTS idx_lead_magnet_downloads_brokerage_id ON public.lead_magnet_downloads(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_lead_magnet_downloads_downloaded_at ON public.lead_magnet_downloads(downloaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_magnet_downloads_converted ON public.lead_magnet_downloads(converted_to_lead);

-- Create RLS policies
ALTER TABLE public.lead_magnets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_magnet_downloads ENABLE ROW LEVEL SECURITY;

-- Policy for lead_magnets: Users can only access their brokerage's magnets
CREATE POLICY lead_magnets_brokerage_isolation ON public.lead_magnets
  FOR ALL
  USING (brokerage_id IN (
    SELECT brokerage_id FROM public.users WHERE id = auth.uid()
  ));

-- Policy for lead_magnet_downloads: Users can only access their brokerage's downloads
CREATE POLICY lead_magnet_downloads_brokerage_isolation ON public.lead_magnet_downloads
  FOR ALL
  USING (brokerage_id IN (
    SELECT brokerage_id FROM public.users WHERE id = auth.uid()
  ));

-- Create function to increment download count
CREATE OR REPLACE FUNCTION public.increment_download_count(magnet_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.lead_magnets
  SET download_count = download_count + 1,
      updated_at = NOW()
  WHERE id = magnet_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to update conversion rate
CREATE OR REPLACE FUNCTION public.update_conversion_rate(magnet_id UUID)
RETURNS VOID AS $$
DECLARE
  total_downloads INTEGER;
  total_conversions INTEGER;
  new_rate NUMERIC(5,2);
BEGIN
  SELECT COUNT(*) INTO total_downloads
  FROM public.lead_magnet_downloads
  WHERE lead_magnet_id = magnet_id;

  SELECT COUNT(*) INTO total_conversions
  FROM public.lead_magnet_downloads
  WHERE lead_magnet_id = magnet_id
    AND converted_to_lead = TRUE;

  IF total_downloads > 0 THEN
    new_rate := (total_conversions::NUMERIC / total_downloads::NUMERIC) * 100;
  ELSE
    new_rate := 0;
  END IF;

  UPDATE public.lead_magnets
  SET conversion_rate = new_rate,
      updated_at = NOW()
  WHERE id = magnet_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to update conversion rate when downloads are marked as converted
CREATE OR REPLACE FUNCTION public.trigger_update_conversion_rate()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM public.update_conversion_rate(NEW.lead_magnet_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_conversion_rate_trigger
AFTER INSERT OR UPDATE OF converted_to_lead ON public.lead_magnet_downloads
FOR EACH ROW
EXECUTE FUNCTION public.trigger_update_conversion_rate();

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_lead_magnets_updated_at
BEFORE UPDATE ON public.lead_magnets
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
