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
