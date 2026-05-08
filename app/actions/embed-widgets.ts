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
