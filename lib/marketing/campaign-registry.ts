"use server"

/**
 * lib/marketing/campaign-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.1 — Marketing Campaign Registry
 *
 * Provides unified read access across all content sources that can be
 * registered to a marketing campaign. Content sources include:
 * - newsletter_campaigns
 * - direct_mail_campaigns
 * - social_posts
 * - video_snippets
 * - ai_video_projects
 * - video_scripts_library
 * - repurposed_content_log
 *
 * This module does NOT own any tables — it only reads from existing tables
 * and writes to marketing_assets when registering a source to a campaign.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import type { CatalogFilters, CatalogRow } from "@/lib/marketing/content-catalog"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type ContentSourceTable =
  | "newsletter_campaigns"
  | "direct_mail_campaigns"
  | "social_posts"
  | "video_snippets"
  | "ai_video_projects"
  | "video_scripts_library"
  | "repurposed_content_log"

export interface ContentSourceItem {
  id: string
  sourceTable: ContentSourceTable
  title: string
  status: string
  createdAt: string
  thumbnailUrl?: string
  previewText?: string
  channel?: string
  metadata?: Record<string, unknown>
}

export interface CampaignRegistryFilters {
  sourceTable?: ContentSourceTable
  status?: string
  search?: string
  limit?: number
  offset?: number
}

// ─── SOURCE TABLE CONFIGS ─────────────────────────────────────────────────────

interface SourceConfig {
  titleColumn: string
  statusColumn: string
  thumbnailColumn?: string
  previewColumn?: string
  channelColumn?: string
  additionalSelect?: string
}

const SOURCE_CONFIGS: Record<ContentSourceTable, SourceConfig> = {
  newsletter_campaigns: {
    titleColumn: "campaign_name",
    statusColumn: "status",
    previewColumn: "subject_line",
    channelColumn: "'email'",
  },
  direct_mail_campaigns: {
    titleColumn: "campaign_name",
    statusColumn: "status",
    thumbnailColumn: "design_url",
    channelColumn: "'direct_mail'",
  },
  social_posts: {
    titleColumn: "content",
    statusColumn: "status",
    previewColumn: "content",
    channelColumn: "platform",
    additionalSelect: "media_urls, hashtags",
  },
  video_snippets: {
    titleColumn: "snippet_title",
    statusColumn: "approval_status",
    thumbnailColumn: "thumbnail_url",
    previewColumn: "caption_text",
    channelColumn: "platform_target",
  },
  ai_video_projects: {
    titleColumn: "title",
    statusColumn: "status",
    thumbnailColumn: "video_url",
    previewColumn: "script_content",
    channelColumn: "video_type",
  },
  video_scripts_library: {
    titleColumn: "title",
    statusColumn: "approval_status",
    previewColumn: "script_content",
    channelColumn: "script_type",
  },
  repurposed_content_log: {
    titleColumn: "output_type",
    statusColumn: "status",
    channelColumn: "platform_target",
    additionalSelect: "source_type, source_id",
  },
}

// ─── MAIN REGISTRY FUNCTION ───────────────────────────────────────────────────

/**
 * getCampaignRegistry
 *
 * Fetches available content sources across all supported tables.
 * Returns a unified list of ContentSourceItem objects that can be
 * registered (linked) to a marketing campaign.
 */
export async function getCampaignRegistry(
  filters?: CampaignRegistryFilters
): Promise<{ success: boolean; items: ContentSourceItem[]; error?: string }> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const items: ContentSourceItem[] = []
  const limit = filters?.limit ?? 50
  const offset = filters?.offset ?? 0

  // Determine which tables to query
  const tablesToQuery: ContentSourceTable[] = filters?.sourceTable
    ? [filters.sourceTable]
    : (Object.keys(SOURCE_CONFIGS) as ContentSourceTable[])

  for (const table of tablesToQuery) {
    const config = SOURCE_CONFIGS[table]

    try {
      // Build select columns
      const selectCols = [
        "id",
        `${config.titleColumn} as title`,
        `${config.statusColumn} as status`,
        "created_at",
        config.thumbnailColumn ? `${config.thumbnailColumn} as thumbnail_url` : null,
        config.previewColumn ? `${config.previewColumn} as preview_text` : null,
        config.channelColumn ? `${config.channelColumn} as channel` : null,
        config.additionalSelect ?? null,
      ]
        .filter(Boolean)
        .join(", ")

      let query = supabase
        .from(table)
        .select(selectCols)
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1)

      if (filters?.status) {
        query = query.eq(config.statusColumn, filters.status)
      }

      if (filters?.search) {
        query = query.ilike(config.titleColumn, `%${filters.search}%`)
      }

      const { data, error } = await query

      if (error) {
        console.error(`[v0] Error querying ${table}:`, error)
        continue
      }

      for (const row of data ?? []) {
        const r = row as any
        items.push({
          id: r.id,
          sourceTable: table,
          title: truncateText(r.title ?? `${table} item`, 100) ?? "",
          status: r.status ?? "unknown",
          createdAt: r.created_at,
          thumbnailUrl: r.thumbnail_url ?? undefined,
          previewText: truncateText(r.preview_text, 200),
          channel: r.channel ?? undefined,
          metadata: r as Record<string, unknown>,
        })
      }
    } catch (err) {
      console.error(`[v0] Exception querying ${table}:`, err)
    }
  }

  // Sort combined results by created_at descending
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return { success: true, items: items.slice(0, limit) }
}

// ─── REGISTER SOURCE TO CAMPAIGN ──────────────────────────────────────────────

/**
 * registerCampaignSource
 *
 * Links an existing content item from any source table to a marketing campaign
 * by creating a corresponding marketing_assets record.
 */
export async function registerCampaignSource(params: {
  campaignId: string
  sourceTable: ContentSourceTable
  sourceId: string
  assetName?: string
}): Promise<{ success: boolean; assetId?: string; error?: string }> {
  const { userId, agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Fetch source item to get metadata
  const config = SOURCE_CONFIGS[params.sourceTable]
  const { data: sourceItem, error: fetchError } = await supabase
    .from(params.sourceTable)
    .select(`id, ${config.titleColumn}, ${config.thumbnailColumn ?? "null as thumbnail"}, ${config.previewColumn ?? "null as preview"}`)
    .eq("id", params.sourceId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (fetchError || !sourceItem) {
    return { success: false, error: "Source item not found" }
  }

  // Map source table to asset type
  const assetTypeMap: Record<ContentSourceTable, string> = {
    newsletter_campaigns: "email",
    direct_mail_campaigns: "direct_mail",
    social_posts: "social_post",
    video_snippets: "video",
    ai_video_projects: "video",
    video_scripts_library: "document",
    repurposed_content_log: "document",
  }

  const { data: asset, error: insertError } = await supabase
    .from("marketing_assets")
    .insert({
      brokerage_id: brokerageId,
      // pass 13: marketing_assets.agent_user_id FKs users(id) — getAgentContext's
      // agentId is agents.id and FK-threw here, killing promote-to-asset.
      agent_user_id: userId,
      created_by: userId,
      campaign_id: params.campaignId,
      asset_type: assetTypeMap[params.sourceTable],
      asset_name: params.assetName ?? (sourceItem as any)[config.titleColumn] ?? "Untitled",
      source_table: params.sourceTable,
      source_id: params.sourceId,
      thumbnail_url: (sourceItem as any).thumbnail ?? null,
      preview_text: truncateText((sourceItem as any).preview, 500),
      approval_status: "pending",
      visibility_scope: "agent",
    })
    .select("id")
    .single()

  if (insertError) {
    console.error("[v0] Error registering source:", insertError)
    return { success: false, error: insertError.message }
  }

  return { success: true, assetId: asset.id }
}

// ─── UNREGISTER SOURCE ────────────────────────────────────────────────────────

/**
 * unregisterCampaignSource
 *
 * Removes a source item from a campaign by deleting the marketing_assets record.
 * Does NOT delete the source item itself.
 */
export async function unregisterCampaignSource(assetId: string): Promise<{ success: boolean; error?: string }> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { error } = await supabase
    .from("marketing_assets")
    .delete()
    .eq("id", assetId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error unregistering source:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── GET CAMPAIGN SOURCES ─────────────────────────────────────────────────────

/**
 * getCampaignSources
 *
 * Returns all content sources registered to a specific campaign.
 */
export async function getCampaignSources(campaignId: string): Promise<{
  success: boolean
  sources: ContentSourceItem[]
  error?: string
}> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data: assets, error } = await supabase
    .from("marketing_assets")
    .select("id, source_table, source_id, asset_name, thumbnail_url, preview_text, approval_status, created_at")
    .eq("campaign_id", campaignId)
    .eq("brokerage_id", brokerageId)
    .not("source_table", "is", null)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching campaign sources:", error)
    return { success: false, sources: [], error: error.message }
  }

  const sources: ContentSourceItem[] = (assets ?? []).map((a) => ({
    id: a.source_id!,
    sourceTable: a.source_table as ContentSourceTable,
    title: a.asset_name ?? "Untitled",
    status: a.approval_status ?? "pending",
    createdAt: a.created_at,
    thumbnailUrl: a.thumbnail_url ?? undefined,
    previewText: a.preview_text ?? undefined,
  }))

  return { success: true, sources }
}

// ─── THE CONTENT AND CHANNEL COMMAND CENTER (wave 154, lane 154G2 — directive G7, owner ruling R8) ─────────────
// The registry above lists 7 linkable tables; the Command Center reads every canonical producer through ONE index
// (lib/marketing/content-catalog.ts readContentCatalog) and acts only through the EXISTING writers it names
// (CATALOG_ACTION_WRITERS). The read export is a public endpoint (§4): the tenant, the seat and the scope come from the
// SESSION only; the service client is used after that gate, and every catalog query is brokerage-filtered.

async function sessionCatalogViewer() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) return null
  const [{ createServiceClient }, { resolveCatalogViewer }] = await Promise.all([import("@/lib/supabase/service"), import("@/lib/marketing/content-catalog")])
  const db = createServiceClient()
  const viewer = await resolveCatalogViewer(db, { userId: ctx.userId, brokerageId: ctx.brokerageId, userType: ctx.userType || "agent" })
  return { db, viewer }
}

/** The unified, scoped read. Filters are view choices only — they can narrow what the session may see, never widen it. */
export async function getContentCommandCenter(filters?: Omit<CatalogFilters, "perSourceLimit">): Promise<{
  success: boolean; rows: CatalogRow[]; scopeLabel: string | null; notice: string | null; perSourceLimit: number | null; error?: string
}> {
  const session = await sessionCatalogViewer()
  if (!session) return { success: false, rows: [], scopeLabel: null, notice: null, perSourceLimit: null, error: "Sign in to see your content." }
  const { readContentCatalog } = await import("@/lib/marketing/content-catalog")
  const read = await readContentCatalog(session.db, session.viewer, { ...(filters ?? {}) })
  let notice: string | null = session.viewer.refusal
  if (read.unreadable.length) {
    const { presentTenantError } = await import("@/lib/errors")
    notice = presentTenantError({
      what: `Part of your content list couldn't be loaded (${read.unreadable.map((u) => u.table.replace(/_/g, " ")).join(", ")}), so those items are missing below — not empty`,
      raw: read.unreadable.map((u) => `${u.table}: ${u.error}`).join("; "), context: "content-command-center",
    }).sentence
  }
  return { success: true, rows: read.rows, scopeLabel: read.scopeLabel, notice, perSourceLimit: read.perSourceLimit }
}

// ─── DELEGATED OFFICE MARKETING (wave 155, lane 155D — owner R7: "if the office is sending marketing for the brokerage
// or team then they need access") ────────────────────────────────────────────────────────────────────────────────
// The grant rides the EXISTING scope membership (organization_members, m958): the delegate's ACTIVE tenant-scope row
// (acts for the brokerage) or team-scope row (acts for that team) carries permissions.marketing_delegation. Nothing new is
// minted: no role, no user type, no table. A LOCATION membership never carries it (parseMarketingDelegation), so office
// association alone confers nothing brokerage-wide. The granter's own hierarchy (lib/kernel/resolve-user-office.ts, C34)
// must cover the principal: the aggregated view for the brokerage, the team for a team. Revocable: revokeMarketingDelegation
// clears the key; revoking the membership (revoked_at) ends it too. Every grant / revoke is on the action ledger.

async function delegationDoor(input: { memberUserId: string; actsFor: "brokerage" | "team"; teamId?: string | null }) {
  const ctx = await getAgentContext()
  const userId = ctx.userId, brokerageId = ctx.brokerageId
  if (!ctx.isAuthenticated || !userId || !brokerageId) return { ok: false as const, error: "Your workspace couldn't be confirmed. Sign in again." }
  if (!input.memberUserId) return { ok: false as const, error: "Choose the person who will market for this principal." }
  if (input.actsFor !== "brokerage" && input.actsFor !== "team") return { ok: false as const, error: "A delegation is for the brokerage or a team." }
  const teamId = input.actsFor === "team" ? (input.teamId ?? "").trim() : null
  if (input.actsFor === "team" && !teamId) return { ok: false as const, error: "Choose the team." }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { resolveViewerHierarchy } = await import("@/lib/kernel/resolve-user-office")
  const granter = await resolveViewerHierarchy(svc as never, { userId, brokerageId })
  if (!granter.ok) return { ok: false as const, error: `Your access could not be checked (${granter.error}) — nothing was changed.` }
  const covers = input.actsFor === "brokerage" ? granter.scope.aggregate : granter.scope.aggregate || granter.scope.teamIds.includes(teamId!)
  if (!covers) return { ok: false as const, error: input.actsFor === "brokerage" ? "Only the brokerage's leadership can let someone market in the brokerage's name." : "You can only delegate marketing for a team you lead or oversee." }
  let q = svc.from("organization_members").select("id, permissions").eq("brokerage_id", brokerageId).eq("user_id", input.memberUserId).eq("scope_kind", input.actsFor === "brokerage" ? "tenant" : "team").is("revoked_at", null)
  q = teamId ? q.eq("team_id", teamId) : q.is("team_id", null)
  const { data: rows, error } = await q.limit(1)
  if (error) return { ok: false as const, error: `The membership could not be read (${error.message}) — nothing was changed.` }
  const m = ((rows ?? []) as Array<{ id: string; permissions: unknown }>)[0]
  if (!m) return { ok: false as const, error: input.actsFor === "brokerage" ? "That person has no active workspace membership to carry the grant — place them first (Settings → Offices)." : "That person is not an active member of this team — place them on the team first (Settings → Offices)." }
  return { ok: true as const, svc, userId, brokerageId, teamId, membership: m }
}

export async function grantMarketingDelegation(input: { memberUserId: string; actsFor: "brokerage" | "team"; teamId?: string | null; may?: Array<"prepare" | "approve"> }) {
  const door = await delegationDoor(input)
  if (!door.ok) return { success: false, error: door.error }
  const { MARKETING_DELEGATION_KEY, MARKETING_DELEGATION_ACTIONS } = await import("@/lib/kernel/approval-authority")
  const may = [...new Set((input.may?.length ? input.may : ["prepare", "approve"]).filter((x) => (MARKETING_DELEGATION_ACTIONS as readonly string[]).includes(x)))]
  if (!may.length) return { success: false, error: "Choose what they may do: prepare, approve, or both." }
  const { svc, userId, brokerageId, teamId, membership } = door
  const prior = membership.permissions && typeof membership.permissions === "object" && !Array.isArray(membership.permissions) ? (membership.permissions as Record<string, unknown>) : {}
  const nowIso = new Date().toISOString()
  const next = { ...prior, [MARKETING_DELEGATION_KEY]: { acts_for: input.actsFor, team_id: teamId, may, granted_by: userId, granted_at: nowIso } }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const r = await withActionLedger(
    {
      brokerageId, action: "marketing.delegation.grant", actor: { type: "user", userId },
      subject: { type: "organization_member", id: membership.id }, reasonCode: "HUMAN_REQUESTED", systemSource: "marketing_studio",
      reasonDetail: `marketing delegation for the ${input.actsFor}${teamId ? ` ${teamId}` : ""}: ${may.join(", ")}`, riskClass: "OPERATIONAL",
      cycle: `marketing_delegation_grant:${membership.id}:${may.join("+")}`,
      detail: { membership_id: membership.id, member_user_id: input.memberUserId, acts_for: input.actsFor, team_id: teamId, may },
    },
    async () => {
      const { data, error } = await svc.from("organization_members").update({ permissions: next, updated_at: nowIso }).eq("id", membership.id).eq("brokerage_id", brokerageId).is("revoked_at", null).select("id")
      if (error) return { n: 0, error: error.message as string }
      return { n: (data ?? []).length, error: null as string | null }
    },
    {
      settle: (x) => x.n === 1 ? { status: "executed", outcome: "marketing_delegation_granted", costUsd: null } : { status: "failed", outcome: "grant_matched_nothing", error: x.error ?? "0 rows matched" },
      replay: (claim) => ({ n: claim.kind === "refused" ? 0 : 1, error: claim.kind === "refused" ? `the grant could not be recorded on the action ledger (${claim.error}) — nothing was changed` : null }),
    },
    { client: svc },
  )
  return r.n === 1 ? { success: true, membershipId: membership.id, may } : { success: false, error: r.error ?? "The grant was not saved." }
}

export async function revokeMarketingDelegation(input: { memberUserId: string; actsFor: "brokerage" | "team"; teamId?: string | null }) {
  const door = await delegationDoor(input)
  if (!door.ok) return { success: false, error: door.error }
  const { MARKETING_DELEGATION_KEY } = await import("@/lib/kernel/approval-authority")
  const { svc, userId, brokerageId, membership } = door
  const prior = membership.permissions && typeof membership.permissions === "object" && !Array.isArray(membership.permissions) ? { ...(membership.permissions as Record<string, unknown>) } : {}
  if (!(MARKETING_DELEGATION_KEY in prior)) return { success: true, unchanged: true }
  delete prior[MARKETING_DELEGATION_KEY]
  const nowIso = new Date().toISOString()
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const r = await withActionLedger(
    {
      brokerageId, action: "marketing.delegation.revoke", actor: { type: "user", userId },
      subject: { type: "organization_member", id: membership.id }, reasonCode: "HUMAN_REQUESTED", systemSource: "marketing_studio",
      reasonDetail: `marketing delegation for the ${input.actsFor} revoked`, riskClass: "OPERATIONAL", cycle: `marketing_delegation_revoke:${membership.id}:${nowIso}`,
      detail: { membership_id: membership.id, member_user_id: input.memberUserId, acts_for: input.actsFor },
    },
    async () => {
      const { data, error } = await svc.from("organization_members").update({ permissions: prior, updated_at: nowIso }).eq("id", membership.id).eq("brokerage_id", brokerageId).select("id")
      if (error) return { n: 0, error: error.message as string }
      return { n: (data ?? []).length, error: null as string | null }
    },
    {
      settle: (x) => x.n === 1 ? { status: "executed", outcome: "marketing_delegation_revoked", costUsd: null } : { status: "failed", outcome: "revocation_matched_nothing", error: x.error ?? "0 rows matched" },
      replay: (claim) => ({ n: 0, error: claim.kind === "refused" ? `the revocation could not be recorded on the action ledger (${claim.error}) — nothing was changed` : "this revocation was already recorded" }),
    },
    { client: svc },
  )
  return r.n === 1 ? { success: true } : { success: false, error: r.error ?? "The revocation was not saved." }
}


/** The delegation board for a granter: who may be delegated, for which principal, and the grants in force. Only the
 *  granter's own hierarchy (the aggregated view → the brokerage + every team; a team lead → their teams) is offered. */
export async function getMarketingDelegations(): Promise<{
  success: boolean; canGrantBrokerage: boolean; teams: Array<{ id: string; name: string }>; people: Array<{ id: string; name: string; userType: string }>
  current: Array<{ userId: string; name: string; actsFor: "brokerage" | "team"; teamId: string | null; may: string[] }>; error?: string
}> {
  const empty = { canGrantBrokerage: false, teams: [], people: [], current: [] }
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) return { success: false, ...empty, error: "Sign in to manage delegated marketing." }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { resolveViewerHierarchy } = await import("@/lib/kernel/resolve-user-office")
  const h = await resolveViewerHierarchy(svc as never, { userId: ctx.userId, brokerageId: ctx.brokerageId })
  if (!h.ok) return { success: false, ...empty, error: `Your access could not be checked (${h.error}).` }
  if (!h.scope.aggregate && h.scope.teamIds.length === 0) return { success: true, ...empty }
  const B = ctx.brokerageId
  let tq = svc.from("teams").select("id, name").eq("brokerage_id", B).is("deleted_at", null)
  if (!h.scope.aggregate) tq = tq.in("id", h.scope.teamIds)
  let pq = svc.from("users").select("id, first_name, last_name, user_type, team_id, location_id").eq("brokerage_id", B).not("user_type", "in", "(contact,vendor,system)").limit(300)
  if (!h.scope.aggregate) pq = pq.in("team_id", h.scope.teamIds)
  const [teams, people, mem] = await Promise.all([tq, pq, svc.from("organization_members").select("user_id, scope_kind, team_id, permissions").eq("brokerage_id", B).in("scope_kind", ["tenant", "team"]).is("revoked_at", null)])
  const err = teams.error ?? people.error ?? mem.error
  if (err) return { success: false, ...empty, error: `The delegation board could not be read (${err.message}).` }
  const { parseMarketingDelegation } = await import("@/lib/kernel/approval-authority")
  const name = new Map(((people.data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed seat"]))
  const teamIds = new Set(((teams.data ?? []) as Array<{ id: string }>).map((t) => t.id))
  const current = ((mem.data ?? []) as Array<{ user_id: string; scope_kind: string; team_id: string | null; permissions: unknown }>)
    .map((m) => ({ m, d: parseMarketingDelegation({ id: m.user_id, scope_kind: m.scope_kind, team_id: m.team_id, permissions: m.permissions }) }))
    .filter((x) => !!x.d && (x.d.actsFor === "brokerage" ? h.scope.aggregate : teamIds.has(x.d.teamId ?? "")))
    .map(({ m, d }) => ({ userId: m.user_id, name: name.get(m.user_id) ?? "a seat outside your scope", actsFor: d!.actsFor, teamId: d!.teamId, may: d!.may }))
  return {
    success: true, canGrantBrokerage: h.scope.aggregate,
    teams: ((teams.data ?? []) as Array<{ id: string; name: string | null }>).map((t) => ({ id: t.id, name: t.name ?? "Unnamed team" })),
    people: ((people.data ?? []) as Array<{ id: string; user_type: string | null }>).map((p) => ({ id: p.id, name: name.get(p.id) ?? "Unnamed seat", userType: p.user_type ?? "unknown" })),
    current,
  }
}

// The ACTION door is NOT here: app/api/marketing/content-command/route.ts (POST) — the writers' graphs would otherwise land
// on the studio page, the heaviest app entry. It re-reads the row with readContentCatalog under the session exactly as above.

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function truncateText(text: string | null | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + "..."
}
