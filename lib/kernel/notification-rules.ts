import { createServiceClient } from "@/lib/supabase/service"
import { requireBrokerageAdmin } from "@/lib/auth/require-brokerage-admin"

// ─── TYPES ───────────────────────────────────────────────────────────────────

export type NotificationRuleRow = {
  id: string
  brokerage_id: string
  rule_name: string
  trigger_event: string
  notification_type: "push" | "email" | "sms"
  recipient_role: string
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

// ─── INTERNAL HELPER ─────────────────────────────────────────────────────────

// The UUID validation that lived here MOVED FORWARD into
// lib/auth/require-brokerage-admin.ts, which is now the only caller that needed
// it. Deleted rather than left behind: a const nothing reads is the orphan this
// workstream keeps having to re-triage.

/**
 * DELETED — this was the SECOND of three copies of the brokerage-admin gate, and
 * it carried both defects the survivor fixes: it omitted `broker_owner` (which
 * public.is_brokerage_admin() admits) and its `superadmin` branch tested
 * user_type alone, which ZERO live rows satisfy.
 *
 * Survivor: lib/auth/require-brokerage-admin.ts:requireBrokerageAdmin.
 * MERGED FORWARD from this copy: the UUID validation on userId, and the
 * user_role_assignments fallback — the survivor's original had neither.
 *
 * The service client is still created here and injected, so this module's
 * RLS-bypassing posture is unchanged.
 */
async function requireBrokerAdmin(
  userId: string
): Promise<{ brokerageId: string; userType: string }> {
  const { brokerageId, userType } = await requireBrokerageAdmin(createServiceClient(), userId)
  return { brokerageId, userType }
}

// ─── EXPORTED FUNCTIONS ───────────────────────────────────────────────────────

export async function listNotificationRules(params: {
  userId: string
}): Promise<NotificationRuleRow[]> {
  const { brokerageId } = await requireBrokerAdmin(params.userId)
  const supabase = createServiceClient()

  const { data: rules, error } = await supabase
    .from("notification_rules")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("trigger_event", { ascending: true })
    .order("recipient_role", { ascending: true })

  if (error) throw error

  return rules || []
}

export async function updateNotificationRule(params: {
  userId: string
  ruleId: string
  updates: Partial<
    Pick<
      NotificationRuleRow,
      | "rule_name"
      | "trigger_event"
      | "notification_type"
      | "recipient_role"
      | "is_active"
    >
  >
}): Promise<void> {
  const { brokerageId } = await requireBrokerAdmin(params.userId)
  const supabase = createServiceClient()

  const { error } = await supabase
    .from("notification_rules")
    .update({
      ...params.updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.ruleId)
    .eq("brokerage_id", brokerageId)

  if (error) throw error
}

export async function createNotificationRule(params: {
  userId: string
  rule: {
    rule_name: string
    trigger_event: string
    notification_type: "push" | "email" | "sms"
    recipient_role: string
    is_active: boolean
  }
}): Promise<{ id: string }> {
  const { brokerageId } = await requireBrokerAdmin(params.userId)
  const supabase = createServiceClient()

  const { data: insertedRow, error } = await supabase
    .from("notification_rules")
    .insert({
      brokerage_id: brokerageId,
      rule_name: params.rule.rule_name,
      trigger_event: params.rule.trigger_event,
      notification_type: params.rule.notification_type,
      recipient_role: params.rule.recipient_role,
      is_active: params.rule.is_active,
    })
    .select("id")
    .single()

  if (error) {
    throw error
  }

  if (!insertedRow) {
    throw new Error("Failed to insert notification rule")
  }

  return { id: insertedRow.id }
}

export async function deleteNotificationRule(params: {
  userId: string
  ruleId: string
}): Promise<void> {
  const { brokerageId } = await requireBrokerAdmin(params.userId)
  const supabase = createServiceClient()

  const { error } = await supabase
    .from("notification_rules")
    .delete()
    .eq("id", params.ruleId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    throw error
  }
}
