/**
 * lib/contact-promotion/welcome-avatar-video.ts
 *
 * THE PERSONAL AVATAR VIDEO FROM THE AGENT, COMMISSIONED AT CONVERSION.
 *
 * OWNER RULING, verbatim: "i believe automatic content is being sent from the
 * first moment that the lead becomes a contact like the welcome portal email
 * with a personal avatar video from the agent.. we only sent content to leads
 * and contacts that are personalized and situation, them first messaging."
 *
 * ── WHAT WAS ACTUALLY TRUE WHEN THIS WAS WRITTEN (measured, not assumed) ────
 *
 * The portal half WAS wired: Step 8 of the conversion tail
 * (lib/contact-promotion/portal-access.ts → the ONE invite core) creates the
 * `portal_contact_invites` row and compliance-gates the magic-link mail. The
 * VIDEO half was not wired anywhere on either conversion lane, and the belief
 * that it was is what this module exists to make true.
 *
 * The live counts on project hrvaqgvukzxfskkcrwbt at the time of writing:
 *
 *   lifecycle_events where event_type='contact_agent_assigned'   50
 *   agent_intro_videos (ANY status, ANY trigger)                  0
 *   ai_video_projects                                             0
 *
 * Fifty assignment events and not one video row — not even a 'suppressed' or a
 * 'failed' one, which the reactor writes on the opt-out and the
 * no-voice-profile paths. So `dispatchAssignmentIntroVideo` had never executed
 * for anybody. The reason is a broken half-link, not a missing capability: the
 * m122 Postgres trigger `trg_contacts_emit_agent_assigned` INSERTS a
 * `lifecycle_events` row directly, and that table is audit-only in this schema
 * — nothing polls it back into `dispatchKernelEvent`, so the reactor arm at
 * lib/kernel/event-reactor.ts (E) that would fire the video could only ever be
 * reached by a code path that dispatches the event itself. Exactly one does
 * (lib/ai-isa/book-seller-appointment.ts), and it is not a conversion lane.
 *
 * CLAUDE.md §1 case 2: the capability is wanted and the reader is live, so the
 * MISSING HALF gets BUILT. This is that half — the call the two conversion
 * lanes never made.
 *
 * ── NO SECOND VIDEO PIPELINE. THIS COMMISSIONS NOTHING ITSELF. ──────────────
 *
 * Every line below resolves inputs and delegates to the ONE avatar spine,
 * lib/video/intro-video-reactor.ts `dispatchAssignmentIntroVideo`, which owns:
 * the `video_opt_out` gate, the voice/avatar profile gate, the
 * `agent_intro_videos` idempotency ledger, the compliance-first draft, the
 * pre-flight `evaluateOutbound` + one redraft, the `ai_video_projects` row, the
 * D-ID submission and the poller link. THE REALISM PASS ALSO LIVES THERE
 * (wave 55 — SPOKEN_REALISM_DIRECTIVE on the draft prompt + scanForAiTells
 * folded into that same one-redraft gate, lib/video/realism-profile.ts): this
 * module does not draft or write ANY spoken text, so the directive is NOT
 * duplicated here (§6) — every welcome video this function commissions
 * already inherits it through the spine it delegates to. Its output is what
 * lib/kernel/welcome-personal-video.ts `resolveWelcomePersonalVideo` reads
 * FIRST (scope 'contact_personal'), which is what puts the clip in the welcome
 * email and on the portal card. Building a second commissioning path here
 * would produce a video the welcome could not find.
 *
 * ── BOTH LANES, ONE FUNCTION (§6) ──────────────────────────────────────────
 *
 * There are two converters and they have drifted before — the history carry was
 * wired into the manual lane only, and the note at
 * lib/kernel/lead-acquisition-handlers.ts records it. This function is called
 * from BOTH and neither holds a copy:
 *
 *   · lib/contact-promotion/promote-lead-to-contact.ts  (manual, Step 8b)
 *   · lib/kernel/lead-acquisition-handlers.ts           (automatic assignment)
 *
 * ── FAIL CLOSED, BUT NEVER AT THE CONVERSION'S EXPENSE ─────────────────────
 *
 * NEVER THROWS. The conversion tail is best-effort by construction: the contact
 * exists, its history is re-pointed and the lead is deactivated before this runs.
 * A video that cannot be produced comes back as warnings, exactly like the
 * portal-access failure beside it. It must not block the portal invite and it
 * must not unwind a successful conversion. "Fail closed" here means the
 * COMMISSION refuses (no video, said out loud) — it never means the conversion
 * refuses.
 *
 * ── IDEMPOTENCY, WHICH IS A BILLING PROPERTY (§5) ──────────────────────────
 *
 * A welcome video generated twice is billed twice, in D-ID render credit and in
 * `ai_tool_usage` tokens that feed `meter_readings.ai_tokens` and the overage
 * projection. Two independent guards, in the order that matters:
 *
 *   1. THE CONVERSION'S OWN MARKER. Step 2 of the manual converter answers
 *      "already promoted?" from `leads.contact_id` and returns early, so a
 *      retried promotion never reaches this call at all.
 *   2. THE LEDGER, WHICH DEDUPES **BEFORE** ANY SPEND. Inside the reactor the
 *      `agent_intro_videos` insert is step 4 and the model draft is step 5 —
 *      the live partial unique index
 *      `uq_agent_intro_videos_per_trigger (contact_id, agent_id, trigger,
 *      coalesce(trigger_year,0))` raises 23505 and the reactor returns
 *      'already_queued' having generated nothing and rendered nothing. That
 *      ordering is the reason this module delegates instead of drafting first
 *      and delegating second, and the simulator asserts it.
 *
 * ── THE SPEND IS DELIBERATE AND LOGGED ─────────────────────────────────────
 *
 * `ai_tool_usage` is the cost ledger and a wrong number there is a wrong
 * invoice. The reactor's `draftScript` called `generateTextRouted` with no
 * `brokerageId`, and lib/ai/models.ts writes the ledger row ONLY under
 * `if (request.brokerageId)` — so every intro-video script, and every
 * compliance redraft of one, was unbilled and uncapped. That is fixed at the
 * reactor (it is the spender, so it is the booker); this module's contract is
 * only that it never asks for a draft it has not already deduped.
 */

import {
  buildWelcomeSituation,
  describeDroppedFacts,
  type WelcomeSituationResult,
  type WelcomeOrigin,
} from "./welcome-situation"

/** Machine-readable outcome for the caller's log. */
export type WelcomeAvatarVideoReason =
  /** A render was commissioned (or was already in flight). */
  | "commissioned"
  /** The reactor deduped it — a video for this contact+agent already exists. */
  | "already_commissioned"
  /** The contact turned video off. Their choice, recorded, not an error. */
  | "video_opt_out"
  /** The agent has no cloned voice / avatar. Agent-actionable, not a failure of ours. */
  | "agent_not_video_ready"
  /** This contact type does not get a welcome video. */
  | "excluded_contact_type"
  /** Something needed to decide was missing or refused. Nothing was spent. */
  | "unavailable"
  /** The reactor ran and refused — compliance, provider, or a write. */
  | "refused"

export interface WelcomeAvatarVideoResult {
  /** A render exists or is in flight for this contact after this call. */
  commissioned: boolean
  reason: WelcomeAvatarVideoReason
  /** ai_video_projects.id when a render was submitted this call. */
  videoProjectId: string | null
  /** True when the script was built from real situational facts, not a generic hello. */
  situational: boolean
  /** The resolved ElevenLabs-mapped language code (resolveContactLanguageFromDb
   *  output) this render was commissioned in — DEFAULT_LANGUAGE ("en") when
   *  resolution fell through every tier, null when no render was commissioned. */
  language: string | null
  /** Everything the operator needs to know. NEVER a reason to unwind. */
  warnings: string[]
}

export interface WelcomeAvatarVideoParams {
  /** contacts.id — the PRIMARY key (contacts also has a secondary `contact_id`). */
  contactId: string
  /** agents.id of the assigned agent. `agents.id` and `users.id` are DISJOINT. */
  agentId: string
  /** The tenant. Resolved by the caller from the lead/contact it already read. */
  brokerageId: string
  /** Owner ruling 2026-09-10 (wave 51): an open-house-sourced contact's welcome
   *  video "may mention the visit" — threaded into the same situation builder the
   *  welcome email uses, so the script gains one more them-first fact, not a
   *  second commissioning path. */
  origin?: WelcomeOrigin | null
}

/**
 * Contact types that get NO welcome avatar video, mirroring the portal
 * exclusion for the same reason: a vendor or a referral partner is a
 * counterparty, not a client, and an agent's personal "welcome to working with
 * me" piece to camera is not addressed to them.
 *
 * Deliberately NOT imported from portal-access.ts even though the list matches
 * today: these are two product decisions that happen to agree, and coupling
 * them would mean a future portal change silently re-aimed a video.
 */
export const WELCOME_VIDEO_EXCLUDED_CONTACT_TYPES: readonly string[] = ["vendor", "referral_partner"]

/**
 * Commission the assigned agent's personal, situation-personalised welcome
 * avatar video for a newly-converted contact.
 *
 * NEVER THROWS. Every refusal is a `warnings` line and a `reason`.
 */
export async function ensureWelcomeAvatarVideo(
  supabase: any,
  params: WelcomeAvatarVideoParams,
): Promise<WelcomeAvatarVideoResult> {
  const out: WelcomeAvatarVideoResult = {
    commissioned: false,
    reason: "unavailable",
    videoProjectId: null,
    situational: false,
    language: null,
    warnings: [],
  }

  if (!params.contactId || !params.agentId || !params.brokerageId) {
    out.warnings.push(
      `welcome avatar video NOT commissioned: missing ${
        !params.contactId ? "contactId" : !params.agentId ? "agentId" : "brokerageId"
      }. Nothing was spent.`,
    )
    return out
  }

  // ── READ THE CONTACT. Never the lead (§5 conversion is FINAL). ────────────
  // The tenant predicate is on the query, not trusted from the row: this runs on
  // a SERVICE client, so the brokerage the caller resolved is the only thing
  // pinning the read.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select(
      "id, contact_type, contact_persona, timeline, city, state, property_type, budget_min, budget_max, beds, video_opt_out",
    )
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  // THE ONE LANGUAGE RESOLVER (§6), resolved ONCE, here, for the moment wave
  // 50's hardening pass found had none: the first-touch WELCOME avatar video.
  // Best-effort — a resolution failure falls to DEFAULT_LANGUAGE inside the
  // resolver itself, never blocks the commission.
  let language: string | undefined
  try {
    const { resolveContactLanguageFromDb } = await import("@/lib/video/multilingual-reel")
    language = await resolveContactLanguageFromDb(supabase, params.contactId)
  } catch { /* falls to the reactor's own DEFAULT_LANGUAGE fallback */ }
  out.language = language ?? null

  // supabase-js RESOLVES refusals. An unread error here reads exactly like "no
  // such contact", and the difference matters: one is a tenant mismatch worth
  // shouting about, the other is a race with a deleted row.
  if (contactError) {
    out.warnings.push(
      `welcome avatar video NOT commissioned for contact ${params.contactId}: the contact read was ` +
        `refused (${contactError.message}). Nothing was spent.`,
    )
    return out
  }
  if (!contact) {
    out.warnings.push(
      `welcome avatar video NOT commissioned: contact ${params.contactId} is not in brokerage ` +
        `${params.brokerageId}. Nothing was spent.`,
    )
    return out
  }

  const contactType = (contact.contact_type ?? "").toLowerCase()
  if (WELCOME_VIDEO_EXCLUDED_CONTACT_TYPES.includes(contactType)) {
    out.reason = "excluded_contact_type"
    return out
  }

  // The reactor gates on this too and records a 'suppressed' ledger row. Reading
  // it here as well is not duplication — it lets the conversion report the
  // contact's own choice as a fact rather than as a failed video.
  if (contact.video_opt_out === true) {
    out.reason = "video_opt_out"
    out.warnings.push(
      `no welcome video for contact ${params.contactId}: they have video_opt_out set. The portal ` +
        `invite is unaffected.`,
    )
    return out
  }

  // ── THE SITUATION. Compliance-screened BEFORE it can reach a prompt. ──────
  const situation: WelcomeSituationResult = buildWelcomeSituation(contact, { origin: params.origin ?? null })
  out.situational = situation.isSituational
  out.warnings.push(...situation.warnings)
  out.warnings.push(...describeDroppedFacts(situation.droppedFacts))
  if (!situation.isSituational) {
    // Honest, not fatal. A contact we know nothing about still deserves a hello;
    // what it must not get is invented detail. Say so, so the CRM gets fixed.
    out.warnings.push(
      `welcome video for contact ${params.contactId} has NO situational facts to work from ` +
        `(no type, timeline, market, persona, property type, budget or bed count on the row) — ` +
        `it will be a warm hello with nothing invented.`,
    )
  }

  // ── DELEGATE TO THE ONE SPINE ─────────────────────────────────────────────
  // DYNAMIC IMPORT ON PURPOSE. intro-video-reactor.ts is `server-only`; a static
  // import would drag it into every module graph that reaches the converter,
  // including the plain `tsx` simulators, which crash on `server-only` at load.
  // Same reason portal-access.ts defers the invite core.
  try {
    const { dispatchAssignmentIntroVideo } = await import("@/lib/video/intro-video-reactor")
    const r = await dispatchAssignmentIntroVideo({
      brokerageId: params.brokerageId,
      contactId: params.contactId,
      agentId: params.agentId,
      // BOTH: the clip belongs in the welcome email AND on the portal card —
      // that is the ruling's "in the emila and in the portal".
      delivery: "both",
      language,
      situation: {
        facts: situation.facts,
        complianceDirectives: situation.complianceDirectives,
      },
    })

    out.videoProjectId = r.videoProjectId ?? null

    if (r.status === "already_queued") {
      // The idempotency ledger caught it BEFORE the draft. Nothing was spent.
      out.commissioned = true
      out.reason = "already_commissioned"
      return out
    }
    if (r.status === "suppressed") {
      out.reason = "video_opt_out"
      return out
    }
    if (r.ok) {
      out.commissioned = true
      out.reason = "commissioned"
      return out
    }

    // A refusal. Distinguish the agent-actionable one, because "this agent has
    // never recorded an avatar" is a setup task and not an incident.
    if (r.reason === "agent voice/avatar profile not configured") {
      out.reason = "agent_not_video_ready"
      out.warnings.push(
        `no welcome video for contact ${params.contactId}: the assigned agent has no cloned voice / ` +
          `avatar on file. They set one up in Settings → Voice & Avatar; the welcome email and portal ` +
          `card ship without a video block rather than promising a recording that does not exist.`,
      )
      return out
    }

    out.reason = "refused"
    out.warnings.push(
      `welcome avatar video NOT commissioned for contact ${params.contactId}: ${r.reason ?? "the reactor refused"}` +
        (r.violations?.length ? ` — ${r.violations.join("; ").slice(0, 400)}` : ""),
    )
    return out
  } catch (e: any) {
    // The spine is unavailable (a bad import, a thrown client). The conversion
    // is already committed and must not care.
    out.reason = "unavailable"
    out.warnings.push(
      `welcome avatar video NOT commissioned for contact ${params.contactId}: ` +
        `${e?.message ?? "the avatar spine is unavailable"}. The portal invite is unaffected.`,
    )
    return out
  }
}

// ─── WAVE 144: THE VIDEO FOLLOWS THE WELCOME (owner ruling 13) ───────────────

export type WelcomeVideoFollowUpState =
  /** A provider accepted the follow-up. */
  | "sent"
  /** The owning manager's posture holds it for approval (it is in the approval queue — not a refusal). */
  | "held"
  /** The note could not be written / the gate deferred it — try again on the sweeper's next tick (inside the deadline). */
  | "retry"
  /** Not sendable (no email, opted out, foreign contact, no owning manager, the gate refused) — said, never pretended. */
  | "refused"

export interface WelcomeVideoFollowUpResult {
  state: WelcomeVideoFollowUpState
  reason: string
  messageId?: string | null
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * THE ONE FOLLOW-UP THAT CARRIES THE AGENT'S PERSONAL VIDEO, sent after the welcome already went (wave 144: "dispatch the
 * immediately available welcome and follow with the video when the real asset is ready"). Called by the welcome sweeper
 * (/api/cron/intro-video-email-backfill) for a `send_video_follow_up` verdict — never at conversion.
 *
 * NO SECOND RAIL. The note is written by THE client-message writer (lib/agents/generate-client-message.ts — compliance redraft,
 * brand voice, no figures) and travels through THE governed dispatcher (dispatchEmail: consent, suppression, de-confliction,
 * the OWNING welcome manager's autonomy posture, the budget pre-flight) from the assigned agent's own sender, with the video
 * embedded by THE embed helper the welcome itself uses (lib/ai-isa/video-generator.ts embedVideoInEmail). The writer's neutral
 * fallback is NEVER sent: an unwritten note is `retry`.
 *
 * ONCE, EVER: the dispatcher's action-ledger cycle `welcome_video_follow_up` (one per contact) replays a retried tick instead of
 * mailing twice; the sweeper stamps the agent_intro_videos row terminal only on a provider accept. NEVER THROWS.
 * @proofSeam the caller is /api/cron/intro-video-email-backfill (wave 144 Outside-lane note); scripts/conversion-welcome-simulator.ts drives every arm with recorder seams.
 */
export async function deliverWelcomeVideoFollowUp(
  svc: { from: (t: string) => any },
  p: { contactId: string; brokerageId: string; agentId?: string | null; videoUrl: string; videoProjectId?: string | null; posterUrl?: string | null },
  deps: {
    message?: (brief: Record<string, unknown>) => Promise<{ subject: string; body: string; generated: boolean }>
    dispatchEmail?: (params: Record<string, unknown>) => Promise<{ success: boolean; providerKey?: string; messageId?: string; error?: string }>
  } = {},
): Promise<WelcomeVideoFollowUpResult> {
  try {
    if (!p.contactId || !p.brokerageId || !p.videoUrl) return { state: "refused", reason: "missing contact, brokerage or video" }
    const { data: c, error } = await svc.from("contacts")
      .select("id, first_name, email, email_opt_out, email_unsubscribed, contact_type, agent_id, video_opt_out")
      .eq("id", p.contactId).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) return { state: "retry", reason: `contact read refused: ${error.message}` }
    if (!c) return { state: "refused", reason: "contact not in this brokerage" }
    if (!c.email || c.email_opt_out || c.email_unsubscribed) return { state: "refused", reason: "no usable email (missing or opted out) — the video stays on the portal card" }
    if (c.video_opt_out === true) return { state: "refused", reason: "the contact turned video off" }

    const { resolveWelcomeManagers } = await import("@/lib/kernel/client-welcome")
    const owningManager = resolveWelcomeManagers(c.contact_type)[0]
    if (!owningManager) return { state: "refused", reason: `contact_type '${c.contact_type ?? "null"}' is picked up by no welcome manager` }

    // agents.id → users.id only through agents.user_id (the two id spaces are disjoint).
    const agentId = p.agentId ?? c.agent_id ?? null
    let agentUserId: string | null = null
    if (agentId) {
      const { data: ag, error: agErr } = await svc.from("agents").select("user_id").eq("id", agentId).eq("brokerage_id", p.brokerageId).maybeSingle()
      if (agErr) return { state: "retry", reason: `agent read refused: ${agErr.message}` }
      agentUserId = (ag as { user_id?: string | null } | null)?.user_id ?? null
    }

    const write = deps.message ?? (async (b) => (await import("@/lib/agents/generate-client-message")).generateClientMessage(b as never))
    const note = await write({
      brokerageId: p.brokerageId, agentUserId, audience: c.contact_type === "seller" ? "seller" : "buyer", recipientFirstName: c.first_name ?? null,
      purpose: "Two or three warm sentences that FOLLOW the client's welcome email: their agent recorded a short personal video for them — invite them to watch it below and to reply with any question. No sales pitch, no figures, no promises.",
      fallback: { subject: "A personal video from your agent", body: "I recorded a short video for you — it is below." },
    })
    if (!note.generated || !note.body.trim()) return { state: "retry", reason: "the note could not be written (gateway / compliance redraft failed) — the neutral fallback is never sent" }

    const { embedVideoInEmail } = await import("@/lib/ai-isa/video-generator")
    const html = await embedVideoInEmail(`<p>${escText(note.body).replace(/\n/g, "<br>")}</p>[Video will be embedded here]`, escAttr(p.videoUrl), p.posterUrl ? escAttr(p.posterUrl) : null)
    const send = deps.dispatchEmail ?? (async (params) => (await import("@/lib/providers/dispatch")).dispatchEmail(params as never))
    const r = await send({
      brokerageId: p.brokerageId, contactId: p.contactId, userId: agentUserId, agentId: agentId ?? undefined, sendAsAgentUserId: agentUserId,
      to: c.email, subject: note.subject, html, text: `${note.body}\n\n${p.videoUrl}`,
      channelPurpose: "conversation", systemSource: "client_welcome", managerKey: owningManager,
      ledger: { reasonCode: "CONTACT_WELCOME", cycle: "welcome_video_follow_up", reasonDetail: "the personal welcome video, following the welcome (wave 144)" },
      metadata: { welcome_video_follow_up: true, welcome_video_project_id: p.videoProjectId ?? null },
    })
    if (r.success) return { state: "sent", reason: "the personal video followed the welcome", messageId: r.messageId ?? null }
    if (r.providerKey === "autonomy_gate") return { state: "held", reason: r.error ?? "held for approval" }
    if (r.providerKey && /deconflict/i.test(r.providerKey)) return { state: "retry", reason: r.error ?? "deferred by de-confliction" }
    return { state: "refused", reason: r.error ?? "the send gate refused" }
  } catch (e) {
    return { state: "retry", reason: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ─── WAVE 144: THE WELCOME'S OWN STATE, FOR THE SWEEPER ──────────────────────

/**
 * Has this contact's ONE welcome gone out? Read from the survivor's own idempotency tag
 * (agent_client_messages.rationale `client_welcome_v1…`, lib/kernel/client-welcome.ts WELCOME_RATIONALE_TAG) — the
 * same row ensureClientWelcome dedupes on, so the sweeper and the composer can never disagree about "already welcomed".
 * Tenant-pinned (a service client: the brokerage on the query is the only pin). A REFUSED read returns null, and
 * classifyPendingWelcome then waits and stamps nothing (fail closed — supabase-js resolves a refusal).
 * @proofSeam the caller is /api/cron/intro-video-email-backfill (wave 144 Outside-lane note in $S/lane144F-notes.md: the sweeper passes this state to classifyPendingWelcome and sends deliverWelcomeVideoFollowUp on `send_video_follow_up`); scripts/conversion-welcome-simulator.ts drives every state.
 */
export async function readWelcomeState(
  svc: { from: (t: string) => any },
  a: { contactId: string; brokerageId: string },
): Promise<import("./conversion-welcome").WelcomeMessageState | null> {
  if (!a.contactId || !a.brokerageId) return null
  const { WELCOME_RATIONALE_TAG } = await import("@/lib/kernel/client-welcome")
  const { data, error } = await svc.from("agent_client_messages").select("id, status")
    .eq("brokerage_id", a.brokerageId).eq("recipient_contact_id", a.contactId).ilike("rationale", `${WELCOME_RATIONALE_TAG}%`).limit(5)
  if (error) return null
  const rows = (data ?? []) as Array<{ status: string | null }>
  if (rows.length === 0) return "none"
  if (rows.some((r) => r.status === "sent")) return "sent"
  if (rows.some((r) => r.status === "proposed" || r.status === "approved")) return "held"
  return "failed"
}
