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
  return { ok: true, decision }
}
