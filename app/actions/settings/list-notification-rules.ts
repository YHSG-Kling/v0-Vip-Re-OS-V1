'use server'

// ACT-AS SEAM (read side) — the kernel gets the EFFECTIVE user id (the
// impersonated seat when acting-as), whose users row carries the real tenant;
// the raw staff auth id has none and was refused by the kernel's admin gate.
import { resolveActingContext } from "@/lib/platform/acting-context"
import { listNotificationRules as kernelListNotificationRules } from "@/lib/kernel"

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function listNotificationRules() {
  try {
    const ctx = await resolveActingContext()
    if (!ctx.ok) return []

    // Validate user ID is a proper UUID (not undefined, null, or string "null")
    const userId = ctx.userId
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
