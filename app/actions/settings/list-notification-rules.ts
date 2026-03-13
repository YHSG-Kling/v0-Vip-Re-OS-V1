'use server'

import { createClient } from "@/lib/supabase/server"
import { listNotificationRules as kernelListNotificationRules } from "@/lib/kernel"

export async function listNotificationRules() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  try {
    return await kernelListNotificationRules({ userId: user.id })
  } catch (error) {
    console.error('[v0] listNotificationRules error:', error)
    // Return empty array instead of throwing to prevent page crash
    return []
  }
}
