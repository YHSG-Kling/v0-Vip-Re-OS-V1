// NO DIRECTIVE (2026-09-03, lane R3-A). The module-level "use server" that stood
// here published nothing — this file has held only the tombstones below since
// 2026-08-24 — but a `"use server"` module with no session gate is the shape
// scripts/lib-use-server-census.ts counts, and a tombstone-only file has no
// business reading as a server-action module. Nothing imports it: the
// lib/security/index.ts re-exports were cleared (see its tombstone) and
// lib/auth/authorization.ts takes its type from lib/security. The tombstones
// are kept VERBATIM: their "This file is `"use server"`" describes the file as
// it was when those deletions were ruled, which is what a tombstone is for.
// `export {}` keeps this a module (isolatedModules) with nothing exported.
export {}

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — requireSuperAdmin / isSuperAdmin
// ═══════════════════════════════════════════════════════════════════════════
//
// BOTH DELETED (owner ruling 1, 2026-08-24). This file is `"use server"`, so each
// was a PUBLIC HTTP ENDPOINT (CLAUDE.md §4), and each had ZERO callers — verified
// by name across the whole tree: the only hits were the two re-export shims
// (lib/security/index.ts, lib/auth/authorization.ts), now also cleared, plus an
// unrelated local `isSuperAdmin` *prop* on three listing-launch components that
// never came from here.
//
// ── THE SURVIVOR, AT file:line ─────────────────────────────────────────────
//
//     lib/auth/platform-guard.ts:63   requireSuperadmin()
//         → lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity
//
// That is the live, called gate every platform surface actually uses, and it
// returns a result object rather than throwing, which is what its ~40 call sites
// are written against.
//
// ── WHY THIS WAS A DUPLICATE *AND* A DEFECT, NOT A NARROWER GATE ───────────
//
// Its whole decision was one line:
//
//     if (!data || data.platform_role !== "superadmin") throw …
//
// i.e. the `platform_role === 'superadmin'` HALF of the discriminator, with the
// legacy `user_type = 'superadmin'` arm missing. The survivor and
// public.is_platform_admin() in RLS both read BOTH columns. So this copy was
// fail-CLOSED, not fail-open — it would have refused a legacy superadmin account
// that RLS admits — but "the app gate is tighter than the database in a way
// nobody chose" is exactly the silent drift §6 exists to stop. Nothing here had
// to be merged forward before deleting: the survivor already does strictly more.
//
// The `AuthorizedUser` TYPE it returned lives on in lib/security/types.ts:445 and
// is still re-exported through this module's barrels; nothing else used it.

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
