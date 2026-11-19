// lib/kernel/approval-authority.ts
//
// CONTRACT C5 — WHO APPROVES A TENANT'S OWN ASSET (wave 146, lane 146E; owner ruling 9, 2026-10-29: "The brokerage
// doesn't only approve tv ads. the tenants approve their own ads/posts, etc. assets.").
//
// ONE answer for every publish door (ads, ad audiences, TV spots, social posts, videos, assets, publications): the
// tenant-authorized human who OWNS the asset approves it; the oversight chain above them (the team lead of the team
// that owns it, then the brokerage's admin roster) may approve as supervision; the BROKERAGE is the required approver
// ONLY where the tenant's own policy or a legal requirement the tenant has recorded says so. Nothing here invents a
// legal rule: a legal requirement is a policy entry whose basis is "legal_requirement" with its cited source — the
// same attestation shape the coming-soon and adaptive-vocabulary policies use.
//
// Built on the survivors, not beside them (§1, LAW 2):
//   · the seat roster — lib/auth/resolve-user-role.ts TENANT_ADMIN_USER_TYPES (derived, never retyped), through
//     lib/kernel/org-recipients.ts ORG_STAFF_ROLES (the roster minus team_lead — the brokerage-level seats);
//   · team lead — teams.team_lead_id (a users.id; CLAUDE.md §4 "Team lead anchors on teams.team_lead_id"); team
//     membership — team_members.agent_id (agents.id); agents.id ↔ users.id crossed through agents.user_id (§3);
//   · the approvals themselves stay where they live (approval_items, social_posts.approved_by, the per-table
//     approval_status columns and the unified queue lib/kernel/approval-queue-aggregator.ts) — this module decides
//     WHO, it stores nothing.
//
// FAIL CLOSED (§4): a read that is refused is a refusal with its reason, never "nobody needs to approve"; an
// unreadable publication policy is treated as REQUIRING brokerage approval (the stricter answer), and says so.
// Tenant comes from the caller's verified context — every read below is pinned to it.

import { ORG_STAFF_ROLES } from "@/lib/kernel/org-recipients"
import { TENANT_COMMERCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

type Db = { from: (table: string) => any }

/** Every asset kind a publish door asks about (one vocabulary, §6). */
export const APPROVAL_ASSET_KINDS = ["ad_creative", "ad_campaign", "ad_audience", "tv_spot", "social_post", "video", "asset", "publication"] as const
export type ApprovalAssetKind = (typeof APPROVAL_ASSET_KINDS)[number]

/** brokerage_settings.settings key the tenant records its approval policy under (versioned like every tenant policy;
 *  registration in lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS is lane 146G's — see lane 146E notes).
 *  Shape: { require_brokerage_approval: { [assetKind]: { basis: "brokerage_policy" | "legal_requirement",
 *  source?: string, attested_by?: string, attested_at?: string } } }. Absent = no brokerage requirement. */
export const PUBLICATION_APPROVAL_POLICY_KEY = "publication_approval"

export interface ApproverScope {
  /** teams.id that owns the asset (a team asset). */
  teamId?: string | null
  /** agents.id that owns the asset (an agent's own asset). */
  agentId?: string | null
  /** users.id of the owning agent when the table stores the users.id (ad_campaigns.agent_user_id). */
  agentUserId?: string | null
}

export interface ApproverForInput {
  /** The VERIFIED tenant (session / the tenant-owned row) — never a request body (§4). */
  brokerageId: string
  assetKind: ApprovalAssetKind
  scope: ApproverScope
  client?: Db
}

export type ApproverTier = "owner_agent" | "team_lead" | "tenant_admin" | "tenant_principal"

export type ApproverDecision =
  | {
      ok: true
      assetKind: ApprovalAssetKind
      tier: ApproverTier
      /** Who is ASKED (notified) first — the owner, or whoever the policy names. */
      primaryUserIds: string[]
      /** Everyone whose approval counts: the primary plus the oversight chain (or, when the brokerage is required,
       *  the brokerage roster only). */
      permittedUserIds: string[]
      brokerageApprovalRequired: boolean
      basis: "owner" | "team" | "brokerage_asset" | "brokerage_policy" | "legal_requirement" | "policy_unreadable" | "solo_tenant"
      /** The policy entry that imposed brokerage approval (`publication_approval.<kind>`), else null. */
      policyRef: string | null
      reason: string
    }
  | { ok: false; reason: string }

async function db(client?: Db): Promise<Db> {
  if (client) return client
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Db
}

/** The brokerage-level approvers: users of this tenant whose seat is on the roster (ORG_STAFF_ROLES), plus role GRANTS
 *  pinned to this tenant (user_role_assignments — the second half of is_brokerage_admin()). Errors are READ. */
async function brokerageApprovers(svc: Db, brokerageId: string): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
  const roles = [...ORG_STAFF_ROLES]
  const { data: seats, error } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).in("user_type", roles)
  if (error) return { ok: false, reason: `the brokerage's approver seats could not be read (${error.message ?? "refused"})` }
  const { data: grants, error: gErr } = await svc.from("user_role_assignments").select("user_id").eq("brokerage_id", brokerageId).in("role", roles)
  if (gErr) return { ok: false, reason: `the brokerage's approver grants could not be read (${gErr.message ?? "refused"})` }
  const ids = new Set<string>()
  for (const r of (seats ?? []) as Array<{ id: string | null }>) if (r.id) ids.add(r.id)
  for (const r of (grants ?? []) as Array<{ user_id: string | null }>) if (r.user_id) ids.add(r.user_id)
  return { ok: true, ids: [...ids] }
}

/** The tenant's recorded requirement for this kind, or null; unreadable is its own answer. */
async function brokerageRequirement(svc: Db, brokerageId: string, kind: ApprovalAssetKind): Promise<{ readable: true; entry: { basis: string; source?: string } | null } | { readable: false; reason: string }> {
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { readable: false, reason: error.message ?? "refused" }
  const policy = ((data as { settings?: Record<string, unknown> | null } | null)?.settings ?? {})[PUBLICATION_APPROVAL_POLICY_KEY] as
    | { require_brokerage_approval?: Record<string, { basis?: unknown; source?: unknown } | null> } | undefined
  const entry = policy?.require_brokerage_approval?.[kind]
  if (!entry) return { readable: true, entry: null }
  const basis = entry.basis === "legal_requirement" ? "legal_requirement" : "brokerage_policy"
  return { readable: true, entry: { basis, ...(typeof entry.source === "string" ? { source: entry.source } : {}) } }
}

/**
 * THE C5 ANSWER: who approves this tenant's asset of this kind at this scope.
 *
 *   policy requires the brokerage (or the policy is unreadable) → the brokerage roster, only;
 *   an agent's own asset   → the agent approves; their team lead and the brokerage roster may approve as oversight;
 *   a team's asset         → the team lead approves; the brokerage roster may approve as oversight;
 *   a brokerage asset      → the brokerage roster (a solo tenant with no roster: its one active agent).
 */
export async function approverFor(input: ApproverForInput): Promise<ApproverDecision> {
  if (!input.brokerageId) return { ok: false, reason: "no tenant — an approver cannot be chosen outside a brokerage" }
  if (!(APPROVAL_ASSET_KINDS as readonly string[]).includes(input.assetKind)) return { ok: false, reason: `unknown asset kind '${String(input.assetKind)}'` }
  try {
    const svc = await db(input.client)
    const kind = input.assetKind

    // ── the owner (an agent's own asset) ──
    let ownerUserId: string | null = null
    let ownerAgentId: string | null = input.scope.agentId ?? null
    if (ownerAgentId) {
      const { data, error } = await svc.from("agents").select("id, user_id, brokerage_id, team_id").eq("id", ownerAgentId).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (error) return { ok: false, reason: `the owning agent could not be read (${error.message ?? "refused"})` }
      if (!data) return { ok: false, reason: "the owning agent is not in this brokerage" }
      ownerUserId = (data as { user_id: string | null }).user_id ?? null
      if (!ownerUserId) return { ok: false, reason: "the owning agent has no user seat to approve with" }
    } else if (input.scope.agentUserId) {
      const { data, error } = await svc.from("agents").select("id, user_id").eq("user_id", input.scope.agentUserId).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (error) return { ok: false, reason: `the owning agent could not be read (${error.message ?? "refused"})` }
      if (data) { ownerUserId = input.scope.agentUserId; ownerAgentId = (data as { id: string }).id }
      else {
        // A users.id that is not an agent here (a broker who made it) — a brokerage-level asset, decided below.
        const { data: u, error: uErr } = await svc.from("users").select("id").eq("id", input.scope.agentUserId).eq("brokerage_id", input.brokerageId).maybeSingle()
        if (uErr) return { ok: false, reason: `the asset's owner could not be read (${uErr.message ?? "refused"})` }
        if (!u) return { ok: false, reason: "the asset's owner is not in this brokerage" }
      }
    }

    // ── the team (the asset's own team, else the owner's active team membership) ──
    let teamId: string | null = input.scope.teamId ?? null
    if (!teamId && ownerAgentId) {
      const { data: tm, error: tmErr } = await svc.from("team_members").select("team_id").eq("agent_id", ownerAgentId).eq("brokerage_id", input.brokerageId).eq("is_active", true).limit(1)
      if (tmErr) return { ok: false, reason: `the owner's team membership could not be read (${tmErr.message ?? "refused"})` }
      teamId = ((tm ?? []) as Array<{ team_id: string | null }>)[0]?.team_id ?? null
    }
    let teamLeadUserId: string | null = null
    if (teamId) {
      const { data: t, error: tErr } = await svc.from("teams").select("id, team_lead_id").eq("id", teamId).eq("brokerage_id", input.brokerageId).is("deleted_at", null).maybeSingle()
      if (tErr) return { ok: false, reason: `the owning team could not be read (${tErr.message ?? "refused"})` }
      if (!t && input.scope.teamId) return { ok: false, reason: "the owning team is not in this brokerage" }
      teamLeadUserId = (t as { team_lead_id: string | null } | null)?.team_lead_id ?? null
    }

    const roster = await brokerageApprovers(svc, input.brokerageId)
    if (!roster.ok) return { ok: false, reason: roster.reason }

    // ── the tenant's recorded requirement (or a legal requirement it recorded) ──
    const req = await brokerageRequirement(svc, input.brokerageId, kind)
    const required = !req.readable || req.entry !== null
    if (required) {
      if (roster.ids.length === 0) return { ok: false, reason: "the brokerage must approve this asset, but no broker / admin seat exists to approve it" }
      const basis = !req.readable ? "policy_unreadable" : (req.entry!.basis === "legal_requirement" ? "legal_requirement" : "brokerage_policy")
      return {
        ok: true, assetKind: kind, tier: "tenant_admin", primaryUserIds: roster.ids, permittedUserIds: roster.ids, brokerageApprovalRequired: true, basis,
        policyRef: req.readable ? `${PUBLICATION_APPROVAL_POLICY_KEY}.${kind}` : null,
        reason: !req.readable
          ? `the publication policy could not be read (${req.reason}) — the brokerage approves until it can (fail closed)`
          : `the brokerage approves ${kind} here: ${basis === "legal_requirement" ? "a recorded legal requirement" : "the brokerage's own policy"}${req.entry!.source ? ` (${req.entry!.source})` : ""}`,
      }
    }

    const oversight = (extra: Array<string | null>) => [...new Set([...extra.filter((x): x is string => !!x), ...roster.ids])]
    if (ownerUserId) {
      return { ok: true, assetKind: kind, tier: "owner_agent", primaryUserIds: [ownerUserId], permittedUserIds: oversight([ownerUserId, teamLeadUserId]), brokerageApprovalRequired: false, basis: "owner", policyRef: null, reason: "the agent approves their own asset (their team lead and the brokerage may approve as oversight)" }
    }
    if (teamId) {
      if (teamLeadUserId) return { ok: true, assetKind: kind, tier: "team_lead", primaryUserIds: [teamLeadUserId], permittedUserIds: oversight([teamLeadUserId]), brokerageApprovalRequired: false, basis: "team", policyRef: null, reason: "the team lead approves the team's asset (the brokerage may approve as oversight)" }
      if (roster.ids.length === 0) return { ok: false, reason: "the team has no lead and the brokerage has no broker / admin seat — nobody can approve this asset" }
      return { ok: true, assetKind: kind, tier: "tenant_admin", primaryUserIds: roster.ids, permittedUserIds: roster.ids, brokerageApprovalRequired: false, basis: "team", policyRef: null, reason: "the team has no lead — the brokerage approves its asset" }
    }
    if (roster.ids.length > 0) {
      return { ok: true, assetKind: kind, tier: "tenant_admin", primaryUserIds: roster.ids, permittedUserIds: roster.ids, brokerageApprovalRequired: false, basis: "brokerage_asset", policyRef: null, reason: "a brokerage asset — the brokerage's broker / admin seats approve it" }
    }
    // A SOLO tenant (no roster): its one active agent is the principal. More than one agent and no roster = nobody.
    const { data: agents, error: aErr } = await svc.from("agents").select("user_id").eq("brokerage_id", input.brokerageId).eq("is_active", true).not("user_id", "is", null).limit(2)
    if (aErr) return { ok: false, reason: `the tenant's agents could not be read (${aErr.message ?? "refused"})` }
    const principals = ((agents ?? []) as Array<{ user_id: string | null }>).map((a) => a.user_id).filter((x): x is string => !!x)
    if (principals.length === 1) return { ok: true, assetKind: kind, tier: "tenant_principal", primaryUserIds: principals, permittedUserIds: principals, brokerageApprovalRequired: false, basis: "solo_tenant", policyRef: null, reason: "a solo tenant — its one agent is the principal who approves" }
    return { ok: false, reason: "a brokerage asset, and the brokerage has no broker / admin seat to approve it" }
  } catch (e) {
    return { ok: false, reason: `approver could not be decided: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** The scope a known asset table carries (tenant-pinned read). Unknown table = refused, never guessed. */
async function scopeOfAsset(svc: Db, brokerageId: string, assetTable: string, assetId: string): Promise<{ ok: true; scope: ApproverScope } | { ok: false; reason: string }> {
  const fromVisibility = (r: { agent_user_id?: string | null; team_id?: string | null; visibility_scope?: string | null; scope_type?: string | null }): ApproverScope => {
    const vis = r.visibility_scope ?? r.scope_type ?? null
    if (vis === "team" && r.team_id) return { teamId: r.team_id }
    if (vis === "agent" && r.agent_user_id) return { agentUserId: r.agent_user_id }
    if (vis == null && r.agent_user_id) return { agentUserId: r.agent_user_id }
    return {}
  }
  if (assetTable === "ad_campaigns") {
    const { data, error } = await svc.from("ad_campaigns").select("id, agent_user_id, team_id, visibility_scope").eq("id", assetId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `campaign read refused: ${error.message ?? "refused"}` }
    if (!data) return { ok: false, reason: "campaign not in this brokerage" }
    return { ok: true, scope: fromVisibility(data) }
  }
  if (assetTable === "ad_creative_variations") {
    const { data, error } = await svc.from("ad_creative_variations").select("id, ad_campaign_id").eq("id", assetId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `creative read refused: ${error.message ?? "refused"}` }
    if (!data) return { ok: false, reason: "creative not in this brokerage" }
    const campaignId = (data as { ad_campaign_id: string | null }).ad_campaign_id
    if (!campaignId) return { ok: true, scope: {} }
    return scopeOfAsset(svc, brokerageId, "ad_campaigns", campaignId)
  }
  if (assetTable === "facebook_custom_audiences") {
    const { data, error } = await svc.from("facebook_custom_audiences").select("id, agent_user_id, scope_type").eq("id", assetId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `audience read refused: ${error.message ?? "refused"}` }
    if (!data) return { ok: false, reason: "audience not in this brokerage" }
    return { ok: true, scope: fromVisibility(data) }
  }
  if (assetTable === "social_posts") {
    const { data, error } = await svc.from("social_posts").select("id, agent_id, user_id").eq("id", assetId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `post read refused: ${error.message ?? "refused"}` }
    if (!data) return { ok: false, reason: "post not in this brokerage" }
    const p = data as { agent_id: string | null; user_id: string | null }
    return { ok: true, scope: p.agent_id ? { agentId: p.agent_id } : p.user_id ? { agentUserId: p.user_id } : {} }
  }
  return { ok: false, reason: `no approval scope is declared for '${assetTable}'` }
}

/**
 * THE DOOR'S CHECK: may THIS person approve THIS asset? Every publish door calls it before its approval write, with
 * the session's user and tenant. Returns the decision so the door can say who CAN approve when the answer is no.
 */
export async function requirePublishApprover(input: {
  brokerageId: string
  assetKind: ApprovalAssetKind
  assetTable: string
  assetId: string
  approverUserId: string
  client?: Db
}): Promise<{ ok: true; decision: Extract<ApproverDecision, { ok: true }> } | { ok: false; reason: string; decision?: ApproverDecision }> {
  if (!input.approverUserId) return { ok: false, reason: "no approver — an approval is a person's act" }
  const svc = await db(input.client)
  const scope = await scopeOfAsset(svc, input.brokerageId, input.assetTable, input.assetId)
  if (!scope.ok) return { ok: false, reason: scope.reason }
  const decision = await approverFor({ brokerageId: input.brokerageId, assetKind: input.assetKind, scope: scope.scope, client: svc })
  if (!decision.ok) return { ok: false, reason: decision.reason, decision }
  if (!decision.permittedUserIds.includes(input.approverUserId)) {
    return { ok: false, decision, reason: `you are not an approver of this ${input.assetKind}: ${decision.reason}` }
  }
  // WAVE 155 (lane 155D, eval SCOPE-005 / PRIV-002): in a MULTI-LOCATION tenant a roster seat approves as oversight only
  // inside the offices / teams its hierarchy admits (lib/kernel/resolve-user-office.ts — C34: user_type never widens a
  // multi-location row). At 9d9626b9 office 2's broker was in permittedUserIds for office 1's asset and approved it.
  // The owner and the owning team's lead are admitted by the decision itself; only the roster path is narrowed here.
  const viaRosterOnly = !decision.primaryUserIds.includes(input.approverUserId) || decision.tier === "tenant_admin"
  if (viaRosterOnly) {
    const reach = await rosterReachesAsset(svc, input.brokerageId, input.approverUserId, scope.scope)
    if (!reach.ok) return { ok: false, decision, reason: `you are not an approver of this ${input.assetKind}: ${reach.reason}` }
  }
  return { ok: true, decision }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// MARKETING ARTIFACT APPROVAL — WAVE 155 (lane 155D; owner ruling R7: "an approver should be compliance, tc, team lead
// and admin. if the office is sending marketing for the brokerage or team then they need access.").
//
// EXTENDS the C5 answer above (never a second approver resolver). FIVE authorities stay SEPARATE — each says where it is
// decided, and one never stands in for another:
//   content_brand      factual / brand approval of the piece                    → decideMarketingApproval (this module)
//   compliance_review  regulated claims + housing ads (fair housing)            → decideMarketingApproval; the content gate
//                      (lib/kernel/marketing/real-estate-compliance-gate.ts runComplianceGate) still runs first in the writer
//   render_quality     the rendered / printed file is real and playable          → MACHINE EVIDENCE (renderProven: the video's
//                      playable render, lib/kernel/video-coordination.ts; a mail piece's proof) — a person cannot "approve"
//                      a render that never produced a file
//   spend_publication  paid spend + actual publication authority              → TENANT_COMMERCE_ADMIN_USER_TYPES in scope; the
//                      Ad OS door (requirePublishApprover above) + the spend gates still decide a paid campaign
//   legal_transaction  legal documents + transaction approvals                → NEVER here (lib/auth/deal-work-ownership.ts and
//                      the e-sign / document doors). A marketing approval never authorizes a legal document or a deal step.
// WHO, by EXISTING assignment and business scope (never everyone globally):
//   owner              the agent who made it (unless the tenant's publication_approval policy requires the brokerage)
//   team lead          teams.team_lead_id of the artifact's team / the owner's team
//   assigned compliance contacts.compliance_officer_id of the artifact's contact
//   assigned TC        contacts.tc_user_id of the artifact's contact; transactions.coordinator_id / transaction_assignments
//                      (transaction_coordinators.user_id) of the artifact's deal
//   roster (admin tier) ORG_STAFF_ROLES (derived from TENANT_ADMIN_USER_TYPES) — in a MULTI-LOCATION tenant only inside the
//                      offices / teams the C34 hierarchy admits; location association alone confers nothing brokerage-wide
//   delegated office   organization_members.permissions.marketing_delegation on the delegate's ACTIVE tenant- (acts for the
//                      brokerage) or team- (acts for that team) membership — written by app/actions/marketing-studio.ts
//                      grantMarketingDelegation, revoked by clearing it or by the membership's revoked_at
// INHERITANCE: an approval carries a fingerprint (approvalFingerprint) + the scope key. It inherits ONLY when scope AND
// version are identical and the authority is inheritable; a substantive edit changes the fingerprint and RE-OPENS it.
// FAIL CLOSED: any refused read narrows the facts and is named (refusal); a refusal never reads as "approved".
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const MARKETING_APPROVAL_AUTHORITIES = {
  content_brand: { label: "Content & brand approval", inherits: true, decidedAt: "lib/kernel/approval-authority.ts decideMarketingApproval" },
  compliance_review: { label: "Compliance review (regulated claims, housing ads)", inherits: false, decidedAt: "lib/kernel/approval-authority.ts decideMarketingApproval, after lib/kernel/marketing/real-estate-compliance-gate.ts runComplianceGate" },
  render_quality: { label: "Render / quality proof", inherits: true, decidedAt: "machine evidence: lib/kernel/video-coordination.ts playable render · direct_mail_campaigns.proof_status" },
  spend_publication: { label: "Budget, spend and publication", inherits: false, decidedAt: "lib/kernel/approval-authority.ts decideMarketingApproval (TENANT_COMMERCE_ADMIN_USER_TYPES in scope) + requirePublishApprover for paid creative" },
  legal_transaction: { label: "Legal document / transaction approval", inherits: false, decidedAt: "never a marketing approval: lib/auth/deal-work-ownership.ts loadDealWorkAccess + the document / e-sign doors" },
} as const
export type MarketingAuthority = keyof typeof MARKETING_APPROVAL_AUTHORITIES
export const MARKETING_AUTHORITY_KEYS = Object.keys(MARKETING_APPROVAL_AUTHORITIES) as MarketingAuthority[]

/** organization_members.permissions key that carries an office's delegated marketing grant. */
export const MARKETING_DELEGATION_KEY = "marketing_delegation"
export const MARKETING_DELEGATION_ACTIONS = ["prepare", "approve"] as const
export type MarketingDelegationAction = (typeof MARKETING_DELEGATION_ACTIONS)[number]

export interface MarketingDelegation { membershipId: string; actsFor: "brokerage" | "team"; teamId: string | null; may: MarketingDelegationAction[] }

export interface MarketingApproverFacts {
  userId: string
  brokerageId: string
  /** users.user_type plus every user_role_assignments role pinned to this tenant (withTenantRoleGrants' rule). */
  roles: string[]
  multiLocation: boolean
  /** The C34 hierarchy (null = not needed: single-office tenant). */
  hierarchy: { aggregate: boolean; locationIds: string[]; teamIds: string[] } | null
  ledTeamIds: string[]
  complianceContactIds: string[]
  tcContactIds: string[]
  tcTransactionIds: string[]
  delegations: MarketingDelegation[]
  /** brokerage_settings publication_approval.asset — the tenant requires the brokerage (or the policy was unreadable). */
  brokerageApprovalRequired: boolean
  /** Non-null ⇒ a read was refused; every decision refuses with this reason (fail closed). */
  refusal: string | null
}

export interface MarketingArtifactScope {
  brokerageId: string
  ownerUserId: string | null
  /** The artifact's own team (team_id / a team-visibility row), else null. */
  teamId: string | null
  /** The owner's office (users.location_id) — the multi-location reach test. */
  ownerLocationId: string | null
  /** The owner's teams (team_members, active) — a team lead oversees their members' work. */
  ownerTeamIds: string[]
  /** visibility_scope = brokerage → the piece speaks for the brokerage; team → for its team. */
  actsFor: "brokerage" | "team" | null
  contactId: string | null
  transactionId: string | null
  /** render_quality evidence: a playable render / an approved proof exists. */
  renderProven?: boolean | null
}

export type MarketingApprovalDecision =
  | { ok: true; authority: MarketingAuthority; basis: string[] }
  | { ok: false; authority: MarketingAuthority; reason: string }

const COMPLIANCE_SEAT = "compliance_officer"

/** PURE: may this seat exercise this authority over this artifact? ONE rule — the catalog's offers and the writers' doors
 *  both call it, so an offered button is never one the writer refuses. */
export function decideMarketingApproval(f: MarketingApproverFacts, a: MarketingArtifactScope, authority: MarketingAuthority): MarketingApprovalDecision {
  const no = (reason: string): MarketingApprovalDecision => ({ ok: false, authority, reason })
  if (!(authority in MARKETING_APPROVAL_AUTHORITIES)) return no(`unknown authority '${String(authority)}'`)
  if (f.refusal) return no(f.refusal)
  if (!f.brokerageId || f.brokerageId !== a.brokerageId) return no("this piece belongs to another workspace")
  if (authority === "legal_transaction") return no("a marketing approval never decides a legal document or a transaction step — the deal's document / e-sign doors do")
  if (authority === "render_quality" && a.renderProven !== true) return no("no playable render / approved proof exists yet — a render is proven by its file, not by a click")

  const roles = new Set(f.roles.map((r) => String(r).toLowerCase()))
  const has = (set: Iterable<string>) => [...set].some((r) => roles.has(r))
  const officeReach = !f.multiLocation
    || (!!f.hierarchy && (f.hierarchy.aggregate
      || (!!a.ownerLocationId && f.hierarchy.locationIds.includes(a.ownerLocationId))
      || (!!a.teamId && f.hierarchy.teamIds.includes(a.teamId))
      || a.ownerTeamIds.some((t) => f.hierarchy!.teamIds.includes(t))))
  // A brokerage-voice piece in a multi-location tenant needs the aggregated (tenant leadership) view.
  const brokerageVoiceReach = a.actsFor !== "brokerage" || !f.multiLocation || !!f.hierarchy?.aggregate
  const rosterInScope = has(ORG_STAFF_ROLES) && officeReach && brokerageVoiceReach
  const teamLead = (!!a.teamId && f.ledTeamIds.includes(a.teamId)) || a.ownerTeamIds.some((t) => f.ledTeamIds.includes(t))
  const owner = !!a.ownerUserId && a.ownerUserId === f.userId
  const assignedCompliance = !!a.contactId && f.complianceContactIds.includes(a.contactId)
  const assignedTc = (!!a.contactId && f.tcContactIds.includes(a.contactId)) || (!!a.transactionId && f.tcTransactionIds.includes(a.transactionId))
  const delegate = f.delegations.find((d) => d.may.includes("approve") && ((d.actsFor === "brokerage" && a.actsFor === "brokerage") || (d.actsFor === "team" && !!d.teamId && a.actsFor === "team" && a.teamId === d.teamId)))

  const basis: string[] = []
  if (authority === "content_brand" || authority === "render_quality") {
    if (!f.brokerageApprovalRequired) {
      if (owner) basis.push("owner")
      if (teamLead) basis.push("team lead")
      if (assignedTc) basis.push("assigned transaction coordinator")
    }
    if (rosterInScope) basis.push(has([COMPLIANCE_SEAT]) ? "compliance officer (roster, in scope)" : "brokerage admin (roster, in scope)")
    if (assignedCompliance) basis.push("assigned compliance officer")
    if (delegate) basis.push(`delegated office for the ${delegate.actsFor}`)
  } else if (authority === "compliance_review") {
    if (rosterInScope) basis.push(has([COMPLIANCE_SEAT]) ? "compliance officer (roster, in scope)" : "supervising broker / admin (roster, in scope)")
    if (assignedCompliance) basis.push("assigned compliance officer")
  } else if (authority === "spend_publication") {
    const commerce = has([...TENANT_COMMERCE_ADMIN_USER_TYPES].filter((r) => r !== "team_lead")) && officeReach && brokerageVoiceReach
    if (commerce) basis.push("commerce admin (in scope)")
    if (roles.has("team_lead") && teamLead) basis.push("team lead (the team's own spend)")
  }
  if (basis.length) return { ok: true, authority, basis }
  const who = authority === "compliance_review" ? "a compliance officer or supervising broker over this piece's office, or the compliance officer assigned to its contact"
    : authority === "spend_publication" ? "a commerce admin over this piece's office (or its team's lead for team spend)"
    : f.brokerageApprovalRequired ? "the brokerage (its publication policy requires it), the assigned compliance officer, or a delegated office"
    : "its owner, their team lead, the assigned compliance officer or TC, a brokerage admin over its office, or a delegated office"
  return no(`${MARKETING_APPROVAL_AUTHORITIES[authority].label} sits with ${who}`)
}

/** PURE: an approval inherits onto another piece only when the authority inherits AND scope + version are identical. */
export function approvalInherits(authority: MarketingAuthority, approved: { scopeKey: string; fingerprint: string } | null, candidate: { scopeKey: string; fingerprint: string }): boolean {
  if (!approved || !MARKETING_APPROVAL_AUTHORITIES[authority]?.inherits) return false
  return approved.scopeKey === candidate.scopeKey && approved.fingerprint === candidate.fingerprint
}

/** PURE: the version of the substantive content (FNV-1a over the stable JSON of the fields that change what is said or shown). */
export function approvalFingerprint(fields: Record<string, unknown>): string {
  const stable = JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k] ?? null]))
  let h = 0x811c9dc5
  for (let i = 0; i < stable.length; i++) { h ^= stable.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `v1:${h.toString(16).padStart(8, "0")}`
}
/** The substantive fields of a marketing_assets row (an edit to any of them re-opens its approval). */
export const MARKETING_ASSET_SUBSTANTIVE_FIELDS = ["asset_type", "asset_name", "asset_url", "preview_text", "variants", "audience", "brand"] as const
export const marketingAssetFingerprint = (row: Record<string, unknown>) => approvalFingerprint(Object.fromEntries(MARKETING_ASSET_SUBSTANTIVE_FIELDS.map((k) => [k, row[k] ?? null])))
/** PURE: the recorded approval stamp (marketing_assets.metadata.approval) — null when none was recorded (pre-wave-155 rows). */
export function readApprovalStamp(metadata: unknown): { fingerprint: string; scopeKey: string; approvedBy: string | null; approvedAt: string | null; authority: string | null } | null {
  const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).approval : null
  if (!m || typeof m !== "object") return null
  const x = m as Record<string, unknown>
  return typeof x.fingerprint === "string" ? { fingerprint: x.fingerprint, scopeKey: typeof x.scope_key === "string" ? x.scope_key : "", approvedBy: typeof x.approved_by === "string" ? x.approved_by : null, approvedAt: typeof x.approved_at === "string" ? x.approved_at : null, authority: typeof x.authority === "string" ? x.authority : null } : null
}
export const marketingScopeKey = (a: Pick<MarketingArtifactScope, "brokerageId" | "actsFor" | "teamId" | "ownerUserId">) => `${a.brokerageId}|${a.actsFor ?? "owner"}|${a.teamId ?? ""}|${a.actsFor ? "" : a.ownerUserId ?? ""}`

/** PURE: parse organization_members.permissions into a delegation (or null). */
export function parseMarketingDelegation(membership: { id: string; scope_kind: string; team_id: string | null; permissions: unknown }): MarketingDelegation | null {
  const p = membership.permissions && typeof membership.permissions === "object" ? (membership.permissions as Record<string, unknown>)[MARKETING_DELEGATION_KEY] : null
  if (!p || typeof p !== "object") return null
  const may = Array.isArray((p as { may?: unknown }).may) ? ((p as { may: unknown[] }).may.filter((x): x is MarketingDelegationAction => (MARKETING_DELEGATION_ACTIONS as readonly unknown[]).includes(x))) : []
  if (!may.length) return null
  if (membership.scope_kind === "tenant") return { membershipId: membership.id, actsFor: "brokerage", teamId: null, may }
  if (membership.scope_kind === "team" && membership.team_id) return { membershipId: membership.id, actsFor: "team", teamId: membership.team_id, may }
  return null // a LOCATION membership never carries a delegation: office association confers nothing brokerage-wide
}

/** THE FACTS LOADER (tenant from the caller's session; every read pinned and its error READ — any refusal fails closed). */
export async function loadMarketingApproverFacts(client: Db | undefined, who: { userId: string; brokerageId: string; userType: string | null }): Promise<MarketingApproverFacts> {
  const svc = await db(client)
  const facts: MarketingApproverFacts = { userId: who.userId, brokerageId: who.brokerageId, roles: who.userType ? [who.userType] : [], multiLocation: false, hierarchy: null, ledTeamIds: [], complianceContactIds: [], tcContactIds: [], tcTransactionIds: [], delegations: [], brokerageApprovalRequired: false, refusal: null }
  const fail = (what: string, e: { message?: string } | null) => { facts.refusal = `your approval scope could not be read (${what}: ${e?.message ?? "refused"}) — nothing is approved until it can` ; return facts }
  if (!who.userId || !who.brokerageId) { facts.refusal = "no session tenant — an approval is a person's act inside a workspace"; return facts }
  const [grants, tenant, offices, led, comp, tcC, coord, mem, settings] = await Promise.all([
    svc.from("user_role_assignments").select("role").eq("user_id", who.userId).eq("brokerage_id", who.brokerageId),
    svc.from("brokerages").select("plan_tier").eq("id", who.brokerageId).maybeSingle(),
    svc.from("locations").select("id, status").eq("brokerage_id", who.brokerageId),
    svc.from("teams").select("id").eq("brokerage_id", who.brokerageId).eq("team_lead_id", who.userId).is("deleted_at", null),
    svc.from("contacts").select("id").eq("brokerage_id", who.brokerageId).eq("compliance_officer_id", who.userId).limit(2000),
    svc.from("contacts").select("id").eq("brokerage_id", who.brokerageId).eq("tc_user_id", who.userId).limit(2000),
    svc.from("transaction_coordinators").select("id").eq("brokerage_id", who.brokerageId).eq("user_id", who.userId),
    svc.from("organization_members").select("id, scope_kind, team_id, permissions").eq("brokerage_id", who.brokerageId).eq("user_id", who.userId).is("revoked_at", null),
    svc.from("brokerage_settings").select("settings").eq("brokerage_id", who.brokerageId).maybeSingle(),
  ])
  for (const [what, r] of [["role grants", grants], ["plan", tenant], ["offices", offices], ["led teams", led], ["compliance assignments", comp], ["TC contact assignments", tcC], ["TC seat", coord], ["memberships", mem]] as const) if ((r as { error: unknown }).error) return fail(what, (r as { error: { message?: string } }).error)
  for (const g of (grants.data ?? []) as Array<{ role: string | null }>) if (g.role) facts.roles.push(g.role)
  facts.roles = [...new Set(facts.roles.map((r) => r.toLowerCase()))]
  const activeOffices = ((offices.data ?? []) as Array<{ status: string | null }>).filter((o) => (o.status ?? "active") === "active").length
  facts.multiLocation = (tenant.data as { plan_tier?: string | null } | null)?.plan_tier === "multi_location" || activeOffices >= 2
  facts.ledTeamIds = ((led.data ?? []) as Array<{ id: string }>).map((t) => t.id)
  facts.complianceContactIds = ((comp.data ?? []) as Array<{ id: string }>).map((c) => c.id)
  facts.tcContactIds = ((tcC.data ?? []) as Array<{ id: string }>).map((c) => c.id)
  const coordIds = ((coord.data ?? []) as Array<{ id: string }>).map((c) => c.id)
  if (coordIds.length) {
    const [tx, asg] = await Promise.all([
      svc.from("transactions").select("id").eq("brokerage_id", who.brokerageId).in("coordinator_id", coordIds).limit(2000),
      svc.from("transaction_assignments").select("transaction_id").eq("brokerage_id", who.brokerageId).in("coordinator_id", coordIds).limit(2000),
    ])
    if (tx.error) return fail("TC deals", tx.error)
    if (asg.error) return fail("TC assignments", asg.error)
    facts.tcTransactionIds = [...new Set([...((tx.data ?? []) as Array<{ id: string }>).map((t) => t.id), ...((asg.data ?? []) as Array<{ transaction_id: string }>).map((t) => t.transaction_id)])]
  }
  facts.delegations = ((mem.data ?? []) as Array<{ id: string; scope_kind: string; team_id: string | null; permissions: unknown }>).map(parseMarketingDelegation).filter((d): d is MarketingDelegation => !!d)
  // the tenant's own publication policy for assets (C5) — unreadable = the brokerage approves (the stricter answer)
  if (settings.error) facts.brokerageApprovalRequired = true
  else {
    const pol = ((settings.data as { settings?: Record<string, any> | null } | null)?.settings ?? {})[PUBLICATION_APPROVAL_POLICY_KEY]
    facts.brokerageApprovalRequired = !!pol?.require_brokerage_approval?.asset
  }
  if (facts.multiLocation) {
    const { resolveViewerHierarchy } = await import("@/lib/kernel/resolve-user-office")
    const h = await resolveViewerHierarchy(svc as never, { userId: who.userId, brokerageId: who.brokerageId })
    if (!h.ok) return fail("office hierarchy", { message: h.error })
    facts.hierarchy = { aggregate: h.scope.aggregate, locationIds: h.scope.locationIds, teamIds: h.scope.teamIds }
  }
  return facts
}

/** The tables a marketing approval can name, and the columns their scope comes from (tenant-pinned read; unknown = refused). */
export const MARKETING_ARTIFACT_TABLES: Record<string, { owner: { column: string; kind: "agent" | "user" }; team?: string; visibility?: string; contact?: string; transaction?: string }> = {
  marketing_assets: { owner: { column: "agent_user_id", kind: "user" }, team: "team_id", visibility: "visibility_scope", contact: "contact_id" },
  social_posts: { owner: { column: "agent_id", kind: "agent" } },
  blog_posts: { owner: { column: "agent_user_id", kind: "user" }, team: "team_id", visibility: "visibility_scope" },
  ai_video_projects: { owner: { column: "agent_id", kind: "agent" }, contact: "contact_id" },
  direct_mail_campaigns: { owner: { column: "created_by", kind: "user" }, contact: "contact_id" },
  newsletter_campaigns: { owner: { column: "created_by", kind: "user" } },
  video_snippets: { owner: { column: "created_by", kind: "user" } },
}

export async function marketingArtifactScope(client: Db | undefined, brokerageId: string, table: string, id: string): Promise<{ ok: true; scope: MarketingArtifactScope; row: Record<string, unknown> } | { ok: false; reason: string }> {
  const cfg = MARKETING_ARTIFACT_TABLES[table]
  if (!cfg) return { ok: false, reason: `no marketing approval scope is declared for '${table}'` }
  const svc = await db(client)
  const cols = ["id", cfg.owner.column, cfg.team, cfg.visibility, cfg.contact, cfg.transaction, ...(table === "marketing_assets" ? [...MARKETING_ASSET_SUBSTANTIVE_FIELDS, "metadata", "approval_status"] : [])].filter((c, i, xs): c is string => !!c && xs.indexOf(c) === i)
  const { data, error } = await svc.from(table).select(cols.join(", ")).eq("id", id).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, reason: `the piece could not be read (${error.message ?? "refused"})` }
  if (!data) return { ok: false, reason: "that piece is not in your workspace" }
  const r = data as Record<string, any>
  let ownerUserId: string | null = null, ownerAgentId: string | null = null
  if (cfg.owner.kind === "user") ownerUserId = r[cfg.owner.column] ?? null; else ownerAgentId = r[cfg.owner.column] ?? null
  const ag = ownerAgentId
    ? await svc.from("agents").select("id, user_id").eq("id", ownerAgentId).eq("brokerage_id", brokerageId).maybeSingle()
    : ownerUserId ? await svc.from("agents").select("id, user_id").eq("user_id", ownerUserId).eq("brokerage_id", brokerageId).maybeSingle() : { data: null, error: null }
  if (ag.error) return { ok: false, reason: `the owner could not be read (${ag.error.message ?? "refused"})` }
  if (ag.data) { ownerAgentId = (ag.data as { id: string }).id; ownerUserId = (ag.data as { user_id: string | null }).user_id ?? ownerUserId }
  let ownerLocationId: string | null = null
  if (ownerUserId) {
    const { data: u, error: uErr } = await svc.from("users").select("location_id").eq("id", ownerUserId).eq("brokerage_id", brokerageId).maybeSingle()
    if (uErr) return { ok: false, reason: `the owner's office could not be read (${uErr.message ?? "refused"})` }
    ownerLocationId = (u as { location_id: string | null } | null)?.location_id ?? null
  }
  let ownerTeamIds: string[] = []
  if (ownerAgentId) {
    const { data: tm, error: tmErr } = await svc.from("team_members").select("team_id").eq("agent_id", ownerAgentId).eq("brokerage_id", brokerageId).eq("is_active", true)
    if (tmErr) return { ok: false, reason: `the owner's team could not be read (${tmErr.message ?? "refused"})` }
    ownerTeamIds = ((tm ?? []) as Array<{ team_id: string | null }>).map((t) => t.team_id).filter((x): x is string => !!x)
  }
  const vis = cfg.visibility ? (r[cfg.visibility] ?? null) : null
  const teamId = cfg.team ? (r[cfg.team] ?? null) : null
  return { ok: true, row: r, scope: {
    brokerageId, ownerUserId, teamId, ownerLocationId, ownerTeamIds,
    actsFor: vis === "brokerage" || vis === "multi_location" ? "brokerage" : vis === "team" && teamId ? "team" : null,
    contactId: cfg.contact ? (r[cfg.contact] ?? null) : null, transactionId: cfg.transaction ? (r[cfg.transaction] ?? null) : null,
  } }
}

/** THE WRITER'S CHECK: may the session's user exercise `authority` over this piece? Called by approveAsset / rejectAsset. */
export async function requireMarketingApprover(input: { brokerageId: string; approverUserId: string; approverUserType: string | null; table: string; id: string; authority: MarketingAuthority; renderProven?: boolean | null; client?: Db }): Promise<{ ok: true; decision: Extract<MarketingApprovalDecision, { ok: true }>; scope: MarketingArtifactScope; row: Record<string, unknown> } | { ok: false; reason: string }> {
  if (!input.approverUserId) return { ok: false, reason: "no approver — an approval is a person's act" }
  const svc = await db(input.client)
  const art = await marketingArtifactScope(svc, input.brokerageId, input.table, input.id)
  if (!art.ok) return art
  const facts = await loadMarketingApproverFacts(svc, { userId: input.approverUserId, brokerageId: input.brokerageId, userType: input.approverUserType })
  const d = decideMarketingApproval(facts, { ...art.scope, renderProven: input.renderProven ?? null }, input.authority)
  return d.ok ? { ok: true, decision: d, scope: art.scope, row: art.row } : { ok: false, reason: d.reason }
}

/** In a multi-location tenant, does a roster seat's C34 hierarchy reach the asset's office / team? (single-office: yes) */
async function rosterReachesAsset(svc: Db, brokerageId: string, userId: string, scope: ApproverScope): Promise<{ ok: true } | { ok: false; reason: string }> {
  const facts = await loadMarketingApproverFacts(svc, { userId, brokerageId, userType: null })
  if (facts.refusal) return { ok: false, reason: facts.refusal }
  if (!facts.multiLocation) return { ok: true }
  let ownerUserId: string | null = scope.agentUserId ?? null
  let ownerAgentId: string | null = scope.agentId ?? null
  if (ownerAgentId) {
    const { data, error } = await svc.from("agents").select("user_id").eq("id", ownerAgentId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `the owner could not be read (${error.message ?? "refused"})` }
    ownerUserId = (data as { user_id: string | null } | null)?.user_id ?? null
  } else if (ownerUserId) {
    const { data, error } = await svc.from("agents").select("id").eq("user_id", ownerUserId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `the owner could not be read (${error.message ?? "refused"})` }
    ownerAgentId = (data as { id: string } | null)?.id ?? null
  }
  let ownerLocationId: string | null = null
  if (ownerUserId) {
    const { data, error } = await svc.from("users").select("location_id").eq("id", ownerUserId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `the owner's office could not be read (${error.message ?? "refused"})` }
    ownerLocationId = (data as { location_id: string | null } | null)?.location_id ?? null
  }
  let ownerTeamIds: string[] = scope.teamId ? [scope.teamId] : []
  if (ownerAgentId) {
    const { data, error } = await svc.from("team_members").select("team_id").eq("agent_id", ownerAgentId).eq("brokerage_id", brokerageId).eq("is_active", true)
    if (error) return { ok: false, reason: `the owner's team could not be read (${error.message ?? "refused"})` }
    ownerTeamIds = [...ownerTeamIds, ...((data ?? []) as Array<{ team_id: string | null }>).map((t) => t.team_id).filter((x): x is string => !!x)]
  }
  // the owning team's lead is admitted by the C5 decision itself (teams.team_lead_id) — never narrowed here
  if (ownerTeamIds.some((t) => facts.ledTeamIds.includes(t))) return { ok: true }
  const h = facts.hierarchy
  const reach = !!h && (h.aggregate || (!!ownerLocationId && h.locationIds.includes(ownerLocationId)) || ownerTeamIds.some((t) => h.teamIds.includes(t)))
  return reach ? { ok: true } : { ok: false, reason: "this asset belongs to an office or team your office access does not cover (multi-location: an office's admins oversee their own office; the all-office view needs a tenant leadership grant)" }
}

/**
 * D4 — THE ACTING SENDER: an office preparing marketing FOR the brokerage or a team uses that principal's approved brand,
 * sender and return address — never the platform's, never the office's own overrides, never another office's. Requires a
 * delegation with "prepare" (or the seat's own natural authority: the team's lead / an in-scope roster seat). The voice is
 * the ONE brief (lib/kernel/brand-voice.ts loadSenderVoiceBrief) compiled at the principal's scope (no agent slot).
 */
export async function resolveActingSender(client: Db | undefined, input: { brokerageId: string; actorUserId: string; actorUserType: string | null; actsFor: "brokerage" | "team"; teamId?: string | null }): Promise<
  | { ok: true; level: "brokerage" | "team"; teamId: string | null; brandName: string | null; returnAddress: string | null; voiceSources: string[]; signatureSource: string | null; basis: string }
  | { ok: false; reason: string }> {
  const svc = await db(client)
  const facts = await loadMarketingApproverFacts(svc, { userId: input.actorUserId, brokerageId: input.brokerageId, userType: input.actorUserType })
  if (facts.refusal) return { ok: false, reason: facts.refusal }
  const teamId = input.actsFor === "team" ? input.teamId ?? null : null
  if (input.actsFor === "team" && !teamId) return { ok: false, reason: "name the team this piece speaks for" }
  const delegated = facts.delegations.find((d) => d.may.includes("prepare") && d.actsFor === input.actsFor && (input.actsFor === "brokerage" || d.teamId === teamId))
  const natural = input.actsFor === "team" ? facts.ledTeamIds.includes(teamId!) : decideMarketingApproval(facts, { brokerageId: input.brokerageId, ownerUserId: null, teamId: null, ownerLocationId: null, ownerTeamIds: [], actsFor: "brokerage", contactId: null, transactionId: null }, "content_brand").ok
  if (!delegated && !natural) return { ok: false, reason: `you have no delegated marketing grant for this ${input.actsFor} — an office association alone does not let you send in its name` }
  const { data: b, error: bErr } = await svc.from("brokerages").select("name, dba, address, address_line2, city, state, zip").eq("id", input.brokerageId).maybeSingle()
  if (bErr || !b) return { ok: false, reason: `the brokerage's sender identity could not be read (${bErr?.message ?? "no tenant row"})` }
  const fmt = (x: { address?: string | null; address_line2?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null) => {
    if (!x?.address) return null
    return [x.address, x.address_line2, [x.city, x.state].filter(Boolean).join(", "), x.zip].filter(Boolean).join(" · ") || null
  }
  let returnAddress = fmt(b as never)
  if (teamId) {
    const { data: t, error: tErr } = await svc.from("teams").select("id, location_id").eq("id", teamId).eq("brokerage_id", input.brokerageId).is("deleted_at", null).maybeSingle()
    if (tErr) return { ok: false, reason: `the team could not be read (${tErr.message ?? "refused"})` }
    if (!t) return { ok: false, reason: "that team is not in your workspace" }
    const loc = (t as { location_id: string | null }).location_id
    if (loc) {
      const { data: l, error: lErr } = await svc.from("locations").select("address").eq("id", loc).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (lErr) return { ok: false, reason: `the team's office address could not be read (${lErr.message ?? "refused"})` }
      const la = (l as { address?: unknown } | null)?.address
      if (typeof la === "string" && la.trim()) returnAddress = la.trim()
      else if (la && typeof la === "object") returnAddress = fmt(la as never) ?? returnAddress
    }
  }
  const { loadSenderVoiceBrief } = await import("@/lib/kernel/brand-voice")
  const brief = await loadSenderVoiceBrief(svc as never, { brokerageId: input.brokerageId, teamId, agentUserId: null, agentId: null }, { cache: false })
  const bb = b as { name: string | null; dba: string | null }
  return { ok: true, level: input.actsFor, teamId, brandName: input.actsFor === "team" ? brief.sender.teamName ?? brief.sender.brandName ?? bb.dba ?? bb.name : bb.dba ?? bb.name, returnAddress, voiceSources: brief.sources, signatureSource: brief.signature.source, basis: delegated ? `delegated marketing grant (membership ${delegated.membershipId})` : input.actsFor === "team" ? "the team's lead" : "in-scope brokerage admin" }
}
