'use server'

import { createClient } from "@/lib/supabase/server"
import { listNotificationRules as kernelListNotificationRules } from "@/lib/kernel"

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function listNotificationRules() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError) {
      console.error('[v0] Auth error in listNotificationRules:', authError)
      return []
    }

    // Validate user ID is a proper UUID (not undefined, null, or string "null")
    const userId = user?.id
    if (!userId || typeof userId !== 'string' || userId === 'null' || !UUID_REGEX.test(userId)) {
      console.error('[v0] Invalid or missing user ID in listNotificationRules:', userId)
      return []
    }

    return await kernelListNotificationRules({ userId })
  } catch (error) {
    console.error('[v0] listNotificationRules error:', error)
    // Return empty array instead of throwing to prevent page crash
    return []
  }
}
