// lib/notifications/recipient-tenant.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE WAY A `notifications` ROW GETS ITS TENANT.
//
// `notifications.brokerage_id` is nullable and the table carries the
// migration-029 escape:
//
//     notifications_tenant_select
//       USING ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))
//
// so RLS admits an untenanted row for everyone. That is NOT what decides whether
// the bell lights, because every surface that reads this table ANDs an EQUALITY
// predicate, and `NULL = <uuid>` is NULL, never true:
//
//   · app/api/dashboard/badge-counts/route.ts:62 — the unread badge count every
//     user sees. It resolves `brokerageId` as `users.brokerage_id` FOR THE
//     SESSION USER and then filters
//       .eq("brokerage_id", brokerageId).eq("user_id", user.id).eq("is_read", false)
//   · app/api/cron/qbr-invitations/route.ts:98 — QBR invitation de-duplication
//   · lib/transactions/stranded-offer-reaper.ts:53 — stranded-offer re-notify
//     suppression
//
// The last two use their read to answer "have we already told them?", so an
// unstamped row does not merely fail to appear — it fails to SUPPRESS, and the
// same invitation / the same stranded-offer alert fires again.
//
// ── WHY THE RESOLVER IS "THE RECIPIENT'S users.brokerage_id" AND NOTHING ELSE ──
//
// Because that is the exact expression `badge-counts` compares against. A
// notification stamped with any other brokerage — the caller's, the anchor
// record's, the agents-row's — is stamped with a value the reader does not
// compute, and the bell stays dark just as surely as with NULL. So there is ONE
// resolver, stated as a question about the RECIPIENT:
//
//     SELECT brokerage_id FROM users WHERE id = <notifications.user_id>
//
// and exactly one no-op case, which is not a second resolver: where the
// recipient list was itself produced by a query that filtered
// `users.brokerage_id = X`, X *is* that value for every recipient by
// construction, and no second read happens.
//
// ── ID SPACES ────────────────────────────────────────────────────────────────
//
// `notifications.user_id` is `FOREIGN KEY (user_id) REFERENCES users(id)`.
// `agents.id`, `users.id`, `contacts.id` and `leads.id` are DISJOINT. An
// `agents.id` written into `user_id` is not "a slightly wrong recipient" — it is
// a 23503 foreign-key violation, so the row never lands at all. Callers that
// hold an `agents.id` must RESOLVE it (`agents.user_id`) before asking this
// module anything; this module only ever reads `users` by `users.id`.
//
// ── REFUSALS ─────────────────────────────────────────────────────────────────
//
// supabase-js RESOLVES a refused query. `const { data }` alone reads "refused"
// as "this user has no row", and a bare try/catch around a supabase call catches
// NOTHING. Both entry points here destructure `error` and report a refusal as a
// DIFFERENT outcome from "resolved to null", so a caller can fail closed on the
// first and make a product decision about the second.

/**
 * The structural shape every Supabase client in this tree satisfies — the same
 * permissive parameter `lib/errors/collect-error.ts` takes, so a session client,
 * a service client and an SSR client all pass without a cast.
 */
export type TenantReadClient = { from: (table: string) => any }

export type RecipientTenantResult =
  /** The read succeeded. `brokerageId` may still be null: that user has no brokerage. */
  | { ok: true; brokerageId: string | null }
  /** The read was REFUSED (or errored). This is not "no brokerage" and must not be treated as one. */
  | { ok: false; reason: string }

export type RecipientTenantBatchResult =
  | { ok: true; brokerageIds: Map<string, string | null> }
  | { ok: false; reason: string }

/**
 * `users.brokerage_id` for every recipient in `userIds`, in ONE read.
 *
 * Resolve ONCE PER ACTION, not once per row: a fan-out that notifies twenty
 * users asks this once with twenty ids, not twenty times with one.
 *
 * A user id present in `userIds` but absent from the returned map has no `users`
 * row at all — which for a column that is `REFERENCES users(id)` means the
 * insert would be refused anyway.
 */
export async function resolveRecipientBrokerageIds(
  client: TenantReadClient,
  userIds: Array<string | null | undefined>,
): Promise<RecipientTenantBatchResult> {
  const ids = Array.from(new Set(userIds.filter((u): u is string => typeof u === "string" && u.length > 0)))
  if (ids.length === 0) return { ok: true, brokerageIds: new Map() }

  const { data, error } = await client.from("users").select("id, brokerage_id").in("id", ids)
  // Destructured deliberately: a refusal arrives with `data: null`, exactly like
  // "none of these users exist". Widening on either is the defect.
  if (error) {
    return { ok: false, reason: `users lookup refused: ${error.message ?? String(error)}` }
  }

  const map = new Map<string, string | null>()
  for (const row of (data ?? []) as Array<{ id: string; brokerage_id: string | null }>) {
    map.set(row.id, row.brokerage_id ?? null)
  }
  return { ok: true, brokerageIds: map }
}

/** The single-recipient projection of {@link resolveRecipientBrokerageIds}. */
export async function resolveRecipientBrokerageId(
  client: TenantReadClient,
  userId: string | null | undefined,
): Promise<RecipientTenantResult> {
  if (!userId) return { ok: true, brokerageId: null }
  const batch = await resolveRecipientBrokerageIds(client, [userId])
  if (!batch.ok) return batch
  return { ok: true, brokerageId: batch.brokerageIds.get(userId) ?? null }
}

/**
 * `agents.id` → `{ userId, brokerageId }`, for the callers that hold an agent id
 * where a recipient is required.
 *
 * TWO reads, on purpose. `agents.brokerage_id` is NOT the value `badge-counts`
 * compares against — `users.brokerage_id` is — so the agent row is used ONLY to
 * cross the id space, and the tenant still comes from the one resolver above.
 * The two agree on every live row today (measured: 5 agents, 0 mismatches); when
 * they ever disagree, the reader decides which one is right, and the reader
 * reads `users`.
 */
export async function resolveAgentRecipient(
  client: TenantReadClient,
  agentId: string | null | undefined,
): Promise<
  | { ok: true; userId: string | null; brokerageId: string | null }
  | { ok: false; reason: string }
> {
  if (!agentId) return { ok: true, userId: null, brokerageId: null }
  const { data, error } = await client.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  if (error) {
    return { ok: false, reason: `agents lookup refused: ${error.message ?? String(error)}` }
  }
  const userId = ((data as { user_id: string | null } | null)?.user_id as string | null) ?? null
  if (!userId) return { ok: true, userId: null, brokerageId: null }
  const tenant = await resolveRecipientBrokerageId(client, userId)
  if (!tenant.ok) return tenant
  return { ok: true, userId, brokerageId: tenant.brokerageId }
}
