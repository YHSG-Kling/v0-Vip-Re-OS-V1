"use server"

/**
 * System 5.8: Buyer Fatigue Predictor — Server Actions
 *
 * Client-callable actions for the fatigue widget and brokerage dashboard.
 */

import { createClient }         from "@/lib/supabase/server"
import { createServiceClient }  from "@/lib/supabase/service"
import { calculateBuyerFatigue } from "@/lib/fatigue/fatigue-scorer"
import { generateRecoveryPlan }  from "@/lib/fatigue/recovery-generator"

// ── Get current fatigue score for one buyer ───────────────────────────────────
export async function getBuyerFatigueScore(contactId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("contact_id", contactId)
    .single()

  if (error && error.code !== "PGRST116") return { success: false, error: error.message }
  return { success: true, score: data ?? null }
}

// ── Get active (undismissed) fatigue alert for one buyer ──────────────────────
export async function getBuyerFatigueAlert(contactId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("contact_id", contactId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  return { success: true, alert: data ?? null }
}

// ── Dismiss a fatigue alert ───────────────────────────────────────────────────
export async function dismissFatigueAlert(alertId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { error } = await supabase
    .from("fatigue_alerts")
    .update({
      dismissed:    true,
      dismissed_at: new Date().toISOString(),
      dismissed_by: user.id,
    })
    .eq("id", alertId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ── Manually trigger re-score for one buyer ───────────────────────────────────
export async function triggerFatigueRescore(contactId: string, brokerageId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const result = await calculateBuyerFatigue(contactId, brokerageId, user.id)
  if (!result.success || !result.score) return { success: false, error: result.error }

  if (result.score.fatigueScore >= 60) {
    await generateRecoveryPlan(result.score)
  }

  return { success: true, score: result.score }
}

// ── Brokerage dashboard: all high-fatigue buyers ──────────────────────────────
export async function getHighFatigueBuyers(brokerageId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data, error } = await supabase
    .from("buyer_fatigue_scores")
    .select(`
      *,
      contacts (
        id, first_name, last_name, email, phone, buyer_stage, agent_id
      )
    `)
    .eq("brokerage_id", brokerageId)
    .gte("fatigue_score", 35)
    .order("fatigue_score", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, buyers: data ?? [] }
}

// ── Get undismissed fatigue alerts for brokerage ──────────────────────────────
export async function getBrokerageFatigueAlerts(brokerageId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select(`
      *,
      contacts (id, first_name, last_name, buyer_stage)
    `)
    .eq("brokerage_id", brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, alerts: data ?? [] }
}
