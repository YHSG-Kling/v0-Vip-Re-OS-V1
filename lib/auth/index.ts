/**
 * lib/auth/index.ts — SERVER-ONLY barrel.
 *
 * Safe to import in Server Components, Route Handlers, and Server Actions.
 * Do NOT import from this file in Client Components.
 *
 * For client-side auth utilities (useAuth, getClientUserRole, etc.)
 * import from "@/lib/auth/client" instead.
 */

// ─── TOMBSTONE (wave 26, lane PERM) — lib/auth/permissions.ts is DELETED ──────
//
// SURVIVOR: lib/security/permission-matrix.ts:102 `ROLE_PERMISSIONS` (with
// `ROLE_HIERARCHY` at :19 and the capability catalogue `PERMISSION_DEFINITIONS`
// at :361). Read through lib/security/role-manager.ts:RoleManager, and live at
// lib/auth/permissions-client.ts:4, app/constants/permissions.ts:2 and
// app/dashboard/admin/users/[userId]/user-edit-form.tsx:20. The live database
// has no role_capabilities table, so the static matrix IS the source of truth
// (pinned by scripts/people-ops-profile-simulator.ts).
//
// WHAT WAS THERE. A SECOND role→capability table, `ROLE_CAPABILITIES`, plus
// eleven exported helpers over it — getCurrentUserContext, getCurrentUserWithRole,
// getUserBrokerages, hasCapability, hasRole, isAdmin, assertCapability,
// assertRole, assertAdmin, getCurrentBrokerageId, canAccessResource — and the
// types Role / UserWithRole / BrokerageContext. MEASURED before deletion: zero
// importers of "@/lib/auth/permissions", zero importers of this barrel, zero
// dynamic `import("@/lib/auth")`. Every textual hit outside the module was a
// comment, scripts/orphan-export-baseline.json, or an unrelated local of the
// same name (an `isAdmin` boolean, lib/agents/brokerage-context.ts's own
// `BrokerageContext`). Nothing called any of it.
//
// NOTHING NEEDED PORTING, checked capability by capability. The survivor covers
// every role the dead table had and two it did not (contact, title_agent), and
// every grant it expressed at equal or greater breadth:
//   contacts:read|write   → contacts:view / view_all / create / edit
//   listings:read|write   → listings:view_all / create / edit
//   transactions:read|write → transactions:view / view_all / edit
//   agents:read|write     → team:view_all / team:manage_agents
//   reports:read          → analytics:view_all / view_team, compliance:generate_reports
//   admin:read|write      → settings:manage_brokerage (broker) and the admin:* family
//   compliance:read|write → compliance:view_logs / flag_violations / manage_policies / generate_reports
//   superadmin ["*"]      → features ['all_features'] (RoleManager.hasFeature treats it
//                           as the wildcard) + ROLE_HIERARCHY level 11 / canViewData 'all';
//                           platform reach itself is lib/auth/platform-guard.ts, not a
//                           capability string.
// TWO ENTRIES WERE DELIBERATELY NOT CARRIED:
//   · `lender: ["contacts:read"]` — CLAUDE.md §5 rules that contacts, lenders and
//     vendors see no financials and only their own. Porting a wrong grant onto the
//     live matrix is the trap this deletion exists to close.
//   · `billing:read` / `billing:write` — not words in the canonical `Permission`
//     union (lib/security/types.ts:363) and they need not become words: billing
//     authority is enforced at app/actions/billing.ts:46 requireTenantBillingAdmin
//     over BILLING_ADMIN_ROLES. CLAUDE.md §1 case 3 — the functionality already
//     lives elsewhere.
//
// AND IT WAS ALREADY WRONG, which is why a dead table is not harmless: its
// lookup was `ROLE_CAPABILITIES[user_type] ?? ROLE_CAPABILITIES.agent`, and it
// had no `contact` and no `title_agent` row — so a contact or a title agent
// would have been handed the AGENT capability set. m470 lists the three role
// tables it maintained (permission-matrix, permissions-service, types.ts) and
// this one is not among them: it had already fallen out of the vocabulary waves.
//
// The barrel keeps only the AuthorizedUser type re-export below. It has zero
// importers of its own; see the report for that chain.

// ─── AUTHORIZATION (re-exports from lib/security for backwards compatibility) ─
// Prefer importing directly from "@/lib/security" for new code.
// SubscriptionContext removed with the four subscription-admin gates —
// see the tombstone in ./authorization.ts.
export type { AuthorizedUser } from "./authorization"
