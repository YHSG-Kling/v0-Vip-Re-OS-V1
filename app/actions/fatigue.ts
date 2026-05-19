"use server"

/**
 * System 5.8: Buyer Fatigue Predictor — Server Actions
 *
 * Client-callable actions for the fatigue widget and brokerage dashboard.
 *
 * Previously every function in this file authenticated the user but
 * accepted contactId / brokerageId as caller-supplied params with no
 * ownership check, so a signed-in user from brokerage A could read /
 * dismiss any contact's fatigue scores or alerts from brokerage B.
 * Now: brokerage is resolved from session and the target contact /
 * alert is verified to belong to caller's brokerage before any read
 * or mutation.
 */

import { createClient }         from "@/lib/supabase/server"
import { createServiceClient }  from "@/lib/supabase/service"
import { calculateBuyerFatigue } from "@/lib/fatigue/fatigue-scorer"
import { generateRecoveryPlan }  from "@/lib/fatigue/recovery-generator"

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

// ── Get current fatigue score for one buyer ───────────────────────────────────
export async function getBuyerFatigueScore(contactId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!(await verifyContactAccess(contactId, auth.brokerageId))) {
    return { success: false, error: "Forbidden" }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", auth.brokerageId)
    .single()

  if (error && error.code !== "PGRST116") return { success: false, error: error.message }
  return { success: true, score: data ?? null }
}

// ── Get active (undismissed) fatigue alert for one buyer ──────────────────────
export async function getBuyerFatigueAlert(contactId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!(await verifyContactAccess(contactId, auth.brokerageId))) {
    return { success: false, error: "Forbidden" }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  return { success: true, alert: data ?? null }
}

// ── Dismiss a fatigue alert ───────────────────────────────────────────────────
export async function dismissFatigueAlert(alertId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Verify the alert belongs to caller's brokerage before mutating
  const { data: alert } = await supabase
    .from("fatigue_alerts")
    .select("brokerage_id")
    .eq("id", alertId)
    .maybeSingle()
  if (!alert) return { success: false, error: "Alert not found" }
  if (alert.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

  const { error } = await supabase
    .from("fatigue_alerts")
    .update({
      dismissed:    true,
      dismissed_at: new Date().toISOString(),
      dismissed_by: auth.userId,
    })
    .eq("id", alertId)
    .eq("brokerage_id", auth.brokerageId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ── Manually trigger re-score for one buyer ───────────────────────────────────
export async function triggerFatigueRescore(contactId: string, _brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!(await verifyContactAccess(contactId, auth.brokerageId))) {
    return { success: false, error: "Forbidden" }
  }

  const result = await calculateBuyerFatigue(contactId, auth.brokerageId, auth.userId)
  if (!result.success || !result.score) return { success: false, error: result.error }

  if (result.score.fatigueScore >= 60) {
    await generateRecoveryPlan(result.score)
  }

  return { success: true, score: result.score }
}

// ── Brokerage dashboard: all high-fatigue buyers ──────────────────────────────
export async function getHighFatigueBuyers(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("buyer_fatigue_scores")
    .select(`
      *,
      contacts (
        id, first_name, last_name, email, phone, buyer_stage, agent_id
      )
    `)
    .eq("brokerage_id", auth.brokerageId)
    .gte("fatigue_score", 35)
    .order("fatigue_score", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, buyers: data ?? [] }
}

// ── Get undismissed fatigue alerts for brokerage ──────────────────────────────
export async function getBrokerageFatigueAlerts(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select(`
      *,
      contacts (id, first_name, last_name, buyer_stage)
    `)
    .eq("brokerage_id", auth.brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, alerts: data ?? [] }
}
