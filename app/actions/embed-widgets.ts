"use server"

/**
 * Server actions for the Embed Widget settings page.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

export interface EmbedWidget {
  id: string
  publicId: string
  brokerageId: string
  agentId: string | null
  teamId: string | null
  label: string
  defaultTwinId: string | null
  welcomeMessage: string | null
  enabledModes: ("text" | "live")[]
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
    enabledModes: (r.enabled_modes ?? ["text"]) as ("text" | "live")[],
    leadCaptureMode: r.lead_capture_mode,
    leadCaptureFields: r.lead_capture_fields ?? [],
    allowedDomains: r.allowed_domains ?? [],
    routingMode: (r.routing_mode ?? "primary") as "primary" | "round_robin",
    style: r.style ?? {},
    isActive: !!r.is_active,
    createdAt: r.created_at,
  }
}

const ADMIN_ROLES = ["broker", "admin", "superadmin", "team_lead"]

export async function listMyEmbeds(): Promise<{ widgets: EmbedWidget[]; canCreateBrokerageWide: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { widgets: [], canCreateBrokerageWide: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const canCreateBrokerageWide = ADMIN_ROLES.includes(ctx.userType)

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

export async function createEmbed(params: {
  label: string
  scope: "personal" | "brokerage"
  defaultTwinId?: string | null
}): Promise<{ ok: boolean; widget?: EmbedWidget; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }

  if (params.scope === "brokerage" && !ADMIN_ROLES.includes(ctx.userType)) {
    return { ok: false, error: "Only brokers / admins can create brokerage-wide embeds" }
  }

  const supabase = createServiceClient()

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
  enabledModes?: ("text" | "live")[]
  leadCaptureMode?: "immediate" | "after_first_message" | "optional"
  leadCaptureFields?: string[]
  allowedDomains?: string[]
  routingMode?: "primary" | "round_robin"
  style?: Record<string, any>
  isActive?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }

  const supabase = createServiceClient()

  const { data: existing } = await supabase
    .from("embed_widgets")
    .select("id, brokerage_id, agent_id")
    .eq("id", params.id)
    .maybeSingle()
  if (!existing) return { ok: false, error: "Embed not found" }
  if (existing.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Forbidden" }

  // Brokerage-wide embeds (agent_id NULL) only editable by admin roles.
  if (existing.agent_id === null && !ADMIN_ROLES.includes(ctx.userType)) {
    return { ok: false, error: "Forbidden" }
  }
  // Personal embeds editable only by their owner.
  if (existing.agent_id !== null && existing.agent_id !== ctx.agentId && !ADMIN_ROLES.includes(ctx.userType)) {
    return { ok: false, error: "Forbidden" }
  }

  const update: Record<string, any> = { updated_at: new Date().toISOString() }
  if (params.label !== undefined) update.label = params.label.slice(0, 64)
  if (params.defaultTwinId !== undefined) update.default_twin_id = params.defaultTwinId
  if (params.welcomeMessage !== undefined) update.welcome_message = params.welcomeMessage
  if (params.enabledModes !== undefined) update.enabled_modes = params.enabledModes
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
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const { data: existing } = await supabase
    .from("embed_widgets")
    .select("brokerage_id, agent_id")
    .eq("id", id)
    .maybeSingle()
  if (!existing) return { ok: false, error: "Not found" }
  if (existing.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Forbidden" }
  if (existing.agent_id === null && !ADMIN_ROLES.includes(ctx.userType)) return { ok: false, error: "Forbidden" }
  if (existing.agent_id !== null && existing.agent_id !== ctx.agentId && !ADMIN_ROLES.includes(ctx.userType)) {
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
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { twins: [] }
  const supabase = createServiceClient()

  const query = supabase
    .from("agent_avatar_assets")
    .select("id, label, agent_id, agents:agent_id(full_name)")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("status", "ready")
    .eq("approval_status", "approved")
    .order("is_default", { ascending: false })

  if (scope === "personal" && ctx.agentId) {
    query.eq("agent_id", ctx.agentId)
  }

  const { data } = await query
  return {
    twins: (data ?? []).map((t: any) => ({
      id: t.id,
      label: t.label,
      agentName: t.agents?.full_name ?? null,
    })),
  }
}

// ─── Analytics ───────────────────────────────────────────────────────────

export interface EmbedAnalytics {
  widgetId: string
  totalSessions: number
  totalLeads: number
  conversionRate: number
  topPages: { pageUrl: string; sessions: number; leads: number }[]
  byDay: { date: string; sessions: number; leads: number }[]
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
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const days = params.days ?? 30
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const isAdmin = ADMIN_ROLES.includes(ctx.userType)

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

  // Pull sessions in the window
  const { data: sessions } = await supabase
    .from("embed_sessions")
    .select("id, embed_widget_id, contact_id, origin, started_at")
    .in("embed_widget_id", widgetIds)
    .gte("started_at", since)
    .order("started_at", { ascending: false })

  const rows = sessions ?? []

  const analytics: EmbedAnalytics[] = widgetIds.map((wid) => {
    const wRows = rows.filter((r: any) => r.embed_widget_id === wid)
    const total = wRows.length
    const leads = wRows.filter((r: any) => !!r.contact_id).length

    // Top pages (by session count, top 10)
    const pageMap: Record<string, { sessions: number; leads: number }> = {}
    for (const r of wRows) {
      const key = r.origin ?? "(unknown)"
      if (!pageMap[key]) pageMap[key] = { sessions: 0, leads: 0 }
      pageMap[key].sessions++
      if (r.contact_id) pageMap[key].leads++
    }
    const topPages = Object.entries(pageMap)
      .sort((a, b) => b[1].sessions - a[1].sessions)
      .slice(0, 10)
      .map(([pageUrl, stats]) => ({ pageUrl, ...stats }))

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

    return {
      widgetId: wid,
      totalSessions: total,
      totalLeads: leads,
      conversionRate: total > 0 ? Math.round((leads / total) * 1000) / 10 : 0,
      topPages,
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
