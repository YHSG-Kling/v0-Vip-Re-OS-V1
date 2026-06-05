/**
 * lib/email/orchestrate-email-preset-send.ts
 *
 * Wave 37 — email preset dispatcher. Loads a locked email_presets
 * row, resolves the brokerage brand context for sender attribution,
 * and fires through the canonical dispatchEmail egress (which still
 * applies TCPA / suppression / per-channel opt-out gates per piece
 * at dispatch time — the locked preset only skips the AI redraft
 * gate, not the consent gates).
 *
 * Variable interpolation: subject + body_html + body_text support
 * {{first_name}} / {{last_name}} / {{agent_name}} / {{brokerage_name}}
 * substitution. The compliance gate ran at save time against the
 * UN-interpolated template; recipient names + agent context don't
 * change the Fair Housing posture of the body so we don't re-gate
 * per send.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchEmail } from "@/lib/providers/dispatch"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"

export interface OrchestrateEmailPresetSendArgs {
  brokerageId: string
  presetId:    string
  /** Recipient identifiers — at least one required. */
  contactId?:  string
  leadId?:     string
  toEmail:     string
  recipientFirstName?: string | null
  recipientLastName?:  string | null
  /** Brand cascade for sender + reply-to. */
  teamId?:      string | null
  agentUserId?: string | null
  systemSource?: string
}

export interface OrchestrateEmailPresetSendResult {
  success:        boolean
  providerKey?:   string
  messageId?:     string
  presetName?:    string
  error?:         string
}

interface PresetRow {
  id: string
  brokerage_id: string
  name: string
  subject: string
  body_html: string
  body_text: string | null
  from_name_override: string | null
  reply_to_override: string | null
  channel_purpose: "conversation" | "campaign" | "update" | "transactional" | null
  is_active: boolean
}

function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(/{{\s*([\w_]+)\s*}}/g, (_, key) => vars[key] ?? "")
}

export async function orchestrateEmailPresetSend(
  args: OrchestrateEmailPresetSendArgs,
): Promise<OrchestrateEmailPresetSendResult> {
  const svc = createServiceClient()

  const { data: presetData } = await svc
    .from("email_presets")
    .select("id, brokerage_id, name, subject, body_html, body_text, from_name_override, reply_to_override, channel_purpose, is_active")
    .eq("id", args.presetId)
    .maybeSingle()
  const preset = presetData as PresetRow | null
  if (!preset) return { success: false, error: "preset_not_found" }
  if (preset.brokerage_id !== args.brokerageId) return { success: false, error: "tenant_mismatch", presetName: preset.name }
  if (!preset.is_active) return { success: false, error: "preset_deactivated", presetName: preset.name }

  const brand = await resolveBrandContext({
    brokerageId: args.brokerageId,
    teamId:      args.teamId ?? null,
    agentUserId: args.agentUserId ?? null,
  })

  const fromName = preset.from_name_override?.trim()
    || brand.agentName
    || brand.displayName
    || brand.brokerageName
  const fromEmail = process.env.OUTBOUND_EMAIL_FROM ?? "noreply@vipre.io"
  // NOTE: preset.reply_to_override is NOT yet applied. DispatchEmailParams
  // has no replyTo field — the address is fully derived from `from`.
  // Wiring reply-to through the dispatch surface is a follow-up that
  // touches lib/providers/dispatch.ts + every assembler downstream;
  // until that lands the preset column is informational only.

  const vars: Record<string, string> = {
    first_name:     args.recipientFirstName ?? "",
    last_name:      args.recipientLastName ?? "",
    agent_name:     brand.agentName ?? brand.displayName,
    brokerage_name: brand.brokerageName,
  }

  const subject = interpolate(preset.subject, vars)
  const html    = interpolate(preset.body_html, vars)
  const text    = preset.body_text ? interpolate(preset.body_text, vars) : undefined

  const dispatch = await dispatchEmail({
    brokerageId: args.brokerageId,
    contactId:   args.contactId,
    leadId:      args.leadId,
    from:        `${fromName} <${fromEmail}>`,
    to:          args.toEmail,
    subject,
    html,
    text,
    channelPurpose: preset.channel_purpose ?? "campaign",
    systemSource:   args.systemSource ?? "email_preset",
    metadata: {
      preset_id:   preset.id,
      preset_name: preset.name,
    },
  })

  return {
    success:     dispatch.success,
    providerKey: dispatch.providerKey,
    messageId:   dispatch.messageId,
    presetName:  preset.name,
    error:       dispatch.error,
  }
}
