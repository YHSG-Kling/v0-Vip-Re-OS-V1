// lib/activities/activity-tenant.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT OF AN `activities` ROW, RESOLVED THROUGH THE RECORD IT IS FILED
// AGAINST.
//
// ── WHY THIS FILE EXISTS AT ALL, GIVEN THE TABLE HAS A TRIGGER ──────────────
//
// `activities` is covered by a BEFORE INSERT trigger, `activities_set_brokerage`,
// and every earlier census therefore bucketed the table as "netted" and stopped
// looking. The net has holes, and they are specific:
//
//     IF NEW.brokerage_id IS NULL THEN
//       contact_id      → contacts
//       entity_type='contact'     + entity_id → contacts
//       listing_id      → listings
//       entity_type='listing'     + entity_id → listings
//       transaction_id  → transactions
//       entity_type='transaction' + entity_id → transactions
//       agent_id        → agents
//       agent_user_id   → users
//     END IF
//
//   1. BRANCH GAP. A row anchored on anything else — `entity_type='lead'`,
//      `'content'`, `'document'` — matches no branch and the column stays NULL.
//   2. SECURITY INVOKER. `prosecdef = false`, so each of those SELECTs runs under
//      the RLS of whoever is inserting. A service client bypasses RLS and the
//      trigger works; a session client that cannot read the anchor row gets
//      nothing back. Note the chain is ELSIF: a branch that MATCHES but RESOLVES
//      TO NOTHING stops the chain — it does not fall through to a later anchor
//      the caller could have read.
//
// ── AND THE FAILURE IS NOT A HIDDEN ROW. IT IS A REFUSED WRITE ──────────────
//
// `activities.brokerage_id` is **NOT NULL** with no default — verified live, and
// there are zero NULL rows in the table because there cannot be one. So where the
// trigger comes back empty the insert is REFUSED, SQLSTATE **23502**:
//
//     null value in column "brokerage_id" of relation "activities"
//     violates not-null constraint
//
// This is NOT the wave-21/22/23 class where an untenanted row survives and the
// reader's `NULL = <uuid>` equality hides it. Nothing survives. And because
// supabase-js RESOLVES a refused query rather than throwing, a writer that does
// not destructure `error` — or one wrapped in a `try/catch`, which catches
// nothing — reports success over a row that was never written.
//
// ── WHAT THE READERS COMPARE ────────────────────────────────────────────────
//
// All 28 brokerage-equality readers of `activities` compare a single scalar. They
// do not all compute it the same way:
//
//   · 26 of 28 use the CALLER'S `users.brokerage_id` — `ctx.brokerageId` from
//     `getAgentContext()`, `profile.brokerage_id`, or a `brokerageId` threaded
//     down from one of those.
//   · `app/actions/buyer-offer/respond-to-counter.ts:58` uses the ANCHOR
//     RECORD'S own tenant (`offer.brokerage_id`).
//   · `lib/kernel/deal-room-reel.ts:107` uses the brokerage currently being swept
//     (`b.id`) — record-shaped as well.
//
// Those two families coincide whenever the record belongs to the caller's
// brokerage, which is the invariant the rest of the tree already assumes, and the
// record-based answer is also the one the trigger computes. So resolving THROUGH
// THE RECORD is the value that satisfies every reader and agrees with the net
// wherever the net works. That is what this module returns.
//
// ── ID SPACES ───────────────────────────────────────────────────────────────
//
// `agents.id`, `users.id`, `contacts.id` and `leads.id` are DISJOINT. Every
// function here names the ONE table its id belongs to and reads only that table.
// Never `??` one resolver's answer onto another's.
//
// ── REFUSALS ────────────────────────────────────────────────────────────────
//
// Every read below destructures `error`. `{ data }` alone cannot tell "this
// record has no brokerage" from "you may not look at it", and one of those is a
// fact about the row while the other is a fact about the caller. Callers get the
// two outcomes separately so they can fail closed on the first and make a product
// decision about the second.
//
// Resolve ONCE PER ACTION, not once per row.

/**
 * The structural shape every Supabase client in this tree satisfies — the same
 * permissive parameter `lib/notifications/recipient-tenant.ts` takes, so a
 * session client, a service client and an SSR client all pass without a cast.
 */
export type TenantReadClient = { from: (table: string) => any }

/** Spelled on the three exported resolvers below (§1.2, 2026-08-31, lane M4):
 *  the union was exported while every public signature left it inferred, so no
 *  declaration named it and the census read it as orphaned. The refusal arm
 *  (`ok:false` ≠ "no brokerage") is the load-bearing part of the contract —
 *  callers must not collapse the two. */
export type ActivityTenantResult =
  /** The read succeeded. `brokerageId` may still be null: that record has no tenant. */
  | { ok: true; brokerageId: string | null }
  /** The read was REFUSED (or errored). This is NOT "no brokerage" and must not be treated as one. */
  | { ok: false; reason: string }

async function readBrokerageId(
  client: TenantReadClient,
  table: string,
  id: string | null | undefined,
): Promise<ActivityTenantResult> {
  if (!id) return { ok: true, brokerageId: null }
  const { data, error } = await client.from(table).select("brokerage_id").eq("id", id).maybeSingle()
  // Destructured deliberately: a refusal arrives with `data: null`, exactly like
  // "no such row". Widening on either is the defect this module exists to stop.
  if (error) return { ok: false, reason: `${table} lookup refused: ${error.message ?? String(error)}` }
  return {
    ok: true,
    brokerageId: ((data as { brokerage_id: string | null } | null)?.brokerage_id as string | null) ?? null,
  }
}

/**
 * `leads.brokerage_id` — for activities filed as `entity_type: "lead"`.
 *
 * There is NO `lead` branch in `activities_set_brokerage`. Every lead-anchored
 * activity is a BRANCH GAP and is refused 23502 unless the writer stamps.
 * `leads.brokerage_id` is itself NOT NULL, so a resolved lead always answers.
 */
export function resolveLeadBrokerageId(client: TenantReadClient, leadId: string | null | undefined): Promise<ActivityTenantResult> {
  return readBrokerageId(client, "leads", leadId)
}

/**
 * `brand_templates.brokerage_id` — for activities filed as `entity_type:
 * "content"` whose `entity_id` is a brand template.
 *
 * `entity_type='content'` matches no trigger branch either. The registry logger's
 * rows carried `agent_user_id` as their only possible anchor and its single live
 * caller (`app/dashboard/admin/brand/brand-client.tsx`) passes no user id at all,
 * so that branch was never reachable in practice.
 *
 * `brand_templates.brokerage_id` is NOT NULL, so a resolved template always
 * answers — and it is the same value `app/dashboard/admin/brand/page.tsx:47`
 * compares when it renders the brand compliance history.
 */
export function resolveBrandTemplateBrokerageId(client: TenantReadClient, templateId: string | null | undefined): Promise<ActivityTenantResult> {
  return readBrokerageId(client, "brand_templates", templateId)
}

/**
 * `users.brokerage_id` — for activities whose only anchor is the ACTING USER, i.e.
 * rows about a person rather than about a record (`lib/security/rbac.ts`'s
 * permission-denial audit and its access-grant/revoke ledger).
 *
 * There IS an `agent_user_id → users` branch in `activities_set_brokerage`, so this
 * is not a branch gap. It is a SECURITY INVOKER hole and a NULLABLE-COLUMN hole:
 *
 *   · the trigger's SELECT runs under the inserting caller's RLS, so it resolves
 *     only what that caller may read on `users`;
 *   · `users.brokerage_id` is NULLABLE (unlike `leads`/`brand_templates` above), so
 *     even a perfectly readable user can answer NULL — and NULL into a NOT NULL
 *     column is a refused insert, 23502, which supabase-js resolves as success.
 *
 * `{ ok: true, brokerageId: null }` therefore means "this user genuinely has no
 * brokerage", which callers must treat as "do not attempt the insert", NOT as
 * "stamp null". It is a different outcome from `{ ok: false }` ("the users read was
 * refused") and the two are kept apart for the reason stated at the top of this file.
 *
 * The id passed here is a **users.id** (`auth.uid()` / `users.id`), never an
 * `agents.id`. Those are disjoint spaces; this resolver reads exactly one table.
 */
export function resolveUserBrokerageId(client: TenantReadClient, userId: string | null | undefined): Promise<ActivityTenantResult> {
  return readBrokerageId(client, "users", userId)
}

// NOTE — there is deliberately NO document resolver here. `activities` rows filed
// as `entity_type: "document"` are also a branch gap, but their one writer
// (`app/actions/documents.ts:askDocumentQuestion`) already holds the whole
// document row from `getDocumentWithAnalysis`, so it reads `document.brokerage_id`
// off the record it loaded rather than fetching it a second time. A resolver
// nothing calls is not a safeguard, it is dead code.
