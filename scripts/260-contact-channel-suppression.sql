-- Migration 260: Per-channel opt-out indexes
-- Columns email_opt_out, sms_opt_out, phone_opt_out, direct_mail_opt_out,
-- opt_out_channels, opted_out_at, opt_out_reason, opt_out_source
-- already exist on contacts and leads from prior migration.
-- This script adds missing indexes only (idempotent).

CREATE INDEX IF NOT EXISTS idx_contacts_dnc
  ON public.contacts(dnc_status)
  WHERE dnc_status = true;

CREATE INDEX IF NOT EXISTS idx_contacts_email_opt_out
  ON public.contacts(email_opt_out)
  WHERE email_opt_out = true;

CREATE INDEX IF NOT EXISTS idx_contacts_sms_opt_out
  ON public.contacts(sms_opt_out)
  WHERE sms_opt_out = true;

CREATE INDEX IF NOT EXISTS idx_leads_email_opt_out
  ON public.leads(email_opt_out)
  WHERE email_opt_out = true;

CREATE INDEX IF NOT EXISTS idx_leads_sms_opt_out
  ON public.leads(sms_opt_out)
  WHERE sms_opt_out = true;
