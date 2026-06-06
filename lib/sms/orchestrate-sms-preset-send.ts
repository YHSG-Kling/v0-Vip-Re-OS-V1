/**
 * lib/sms/orchestrate-sms-preset-send.ts
 *
 * Wave 37 — SMS preset dispatcher. Same shape as the email preset
 * orchestrator: locked sms_presets.body, brand cascade, dispatchSms
 * for egress (which enforces TCPA + suppression + sms_opt_out at
 * dispatch time).
 *
 * TCPA important note: dispatchSms refuses sends to contacts without
 * verified tcpa_consent UNLESS active representation is detected. The
 * preset-save compliance gate doesn't authorize bypass — every SMS
 * send still re-checks consent at dispatch.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchSms } from "@/lib/providers/dispatch"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"

export interface OrchestrateSmsPresetSendArgs {
  brokerageId: string
  presetId:    string
  contactId?:  string
  leadId?:     string
  toPhone:     string
  recipientFirstName?: string | null
  teamId?:      string | null
  agentUserId?: string | null
  systemSource?: string
}

export interface OrchestrateSmsPresetSendResult {
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
  body: string
  is_active: boolean
}

function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(/{{\s*([\w_]+)\s*}}/g, (_, key) => vars[key] ?? "")
}

export async function orchestrateSmsPresetSend(
  args: OrchestrateSmsPresetSendArgs,
): Promise<OrchestrateSmsPresetSendResult> {
  const svc = createServiceClient()

  const { data: presetData } = await svc
    .from("sms_presets")
    .select("id, brokerage_id, name, body, is_active")
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

  const message = interpolate(preset.body, {
    first_name:     args.recipientFirstName ?? "",
    agent_name:     brand.agentName ?? brand.displayName,
    brokerage_name: brand.brokerageName,
  })

  const dispatch = await dispatchSms({
    brokerageId: args.brokerageId,
    contactId:   args.contactId,
    leadId:      args.leadId,
    to:          args.toPhone,
    message,
    systemSource: args.systemSource ?? "sms_preset",
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
