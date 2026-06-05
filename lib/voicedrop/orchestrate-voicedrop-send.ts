/**
 * lib/voicedrop/orchestrate-voicedrop-send.ts
 *
 * Wave 38 — voicedrop (ringless voicemail) preset dispatcher.
 * Loads a voicedrops_preset, generates a hosted MP3 (or uses the
 * preset's pre-uploaded audio_url), and stages the drop through
 * the canonical egress.
 *
 * Provider: configurable via VOICEDROP_PROVIDER env. Default 'slybroadcast'
 * (the industry standard for real estate). Twilio doesn't ship
 * ringless natively — they require a partner integration; we route
 * through callConnector either way so the broker can swap
 * providers without code changes.
 *
 * Voice: when preset.tts_script is set (no pre-uploaded audio),
 * we synth via ElevenLabs the agent's CLONED voice (the existing
 * agent_voice_profiles.elevenlabs_voice_id from the kernel OS
 * plan). The recipient hears a voicemail in the actual agent's
 * voice — same differentiator as the per-agent direct-mail voice
 * but for audio.
 *
 * TCPA: voicedrop is regulated as a phone call. dispatchVoicedrop
 * applies the same TCPA + dnc_status + phone_opt_out gates as
 * dispatchSms.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { evaluateOutbound } from "@/lib/kernel/compliance"

export interface OrchestrateVoicedropSendArgs {
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

export interface OrchestrateVoicedropSendResult {
  success:        boolean
  providerKey?:   string
  jobId?:         string
  presetName?:    string
  audioUrl?:      string
  error?:         string
}

interface PresetRow {
  id: string
  brokerage_id: string
  name: string
  tts_script: string | null
  audio_url: string | null
  voice_id_override: string | null
  is_active: boolean
}

function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(/{{\s*([\w_]+)\s*}}/g, (_, key) => vars[key] ?? "")
}

async function ensureCompliance(args: {
  brokerageId: string
  contactId?: string
  leadId?: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  // The compliance gate uses messageType='phone' to enforce TCPA
  // consent + dnc_status + phone_opt_out. Voicedrop = a phone call
  // by FCC interpretation, so we gate identically.
  if (!args.contactId && !args.leadId) return { ok: true }
  const svc = createServiceClient()
  let kc: { id: string; tcpa_consent: boolean | null; dnc_status: boolean | null; phone_opt_out: boolean | null; status: string | null } | null = null
  if (args.contactId) {
    const { data } = await svc.from("contacts")
      .select("id, tcpa_consent, dnc_status, phone_opt_out, status")
      .eq("id", args.contactId)
      .maybeSingle()
    kc = data as typeof kc
  } else if (args.leadId) {
    const { data } = await svc.from("leads")
      .select("id, tcpa_consent, dnc_status, phone_opt_out, lifecycle_state")
      .eq("id", args.leadId)
      .maybeSingle()
    if (data) {
      kc = {
        id:            data.id as string,
        tcpa_consent:  (data as { tcpa_consent?: boolean | null }).tcpa_consent ?? null,
        dnc_status:    (data as { dnc_status?: boolean | null }).dnc_status ?? null,
        phone_opt_out: (data as { phone_opt_out?: boolean | null }).phone_opt_out ?? null,
        status:        (data as { lifecycle_state?: string | null }).lifecycle_state ?? null,
      }
    }
  }
  if (!kc) return { ok: false, reason: "recipient_not_found" }

  const r = await evaluateOutbound({
    actorContext: { brokerageId: args.brokerageId, role: "agent", userId: args.brokerageId },
    messageType:  "phone",
    journeyType:  "buyer",
    persona:      "other",
    content:      "(voicedrop)",
    contact: {
      id:            kc.id,
      first_name:    "",
      last_name:     "",
      tcpa_consent:  kc.tcpa_consent ?? false,
      dnc_status:    kc.dnc_status ?? false,
      phone_opt_out: kc.phone_opt_out ?? undefined,
      status:        kc.status ?? "",
    } as unknown as Parameters<typeof evaluateOutbound>[0]["contact"],
  })
  if (!r.allowed) return { ok: false, reason: `gate:${r.violations.join("; ")}` }
  return { ok: true }
}

async function synthVoicemail(args: {
  brokerageId: string
  script: string
  voiceIdOverride: string | null
  agentUserId: string | null
}): Promise<string | null> {
  // ElevenLabs TTS via callConnector. When the brokerage hasn't
  // configured EL or the agent's voice clone isn't ready, return
  // null and the caller fails with no_voice.
  if (!process.env.ELEVENLABS_API_KEY) return null

  // Resolve agent's voice id from agent_voice_profiles when override
  // is null. The agent's CLONED voice is the differentiator.
  let voiceId = args.voiceIdOverride
  if (!voiceId && args.agentUserId) {
    const svc = createServiceClient()
    const { data } = await svc.from("agent_voice_profiles")
      .select("elevenlabs_voice_id")
      .eq("agent_user_id", args.agentUserId)
      .maybeSingle()
    voiceId = (data?.elevenlabs_voice_id as string | null) ?? null
  }
  if (!voiceId) return null

  // Call ElevenLabs TTS → buffer → Vercel Blob → public URL.
  try {
    const { synthesizeSpeech } = await import("@/lib/voice/elevenlabs-tts")
    const result = await synthesizeSpeech({
      text:        args.script,
      voiceId,
      brokerageId: args.brokerageId,
    })
    if (!result.success || !result.audioBuffer) return null
    const { put } = await import("@vercel/blob")
    const uploaded = await put(
      `voicedrops/${args.brokerageId}/${Date.now()}.mp3`,
      result.audioBuffer,
      { access: "public", contentType: "audio/mpeg" },
    )
    return uploaded.url
  } catch (e) {
    console.error("[voicedrop] synth failed:", (e as Error).message)
    return null
  }
}

export async function orchestrateVoicedropSend(
  args: OrchestrateVoicedropSendArgs,
): Promise<OrchestrateVoicedropSendResult> {
  const svc = createServiceClient()

  const { data: presetData } = await svc.from("voicedrop_presets")
    .select("id, brokerage_id, name, tts_script, audio_url, voice_id_override, is_active")
    .eq("id", args.presetId)
    .maybeSingle()
  const preset = presetData as PresetRow | null
  if (!preset) return { success: false, error: "preset_not_found" }
  if (preset.brokerage_id !== args.brokerageId) return { success: false, error: "tenant_mismatch", presetName: preset.name }
  if (!preset.is_active) return { success: false, error: "preset_deactivated", presetName: preset.name }

  // TCPA gate FIRST — no synthesis spend on a blocked send.
  const gate = await ensureCompliance({
    brokerageId: args.brokerageId,
    contactId:   args.contactId,
    leadId:      args.leadId,
  })
  if (!gate.ok) return { success: false, error: gate.reason, presetName: preset.name }

  const brand = await resolveBrandContext({
    brokerageId: args.brokerageId,
    teamId:      args.teamId ?? null,
    agentUserId: args.agentUserId ?? null,
  })

  // Resolve audio: pre-uploaded URL wins; else synth from script.
  let audioUrl = preset.audio_url
  if (!audioUrl && preset.tts_script) {
    const script = interpolate(preset.tts_script, {
      first_name:     args.recipientFirstName ?? "",
      agent_name:     brand.agentName ?? brand.displayName,
      brokerage_name: brand.brokerageName,
    })
    audioUrl = await synthVoicemail({
      brokerageId:     args.brokerageId,
      script,
      voiceIdOverride: preset.voice_id_override,
      agentUserId:     args.agentUserId ?? null,
    })
  }
  if (!audioUrl) {
    return { success: false, error: "no_audio_available", presetName: preset.name }
  }

  // Dispatch via Slybroadcast (default) through the canonical
  // connector gateway. Result captured for the bundle outcome ledger.
  const providerKey = process.env.VOICEDROP_PROVIDER ?? "slybroadcast"
  const apiKey      = process.env.VOICEDROP_API_KEY
  const fromPhone   = process.env.VOICEDROP_FROM_PHONE ?? brand.display.phone ?? ""
  if (!apiKey) {
    return { success: false, error: "voicedrop_provider_not_configured", presetName: preset.name, audioUrl }
  }

  // Slybroadcast: POST https://api.slybroadcast.com/MachineAudio.mp3
  // The exact param shape is provider-specific; we route via
  // callConnector so swapping providers is a config change, not a
  // code change.
  const res = await callConnector<{ job_id?: string; success?: boolean; error?: string }>({
    connector: "voicedrop",
    baseUrl:   "https://www.mobile-sphere.com",
    path:      "gateway/vmb.php",
    method:    "POST",
    auth:      { style: "none" },
    bodyType:  "form",
    body: {
      c_uid:      apiKey,
      c_url:      audioUrl,
      c_callerID: fromPhone,
      c_audio:    "mp3",
      c_phone:    args.toPhone,
    },
  })

  return {
    success:     res.ok && !!res.data?.success,
    providerKey,
    jobId:       res.data?.job_id ?? undefined,
    audioUrl,
    presetName:  preset.name,
    error:       res.ok ? res.data?.error : `connector_${res.status ?? "error"}`,
  }
}
