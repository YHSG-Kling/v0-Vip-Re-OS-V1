'use server'

import { createClient } from "@/lib/supabase/server"
import { updateNotificationRule } from "@/lib/kernel"

export async function updateNotificationRules(
  id: string,
  updates: { is_active?: boolean }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  await updateNotificationRule({
    userId: user.id,
    ruleId: id,
    updates: { is_active: updates.is_active },
  })

  return { data: { ok: true } }
}
