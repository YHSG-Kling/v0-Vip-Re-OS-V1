import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
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

// TOMBSTONE (§1.3, 2026-08-31, lane M4): `ACT_FOR_OTHERS_ROLES` deleted. It
// was built to be the gate's roster and the gate below never consulted it —
// authorizeForUser answers through isAdminOrBroker, i.e. the ONE tenant-admin
// roster (TENANT_ADMIN_USER_TYPES) directly. Its single distinctive member was
// "superadmin" AS A user_type, and platform staff live in the platform_role
// COLUMN — user_type='superadmin' matches no live row (CLAUDE.md §4 roles), so
// the entry was inert: the same matches-nobody defect this module's own header
// records for the retired `role` column. Platform staff acting on a user's
// behalf is a different, deliberately narrower lane — the impersonation /
// act-as seam (test:act-as-seam), where a grant walks the account and never
// exceeds it — not a blanket set membership here.

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
