"use server"

import { createServiceClient }      from "@/lib/supabase/service"
import { createClient }              from "@/lib/supabase/server"
import { calculateFatigue }          from "@/lib/fatigue/fatigue-calculator"
import { generateText }              from "ai"

// ─── GET FATIGUE SCORE FOR ONE BUYER ─────────────────────────────────────────

export async function getBuyerFatigueScore(contactId: string) {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("contact_id", contactId)
    .maybeSingle()

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data }
}

// ─── GET ACTIVE FATIGUE ALERTS FOR ONE BUYER ─────────────────────────────────

export async function getBuyerFatigueAlerts(contactId: string) {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("contact_id", contactId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data: data ?? [] }
}

// ─── DISMISS ALERT ────────────────────────────────────────────────────────────

export async function dismissFatigueAlert(alertId: string) {
  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()
  if (!user) return { success: false as const, error: "Unauthorized" }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from("fatigue_alerts")
    .update({
      dismissed:    true,
      dismissed_at: new Date().toISOString(),
      dismissed_by: user.id,
    })
    .eq("id", alertId)

  if (error) return { success: false as const, error: error.message }
  return { success: true as const }
}

// ─── CALCULATE NOW (on-demand) ────────────────────────────────────────────────

export async function triggerFatigueCalculation(
  contactId:   string,
  brokerageId: string,
) {
  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()
  if (!user) return { success: false as const, error: "Unauthorized" }

  try {
    const result = await calculateFatigue(contactId, brokerageId)
    return { success: true as const, data: result }
  } catch (err: any) {
    return { success: false as const, error: err.message }
  }
}

// ─── GET REINVIGORATION SUGGESTIONS (AI) ──────────────────────────────────────

export async function getReinvigorationSuggestions(
  contactId:   string,
  brokerageId: string,
) {
  const supabase = createServiceClient()

  const [contactRes, scoreRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("first_name, last_name, contact_persona, buyer_stage, timeline")
      .eq("id", contactId)
      .single(),
    supabase
      .from("buyer_fatigue_scores")
      .select("fatigue_score, risk_level, total_showings, total_tour_days, days_searching, offers_rejected, engagement_trend")
      .eq("contact_id", contactId)
      .maybeSingle(),
  ])

  if (contactRes.error) return { success: false as const, error: contactRes.error.message }

  const contact = contactRes.data
  const score   = scoreRes.data

  try {
    const { text } = await generateText({
      model: "anthropic/claude-opus-4.6" as any,
      messages: [
        {
          role: "system",
          content:
            "You are an expert real estate agent coach specializing in buyer fatigue and re-engagement. " +
            "Return a JSON array of exactly 4 reinvigoration suggestions. Each suggestion is a plain string under 20 words. " +
            "Be specific, actionable, and empathetic. Return only the JSON array, no other text.",
        },
        {
          role: "user",
          content:
            `Buyer: ${contact.first_name} ${contact.last_name}. ` +
            `Persona: ${contact.contact_persona ?? "unknown"}. ` +
            `Stage: ${contact.buyer_stage ?? "searching"}. ` +
            `Timeline: ${contact.timeline ?? "unknown"}. ` +
            `Fatigue score: ${score?.fatigue_score ?? "unknown"}/100 (${score?.risk_level ?? "high"}). ` +
            `Showings: ${score?.total_showings ?? 0}, Tour days: ${score?.total_tour_days ?? 0}, ` +
            `Days searching: ${score?.days_searching ?? 0}, Rejected offers: ${score?.offers_rejected ?? 0}. ` +
            `Engagement trend: ${score?.engagement_trend ?? "declining"}. ` +
            `Generate 4 specific reinvigoration suggestions for the agent.`,
        },
      ],
      maxTokens: 300,
    })

    const suggestions: string[] = JSON.parse(text.trim())
    return { success: true as const, suggestions }
  } catch {
    return {
      success: true as const,
      suggestions: [
        "Suggest narrowing the search criteria to reduce overwhelming options.",
        "Schedule a 2-week break from active touring to reset perspective.",
        "Revisit their top-rated properties from earlier in the search.",
        "Explore an adjacent price range or neighboring city for fresh options.",
      ],
    }
  }
}

// ─── GET HIGH FATIGUE BUYERS (watch / warning / critical) ─────────────────────

export async function getHighFatigueBuyers(brokerageId: string) {
  const supabase = createServiceClient()

  const { data: scores, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .in("risk_level", ["moderate", "high", "critical"])
    .order("fatigue_score", { ascending: false })

  if (error) return { success: false as const, error: error.message }

  const contactIds = (scores || []).map(s => s.contact_id).filter(Boolean)
  if (contactIds.length === 0) return { success: true as const, data: [] }

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id, buyer_stage, deleted_at")
    .in("id", contactIds)
    .is("deleted_at", null)

  const contactMap = new Map((contacts || []).map(c => [c.id, c]))

  const enriched = (scores || [])
    .filter(s => contactMap.has(s.contact_id))
    .map(s => ({ ...s, contacts: contactMap.get(s.contact_id) ?? null }))

  return { success: true as const, data: enriched }
}

// ─── GET ACTIVE BROKERAGE-WIDE FATIGUE ALERTS ─────────────────────────────────

export async function getBrokerageFatigueAlerts(brokerageId: string) {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(50)

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data: data ?? [] }
}

// ─── BROKERAGE FATIGUE DASHBOARD DATA ────────────────────────────────────────

export async function getBrokerageFatigueData(brokerageId: string) {
  const supabase = createServiceClient()

  // Query fatigue scores first
  const { data: scores, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("fatigue_score", { ascending: false })

  if (error) return { success: false as const, error: error.message }
  
  // Fetch contacts separately to avoid relationship ambiguity
  const contactIds = (scores || []).map(s => s.contact_id).filter(Boolean)
  if (contactIds.length === 0) return { success: true as const, data: [] }

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id, buyer_stage, deleted_at")
    .in("id", contactIds)
    .is("deleted_at", null)

  // Fetch agent users for each contact
  const agentIds = [...new Set((contacts || []).map(c => c.agent_id).filter(Boolean))]
  let agentMap = new Map()
  if (agentIds.length > 0) {
    const { data: agents } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .in("id", agentIds)
    agentMap = new Map(agents?.map(a => [a.id, a]) || [])
  }

  const contactMap = new Map((contacts || []).map(c => [c.id, {
    ...c,
    users: agentMap.get(c.agent_id) || null,
  }]))

  // Merge contacts into scores
  const enrichedData = (scores || [])
    .filter(s => contactMap.has(s.contact_id))
    .map(s => ({
      ...s,
      contacts: contactMap.get(s.contact_id),
    }))

  return { success: true as const, data: enrichedData }
}
