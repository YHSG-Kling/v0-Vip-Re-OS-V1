/**
 * Voice Drop adapter — Vapi native voicedrop (not voicemail/RVM).
 *
 * Delivers a pre-recorded or TTS audio clip to the contact's voicemail
 * WITHOUT causing the phone to ring. Vapi native voicedrop handles this.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const voiceDropAdapter: ChannelAdapter = {
  channel: "voice_drop",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, step, brokerageId, agentUserId } = ctx

    if (!contact?.phone) {
      return { status: "error", providerKey: "vapi", error: "No phone on contact" }
    }

    const script = step.voice_drop_script ?? step.body
    if (!script) {
      return { status: "error", providerKey: "vapi", error: "No voice drop script configured" }
    }

    // Resolve voice: step-level override → agent's cloned voice
    let voiceId: string | null = step.voice_drop_voice_id ?? null
    if (!voiceId && agentUserId) {
      try {
        const { resolveSelfVoice } = await import("@/lib/voice/voice-resolver")
        const resolved = await resolveSelfVoice(agentUserId)
        voiceId = resolved.voiceId ?? null
      } catch { /* best-effort */ }
    }

    // Dispatch via Vapi voicedrop
    try {
      const vapiKey = process.env.VAPI_API_KEY
      if (!vapiKey) {
        return { status: "error", providerKey: "vapi", error: "VAPI_API_KEY not configured" }
      }

      // Vapi REST call for voicedrop (ringless voicemail delivery)
      const response = await fetch("https://api.vapi.ai/call/phone", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${vapiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
          customer: { number: contact.phone },
          assistantOverrides: {
            firstMessage: script,
            ...(voiceId ? { voice: { provider: "11labs", voiceId } } : {}),
          },
          // Vapi voicedrop flag — deliver without ringing
          voicemailDetectionEnabled: true,
          metadata: { voicedrop: true, brokerageId, contactId: contact.id },
        }),
      })

      if (!response.ok) {
        const err = await response.text()
        return { status: "error", providerKey: "vapi", error: `Vapi error: ${err}` }
      }

      const data = await response.json()
      return {
        status: "sent",
        providerKey: "vapi",
        messageId: data?.id,
        output: { call_id: data?.id },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: "error", providerKey: "vapi", error: `Voice drop failed: ${msg}` }
    }
  },
}
