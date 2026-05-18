"use server"

import { createServiceClient }      from "@/lib/supabase/service"
import { createClient }              from "@/lib/supabase/server"
import { calculateFatigue }          from "@/lib/fatigue/fatigue-calculator"
import { generateTextRouted as generateText } from "@/lib/ai/models"

// Every read in this file used to be unauthenticated and accepted
// caller-supplied contactId / brokerageId. Any signed-in user could read
// any brokerage's buyer fatigue scores and active alerts simply by
// passing the brokerage's UUID. Now: session is required and brokerage
// is resolved from the session.

async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

async function verifyContactAccess(contactId: string, brokerageId: string): Promise<boolean> {
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  return !!contact && contact.brokerage_id === brokerageId
}

// ─── GET FATIGUE SCORE FOR ONE BUYER ─────────────────────────────────────────

export async function getBuyerFatigueScore(contactId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  if (!(await verifyContactAccess(contactId, auth.brokerageId))) {
    return { success: false as const, error: "Forbidden" }
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data }
}

// ─── GET ACTIVE FATIGUE ALERTS FOR ONE BUYER ─────────────────────────────────

export async function getBuyerFatigueAlerts(contactId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  if (!(await verifyContactAccess(contactId, auth.brokerageId))) {
    return { success: false as const, error: "Forbidden" }
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data: data ?? [] }
}

// ─── DISMISS ALERT ────────────────────────────────────────────────────────────

export async function dismissFatigueAlert(alertId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }

  const supabase = createServiceClient()

  // Verify the alert belongs to caller's brokerage before mutating
  const { data: alert } = await supabase
    .from("fatigue_alerts")
    .select("brokerage_id")
    .eq("id", alertId)
    .maybeSingle()
  if (!alert) return { success: false as const, error: "Alert not found" }
  if (alert.brokerage_id !== auth.brokerageId) return { success: false as const, error: "Forbidden" }

  const { error } = await supabase
    .from("fatigue_alerts")
    .update({
      dismissed:    true,
      dismissed_at: new Date().toISOString(),
      dismissed_by: auth.userId,
    })
    .eq("id", alertId)
    .eq("brokerage_id", auth.brokerageId)

  if (error) return { success: false as const, error: error.message }
  return { success: true as const }
}

// ─── CALCULATE NOW (on-demand) ────────────────────────────────────────────────

export async function triggerFatigueCalculation(
  contactId:   string,
  _brokerageId?: string,  // ignored — derived from session
) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  if (!(await verifyContactAccess(contactId, auth.brokerageId))) {
    return { success: false as const, error: "Forbidden" }
  }

  try {
    const result = await calculateFatigue(contactId, auth.brokerageId)
    return { success: true as const, data: result }
  } catch (err: any) {
    return { success: false as const, error: err.message }
  }
}

// ─── GET REINVIGORATION SUGGESTIONS (AI) ──────────────────────────────────────

export async function getReinvigorationSuggestions(
  contactId:   string,
  _brokerageId?: string,  // ignored — derived from session
) {
  // Burns paid AI inference — auth required
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  if (!(await verifyContactAccess(contactId, auth.brokerageId))) {
    return { success: false as const, error: "Forbidden" }
  }

  const supabase = createServiceClient()

  const [contactRes, scoreRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("first_name, last_name, contact_persona, buyer_stage, timeline")
      .eq("id", contactId)
      .eq("brokerage_id", auth.brokerageId)
      .single(),
    supabase
      .from("buyer_fatigue_scores")
      .select("fatigue_score, risk_level, total_showings, total_tour_days, days_searching, offers_rejected, engagement_trend")
      .eq("contact_id", contactId)
      .eq("brokerage_id", auth.brokerageId)
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
          role: "user",
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
      maxTokens: 400,
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

export async function getHighFatigueBuyers(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }

  const supabase = createServiceClient()

  const { data: scores, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .in("risk_level", ["moderate", "high", "critical"])
    .order("fatigue_score", { ascending: false })

  if (error) return { success: false as const, error: error.message }

  const contactIds = (scores || []).map(s => s.contact_id).filter(Boolean)
  if (contactIds.length === 0) return { success: true as const, data: [] }

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id, buyer_stage, deleted_at")
    .in("id", contactIds)
    .eq("brokerage_id", auth.brokerageId)
    .is("deleted_at", null)

  const contactMap = new Map((contacts || []).map(c => [c.id, c]))

  const enriched = (scores || [])
    .filter(s => contactMap.has(s.contact_id))
    .map(s => ({ ...s, contacts: contactMap.get(s.contact_id) ?? null }))

  return { success: true as const, data: enriched }
}

// ─── GET ACTIVE BROKERAGE-WIDE FATIGUE ALERTS ─────────────────────────────────

export async function getBrokerageFatigueAlerts(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(50)

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data: data ?? [] }
}

// ─── BROKERAGE FATIGUE DASHBOARD DATA ────────────────────────────────────────

export async function getBrokerageFatigueData(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }

  const supabase = createServiceClient()

  const { data: scores, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .order("fatigue_score", { ascending: false })

  if (error) return { success: false as const, error: error.message }

  const contactIds = (scores || []).map(s => s.contact_id).filter(Boolean)
  if (contactIds.length === 0) return { success: true as const, data: [] }

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id, buyer_stage, deleted_at")
    .in("id", contactIds)
    .eq("brokerage_id", auth.brokerageId)
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

  const enrichedData = (scores || [])
    .filter(s => contactMap.has(s.contact_id))
    .map(s => ({
      ...s,
      contacts: contactMap.get(s.contact_id),
    }))

  return { success: true as const, data: enrichedData }
}
