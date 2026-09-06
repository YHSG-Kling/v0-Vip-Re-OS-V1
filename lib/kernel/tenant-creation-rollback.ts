// lib/kernel/tenant-creation-rollback.ts
// ─────────────────────────────────────────────────────────────────────────────
// UNDOING A TENANT THAT WAS CREATED SECONDS AGO AND COULD NOT BE FINISHED.
//
// There are exactly TWO hard `.from("brokerages").delete()` calls in this tree
// and both are creation-rollback paths for the same failure — the brokerage row
// was inserted, `provisionTenantOwner` then failed, and the half-built tenant
// must go away:
//
//   app/actions/admin/create-subscriber.ts   (superadmin creates a subscriber)
//   app/actions/auth/signup-brokerage.ts     (public self-serve signup)
//
// Both wrote the SAME line and both got it wrong the SAME two ways, which is why
// this is ONE function and not two copies (CLAUDE.md §6):
//
//     await service.from("brokerages").delete().eq("id", brokerageId)
//
// ── DEFECT 1 · THE ROLLBACK WAS ITSELF AN ORPHAN FACTORY ────────────────────
//
// MEASURED LIVE on hrvaqgvukzxfskkcrwbt, 2026-08-23 — the delete rules of every
// foreign key that points at `brokerages`:
//
//     CASCADE     293      the child dies with the tenant
//     NO ACTION   239      the delete is REFUSED while a child exists
//     SET NULL     70      the child SURVIVES with brokerage_id = NULL
//     RESTRICT      1
//
// `public.users.brokerage_id` is in the SET NULL group. So the failure this
// rollback exists to clean up left, every time it ran, a live `users` row
// belonging to no tenant — invisible to every tenant-scoped read in the product
// while fully present to the service-role client. That is precisely the class
// the owner's "we need to include orphaned children" ruling names, produced by
// the code that was supposed to be tidying up. `user_role_assignments` is in the
// same group and had the same behaviour.
//
// The users row is real at that moment and not hypothetical: the auth trigger
// `on_auth_user_created` seeds `public.users` from the invite's metadata, which
// carries `brokerage_id`. `provisionTenantOwner` can return failure AFTER that
// invite has gone out — its "Could not resolve auth user id after invite" branch
// is exactly that case.
//
// ── DEFECT 2 · THE REFUSAL WAS SWALLOWED ────────────────────────────────────
//
// Neither call site destructured `{ error }`. supabase-js RESOLVES a refused
// query (CLAUDE.md §3), so a delete blocked by any of those 239 NO ACTION keys
// returned a resolved promise and the caller reported only "Owner provisioning
// failed" — the operator was never told a tenant row had been left behind. A
// rollback that cannot be trusted to have rolled back is worse than none.
//
// ── WHY THIS MATTERS MORE AFTER m533 ────────────────────────────────────────
//
// m533 adds 68 `brokerage_id → brokerages` foreign keys with ON DELETE RESTRICT
// and its header names these two files as its precondition. RESTRICT and NO
// ACTION both refuse, so m533 does not introduce this failure class — 239 keys
// already had it — it widens it by 68. The fix is the same either way: remove
// the children first, and READ the answer.
//
// ── THE ORDER, AND WHERE IT COMES FROM ──────────────────────────────────────
//
// The list below is not "every table with a brokerage_id" (there are hundreds).
// It is the set of tables the TENANT CREATION PATH itself can write between the
// brokerage insert and the rollback point, read out of the code:
// `provisionTenantOwner` (lib/kernel/users.ts) and the
// `createOrRepairUserDomainRecords` it calls. Deepest first, so a child never
// outlives the row it points at. Every one was verified live to HAVE a
// `brokerage_id` column — a filter naming an absent column is refused entirely
// (PGRST204), which would have turned this cleanup into a no-op.
//
// ── AND WHEN SOMETHING OUTSIDE THAT LIST BLOCKS ─────────────────────────────
//
// It FAILS LOUDLY. m533's header states the trade in as many words: "a rollback
// that fails loudly beats a rollback that silently strands rows in no tenant."
// The brokerage delete's error is read and returned, the caller reports it
// alongside the provisioning failure, and the brokerage id is in the message so
// support can finish the job. A future writer that adds a provisioning-time
// child without adding it here gets a loud, named failure — not a silent one.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
//
// It does not delete the AUTH user. `provisionTenantOwner` may have adopted an
// auth identity that already existed (`resolveEmailHolder` reuses a real
// auth-linked user), so deleting it could destroy something this signup did not
// create. The stale-auth-user case is already handled on retry by
// `resolveEmailHolder`, which frees an orphan email so the trigger can rebuild
// the canonical row. Deleting the `public.users` row — which this DOES do — is
// what makes that retry clean.

// ── THE DELETE ITSELF NOW LIVES IN ONE PLACE ────────────────────────────────
//
// The mechanics below — children first, deepest-first, `count: "exact"` so a
// zero is a MEASURED zero, read every error, never throw — were re-needed by a
// second hard delete (`deleteListing`, 63 foreign keys onto `listings`). Rather
// than write them a second time (CLAUDE.md §6), they were EXTRACTED to
// `lib/kernel/child-safe-delete.ts` and this function became the tenant-shaped
// configuration of them: its table manifest, its `brokerage_id` child column,
// and its caller-facing sentence. Behaviour is unchanged — every table below is
// still `remove`, still in the same order, and the result shape both call sites
// destructure is still the one they were written against.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { ChildRule } from "./child-safe-delete"
import { deleteParentWithChildren, describeDeleteFailure } from "./child-safe-delete"

type Svc = SupabaseClient<any, any, any>

/**
 * Tables the tenant-creation path can populate before the rollback point,
 * DEEPEST FIRST. Sourced from lib/kernel/users.ts `provisionTenantOwner` and
 * `createOrRepairUserDomainRecords`; each verified live to carry `brokerage_id`.
 *
 * `teams` before `users` because `users.team_id` points at it; `users` last
 * because agents / role assignments / onboarding hang off it.
 */
export const TENANT_CREATION_CHILD_TABLES: readonly string[] = [
  "user_role_assignments",
  "agent_onboarding",
  "agent_commission_profiles",
  "transaction_coordinators",
  "agents",
  "user_invitations",
  "subscriptions",
  "lifecycle_events",
  "teams",
  "users",
]

/**
 * The same manifest expressed as the engine's rules. EVERY entry is `remove`:
 * a tenant that could not finish being created has no child that belongs to
 * anybody else, which is exactly why the disposition question the listing
 * manifest has to answer does not arise here.
 */
const TENANT_ROLLBACK_PLAN = {
  parentTable: "brokerages",
  parentIdColumn: "id",
  children: TENANT_CREATION_CHILD_TABLES.map(
    (table): ChildRule => ({ table, column: "brokerage_id", disposition: "remove" }),
  ),
} as const

export interface TenantRollbackResult {
  /** True only when the brokerage row is GONE. Anything else is a live tenant. */
  ok: boolean
  /** table → rows removed, for the tables that reported a count. */
  childrenRemoved: Record<string, number>
  /**
   * Child deletes that were REFUSED. Not fatal on their own — the brokerage
   * delete below is the verdict — but they are the reason when it fails, and
   * swallowing them is what made this defect invisible.
   */
  childRefusals: string[]
  /** Caller-safe sentence when `ok` is false. Null when the rollback succeeded. */
  error: string | null
}

/**
 * Remove a brokerage that was created moments ago and could not be finished,
 * together with the rows the creation path had already written for it.
 *
 * The tenant id is one the CALLER just inserted in the same request — never a
 * value from a request body (CLAUDE.md §4). Both call sites satisfy that by
 * construction: they pass back the id returned by their own insert.
 *
 * Never throws: a rollback that throws inside a failure handler replaces one
 * error message with a worse one. The outcome is in the result.
 */
export async function rollbackTenantCreation(
  service: Svc,
  brokerageId: string,
): Promise<TenantRollbackResult> {
  if (!brokerageId) {
    return {
      ok: false,
      childrenRemoved: {},
      childRefusals: [],
      error: "Tenant rollback could not run: no workspace id was given.",
    }
  }

  const outcome = await deleteParentWithChildren(service, TENANT_ROLLBACK_PLAN, brokerageId)
  const { childrenRemoved, childRefusals } = outcome

  if (!outcome.ok) {
    // MERGED ONTO THE SURVIVOR (§1, §6). This branch hand-built its own sentence
    // from outcome.parentError / censusFailures / childRefusals — the same job
    // `describeDeleteFailure` does in the engine, and less completely: it had no
    // arm for `blocked` or `no-parent-id`, so those two reasons rendered as
    // "(unknown)" or "()".
    //
    // AND THE HAND-ROLLED VERSION CARRIED A BUG that the merge removes:
    //     outcome.parentError ?? outcome.censusFailures.join("; ") ?? "unknown"
    // `Array.join` NEVER returns null or undefined — it returns "" for an empty
    // array — so the `?? "unknown"` arm was unreachable, and a census-failure with
    // an empty list rendered as "The workspace could not be removed after setup
    // failed ()." An empty parenthesis is the operator-facing version of "nobody
    // checked": it reads as a reason having been given.
    const why = describeDeleteFailure(outcome, "workspace")
      ?? "The workspace could not be removed after setup failed."
    return {
      ok: false,
      childrenRemoved,
      childRefusals,
      // The engine's sentence says WHAT failed; this caller adds the one fact only
      // it knows — the id support needs to finish the cleanup by hand.
      error: `${why} It is still present as ${brokerageId} and needs a support cleanup.`,
    }
  }

  return { ok: true, childrenRemoved, childRefusals, error: null }
}
