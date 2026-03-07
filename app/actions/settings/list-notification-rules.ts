'use server'

import { createClient } from "@/lib/supabase/server"
import { listNotificationRules as kernelListNotificationRules } from "@/lib/kernel"

export async function listNotificationRules() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  return await kernelListNotificationRules({ userId: user.id })
}
