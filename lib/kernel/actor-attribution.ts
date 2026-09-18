/**
 * lib/kernel/actor-attribution.ts — WHO did it, as a display name.
 *
 * THE survivor for the inline "resolve these users.id values to names" block
 * (§1 / §6, lane R3-B, 2026-09-03). Four copies of the same loop lived in four
 * actions — each computing `[first_name, last_name].filter(Boolean).join(" ")
 * || email` into a Map keyed by users.id, each with its own fallback and one
 * of them never reading the query's error:
 *   app/actions/compliance/dashboard.ts          metadata.resolved_by         unscoped (cookie client — RLS bounds it)
 *   app/actions/vendor-contact-access.ts         assigned_by / revoked_by     brokerage-scoped service read
 *   app/actions/superadmin/platform-sentinel.ts  acted_by                     platform-wide (correct: staff)
 *   app/dashboard/sphere/actions.ts              reviewed_by / cancelled_by   brokerage-scoped service read
 * A fifth, app/actions/dotloop-integration.ts (document_access_log.accessed_by_id),
 * resolves against BOTH identity classes and is the model for the second
 * function below.
 *
 * CONTRACT.
 *   · An ACTOR id is a users.id — the authenticated staffer who pressed the
 *     button. `agents.id` and `users.id` are DISJOINT (CLAUDE.md §3), so the
 *     one-class resolver never consults `agents`; the either-class resolver
 *     crosses via agents.user_id.
 *   · A refused read returns an EMPTY map and the reason — NEVER a partial map.
 *     A partial map would let one refused hop render as "these three people
 *     did it and nobody did the rest".
 *   · The map holds only ids that resolved to a non-empty label. What to show
 *     for an id that is NOT in the map is the CALLER's decision at its render
 *     site (null, "Teammate", the raw id — the sentinel keeps the raw id so a
 *     deleted staff account never renders as "nobody decided this").
 *   · `brokerageId` given → the read is anchored to that tenant, and an id
 *     outside it stays unresolved on purpose (the card says "outside this
 *     brokerage" rather than borrowing a name from another tenant). A caller
 *     that asks for tenant scope with NO brokerage id is refused outright
 *     (fail closed, §4) rather than silently widened to every tenant.
 *
 * `import "server-only"`, not "use server": every caller is an in-process
 * server action, and a module-level directive would have made these two
 * functions public HTTP endpoints taking a client argument.
 *
 * NOT folded here (separate baseline, recorded in the lane report): the ~28
 * users-name Map sites that resolve SUBJECTS (the agent a row is about) rather
 * than the actor who changed it.
 */
import "server-only"

import type { QueryableClient } from "@/lib/video/script-compliance"

export type ActorNameResult = { names: Map<string, string>; error: string | null }

type UserNameRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

const USER_NAME_COLUMNS = "id, first_name, last_name, email"

function labelOf(u: UserNameRow): string | null {
  const named = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
  return named || u.email || null
}

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.filter((v): v is string => typeof v === "string" && v.length > 0)))
}

function empty(error: string | null = null): ActorNameResult {
  return { names: new Map(), error }
}

async function readUsers(
  client: QueryableClient,
  ids: string[],
  brokerageId: string | null,
): Promise<{ rows: UserNameRow[]; error: string | null }> {
  let q = client.from("users").select(USER_NAME_COLUMNS).in("id", ids)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data, error } = await q
  if (error) return { rows: [], error: error.message as string }
  return { rows: (data ?? []) as UserNameRow[], error: null }
}

/**
 * users.id → display name, one batched `.in()`.
 *
 * `opts` omitted → unscoped (a cookie-session client bounded by RLS, or a
 * platform-staff read). `opts.brokerageId` given → anchored to that tenant.
 * `opts` given with a null/empty brokerageId → REFUSED with a reason: the
 * caller asked for tenant scope and could not name the tenant.
 */
export async function resolveActorNames(
  client: QueryableClient,
  actorIds: readonly string[],
  opts?: { brokerageId?: string | null },
): Promise<ActorNameResult> {
  const ids = uniqueIds(actorIds)
  if (ids.length === 0) return empty()
  if (opts && "brokerageId" in opts && !opts.brokerageId) {
    return empty("tenant-scoped actor lookup requested with no brokerage id — refused rather than widened")
  }
  const { rows, error } = await readUsers(client, ids, opts?.brokerageId ?? null)
  if (error) return empty(error)
  const names = new Map<string, string>()
  for (const u of rows) {
    const label = labelOf(u)
    if (u.id && label) names.set(u.id, label)
  }
  return { names, error: null }
}

/**
 * An id that may be EITHER a users.id or an agents.id → display name.
 *
 * For columns written by more than one identity class (document_access_log.
 * accessed_by_id: portal contacts write users-class, document custody writes
 * agents-class). Three brokerage-scoped reads — users by id, agents by id,
 * then users by the agents' user_id — and the map is keyed by whichever id the
 * caller holds. Any refused hop returns an empty map with that hop's reason.
 * Always tenant-scoped: this is a service-role shape and has no RLS to lean on.
 */
export async function resolveActorNamesEitherClass(
  client: QueryableClient,
  actorIds: readonly string[],
  opts: { brokerageId: string },
): Promise<ActorNameResult> {
  const ids = uniqueIds(actorIds)
  if (ids.length === 0) return empty()
  if (!opts?.brokerageId) {
    return empty("either-class actor lookup requested with no brokerage id — refused rather than widened")
  }
  const brokerageId = opts.brokerageId

  // USERS class.
  const direct = await readUsers(client, ids, brokerageId)
  if (direct.error) return empty(direct.error)
  const names = new Map<string, string>()
  for (const u of direct.rows) {
    const label = labelOf(u)
    if (u.id && label) names.set(u.id, label)
  }

  // AGENTS class → agents.user_id → users.
  const { data: agents, error: agentsError } = await client
    .from("agents")
    .select("id, user_id")
    .in("id", ids)
    .eq("brokerage_id", brokerageId)
  if (agentsError) return empty(agentsError.message as string)
  const agentRows = (agents ?? []) as Array<{ id: string; user_id: string | null }>
  const agentUserIds = uniqueIds(agentRows.map((a) => a.user_id ?? ""))
  if (agentUserIds.length > 0) {
    const viaAgent = await readUsers(client, agentUserIds, brokerageId)
    if (viaAgent.error) return empty(viaAgent.error)
    const byUserId = new Map<string, string>()
    for (const u of viaAgent.rows) {
      const label = labelOf(u)
      if (u.id && label) byUserId.set(u.id, label)
    }
    for (const a of agentRows) {
      const label = a.user_id ? byUserId.get(a.user_id) : undefined
      if (label) names.set(a.id, label)
    }
  }

  return { names, error: null }
}
