"use server"

/**
 * Server actions for the Embed Widget settings page.
 */

import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { normalizeEnabledModes, type EmbedMode } from "@/lib/embed/widget-modes"

export interface EmbedWidget {
  id: string
  publicId: string
  brokerageId: string
  agentId: string | null
  teamId: string | null
  label: string
  defaultTwinId: string | null
  welcomeMessage: string | null
  enabledModes: EmbedMode[]
  leadCaptureMode: "immediate" | "after_first_message" | "optional"
  leadCaptureFields: string[]
  allowedDomains: string[]
  routingMode: "primary" | "round_robin"
  style: Record<string, any>
  isActive: boolean
  createdAt: string
}

function rowToWidget(r: any): EmbedWidget {
  return {
    id: r.id,
    publicId: r.public_id,
    brokerageId: r.brokerage_id,
    agentId: r.agent_id,
    teamId: r.team_id,
    label: r.label ?? "My Website",
    defaultTwinId: r.default_twin_id,
    welcomeMessage: r.welcome_message,
    enabledModes: normalizeEnabledModes(r.enabled_modes),
    leadCaptureMode: r.lead_capture_mode,
    leadCaptureFields: r.lead_capture_fields ?? [],
    allowedDomains: r.allowed_domains ?? [],
    routingMode: (r.routing_mode ?? "primary") as "primary" | "round_robin",
    style: r.style ?? {},
    isActive: !!r.is_active,
    createdAt: r.created_at,
  }
}

// TRUE ADMIN GATE (operational, team_lead already included) — repointed to the
// ONE tenant roster. 'superadmin' was dead: 0 live rows store that users.user_type.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export async function listMyEmbeds(): Promise<{ widgets: EmbedWidget[]; canCreateBrokerageWide: boolean; error?: string }> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { widgets: [], canCreateBrokerageWide: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const canCreateBrokerageWide = isAdminOrBroker({ user_type: ctx.userType })

  // Brokers see all embeds in their brokerage. Agents see only their own.
  const query = supabase
    .from("embed_widgets")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })

  if (!canCreateBrokerageWide) {
    if (!ctx.agentId) return { widgets: [], canCreateBrokerageWide }
    query.eq("agent_id", ctx.agentId)
  }

  const { data, error } = await query
  if (error) return { widgets: [], canCreateBrokerageWide, error: error.message }
  return { widgets: (data ?? []).map(rowToWidget), canCreateBrokerageWide }
}

/**
 * A twin may only be pinned to an embed if it is a twin of THIS brokerage and is
 * actually usable — ready + approved. Enforced server-side because the picker is
 * a convenience, not a boundary: these actions accept an id straight from the
 * client, and an unvalidated one would put an unapproved (or another tenant's)
 * face on a public website.
 */
async function assertTwinAssignable(
  supabase: ReturnType<typeof createServiceClient>,
  twinId: string,
  brokerageId: string,
): Promise<string | null> {
  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("id, brokerage_id, status, approval_status")
    .eq("id", twinId)
    .maybeSingle()
  if (!twin || twin.brokerage_id !== brokerageId) return "Twin not found"
  if (twin.status !== "ready") return "That twin is still processing — pick one that's ready"
  if (twin.approval_status !== "approved") return "That twin is awaiting approval"
  return null
}

export async function createEmbed(params: {
  label: string
  scope: "personal" | "brokerage"
  defaultTwinId?: string | null
}): Promise<{ ok: boolean; widget?: EmbedWidget; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }

  if (params.scope === "brokerage" && !isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Only brokers / admins can create brokerage-wide embeds" }
  }

  const supabase = createServiceClient()

  // A BROKERAGE-WIDE EMBED MUST NAME ITS TWIN. There is no owner agent to fall
  // back to, and the session route no longer invents one by picking the
  // brokerage's longest-tenured agent — an agent's likeness and cloned voice are
  // not brokerage property to assign on a timestamp. Required at the moment of
  // creation so the admin never ships a widget that cannot greet anyone.
  if (params.scope === "brokerage" && !params.defaultTwinId) {
    return { ok: false, error: "Pick the twin that will greet visitors — a brokerage-wide embed has no owner agent to inherit from" }
  }
  if (params.defaultTwinId) {
    const bad = await assertTwinAssignable(supabase, params.defaultTwinId, ctx.brokerageId)
    if (bad) return { ok: false, error: bad }
  }

  const insert: Record<string, any> = {
    brokerage_id: ctx.brokerageId,
    label: params.label.slice(0, 64) || "My Website",
    default_twin_id: params.defaultTwinId ?? null,
    is_active: true,
  }

  if (params.scope === "personal") {
    if (!ctx.agentId) return { ok: false, error: "No agent profile for this user" }
    insert.agent_id = ctx.agentId
  }

  const { data, error } = await supabase
    .from("embed_widgets")
    .insert(insert)
    .select("*")
    .single()

  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" }
  revalidatePath("/dashboard/settings/embeds")
  return { ok: true, widget: rowToWidget(data) }
}

export async function updateEmbed(params: {
  id: string
  label?: string
  defaultTwinId?: string | null
  welcomeMessage?: string | null
  enabledModes?: EmbedMode[]
  leadCaptureMode?: "immediate" | "after_first_message" | "optional"
  leadCaptureFields?: string[]
  allowedDomains?: string[]
  routingMode?: "primary" | "round_robin"
  style?: Record<string, any>
  isActive?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }

  const supabase = createServiceClient()

  const { data: existing } = await supabase
    .from("embed_widgets")
    .select("id, brokerage_id, agent_id")
    .eq("id", params.id)
    .maybeSingle()
  if (!existing) return { ok: false, error: "Embed not found" }
  if (existing.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Forbidden" }

  // Brokerage-wide embeds (agent_id NULL) only editable by admin roles.
  if (existing.agent_id === null && !isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden" }
  }
  // Personal embeds editable only by their owner.
  if (existing.agent_id !== null && existing.agent_id !== ctx.agentId && !isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden" }
  }

  // Same rule on edit: a brokerage-wide embed cannot be left twin-less, and any
  // twin pinned here must belong to this brokerage and be ready + approved.
  if (params.defaultTwinId !== undefined) {
    if (!params.defaultTwinId && existing.agent_id === null) {
      return { ok: false, error: "A brokerage-wide embed needs a twin — it has no owner agent to inherit one from" }
    }
    if (params.defaultTwinId) {
      const bad = await assertTwinAssignable(supabase, params.defaultTwinId, ctx.brokerageId)
      if (bad) return { ok: false, error: bad }
    }
  }

  const update: Record<string, any> = { updated_at: new Date().toISOString() }
  if (params.label !== undefined) update.label = params.label.slice(0, 64)
  if (params.defaultTwinId !== undefined) update.default_twin_id = params.defaultTwinId
  if (params.welcomeMessage !== undefined) update.welcome_message = params.welcomeMessage
  // NORMALISED, not trusted. The stored array is CHECK-constrained (m336) to the
  // EMBED_MODES vocabulary with 'text' always present, and this is the single
  // writer — so it normalises rather than letting a stale client shape reach the
  // constraint as a raw error the broker cannot act on.
  if (params.enabledModes !== undefined) update.enabled_modes = normalizeEnabledModes(params.enabledModes)
  if (params.leadCaptureMode !== undefined) update.lead_capture_mode = params.leadCaptureMode
  if (params.leadCaptureFields !== undefined) update.lead_capture_fields = params.leadCaptureFields
  if (params.allowedDomains !== undefined) update.allowed_domains = sanitizeDomains(params.allowedDomains)
  if (params.routingMode !== undefined) update.routing_mode = params.routingMode
  if (params.style !== undefined) update.style = params.style
  if (params.isActive !== undefined) update.is_active = params.isActive

  const { error } = await supabase.from("embed_widgets").update(update).eq("id", params.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/settings/embeds")
  return { ok: true }
}

export async function deleteEmbed(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const { data: existing } = await supabase
    .from("embed_widgets")
    .select("brokerage_id, agent_id")
    .eq("id", id)
    .maybeSingle()
  if (!existing) return { ok: false, error: "Not found" }
  if (existing.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Forbidden" }
  if (existing.agent_id === null && !isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }
  if (existing.agent_id !== null && existing.agent_id !== ctx.agentId && !isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden" }
  }

  await supabase.from("embed_widgets").delete().eq("id", id)
  revalidatePath("/dashboard/settings/embeds")
  return { ok: true }
}

/** Returns the available twins for assignment (owner agent's, or all in
 *  brokerage for admin scope). Ready + approved only. */
export async function listTwinsForEmbed(scope: "personal" | "brokerage"):
  Promise<{ twins: { id: string; label: string; agentName: string | null }[] }> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { twins: [] }
  const supabase = createServiceClient()

  // `agents` has NO `full_name` (verified against information_schema), so
  // PostgREST rejected this ENTIRE query and the twin picker on
  // /dashboard/settings/embeds has always been empty — not "no twins", a dead
  // read. The name lives on `users`, reached through agents_user_id_fkey (the
  // only FK from agents to users, so an OBJECT embed).
  const query = supabase
    .from("agent_avatar_assets")
    .select("id, label, agent_id, agents:agent_id(id, users:user_id(first_name, last_name))")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("status", "ready")
    .eq("approval_status", "approved")
    .order("is_default", { ascending: false })

  if (scope === "personal" && ctx.agentId) {
    query.eq("agent_id", ctx.agentId)
  }

  // supabase-js RESOLVES a failed query, so a bare `const { data }` reported a
  // rejected select as "this brokerage has no approved twins".
  const { data, error } = await query
  if (error) {
    console.error("[listTwinsForEmbed] twin read refused:", error.message)
    return { twins: [] }
  }

  return {
    twins: (data ?? []).map((t: any) => {
      const u = t.agents?.users ?? null
      return {
        id: t.id,
        label: t.label,
        agentName: [u?.first_name, u?.last_name].filter(Boolean).join(" ") || null,
      }
    }),
  }
}

// ─── Analytics ───────────────────────────────────────────────────────────

export interface EmbedAnalytics {
  widgetId: string
  totalSessions: number
  totalLeads: number
  conversionRate: number
  /** Distinct visitor_ids seen in the window. */
  uniqueVisitors: number
  /** Visitors with more than one session in the window. */
  returningVisitors: number
  topPages: { pageUrl: string; sessions: number; leads: number }[]
  /** Same shape as topPages, keyed by embed_sessions.referrer (the page that sent the visitor). */
  topReferrers: { referrer: string; sessions: number; leads: number }[]
  /**
   * Coarse device split derived from embed_sessions.user_agent. The raw UA is
   * fingerprint-adjacent and is NEVER returned or stored anywhere but the row
   * the session writer already wrote — only these four buckets leave the action.
   */
  devices: { mobile: number; desktop: number; bot: number; unknown: number }
  /**
   * Which twin actually greeted visitors. embed_sessions.did_session_ref is the
   * D-ID agent id the session was opened against (app/api/embed/session/route.ts
   * stores ensured.didAgentId — an AGENT id, not a D-ID session id, despite the
   * column name), resolved tenant-scoped against agent_avatar_assets.did_agent_id.
   * A widget's twin can change (default_twin_id is nullable and the route falls
   * back to the agent's first ready twin), so this is not always one row.
   *
   * NOT A LINK: nothing in the tree routes by a D-ID agent id — the only readers
   * of did_agent_id are the D-ID cache lookups in lib/did/agents.ts, and the
   * twin-studio settings page is keyed by agent_avatar_assets.id, not by it. A
   * label is what can be honestly shown; a link would have nowhere to go.
   */
  byTwin: { twinId: string | null; label: string; sessions: number }[]
  byDay: { date: string; sessions: number; leads: number }[]
}

/**
 * Bucket a User-Agent string without retaining it. Bot first (a crawler's UA
 * often also says "Mobile"), then the mobile markers, else desktop. Empty/NULL
 * is "unknown" — older rows and header-less requests must not read as desktop.
 *
 * NOT exported: this file is "use server", where every export is a public
 * HTTP endpoint and must be async (CLAUDE.md §4). A sync helper stays private.
 */
function classifyUserAgent(ua: string | null | undefined): "mobile" | "desktop" | "bot" | "unknown" {
  if (!ua || !ua.trim()) return "unknown"
  const s = ua.toLowerCase()
  if (/\b(bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl\/|wget\/|python-requests)\b/.test(s)) return "bot"
  if (/\b(mobile|iphone|ipod|android|windows phone|blackberry|opera mini|ipad|tablet)\b/.test(s)) return "mobile"
  return "desktop"
}

/**
 * Returns analytics for a single embed widget (or a summary across all of the
 * caller's widgets when widgetId is omitted). Only accessible by the widget
 * owner or admin roles.
 */
export async function getEmbedAnalytics(params: {
  widgetId?: string
  days?: number
}): Promise<{ ok: boolean; analytics?: EmbedAnalytics[]; error?: string }> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const days = params.days ?? 30
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const isAdmin = isAdminOrBroker({ user_type: ctx.userType })

  // Determine which widget ids to query
  let widgetIds: string[]
  if (params.widgetId) {
    // Verify access
    const { data: w } = await supabase
      .from("embed_widgets")
      .select("id, brokerage_id, agent_id")
      .eq("id", params.widgetId)
      .maybeSingle()
    if (!w || w.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Not found" }
    if (!isAdmin && w.agent_id !== ctx.agentId) return { ok: false, error: "Forbidden" }
    widgetIds = [params.widgetId]
  } else {
    const q = supabase.from("embed_widgets").select("id").eq("brokerage_id", ctx.brokerageId)
    if (!isAdmin && ctx.agentId) q.eq("agent_id", ctx.agentId)
    const { data: ws } = await q
    widgetIds = (ws ?? []).map((w: any) => w.id)
  }

  if (widgetIds.length === 0) return { ok: true, analytics: [] }

  // Pull sessions in the window. metadata carries the full page URL — the
  // session writer (app/api/embed/session/route.ts) stores it as
  // metadata.page_url because embed_sessions has no page_url column.
  // referrer / user_agent / did_session_ref are written on every row by that
  // same route and were never selected. referrer feeds "Top referrers",
  // user_agent is reduced to a device bucket in-process (see classifyUserAgent
  // — the string itself never leaves this function), did_session_ref is
  // resolved to a twin label below.
  const { data: sessions, error: sessionsError } = await supabase
    .from("embed_sessions")
    .select("id, embed_widget_id, contact_id, origin, started_at, metadata, visitor_id, referrer, user_agent, did_session_ref")
    .in("embed_widget_id", widgetIds)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
  if (sessionsError) return { ok: false, error: sessionsError.message }

  const rows = sessions ?? []

  // Twin resolution: did_session_ref → agent_avatar_assets.did_agent_id, ONE
  // batched read anchored on the session tenant. A ref that matches no twin in
  // this brokerage (twin deleted, or a D-ID agent cached on agent_voice_profiles
  // rather than on a twin) stays a labelled "unresolved" bucket, never a guess.
  const twinRefs = [...new Set(rows.map((r: any) => r.did_session_ref).filter((v: unknown): v is string => typeof v === "string" && v.length > 0))]
  const twinByRef = new Map<string, { id: string; label: string }>()
  if (twinRefs.length > 0) {
    const { data: twins, error: twinErr } = await supabase
      .from("agent_avatar_assets")
      .select("id, did_agent_id, label")
      .eq("brokerage_id", ctx.brokerageId)
      .in("did_agent_id", twinRefs)
    if (twinErr) console.error("[embed-widgets] twin resolve for analytics refused:", twinErr.message)
    for (const t of twins ?? []) {
      if (t.did_agent_id) twinByRef.set(t.did_agent_id, { id: t.id, label: t.label ?? "Untitled twin" })
    }
  }

  const analytics: EmbedAnalytics[] = widgetIds.map((wid) => {
    const wRows = rows.filter((r: any) => r.embed_widget_id === wid)
    const total = wRows.length
    const leads = wRows.filter((r: any) => !!r.contact_id).length

    // Top pages (by session count, top 10). "Pages" means PAGES: the full
    // URL from metadata.page_url — this used to group by origin, which
    // collapsed every page of a site into one row labeled a page. Origin
    // stays as the fallback for older rows written before page_url existed.
    const pageMap: Record<string, { sessions: number; leads: number }> = {}
    for (const r of wRows) {
      const meta = (r.metadata ?? {}) as Record<string, unknown>
      const pageUrl = typeof meta.page_url === "string" && meta.page_url ? meta.page_url : null
      const key = pageUrl ?? r.origin ?? "(unknown)"
      if (!pageMap[key]) pageMap[key] = { sessions: 0, leads: 0 }
      pageMap[key].sessions++
      if (r.contact_id) pageMap[key].leads++
    }
    const topPages = Object.entries(pageMap)
      .sort((a, b) => b[1].sessions - a[1].sessions)
      .slice(0, 10)
      .map(([pageUrl, stats]) => ({ pageUrl, ...stats }))

    // Top referrers — same shape and bound as topPages. "(direct)" is the
    // honest label for an empty referrer: the visitor typed the URL, came from
    // an app, or the referrer policy stripped it — none of which is "unknown page".
    const refMap: Record<string, { sessions: number; leads: number }> = {}
    for (const r of wRows) {
      const key = typeof r.referrer === "string" && r.referrer.trim() ? r.referrer.trim() : "(direct)"
      if (!refMap[key]) refMap[key] = { sessions: 0, leads: 0 }
      refMap[key].sessions++
      if (r.contact_id) refMap[key].leads++
    }
    const topReferrers = Object.entries(refMap)
      .sort((a, b) => b[1].sessions - a[1].sessions)
      .slice(0, 10)
      .map(([referrer, stats]) => ({ referrer, ...stats }))

    // Device split — buckets only; the UA string is consumed here and dropped.
    const devices = { mobile: 0, desktop: 0, bot: 0, unknown: 0 }
    for (const r of wRows) devices[classifyUserAgent(r.user_agent)]++

    // Sessions by twin (see EmbedAnalytics.byTwin for why this is a label, not a link).
    const twinMap: Record<string, { twinId: string | null; label: string; sessions: number }> = {}
    for (const r of wRows) {
      const ref = typeof r.did_session_ref === "string" && r.did_session_ref ? r.did_session_ref : null
      const twin = ref ? twinByRef.get(ref) : undefined
      const key = twin ? twin.id : ref ? `unresolved:${ref}` : "none"
      if (!twinMap[key]) {
        twinMap[key] = {
          twinId: twin?.id ?? null,
          label: twin ? twin.label : ref ? "(twin no longer in this brokerage)" : "(no twin recorded)",
          sessions: 0,
        }
      }
      twinMap[key].sessions++
    }
    const byTwin = Object.values(twinMap).sort((a, b) => b.sessions - a.sessions)

    // By day (last N days)
    const dayMap: Record<string, { sessions: number; leads: number }> = {}
    for (const r of wRows) {
      const date = (r.started_at as string).slice(0, 10)
      if (!dayMap[date]) dayMap[date] = { sessions: 0, leads: 0 }
      dayMap[date].sessions++
      if (r.contact_id) dayMap[date].leads++
    }
    const byDay = Object.entries(dayMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, stats]) => ({ date, ...stats }))

    // Returning visitors — visitor_id is stamped on every session row by the
    // session writer; more than one session in the window = they came back.
    const byVisitor: Record<string, number> = {}
    for (const r of wRows) {
      if (r.visitor_id) byVisitor[r.visitor_id] = (byVisitor[r.visitor_id] ?? 0) + 1
    }
    const uniqueVisitors = Object.keys(byVisitor).length
    const returningVisitors = Object.values(byVisitor).filter((n) => n > 1).length

    return {
      widgetId: wid,
      totalSessions: total,
      totalLeads: leads,
      conversionRate: total > 0 ? Math.round((leads / total) * 1000) / 10 : 0,
      uniqueVisitors,
      returningVisitors,
      topPages,
      topReferrers,
      devices,
      byTwin,
      byDay,
    }
  })

  return { ok: true, analytics }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sanitizeDomains(input: string[]): string[] {
  return input
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      // Accept "example.com", "https://example.com", "https://example.com/" — output https://example.com (no trailing slash)
      let domain = d
      if (!/^https?:\/\//.test(domain)) domain = "https://" + domain
      try {
        const u = new URL(domain)
        return `${u.protocol}//${u.host}`
      } catch {
        return d
      }
    })
}
