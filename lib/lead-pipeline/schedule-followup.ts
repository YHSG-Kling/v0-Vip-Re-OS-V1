// lib/lead-pipeline/schedule-followup.ts
//
// Capture an explicit FUTURE-INTENT re-contact date ("call me in 6 months") on a contact or lead,
// so the reactivation cadences HONOR it (suppress nagging until due) instead of relying on age
// heuristics. The AI ISA / voice admin calls this when a person states a future timeline; the
// reactivation runners read next_followup_at via followupSuppresses(). Never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface SetFollowupInput {
  entity: "contact" | "lead"
  id: string
  /** ISO timestamp to next reach out. */
  at: string
  /** WHY / what they said — stored for the agent's context ("said calling after the school year"). */
  reason?: string | null
}

export async function setEntityFollowup(input: SetFollowupInput, client?: Svc): Promise<{ ok: boolean; error?: string }> {
  const svc = client ?? createServiceClient()
  const at = new Date(input.at)
  if (!Number.isFinite(at.getTime())) return { ok: false, error: "invalid follow-up date" }
  const table = input.entity === "lead" ? "leads" : "contacts"
  const { error } = await svc.from(table)
    .update({ next_followup_at: at.toISOString(), next_followup_reason: input.reason ?? null })
    .eq("id", input.id)
  return error ? { ok: false, error: error.message } : { ok: true }
}
