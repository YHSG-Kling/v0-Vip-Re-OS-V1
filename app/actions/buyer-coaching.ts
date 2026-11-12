"use server"

/**
 * Buyer Coaching Card — Server Actions
 *
 * The SESSION gate in front of the one buyer-coaching engine
 * (lib/intelligence/coaching-engine.ts::getBuyerCoaching): priority lookup
 * (brokerage → system default), cache miss → routed generate → cached row.
 */

// ROUTED (lane 99B), then MERGED (wave 100, lane 100C): the model call this file made now lives only
// in the survivor lib/intelligence/coaching-engine.ts::getBuyerCoaching (same routed feature,
// lib/ai/models.ts:buyer_stage_coaching). See the tombstone in the body.
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

  // TOMBSTONE (CLAUDE.md §1.1, wave 100 lane 100C — 99B open item): this action's OWN cache-then-generate
  // copy (a priority lookup on buyer_stage_coaching, a generateTextRouted("buyer_stage_coaching") call on
  // a miss, an INSERT of a system-default row) is DELETED — a second implementation of one feature over
  // one table. Survivor: lib/intelligence/coaching-engine.ts::getBuyerCoaching (freshness window,
  // scope-correct upsert, booked through the same routed feature). What this copy had and the survivor
  // lacked was merged onto it FIRST: the is_active filter, maybeSingle, the full playbook fields this card
  // renders (objections, next action, stage duration, success / risk signals) and the requesting user on
  // the ledger row. This action is now only the SESSION gate (above) in front of the survivor; the tenant
  // it passes is the session's (`brokerageId = caller.brokerageId`), never params.brokerageId.
  try {
    const { getBuyerCoaching: coachingSurvivor } = await import("@/lib/intelligence/coaching-engine")
    const c = await coachingSurvivor(stage, persona as Parameters<typeof coachingSurvivor>[1], brokerageId, { actorUserId: caller.userId })
    return {
      success:  true,
      coaching: {
        id:                       c.id ?? "generated",
        buyer_stage:              c.buyer_stage,
        persona:                  c.persona,
        coaching_headline:        c.coaching_headline,
        coaching_body:            c.coaching_body,
        suggested_talking_points: c.suggested_talking_points ?? [],
        common_objections:        c.common_objections         ?? [],
        next_action_prompt:       c.next_action_prompt        ?? null,
        estimated_stage_duration: c.estimated_stage_duration  ?? null,
        success_signals:          c.success_signals           ?? [],
        risk_signals:             c.risk_signals              ?? [],
      },
    }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Coaching could not be loaded" }
  }
}
