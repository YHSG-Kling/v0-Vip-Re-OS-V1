/**
 * Voice Drop adapter — CONSOLIDATED onto the canonical voicedrop rail
 * (lib/voicedrop/orchestrate-voicedrop-send: provider-configurable via
 * VOICEDROP_PROVIDER through the connector gateway, TCPA + compliance
 * gated, preset-based with a situational script override).
 *
 * DRIFT KILLED (2026-07 omnichannel audit): this adapter previously
 * called the RAW Vapi API — a provider the platform decommissioned
 * (Twilio-native voice lane) — so any sequence voice_drop step rode a
 * dead vendor while the real rail sat beside it. Now the step's
 * generated, persona-grounded script (ai_intent → body) is the
 * scriptOverride on the brokerage's ACTIVE voicedrop preset; no active
 * preset = an honest error the executor records (the deferral/skip
 * ledger says why), never a fake send.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const voiceDropAdapter: ChannelAdapter = {
  channel: "voice_drop",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, step, brokerageId, agentUserId } = ctx

    if (!contact?.phone) {
      return { status: "error", providerKey: "voicedrop", error: "No phone on contact" }
    }
    const script = (step.voice_drop_script as string | null) ?? (step.body as string | null)
    if (!script) {
      return { status: "error", providerKey: "voicedrop", error: "No voice drop script configured" }
    }

    // The brokerage's ACTIVE voicedrop preset — the canonical rail requires
    // one (it carries the synthesized-voice + provider config).
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data: preset } = await svc.from("voicedrop_presets")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!preset) {
      return { status: "error", providerKey: "voicedrop", error: "No active voicedrop preset for this brokerage — configure one in settings" }
    }

    const { orchestrateVoicedropSend } = await import("@/lib/voicedrop/orchestrate-voicedrop-send")
    const result = await orchestrateVoicedropSend({
      brokerageId,
      presetId: (preset as { id: string }).id,
      contactId: contact.id,
      toPhone: contact.phone,
      recipientFirstName: (contact as { first_name?: string | null }).first_name ?? null,
      agentUserId: agentUserId ?? null,
      systemSource: "sequence",
      scriptOverride: script,
    })

    if (!result.success) {
      return { status: "error", providerKey: result.providerKey ?? "voicedrop", error: result.error ?? "voicedrop failed" }
    }
    return { status: "sent", providerKey: result.providerKey ?? "voicedrop" }
  },
}
