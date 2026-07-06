// lib/kernel/lender-linkage.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ONE canonical linkage between a lender (a users row, user_type='lender')
// and a transaction. It closes a chain that never actually worked (0 rows live):
//
//   • lender_portal_users is a PER-(user, transaction) access grant — user_id +
//     transaction_id + brokerage_id are all NOT NULL. It is NOT a per-user
//     identity row, so it can only be created at ASSIGNMENT time (a transaction
//     exists), never at invite time.
//   • transactions.lender_id  →  lender_portal_users.id  (FK). The auth gate
//     (requireLenderActor) + the lender's transaction detail read both key off
//     this FK, so a lender that isn't linked THROUGH lender_portal_users.id can
//     neither be authorized nor see the deal.
//
// The old assignLenderToTransaction wrote the lender's USER id straight into
// transactions.lender_id and omitted the NOT-NULL brokerage_id — so the insert
// failed and, even if it hadn't, requireLenderActor could never match. Every
// lender-facing read (dashboard, TC/lender brief) also filtered
// transactions.lender_id by a USER id, which points at a lender_portal_users.id.
// This module is the single source of truth so those can't drift again.

/** A safe .in() list — never empty (an empty PostgREST .in() matches nothing but
 *  a bad empty-array can error), so callers pass this sentinel for "no rows". */
const NO_MATCH = "00000000-0000-0000-0000-000000000000"
export function lenderFilterIds(rowIds: string[]): string[] {
  return rowIds.length > 0 ? rowIds : [NO_MATCH]
}

/** All lender_portal_users.id values that belong to a given lender USER — these
 *  are exactly the values that can appear in transactions.lender_id for them. */
export async function lenderPortalRowIdsForUser(
  client: any,
  userId: string,
  brokerageId?: string | null,
): Promise<string[]> {
  let q = client.from("lender_portal_users").select("id").eq("user_id", userId)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data } = await q
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
}

export interface LinkLenderResult {
  ok: boolean
  error?: string
  /** lender_portal_users.id — the value written to transactions.lender_id */
  lenderPortalId?: string
}

/**
 * Idempotently link a lender USER to a specific transaction and return the
 * lender_portal_users.id to stamp on transactions.lender_id.
 *
 * Constraint-safe: resolves an existing (user_id, transaction_id) grant and
 * updates it, else inserts — never relies on an ON CONFLICT target. All three
 * NOT-NULL columns (user_id, transaction_id, brokerage_id) are always set.
 */
export async function linkLenderToTransaction(
  svc: any,
  params: {
    lenderUserId: string
    transactionId: string
    brokerageId: string
    lenderCompany?: string | null
    accessLevel?: string
  },
): Promise<LinkLenderResult> {
  const { lenderUserId, transactionId, brokerageId } = params
  if (!lenderUserId || !transactionId || !brokerageId) {
    return { ok: false, error: "lenderUserId, transactionId and brokerageId are all required" }
  }
  const accessLevel = params.accessLevel ?? "read"

  const { data: existing } = await svc
    .from("lender_portal_users")
    .select("id")
    .eq("user_id", lenderUserId)
    .eq("transaction_id", transactionId)
    .maybeSingle()

  if (existing?.id) {
    await svc
      .from("lender_portal_users")
      .update({
        brokerage_id: brokerageId,
        ...(params.lenderCompany !== undefined ? { lender_company: params.lenderCompany } : {}),
        access_level: accessLevel,
      })
      .eq("id", existing.id)
    return { ok: true, lenderPortalId: existing.id as string }
  }

  const { data: inserted, error } = await svc
    .from("lender_portal_users")
    .insert({
      user_id: lenderUserId,
      transaction_id: transactionId,
      brokerage_id: brokerageId,
      lender_company: params.lenderCompany ?? null,
      access_level: accessLevel,
      invited_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (error || !inserted?.id) {
    return { ok: false, error: error?.message ?? "Failed to create lender portal grant" }
  }
  return { ok: true, lenderPortalId: inserted.id as string }
}
