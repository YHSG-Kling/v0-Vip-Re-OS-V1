-- m613 — contact_lead_history WIDENED WITH CAMPAIGN/INTAKE PROVENANCE
--
-- APPLIED to hrvaqgvukzxfskkcrwbt on 2026-09-09 by the integrator (measured first:
-- all five leads columns exist, the view had no dependents, 20 columns before).
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- Owner ruling (2026-09-08, restating CLAUDE.md §5): "agents can't claim leads
-- because they can only see contacts (with access to leads history)." Migration
-- 039's contact_lead_history view is the ONE sanctioned lineage projection an
-- agent may read (leads itself stays locked by migration 034), and it already
-- carries source / source_family / source_channel / source_subtype / lead_stage
-- / qualification / handoff timestamps. It is MISSING the campaign/intake facts
-- an agent needs to answer "how did this specific piece of marketing reach
-- them" — utm_source/utm_medium/utm_campaign, campaign_attribution_id, and
-- source_page_url (the landing page the lead form was submitted from) — which
-- CLAUDE.md §4/§5's task brief for the contact-facing lead-history surface
-- names explicitly as "lead source / intake facts the agent may see (source,
-- campaign, form submission)".
--
-- ── WHAT IS DELIBERATELY NOT ADDED ──────────────────────────────────────────
-- `raw_record_id` (points at scraped/vendor raw payloads — lead-desk-only),
-- `enrichment_profile`/`enrichment_provider`/`enrichment_confidence` (the
-- scoring/enrichment internals the task brief names as off-limits), and
-- `notes`/`tags` (free-text ISA/lead-desk working notes, not intake facts).
-- Widening this view is additive and SECURITY INVOKER-safe: it changes no
-- column already exposed and grants no new table access — RLS on `contacts`
-- still gates who reads any row of it at all.
--
-- ── APPLY ────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.contact_lead_history
WITH (security_invoker = TRUE)
AS
SELECT
  c.id                       AS contact_id,
  c.agent_id                 AS contact_agent_id,
  c.brokerage_id             AS contact_brokerage_id,
  l.id                       AS lead_id,
  l.source,
  l.source_family,
  l.source_channel,
  l.source_subtype,
  l.lead_stage,
  l.lead_score,
  l.motivation_type,
  l.motivation_confidence,
  l.urgency_level,
  l.qualification_summary,
  l.isa_handoff_brief,
  l.handed_to_agent_at,
  l.converted_at,
  l.last_contacted_at,
  l.lifecycle_state,
  l.created_at               AS lead_created_at,
  -- m613: appended AFTER the m039 columns — CREATE OR REPLACE VIEW only accepts
  -- new columns at the END; inserting them mid-list is refused (42P16).
  l.source_page_url,
  l.utm_source,
  l.utm_medium,
  l.utm_campaign,
  l.campaign_attribution_id
FROM public.contacts c
LEFT JOIN public.leads l ON l.contact_id = c.id;

COMMENT ON VIEW public.contact_lead_history IS
  'Lead-lineage projection over leads, joined to contacts. SECURITY INVOKER: visibility is gated by RLS on contacts. Agents see lineage only for their own assigned contacts; leads.* is otherwise inaccessible to them. m613 added campaign/intake provenance (source_page_url, utm_*, campaign_attribution_id) alongside the source/qualification/handoff columns migration 039 shipped.';

GRANT SELECT ON public.contact_lead_history TO authenticated;
