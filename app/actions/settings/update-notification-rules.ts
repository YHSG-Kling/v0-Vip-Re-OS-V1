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

  await updateNotificationRule({
    userId: ctx.userId,
    ruleId: id,
    updates: { is_active: updates.is_active },
  })

  return { data: { ok: true } }
}
