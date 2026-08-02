// lib/vendors/vendor-scope.ts
//
// VENDOR SCOPE MODEL (round 37) — "agents and teams can invite vendors and
// charge them also."
//
// Two lanes, one scope vocabulary (brokerage | team | agent):
//
//   INVITES — inviteVendorToPlatformAction was ALREADY open to every tier
//     (round 15: broker/admin/team_lead/agent). What was missing is
//     ATTRIBUTION: the vendor row now records WHO brought the vendor
//     (vendors.invited_by_user_id — first inviter wins) and the inviter's team
//     (vendors.invited_by_team_id) — migration 1106. vendor_invitations.invited_by
//     already recorded the inviter per-invitation; the vendor-row stamp makes
//     "THEIR vendors" a queryable fact.
//
//   CHARGES — issueVendorCharge (app/actions/vendor-payments.ts) is the ONE
//     tenant→vendor billing lane (billed_to='vendor', migration 1104 vocabulary).
//     Brokerage leadership (broker/admin/team_lead) may charge ANY brokerage
//     vendor; an AGENT may charge only vendors attributed to them (their own
//     invite, or their team's). Every charge carries a zero-amount typed
//     attribution entry in line_items (the premium-placement typed-line-item
//     idiom) so the ledger records which scope raised it — same table, same
//     rows, so brokerage admins see agent/team-raised charges with no forks.
//
// PREMIUM PLACEMENT VERDICT (documented, not faked): placement stays
// brokerage-level — see PREMIUM_PLACEMENT_SCOPE_VERDICT below.
//
// Pure sections are unit-tested by scripts/vendor-scope-charging-simulator.ts;
// the live resolver takes a service client as a parameter (the
// lib/connections/accounting-scopes.ts idiom) so the simulator can stub it.

import type { createServiceClient } from "@/lib/supabase/service"

type ServiceClient = ReturnType<typeof createServiceClient>

// ─── Scope vocabulary (pure) ─────────────────────────────────────────────────

export type VendorActorScope = "brokerage" | "team" | "agent"

/** Roles that may INVITE a vendor to the platform — mirrors the
 *  INVITE_ALLOWED_ROLES gate in app/actions/vendor-invite.ts (round 15 opened
 *  invites to every tier; round 37 adds attribution, not new gates). */
export const VENDOR_INVITE_ROLES: ReadonlySet<string> = new Set([
  "broker", "broker_admin", "admin", "superadmin", "team_lead", "agent",
])

/** Roles that may charge ANY vendor in the brokerage (the round-36½ admin
 *  lane). Agents are deliberately absent — they go through the
 *  their-vendor attribution gate instead. */
export const VENDOR_CHARGE_ADMIN_ROLES: ReadonlySet<string> = new Set([
  "broker", "broker_owner", "broker_admin", "admin", "superadmin", "team_lead",
])

export function canInviteVendors(userType: string | null | undefined): boolean {
  return VENDOR_INVITE_ROLES.has(userType ?? "")
}

/** Pure: which charge scope a caller acts under.
 *    · leads a team            → team  (charge attributed to the team)
 *    · agent (member or solo)  → agent (personal attribution, team recorded)
 *    · any admin role          → brokerage
 *  A team LEAD who also has an admin user_type still attributes as team when
 *  they lead one — the charge is the team's revenue story. */
export function vendorChargeScopeForActor(args: {
  userType: string
  ledTeamId: string | null
  membershipTeamId: string | null
}): { scope: VendorActorScope; teamId: string | null } {
  if (args.ledTeamId) return { scope: "team", teamId: args.ledTeamId }
  if (args.userType === "agent") return { scope: "agent", teamId: args.membershipTeamId }
  return { scope: "brokerage", teamId: null }
}

// ─── Charge attribution (pure — the typed line-item idiom) ───────────────────
//
// vendor_invoices has no metadata column (migration 1000), and premium
// placement already established the pattern of typed entries inside the
// line_items JSONB (findPlacementItem in lib/vendors/premium-placement.ts).
// Attribution is a ZERO-AMOUNT typed entry: subtotal/total math (sum of
// `amount`) is untouched, and `.contains("line_items", ...)` can query it.

export const CHARGE_ATTRIBUTION_TYPE = "charge_attribution" as const

export interface VendorChargeAttribution {
  type: typeof CHARGE_ATTRIBUTION_TYPE
  scope: VendorActorScope
  /** users.id of the person who raised the charge. */
  user_id: string
  /** teams.id when the raiser leads/belongs to a team (led team wins). */
  team_id?: string | null
  description: string
  quantity: 0
  unitPrice: 0
  /** MUST stay 0 — attribution never changes invoice totals. */
  amount: 0
}

export function buildChargeAttribution(args: {
  scope: VendorActorScope
  userId: string
  teamId?: string | null
}): VendorChargeAttribution {
  return {
    type: CHARGE_ATTRIBUTION_TYPE,
    scope: args.scope,
    user_id: args.userId,
    team_id: args.teamId ?? null,
    description: `Raised by ${args.scope}`,
    quantity: 0,
    unitPrice: 0,
    amount: 0,
  }
}

export function findChargeAttribution(lineItems: unknown): VendorChargeAttribution | null {
  if (!Array.isArray(lineItems)) return null
  const item = lineItems.find(
    (li: any) =>
      li && typeof li === "object" &&
      li.type === CHARGE_ATTRIBUTION_TYPE &&
      typeof li.user_id === "string"
  )
  return (item as VendorChargeAttribution) ?? null
}

// ─── "THEIR vendors" gate (pure) ─────────────────────────────────────────────

/** Pure: may an AGENT charge this vendor? True only when the vendor is
 *  attributed to them personally or to their team (migration 1106 columns).
 *  Unattributed vendors are the brokerage's — admins charge those. */
export function agentMayChargeVendor(
  vendor: { invitedByUserId: string | null; invitedByTeamId: string | null },
  caller: { userId: string; teamId: string | null },
): boolean {
  if (vendor.invitedByUserId && vendor.invitedByUserId === caller.userId) return true
  if (vendor.invitedByTeamId && caller.teamId && vendor.invitedByTeamId === caller.teamId) return true
  return false
}

/** Pure: may this caller mark a vendor charge paid / act on it after issue?
 *  Admin roles manage any brokerage charge; an agent only one they raised
 *  (attribution user_id match — never someone else's assertion of collection). */
export function canManageVendorCharge(args: {
  userType: string
  callerUserId: string
  attribution: VendorChargeAttribution | null
}): boolean {
  if (VENDOR_CHARGE_ADMIN_ROLES.has(args.userType)) return true
  if (args.userType !== "agent") return false
  return !!args.attribution && args.attribution.user_id === args.callerUserId
}

// ─── Premium placement — documented scope verdict ────────────────────────────

/** Premium placement stays BROKERAGE-level. This is a verdict, not a gap:
 *  markPlacementPaid flips vendors.{preferred, display_priority,
 *  visible_in_portal} — brokerage-wide flags every member of the brokerage
 *  (and the contact portal) sees. There is no team- or agent-scoped directory
 *  row to feature, so a "team placement" would fake a scope the directory
 *  cannot represent. Agents/teams monetize their vendors through the general
 *  charge lane (issueVendorCharge) instead. */
export const PREMIUM_PLACEMENT_SCOPE = "brokerage" as const
export const PREMIUM_PLACEMENT_SCOPE_VERDICT =
  "Premium placement remains brokerage-level: it flips brokerage-wide vendor placement flags (preferred / display_priority / visible_in_portal) that the whole brokerage and the contact portal read — there is no team- or agent-scoped directory surface to feature into. Agents and teams charge their vendors through the general vendor-charge lane instead."

// ─── Live: resolve the caller's vendor actor scope ───────────────────────────

/** Resolve led team (teams.team_lead_id = users.id — NEVER agents.id, see
 *  lib/identity/policy-scope.ts) and membership team (agents.team_id) for a
 *  caller, then fold into the pure scope rule. Service client is a parameter
 *  so the simulator can stub it. */
export async function resolveVendorActorScope(
  svc: ServiceClient,
  args: { userId: string; userType: string; brokerageId: string },
): Promise<{ scope: VendorActorScope; teamId: string | null; ledTeamId: string | null; membershipTeamId: string | null }> {
  let ledTeamId: string | null = null
  let membershipTeamId: string | null = null
  try {
    const { data: led } = await svc
      .from("teams")
      .select("id")
      .eq("team_lead_id", args.userId)
      .eq("brokerage_id", args.brokerageId)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle()
    ledTeamId = (led as { id: string } | null)?.id ?? null
  } catch { /* fail-closed: no led team */ }
  try {
    const { data: agentRow } = await svc
      .from("agents")
      .select("team_id")
      .eq("user_id", args.userId)
      .eq("brokerage_id", args.brokerageId)
      .maybeSingle()
    membershipTeamId = (agentRow as { team_id: string | null } | null)?.team_id ?? null
  } catch { /* fail-closed: no membership */ }

  const { scope, teamId } = vendorChargeScopeForActor({
    userType: args.userType,
    ledTeamId,
    membershipTeamId,
  })
  return { scope, teamId, ledTeamId, membershipTeamId }
}
