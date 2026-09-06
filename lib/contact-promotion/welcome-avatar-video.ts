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
 * D-ID submission and the poller link. Its output is what
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
  const situation: WelcomeSituationResult = buildWelcomeSituation(contact)
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
