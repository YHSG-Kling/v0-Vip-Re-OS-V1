// lib/kernel/tier-role-matrix.ts
//
// PURE, server+client-safe tier → invitable-role matrix. Plain module (NOT
// "use server") so the SAME truth drives the invite server actions, the
// role-change gate, the god-console tenant-user creator, and the invite UI —
// no drift. Only TYPE imports from the kernel (erased at compile time), so it
// is safe in client bundles.
//
// THE BUSINESS MODEL the matrix encodes:
//   • solo_agent    — ONE seat. The owner IS admin+agent (provisioning already
//                     makes them so). There are no additional seat roles to
//                     invite — only PARTNER roles (vendor, lender), which every
//                     tier may always invite.
//   • team          — adds team STRUCTURE: the owner leads a team and can seat
//                     admins, team leads, agents, and ISAs (+ partners).
//   • brokerage     — adds brokerage GOVERNANCE roles on top of team seats:
//                     broker, transaction coordinator, compliance officer.
//   • multi_location — brokerage + locations. Locations are STRUCTURE, not
//                     roles, so the invitable-role set is identical to brokerage.
//
// superadmin/support/etc. are PLATFORM roles — never tenant-invitable, so they
// appear in no tier's list. Platform staff are provisioned through their own
// path (see app/actions/superadmin/tenant-users.ts).

import type { UserDomainRole, CanonicalTier } from "./users"

/** Partner roles every tier may invite (a solo agent can always invite vendors — spec). */
const PARTNER_ROLES: readonly UserDomainRole[] = ["vendor", "lender"]

/** Brokerage-governance set — also the multi_location set (locations ≠ roles). */
const BROKERAGE_ROLES: readonly UserDomainRole[] = [
  "admin", "broker", "team_lead", "agent", "tc", "isa", "compliance_officer",
  ...PARTNER_ROLES,
]

/** Canonical tier → invitable roles. THE matrix — every invite surface derives from it. */
export const TIER_INVITABLE_ROLES: Record<CanonicalTier, readonly UserDomainRole[]> = {
  solo_agent:     [...PARTNER_ROLES],
  team:           ["admin", "team_lead", "agent", "isa", ...PARTNER_ROLES],
  brokerage:      BROKERAGE_ROLES,
  multi_location: BROKERAGE_ROLES,
}

/** Ascending capability order — used to answer "which tier unlocks this role?". */
export const TIER_ORDER: readonly CanonicalTier[] = ["solo_agent", "team", "brokerage", "multi_location"]

/** Human labels for upgrade copy (the only product names the UI may use). */
export const TIER_LABELS: Record<CanonicalTier, string> = {
  solo_agent:     "Solo",
  team:           "Team",
  brokerage:      "Brokerage",
  multi_location: "Multi-Location",
}

export function isCanonicalTier(tier: string | null | undefined): tier is CanonicalTier {
  return !!tier && tier in TIER_INVITABLE_ROLES
}

/**
 * Invitable roles for a tenant tier.
 * Unknown/legacy/null tiers FAIL OPEN to the full brokerage set — the
 * pre-matrix behavior — so a legacy tenant whose brokerages.plan_tier was never
 * backfilled keeps a working invite surface instead of being bricked to
 * partners-only. Canonical tiers are enforced strictly.
 */
export function invitableRolesForTier(tier: string | null | undefined): readonly UserDomainRole[] {
  return isCanonicalTier(tier) ? TIER_INVITABLE_ROLES[tier] : BROKERAGE_ROLES
}

/** Is this role invitable on this tier? (Same fail-open rule for unknown tiers.) */
export function tierAllowsRole(tier: string | null | undefined, role: UserDomainRole): boolean {
  return invitableRolesForTier(tier).includes(role)
}

/** Lowest tier whose matrix includes the role — null for platform-only roles. */
export function minimumTierForRole(role: UserDomainRole): CanonicalTier | null {
  for (const tier of TIER_ORDER) {
    if (TIER_INVITABLE_ROLES[tier].includes(role)) return tier
  }
  return null
}

/** Safe label for error copy — canonical tiers get their label, anything else "current". */
export function tierLabel(tier: string | null | undefined): string {
  return isCanonicalTier(tier) ? TIER_LABELS[tier] : "current"
}
