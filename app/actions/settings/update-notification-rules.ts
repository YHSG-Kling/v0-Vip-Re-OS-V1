'use server'

// ★ ACT-AS WRITE SEAM ★ — see manage-notification-rules.ts: effective
// (impersonated) user id into the kernel, read_only refused here first.
import { resolveWriteContext } from "@/lib/platform/acting-context"
import { updateNotificationRule } from "@/lib/kernel"

export async function updateNotificationRules(
  id: string,
  updates: { is_active?: boolean }
) {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) {
    throw new Error(ctx.error)
  }

  // WAVE 155 (lane 155R19): ONE receipt (the acting human, the SESSION tenant) for the toggle.
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({ brokerageId: ctx.brokerageId ?? "", action: "tenant.notification_rule.toggle", actor: { type: "user", userId: ctx.actorUserId }, subject: { type: "notification_rule", id }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { is_active: updates.is_active ?? null } }, async (): Promise<{ success: boolean; error?: string }> => { await updateNotificationRule({
    userId: ctx.userId,
    ruleId: id,
    updates: { is_active: updates.is_active },
  }); return { success: true } })
  if (!r.success) throw new Error(r.error ?? "The notification rule change was not recorded")

  return { data: { ok: true } }
}
