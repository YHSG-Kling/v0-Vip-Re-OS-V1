"use server"

import { createClient } from "@/lib/supabase/server"
import type { AuthorizedUser } from "./types"

export async function requireSuperAdmin(): Promise<AuthorizedUser> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    console.warn("[Security] Unauthorized access attempt to super admin resource")
    throw new Error("Unauthorized: Not authenticated")
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .select("platform_role, email")
      .eq("id", user.id)
      .single()

    if (error) throw new Error("Authorization check failed")
    if (!data || data.platform_role !== "superadmin") {
      throw new Error("Forbidden: Super admin access required")
    }

    return { id: user.id, email: data.email, platformRole: data.platform_role }
  } catch (error) {
    if (error instanceof Error && (error.message.includes("Forbidden") || error.message.includes("Authorization"))) throw error
    console.error("[Security] Unexpected error in requireSuperAdmin:", error)
    throw new Error("Authorization check failed")
  }
}

export async function isSuperAdmin(): Promise<boolean> {
  try { await requireSuperAdmin(); return true } catch { return false }
}

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — requireSubscriptionAdmin / isSubscriptionAdmin /
//             getSubscriptionAdmin / getCurrentUserSubscriptionContext
// ═══════════════════════════════════════════════════════════════════════════
//
// All four are DELETED. They had ZERO callers — not one, anywhere in the tree,
// verified for each name individually — and this file is re-exported through
// `lib/auth/authorization.ts`, which is `"use server"`. CLAUDE.md §4: every
// export of a `"use server"` file is a PUBLIC HTTP ENDPOINT. So these were not
// merely dead code; they were four unauthenticated-reachable entry points that
// no surface in the product had ever needed.
//
// ── THE SURVIVOR, AT file:line ──────────────────────────────────────────────
//
//     app/actions/billing.ts:46   requireTenantBillingAdmin()
//     lib/auth/resolve-user-role.ts  BROKERAGE_FINANCE_ADMIN_USER_TYPES
//     public.is_brokerage_finance_admin()  (m472) — the same roster in SQL
//
// That is the live, called, role-derived answer to "may this user administer
// this tenant's subscription", and it is used by every billing surface: the
// Stripe portal, the cancellation save-offer, the tier page.
//
// ── WHY THE DELETED ONE WAS NOT A NARROWER GATE BUT AN ARBITRARY ONE ────────
//
// requireSubscriptionAdmin compared the caller against
// `ai_subscription_tier.admin_user_id`. That column has exactly ONE writer —
// app/actions/superadmin/brokerage-management.ts:270 — and what it writes is:
//
//     .from("users").select("id").eq("brokerage_id", …)
//     .in("user_type", ["broker", "admin", "broker_owner"])
//     .order("created_at", { ascending: true }).limit(1)
//
// i.e. the FIRST-CREATED member of exactly the roster the survivor already
// admits, collapsed to one row by creation order. So the deleted gate was not
// a different concept and it carried no capability the survivor lacks: it was
// the survivor's own roster, narrowed to whichever admin happened to be created
// first. Every OTHER broker/admin/broker_owner of the same brokerage would have
// been refused, for no reason a product ruling states. There was nothing to
// merge onto the survivor before deleting (CLAUDE.md §1).
//
// ── ai_subscription_tier IS NOT READERLESS, AND THIS IS THE IMPORTANT PART ──
//
// Deleting these four leaves the table with a writer and no TypeScript reader,
// and that is the correct state rather than a new orphan: the table's real
// reader is the DATABASE. Verified live on hrvaqgvukzxfskkcrwbt 2026-08-23,
// from pg_policy — the SELECT policy `ai_usage_monthly_view` on
// `public.ai_usage_monthly` reads it:
//
//     brokerage_id IN (SELECT brokerage_id FROM ai_subscription_tier
//                      WHERE admin_user_id = auth.uid() AND is_active)
//     OR team_id  IN (SELECT team_id  FROM ai_subscription_tier WHERE …)
//     OR agent_id IN (SELECT agent_id FROM ai_subscription_tier WHERE …)
//
// CLAUDE.md §3 warns that a column written only by a trigger, an .rpc() or a
// backfill reads as writerless without being writerless. This is the MIRROR of
// that trap: a table read only by an RLS policy reads as readerless without
// being readerless. The tier-change entitlement sync is load-bearing for that
// policy and must NOT be deleted on the strength of "no .from() reads it".
//
// ── TWO OPEN QUESTIONS, RECORDED RATHER THAN GUESSED (CLAUDE.md §1) ─────────
//
//   1. APP AND DATABASE DISAGREE ABOUT WHO A SUBSCRIPTION ADMIN IS. The policy
//      above says `admin_user_id = auth.uid()`; the app says "any member of the
//      finance roster". That is two spellings of one idea (§6) and the merge
//      belongs in a migration that rewrites the policy onto
//      is_brokerage_finance_admin(), not in this file.
//   2. THE POLICY STILL CARRIES team_id AND agent_id ARMS THAT CANNOT MATCH.
//      The deleted `SubscriptionContext` type had already lost its teamId and
//      agentId fields in an earlier round for exactly this reason: the sole
//      writer of ai_subscription_tier sets brokerage_id and neither of the
//      other two, and neither column carries a DEFAULT or a trigger (measured
//      2026-08-22, re-confirmed 2026-08-23 — the table holds 0 rows). Nothing
//      rebuilt them, because there is no team- or agent-level subscription to
//      hold: `plan_tier` lives on `brokerages` ONLY, and §5 prices AI per
//      brokerage tier — a team is a mini brokerage for VISIBILITY, not a
//      billing entity. Those two SQL arms are inert for the same reason the
//      TypeScript ones were.
//
// Neither is fixed here: `ai_usage_monthly` has no `.from()` reader anywhere in
// the tree, so neither is currently reachable from the product, and rewriting a
// live tenancy policy is a migration with its own evidence.
