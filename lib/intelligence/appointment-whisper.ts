// lib/intelligence/appointment-whisper.ts
//
// THE WHISPER — the hallway briefing, productized. 30 minutes before any client
// appointment, the eleven managers each contribute what they know about that person —
// propensity reasons, saved homes, the latest manager-to-manager talk, the vendor visit
// next week — synthesized into a ≤60-second brief delivered to the agent's phone IN THE
// USER'S CONFIGURED ASSISTANT VOICE (voice_assistant_config → agent_voice_profiles
// elevenlabs voice id — never a hardcoded voice, never the client-facing clone).
//
// EVERY TIER gets the AUDIO whisper (solo agents are not second-class — the assistant
// voice is part of the product on every subscription). Text is strictly the FALLBACK:
// it appears only when the user hasn't configured an assistant voice yet or synthesis
// is unavailable — never as a tier downgrade.
// The synthesizer is an injectable vendor seam (like the dial executor) — tests never
// spend TTS credits; the brief content is REAL either way.

import { createServiceClient } from "@/lib/supabase/service"
import type { UserTier } from "@/lib/kernel/0.1-feature-access"

type Svc = ReturnType<typeof createServiceClient>

/** Tier capability — AUDIO on EVERY tier (solo included); "text" is never returned by
 *  tier. Text happens downstream only as the no-voice-configured / synth-down fallback. */
export function whisperTierCapability(tier: UserTier): "audio" | "text" {
  void tier
  return "audio"
}

export interface WhisperFacts {
  contactName: string
  appointmentTitle: string | null
  minutesUntil: number
  propensityReasons: string[]
  savedHomes: number
  latestSave: string | null
  managerTalk: string[]      // recent inter-manager lines about this contact
  upcomingVendorVisit: string | null
}

/** Pure: the spoken brief — short sentences, ≤60s read aloud, no fabricated facts
 *  (sections appear only when the manager actually knows something). */
export function buildWhisperScript(f: WhisperFacts): string {
  const parts: string[] = []
  parts.push(`Heads up — ${f.contactName} in ${f.minutesUntil} minutes${f.appointmentTitle ? ` for ${f.appointmentTitle}` : ""}.`)
  if (f.propensityReasons.length > 0) parts.push(`The team reads them as likely to move: ${f.propensityReasons.slice(0, 2).join(", ")}.`)
  if (f.savedHomes > 0) parts.push(`They've saved ${f.savedHomes} home${f.savedHomes === 1 ? "" : "s"}${f.latestSave ? `, most recently ${f.latestSave}` : ""}.`)
  for (const line of f.managerTalk.slice(0, 2)) parts.push(line)
  if (f.upcomingVendorVisit) parts.push(`Also: ${f.upcomingVendorVisit}.`)
  parts.push(`Go get them.`)
  return parts.join(" ")
}

/** The user's ASSISTANT voice — voice_assistant_config.voice_profile_id →
 *  agent_voice_profiles.elevenlabs_voice_id. Null when unconfigured (text fallback). */
export async function resolveAssistantVoiceId(supabase: Svc, agentUserId: string): Promise<string | null> {
  // IDENTITY CLASS (m365). voice_assistant_config.agent_id FKs AGENTS (and is
  // NOT NULL, so every row holds a real agents id) while agentUserId is a users
  // id — the filter matched nothing, resolveAssistantVoiceId returned null on
  // every call, and the whisper silently fell back to text. The agent's cloned
  // voice was configured and never used.
  const { data: whisperAgentRow } = await supabase
    .from("agents").select("id").eq("user_id", agentUserId).maybeSingle()
  const whisperAgentId = (whisperAgentRow as { id?: string } | null)?.id ?? null
  if (!whisperAgentId) return null
  const { data: cfg } = await supabase
    .from("voice_assistant_config").select("voice_profile_id").eq("agent_id", whisperAgentId).maybeSingle()
  const profileId = (cfg as { voice_profile_id: string | null } | null)?.voice_profile_id ?? null
  if (!profileId) return null
  const { data: vp } = await supabase
    .from("agent_voice_profiles").select("elevenlabs_voice_id").eq("id", profileId).maybeSingle()
  return (vp as { elevenlabs_voice_id: string | null } | null)?.elevenlabs_voice_id ?? null
}

/** Vendor seam: synthesize the brief → audio URL (or null → text fallback). */
export type WhisperSynthesizer = (script: string, voiceId: string) => Promise<string | null>

const realSynthesizer: WhisperSynthesizer = async (script, voiceId) => {
  try {
    const { synthesizeSpeechStream } = await import("@/lib/voice/elevenlabs-tts")
    const res = await synthesizeSpeechStream({ text: script, voiceId })
    return (res as { audioUrl?: string | null })?.audioUrl ?? null
  } catch { return null }
}

export interface WhisperRunResult { whispers: number; audio: number; text: number }

/**
 * Produce whispers for appointments starting in [25, 40] minutes. Idempotent per
 * calendar event (one whisper notification per event). AUDIO on every tier;
 * audio requires the user's configured assistant voice AND working synthesis —
 * otherwise the same brief lands as text (never silently nothing).
 */
export async function produceAppointmentWhispers(
  brokerageId: string,
  opts: { now?: Date; synthesizer?: WhisperSynthesizer } = {},
  client?: Svc,
): Promise<WhisperRunResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const synthesizer = opts.synthesizer ?? realSynthesizer
  const from = new Date(now.getTime() + 25 * 60_000).toISOString()
  const to = new Date(now.getTime() + 40 * 60_000).toISOString()

  const { data: events } = await supabase
    .from("calendar_events")
    .select("id, entity_type, entity_id, event_type, start_at, title, agent_user_id")
    .eq("brokerage_id", brokerageId)
    .eq("entity_type", "contact")
    .gte("start_at", from).lte("start_at", to)
    .limit(50)

  let whispers = 0, audio = 0, text = 0
  for (const ev of (events ?? []) as any[]) {
    if (!ev.agent_user_id || !ev.entity_id) continue
    // Idempotency — one whisper per event.
    const { data: already } = await supabase.from("notifications").select("id")
      .eq("user_id", ev.agent_user_id).eq("type", "whisper_brief").eq("entity_id", ev.id).limit(1).maybeSingle()
    if (already) continue

    // Gather what the team knows — every fact from a real table, nothing fabricated.
    const [{ data: contact }, { data: saves }, { data: talk }, { data: vendor }, { data: usr }] = await Promise.all([
      supabase.from("contacts").select("first_name, last_name, intent_score, engagement_score, equity_estimate, referral_score, last_life_event_detected, updated_at").eq("id", ev.entity_id).maybeSingle(),
      supabase.from("saved_properties").select("property_address, saved_at").eq("contact_id", ev.entity_id).eq("dismissed", false).order("saved_at", { ascending: false }).limit(5),
      supabase.from("manager_signals").select("message").eq("contact_id", ev.entity_id).order("created_at", { ascending: false }).limit(2),
      supabase.from("vendor_bookings").select("service_type, scheduled_date").eq("contact_id", ev.entity_id).gte("scheduled_date", now.toISOString().slice(0, 10)).order("scheduled_date", { ascending: true }).limit(1).maybeSingle(),
      supabase.from("users").select("user_type, brokerage_id, team_id").eq("id", ev.agent_user_id).maybeSingle(),
    ])
    if (!contact) continue

    const { computeTransactionPropensity } = await import("@/lib/ai-isa/transaction-propensity")
    const daysSince = (iso: string | null) => (iso ? Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000) : null)
    const prop = computeTransactionPropensity({
      intentScore: (contact as any).intent_score, engagementScore: (contact as any).engagement_score,
      equityEstimate: (contact as any).equity_estimate, referralScore: (contact as any).referral_score,
      lifeEventDaysAgo: daysSince((contact as any).last_life_event_detected),
      lastActivityDaysAgo: daysSince((contact as any).updated_at),
    })
    const saveRows = (saves ?? []) as Array<{ property_address: string | null }>
    const facts: WhisperFacts = {
      contactName: [(contact as any).first_name, (contact as any).last_name].filter(Boolean).join(" ").trim() || "your client",
      appointmentTitle: ev.title ?? null,
      minutesUntil: Math.max(1, Math.round((new Date(ev.start_at).getTime() - now.getTime()) / 60_000)),
      propensityReasons: prop.topReasons,
      savedHomes: saveRows.length,
      latestSave: saveRows[0]?.property_address ?? null,
      managerTalk: ((talk ?? []) as Array<{ message: string }>).map((t) => t.message),
      upcomingVendorVisit: vendor ? `their ${(vendor as any).service_type ?? "vendor"} visit is scheduled ${(vendor as any).scheduled_date}` : null,
    }
    const script = buildWhisperScript(facts)

    // Audio on every tier; the assistant voice comes from THE USER'S SETTINGS.
    const { mapUserTypeToTier } = await import("@/lib/kernel/0.1-feature-access")
    const tier = mapUserTypeToTier((usr as any)?.user_type ?? "agent", (usr as any)?.brokerage_id ?? undefined, (usr as any)?.team_id ?? undefined)
    let audioUrl: string | null = null
    if (whisperTierCapability(tier) === "audio") {
      const voiceId = await resolveAssistantVoiceId(supabase, ev.agent_user_id)
      if (voiceId) audioUrl = await synthesizer(script, voiceId)
    }

    const { error } = await supabase.from("notifications").insert({
      user_id: ev.agent_user_id, brokerage_id: brokerageId, type: "whisper_brief",
      title: `🎧 Whisper: ${facts.contactName} in ${facts.minutesUntil} min`,
      body: audioUrl ? `${script}\n\n▶ Listen: ${audioUrl}` : script,
      entity_type: "calendar_event", entity_id: ev.id, priority: "high", is_read: false,
    })
    if (!error) { whispers += 1; if (audioUrl) audio += 1; else text += 1 }
  }
  return { whispers, audio, text }
}
