"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { resolveModel } from "@/lib/ai/resolve-model"

// Get auto-response settings for the current agent
export async function getAutoResponseSettings() {
  const supabase = await createClient()
  const { agentId } = await getAgentContext()

  if (!agentId) {
    return { success: false, error: "Not authenticated", settings: null }
  }

  const { data, error } = await supabase
    .from("auto_response_settings")
    .select("*")
    .eq("agent_id", agentId)
    .single()

  if (error && error.code !== "PGRST116") {
    console.error("Error fetching auto-response settings:", error)
    return { success: false, error: error.message, settings: null }
  }

  // Return default settings if none exist (live schema columns only).
  if (!data) {
    return {
      success: true,
      settings: {
        is_enabled: false,
        tone: "professional",
        delay_minutes: 5,
        keywords: [],
        custom_prompt: null,
      },
    }
  }

  return { success: true, settings: data }
}

// Update auto-response settings
export async function updateAutoResponseSettings(settings: {
  is_enabled?: boolean
  tone?: string
  delay_minutes?: number
  keywords?: string[]
  custom_prompt?: string | null
}) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  if (!agentId) {
    return { success: false, error: "Not authenticated" }
  }

  // auto_response_settings is keyed by agent_id (NOT NULL, UNIQUE, FK→agents).
  const { error } = await supabase
    .from("auto_response_settings")
    .upsert(
      {
        agent_id: agentId,
        brokerage_id: brokerageId,
        ...settings,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" },
    )

  if (error) {
    console.error("Error updating auto-response settings:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// Generate AI response for a message
export async function generateAIResponse(params: {
  conversationId: string
  contactId: string
  lastMessage: string
  conversationHistory?: any[]
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated", response: null }
  }

  // Get contact information for context
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", params.contactId)
    .single()

  // Get conversation history
  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", params.conversationId)
    .order("created_at", { ascending: false })
    .limit(10)

  // Get auto-response settings
  const { settings } = await getAutoResponseSettings()

  // Build context for AI
  const context = {
    contactName: contact?.first_name
      ? `${contact.first_name} ${contact.last_name || ""}`
      : "there",
    contactType: contact?.contact_type || "unknown",
    lastMessage: params.lastMessage,
    conversationHistory: messages || [],
    tone: settings?.tone || "professional",
    agentName: user.user_metadata?.full_name || "our team",
  }

  // Generate AI response — real call: generateSmartReply rides generateTextRouted
  // (routed model + fair-use quota + usage log), compliance-constrained prompt.
  const aiResponse = await generateSmartReply(context)

  // Log the AI response.
  //
  // THE TENANT IS STAMPED. `messages.brokerage_id` is nullable with no backfill,
  // and this writer omitted it — so every AI auto-response landed with a NULL
  // tenant and was invisible to any brokerage-filtered reader of that table.
  // A row nothing can find is the same as a row that was never written, except
  // that it still went out to the contact.
  //
  // The insert result is READ. supabase-js resolves a refused write, so an
  // unchecked insert reports success while the outbound message it was meant to
  // record does not exist.
  const { agentId, brokerageId } = await getAgentContext()
  // messages live cols: conversation_id, contact_id, agent_id, type, direction,
  // subject, body, status, compliance_checked. No content/channel/is_ai_generated/
  // sent_at/compliance_approved fields. ai_auto provenance lives in `type`.
  const { error: logError } = await supabase.from("messages").insert({
    brokerage_id: brokerageId,
    conversation_id: params.conversationId,
    contact_id: params.contactId,
    agent_id: agentId,
    type: "ai_auto_response",
    direction: "outbound",
    body: aiResponse,
    status: "queued",
    compliance_checked: false,
  })
  if (logError) {
    console.error("[ai-auto-response] the AI reply was generated but NOT logged:", logError.message)
  }

  return { success: true, response: aiResponse }
}

// Smart reply generation using AI
async function generateSmartReply(context: {
  contactName: string
  contactType: string
  lastMessage: string
  conversationHistory: any[]
  tone: string
  agentName: string
}): Promise<string> {
  const recentHistory = context.conversationHistory
    .slice(0, 5)
    .reverse()
    .map((m: any) =>
      `${m.direction === "inbound" ? context.contactName : context.agentName}: ${m.content ?? m.body ?? ""}`
    )
    .join("\n")

  const { text } = await generateText({
    model: resolveModel("openai/gpt-4o-mini"),
    prompt: `You are ${context.agentName}, a professional real estate agent. Write a ${context.tone} reply.

Contact: ${context.contactName} (${context.contactType || "prospect"})
${recentHistory ? `Recent conversation:\n${recentHistory}\n` : ""}Their latest message: "${context.lastMessage}"

Rules:
- 1–3 sentences, no bullet lists
- Do not use "guaranteed", "can't lose", or "risk-free"
- Match the ${context.tone} tone
- End with a clear next step or open question when natural
- No signature line

Reply:`,
  })

  return text.trim()
}

// Track behavioral event for lead scoring
export async function trackBehavioralEvent(params: {
  contactId: string
  eventType: string
  eventData?: any
  pointsAwarded?: number
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  // behavioral_patterns is a brokerage pattern-definition CATALOG, not an event log.
  // Per-entity events belong in lead_behavioral_data (keyed by lead_id, event_type NOT NULL).
  const { brokerageId } = await getAgentContext()
  const { error } = await supabase.from("lead_behavioral_data").insert({
    lead_id: params.contactId,
    event_type: params.eventType,
    event_data: {
      ...(params.eventData || {}),
      points_awarded: params.pointsAwarded || 0,
    },
    brokerage_id: brokerageId,
    occurred_at: new Date().toISOString(),
  })

  if (error) {
    console.error("Error tracking behavioral event:", error)
    return { success: false, error: error.message }
  }

  // Recalculate lead score through the CANONICAL scorer (multi-factor baseline +
  // the behavioural layer that reads this very event log). Behaviour tracking is
  // best-effort telemetry: a scoring failure must not fail the tracking call.
  try {
    const { calculateLeadScore } = await import("@/lib/services/lead-management.service")
    await calculateLeadScore({ id: params.contactId, table: "contacts" })
  } catch (scoreErr) {
    console.error("[ai-auto-response] scoring after behavioural event failed:", scoreErr)
  }

  return { success: true }
}

// ─── THE LEGACY LOCAL SCORER IS GONE ─────────────────────────────────────────
//
// It was the THIRD calculateLeadScore in the repo and had been marked @deprecated
// while still being called on this file's live auto-response path. Two things made
// it worse than a duplicate:
//
//   · It normalised with `min(100, floor(totalPoints / 10))`, so a "hot" score of 70
//     required 700 raw event points — roughly 24 CMA requests or 28 showing requests
//     from one person. Unreachable in practice, which made getHotLeads below (the
//     agent dashboard and /leads) empty by arithmetic.
//   · It wrote lead_scores, which NO authoritative path wrote, while the real score
//     went to contacts.lead_score. Two tables, two formulas, one lead.
//
// What it uniquely got RIGHT was reading lead_behavioral_data as the event log it
// actually is — per-event-type weights, real occurred_at recency,
// event_data.points_awarded as a fallback. Those weights are ported verbatim into
// lib/lead-scoring/behavioral-events.ts and now feed the canonical scorer, which
// also writes the lead_scores snapshot. So this function's asset survives and its
// two defects do not.

// Get lead score for a contact
export async function getLeadScore(contactId: string) {
  const supabase = await createClient()

  // maybeSingle, not single: "no snapshot yet" is an ordinary state for a contact
  // that has never been scored, and .single() turned it into an error the caller had
  // to recognise by PostgREST code.
  const { data, error } = await supabase
    .from("lead_scores")
    .select("*")
    .eq("contact_id", contactId)
    .maybeSingle()

  if (error && error.code !== "PGRST116") {
    console.error("Error fetching lead score:", error)
    return { success: false, error: error.message, score: null }
  }

  if (!data) {
    // No snapshot yet — compute one through the canonical scorer, which writes the
    // lead_scores row, then read it back rather than returning a differently-shaped
    // ad-hoc object (the old local scorer returned its own shape here, so callers
    // saw two different score payloads depending on whether a row existed).
    const { calculateLeadScore } = await import("@/lib/services/lead-management.service")
    await calculateLeadScore({ id: contactId, table: "contacts" })
    const { data: fresh } = await supabase
      .from("lead_scores")
      .select("*")
      .eq("contact_id", contactId)
      .maybeSingle()
    return { success: true, score: fresh ?? null }
  }

  return { success: true, score: data }
}

/** The score at or above which a lead is HOT. Same number priorityTier() uses in
 *  lib/lead-scoring/behavioral-events, stated once so the list and the tier label
 *  cannot disagree about what "hot" means. */
const HOT_LEAD_SCORE = 70

// Get hot leads (priority scoring) - using actual schema columns
// Schema: id, contact_id, agent_id, score, score_factors, ai_confidence, computed_at
export async function getHotLeads(limit = 50) {
  const context = await getAgentContext()
  if (!context?.agentId) {
    return { success: false, error: "Agent context not available", leads: [] }
  }
  
  const { agentId, brokerageId } = context
  const supabase = await createClient()

  // lead_scores is UNIQUE (contact_id) — one current row per contact, verified
  // against the live schema — so ranking by score and taking `limit` needs no
  // dedupe. The canonical scorer upserts on contact_id to keep it that way.
  const { data, error } = await supabase
    .from("lead_scores")
    .select("id, contact_id, agent_id, score, score_factors, ai_confidence, computed_at")
    .eq("agent_id", agentId)
    .gte("score", HOT_LEAD_SCORE)
    .order("score", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Error fetching hot leads:", error)
    // Fallback: query contacts directly with high intent_score
    const { data: contactsData, error: contactsError } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, contact_type, source, lead_score, lead_temperature, created_at")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .or(`lead_score.gte.${HOT_LEAD_SCORE},status.eq.hot`)
      .order("lead_score", { ascending: false, nullsFirst: false })
      .limit(limit)

    if (contactsError) {
      console.error("Error fetching contacts fallback:", contactsError)
      return { success: false, error: contactsError.message, leads: [] }
    }

    // Map contacts to the expected hot leads format
    return {
      success: true,
      leads: (contactsData || []).map(c => ({
        id: c.id,
        contact_id: c.id,
        agent_id: agentId,
        // contacts.lead_score IS the canonical current score — the fallback reads the
        // same number the snapshot would carry, not intent_score/engagement_score,
        // which are enrichment signals and never were this score.
        score: c.lead_score ?? HOT_LEAD_SCORE,
        score_factors: { temperature: c.lead_temperature },
        ai_confidence: 0.8,
        computed_at: new Date().toISOString(),
        contacts: c,
      })),
    }
  }

  // Fetch contacts separately to avoid relationship issues
  const leads = data || []
  if (leads.length > 0) {
    const contactIds = leads.map(l => l.contact_id).filter(Boolean)
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, email, phone, contact_type, source, created_at")
        .in("id", contactIds)
        .eq("brokerage_id", brokerageId)

      const contactMap = new Map(contacts?.map(c => [c.id, c]) || [])
      return {
        success: true,
        leads: leads.map(l => ({
          ...l,
          contacts: contactMap.get(l.contact_id) || null,
        })),
      }
    }
  }

  return { success: true, leads: [] }
}
