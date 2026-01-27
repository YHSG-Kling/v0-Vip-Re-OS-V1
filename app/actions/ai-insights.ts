"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { generateText } from "ai"

export interface ContactInsight {
  contactId: string
  suggestion: string
  action: "call" | "email" | "schedule" | "qualify"
  reason: string
  priority: "high" | "medium" | "low"
  confidence: number
}

export async function generateContactInsights(userId: string, userRole: string): Promise<ContactInsight[]> {
  const supabase = createServiceClient()

  try {
    // Get contacts with recent activity
    const { data: contacts } = await supabase
      .from("contacts")
      .select(
        "id, first_name, last_name, email, phone, lead_stage, last_contact_date, engagement_score, intent_score, created_at",
      )
      .eq(
        userRole === "admin" || userRole === "broker" ? "id" : "agent_id",
        userRole === "admin" || userRole === "broker" ? undefined : userId,
      )
      .order("engagement_score", { ascending: false })
      .limit(20)

    if (!contacts || contacts.length === 0) return []

    // AI analyzes contacts and suggests next actions
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are an AI assistant for a real estate agent. Analyze these contacts and suggest the top 3 most important actions to take today.

Contacts:
${contacts.map((c) => `- ${c.first_name} ${c.last_name}: Stage=${c.lead_stage}, Engagement=${c.engagement_score}, Intent=${c.intent_score}, Last Contact=${c.last_contact_date}`).join("\n")}

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
    console.error("[v0] AI insights error:", error)
    return []
  }
}

export async function draftSmartEmail(contactId: string, context: string): Promise<string> {
  const supabase = createServiceClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, lead_stage, contact_persona")
    .eq("id", contactId)
    .single()

  if (!contact) return ""

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `Draft a professional yet friendly email for a real estate agent to send to ${contact.first_name} ${contact.last_name}.

Context: ${context}
Lead Stage: ${contact.lead_stage}
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
