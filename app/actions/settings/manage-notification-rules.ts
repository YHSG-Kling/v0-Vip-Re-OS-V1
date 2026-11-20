'use server'

// ★ ACT-AS WRITE SEAM ★ — the kernel is handed the EFFECTIVE user id (the
// impersonated seat under an active FULL grant, whose users row carries the
// real tenant), not the raw staff auth id (NULL brokerage → refused). The
// kernel's own admin gate (requireBrokerageAdmin over the service client) then
// evaluates the IMPERSONATED identity; read_only grants are refused here first.
import { resolveWriteContext } from "@/lib/platform/acting-context"
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
  const ctx = await resolveWriteContext()
  if (!ctx.ok) {
    throw new Error(ctx.error)
  }

  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  // WAVE 155 (lane 155R19): ONE receipt (the acting human, the SESSION tenant) per rule change.
  const r = await ledgerSessionAction({ brokerageId: ctx.brokerageId ?? "", action: "tenant.notification_rule.create", actor: { type: "user", userId: ctx.actorUserId }, subject: { type: "notification_rule" }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { trigger_event: input.trigger_event, notification_type: input.notification_type } }, async () => createNotificationRule({ userId: ctx.userId, rule: input }))
  if (!("id" in r)) throw new Error(r.error ?? "The notification rule was not recorded")
  return r
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
  const ctx = await resolveWriteContext()
  if (!ctx.ok) {
    throw new Error(ctx.error)
  }

  const cleanUpdates = buildRuleUpdates(updates)
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({ brokerageId: ctx.brokerageId ?? "", action: "tenant.notification_rule.update", actor: { type: "user", userId: ctx.actorUserId }, subject: { type: "notification_rule", id: ruleId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { fields: Object.keys(cleanUpdates) } }, async (): Promise<{ success: boolean; error?: string }> => { await updateNotificationRule({ userId: ctx.userId, ruleId, updates: cleanUpdates }); return { success: true } })
  if (!r.success) throw new Error(r.error ?? "The notification rule change was not recorded")
}

export async function removeRule(ruleId: string): Promise<void> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) {
    throw new Error(ctx.error)
  }

  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({ brokerageId: ctx.brokerageId ?? "", action: "tenant.notification_rule.delete", actor: { type: "user", userId: ctx.actorUserId }, subject: { type: "notification_rule", id: ruleId }, riskClass: "IRREVERSIBLE", reasonCode: "HUMAN_REQUESTED" }, async (): Promise<{ success: boolean; error?: string }> => { await deleteNotificationRule({ userId: ctx.userId, ruleId }); return { success: true } })
  if (!r.success) throw new Error(r.error ?? "The notification rule deletion was not recorded")
}
