"use server"

import { createClient } from "@/lib/supabase/server"
import { markNotificationRead, markAllNotificationsRead } from "@/lib/kernel"

export async function markOneRead(notificationId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  await markNotificationRead({ userId: user.id, notificationId })
}

export async function markAllRead(): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  await markAllNotificationsRead({ userId: user.id })
}
