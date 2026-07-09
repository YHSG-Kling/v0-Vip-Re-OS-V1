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
import { dealCommission, toPipeline, forecastGci } from "@/lib/kernel/commission-forecaster"
import { summarizeComplianceLedger, PREFLIGHT_GATE } from "@/lib/kernel/compliance-ledger"

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
  /** Finance Manager's line: gross commission BOOKED from deals closed this week. */
  gciClosedThisWeek: number
  /** Probability-weighted gross commission still in the in-progress pipeline (Σ commission × win%). */
  gciWeightedPipeline: number
  /** Compliance Officer's line: outbound decisions pre-flighted this week. */
  complianceReviewed: number
  /** …of those, how many needed a Fair Housing / consent fix (advisory + blocked). */
  complianceAdvisories: number
  /** …and how many a human RELEASED over an open objection — the number a broker must defend. */
  complianceReleasedOverObjection: number
}

/** Speak a dollar figure the way a partner would ("$1.2M" / "$180K" / "$3,200"). */
function fmtUsd(n: number): string {
  const v = Math.round(Math.max(0, n))
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 10_000) return `$${Math.round(v / 1000)}K`
  return `$${v.toLocaleString("en-US")}`
}

/** Pure: the partners'-meeting script — spoken, warm, only lines the team actually
 *  earned (zero weeks don't get fabricated wins), always ends on the pending queue. */
export function composePartnersMeetingScript(w: WeekInBusiness, audienceName?: string | null): string {
  const parts: string[] = []
  parts.push(`${audienceName ? `${audienceName}, good` : "Good"} evening — your team, checking in on ${w.weekLabel}.`)
  if (w.dealsClosed > 0) parts.push(`We closed ${w.dealsClosed} deal${w.dealsClosed === 1 ? "" : "s"} this week.`)
  // Finance Manager's line — only the money the team actually earned/forecast (a dry week stays silent).
  if (w.gciClosedThisWeek > 0 || w.gciWeightedPipeline > 0) {
    const booked = w.gciClosedThisWeek > 0 ? `${fmtUsd(w.gciClosedThisWeek)} in gross commission booked this week` : `no commission booked this week`
    const pipeline = w.gciWeightedPipeline > 0 ? `, with ${fmtUsd(w.gciWeightedPipeline)} weighted in the pipeline` : ""
    parts.push(`Finance Manager: ${booked}${pipeline}.`)
  }
  if (w.teamPlays > 0) parts.push(`The managers huddled and ran ${w.teamPlays} coordinated team play${w.teamPlays === 1 ? "" : "s"} instead of scattered touches.`)
  if (w.fireDrills > 0) parts.push(`We caught ${w.fireDrills} uncovered deadline${w.fireDrills === 1 ? "" : "s"} before ${w.fireDrills === 1 ? "it" : "they"} burned a deal — save plans went out the same hour.`)
  if (w.whispers > 0) parts.push(`${w.whispers} appointment briefing${w.whispers === 1 ? "" : "s"} whispered before you walked in.`)
  if (w.consentFallbacks > 0) parts.push(`${w.consentFallbacks} client${w.consentFallbacks === 1 ? "" : "s"} who opted out ${w.consentFallbacks === 1 ? "was" : "were"} acknowledged on the channel they still allow — relationship kept.`)
  if (w.withdrawnRespectfully > 0) parts.push(`${w.withdrawnRespectfully} relationship${w.withdrawnRespectfully === 1 ? "" : "s"} released respectfully after every recovery step came back empty.`)
  if (w.handoffs > 0) parts.push(`${w.handoffs} manager-to-manager handoff${w.handoffs === 1 ? "" : "s"} crossed the bus without you lifting a finger.`)
  if (w.dissents > 0) parts.push(`Quality control: peer review raised ${w.dissents} objection${w.dissents === 1 ? "" : "s"} before anything reached your desk.`)
  if (w.complianceReviewed > 0) {
    const fixes = w.complianceAdvisories > 0
      ? ` ${w.complianceAdvisories} needed a Fair Housing or consent fix and ${w.complianceAdvisories === 1 ? "was" : "were"} flagged before release.`
      : ` Every one cleared Fair Housing and consent.`
    let line = `Compliance Officer: ${w.complianceReviewed} outbound message${w.complianceReviewed === 1 ? "" : "s"} pre-flighted this week.${fixes}`
    if (w.complianceReleasedOverObjection > 0) {
      line += ` ${w.complianceReleasedOverObjection} ${w.complianceReleasedOverObjection === 1 ? "was" : "were"} released over an open objection — on the record for your review.`
    }
    parts.push(line)
  }
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
    // WHO FRONTS IT (owner rule): an internal REPORT is presented by the named
    // AI ASSISTANT (ai_identity_profiles cascade — the same identity that
    // answers the phone), not the human's own clone — nobody wants to be
    // briefed by a mirror. Falls back to the human's clone when no assistant
    // is configured; memo when neither exists.
    const { resolveVideoIdentity } = await import("@/lib/video/video-identity")
    const identity = await resolveVideoIdentity(supabase, { brokerageId, agentUserId, purpose: "internal_report" })
    if (!identity.voiceId) return null
    const { generateVideo } = await import("@/lib/did")
    const res = await generateVideo({
      script, voiceId: identity.voiceId, agentUserId, brokerageId,
      avatarImageUrl: identity.avatarPhotoUrl, voiceOnly: !identity.avatarPhotoUrl,
    })
    if (!res.videoUrl) return null
    return { kind: identity.avatarPhotoUrl ? "video" : "audio", url: res.videoUrl }
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

  // ── Finance Manager's numbers — gross commission booked this week + weighted pipeline, from the
  //    SAME pure commission math the forecaster uses (dealCommission/forecastGci) — no second formula. ──
  const [{ data: closedRows }, { data: pipelineRows }] = await Promise.all([
    supabase.from("transactions")
      .select("estimated_commission, commission_amount, commission_percentage, purchase_price")
      .eq("brokerage_id", brokerageId).eq("status", "closed").gte("updated_at", weekAgo).limit(500),
    supabase.from("transactions")
      .select("id, deal_name, property_address, estimated_commission, commission_amount, commission_percentage, purchase_price, win_probability, stage, estimated_close_date, close_date")
      .eq("brokerage_id", brokerageId).in("status", ["active", "under_contract", "closing"]).is("deleted_at", null).limit(500),
  ])
  const gciClosedThisWeek = ((closedRows ?? []) as any[]).reduce((s, t) => s + dealCommission(t), 0)
  const gciWeightedPipeline = forecastGci(0, toPipeline((pipelineRows ?? []) as any[]), now).weightedPipeline

  // Compliance Officer's week — the ledger this PR now writes (gate_name='compliance_preflight').
  const { data: ledgerRows } = await supabase.from("compliance_events")
    .select("severity, allowed, details")
    .eq("brokerage_id", brokerageId).eq("gate_name", PREFLIGHT_GATE).gte("created_at", weekAgo).limit(2000)
  const led = summarizeComplianceLedger((ledgerRows ?? []) as any[])

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
    gciClosedThisWeek,
    gciWeightedPipeline,
    complianceReviewed: led.total,
    complianceAdvisories: led.advisory + led.blocked,
    complianceReleasedOverObjection: led.approvedDespiteAdvisory,
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
  let avatarClipUrl: string | null = null
  let avatarUserId: string | null = null
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
    if (media?.kind === "video") { video += 1; avatarClipUrl = avatarClipUrl ?? media.url; avatarUserId = avatarUserId ?? user.id }
    else if (media?.kind === "audio") audio += 1
    else memo += 1
  }

  // ── The SHOW: one PartnersMeetingReel render per brokerage per week — the
  // same earned numbers as branded 1080p stat cards, with the D-ID avatar clip
  // (the broker's cloned voice, already generated above) in the PIP. Queued on
  // the shared render rail; the Monday ?phase=deliver sweep notifies leadership.
  // Best-effort — a render-queue hiccup never blocks the meeting itself. ──
  try {
    await queuePartnersMeetingReel(supabase, {
      brokerageId, week, avatarVideoUrl: avatarClipUrl,
      agentUserId: avatarUserId ?? audience[0]?.id ?? null, now,
    })
  } catch { /* reel is additive */ }

  return { meetings, video, audio, memo }
}

/** entity_type on the weekly show's render row (dedupe + delivery-sweep key). */
export const PARTNERS_MEETING_REEL_ENTITY = "partners_meeting_reel"

/** Queue ONE weekly-show render per brokerage per week, branded from the live
 *  tenant brand tables, with a branded VideoCoverThumb pass. Idempotent on the
 *  render ledger (entity + 6-day window). */
export async function queuePartnersMeetingReel(
  supabase: Svc,
  p: { brokerageId: string; week: WeekInBusiness; avatarVideoUrl: string | null; agentUserId: string | null; now: Date },
): Promise<boolean> {
  const sinceIso = new Date(p.now.getTime() - 6 * 86_400_000).toISOString()
  const { data: existing } = await supabase.from("remotion_composition_renders").select("id")
    .eq("brokerage_id", p.brokerageId).eq("composition_id", "PartnersMeetingReel")
    .eq("entity_type", PARTNERS_MEETING_REEL_ENTITY).eq("entity_id", p.brokerageId)
    .gte("created_at", sinceIso).limit(1).maybeSingle()
  if (existing) return false

  const { resolveReelBrand } = await import("@/lib/video/reel-brand")
  const { resolveVideoIdentity } = await import("@/lib/video/video-identity")
  const [brand, identity] = await Promise.all([
    resolveReelBrand(supabase, p.brokerageId),
    // The named ASSISTANT hosts the show (photo PIP + on-screen name) — the
    // owner rule: reporting is presented TO the human, not BY the human.
    resolveVideoIdentity(supabase, { brokerageId: p.brokerageId, agentUserId: p.agentUserId, purpose: "internal_report" }),
  ])
  const { buildPartnersMeetingRenderRequest } = await import("@/lib/intelligence/partners-meeting-reel-props")
  const req = buildPartnersMeetingRenderRequest(p.week, {
    agentName: identity.speakerName, avatarVideoUrl: p.avatarVideoUrl,
    agentPhotoUrl: identity.avatarPhotoUrl, brand,
  })
  const props = req.inputProps as unknown as Record<string, unknown>
  props.thumbnail_props = {
    kind: "presentation", title: "Partners' Meeting", subtitle: p.week.weekLabel, eyebrow: "THE AI TEAM'S WEEK",
    agentName: brand.brokerageName,
    brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, showEhoMark: true, ...(brand.logoUrl ? { logoUrl: brand.logoUrl } : {}) },
  }
  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const r = await recordRenderQueued({
    brokerageId: p.brokerageId, compositionId: req.compositionId,
    entityType: PARTNERS_MEETING_REEL_ENTITY, entityId: p.brokerageId,
    inputProps: props, scopeType: "brokerage", scopeId: p.brokerageId, requestedVia: "cron",
  })
  return r.ok
}

/** Monday-afternoon sweep: completed weekly shows → leadership notified. */
export async function deliverPartnersMeetingReels(supabase: Svc, now: Date = new Date()) {
  const { deliverCompletedReels } = await import("@/lib/video/reel-brand")
  return deliverCompletedReels(supabase, {
    entityType: PARTNERS_MEETING_REEL_ENTITY,
    sinceIso: new Date(now.getTime() - 6 * 86_400_000).toISOString(),
    notificationType: "partners_meeting",
    title: "This week's show is ready — your AI team on camera",
    bodyIntro: "The Partners' Meeting as a branded video: the week's plays, the money booked, and the compliance disposition.",
  })
}
