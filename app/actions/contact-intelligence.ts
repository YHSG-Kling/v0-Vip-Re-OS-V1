"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"

export interface ContactIntelligence {
  // Scores
  confidence_score: number | null
  intent_score: number | null
  engagement_score: number | null
  // Latest computed lead score
  latest_lead_score: number | null
  latest_score_ai_confidence: number | null
  latest_score_factors: Record<string, unknown> | null
  latest_scored_at: string | null
  // Lead origin / enrichment
  source: string | null
  source_channel: string | null
  source_family: string | null
  source_subtype: string | null
  data_source: string | null
  enrichment_source: string | null
  enrichment_confidence: number | null
  enriched_at: string | null
  last_enriched_at: string | null
  // Compliance & contact-ability
  email_verified: boolean | null
  email_unsubscribed: boolean | null
  email_opt_out: boolean | null
  direct_mail_opt_out: boolean | null
  tcpa_consent_source: string | null
  ai_isa_enabled: boolean | null
  ai_outreach_paused: boolean | null
}

export async function getContactIntelligence(contactId: string): Promise<{
  success: boolean
  intelligence?: ContactIntelligence
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated." }
  }

  const service = createServiceClient()

  // Pull intelligence-shaped fields directly from contacts.
  const { data: contactRaw, error: contactErr } = await service
    .from("contacts")
    .select("id, brokerage_id, confidence_score, intent_score, engagement_score, source, source_channel, source_family, source_subtype, data_source, enrichment_source, enrichment_confidence, enriched_at, last_enriched_at, last_scored_at, email_verified, email_unsubscribed, email_opt_out, direct_mail_opt_out, tcpa_consent_source, ai_isa_enabled, ai_outreach_paused")
    .eq("id", contactId)
    .maybeSingle()

  if (contactErr || !contactRaw) {
    return { success: false, error: contactErr?.message ?? "Contact not found." }
  }

  // Supabase widens .select() with a literal string projection — cast to the local shape.
  const contact = contactRaw as unknown as {
    brokerage_id: string
    confidence_score: number | null
    intent_score: number | null
    engagement_score: number | null
    source: string | null
    source_channel: string | null
    source_family: string | null
    source_subtype: string | null
    data_source: string | null
    enrichment_source: string | null
    enrichment_confidence: number | null
    enriched_at: string | null
    last_enriched_at: string | null
    last_scored_at: string | null
    email_verified: boolean | null
    email_unsubscribed: boolean | null
    email_opt_out: boolean | null
    direct_mail_opt_out: boolean | null
    tcpa_consent_source: string | null
    ai_isa_enabled: boolean | null
    ai_outreach_paused: boolean | null
  }

  if (contact.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Not authorized for this contact." }
  }

  // Most recent lead_scores row for this contact, if any.
  const { data: leadScore } = await service
    .from("lead_scores")
    .select("score, score_factors, ai_confidence, computed_at")
    .eq("contact_id", contactId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return {
    success: true,
    intelligence: {
      confidence_score: contact.confidence_score ?? null,
      intent_score: contact.intent_score ?? null,
      engagement_score: contact.engagement_score ?? null,
      latest_lead_score: leadScore?.score ?? null,
      latest_score_ai_confidence: leadScore?.ai_confidence ?? null,
      latest_score_factors: (leadScore?.score_factors as any) ?? null,
      latest_scored_at: leadScore?.computed_at ?? contact.last_scored_at ?? null,
      source: contact.source ?? null,
      source_channel: contact.source_channel ?? null,
      source_family: contact.source_family ?? null,
      source_subtype: contact.source_subtype ?? null,
      data_source: contact.data_source ?? null,
      enrichment_source: contact.enrichment_source ?? null,
      enrichment_confidence: contact.enrichment_confidence ?? null,
      enriched_at: contact.enriched_at ?? null,
      last_enriched_at: contact.last_enriched_at ?? null,
      email_verified: contact.email_verified ?? null,
      email_unsubscribed: contact.email_unsubscribed ?? null,
      email_opt_out: contact.email_opt_out ?? null,
      direct_mail_opt_out: contact.direct_mail_opt_out ?? null,
      tcpa_consent_source: contact.tcpa_consent_source ?? null,
      ai_isa_enabled: contact.ai_isa_enabled ?? null,
      ai_outreach_paused: contact.ai_outreach_paused ?? null,
    },
  }
}
