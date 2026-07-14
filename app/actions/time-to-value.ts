"use server"

/**
 * app/actions/time-to-value.ts — the agent's own hours-saved read (shine #8).
 * Self-scoped: an agent sees ONLY their own time-saved, resolved from their
 * session. Read-only; the compute is pure in lib/intelligence/time-to-value-radar.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { loadTimeToValue, composeTimeToValueLine, type TimeToValueRead } from "@/lib/intelligence/time-to-value-radar"

export async function getMyTimeToValue(): Promise<
  { success: true; read: TimeToValueRead; line: string } | { success: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id) return { success: false, error: "No brokerage on user" }

  const agentsId = await resolveAgentId(supabase, user.id).catch(() => null)
  const read = await loadTimeToValue(createServiceClient(), (profile as any).brokerage_id, user.id, agentsId)
  return { success: true, read, line: composeTimeToValueLine(read) }
}
