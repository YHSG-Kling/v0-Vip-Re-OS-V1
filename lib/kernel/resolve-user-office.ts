// lib/kernel/resolve-user-office.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ANSWER to "which office does this person work out of?"
//
// There are two places an office can be recorded and they exist for different
// people, which is exactly why this has to be one function rather than an
// `?? ` written out at each call site:
//
//   users.location_id   — the PERSON's office. Set by an admin on
//                         Admin → Office Locations. This is the only option for
//                         a pure-admin on a brokerage / multi_location tenant,
//                         because requiresAgentRow() (lib/kernel/
//                         tenant-provisioning-spec.ts) deliberately gives them
//                         no `agents` row at all.
//   agents.location_id  — the producing AGENT's office. Predates m423 and stays
//                         the office of record for anyone who has an agents row;
//                         the brokerage P&L's per-office rollup joins through it.
//
// PRECEDENCE IS users FIRST, and it is a real decision rather than an ordering
// accident: `users.location_id` is what an admin last set deliberately through
// the office UI, while `agents.location_id` can also be written by provisioning
// and import paths. The explicit act wins.
//
// NULL means NOT PINNED — which for an admin means they see the whole
// brokerage. It does not mean "no office found, fail closed": narrowing someone
// is always an explicit act, and inventing a narrowing from missing data would
// silently hide a brokerage's own numbers from its own broker.

import type { SupabaseClient } from "@supabase/supabase-js"

export interface UserOffice {
  locationId: string | null
  /** Where the answer came from — for surfaces that explain a scope to a human. */
  source: "user" | "agent" | "none"
}

/**
 * The precedence rule itself, as a pure function.
 *
 * Exists because several callers have ALREADY loaded both rows for other
 * reasons (reporting-kernel builds a whole ctx; the exception center has the
 * agent row in hand). Making them call the async resolver would re-query two
 * tables to re-derive something they are holding — so they get this instead,
 * and the rule still lives in exactly one place. The async `resolveUserOffice`
 * below is a thin wrapper over it, which is what keeps the two from drifting.
 */
export function pickUserOffice(
  userLocationId: string | null | undefined,
  agentLocationId: string | null | undefined,
): UserOffice {
  if (userLocationId) return { locationId: userLocationId, source: "user" }
  if (agentLocationId) return { locationId: agentLocationId, source: "agent" }
  return { locationId: null, source: "none" }
}

/**
 * Resolve one user's office. `client` must be a service client or a session
 * client that can read `users` and `agents` for this tenant.
 *
 * Errors are DESTRUCTURED and logged rather than swallowed: supabase-js resolves
 * a refused read, so `const { data }` alone would turn "permission denied" into
 * "this person has no office" and quietly widen their scope to the whole
 * brokerage. A refused read returns `none` — the same value as genuinely
 * unpinned — so the log line is the only way to tell them apart. Say so loudly.
 */
export async function resolveUserOffice(
  client: SupabaseClient<any, any, any>,
  userId: string,
): Promise<UserOffice> {
  const { data: userRow, error: userErr } = await client
    .from("users")
    .select("location_id")
    .eq("id", userId)
    .maybeSingle()

  if (userErr) {
    console.error(`[resolve-user-office] users read REFUSED for ${userId}: ${userErr.message}`)
  }
  const fromUser = (userRow as { location_id?: string | null } | null)?.location_id ?? null
  if (fromUser) return pickUserOffice(fromUser, null)

  const { data: agentRow, error: agentErr } = await client
    .from("agents")
    .select("location_id")
    .eq("user_id", userId)
    .maybeSingle()

  if (agentErr) {
    console.error(`[resolve-user-office] agents read REFUSED for ${userId}: ${agentErr.message}`)
  }
  const fromAgent = (agentRow as { location_id?: string | null } | null)?.location_id ?? null
  return pickUserOffice(null, fromAgent)
}
