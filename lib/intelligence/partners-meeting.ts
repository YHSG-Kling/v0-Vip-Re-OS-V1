// lib/intelligence/partners-meeting.ts
//
// SUNDAY NIGHT PARTNERS' MEETING — the week, presented by your AI team. Every Sunday
// evening the eleven managers sit down with the broker the way human partners do: here's
// what we ran this week — the plays we called, the fires we put out, the briefings we
// whispered, the relationships we recovered, the deals we closed — and here's the ONE
// thing waiting on you (your approval queue).
//
// Delivered as a D-ID avatar video in the user's CONFIGURED assistant voice when their
// voice profile has a photo, as assistant-voice AUDIO when it has a voice but no photo,
// and as the written memo only when neither is configured — on EVERY tier (media is
// never a tier downgrade). Producer is an injectable vendor seam (no D-ID/TTS spend in
// tests); every number comes from a real table — nothing fabricated.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface WeekInBusiness {
  weekLabel: string
  teamPlays: number
  fireDrills: number
  whispers: number
  consentFallbacks: number
  withdrawnRespectfully: number
  handoffs: number
  dissents: number
  proposalsSent: number
  proposalsPending: number
  dealsClosed: number
}

/** Pure: the partners'-meeting script — spoken, warm, only lines the team actually
 *  earned (zero weeks don't get fabricated wins), always ends on the pending queue. */
export function composePartnersMeetingScript(w: WeekInBusiness, audienceName?: string | null): string {
  const parts: string[] = []
  parts.push(`${audienceName ? `${audienceName}, good` : "Good"} evening — your team, checking in on ${w.weekLabel}.`)
  if (w.dealsClosed > 0) parts.push(`We closed ${w.dealsClosed} deal${w.dealsClosed === 1 ? "" : "s"} this week.`)
  if (w.teamPlays > 0) parts.push(`The managers huddled and ran ${w.teamPlays} coordinated team play${w.teamPlays === 1 ? "" : "s"} instead of scattered touches.`)
  if (w.fireDrills > 0) parts.push(`We caught ${w.fireDrills} uncovered deadline${w.fireDrills === 1 ? "" : "s"} before ${w.fireDrills === 1 ? "it" : "they"} burned a deal — save plans went out the same hour.`)
  if (w.whispers > 0) parts.push(`${w.whispers} appointment briefing${w.whispers === 1 ? "" : "s"} whispered before you walked in.`)
  if (w.consentFallbacks > 0) parts.push(`${w.consentFallbacks} client${w.consentFallbacks === 1 ? "" : "s"} who opted out ${w.consentFallbacks === 1 ? "was" : "were"} acknowledged on the channel they still allow — relationship kept.`)
  if (w.withdrawnRespectfully > 0) parts.push(`${w.withdrawnRespectfully} relationship${w.withdrawnRespectfully === 1 ? "" : "s"} released respectfully after every recovery step came back empty.`)
  if (w.handoffs > 0) parts.push(`${w.handoffs} manager-to-manager handoff${w.handoffs === 1 ? "" : "s"} crossed the bus without you lifting a finger.`)
  if (w.dissents > 0) parts.push(`Quality control: peer review raised ${w.dissents} objection${w.dissents === 1 ? "" : "s"} before anything reached your desk.`)
  if (w.proposalsSent > 0) parts.push(`${w.proposalsSent} approved message${w.proposalsSent === 1 ? "" : "s"} went out to clients.`)
  parts.push(
    w.proposalsPending > 0
      ? `One thing waits on you: ${w.proposalsPending} proposal${w.proposalsPending === 1 ? "" : "s"} in the approval queue. Clear ${w.proposalsPending === 1 ? "it" : "them"} and the team rolls into Monday at full speed.`
      : `Your approval queue is clear — the team rolls into Monday at full speed.`,
  )
  return parts.join(" ")
}

/** Vendor seam: turn the script into media for one user. Returns null → written memo. */
export type MeetingProducer = (
  script: string, agentUserId: string,
) => Promise<{ kind: "video" | "audio"; url: string } | null>

const defaultProducer = (supabase: Svc, brokerageId: string): MeetingProducer => async (script, agentUserId) => {
  try {
    const { resolveAssistantVoiceId } = await import("@/lib/intelligence/appointment-whisper")
    const voiceId = await resolveAssistantVoiceId(supabase, agentUserId)
    if (!voiceId) return null
    // Avatar photo from the SAME configured profile (voice_assistant_config → profile).
    const { data: cfg } = await supabase.from("voice_assistant_config")
      .select("voice_profile_id").eq("agent_id", agentUserId).maybeSingle()
    let photo: string | null = null
    if ((cfg as any)?.voice_profile_id) {
      const { data: vp } = await supabase.from("agent_voice_profiles")
        .select("did_photo_url").eq("id", (cfg as any).voice_profile_id).maybeSingle()
      photo = (vp as any)?.did_photo_url ?? null
    }
    const { generateVideo } = await import("@/lib/did")
    const res = await generateVideo({
      script, voiceId, agentUserId, brokerageId,
      avatarImageUrl: photo, voiceOnly: !photo,
    })
    if (!res.videoUrl) return null
    return { kind: photo ? "video" : "audio", url: res.videoUrl }
  } catch { return null }
}

export interface PartnersMeetingResult { meetings: number; video: number; audio: number; memo: number }

/**
 * Produce this week's partners' meeting for the brokerage's leadership (admin/broker
 * users; falls back to the brokerage's agents when no leadership user exists). One
 * meeting per user per week (notification-keyed idempotency).
 */
export async function producePartnersMeeting(
  brokerageId: string,
  opts: { now?: Date; producer?: MeetingProducer } = {},
  client?: Svc,
): Promise<PartnersMeetingResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const producer = opts.producer ?? defaultProducer(supabase, brokerageId)
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()

  // ── The week, from the real tables ──
  const [plays, drills, whispers, fallbacks, withdraws, handoffs, dissents, sent, pending, closed] = await Promise.all([
    supabase.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).ilike("rationale", "TEAM PLAY%").gte("proposed_at", weekAgo),
    supabase.from("notifications").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("type", "fire_drill").gte("created_at", weekAgo),
    supabase.from("notifications").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("type", "whisper_brief").gte("created_at", weekAgo),
    supabase.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).ilike("rationale", "CONSENT RECOVERY%").gte("proposed_at", weekAgo),
    supabase.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("signal_type", "contact_withdrawn").eq("status", "consumed").gte("created_at", weekAgo),
    supabase.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("status", "consumed").gte("created_at", weekAgo),
    supabase.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).ilike("rationale", "%PEER REVIEW%DISSENTS%").gte("proposed_at", weekAgo),
    supabase.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("status", "sent").gte("sent_at", weekAgo),
    supabase.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("status", "proposed"),
    supabase.from("transactions").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("status", "closed").gte("updated_at", weekAgo),
  ])

  const weekStart = new Date(now.getTime() - 7 * 86_400_000)
  const week: WeekInBusiness = {
    weekLabel: `the week of ${weekStart.toISOString().slice(0, 10)}`,
    teamPlays: plays.count ?? 0,
    fireDrills: drills.count ?? 0,
    whispers: whispers.count ?? 0,
    consentFallbacks: fallbacks.count ?? 0,
    withdrawnRespectfully: withdraws.count ?? 0,
    handoffs: handoffs.count ?? 0,
    dissents: dissents.count ?? 0,
    proposalsSent: sent.count ?? 0,
    proposalsPending: pending.count ?? 0,
    dealsClosed: closed.count ?? 0,
  }

  // ── The partners: leadership first, agents as fallback ──
  const { data: leaders } = await supabase.from("users")
    .select("id, first_name").eq("brokerage_id", brokerageId).in("user_type", ["admin", "broker"]).limit(10)
  let audience = (leaders ?? []) as Array<{ id: string; first_name: string | null }>
  if (audience.length === 0) {
    const { data: agents } = await supabase.from("agents")
      .select("user_id").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(10)
    const ids = Array.from(new Set(((agents ?? []) as Array<{ user_id: string }>).map((a) => a.user_id)))
    if (ids.length > 0) {
      const { data: us } = await supabase.from("users").select("id, first_name").in("id", ids).limit(10)
      audience = (us ?? []) as Array<{ id: string; first_name: string | null }>
    }
  }

  let meetings = 0, video = 0, audio = 0, memo = 0
  for (const user of audience) {
    // One meeting per user per week.
    const { data: already } = await supabase.from("notifications").select("id")
      .eq("user_id", user.id).eq("type", "partners_meeting")
      .gte("created_at", new Date(now.getTime() - 6 * 86_400_000).toISOString())
      .limit(1).maybeSingle()
    if (already) continue

    const script = composePartnersMeetingScript(week, user.first_name)
    const media = await producer(script, user.id)
    const { error } = await supabase.from("notifications").insert({
      user_id: user.id, brokerage_id: brokerageId, type: "partners_meeting",
      title: `🗓 Partners' meeting — ${week.weekLabel}`,
      body: media ? `${script}\n\n▶ ${media.kind === "video" ? "Watch" : "Listen"}: ${media.url}` : script,
      priority: "medium", is_read: false,
    })
    if (error) continue
    meetings += 1
    if (media?.kind === "video") video += 1
    else if (media?.kind === "audio") audio += 1
    else memo += 1
  }

  return { meetings, video, audio, memo }
}
