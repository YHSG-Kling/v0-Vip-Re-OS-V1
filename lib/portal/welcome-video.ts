/**
 * lib/portal/welcome-video.ts — CONTRACT C3 (wave 146): THE CONTACT'S PERSONAL WELCOME VIDEO LIVES IN THEIR PORTAL.
 *
 * OWNER RULING 6 (2026-10-29), verbatim: "Welcome email shouldn't wait for a video so send welcome email out right away and
 * put the welcome personal video in-app contact portal so the contact sees it right away." — and — "Welcome video is
 * automatically sent in the portal regardless of the contact's preferences." This OVERRULES wave 145's ruling 17 (the welcome
 * waited for the video; a failure became a `welcome_without_video` approval item).
 *
 *   conversion → lead-domain sends suppressed (lib/contact-promotion/lead-deactivator.ts) → relationship confirmed
 *   (contacts.agent_id) → portal invite + welcome email SENT NOW (lib/contact-promotion/conversion-welcome.ts) → the agent's
 *   personal video prepared ASYNCHRONOUSLY (the ONE avatar spine, lib/video/intro-video-reactor.ts) → it APPEARS in this
 *   contact's portal the moment it is validated (THIS module's reader — the portal renders from it, so "validated" and
 *   "visible" are one read) → the sweeper reads it BACK through the same reader and only then records it delivered.
 *
 * WHAT THIS MODULE IS. One reader, one pure sweep classifier, one recovery decision, and the four writes that carry them
 * out — every one on an EXISTING survivor (no second video pipeline, no new table):
 *   · portalWelcomeVideoFor            — THE C3 read. Tenant-pinned (brokerage AND contact, from the caller's SESSION gate —
 *                                        app/portal/[contactId]/components/PortalWelcomeVideo.tsx asks requireContactAccess
 *                                        first). Reads the welcome render's ledger (agent_intro_videos, trigger
 *                                        contact_agent_assigned) for the contact's CURRENT agent, the playable state through
 *                                        THE one resolver (lib/video/playable-video.ts resolvePlayableVideo: finished,
 *                                        compliance not failed, the assembled cut — never the bare avatar track while the
 *                                        assembly is pending), the agent's standing personal video as the stand-in
 *                                        (lib/kernel/welcome-personal-video.ts), the video's own script as the transcript, and
 *                                        the contact's STATED accessibility preferences (lib/contacts/accessibility-
 *                                        preferences.ts, contract C3 of wave 145) as PLAYBACK — they shape playback, they never
 *                                        suppress the video (ruling 6).
 *   · classifyPortalWelcomeVideo       — PURE. What the sweeper does with a pending render: wait / place / fail / skip. The
 *                                        deadline is checked BEFORE the assembly gate (nothing waits forever). No email,
 *                                        opt-out or channel input exists: the portal video is not a marketing message.
 *   · placePortalWelcomeVideo          — the READBACK: the portal's own reader must answer `ready` for THIS render before the
 *                                        ledger row is stamped 'delivered' — never a false video-complete state. Evidence on
 *                                        the action ledger (Law 5).
 *   · decidePortalWelcomeRecovery /    — FAILURE: the portal keeps working (the reader shows nothing false), the failure is
 *     recoverPortalWelcomeVideo          recorded (the ledger row + automation_errors), the manager retries SAFELY (the agent's
 *                                        standing video stands in at no spend; ONE bounded re-render through the avatar spine's
 *                                        retry door when the cause is transient or fixed), and a PERSON is told once (the
 *                                        agent's notification + the error console). Idempotent per contact on the action ledger.
 *   · recordPortalWelcomeVideoServed   — the contact's own portal view of the video, recorded once per render.
 *
 * VISIBLE ONLY TO THAT CONTACT AND THE RELEVANT AGENT / TENANT: the reader is keyed by (brokerage, contact) and both come from
 * the session gate (requireContactAccess admits the contact themselves and same-brokerage contact-scope staff); the render is
 * the contact's CURRENT agent's (a reassigned contact never sees the previous agent's clip); a contact of another brokerage
 * reads `none`. BLIND SPOT, published: the rendered bytes live in the PUBLIC `video-assets` bucket (lib/remotion/media-host.ts —
 * an unguessable path, never listed), so the URL itself is a bearer link once handed to the page; making it private is a
 * storage change (lane 146A's domain — Outside-lane in this lane's notes).
 */

import { PENDING_WELCOME_STATUSES, WELCOME_VIDEO_WAIT_MS } from "@/lib/contact-promotion/conversion-welcome"
import { WELCOME_VIDEO_EXCLUDED_CONTACT_TYPES } from "@/lib/contact-promotion/welcome-avatar-video"
import { applyTenantScope, platformScope } from "@/lib/kernel/tenant-scope"

type Svc = { from: (table: string) => any }

/** The agent_intro_videos trigger of the welcome render (the live CHECK: contact_agent_assigned | home_anniversary). */
export const PORTAL_WELCOME_VIDEO_TRIGGER = "contact_agent_assigned"

/** automation_errors.workflow_name of an escalated portal welcome video. */
export const PORTAL_WELCOME_VIDEO_WORKFLOW = "portal_welcome_video"

/** How far back the sweeper looks for failed welcome renders to recover (a render older than this was told to a person). */
export const PORTAL_WELCOME_RECOVERY_WINDOW_DAYS = 7

// ─── THE READ (contract C3) ──────────────────────────────────────────────────

/** How the portal plays the video for THIS person — their STATED accessibility preferences, never inferred (ruling 6 + C3). */
export interface PortalWelcomeVideoPlayback {
  /** Never true: the portal never forces playback (ruling 6 — "no forced autoplay with sound"). */
  autoplay: false
  /** Show the transcript OPEN under the player: captions / transcript / a screen-reader portal / a stated text format. */
  transcriptOpen: boolean
  /** The person asked for captions. There is no timed caption track (see `timedCaptions`) — the transcript answers it. */
  captionsRequested: boolean
  /** False, honestly: no WebVTT track exists for an avatar render; the assembled cut burns only a caption strip. */
  timedCaptions: false
  /** reduce_motion or a screen-reader portal. */
  reduceMotion: boolean
  /** Any accessibility preference was stated (false = the defaults; nothing about the person was guessed). */
  stated: boolean
  /** The preference read could not be made — the defaults apply, and this says so. */
  blindSpot: string | null
}

export type PortalWelcomeVideo =
  | {
      state: "ready"
      videoUrl: string
      posterUrl: string | null
      videoProjectId: string
      /** contact_personal = rendered for THIS contact; agent_personal = the agent's standing personal video standing in. */
      scope: "contact_personal" | "agent_personal"
      /** agents.id of the contact's current agent — the video is FROM them. */
      agentRecordId: string
      /** The words the video speaks (ai_video_projects.script_content, tenant-pinned) — the text alternative, always offered. */
      transcript: string | null
      /** agent_intro_videos.id of the welcome render (null when none was ever commissioned). */
      introVideoId: string | null
      playback: PortalWelcomeVideoPlayback
    }
  /** A render is genuinely in flight and inside its deadline. The CONTACT sees nothing (never a promise); staff see this. */
  | { state: "preparing"; reason: string; introVideoId: string | null }
  /** The render failed / stalled / was refused and nothing stands in. The CONTACT sees nothing false; staff see the reason. */
  | { state: "failed"; reason: string; introVideoId: string | null }
  /** No welcome video belongs here (no agent, a counterparty type, another brokerage's contact, never commissioned). */
  | { state: "none"; reason: string; introVideoId: string | null }
  /** A read was REFUSED. Fail closed: never `ready`, never "nothing to see" — "nobody checked" is not "checked and fine". */
  | { state: "unavailable"; reason: string; introVideoId: string | null }

export interface WelcomeRenderRow {
  id: string
  agent_id: string | null
  status: string | null
  video_project_id: string | null
  error_message: string | null
  created_at: string | null
  delivered_at?: string | null
}

const isPending = (status: string | null | undefined) => !!status && PENDING_WELCOME_STATUSES.includes(status)

/** PURE: the playback a stated preference set asks for (H's ONE adaptation table — never a second parser of the vocabulary). */
export function playbackFromAdaptations(
  a: { stated: boolean; format: string | null; captions: boolean; transcript: boolean; noAutoplay: boolean; modality: string } | null,
  blindSpot: string | null = null,
): PortalWelcomeVideoPlayback {
  if (!a) return { autoplay: false, transcriptOpen: false, captionsRequested: false, timedCaptions: false, reduceMotion: false, stated: false, blindSpot }
  return {
    autoplay: false,
    transcriptOpen: a.transcript || a.captions || a.format === "text" || a.modality === "screen_reader",
    captionsRequested: a.captions,
    timedCaptions: false,
    reduceMotion: a.noAutoplay,
    stated: a.stated,
    blindSpot,
  }
}

/**
 * THE C3 READ: this contact's personal welcome video, as the portal must show it. Tenant-pinned on BOTH ids, which the caller
 * takes from its session gate (never a body). NEVER THROWS; a refused read is `unavailable`, never `ready`.
 *
 * Precedence: the render made FOR THIS CONTACT by their current agent (when playable) → the agent's standing personal video
 * standing in for a render still coming or failed → the honest state of the render (preparing / failed) → none.
 */
export async function portalWelcomeVideoFor(
  svc: Svc,
  brokerageId: string,
  contactId: string,
  opts: { now?: Date } = {},
): Promise<PortalWelcomeVideo> {
  const nowMs = (opts.now ?? new Date()).getTime()
  try {
    if (!brokerageId || !contactId) return { state: "unavailable", reason: "no brokerage / contact to read the welcome video for", introVideoId: null }

    const { data: contact, error: contactErr } = await svc.from("contacts")
      .select("id, agent_id, contact_type").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
    if (contactErr) return { state: "unavailable", reason: `contact read refused: ${contactErr.message ?? "unknown"}`, introVideoId: null }
    if (!contact) return { state: "none", reason: "this contact is not in this brokerage — no welcome video is served across tenants", introVideoId: null }
    const c = contact as { agent_id?: string | null; contact_type?: string | null }
    if (WELCOME_VIDEO_EXCLUDED_CONTACT_TYPES.includes(String(c.contact_type ?? "").toLowerCase())) {
      return { state: "none", reason: `a '${c.contact_type}' is a counterparty, not a client — no welcome video`, introVideoId: null }
    }
    const agentRecordId = c.agent_id ?? null
    if (!agentRecordId) return { state: "none", reason: "no assigned agent — there is nobody for the welcome video to be from", introVideoId: null }

    // THE WELCOME RENDER'S LEDGER for the CURRENT agent. Trigger-filtered: an anniversary clip is never a welcome.
    const { data: rows, error: rowsErr } = await svc.from("agent_intro_videos")
      .select("id, agent_id, status, video_project_id, error_message, created_at, delivered_at")
      .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("trigger", PORTAL_WELCOME_VIDEO_TRIGGER)
      .order("created_at", { ascending: false }).limit(5)
    if (rowsErr) return { state: "unavailable", reason: `welcome render ledger read refused: ${rowsErr.message ?? "unknown"}`, introVideoId: null }
    const row = ((rows ?? []) as WelcomeRenderRow[]).find((r) => r.agent_id === agentRecordId) ?? null

    const playback = async () => {
      try {
        const { readAccessibilityPreferences, accessibilityAdaptations } = await import("@/lib/contacts/accessibility-preferences")
        const read = await readAccessibilityPreferences(svc as never, brokerageId, contactId)
        if (!read.ok) return playbackFromAdaptations(null, `accessibility preferences unreadable (${read.error}) — the defaults apply`)
        return playbackFromAdaptations(accessibilityAdaptations(read.preferences))
      } catch (e) {
        return playbackFromAdaptations(null, `accessibility preferences unavailable (${e instanceof Error ? e.message : String(e)}) — the defaults apply`)
      }
    }
    const transcriptFor = async (videoProjectId: string): Promise<string | null> => {
      const { data, error } = await svc.from("ai_video_projects").select("script_content")
        .eq("id", videoProjectId).eq("brokerage_id", brokerageId).maybeSingle()
      if (error) return null // the player still plays; the transcript is simply not offered (never invented)
      const s = (data as { script_content?: string | null } | null)?.script_content ?? null
      return s && s.trim() ? s.trim().slice(0, 6000) : null
    }
    const ready = async (v: { videoUrl: string; posterUrl: string | null; videoProjectId: string; scope: "contact_personal" | "agent_personal" }): Promise<PortalWelcomeVideo> => ({
      state: "ready", ...v, agentRecordId, transcript: await transcriptFor(v.videoProjectId), introVideoId: row?.id ?? null, playback: await playback(),
    })

    // 1. THE RENDER MADE FOR THIS CONTACT — validated by THE one resolver.
    let personalReason: string | null = null
    let personalInFlight = false
    if (row?.video_project_id) {
      const { resolvePlayableVideo } = await import("@/lib/video/playable-video")
      const playable = await resolvePlayableVideo({ videoProjectId: row.video_project_id }, svc as never)
      if (playable.state === "ready") {
        return ready({ videoUrl: playable.videoUrl, posterUrl: playable.thumbnailUrl, videoProjectId: row.video_project_id, scope: "contact_personal" })
      }
      if (playable.state === "in_progress") personalInFlight = true
      else personalReason = playable.reason
    }

    // 2. THE AGENT'S STANDING PERSONAL VIDEO stands in — only for a contact who entered the welcome path (a render row exists).
    if (row) {
      const { resolveWelcomePersonalVideo } = await import("@/lib/kernel/welcome-personal-video")
      const standing = await resolveWelcomePersonalVideo(svc as never, { brokerageId, contactId, agentRecordId })
      if (standing.state === "ready" && standing.scope === "agent_personal") {
        return ready({ videoUrl: standing.videoUrl, posterUrl: standing.thumbnailUrl, videoProjectId: standing.videoProjectId, scope: "agent_personal" })
      }
    }

    // 3. THE HONEST STATE OF THE RENDER.
    if (!row) return { state: "none", reason: "no welcome video was commissioned for this contact", introVideoId: null }
    if (isPending(row.status) || personalInFlight) {
      const ageMs = row.created_at ? nowMs - new Date(row.created_at).getTime() : null
      if (ageMs !== null && ageMs > WELCOME_VIDEO_WAIT_MS) {
        return { state: "failed", reason: `the personal welcome video has not landed within ${Math.round(WELCOME_VIDEO_WAIT_MS / 60000)} minutes of conversion`, introVideoId: row.id }
      }
      return { state: "preparing", reason: "the agent's personal welcome video is rendering — it appears here the moment it is validated", introVideoId: row.id }
    }
    if (row.status === "delivered") {
      // Recorded delivered, but no longer playable (a later compliance fail, a removed render): never shown as complete.
      return { state: "failed", reason: `the delivered welcome video is no longer playable: ${personalReason ?? "no playable cut"}`, introVideoId: row.id }
    }
    return { state: "failed", reason: row.error_message?.trim() || personalReason || `the welcome render is '${row.status ?? "unknown"}'`, introVideoId: row.id }
  } catch (e) {
    return { state: "unavailable", reason: `welcome video read threw: ${e instanceof Error ? e.message : String(e)}`, introVideoId: null }
  }
}

// ─── THE SWEEPER'S DECISION (PURE) ───────────────────────────────────────────

export type PortalWelcomeVideoAction =
  /** Still rendering / the assembly is pending, inside the deadline. Leave it. */
  | "wait"
  /** The render landed: read it back through the portal's reader and record it delivered. */
  | "place"
  /** Past the deadline: record 'failed' and hand it to recovery (retry / stand-in / a person). */
  | "fail"
  /** A terminal row: nothing to do. */
  | "skip"

export interface PortalWelcomeVideoVerdict {
  action: PortalWelcomeVideoAction
  /** What agent_intro_videos.status becomes once carried out (live CHECK values only); null while waiting / skipping. */
  ledgerStatus: "delivered" | "failed" | null
  reason: string
}

/**
 * THE SWEEPER'S DECISION, with no I/O. ORDER IS THE DESIGN: a terminal row is skipped; the DEADLINE is checked BEFORE the
 * assembly gate (a stuck Remotion assembly can never hold the video past it); only then may the assembly or a missing URL hold
 * it. No email, opt-out or channel input exists here on purpose — the portal video is the contact's in-app welcome, not a
 * marketing message (ruling 6), and the WELCOME EMAIL already went at conversion.
 */
export function classifyPortalWelcomeVideo(input: {
  status: string | null
  ageMs: number | null
  composite: "not_requested" | "pending" | "landed" | "abandoned" | null
  hasRenderedUrl: boolean
  waitMs?: number
}): PortalWelcomeVideoVerdict {
  const waitMs = input.waitMs ?? WELCOME_VIDEO_WAIT_MS
  if (!isPending(input.status)) {
    return { action: "skip", ledgerStatus: null, reason: `agent_intro_videos.status '${input.status ?? "null"}' is terminal` }
  }
  if (input.ageMs !== null && input.ageMs > waitMs) {
    return {
      action: "fail", ledgerStatus: "failed",
      reason: `the personal welcome video has not landed within ${Math.round(waitMs / 60000)} minutes of conversion — the portal shows nothing false; the manager retries or a person is told`,
    }
  }
  if (input.composite === "pending") {
    return { action: "wait", ledgerStatus: null, reason: "the Remotion assembly has not landed — the bare avatar track is never shown as the welcome" }
  }
  if (!input.hasRenderedUrl) return { action: "wait", ledgerStatus: null, reason: "the render is still in flight" }
  return { action: "place", ledgerStatus: "delivered", reason: "the finished personal video is ready — it is read back through the portal and recorded delivered" }
}

// ─── THE READBACK: placed only when the portal's own reader shows it ─────────

export interface PortalPlacement {
  placed: boolean
  /** The portal reader's answer the decision was made on (the readback). */
  readback: PortalWelcomeVideo["state"]
  reason: string
}

/**
 * Record the welcome render DELIVERED to the portal — ONLY after the portal's own reader (portalWelcomeVideoFor — the function
 * the portal renders from) answers `ready` for THIS render, made for THIS contact. Anything else stamps nothing and the next tick
 * re-reads (never a false video-complete state). The stamp is guarded on the pending status it was read in and COUNTED; the
 * evidence (who / why / the readback / what happened) rides the action ledger, once per render. NEVER THROWS.
 */
export async function placePortalWelcomeVideo(
  svc: Svc,
  p: { introVideoId: string; brokerageId: string; contactId: string; videoProjectId: string | null; expectedUrl?: string | null; now?: Date },
  deps: { read?: typeof portalWelcomeVideoFor } = {},
): Promise<PortalPlacement> {
  try {
    const read = deps.read ?? portalWelcomeVideoFor
    const back = await read(svc, p.brokerageId, p.contactId, { now: p.now })
    if (!(back.state === "ready" && back.scope === "contact_personal" && !!p.videoProjectId && back.videoProjectId === p.videoProjectId)) {
      const what = back.state === "ready" ? `${back.scope} ${back.videoProjectId}` : `${back.state}: ${back.reason}`
      return { placed: false, readback: back.state, reason: `the portal readback did not show this render (${what}) — nothing stamped; the next tick re-reads` }
    }
    const nowIso = (p.now ?? new Date()).toISOString()
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const stamped = await withActionLedger(
      {
        brokerageId: p.brokerageId, action: "welcome_video.portal.place", actor: { type: "system" },
        subject: { type: "contact", id: p.contactId }, reasonCode: "CONTACT_WELCOME", channel: "portal", systemSource: PORTAL_WELCOME_VIDEO_WORKFLOW,
        reasonDetail: "owner ruling 6 — the personal welcome video appears in the contact's portal the moment it is validated",
        cycle: `portal_welcome_video:${p.videoProjectId}`,
        detail: { intro_video_id: p.introVideoId, video_project_id: p.videoProjectId, readback: { state: back.state, scope: back.scope, video_url: back.videoUrl }, expected_url: p.expectedUrl ?? null },
      },
      async () => {
        const { data, error } = await svc.from("agent_intro_videos")
          .update({ status: "delivered", delivered_at: nowIso, error_message: null })
          .eq("id", p.introVideoId).eq("brokerage_id", p.brokerageId).in("status", [...PENDING_WELCOME_STATUSES]).select("id")
        if (error) return { n: 0, error: error.message as string }
        return { n: (data ?? []).length, error: null as string | null }
      },
      {
        settle: (r) => r.n === 1 ? { status: "executed", outcome: "placed_in_portal" } : { status: "failed", outcome: "stamp_matched_nothing", error: r.error ?? "0 rows matched" },
        replay: () => ({ n: 1, error: null }),
      },
      { client: svc },
    )
    if (stamped.n !== 1) return { placed: false, readback: back.state, reason: `the delivered stamp did not land (${stamped.error ?? "0 rows matched — another tick may have placed it"})` }
    return { placed: true, readback: back.state, reason: "read back through the portal's reader and recorded delivered" }
  } catch (e) {
    return { placed: false, readback: "unavailable", reason: `placement threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ─── FAILURE: RECORDED, RETRIED SAFELY, TOLD TO A PERSON ─────────────────────

export type PortalWelcomeFailureKind =
  /** The agent has no cloned voice / avatar on file — agent-actionable. */
  | "no_avatar"
  /** The avatar spine's channel gate (contacts.video_opt_out) refused it — ruling 6 says it should not (Outside-lane 146F). */
  | "channel_gate"
  /** The render did not land inside the deadline. Transient. */
  | "timeout"
  /** The spine was unreachable / threw. Transient. */
  | "unavailable"
  /** Compliance or the provider refused it — a person must look; a blind retry would spend for the same answer. */
  | "refused"

/** PURE: the failure kind from what the ledger (or the commissioning) recorded. */
export function failureKindOf(input: { status?: string | null; errorMessage?: string | null; commissionReason?: string | null }): PortalWelcomeFailureKind {
  const r = input.commissionReason ?? null
  if (r === "agent_not_video_ready") return "no_avatar"
  if (r === "video_opt_out") return "channel_gate"
  if (r === "unavailable") return "unavailable"
  if (r === "refused") return "refused"
  if (input.status === "suppressed") return "channel_gate"
  const m = String(input.errorMessage ?? "")
  if (/voice\/avatar|voice \/ avatar|avatar profile/i.test(m)) return "no_avatar"
  if (/has not landed within|did not land within|stalled/i.test(m)) return "timeout"
  if (/video_opt_out/i.test(m)) return "channel_gate"
  return "refused"
}

export type PortalWelcomeRecoveryAction =
  /** A read was refused — decide nothing on a guess; the next tick re-reads. */
  | "defer"
  /** The portal already shows a validated video (the agent's standing video stands in) — no spend, nobody to wake. */
  | "covered_by_standing_video"
  /** A render is in flight again — leave it. */
  | "in_flight"
  /** ONE bounded re-render through the avatar spine's retry door. */
  | "retry"
  /** Tell a person (once per contact): the agent + the error console. */
  | "escalate"

/**
 * PURE. What the welcome-video manager does with a failed render. SAFE retry only: a re-render when the cause is transient
 * (timeout / unavailable) or has since been FIXED (no avatar → the agent now has one), and only through the spine's own retry
 * door; a refusal (compliance / provider) or the channel gate is a PERSON's call, never a blind re-spend.
 */
export function decidePortalWelcomeRecovery(input: {
  readerState: PortalWelcomeVideo["state"]
  failureKind: PortalWelcomeFailureKind
  /** The agent has a cloned voice + avatar NOW (null = could not read → not retryable on a guess). */
  agentVideoReady: boolean | null
  /** The avatar spine exposes its retry door (lib/video/intro-video-reactor.ts retryAssignmentIntroVideo). */
  retryDoor: boolean
}): { action: PortalWelcomeRecoveryAction; reason: string } {
  if (input.readerState === "unavailable") return { action: "defer", reason: "the portal reader was refused — nothing decided on a guess" }
  if (input.readerState === "ready") return { action: "covered_by_standing_video", reason: "the portal already shows a validated personal video from the agent" }
  if (input.readerState === "preparing") return { action: "in_flight", reason: "a render is in flight again" }
  const retryable =
    input.failureKind === "timeout" || input.failureKind === "unavailable" || (input.failureKind === "no_avatar" && input.agentVideoReady === true)
  if (retryable && input.retryDoor) return { action: "retry", reason: `one bounded re-render (${input.failureKind})` }
  const why =
    input.failureKind === "no_avatar" ? "the agent has no cloned voice / avatar on file — they set it up in Settings → Voice & Avatar, or record a standing personal video in Video Studio, and the portal shows it"
    : input.failureKind === "channel_gate" ? "the avatar spine refused the render on the contact's video channel opt-out — the portal welcome video is not a channel message (owner ruling 6); a person decides until the spine stops applying that gate to it"
    : input.failureKind === "refused" ? "the render was refused (compliance or provider) — a person must review it before anything is spent again"
    : "the render could not be retried automatically (the avatar spine has no retry door for a failed welcome render yet)"
  return { action: "escalate", reason: why }
}

/** The avatar spine's retry door, when it exposes one (contract by NAME — lane 146F Outside-lane in this lane's notes). */
export type PortalWelcomeRetryDoor = (input: { introVideoId: string; brokerageId: string }) => Promise<{ ok?: boolean; status?: string; reason?: string }>

async function resolveRetryDoor(): Promise<PortalWelcomeRetryDoor | null> {
  try {
    const mod = (await import("@/lib/video/intro-video-reactor")) as unknown as Record<string, unknown>
    const door = mod.retryAssignmentIntroVideo
    return typeof door === "function" ? (door as PortalWelcomeRetryDoor) : null
  } catch {
    return null // the spine is server-only / unreachable here — no retry on a guess
  }
}

/** The agent has a cloned voice + an avatar on file NOW. A PRE-CHECK only (the spine re-checks its own gate when it renders):
 *  it keeps the ONE bounded retry from being spent before the cause is fixed. Refused read → null (not retryable). */
async function agentVideoReadyNow(svc: Svc, agentRecordId: string | null): Promise<boolean | null> {
  if (!agentRecordId) return false
  const { data, error } = await svc.from("agent_voice_profiles").select("elevenlabs_voice_id, did_photo_url, did_video_url").eq("agent_id", agentRecordId).maybeSingle()
  if (error) return null
  const p = data as { elevenlabs_voice_id?: string | null; did_photo_url?: string | null; did_video_url?: string | null } | null
  return !!(p?.elevenlabs_voice_id && (p.did_photo_url || p.did_video_url))
}

export interface PortalWelcomeEscalation { escalated: boolean; replay: boolean; errorId: string | null; notified: boolean; error: string | null }

/**
 * TELL A PERSON, ONCE PER CONTACT: the error console (automation_errors through THE one writer, lib/errors/collect-error.ts —
 * tenant-anchored, severity high) and the contact's agent (one notification, recipient tenant through THE one resolver).
 * Idempotent on the action ledger (cycle `portal_welcome_video`): a replay tells nobody twice; a failed escalation is re-tried
 * on the next tick (the ledger re-claims a failed row). NEVER THROWS.
 */
export async function escalatePortalWelcomeVideo(
  svc: Svc,
  p: { brokerageId: string; contactId: string; agentId: string | null; introVideoId: string | null; reason: string; failureKind?: PortalWelcomeFailureKind },
): Promise<PortalWelcomeEscalation> {
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    return await withActionLedger(
      {
        brokerageId: p.brokerageId, action: "welcome_video.portal.escalate", actor: { type: "system" },
        subject: { type: "contact", id: p.contactId }, reasonCode: "CONTACT_WELCOME", channel: "portal", systemSource: PORTAL_WELCOME_VIDEO_WORKFLOW,
        reasonDetail: p.reason.slice(0, 600), cycle: "portal_welcome_video", detail: { intro_video_id: p.introVideoId },
      },
      async (): Promise<PortalWelcomeEscalation> => {
        const { collectError } = await import("@/lib/errors/collect-error")
        const errorId = await collectError({
          // An agent with no avatar on file is a SETUP gap the agent fixes (medium); a refusal, a stall or the spine's channel gate
          // is an incident (high).
          workflowName: PORTAL_WELCOME_VIDEO_WORKFLOW, severity: p.failureKind === "no_avatar" ? "medium" : "high", brokerageId: p.brokerageId, client: svc as never,
          errorMessage: `the personal welcome video for contact ${p.contactId} is not in their portal: ${p.reason}`.slice(0, 1000),
          context: { contactId: p.contactId, agentId: p.agentId, introVideoId: p.introVideoId },
        })
        let notified = false
        if (p.agentId) {
          const { resolveAgentRecipient } = await import("@/lib/notifications/recipient-tenant")
          const who = await resolveAgentRecipient(svc as never, p.agentId)
          if (who.ok && who.userId && who.brokerageId) {
            const { data, error } = await svc.from("notifications").insert({
              user_id: who.userId, brokerage_id: who.brokerageId, type: "welcome_video_not_ready",
              title: "Your client's portal welcome video needs you",
              body: `Your personal welcome video is not in their portal — ${p.reason}`.slice(0, 900),
              entity_type: "contact", entity_id: p.contactId, priority: "medium", is_read: false,
            }).select("id")
            notified = !error && (data ?? []).length === 1
          }
        }
        return { escalated: !!errorId || notified, replay: false, errorId, notified, error: !errorId && !notified ? "neither the error console nor the agent could be written" : null }
      },
      {
        settle: (r) => r.escalated ? { status: "executed", outcome: r.notified ? "escalated_agent_and_console" : "escalated_console" } : { status: "failed", outcome: "escalation_not_written", error: r.error },
        replay: (claim) => ({ escalated: claim.kind === "replay", replay: true, errorId: null, notified: false, error: claim.kind === "replay" ? null : `escalation ${claim.kind}` }),
      },
      { client: svc },
    )
  } catch (e) {
    return { escalated: false, replay: false, errorId: null, notified: false, error: `escalation threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface PortalWelcomeRecovery { action: PortalWelcomeRecoveryAction; outcome: string; reason: string }

/**
 * THE MANAGER'S RECOVERY of a failed welcome render (ruling 6: "failure: portal still works, failure recorded, the existing
 * manager retries safely, human escalation, never a false video-complete state"). Called by the welcome sweeper for a render
 * past its deadline or one the spine recorded failed / suppressed, and at conversion when nothing could be commissioned.
 * The portal is never touched here — its reader already shows nothing false. NEVER THROWS.
 */
export async function recoverPortalWelcomeVideo(
  svc: Svc,
  p: { brokerageId: string; contactId: string; agentId: string | null; introVideoId: string | null; failureKind: PortalWelcomeFailureKind; reason: string; now?: Date },
  deps: { read?: typeof portalWelcomeVideoFor; retryDoor?: PortalWelcomeRetryDoor | null; escalate?: typeof escalatePortalWelcomeVideo; agentVideoReady?: boolean | null } = {},
): Promise<PortalWelcomeRecovery> {
  try {
    const read = deps.read ?? portalWelcomeVideoFor
    const reader = await read(svc, p.brokerageId, p.contactId, { now: p.now })
    const door = deps.retryDoor !== undefined ? deps.retryDoor : (p.introVideoId ? await resolveRetryDoor() : null)
    const ready = deps.agentVideoReady !== undefined ? deps.agentVideoReady : (p.failureKind === "no_avatar" ? await agentVideoReadyNow(svc, p.agentId) : null)
    const d = decidePortalWelcomeRecovery({ readerState: reader.state, failureKind: p.failureKind, agentVideoReady: ready, retryDoor: !!door && !!p.introVideoId })
    const escalate = deps.escalate ?? escalatePortalWelcomeVideo
    if (d.action === "defer" || d.action === "in_flight" || d.action === "covered_by_standing_video") {
      return { action: d.action, outcome: d.action, reason: d.action === "defer" && reader.state === "unavailable" ? reader.reason : d.reason }
    }
    if (d.action === "retry" && door && p.introVideoId) {
      const { withActionLedger } = await import("@/lib/kernel/action-ledger")
      const introVideoId = p.introVideoId
      // ONE retry per contact, ever: the attempt is settled 'executed' whatever the spine answered, so the ledger never re-claims it.
      const tried = await withActionLedger(
        {
          brokerageId: p.brokerageId, action: "welcome_video.portal.retry", actor: { type: "system" },
          subject: { type: "contact", id: p.contactId }, reasonCode: "CONTACT_WELCOME", channel: "portal", systemSource: PORTAL_WELCOME_VIDEO_WORKFLOW,
          reasonDetail: `${p.failureKind}: ${p.reason}`.slice(0, 600), cycle: "portal_welcome_video_retry", detail: { intro_video_id: introVideoId },
        },
        async () => {
          const r = await door({ introVideoId, brokerageId: p.brokerageId })
          return { attempted: true, ok: r?.ok === true, reason: r?.reason ?? r?.status ?? "" }
        },
        {
          settle: (r) => ({ status: "executed", outcome: r.ok ? "retry_accepted" : "retry_refused", error: r.ok ? null : r.reason || null }),
          replay: () => ({ attempted: false, ok: false, reason: "the one retry for this contact was already spent" }),
        },
        { client: svc },
      )
      if (tried.ok) return { action: "retry", outcome: "retry_accepted", reason: "the avatar spine accepted the one re-render — the portal shows it the moment it is validated" }
      const e = await escalate(svc, { brokerageId: p.brokerageId, contactId: p.contactId, agentId: p.agentId, introVideoId: p.introVideoId, failureKind: p.failureKind, reason: `${p.reason} — the automatic re-render did not take (${tried.reason || "refused"})` })
      return { action: "escalate", outcome: e.escalated ? (e.replay ? "already_escalated" : "escalated") : "escalation_failed", reason: e.error ?? tried.reason }
    }
    const e = await escalate(svc, { brokerageId: p.brokerageId, contactId: p.contactId, agentId: p.agentId, introVideoId: p.introVideoId, failureKind: p.failureKind, reason: `${p.reason} — ${d.reason}` })
    return { action: "escalate", outcome: e.escalated ? (e.replay ? "already_escalated" : "escalated") : "escalation_failed", reason: e.error ?? d.reason }
  } catch (e) {
    return { action: "defer", outcome: "threw", reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The sweeper's second pass: welcome renders the SPINE recorded failed / suppressed (never pending, so the first pass never sees
 * them) inside the recovery window go through the ONE recovery above. Platform scope, written down (the cron is CRON_SECRET
 * verified at its route); every row is recovered under its OWN brokerage_id. NEVER THROWS.
 */
export async function recoverFailedPortalWelcomeVideos(
  svc: Svc,
  opts: { now?: Date; limit?: number } = {},
  deps: Parameters<typeof recoverPortalWelcomeVideo>[2] = {},
): Promise<{ examined: number; results: Array<{ id: string; contactId: string; action: string; outcome: string }>; error: string | null }> {
  const now = opts.now ?? new Date()
  const out = { examined: 0, results: [] as Array<{ id: string; contactId: string; action: string; outcome: string }>, error: null as string | null }
  try {
    const since = new Date(now.getTime() - PORTAL_WELCOME_RECOVERY_WINDOW_DAYS * 86_400_000).toISOString()
    const q = applyTenantScope(
      svc.from("agent_intro_videos").select("id, brokerage_id, contact_id, agent_id, status, error_message, video_project_id, created_at")
        .eq("trigger", PORTAL_WELCOME_VIDEO_TRIGGER).in("status", ["failed", "suppressed"]).gte("created_at", since),
      platformScope("the welcome sweeper (/api/cron/intro-video-email-backfill, CRON_SECRET verified at the route) recovers failed portal welcome videos across every tenant; each row is recovered under its own brokerage_id"),
    )
    const { data, error } = await q.order("created_at", { ascending: true }).limit(Math.max(1, Math.min(opts.limit ?? 25, 100)))
    if (error) return { ...out, error: `failed welcome renders unreadable: ${error.message ?? "unknown"} — nothing recovered` }
    for (const r of (data ?? []) as Array<{ id: string; brokerage_id: string | null; contact_id: string | null; agent_id: string | null; status: string | null; error_message: string | null }>) {
      if (!r.brokerage_id || !r.contact_id) continue
      out.examined++
      const rec = await recoverPortalWelcomeVideo(svc, {
        brokerageId: r.brokerage_id, contactId: r.contact_id, agentId: r.agent_id, introVideoId: r.id,
        failureKind: failureKindOf({ status: r.status, errorMessage: r.error_message }), reason: r.error_message?.trim() || `the welcome render is '${r.status}'`, now,
      }, deps)
      out.results.push({ id: r.id, contactId: r.contact_id, action: rec.action, outcome: rec.outcome })
    }
    return out
  } catch (e) {
    return { ...out, error: `recoverFailedPortalWelcomeVideos threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ─── THE CONTACT'S OWN VIEW ──────────────────────────────────────────────────

/**
 * The contact saw their welcome video in their portal — recorded ONCE per render on the action ledger (the portal's own
 * readback of the delivery, from the person's side; the player's view / complete events are /api/video/engagement's). Called by
 * the portal component only when the SESSION is the contact themselves. NEVER THROWS.
 */
export async function recordPortalWelcomeVideoServed(
  svc: Svc,
  p: { brokerageId: string; contactId: string; videoProjectId: string; scope: string; viewerUserId: string },
): Promise<{ recorded: boolean; replay: boolean }> {
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    return await withActionLedger(
      {
        brokerageId: p.brokerageId, action: "welcome_video.portal.served", actor: { type: "user", userId: p.viewerUserId },
        subject: { type: "contact", id: p.contactId }, reasonCode: "CONTACT_WELCOME", channel: "portal", systemSource: PORTAL_WELCOME_VIDEO_WORKFLOW,
        cycle: `portal_welcome_video_served:${p.videoProjectId}`, detail: { video_project_id: p.videoProjectId, scope: p.scope },
      },
      async (): Promise<{ recorded: boolean; replay: boolean }> => ({ recorded: true, replay: false }),
      { settle: () => ({ status: "executed", outcome: "shown_to_contact" }), replay: () => ({ recorded: true, replay: true }) },
      { client: svc },
    )
  } catch {
    return { recorded: false, replay: false }
  }
}
