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
