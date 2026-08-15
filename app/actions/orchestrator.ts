"use server"

/**
 * Client-callable orchestrator actions.
 *
 * Internal handlers + dispatch logic live in lib/orchestrator/internal.ts
 * so they are NOT registered as Next.js server actions (RPC endpoints).
 *
 * Only the two functions exported here are intended to be called from the
 * browser — and both pass through explicit auth gates first:
 *
 *   - emitEvent: requires a valid session + the input.brokerage_id is
 *     overridden to the caller's session brokerage. Prevents cross-tenant
 *     event forging via the dashboard.
 *   - orchestrateEventById: admin-only replay UI; requires admin / superadmin
 *     role and verifies the event belongs to the caller's brokerage.
 */

import { createClient } from "@/lib/supabase/server"
import type { Event, EventInput } from "@/lib/orchestrator"
import { orchestrateEvent } from "@/lib/orchestrator/internal"

// =====================================================
// EMIT EVENT — auth-gated client action
// =====================================================

export async function emitEvent(
  input: EventInput,
  processImmediately = false
): Promise<{ success: boolean; eventId?: string; error?: string }> {
  // Auth gate — must have a real session
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { success: false, error: "Unauthorized" }

  // Force brokerage_id + user_id to come from the session, never from input.
  // Previous version trusted input.brokerage_id, which let any signed-in user
  // forge events under any brokerage by passing its UUID.
  const safeInput: EventInput = {
    ...input,
    brokerage_id: u.brokerage_id,
    user_id: user.id,
  }

  try {
    // Dedupe check (per brokerage)
    if (safeInput.dedupe_key) {
      const { data: existing } = await supabase
        .from("lifecycle_events")
        .select("id")
        .eq("dedupe_key", safeInput.dedupe_key)
        .eq("brokerage_id", safeInput.brokerage_id)
        .maybeSingle()
      if (existing) return { success: true, eventId: existing.id }
    }

    const pl = (safeInput.payload ?? {}) as Record<string, any>
    const entityId = pl.contact_id ?? pl.listing_id ?? pl.video_id ?? pl.transaction_id ?? safeInput.brokerage_id
    const entityType = pl.contact_id ? "contact"
                     : pl.listing_id ? "listing"
                     : pl.video_id ? "video"
                     : pl.transaction_id ? "transaction"
                     : "brokerage"

    const { data: event, error } = await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id:  safeInput.brokerage_id,
        actor_user_id: safeInput.user_id,
        user_id:       safeInput.user_id,
        event_type:    safeInput.event_type,
        payload:       pl,
        metadata:      pl,
        source:        safeInput.source,
        dedupe_key:    safeInput.dedupe_key ?? null,
        processed:     false,
        entity_id:     entityId,
        entity_type:   entityType,
      })
      .select()
      .single()

    if (error) {
      console.log("[orchestrator] Event insert failed:", safeInput.event_type, error.message)
      return { success: true }  // non-fatal
    }

    if (processImmediately && event) {
      await orchestrateEvent(event as Event)
    }

    return { success: true, eventId: event?.id }
  } catch (err) {
    console.error("[orchestrator] emitEvent error:", err)
    return { success: true }  // non-fatal
  }
}

// =====================================================
// ORCHESTRATE BY EVENT ID — admin-only replay
// =====================================================

const REPLAY_ROLES = ["admin", "super_admin", "superadmin", "broker", "broker_owner"]

export async function orchestrateEventById(eventId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { success: false, error: "Unauthorized" }
  if (!REPLAY_ROLES.includes(u.user_type ?? "")) {
    return { success: false, error: "Forbidden" }
  }

  // "Is superadmin" is not answerable from user_type. The platform's only
  // superadmin is (user_type='admin', platform_role='superadmin'), so BOTH
  // columns are read — the same shape as public.is_platform_admin() in RLS and
  // requireSuperadmin() in lib/auth/platform-guard.ts. See
  // app/actions/vendor-budget.ts:136-147.
  const isSuperadmin =
    u.user_type === "superadmin" ||
    u.user_type === "super_admin" ||
    (u as any).platform_role === "superadmin"

  try {
    const { data: event, error: fetchError } = await supabase
      .from("lifecycle_events")
      .select("id, brokerage_id, actor_user_id, event_type, metadata, processed")
      .eq("id", eventId)
      .maybeSingle()

    if (fetchError || !event) {
      return { success: false, error: "Event not found" }
    }

    // Superadmins can replay across brokerages; everyone else must be in the
    // same brokerage as the event.
    //
    // This is a NEGATIVE test ANDed into a DENIAL, so the dead literal failed
    // CLOSED, not open: `u.user_type !== "superadmin"` was always true for the
    // real superadmin, which collapsed the condition to the plain tenant check
    // and denied the one account the exemption exists for. The gate it guards is
    // the cross-tenant replay of a lifecycle_event — nothing was ever let through
    // that should not have been; the platform owner was locked out of replaying
    // any event outside their own brokerage_id.
    if (!isSuperadmin && event.brokerage_id !== u.brokerage_id) {
      return { success: false, error: "Forbidden" }
    }

    if (event.processed) {
      return { success: true, skipped: true }
    }

    // Reconstruct Event shape and dispatch
    const eventAsEvent: Event = {
      id:           event.id,
      brokerage_id: event.brokerage_id,
      user_id:      event.actor_user_id ?? undefined,
      event_type:   event.event_type,
      payload:      (event.metadata as Record<string, any>) ?? {},
      source:       "system",
      created_at:   new Date().toISOString(),
    }

    await orchestrateEvent(eventAsEvent)

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    await supabase
      .from("lifecycle_events")
      .update({ processed: true, processed_at: new Date().toISOString(), error: errorMessage })
      .eq("id", eventId)
    return { success: false, error: errorMessage }
  }
}
