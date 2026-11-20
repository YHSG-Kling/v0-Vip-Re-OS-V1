// lib/kernel/child-safe-delete.ts
// ─────────────────────────────────────────────────────────────────────────────
// DELETING A PARENT ROW WITHOUT LEAVING ITS CHILDREN BEHIND — the one engine.
//
// EXTRACTED (not copied) from lib/kernel/tenant-creation-rollback.ts, which was
// the first place in this tree to get a hard delete right: children first,
// deepest-first, and READ the error of every step. That function now calls this
// engine and keeps only its tenant-specific manifest and its caller-facing
// sentence — see the note in its header. A second hard delete (listings) needed
// the same shape, and CLAUDE.md §6 says two spellings of one idea is a defect,
// not a style choice. So the shape lives here once.
//
// ── WHAT THE ROLLBACK VERSION COULD NOT SAY, AND THIS ONE CAN ────────────────
//
// The tenant rollback has exactly one disposition: every child on its list is
// REMOVED. That is right for a tenant that was created seconds ago and never
// had a real child. It is wrong for a parent with history: a listing may carry
// a signed listing agreement, a contact's saved-properties row, or a task — rows
// that belong to somebody else and must NOT die because a listing was deleted.
//
// So a child rule carries a DISPOSITION, and the manifest must name one for
// EVERY foreign key pointing at the parent. That completeness is the whole
// defence: "child-blind" is precisely the state of not having an answer for a
// child table, and a manifest with a hole reads exactly like a manifest with
// none. The per-parent simulators check the manifest against SCHEMA_FK_MAP,
// which is generated from the live database, so a new child table added later
// fails the check instead of quietly reopening the hole.
//
//   remove   The row exists only because the parent does. Delete it first,
//            deepest-first, reading the error of each delete.
//   block    The row is somebody else's record. If any exists, the parent
//            delete is REFUSED and the blocking tables are named.
//   detach   The database's own ON DELETE SET NULL clears the pointer and the
//            row survives, correctly, under its other owner. Not acted on — but
//            COUNTED and reported, because "the database will handle it" is the
//            sentence that hides an orphan.
//   cascade  ON DELETE CASCADE removes it with the parent. Declared so the
//            manifest is complete; no query is spent on it.
//
// ── FAIL CLOSED (CLAUDE.md §4) ──────────────────────────────────────────────
//
// A `block` census that cannot RUN refuses the delete. A count query that errors
// has not proved the table empty, and "nobody checked" must never render as
// "checked and fine". supabase-js RESOLVES refusals (CLAUDE.md §3), so every
// step here destructures `{ error }` and reads it; that single omission is what
// made the original brokerage rollback invisible for as long as it was.
//
// ── NEVER THROWS ────────────────────────────────────────────────────────────
//
// Inherited from the rollback: the outcome is in the result. A delete helper
// that throws inside a failure handler replaces one error message with a worse
// one.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export type ChildDisposition = "remove" | "block" | "detach" | "cascade"

export interface ChildRule {
  /** Child table name, exactly as it exists in the live database. */
  readonly table: string
  /** The column on the child that points at the parent. */
  readonly column: string
  readonly disposition: ChildDisposition
  /** Why this disposition and not another. Read by humans, not by code. */
  readonly why?: string
}

export interface ParentDeletePlan {
  readonly parentTable: string
  /** Primary-key column on the parent. Defaults to "id". */
  readonly parentIdColumn?: string
  /**
   * Refuse when the parent delete matched NO row.
   *
   * Not the default, because the two callers mean different things by it. The
   * tenant rollback deletes `brokerages` by id alone: a delete that matches
   * nothing means the workspace is already gone, which IS the outcome it wants.
   * The listing delete carries a `brokerage_id` predicate as well, so a delete
   * that matches nothing means the id belonged to another tenant or vanished
   * mid-request — a failure that must not report success.
   */
  readonly requireParentRowRemoved?: boolean
  /**
   * Every foreign key that points at the parent, with a disposition for each.
   * The `remove` entries are applied IN ARRAY ORDER, so they must be listed
   * deepest-first: a child never outlives the row it points at.
   */
  readonly children: readonly ChildRule[]
}

export interface ParentDeleteOutcome {
  /** True only when the parent row is GONE. Anything else means it is still there. */
  ok: boolean
  /** `block` tables that hold at least one row → the count that refused the delete. */
  blocked: Record<string, number>
  /** `remove` tables → rows deleted. */
  childrenRemoved: Record<string, number>
  /** `remove` deletes that were REFUSED, each with the database's own message. */
  childRefusals: string[]
  /** `detach` tables → rows whose pointer the database cleared, and which survive. */
  detached: Record<string, number>
  /** Census queries that could not run. A `block` failure in here is always fatal. */
  censusFailures: string[]
  /** The parent delete's own error message, verbatim. Null when it succeeded. */
  parentError: string | null
  /** Machine-readable reason for `ok: false`. Null when the delete succeeded. */
  reason: "no-parent-id" | "blocked" | "census-failed" | "parent-refused" | null
}

function emptyOutcome(): ParentDeleteOutcome {
  return {
    ok: false,
    blocked: {},
    childrenRemoved: {},
    childRefusals: [],
    detached: {},
    censusFailures: [],
    parentError: null,
    reason: null,
  }
}

/**
 * Delete one parent row and everything the manifest says must go with it.
 *
 * `parentId` must be a value the CALLER has already tied to the session's tenant
 * (CLAUDE.md §4) — this engine takes no view on tenancy, so a caller that hands
 * it an id straight out of a request body has an IDOR regardless of what happens
 * here. `parentScope` adds extra equality predicates to the PARENT delete only
 * (e.g. `{ brokerage_id }`), so even a mistaken id cannot delete across tenants.
 *
 * Order: census the blockers → refuse if any → remove the children → count the
 * detaches → delete the parent. The blocker census runs FIRST so a refused
 * delete costs nothing and, more importantly, so no `remove` runs for a parent
 * that was never going to be deleted.
 */
export async function deleteParentWithChildren(
  service: Svc,
  plan: ParentDeletePlan,
  parentId: string,
  parentScope?: Record<string, string>,
): Promise<ParentDeleteOutcome> {
  const out = emptyOutcome()

  if (!parentId) {
    out.reason = "no-parent-id"
    return out
  }

  // ── 1. BLOCKERS ───────────────────────────────────────────────────────────
  // head:true so this is a count, not a fetch. A census that errors has proved
  // nothing; it refuses (§4 fail closed) rather than reading as an empty table.
  for (const rule of plan.children) {
    if (rule.disposition !== "block") continue
    const { count, error } = await service
      .from(rule.table)
      .select(rule.column, { count: "exact", head: true })
      .eq(rule.column, parentId)

    if (error) {
      out.censusFailures.push(`${rule.table} (${error.message})`)
      continue
    }
    if (count && count > 0) out.blocked[rule.table] = count
  }

  if (out.censusFailures.length > 0) {
    out.reason = "census-failed"
    return out
  }
  if (Object.keys(out.blocked).length > 0) {
    out.reason = "blocked"
    return out
  }

  // ── 2. DETACH CENSUS ──────────────────────────────────────────────────────
  // These rows SURVIVE — the database nulls their pointer. Counting them is the
  // difference between a delete that reports what it left behind and one that
  // does not know. A failure here is recorded but is not a gate: it describes
  // an outcome rather than authorising one.
  for (const rule of plan.children) {
    if (rule.disposition !== "detach") continue
    const { count, error } = await service
      .from(rule.table)
      .select(rule.column, { count: "exact", head: true })
      .eq(rule.column, parentId)

    if (error) {
      out.censusFailures.push(`${rule.table} (${error.message})`)
      continue
    }
    if (count && count > 0) out.detached[rule.table] = count
  }

  // ── 3. REMOVE, DEEPEST FIRST ──────────────────────────────────────────────
  for (const rule of plan.children) {
    if (rule.disposition !== "remove") continue
    // count:"exact" so a zero is a MEASURED zero rather than an unread one — the
    // difference between "there was nothing to remove" and "the delete was
    // refused" is the whole point of this function.
    const { error, count } = await service
      .from(rule.table)
      .delete({ count: "exact" })
      .eq(rule.column, parentId)

    if (error) {
      // READ it (§3). A refused child delete is why the parent delete below will
      // fail, and reporting "denied" without saying which table leaves an
      // operator with nothing to act on.
      out.childRefusals.push(`${rule.table} (${error.message})`)
      continue
    }
    if (count) out.childrenRemoved[rule.table] = count
  }

  // ── 4. THE PARENT ─────────────────────────────────────────────────────────
  // `.select()` on the delete so the number of rows removed is READ rather than
  // assumed. A delete whose predicates match nothing is not an error in
  // PostgREST — it resolves, empty — so without this a wrong-tenant or
  // already-gone parent would report `ok: true` having deleted nothing, which is
  // the same silent success this engine exists to abolish.
  const idCol = plan.parentIdColumn ?? "id"
  let del = service.from(plan.parentTable).delete().eq(idCol, parentId)
  for (const [col, val] of Object.entries(parentScope ?? {})) del = del.eq(col, val)
  const { data: deletedRows, error: parentErr } = await del.select(idCol)

  if (parentErr) {
    out.parentError = parentErr.message
    out.reason = "parent-refused"
    return out
  }
  if (plan.requireParentRowRemoved && (!Array.isArray(deletedRows) || deletedRows.length === 0)) {
    out.parentError = "no matching row was removed"
    out.reason = "parent-refused"
    return out
  }

  out.ok = true
  return out
}

/**
 * One caller-safe sentence for a failed outcome, shared by every parent so the
 * phrasing of "we could not remove this and here is what is holding it" is not
 * re-invented per call site. `null` when the delete succeeded.
 */
export function describeDeleteFailure(out: ParentDeleteOutcome, noun: string): string | null {
  if (out.ok) return null
  switch (out.reason) {
    case "no-parent-id":
      return `This ${noun} could not be removed: no id was given.`
    case "census-failed":
      return (
        `This ${noun} could not be removed because its related records could not be checked ` +
        `(${out.censusFailures.join("; ")}). Nothing was deleted.`
      )
    case "blocked": {
      const parts = Object.entries(out.blocked).map(([t, n]) => `${t} (${n})`)
      return (
        `This ${noun} still has records attached and was not removed: ${parts.join(", ")}. ` +
        `Remove or reassign those first, or archive the ${noun} instead of deleting it.`
      )
    }
    case "parent-refused": {
      const blockedBy = out.childRefusals.length
        ? ` Child cleanup was refused on: ${out.childRefusals.join("; ")}.`
        : ""
      return `This ${noun} could not be removed (${out.parentError}).${blockedBy}`
    }
    default:
      return `This ${noun} could not be removed.`
  }
}
