"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

// Both functions burn paid AI inference. Previously trusted caller-supplied
// userId / userRole / contactId without verification — any signed-in user
// (or even unauthenticated callers, since there was no auth.getUser() check)
// could spoof an agentId + role, drain AI budget, and pull contact data
// from any agent in the brokerage.

export interface ContactInsight {
  contactId: string
  suggestion: string
  action: "call" | "email" | "schedule" | "qualify"
  reason: string
  priority: "high" | "medium" | "low"
  confidence: number
}

async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id, userType: u.user_type ?? "agent" }
}

export async function generateContactInsights(_userId?: string, _userRole?: string): Promise<ContactInsight[]> {
  // Ignore caller-supplied userId/userRole — derive from session.
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  try {
    const isAdmin = isAdminOrBroker({ user_type: auth.userType })

    // Resolve the agent_id (agents.id) for non-admin callers
    let query = supabase
      .from("contacts")
      .select(
        "id, first_name, last_name, email, phone, buyer_stage, last_contacted_at, engagement_score, intent_score, created_at, agent_id, brokerage_id",
      )
      .eq("brokerage_id", auth.brokerageId)
      .order("engagement_score", { ascending: false })
      .limit(20)

    if (!isAdmin) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", auth.userId)
        .maybeSingle()
      if (!agentRow?.id) return []
      query = query.eq("agent_id", agentRow.id)
    }

    const { data: contacts } = await query
    if (!contacts || contacts.length === 0) return []

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are an AI assistant for a real estate agent. Analyze these contacts and suggest the top 3 most important actions to take today.

Contacts:
${contacts.map((c) => `- ${c.first_name} ${c.last_name}: Stage=${c.buyer_stage}, Engagement=${c.engagement_score}, Intent=${c.intent_score}, Last Contact=${c.last_contacted_at}`).join("\n")}

For each of the top 3, provide:
1. Contact ID
2. Suggested action (call, email, schedule, qualify)
3. Brief reason (one sentence)
4. Priority (high/medium/low)
5. Confidence (0-100)

Return as JSON array: [{"contactId": "...", "suggestion": "...", "action": "...", "reason": "...", "priority": "...", "confidence": 95}]`,
    })

    const insights = JSON.parse(
      text
        .trim()
        .replace(/^```json\n?/, "")
        .replace(/\n?```$/, ""),
    )
    return insights
  } catch (error) {
    console.error("[ai-insights] error:", error)
    return []
  }
}

export async function draftSmartEmail(contactId: string, context: string): Promise<string> {
  // Auth gate — AI inference + contact PII access
  const auth = await requireCaller()
  if (!auth.ok) return ""

  const supabase = createServiceClient()

  // Verify the contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, buyer_stage, contact_persona, brokerage_id")
    .eq("id", contactId)
    .single()

  if (!contact) return ""
  if (contact.brokerage_id !== auth.brokerageId) return ""

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `Draft a professional yet friendly email for a real estate agent to send to ${contact.first_name} ${contact.last_name}.

Context: ${context}
Lead Stage: ${contact.buyer_stage}
Persona: ${contact.contact_persona}

Write a concise email (3-4 sentences) that:
- Addresses their specific needs
- Provides value
- Has a clear call-to-action
- Uses a professional but warm tone

Return only the email body, no subject line.`,
  })

  return text
}
