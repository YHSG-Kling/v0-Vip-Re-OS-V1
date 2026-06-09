-- m195 — persist the contact-stage AI enrichment that nurture/scoring features already compute.
-- These do .from("contacts").update({...}) with columns that didn't exist → the write errored and
-- the computed scores/insights were silently discarded. They are CONTACT-stage (a promoted lead
-- being nurtured/scored), not lead-pipeline fields (contacts-vs-leads respected), and distinct from
-- intent_score/engagement_score/referral_potential(text).
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS ai_conversion_probability numeric,
  ADD COLUMN IF NOT EXISTS ai_predicted_close_date   date,
  ADD COLUMN IF NOT EXISTS ai_insights               text,
  ADD COLUMN IF NOT EXISTS nurture_status            text,
  ADD COLUMN IF NOT EXISTS referral_score            numeric,
  ADD COLUMN IF NOT EXISTS referral_approach         text;
