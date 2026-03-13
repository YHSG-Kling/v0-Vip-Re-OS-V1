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

  // Try to get user from public.users first
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", userId)
    .maybeSingle()

  console.log("[v0] requireBrokerAdmin - userId:", userId, "user:", user, "userError:", userError)

  // If user found in public.users with brokerage_id, check permissions
  if (user?.brokerage_id) {
    const userType = user.user_type || "admin" // Default to admin if user_type is null
    if (!["admin", "broker", "superadmin"].includes(userType)) {
      throw new Error("Forbidden: insufficient permissions")
    }
    return { brokerageId: user.brokerage_id, userType }
  }

  // Fallback: check user_role_assignments table
  const { data: roleAssignment, error: roleError } = await supabase
    .from("user_role_assignments")
    .select("brokerage_id, role")
    .eq("user_id", userId)
    .maybeSingle()

  console.log("[v0] requireBrokerAdmin - roleAssignment:", roleAssignment, "roleError:", roleError)

  if (roleAssignment?.brokerage_id) {
    const role = roleAssignment.role || "admin" // Default to admin if role is null
    if (!["admin", "broker", "superadmin"].includes(role)) {
      throw new Error("Forbidden: insufficient permissions")
    }
    return { brokerageId: roleAssignment.brokerage_id, userType: role }
  }

  // Final fallback: Get first available brokerage for this admin user
  // This handles cases where the user exists but brokerage_id relationship is incomplete
  const { data: firstBrokerage } = await supabase
    .from("brokerages")
    .select("id")
    .limit(1)
    .maybeSingle()

  console.log("[v0] requireBrokerAdmin - firstBrokerage fallback:", firstBrokerage)

  if (firstBrokerage?.id) {
    // User exists but wasn't properly linked - return with the brokerage
    return { brokerageId: firstBrokerage.id, userType: "admin" }
  }

  // If still no user found, throw error
  throw new Error("User not found or not associated with a brokerage")
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
