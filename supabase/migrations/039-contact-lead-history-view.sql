-- =====================================================
-- MIGRATION 039: contact_lead_history view
-- =====================================================
-- Agents must NOT read the `leads` table directly (see migration
-- 034). But when a lead has been converted to a contact assigned to
-- an agent, the agent legitimately needs the lineage — what source,
-- what ISA conversation summary, what qualification answers led to
-- the handoff.
--
-- This view exposes ONLY non-sensitive lineage columns and joins
-- via leads.contact_id → contacts.id. It runs SECURITY INVOKER, so
-- the underlying RLS on `contacts` is what gates visibility — the
-- agent sees only their own assigned contacts' lineage.
-- =====================================================

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
  l.created_at               AS lead_created_at
FROM public.contacts c
LEFT JOIN public.leads l ON l.contact_id = c.id;

COMMENT ON VIEW public.contact_lead_history IS
  'Lead-lineage projection over leads, joined to contacts. SECURITY INVOKER: visibility is gated by RLS on contacts. Agents see lineage only for their own assigned contacts; leads.* is otherwise inaccessible to them.';

GRANT SELECT ON public.contact_lead_history TO authenticated;
