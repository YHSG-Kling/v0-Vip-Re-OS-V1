-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150PU ──
--
-- m978 — AD LEAD-FORM LEGAL CONTENT, MARKED UNKNOWN UNTIL VERIFIED (wave 150, directive lane 150U; canary 18 "Meta legal-consent
-- uncertainty"; lane 148B Still open 6 / lane 149J Outside-lane A1).
--
-- WHY. A Meta lead-ad submission is a consented CONTACT only with the platform's OWN disclosure wording (owner ruling 3 —
-- consent never fabricated; lib/ads/ad-lead-intake.ts ingestConsentedAdLead records no consent without it). The form's
-- `legal_content` is fetched once per (tenant, form) by lib/ads/ad-lead-intake.ts ingestMetaLeadByRef through
-- lib/ads/connectors/meta.ts fetchMetaLeadFormLegalContent and stored HERE with legal_content_status = 'unknown'. The field
-- path has not been read back from a live form, so nothing arms a consent from an 'unknown' row. Only a person who has looked
-- at the live form in Meta and compared its wording with disclosure_text sets 'verified' (owner SQL below, after the
-- WAITING_EXTERNAL live check); from then on that form's leads carry disclosure_text as their consent wording.
--
-- WRITER: lib/ads/ad-lead-intake.ts recordAdFormLegalContent (insert 'unknown' / 'not_provided'; never overwrites 'verified').
-- READER: the same module (the status + wording decide whether a consent is recorded for the lead).
-- Owner SQL after the live check (by NAME, never run by a lane):
--   UPDATE public.ad_lead_form_legal_content SET legal_content_status = 'verified', verified_at = now(),
--          verified_by_user_id = '<the reviewer users.id>' WHERE brokerage_id = '<tenant>' AND platform = 'facebook' AND form_id = '<form>';

CREATE TABLE IF NOT EXISTS public.ad_lead_form_legal_content (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  platform              text NOT NULL,
  form_id               text NOT NULL,
  disclosure_text       text,
  checkbox_keys         text[] NOT NULL DEFAULT '{}',
  privacy_policy_url    text,
  legal_content_status  text NOT NULL DEFAULT 'unknown',
  fetch_error           text,
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  verified_at           timestamptz,
  verified_by_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_lead_form_legal_content_status_check CHECK (legal_content_status IN ('unknown', 'verified', 'not_provided')),
  CONSTRAINT ad_lead_form_legal_content_verified_check CHECK (legal_content_status <> 'verified' OR (verified_at IS NOT NULL AND disclosure_text IS NOT NULL)),
  CONSTRAINT ad_lead_form_legal_content_unique UNIQUE (brokerage_id, platform, form_id)
);

ALTER TABLE public.ad_lead_form_legal_content ENABLE ROW LEVEL SECURITY;

-- Tenant staff may READ their own forms' legal content (the service client writes it from the webhook).
DROP POLICY IF EXISTS ad_lead_form_legal_content_tenant_select ON public.ad_lead_form_legal_content;
CREATE POLICY ad_lead_form_legal_content_tenant_select ON public.ad_lead_form_legal_content
  FOR SELECT TO authenticated USING (brokerage_id = current_user_brokerage_id() AND is_tenant_staff_seat());

COMMENT ON TABLE public.ad_lead_form_legal_content IS
  'Wave 150 (150U): a paid lead form''s own legal content per tenant + form. legal_content_status unknown until a person verifies it against the live form; only verified wording becomes a lead''s consent text (lib/ads/ad-lead-intake.ts).';
