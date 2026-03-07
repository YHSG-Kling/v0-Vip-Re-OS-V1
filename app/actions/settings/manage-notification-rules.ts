'use server'

import { createClient } from "@/lib/supabase/server"
import {
  createNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
  type NotificationRuleRow,
} from "@/lib/kernel"

// Helper: Build a typed updates object (no any casting)
function buildRuleUpdates(input: {
  rule_name?: string
  trigger_event?: string
  notification_type?: "push" | "email" | "sms"
  recipient_role?: string
  is_active?: boolean
}): Partial<Pick<NotificationRuleRow, "rule_name" | "trigger_event" | "notification_type" | "recipient_role" | "is_active">> {
  const updates: Partial<Pick<NotificationRuleRow, "rule_name" | "trigger_event" | "notification_type" | "recipient_role" | "is_active">> = {}

  if (input.rule_name !== undefined) {
    updates.rule_name = input.rule_name
  }
  if (input.trigger_event !== undefined) {
    updates.trigger_event = input.trigger_event
  }
  if (input.notification_type !== undefined) {
    updates.notification_type = input.notification_type
  }
  if (input.recipient_role !== undefined) {
    updates.recipient_role = input.recipient_role
  }
  if (input.is_active !== undefined) {
    updates.is_active = input.is_active
  }

  return updates
}

export async function createRule(input: {
  rule_name: string
  trigger_event: string
  notification_type: "push" | "email" | "sms"
  recipient_role: string
  is_active: boolean
}): Promise<{ id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  return await createNotificationRule({ userId: user.id, rule: input })
}

export async function editRule(
  ruleId: string,
  updates: {
    rule_name?: string
    trigger_event?: string
    notification_type?: "push" | "email" | "sms"
    recipient_role?: string
    is_active?: boolean
  }
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  const cleanUpdates = buildRuleUpdates(updates)
  await updateNotificationRule({ userId: user.id, ruleId, updates: cleanUpdates })
}

export async function removeRule(ruleId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  await deleteNotificationRule({ userId: user.id, ruleId })
}
