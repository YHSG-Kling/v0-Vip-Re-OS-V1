"use server"

// Browser push subscription capture — the ingest side of the web-push rail
// (lib/providers/web-push.ts is the delivery side). The service worker is
// public/push-sw.js; the client UI is
// app/components/shared/push-permission-toggle.tsx.
//
// Identity is ALWAYS resolved from the session — the caller never supplies a
// userId. Writes go through the service client AFTER auth so an endpoint that
// changes hands on a shared browser is re-stamped to the new signed-in user
// (endpoint is UNIQUE — onConflict: "endpoint" is safe). Rows are never
// deleted: unsubscribe soft-disables (disabled_at + disabled_reason).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export interface PushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string
}

/** The VAPID application-server PUBLIC key — safe to expose to the browser
 *  (it's what PushManager.subscribe requires). null when push isn't configured. */
export async function getVapidPublicKey(): Promise<string | null> {
  return process.env.VAPID_PUBLIC_KEY ?? null
}

export async function subscribePush(
  input: PushSubscriptionInput,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!input?.endpoint || !input.p256dh || !input.auth) {
      return { success: false, error: "Invalid subscription (endpoint/p256dh/auth required)" }
    }

    const supabase = await createClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return { success: false, error: "Not authenticated" }

    const svc = createServiceClient()
    const { data: userRow, error: userErr } = await svc
      .from("users")
      .select("brokerage_id")
      .eq("id", authUser.id)
      .maybeSingle()
    if (userErr) {
      console.error("[v0] subscribePush: users lookup failed:", userErr.message)
      return { success: false, error: "Failed to resolve user profile" }
    }

    const now = new Date().toISOString()
    const { error } = await svc
      .from("push_subscriptions")
      .upsert(
        {
          user_id: authUser.id,
          brokerage_id: (userRow?.brokerage_id as string | null) ?? null,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          user_agent: input.userAgent ?? null,
          last_seen_at: now,
          // Re-subscribing revives a previously disabled endpoint.
          disabled_at: null,
          disabled_reason: null,
        },
        { onConflict: "endpoint" },
      )
    if (error) {
      console.error("[v0] subscribePush: upsert failed:", error.message)
      return { success: false, error: "Failed to save push subscription" }
    }

    return { success: true }
  } catch (e) {
    console.error("[v0] subscribePush failed:", e)
    return { success: false, error: e instanceof Error ? e.message : "Failed to subscribe" }
  }
}

/**
 * ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF (no duplicate existed).
 *
 * `user_agent`, `last_seen_at` and `disabled_reason` were written by
 * subscribePush/unsubscribePush (:55) and by the delivery rail's soft-disable
 * (lib/providers/web-push.ts:110, reason "endpoint_gone") and read by NOBODY.
 * The two live readers select only what they need to SEND
 * (web-push.ts:74 → id/endpoint/p256dh/auth) or to count
 * (lib/onboarding/critical-setup.ts:515 → id), so the user could never see
 * that the browser they enabled push on months ago had been silently pruned:
 * the toggle on THIS browser says "Disabled" and says nothing about the other
 * four devices, one of which the push service hung up on.
 *
 * This is the missing reader: the signed-in user's OWN devices, with why each
 * dead one died. Scope is the SESSION user id (§4) — there is no parameter to
 * spoof, and a user never sees another user's endpoints.
 */
export interface PushDeviceRow {
  id: string
  /** Raw UA string as the browser reported it at subscribe time; may be null. */
  userAgent: string | null
  lastSeenAt: string | null
  disabledAt: string | null
  /** "user_unsubscribed" | "endpoint_gone" | null — the honest reason. */
  disabledReason: string | null
}

export async function listMyPushDevices(): Promise<{
  success: boolean
  devices?: PushDeviceRow[]
  error?: string
}> {
  try {
    const supabase = await createClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return { success: false, error: "Not authenticated" }

    const svc = createServiceClient()
    const { data, error } = await svc
      .from("push_subscriptions")
      .select("id, user_agent, last_seen_at, disabled_at, disabled_reason")
      .eq("user_id", authUser.id)
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(25)
    // §3 — a swallowed refusal would render as "you have no devices", which is
    // exactly the false all-clear this list exists to prevent.
    if (error) {
      console.error("[v0] listMyPushDevices: select failed:", error.message)
      return { success: false, error: "Failed to read your push devices" }
    }

    return {
      success: true,
      devices: (data ?? []).map((row: any) => ({
        id: row.id as string,
        userAgent: (row.user_agent as string | null) ?? null,
        lastSeenAt: (row.last_seen_at as string | null) ?? null,
        disabledAt: (row.disabled_at as string | null) ?? null,
        disabledReason: (row.disabled_reason as string | null) ?? null,
      })),
    }
  } catch (e) {
    console.error("[v0] listMyPushDevices failed:", e)
    return { success: false, error: e instanceof Error ? e.message : "Failed to read push devices" }
  }
}

export async function unsubscribePush(
  input: { endpoint: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!input?.endpoint) return { success: false, error: "endpoint required" }

    const supabase = await createClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return { success: false, error: "Not authenticated" }

    // Soft-disable OWN row only — never delete, never touch another user's row.
    const svc = createServiceClient()
    const { error } = await svc
      .from("push_subscriptions")
      .update({ disabled_at: new Date().toISOString(), disabled_reason: "user_unsubscribed" })
      .eq("endpoint", input.endpoint)
      .eq("user_id", authUser.id)
    if (error) {
      console.error("[v0] unsubscribePush: update failed:", error.message)
      return { success: false, error: "Failed to unsubscribe" }
    }

    return { success: true }
  } catch (e) {
    console.error("[v0] unsubscribePush failed:", e)
    return { success: false, error: e instanceof Error ? e.message : "Failed to unsubscribe" }
  }
}
