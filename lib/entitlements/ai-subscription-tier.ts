// lib/entitlements/ai-subscription-tier.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE WRITER of `ai_subscription_tier` — the tenant's AI ENTITLEMENT row
// (wave 140, lane 140O; owner: "every subscriber automatically gets … entitlements").
//
// WHY IT EXISTS. The table had exactly one writer, inline in the superadmin tier-change
// action (app/actions/superadmin/brokerage-management.ts changeBrokerageTierAction), so a
// tenant received an AI entitlement row ONLY when platform staff later changed its tier:
// every self-serve, direct-paid, trial, staff-created and adopted tenant started with none
// (lanes 140D/E reported it). The row is not decorative — it is what the live RLS policy
// `ai_usage_monthly_view` reads (`brokerage_id IN (SELECT brokerage_id FROM
// ai_subscription_tier WHERE admin_user_id = auth.uid() AND is_active)`, see
// lib/security/authorization.ts), so a tenant without it cannot read its own AI usage.
//
// ONE WRITER, TWO MODES (CLAUDE.md §1 — extend the survivor, never a fourth spelling):
//   fill_absent  the operating baseline (lib/kernel/tenant-operating-baseline.ts item
//                `ai_entitlement`, run by createTenantCore for EVERY door and by the
//                readiness repair): a row that exists is the tenant's — untouched, whatever
//                tier it names. Absent → created once.
//   set          the staff tier change: the row follows the new tier (tier_name,
//                is_active, admin_user_id refreshed); absent → created.
//
// RULES CARRIED FROM THE SURVIVOR
//   · subscribed_at IS TENURE (w26 lane C8): set ONCE on the insert that creates the
//     entitlement, never on an update; `updated_at` is "last touched".
//   · admin_user_id = the tenant's first admin-class seat, from the ONE roster
//     (TENANT_ADMIN_USER_TYPES — never a retyped `["broker","admin","broker_owner"]`,
//     CLAUDE.md §4). No admin seat yet → `skipped`, named; the admin user is the readiness
//     contract's own item (adminUser), never minted here.
//   · AI is covered by the subscription with per-tier overage (CLAUDE.md §5) — NO PRICE is
//     written here (monthly_budget_cents is never set; tier pricing is not set, wave 139).
//   · TENANT (§4): brokerageId is the id the caller minted (provisioner), resolved from the
//     contract (readiness) or gated on (staff action) — never a request body. Every write
//     carries it; the update is pinned by id AND brokerage_id.
//   · §3: every read/write destructures { data, error } and READS the error; the update
//     and the insert `.select()` and COUNT — a write that matched nothing is `refused`,
//     never success.
//
// The row literals sit INSIDE `.insert({...})` / `.update({...})` on the literal table name
// so the column censuses (opposite-missing, readerless-writes) see every column written.

import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

export type AiEntitlementSyncStatus = "present" | "created" | "updated" | "skipped" | "refused"

export interface AiEntitlementSyncResult {
  status: AiEntitlementSyncStatus
  /** One sentence a baseline item / audit row can carry verbatim. */
  detail: string
  rowId: string | null
  adminUserId: string | null
  tier: string
}

type Svc = { from: (table: string) => any }

/**
 * Create (or, in `set` mode, align) the tenant's `ai_subscription_tier` row. Idempotent:
 * a second call with nothing to change writes nothing and reports `present`.
 */
export async function syncAiSubscriptionTier(
  svc: Svc,
  args: { brokerageId: string; tier: string; mode: "fill_absent" | "set"; now?: () => Date },
): Promise<AiEntitlementSyncResult> {
  const brokerageId = (args.brokerageId ?? "").trim()
  const tier = (args.tier ?? "").trim()
  const refused = (detail: string, adminUserId: string | null = null): AiEntitlementSyncResult => ({ status: "refused", detail, rowId: null, adminUserId, tier })
  if (!brokerageId) return refused("no brokerage id — the AI entitlement needs the tenant the caller minted, resolved or gated on; nothing was written")
  if (!tier) return refused("no plan tier — the AI entitlement names the tier it covers; nothing was written")

  // 1. THE TENANT'S ADMIN SEAT — the roster, derived, never restated (§4). First by created_at:
  //    the owner the provisioner seated. A refused read is a refusal, not "no admin yet".
  const { data: admins, error: adminErr } = await svc
    .from("users").select("id").eq("brokerage_id", brokerageId).is("deleted_at", null)
    .in("user_type", [...TENANT_ADMIN_USER_TYPES]).order("created_at", { ascending: true }).limit(1)
  if (adminErr) return refused(`admin seat unreadable (${adminErr.message}) — nothing was written`)
  const adminUserId = ((admins ?? []) as Array<{ id: string }>)[0]?.id ?? null
  if (!adminUserId) return { status: "skipped", detail: "no tenant admin seat yet (readiness item adminUser) — the AI entitlement is written once one exists", rowId: null, adminUserId: null, tier }

  // 2. THE EXISTING ROW — one per brokerage. A refused read, or two rows, is reported, never read as "absent".
  const { data: existing, error: readErr } = await svc
    .from("ai_subscription_tier").select("id, tier_name, is_active, admin_user_id").eq("brokerage_id", brokerageId).maybeSingle()
  if (readErr) return refused(`ai_subscription_tier unreadable (${readErr.message}) — nothing was written`, adminUserId)
  const row = (existing ?? null) as { id: string; tier_name: string | null; is_active: boolean | null; admin_user_id: string | null } | null
  const nowIso = (args.now ?? (() => new Date()))().toISOString()

  if (row) {
    if (args.mode === "fill_absent") {
      return { status: "present", detail: `entitlement row holds tier ${row.tier_name ?? "(none)"} — kept (fill-absent never overwrites the tenant's row)`, rowId: row.id, adminUserId: row.admin_user_id ?? adminUserId, tier }
    }
    if (row.tier_name === tier && row.is_active === true && row.admin_user_id === adminUserId) {
      return { status: "present", detail: `entitlement row already names tier ${tier}, active, admin ${adminUserId}`, rowId: row.id, adminUserId, tier }
    }
    // subscribed_at is deliberately NOT in this patch — tenure is set once, on the insert below.
    const { data: updated, error: updErr } = await svc
      .from("ai_subscription_tier")
      .update({ tier_name: tier, is_active: true, admin_user_id: adminUserId, updated_at: nowIso })
      .eq("id", row.id).eq("brokerage_id", brokerageId)
      .select("id")
    if (updErr) return refused(`ai_subscription_tier update refused: ${updErr.message}`, adminUserId)
    if (((updated ?? []) as unknown[]).length !== 1) return refused(`ai_subscription_tier update matched ${((updated ?? []) as unknown[]).length} row(s) for ${row.id} — the tenant's row was not moved`, adminUserId)
    return { status: "updated", detail: `entitlement row moved ${row.tier_name ?? "(none)"} → ${tier}`, rowId: row.id, adminUserId, tier }
  }

  // 3. ABSENT → CREATED ONCE. subscribed_at = tenure, stamped here and only here.
  const { data: inserted, error: insErr } = await svc
    .from("ai_subscription_tier")
    .insert({ brokerage_id: brokerageId, tier_name: tier, is_active: true, admin_user_id: adminUserId, subscribed_at: nowIso, updated_at: nowIso })
    .select("id").maybeSingle()
  if (insErr) return refused(`ai_subscription_tier insert refused: ${insErr.message}`, adminUserId)
  const rowId = (inserted as { id?: string } | null)?.id ?? null
  if (!rowId) return refused("ai_subscription_tier insert returned no row — not counted as created", adminUserId)
  return { status: "created", detail: `entitlement row created for tier ${tier} (admin ${adminUserId})`, rowId, adminUserId, tier }
}

/**
 * The CANCEL half. When the tenant's subscription is cancelled the AI entitlement row is
 * deactivated and `cancelled_at` stamped — the superadmin tenant view reads it. Counted; an
 * already-inactive (or absent) row is reported, never faked.
 */
export async function deactivateAiSubscriptionTier(
  svc: Svc,
  args: { brokerageId: string; now?: () => Date },
): Promise<{ status: "deactivated" | "already_inactive" | "refused"; detail: string; rowId: string | null }> {
  const brokerageId = (args.brokerageId ?? "").trim()
  if (!brokerageId) return { status: "refused", detail: "no brokerage id — nothing was written", rowId: null }
  const nowIso = (args.now ?? (() => new Date()))().toISOString()
  const { data: rows, error } = await svc
    .from("ai_subscription_tier")
    .update({ is_active: false, cancelled_at: nowIso, updated_at: nowIso })
    .eq("brokerage_id", brokerageId).eq("is_active", true)
    .select("id")
  if (error) return { status: "refused", detail: `ai_subscription_tier deactivate refused: ${error.message}`, rowId: null }
  const hit = ((rows ?? []) as Array<{ id: string }>)[0] ?? null
  if (!hit) return { status: "already_inactive", detail: "no active AI entitlement row for this tenant — nothing to cancel", rowId: null }
  return { status: "deactivated", detail: `AI entitlement row ${hit.id} deactivated (cancelled_at ${nowIso})`, rowId: hit.id }
}
