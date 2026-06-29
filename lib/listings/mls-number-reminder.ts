// lib/listings/mls-number-reminder.ts
// ─────────────────────────────────────────────────────────────────────────────
// MLS-NUMBER ENTRY REMINDER (Listing Concierge domain). The seller portal's marketing card only shows
// MLS / Zillow / Realtor.com as "live" once a real mls_number is on the listing (see
// marketing-channels.ts) — because the MLS is what actually syndicates to those portals. When a listing
// goes live (MLS_ACTIVE per the Lifecycle contract) but the agent hasn't entered the MLS number yet,
// this nudges them ONCE to add it (updateListing already accepts mls_number), so syndication flips
// honestly to "live" for the seller. Idempotent per listing — one nudge, never nagging. Best-effort.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { needsMlsNumberReminder } from "./mls-reminder-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface MlsReminderResult { scanned: number; reminded: number }

export async function runMlsNumberReminders(
  brokerageId: string, client?: Svc, opts?: { limit?: number },
): Promise<MlsReminderResult> {
  const svc = client ?? createServiceClient()
  const result: MlsReminderResult = { scanned: 0, reminded: 0 }
  if (!brokerageId) return result

  // Live listings (MLS_ACTIVE or active) — the syndication-eligible set.
  const { data: rows } = await svc.from("listings")
    .select("id, address, mls_number, status, lifecycle_stage, agent_id")
    .eq("brokerage_id", brokerageId)
    .or("lifecycle_stage.eq.MLS_ACTIVE,status.eq.active")
    .limit(opts?.limit ?? 200)

  for (const l of (rows ?? []) as Array<{ id: string; address: string | null; mls_number: string | null; status: string | null; lifecycle_stage: string | null; agent_id: string | null }>) {
    const eligible = needsMlsNumberReminder({
      isLiveListing: l.lifecycle_stage === "MLS_ACTIVE" || l.status === "active",
      hasMlsNumber: !!l.mls_number?.trim(),
      hasAgent: !!l.agent_id,
    })
    if (!eligible) continue
    result.scanned++
    try {
      // Resolve the listing agent's user id (listings.agent_id → agents.user_id).
      const { data: agent } = await svc.from("agents").select("user_id").eq("id", l.agent_id!).maybeSingle()
      const agentUserId = (agent as { user_id: string | null } | null)?.user_id ?? null
      if (!agentUserId) continue

      // Idempotent — one nudge per listing (until the number is added). Never nag.
      const { data: existing } = await svc.from("notifications").select("id")
        .eq("entity_type", "listing").eq("entity_id", l.id).eq("type", "mls_number_needed")
        .limit(1).maybeSingle()
      if (existing) continue

      const { error } = await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: brokerageId, type: "mls_number_needed",
        title: "Add the MLS number to confirm syndication",
        body: `${l.address ?? "Your listing"} is live but has no MLS number on file yet. Add it on the listing so the MLS — and the portals it syndicates to (Zillow, Realtor.com) — show as live in the seller's portal.`,
        entity_type: "listing", entity_id: l.id, priority: "medium", is_read: false,
      })
      if (!error) result.reminded++
    } catch { /* best-effort per listing */ }
  }
  return result
}
