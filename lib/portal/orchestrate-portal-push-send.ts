/**
 * lib/portal/orchestrate-portal-push-send.ts
 *
 * Wave 38 — portal push dispatcher. Loads a portal_push_presets row,
 * resolves the brand cascade, and inserts a client_portal_messages
 * row for the recipient contact. The existing portal stream
 * projector cron + the contact's portal UI pick it up automatically.
 *
 * Why not a channel-side send: the recipient ALREADY has a portal
 * session (they've been invited + activated); a push card here is
 * the equivalent of "leave a note inside their portal" — no
 * external egress, no TCPA concern. Just a tenant-gated write.
 *
 * Recipient must be a CONTACT with portal access (lead_id path is
 * not supported — leads don't have portal accounts yet).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"

export interface OrchestratePortalPushSendArgs {
  brokerageId: string
  presetId:    string
  contactId:   string
  teamId?:      string | null
  agentUserId?: string | null
  systemSource?: string
}

export interface OrchestratePortalPushSendResult {
  success:        boolean
  messageId?:     string
  presetName?:    string
  error?:         string
}

interface PresetRow {
  id: string
  brokerage_id: string
  name: string
  title: string
  body_md: string
  cta_url: string | null
  cta_label: string | null
  priority: "low" | "normal" | "high" | "urgent" | null
  is_active: boolean
}

function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(/{{\s*([\w_]+)\s*}}/g, (_, key) => vars[key] ?? "")
}

export async function orchestratePortalPushSend(
  args: OrchestratePortalPushSendArgs,
): Promise<OrchestratePortalPushSendResult> {
  const svc = createServiceClient()

  const { data: presetData } = await svc.from("portal_push_presets")
    .select("id, brokerage_id, name, title, body_md, cta_url, cta_label, priority, is_active")
    .eq("id", args.presetId)
    .maybeSingle()
  const preset = presetData as PresetRow | null
  if (!preset) return { success: false, error: "preset_not_found" }
  if (preset.brokerage_id !== args.brokerageId) return { success: false, error: "tenant_mismatch", presetName: preset.name }
  if (!preset.is_active) return { success: false, error: "preset_deactivated", presetName: preset.name }

  // Contact must be in tenant.
  const { data: contact } = await svc.from("contacts")
    .select("id, brokerage_id, first_name, last_name")
    .eq("id", args.contactId)
    .maybeSingle()
  const c = contact as { id: string; brokerage_id: string | null; first_name: string | null; last_name: string | null } | null
  if (!c) return { success: false, error: "contact_not_found", presetName: preset.name }
  if (c.brokerage_id !== args.brokerageId) return { success: false, error: "contact_tenant_mismatch", presetName: preset.name }

  const brand = await resolveBrandContext({
    brokerageId: args.brokerageId,
    teamId:      args.teamId ?? null,
    agentUserId: args.agentUserId ?? null,
  })

  const vars: Record<string, string> = {
    first_name:     c.first_name ?? "",
    last_name:      c.last_name ?? "",
    agent_name:     brand.agentName ?? brand.displayName,
    brokerage_name: brand.brokerageName,
  }

  // portal_event_stream is the canonical card surface — title +
  // body_md collapse into customer_copy (markdown); cta_url +
  // cta_label flow through metadata jsonb where the portal UI reads
  // them.
  const severityMap: Record<string, string> = {
    low: "info", normal: "info", high: "warning", urgent: "critical",
  }
  const customer_copy = `**${interpolate(preset.title, vars)}**\n\n${interpolate(preset.body_md, vars)}`
  const { data: msg, error } = await svc.from("portal_event_stream").insert({
    brokerage_id:    args.brokerageId,
    contact_id:      args.contactId,
    agent_user_id:   args.agentUserId ?? null,
    event_type:      "preset_push",
    customer_copy,
    customer_icon:   "bell",
    severity:        severityMap[preset.priority ?? "normal"] ?? "info",
    metadata:        {
      preset_id:   preset.id,
      preset_name: preset.name,
      cta_url:     preset.cta_url,
      cta_label:   preset.cta_label,
    },
    occurred_at:     new Date().toISOString(),
  } as Record<string, unknown>).select("id").single()
  if (error) return { success: false, error: error.message, presetName: preset.name }

  return { success: true, messageId: msg.id as string, presetName: preset.name }
}
