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
  ai_autopilot_level: "off" | "conservative" | "moderate" | "aggressive" | null
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
    .select("id, brokerage_id, confidence_score, intent_score, engagement_score, source, source_channel, source_family, source_subtype, data_source, enrichment_source, enrichment_confidence, enriched_at, last_enriched_at, last_scored_at, email_verified, email_unsubscribed, email_opt_out, direct_mail_opt_out, tcpa_consent_source, ai_isa_enabled, ai_outreach_paused, ai_autopilot_level")
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
    ai_autopilot_level: "off" | "conservative" | "moderate" | "aggressive" | null
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
      ai_autopilot_level: contact.ai_autopilot_level ?? null,
    },
  }
}

export type AIPilotLevel = "off" | "conservative" | "moderate" | "aggressive"

/**
 * Unified AI Pilot control for a contact. Single source of truth replacing
 * the old split between `contacts.ai_isa_enabled` (boolean) and the
 * `ai_autopilot_plans` table.
 *
 * Levels:
 *   - off          — no AI activity
 *   - conservative — light cadence; agent approves every send
 *   - moderate     — standard nurture + AI reply drafts (DEFAULT for legacy on)
 *   - aggressive   — full autopilot incl. AI ISA outbound calls/SMS where consented
 *
 * Writes `contacts.ai_autopilot_level` and keeps `ai_isa_enabled` in sync
 * for any legacy reader still consuming the boolean.
 */
export async function setContactAIPilot(params: {
  contactId: string
  level: AIPilotLevel
}): Promise<{ success: boolean; error?: string; level?: AIPilotLevel }> {
  const { agentId, brokerageId } = await getAgentContext()
  if (!brokerageId) return { success: false, error: "No brokerage context" }

  const enabled = params.level !== "off"
  const supabase = createServiceClient()
  // .select() so a ZERO-ROW update is distinguishable from a successful one.
  // The brokerage_id filter is a real tenant boundary: a contact from another
  // tenancy (or a deleted one) matches nothing, and an update that matches
  // nothing returns error: null. The CRM then toasted "AI Pilot: Aggressive"
  // for a contact whose autonomy setting had not moved — which, on the control
  // that governs whether an AI messages a client unattended, is the worst
  // possible thing to be wrong about.
  const { data: updated, error } = await supabase
    .from("contacts")
    .update({
      ai_autopilot_level: params.level,
      ai_isa_enabled: enabled,
    })
    .eq("id", params.contactId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!updated?.length) return { success: false, error: "Contact not found in your brokerage" }

  // Activity log for audit trail
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    agent_id: agentId,
    contact_id: params.contactId,
    activity_type: "ai_pilot_changed",
    title: `AI Pilot set to ${params.level}`,
    metadata: { level: params.level, enabled },
  }).then(() => {}, () => {})

  return { success: true, level: params.level }
}

// TOMBSTONE: `toggleAIISA(contactId, enabled)` — DELETED as a legacy alias.
// SURVIVOR: `setContactAIPilot`, app/actions/contact-intelligence.ts:146.
//
// Its own comment called it "Legacy entry — routes to the unified pilot setter",
// and that was its entire body: it mapped a boolean onto `level: "moderate" |
// "off"` and called the survivor. The survivor carries every level the product
// actually offers, the tenant-scoped `.select()`-checked update that
// distinguishes a zero-row write from a real one, and the `ai_pilot_changed`
// activity row — none of which this alias added to or could.
//
// NOTHING WAS LOST IN THE MERGE. The two-state toggle is a strict subset of the
// survivor's level vocabulary, and the live surface is already the survivor's:
// app/crm/components/ai-pilot-control.tsx:63 calls setContactAIPilot directly,
// and app/crm/page.tsx renders that control. This alias's only importer was
// that same page, which imported it and never called it.
//
// A boolean alias over a four-level control is also the §6 defect in miniature:
// it can only ever express two of the levels, so any caller reaching for it
// silently loses "conservative"/"aggressive" — and reads back a contact whose
// autonomy setting it cannot describe.
