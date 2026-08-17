import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
// lib/auth/authorize-for-user.ts
//
// "Are you this user, or someone entitled to act for them?"
//
// The orchestrator-style event handlers in app/actions/assistant.ts and
// app/actions/copilot.ts all take a `payload: any` carrying a `user_id` and then write on
// that user's behalf — log a query as them, book a coaching session for them, deliver a
// notification to them, reassign their task. They are `"use server"` exports, so each is a
// public HTTP endpoint, and the `user_id` in the payload is whatever the caller typed.
//
// assistant.ts had already grown a private `authorizeForUser` for exactly this; copilot.ts
// had not, so the same three-line question was answered in one file and not asked at all in
// the other. It lives here now, once, and both use it.
//
// NOT a `"use server"` module and NOT importing `server-only`: keeping it a plain module
// means a route handler or a `scripts/*-simulator.ts` can import the file that imports this
// without the guard dying at load with "This module cannot be imported from a Client
// Component module". The Supabase server client is reached through a dynamic import at call
// time for the same reason (the pattern lib/kernel/crm.ts uses).
//
// `users.role` is RETIRED — 19 of 23 live rows are NULL and the rest are title-cased, so any
// filter on it matches nobody. Authority is read from `user_type`.

// DERIVED from the ONE tenant-admin roster (lib/auth/resolve-user-role.ts), not
// retyped beside it. `superadmin` is added EXPLICITLY and only here — it is a
// PLATFORM identity, deliberately absent from the tenant roster, and acting for
// another user is a lane platform staff are meant to have.
export const ACT_FOR_OTHERS_ROLES = new Set([
  ...TENANT_ADMIN_USER_TYPES,
  "superadmin",
])

export type AuthorizeForUserResult =
  | { ok: true; callerUserId: string }
  | { ok: false; error: string }

/**
 * Allows the call when the session's user IS `targetUserId`, or when the session's user holds
 * a role that may act for others.
 *
 * Fails CLOSED. Both reads destructure `error`: supabase-js RESOLVES a refused query, so
 * without that a refusal would arrive as `data: null` and read identically to "this user has
 * no row" — and in a gate those must not be the same answer.
 *
 * A missing/blank `targetUserId` is NOT treated as "no target, therefore fine". It means the
 * payload never said who it was acting for, which is precisely the case a caller-supplied
 * payload should not be trusted on, so it requires the act-for-others role.
 */
export async function authorizeForUser(
  targetUserId: string | null | undefined,
): Promise<AuthorizeForUserResult> {
  const { createClient } = await import("@/lib/supabase/server")
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { ok: false, error: "Could not verify the session" }
  if (!user) return { ok: false, error: "Not authenticated" }

  if (targetUserId && targetUserId === user.id) {
    return { ok: true, callerUserId: user.id }
  }

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (roleError) return { ok: false, error: "Could not verify your role" }

  if (userRow && isAdminOrBroker({ user_type: (userRow.user_type ?? "") as string })) {
    return { ok: true, callerUserId: user.id }
  }

  return { ok: false, error: "Forbidden: must be the user or an admin" }
}
