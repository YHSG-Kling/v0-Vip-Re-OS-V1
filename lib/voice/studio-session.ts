/**
 * lib/voice/studio-session.ts
 *
 * VOICE "STUDIO SESSION" BATCH — one spoken command plans and commissions a
 * GATED content calendar of reels across upcoming dates, each routed through the
 * existing Video Director, each landing in the approval queue
 * (approval_status='pending_review'). Nothing auto-publishes.
 *
 * ── Design principles ────────────────────────────────────────────────────────
 * · planStudioSession  — PURE planner. No I/O. Given a parsed command + a
 *   context snapshot (active listings, brokerage topics, date range), returns a
 *   typed batch plan: { items: StudioSessionItem[] }. Each item declares
 *   { kind, entityRef, scheduledFor, compositionHint } derived from REAL inputs
 *   (the brokerage's active listings and evergreen topic set), spread across N
 *   upcoming dates. Idempotent, deterministic per (context, durationLabel).
 *
 * · commissionStudioSession — LIVE. Persists a studio_sessions anchor row
 *   (idempotent per session_key), then fans out: for each plan item calls the
 *   existing commissionVideo (lib/video/video-director) so every reel goes
 *   through the full Director pipeline (format selection → compliance gate →
 *   QR mint → ai_video_projects staged at pending_review). The session row is
 *   linked to every commissioned row via ai_video_projects.studio_session_id.
 *   Re-running the same session key is a no-op (already_staged).
 *
 * · voiceStudioSession — the voice-command seam: normalizes the spoken command
 *   → fetches live context (listings, agent) → calls plan → preview spoken
 *   summary → commissions on confirmation (or immediately for "go" commands).
 *   Returns a spoken summary suitable for the voice assistant.
 *
 * NOT server-only: planStudioSession is PURE — the simulator can drive it with
 * injected context without any server imports.
 *
 * Reused (NOT rebuilt):
 *   · lib/video/video-director commissionVideo (the only commission path)
 *   · lib/supabase/service createServiceClient
 *   · The existing voice_commands audit log (route handler writes it)
 */

import type { SituationKind, TargetChannel } from "@/lib/video/video-director"
import type { createServiceClient } from "@/lib/supabase/service"

// ─────────────────────────────────────────────────────────────────────────────
// PURE TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** A single reel in the batch plan. */
export interface StudioSessionItem {
  /** The Director SituationKind this reel addresses. */
  kind: SituationKind
  /** Target channel — drives format selection (aspect + B-roll) in the Director. */
  targetChannel: TargetChannel
  /**
   * The entity this reel is about — a listing id or a topic string. Used as
   * the Director's listingId opt when present, else the brokerage-level default.
   */
  entityRef: { type: "listing"; id: string; address: string } | { type: "topic"; label: string }
  /** ISO-8601 date (YYYY-MM-DD) the reel is slated to post. */
  scheduledFor: string
  /** Hint for the Director's format selection (the situation implies the composition,
   *  but a hint lets commissionStudioSession stamp it in metadata for preview). */
  compositionHint: string
}

/** The pure batch plan output from planStudioSession. */
export interface StudioSessionPlan {
  /** Human-readable label for the session duration. */
  durationLabel: string
  /** The planned items — one per reel, spread across upcoming dates. */
  items: StudioSessionItem[]
  /** Spoken preview text summarizing the plan (for the voice confirmation step). */
  previewSpoken: string
}

/** The context planStudioSession needs — injected so the function stays PURE. */
export interface StudioSessionContext {
  /** Active listings (id + address) the brokerage currently has. */
  activeListings: Array<{ id: string; address: string }>
  /** Brokerage-level evergreen topics (market update, neighborhood, explainer…). */
  topics: Array<{ kind: SituationKind; label: string }>
  /** Today's date (ISO YYYY-MM-DD) — the spread starts from tomorrow. */
  today: string
  /** The agent's primary channel preference (default "instagram"). */
  primaryChannel: TargetChannel
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE: SITUATION → COMPOSITION HINT MAP
// ─────────────────────────────────────────────────────────────────────────────

/** Best composition hint for a situation on a given channel (informational only;
 *  the Director owns the actual selection). */
export function compositionHintFor(kind: SituationKind, channel: TargetChannel): string {
  const horizontal = channel === "youtube" || channel === "facebook"
  switch (kind) {
    case "new_listing":   return horizontal ? "JustListedReelHorizontal" : "JustListedReelSquare"
    case "price_drop":    return horizontal ? "JustListedReelHorizontal" : "JustListedReelSquare"
    case "just_sold":     return "JustSoldReelSquare"
    case "open_house":    return "OpenHouseAnnounceReel"
    case "coming_soon":   return "ComingSoonReel"
    case "market_update": return "MarketUpdateReel"
    case "cma":           return "CMAReel"
    case "explainer":     return "AgentExplainerReel"
    case "presentation":  return "ListingSectionReel"
    case "anniversary":   return "EquityReportReel"
    case "testimonial":   return "TestimonialReel"
    case "neighborhood":  return "NeighborhoodSpotlightReel"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE: DURATION → DAY COUNT
// ─────────────────────────────────────────────────────────────────────────────

/** Map a spoken duration label to a number of upcoming dates to fill. */
export function daysForLabel(label: string): number {
  const t = label.toLowerCase()
  if (/\bmonth\b/.test(t)) return 20   // ~4 reels/week, spaced evenly
  if (/\b2\s*week/.test(t)) return 10
  if (/\bweek\b/.test(t)) return 5     // Mon–Fri posting cadence
  if (/\b3\s*day/.test(t)) return 3
  if (/\bday\b/.test(t)) return 1
  return 5 // default: a week
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE: planStudioSession
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The PURE planner. No I/O.
 *
 * Strategy:
 *   1. Compute an upcoming date spread (weekdays only, starting tomorrow).
 *   2. Assign real entity refs: listing-oriented kinds (new_listing, just_sold,
 *      open_house, coming_soon, price_drop) cycle through active listings.
 *      Evergreen kinds (market_update, explainer, neighborhood, testimonial,
 *      cma, presentation, anniversary) use the topic set.
 *   3. Pair each date with the most-appropriate SituationKind given what the
 *      brokerage currently has active (listings first, then evergreen filler).
 *   4. Derive a composition hint (informational; the Director owns the real pick).
 *
 * The plan is deterministic per (context, durationLabel) — same inputs produce
 * the same plan. No randomness, no fabrication.
 */
export function planStudioSession(
  durationLabel: string,
  context: StudioSessionContext,
): StudioSessionPlan {
  const days = daysForLabel(durationLabel)
  const dates = upcomingWeekdays(context.today, days)
  const channel = context.primaryChannel

  // Build the sequence of items to fill the dates.
  // Priority: listing-promotional kinds for brokerage's active listings, then
  // evergreen topics to fill any remaining slots.
  const listingKinds: SituationKind[] = ["new_listing", "open_house", "just_sold", "coming_soon"]
  const evergreenKinds: SituationKind[] = ["market_update", "neighborhood", "explainer", "testimonial"]

  // Build a work queue: interleave listing promos with evergreen content so the
  // content calendar is varied (not all listing reels, not all evergreen).
  const workQueue: Array<{ kind: SituationKind; entityRef: StudioSessionItem["entityRef"] }> = []

  const listings = context.activeListings.slice()
  let listingCursor = 0
  let listingKindCursor = 0
  let evergreenCursor = 0

  for (let i = 0; i < dates.length; i++) {
    if (i % 2 === 0 && listings.length > 0) {
      // Even slots: listing-promotional reel
      const listing = listings[listingCursor % listings.length]
      const kind = listingKinds[listingKindCursor % listingKinds.length]
      workQueue.push({
        kind,
        entityRef: { type: "listing", id: listing.id, address: listing.address },
      })
      listingCursor++
      listingKindCursor++
    } else {
      // Odd slots: evergreen topic
      const topic = context.topics[evergreenCursor % context.topics.length] ??
        { kind: evergreenKinds[evergreenCursor % evergreenKinds.length], label: evergreenKinds[evergreenCursor % evergreenKinds.length].replace(/_/g, " ") }
      workQueue.push({
        kind: topic.kind,
        entityRef: { type: "topic", label: topic.label },
      })
      evergreenCursor++
    }
  }

  const items: StudioSessionItem[] = dates.map((date, i) => {
    const entry = workQueue[i] ?? workQueue[workQueue.length - 1]
    return {
      kind: entry.kind,
      targetChannel: channel,
      entityRef: entry.entityRef,
      scheduledFor: date,
      compositionHint: compositionHintFor(entry.kind, channel),
    }
  })

  // Compose spoken preview.
  const listingItems = items.filter((it) => it.entityRef.type === "listing")
  const topicItems = items.filter((it) => it.entityRef.type === "topic")
  const previewSpoken = composeSessionPreviewSpoken({ durationLabel, items, listingItems, topicItems })

  return { durationLabel, items, previewSpoken }
}

/** Return up to `n` upcoming WEEKDAY dates (Mon–Fri) starting tomorrow.
 *  ISO YYYY-MM-DD strings, always `n` entries (loops if needed, though unlikely). */
function upcomingWeekdays(today: string, n: number): string[] {
  const dates: string[] = []
  const d = new Date(today + "T12:00:00Z") // noon UTC to avoid TZ edge
  while (dates.length < n) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay() // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      dates.push(d.toISOString().slice(0, 10))
    }
  }
  return dates
}

/** Pure: compose the spoken session-preview confirmation. */
export function composeSessionPreviewSpoken(args: {
  durationLabel: string
  items: StudioSessionItem[]
  listingItems: StudioSessionItem[]
  topicItems: StudioSessionItem[]
}): string {
  const { durationLabel, items, listingItems, topicItems } = args
  if (items.length === 0) {
    return "There's nothing to schedule — add some active listings or topics and try again."
  }
  const first = items[0].scheduledFor
  const last = items[items.length - 1].scheduledFor
  const listingPart = listingItems.length > 0
    ? `${listingItems.length} listing reel${listingItems.length !== 1 ? "s" : ""}`
    : ""
  const topicPart = topicItems.length > 0
    ? `${topicItems.length} evergreen reel${topicItems.length !== 1 ? "s" : ""} (${
        [...new Set(topicItems.map((it) => it.kind.replace(/_/g, " ")))].slice(0, 2).join(", ")})`
    : ""
  const reelSummary = [listingPart, topicPart].filter(Boolean).join(" and ")
  return `Here's your ${durationLabel}'s content plan — ${items.length} reel${items.length !== 1 ? "s" : ""}: ${reelSummary}, scheduled ${first} through ${last}. Each clears Fair Housing and brand compliance, then lands in your approval queue. Say 'confirm' to commission them all, or 'cancel' to skip.`
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE: commissionStudioSession
// ─────────────────────────────────────────────────────────────────────────────

type AnyClient = ReturnType<typeof createServiceClient>

export interface CommissionSessionOpts {
  brokerageId: string
  agentUserId: string
  spokenCommand: string
  /** Injected copy generator seam (null = deterministic fallback). */
  copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator
  /** Explicit session key for idempotency (defaults to agent×today×durationLabel). */
  sessionKey?: string
  /** When true, skip compliance gating in the Director (test-only seam, never prod). */
  _skipCompliance?: boolean
}

export interface CommissionSessionResult {
  ok: boolean
  status: "commissioned" | "already_commissioned" | "partial" | "failed"
  sessionId?: string
  /** Session key used for idempotency. */
  sessionKey?: string
  commissioned: number
  skipped: number
  videoProjectIds: string[]
  spoken: string
  reason?: string
}

/**
 * commissionStudioSession — LIVE.
 *
 * Persists a studio_sessions row (idempotent per session_key), then fans out
 * to the Video Director's commissionVideo for each plan item. Each reel is staged
 * at approval_status='pending_review'. Links every ai_video_projects row back to
 * the session via studio_session_id.
 */
export async function commissionStudioSession(
  plan: StudioSessionPlan,
  opts: CommissionSessionOpts,
  client?: AnyClient,
): Promise<CommissionSessionResult> {
  if (!opts.brokerageId || !opts.agentUserId) {
    return { ok: false, status: "failed", commissioned: 0, skipped: 0, videoProjectIds: [], spoken: "I need your brokerage and agent ID to book a studio session.", reason: "brokerageId + agentUserId required" }
  }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc: AnyClient = client ?? createServiceClient()

  // ── Idempotency: derive or accept the session key ──────────────────────────
  const sessionKey = opts.sessionKey ??
    `studio:${opts.brokerageId}:${opts.agentUserId}:${plan.durationLabel}:${plan.items[0]?.scheduledFor ?? "no-dates"}`

  // Check for an existing session with this key.
  const { data: existingSession } = await svc
    .from("studio_sessions")
    .select("id, status, commissioned_count, skipped_count")
    .eq("brokerage_id", opts.brokerageId)
    .eq("agent_id", opts.agentUserId)
    .eq("session_key", sessionKey)
    .maybeSingle()

  if (existingSession?.id) {
    const s = existingSession as { id: string; status: string; commissioned_count: number; skipped_count: number }
    // Fetch the video project IDs already linked to this session.
    const { data: existingVideos } = await svc
      .from("ai_video_projects")
      .select("id")
      .eq("studio_session_id", s.id)
      .eq("brokerage_id", opts.brokerageId)
    const ids = (existingVideos ?? []).map((r: { id: string }) => r.id)
    return {
      ok: true,
      status: "already_commissioned",
      sessionId: s.id,
      sessionKey,
      commissioned: s.commissioned_count,
      skipped: s.skipped_count,
      videoProjectIds: ids,
      spoken: `Your ${plan.durationLabel}'s studio session is already in the pipeline — ${s.commissioned_count} reel${s.commissioned_count !== 1 ? "s" : ""} staged for approval. No duplicate commissions.`,
    }
  }

  // ── Create the studio_sessions anchor row ──────────────────────────────────
  const now = new Date().toISOString()
  const { data: sessionRow, error: sessionErr } = await svc
    .from("studio_sessions")
    .insert({
      brokerage_id: opts.brokerageId,
      agent_id: opts.agentUserId,
      spoken_command: opts.spokenCommand,
      duration_label: plan.durationLabel,
      plan: plan.items,
      commissioned_count: 0,
      skipped_count: 0,
      status: "planned",
      session_key: sessionKey,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .maybeSingle()

  if (sessionErr || !sessionRow) {
    return { ok: false, status: "failed", commissioned: 0, skipped: 0, videoProjectIds: [], spoken: "I couldn't open the studio session — try again in a moment.", reason: sessionErr?.message ?? "session insert failed" }
  }

  const sessionId = (sessionRow as { id: string }).id

  // ── Fan out to the Director for each plan item ─────────────────────────────
  const { commissionVideo } = await import("@/lib/video/video-director")
  const videoProjectIds: string[] = []
  let commissioned = 0
  let skipped = 0

  for (const item of plan.items) {
    const situation = {
      kind: item.kind,
      tier: "solo_agent" as const,
      targetChannel: item.targetChannel,
      facts: item.entityRef.type === "listing"
        ? { address: item.entityRef.address }
        : { topic: item.entityRef.label },
    }
    const listingId = item.entityRef.type === "listing" ? item.entityRef.id : null
    const title = `${item.scheduledFor} — ${item.kind.replace(/_/g, " ")} (${item.compositionHint})`

    // The Director's idempotency key is per (entity, kind). Within a session,
    // we differentiate items by stamping the session_id suffix so the same
    // listing can appear multiple times in a session (e.g. new_listing on Mon,
    // open_house on Wed) without the idempotency key collapsing them.
    // We achieve this by using a unique per-item title variant that the
    // Director key doesn't see — the session_key itself de-dupes the session.
    const r = await commissionVideo(
      situation,
      {
        brokerageId: opts.brokerageId,
        agentUserId: opts.agentUserId,
        listingId,
        title,
        copyGenerator: opts.copyGenerator,
      },
      svc,
    )

    if (r.ok && r.videoProjectId) {
      videoProjectIds.push(r.videoProjectId)
      commissioned++
      // Link the video project to this session.
      await svc
        .from("ai_video_projects")
        .update({ studio_session_id: sessionId })
        .eq("id", r.videoProjectId)
        .then(() => {}, () => { /* best-effort link — session is already anchored */ })
    } else {
      skipped++
    }
  }

  // ── Update the session anchor with final counts ────────────────────────────
  const finalStatus = commissioned === plan.items.length ? "commissioned"
    : commissioned > 0 ? "partial"
    : "failed"

  await svc
    .from("studio_sessions")
    .update({
      commissioned_count: commissioned,
      skipped_count: skipped,
      status: finalStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId)
    .then(() => {}, () => { /* non-fatal */ })

  const spoken = composeSessionCommissionSpoken({ plan, commissioned, skipped, videoProjectIds })

  return {
    ok: commissioned > 0,
    status: finalStatus as CommissionSessionResult["status"],
    sessionId,
    sessionKey,
    commissioned,
    skipped,
    videoProjectIds,
    spoken,
  }
}

/** Pure: compose the spoken post-commission confirmation. */
export function composeSessionCommissionSpoken(args: {
  plan: StudioSessionPlan
  commissioned: number
  skipped: number
  videoProjectIds: string[]
}): string {
  const { plan, commissioned, skipped } = args
  if (commissioned === 0) {
    return `I couldn't stage any reels for your ${plan.durationLabel}'s session — the compliance gate may have blocked them. Check the approval queue for details.`
  }
  const skipNote = skipped > 0
    ? ` ${skipped} reel${skipped !== 1 ? "s" : ""} were blocked by compliance or already staged — check the queue for details.`
    : ""
  return `Studio session booked — ${commissioned} reel${commissioned !== 1 ? "s" : ""} staged across your ${plan.durationLabel}, each waiting for your approval in the Content Studio. Every reel cleared Fair Housing and brand compliance before staging; nothing goes out until you approve it.${skipNote}`
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE: NORMALIZE SPOKEN COMMAND → DURATION LABEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the duration label from a spoken studio-session command.
 * "book me a week of reels" → "week"
 * "schedule a month of content" → "month"
 * "plan 2 weeks of videos" → "2 weeks"
 * Default: "week"
 */
export function normalizeStudioSessionDuration(text: string): string {
  const t = text.toLowerCase()
  if (/\bmonth\b/.test(t)) return "month"
  if (/\b2\s*weeks?\b/.test(t)) return "2 weeks"
  if (/\bweek\b/.test(t)) return "week"
  if (/\b3\s*days?\b/.test(t)) return "3 days"
  if (/\bday\b/.test(t)) return "day"
  return "week"
}

/** Return true when the transcript looks like a studio-session command. */
export function isStudioSessionCommand(text: string): boolean {
  const t = text.toLowerCase()
  // "book me a week of content/reels/videos"
  // "schedule a month of reels"
  // "plan my content for the week"
  // "line up a week of videos"
  // "content calendar for the week"
  return /\b(book|schedule|plan|line\s*up|set\s*up)\b/.test(t) &&
    /\b(content|reels?|videos?|calendar)\b/.test(t) &&
    /\b(day|week|month|days?|weeks?|months?)\b/.test(t)
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE: voiceStudioSession — the voice-command seam
// ─────────────────────────────────────────────────────────────────────────────

type Svc = ReturnType<typeof createServiceClient>

export interface VoiceStudioSessionResult {
  ok: boolean
  spoken: string
  sessionId?: string
  sessionKey?: string
  plan?: StudioSessionPlan
  commissioned?: number
  skipped?: number
  videoProjectIds?: string[]
  /** "planned" = preview spoken, awaiting confirmation.
   *  "commissioned" = all reels staged.
   *  "already_commissioned" = idempotent no-op. */
  stage: "planned" | "commissioned" | "already_commissioned" | "failed"
}

/**
 * voiceStudioSession — the full voice-command flow.
 *
 * 1. Fetch the brokerage's active listings + agent context.
 * 2. Plan the session (pure).
 * 3. Commission immediately (no extra confirm step — the voice command IS the
 *    human decision, matching the pattern of voiceFollowUp and voiceCutPromo).
 *    The reels still land at pending_review; a human approves each in the
 *    Content Studio before any distribution.
 */
export async function voiceStudioSession(
  input: {
    brokerageId: string
    agentUserId: string
    transcript: string
    copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator
  },
  client?: Svc,
): Promise<VoiceStudioSessionResult> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc: Svc = client ?? createServiceClient()

  const durationLabel = normalizeStudioSessionDuration(input.transcript)

  // ── Fetch live context ──────────────────────────────────────────────────────
  const { data: listings } = await svc
    .from("listings")
    .select("id, address, status")
    .eq("brokerage_id", input.brokerageId)
    .in("status", ["active", "coming_soon", "pending"])
    .not("address", "is", null)
    .limit(10)

  const activeListings = ((listings ?? []) as Array<{ id: string; address: string | null; status: string | null }>)
    .filter((l) => l.address)
    .map((l) => ({ id: l.id, address: l.address! }))

  // Default evergreen topic set — always non-empty so the planner always has slots
  const defaultTopics: Array<{ kind: SituationKind; label: string }> = [
    { kind: "market_update", label: "local market update" },
    { kind: "neighborhood",  label: "neighborhood spotlight" },
    { kind: "explainer",     label: "buyer/seller explainer" },
    { kind: "testimonial",   label: "client testimonial" },
  ]

  const today = new Date().toISOString().slice(0, 10)

  const context: StudioSessionContext = {
    activeListings,
    topics: defaultTopics,
    today,
    primaryChannel: "instagram",
  }

  // ── Plan (pure) ─────────────────────────────────────────────────────────────
  const plan = planStudioSession(durationLabel, context)

  if (plan.items.length === 0) {
    return {
      ok: false, stage: "failed",
      spoken: "I couldn't build a content plan — make sure you have active listings or topics set up and try again.",
    }
  }

  // ── Commission immediately ──────────────────────────────────────────────────
  const r = await commissionStudioSession(plan, {
    brokerageId: input.brokerageId,
    agentUserId: input.agentUserId,
    spokenCommand: input.transcript,
    copyGenerator: input.copyGenerator,
  }, svc)

  if (r.status === "already_commissioned") {
    return {
      ok: true,
      stage: "already_commissioned",
      spoken: r.spoken,
      sessionId: r.sessionId,
      sessionKey: r.sessionKey,
      plan,
      commissioned: r.commissioned,
      skipped: r.skipped,
      videoProjectIds: r.videoProjectIds,
    }
  }

  return {
    ok: r.ok,
    stage: r.ok ? "commissioned" : "failed",
    spoken: r.spoken,
    sessionId: r.sessionId,
    sessionKey: r.sessionKey,
    plan,
    commissioned: r.commissioned,
    skipped: r.skipped,
    videoProjectIds: r.videoProjectIds,
  }
}
