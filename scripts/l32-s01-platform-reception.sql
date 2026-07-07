-- l32-s01-platform-reception.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PLATFORM-LEVEL AI RECEPTION (the third scope) — the platform's OWN phone line
-- is answered by the same Twilio-native conversational AI that answers tenant
-- lines. voice_calls is tenant-shaped (NOT NULL brokerage/contact/agent), so the
-- platform line gets its own call ledger. Prospect hand-raises on a live call
-- land in the EXISTING growth funnel (platform_prospects) — phone callers dedupe
-- by caller ID, so prospects gain a phone column and email relaxes to nullable
-- (the web capture still always provides email; UNIQUE allows multiple NULLs).
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.platform_reception_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid text NOT NULL UNIQUE,
  phone_from text,
  phone_to text,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','completed','transferred')),
  outcome text,
  transcript text,
  prospect_id uuid REFERENCES public.platform_prospects(id),
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz
);

ALTER TABLE public.platform_prospects ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.platform_prospects ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_prospects_phone
  ON public.platform_prospects(phone) WHERE phone IS NOT NULL;
