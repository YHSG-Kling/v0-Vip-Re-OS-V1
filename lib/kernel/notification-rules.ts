import { createClient } from "@/lib/supabase/server"

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

async function requireBrokerAdmin(
  userId: string
): Promise<{ brokerageId: string; userType: string }> {
  const supabase = await createClient()

  const { data: user, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", userId)
    .single()

  if (error || !user) {
    throw new Error("User not found")
  }

  if (!["admin", "broker", "superadmin"].includes(user.user_type)) {
    throw new Error("Forbidden: insufficient permissions")
  }

  return { brokerageId: user.brokerage_id, userType: user.user_type }
}

// ─── EXPORTED FUNCTIONS ───────────────────────────────────────────────────────

export async function listNotificationRules(params: {
  userId: string
}): Promise<NotificationRuleRow[]> {
  const { brokerageId } = await requireBrokerAdmin(params.userId)
  const supabase = await createClient()

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
  const supabase = await createClient()

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
  const supabase = await createClient()

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
  const supabase = await createClient()

  const { error } = await supabase
    .from("notification_rules")
    .delete()
    .eq("id", params.ruleId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    throw error
  }
}
