"use server"

/**
 * Buyer Coaching Card — Server Actions
 *
 * Reads/writes buyer_stage_coaching with the same cache-then-generate
 * pattern as seller-coaching: priority lookup (brokerage → system default),
 * cache miss → Anthropic generate → INSERT as system-default row.
 */

import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { createServiceClient } from "@/lib/supabase/service"
import { requireCaller } from "@/lib/auth/require-caller"
import { isCrmContactStaff } from "@/lib/auth/crm-contact-staff"

export interface BuyerCoachingResult {
  success:                  boolean
  coaching?: {
    id:                     string
    buyer_stage:            string
    persona:                string | null
    coaching_headline:      string
    coaching_body:          string
    suggested_talking_points: string[]
    common_objections:      Array<{ objection: string; response: string }>
    next_action_prompt:     string | null
    estimated_stage_duration: string | null
    success_signals:        string[]
    risk_signals:           string[]
  }
  error?: string
}

export async function getBuyerCoaching(params: {
  contactId:  string
  brokerageId?: string  // ignored — derived from session
}): Promise<BuyerCoachingResult> {
  // Auth gate — paid AI fallback runs on cache miss, PII (contact_persona,
  // buyer_stage) returned. Was unauthenticated.
  //
  // ── AND UNTIL WAVE 26 IT HAD NO ROLE TEST ──────────────────────────────────
  // It read the caller's brokerage_id, read the contact's, and admitted on
  // EQUALITY ALONE. `users.user_type` can hold `contact`, `vendor` and `lender`
  // and those rows carry a brokerage_id, so every such seat passed for EVERY
  // contact in the tenant — reading that person's buyer stage and persona, and
  // on a cache miss BILLING the brokerage for an Opus call to do it. This card
  // is agent-facing coaching ABOUT a buyer (its only caller is the CRM contact
  // page), so the back-office roster is the right question, and `isContactSelf`
  // is deliberately not offered: it is the agent's playbook, not the buyer's.
  //
  // The `users` read also discarded `error` — supabase-js RESOLVES a refusal
  // (§3), so an RLS denial of the caller's own row was reported as
  // "Unauthorized". `requireCaller()` reads that error and separates the cases.
  const caller = await requireCaller()
  if (!caller.ok) {
    return { success: false, error: caller.reason === "unauthenticated" ? "Unauthorized" : caller.error }
  }
  if (!isCrmContactStaff(caller.userType)) return { success: false, error: "Forbidden" }
  const brokerageId = caller.brokerageId

  const supabase = createServiceClient()

  // 1. Load contact.buyer_stage + contact_persona — must belong to caller's brokerage.
  //    `.maybeSingle()`, not `.single()`: single() raises PGRST116 on zero rows, so a
  //    refused read and an absent contact arrived as the same "error" and were reported
  //    with the same sentence. They are different answers and must stay apart (§4).
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("buyer_stage, contact_persona, brokerage_id")
    .eq("id", params.contactId)
    .maybeSingle()

  if (contactError) {
    return { success: false, error: "Access check failed" }
  }
  if (!contact || !contact.brokerage_id) {
    return { success: false, error: "Contact not found" }
  }
  if (contact.brokerage_id !== brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const stage   = contact.buyer_stage   ?? "prospect"
  const persona = contact.contact_persona ?? null

  // 2. Priority-ordered lookup: brokerage+persona > brokerage+null > system+persona > system+null
  const { data: cached } = await supabase
    .from("buyer_stage_coaching")
    .select("*")
    .eq("buyer_stage", stage)
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .or(persona ? `persona.eq.${persona},persona.is.null` : "persona.is.null")
    .eq("is_active", true)
    .order("brokerage_id",  { ascending: false, nullsFirst: false })
    .order("persona",       { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (cached) {
    return {
      success:  true,
      coaching: {
        id:                       cached.id,
        buyer_stage:              cached.buyer_stage,
        persona:                  cached.persona,
        coaching_headline:        cached.coaching_headline,
        coaching_body:            cached.coaching_body,
        suggested_talking_points: cached.suggested_talking_points ?? [],
        common_objections:        cached.common_objections          ?? [],
        next_action_prompt:       cached.next_action_prompt         ?? null,
        estimated_stage_duration: cached.estimated_stage_duration   ?? null,
        success_signals:          cached.success_signals            ?? [],
        risk_signals:             cached.risk_signals               ?? [],
      },
    }
  }

  // 3. Cache miss — generate via AI
  const stageLabel = stage.replace(/_/g, " ").replace("BUYER ", "").toLowerCase()
  const personaCtx = persona ? ` The buyer has a "${persona}" persona.` : ""

  const { text: raw } = await generateText({
    model: resolveModel("anthropic/claude-opus-4.6"),
    prompt: `You are a real estate coaching expert. Generate agent coaching content for a buyer at stage: "${stageLabel}".${personaCtx}

Return ONLY valid JSON matching this structure exactly:
{
  "coaching_headline": "Short motivating headline (max 10 words)",
  "coaching_body": "2-3 sentence coaching guidance for the agent about this stage",
  "suggested_talking_points": ["point 1", "point 2", "point 3", "point 4"],
  "common_objections": [
    { "objection": "I'm not sure I'm ready", "response": "Acknowledge and bridge response" },
    { "objection": "The market seems risky", "response": "Data-driven reassurance response" }
  ],
  "next_action_prompt": "Single clear next action for the agent to take",
  "estimated_stage_duration": "Typical duration string e.g. '3-7 days'",
  "success_signals": ["Signal 1", "Signal 2", "Signal 3"],
  "risk_signals": ["Risk 1", "Risk 2"]
}`,
  })

  let parsed: any
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
  } catch {
    parsed = {
      coaching_headline:        `Coaching for ${stageLabel}`,
      coaching_body:            "Guide your buyer through this stage with clear communication and consistent follow-up.",
      suggested_talking_points: ["Check in on their timeline", "Review recent listings", "Address any concerns", "Confirm next steps"],
      common_objections:        [],
      next_action_prompt:       "Schedule a check-in call within 48 hours",
      estimated_stage_duration: "3-7 days",
      success_signals:          ["Engaged in conversation", "Actively reviewing properties"],
      risk_signals:             ["Unresponsive for 3+ days"],
    }
  }

  // 4. Cache as system-default row (brokerage_id = null)
  const { data: inserted } = await supabase
    .from("buyer_stage_coaching")
    .insert({
      brokerage_id:             null,
      buyer_stage:              stage,
      persona:                  persona,
      coaching_headline:        parsed.coaching_headline,
      coaching_body:            parsed.coaching_body,
      suggested_talking_points: parsed.suggested_talking_points ?? [],
      common_objections:        parsed.common_objections         ?? [],
      next_action_prompt:       parsed.next_action_prompt        ?? null,
      estimated_stage_duration: parsed.estimated_stage_duration  ?? null,
      success_signals:          parsed.success_signals           ?? [],
      risk_signals:             parsed.risk_signals              ?? [],
      is_active:                true,
    })
    .select("id")
    .single()

  return {
    success:  true,
    coaching: {
      id:                       inserted?.id ?? "generated",
      buyer_stage:              stage,
      persona,
      coaching_headline:        parsed.coaching_headline,
      coaching_body:            parsed.coaching_body,
      suggested_talking_points: parsed.suggested_talking_points ?? [],
      common_objections:        parsed.common_objections         ?? [],
      next_action_prompt:       parsed.next_action_prompt        ?? null,
      estimated_stage_duration: parsed.estimated_stage_duration  ?? null,
      success_signals:          parsed.success_signals           ?? [],
      risk_signals:             parsed.risk_signals              ?? [],
    },
  }
}
