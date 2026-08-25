/**
 * lib/kernel/client-welcome.ts
 *
 * THE WELCOME PACKAGE — and it is FOUR things, not one.
 *
 * OWNER RULING, verbatim: "the contact gets access to their portal so the
 * welcome package is getting an email from the assigned agent with portal
 * access and in the emila and in the portal a personal video from agent. the
 * agent also gets notified of the new contact and confirmation that the welcome
 * paket was sent."
 *
 *   (a) an email FROM THE ASSIGNED AGENT — not the brokerage, not a generic sender
 *   (b) carrying portal access
 *   (c) carrying a PERSONAL VIDEO from that agent, in the email AND in the portal
 *   (d) the agent is told "you have a new contact" AND "the welcome packet was sent"
 *
 * ── WHAT THIS USED TO DO, AND WHY THAT COULD NOT SATISFY THE RULING ─────────
 *
 * `ensureClientWelcome` wrote ONE GATED DRAFT to `agent_client_messages`
 * (status 'proposed') and stopped. Approval of a client_message lives only in
 * the admin Command Center (app/actions/command-center.ts gates it to
 * admin / broker / broker_owner) and is absent from the agent /approvals queue,
 * so THE ASSIGNED AGENT STRUCTURALLY CANNOT APPROVE THEIR OWN WELCOME. On the
 * default path nothing was ever sent — the draft simply aged in a queue the
 * person it was written for could not reach.
 *
 * ── THE APPROVAL RULE APPLIED HERE, AND THE ARGUMENT FOR IT ─────────────────
 *
 * "Just send it unapproved" is not the answer, and neither is per-message
 * approval. An AI-authored message going to a client under a named human's
 * signature is exactly what the brand-voice / Fair-Housing gate exists for. So
 * the welcome sends as a GOVERNED AUTONOMOUS MANAGER SEND — `dispatchEmail`
 * with `managerKey` set (shopping_agent for buyers, listing_concierge for
 * sellers). That is not a bypass; it moves the human judgement from a
 * per-message click the agent cannot make to the standing, broker-set,
 * revocable, audited posture the platform already enforces:
 *
 *   · lib/managers/autonomy-gate — an explicit `approval_required` posture
 *     (broker override or eval-derived probation), a platform emergency halt, a
 *     per-tenant staff halt, or a failed prediction-accuracy gate HOLDS the send.
 *     When it holds, the draft stays 'proposed' and the Command Center approval
 *     path (approveClientMessage) sends it exactly as before. Nothing regressed.
 *   · setting `managerKey` also arms `contentSafetyBackstop` in HARD-BLOCK mode
 *     (isAutonomousSend), so a Fair-Housing violation in the FINAL assembled
 *     content refuses the send outright rather than being flagged-and-allowed.
 *   · the copy itself is authored against a fixed FACT SET (the journey map) by
 *     generatePersonaCopy, whose system prompt forbids inventing anything beyond
 *     those facts, and whose guaranteed fallback is the deterministic,
 *     Fair-Housing-clean composition below.
 *   · every consent gate on the canonical rail still runs unchanged:
 *     suppression list, per-channel opt-out, evaluateOutboundCompliance,
 *     de-confliction, vendor budget.
 *
 * ── THE "SENT" CLAIM IS BACKED BY A PROVIDER RESULT, NEVER BY A CALL ────────
 *
 * `agent_client_messages.status` is flipped to 'sent' ONLY when
 * dispatchEmail returns `success === true`, and the provider key + provider
 * message id are appended to `rationale` as the evidence line. A refusal writes
 * status 'failed' with the refusal text in `send_error`. A HELD send leaves the
 * row 'proposed'. app/actions/lead-handoff/pending-handoffs.ts reads that column
 * and prints exactly what it says — so making the surface's claim true meant
 * making the send real, not making the wording softer.
 *
 * ── THE PERSONAL VIDEO DEGRADES HONESTLY ───────────────────────────────────
 *
 * lib/kernel/welcome-personal-video.ts READS the existing avatar spine
 * (intro-video-reactor → agent_intro_videos → ai_video_projects, resolved by
 * lib/video/playable-video). It commissions nothing and waits for nothing. If no
 * finished personal video from THAT agent exists, the welcome ships with NO
 * video block and says nothing about video — a "your video is coming" placeholder
 * under a named human's signature implies a recording they never made. The
 * agent's own notification carries the reason so they can fix it.
 *
 * Idempotent per contact via the rationale tag. Best-effort throughout: a
 * welcome is care, never a dependency — it must never fail contact creation.
 * PURE composer + a thin ensure; NOT server-only (every server dependency is a
 * dynamic import so the simulators can load the composer).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-08-25 — THIS IS NOW **THE** WELCOME EMAIL. THERE IS ONLY ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OWNER RULING, verbatim: "the welcome email is the first on conversion that has
 * the welcome with portal info to also inclue the embedded personal video." With
 * his earlier one — "the video for the welcome email/portal info for the newly
 * converted lead to contact, FINISHES AND THEN EMBEDS into the email" — the
 * design is unambiguous: ONE email, the FIRST thing a converted contact
 * receives, carrying portal information AND the embedded personal avatar video.
 * The email WAITS for the video; the video never arrives in a second, later mail.
 *
 * THREE senders were doing welcome-ish work and this one is the SURVIVOR (§1.1),
 * chosen on evidence, not on name — it is the only one of the three that already
 * carried all four required parts: portal block, agent signature
 * (sendAsAgentUserId → the agent's own mailbox), a video block, and compliance
 * gating (managerKey arms contentSafetyBackstop in hard-block mode on top of the
 * canonical consent rail). The two retired duplicates:
 *
 *   · lib/portal/portal-invite-core.ts — its HARDCODED GENERIC portal greeting
 *     ("Hi ${first_name}, your client portal is ready. Log in to track your
 *     journey.") is gone; the tombstone there names `writePortalWelcomeCard`
 *     below. Live evidence for the retirement: client_portal_messages held ZERO
 *     rows on hrvaqgvukzxfskkcrwbt. The invite ROW — the actual portal access —
 *     is untouched and still created immediately at conversion.
 *   · app/api/cron/intro-video-email-backfill — it no longer AUTHORS an email.
 *     It is now the SWEEPER that releases this one welcome once the render lands
 *     (or once the wait deadline says it never will).
 *
 * WHAT WAS MERGED ONTO THIS SURVIVOR BEFORE THEY WERE RETIRED:
 *   (1) `videoOverride` — the cron knew the assembled composite's URL a tick
 *       before render-composition stamps it onto ai_video_projects.video_url.
 *       That knowledge had no home here, so it was added rather than dropped.
 *   (2) THEM-FIRST SITUATIONAL COPY — lib/contact-promotion/welcome-situation.ts
 *       (compliance-first: a HIGH-severity fair-housing phrase in the CRM row is
 *       DROPPED before the prompt, medium/low rides through as a warning, a named
 *       market forces its own steering ban). Owner ruling: "we only sent content
 *       to leads and contacts that are personalized and situation, them first
 *       messaging." No second personalizer was written — this calls that one.
 *   (3) `resolveWelcomeSide` is EXPORTED, so the conversion lane can ask "will an
 *       agent-signed welcome go out for this contact type?" BEFORE it decides
 *       whether the portal invite's own magic-link mail is needed as the fallback
 *       delivery. That is what keeps the count at exactly one email per contact —
 *       never two, never zero.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildWelcomeSituation,
  describeDroppedFacts,
  type WelcomeSituationContact,
} from "@/lib/contact-promotion/welcome-situation"

type Svc = SupabaseClient<any, any, any>

export const WELCOME_RATIONALE_TAG = "client_welcome_v1"

/** systemSource stamped on the governed dispatch — greppable in vendor usage. */
const WELCOME_SYSTEM_SOURCE = "client_welcome"

const BUYER_JOURNEY = [
  "We get clear on what you want (and what you don't)",
  "You see curated homes with my reasoning — never a firehose",
  "We tour, we compare, we decide at YOUR pace",
  "When it's the one, I run the offer and the paperwork",
  "You get the keys — and I stay your resource for years",
]

const SELLER_JOURNEY = [
  "We walk your home and build the pricing story together",
  "Prep and staging get a plan, not a scramble",
  "Launch week runs on a schedule you'll see in advance",
  "Every showing and offer comes back to you with my read",
  "We close — and I keep watching your equity after",
]

/** PURE deterministic FALLBACK (owner rule: content is never hardcoded —
 *  production routes through generatePersonaCopy with THIS as the guaranteed
 *  floor; the journey steps are the FACTS the generator may rephrase but
 *  never invent beyond). */
export function composeClientWelcome(input: {
  side: "buyer" | "seller"
  addressAs: string
  agentName: string | null
}): { subject: string; body: string } {
  const steps = input.side === "buyer" ? BUYER_JOURNEY : SELLER_JOURNEY
  const who = input.agentName ? `I'm ${input.agentName}, and my` : `My`
  return {
    subject: input.side === "buyer" ? "Welcome — here's how we'll find your home" : "Welcome — here's how we'll sell your home",
    body: [
      `${input.addressAs}, welcome. ${who} whole team is now working for you — here's the map so you always know where we are:`,
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      `You'll never have to chase me for a status — updates come to you, and every one ends with "here's what's next." Questions at any hour go to your portal; a human reads everything.`,
    ].join("\n"),
  }
}

// ─── The email body (PURE) ───────────────────────────────────────────────────

/**
 * The `[Video will be embedded here]` token `embedVideoInEmail` substitutes.
 * It is written into the HTML **only when a playable video actually exists** —
 * that helper replaces the token with a "being prepared" note when handed a null
 * URL, and that note is precisely the false implication this package refuses to
 * make under an agent's name.
 */
const VIDEO_EMBED_TOKEN = "[Video will be embedded here]"

interface WelcomeEmailInput {
  /** The authored (or fallback) welcome copy — plain text, newline separated. */
  body: string
  /** Absolute URL of the client's portal. Omitted → no portal block. */
  portalUrl: string | null
  /** True when a REAL finished personal video from this agent was resolved. */
  hasVideo: boolean
  agentFirstName: string | null
}

/** PURE — the welcome email's HTML body, before the kernel's assembly order
 *  (body → signature → unsubscribe → legal) is applied by dispatchEmail. */
function composeWelcomeEmailHtml(input: WelcomeEmailInput): string {
  const paragraphs = input.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p style="margin:0 0 12px;line-height:1.55;">${escapeHtml(line)}</p>`)
    .join("\n")

  // The video block carries NO hedge and NO placeholder — it exists only when
  // there is something to play.
  const videoBlock = input.hasVideo
    ? `<p style="margin:20px 0 8px;line-height:1.55;">I recorded something for you — here it is:</p>\n${VIDEO_EMBED_TOKEN}`
    : ""

  const portalBlock = input.portalUrl
    ? `
<div style="margin:24px 0;padding:16px;border:1px solid #e5e7eb;border-radius:8px;">
  <p style="margin:0 0 10px;line-height:1.55;"><strong>Your private portal is open.</strong> Everything about your move lives there — updates, documents, and a way to reach ${input.agentFirstName ? escapeHtml(input.agentFirstName) : "me"} at any hour.</p>
  <p style="margin:0 0 6px;"><a href="${input.portalUrl}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;">Open your portal</a></p>
  <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">Sign in with this email address — no password to remember.</p>
</div>`
    : ""

  return [paragraphs, videoBlock, portalBlock].filter(Boolean).join("\n")
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ─── The live ensure ─────────────────────────────────────────────────────────

/** What actually happened. Every value is a FACT the ledger can back. */
export type WelcomeSendState =
  /** Provider accepted the send. `agent_client_messages.status = 'sent'`. */
  | "sent"
  /** The autonomy gate / a halt held it — the draft awaits Command Center approval. */
  | "held_for_approval"
  /** A gate or the provider refused. Ledger row is 'failed' with the reason. */
  | "send_failed"
  /** No assigned agent — nobody for the welcome to be FROM. Gated draft written. */
  | "no_assigned_agent"
  /** No reachable email — the welcome was written to the portal rail instead. */
  | "no_email_on_file"
  /** Not a buyer/seller client, or a welcome already exists. Nothing written. */
  | "skipped"

export interface WelcomeOutcome {
  /** A governed ledger row exists for this contact (kept for the prior contract). */
  proposed: boolean
  /** A provider ACCEPTED the welcome email. Never true without a provider result. */
  sent: boolean
  state: WelcomeSendState
  /** agent_client_messages.id, when a row was written. */
  messageId: string | null
  /** Human-readable reason when `state` is not 'sent'. */
  reason: string | null
  /** True only when a REAL playable personal video rode along. */
  videoIncluded: boolean
  /** Why there was no video — the honest degradation, surfaced to the agent. */
  videoReason: string | null
  /** A portal invite row exists for this contact. */
  portalAccess: boolean
  /** True when the copy was built from REAL facts about this contact, not a generic hello. */
  situational: boolean
  /**
   * Fair-housing advisories and hard DROPS found in the contact's own CRM free
   * text while building the situation. A drop means a human should look at the
   * row — the fact never reached the writing prompt (§5).
   */
  situationWarnings: string[]
}

const SKIPPED: WelcomeOutcome = {
  proposed: false, sent: false, state: "skipped", messageId: null,
  reason: null, videoIncluded: false, videoReason: null, portalAccess: false,
  situational: false, situationWarnings: [],
}

/**
 * DOES THIS CONTACT TYPE GET AN AGENT-SIGNED WELCOME, AND ON WHICH JOURNEY?
 *
 * EXPORTED because the conversion lane must ask this question BEFORE it grants
 * portal access: when the answer is a side, the agent's welcome IS the delivery
 * and the invite core's own magic-link mail must be suppressed (one email, per
 * the ruling). When the answer is null, that magic link is the ONLY thing that
 * would ever tell the contact their portal exists, so it must still go. One
 * function answers it for both callers — two spellings of "who gets a welcome"
 * is exactly the §6 defect that produced three senders in the first place.
 *
 * `investor` maps to the BUYER journey and `both` to the SELLER journey: a
 * dual-sided move starts with the home they already own. `vendor` and
 * `referral_partner` are counterparties, not clients — the same exclusion
 * lib/contact-promotion/portal-access.ts applies to the portal itself.
 */
export function resolveWelcomeSide(contactType: string | null | undefined): "buyer" | "seller" | null {
  const type = (contactType ?? "").trim().toLowerCase()
  if (!type) return null
  if (type === "vendor" || type === "referral_partner") return null
  if (type === "both") return "seller"
  if (type === "investor") return "buyer"
  if (type.includes("seller")) return "seller"
  if (type.includes("buyer")) return "buyer"
  return null
}

/**
 * The video the welcome is allowed to embed. Structurally the same union
 * lib/kernel/welcome-personal-video.ts returns, widened at `scope` to a plain
 * string so a CALLER-SUPPLIED override (the sweeper's assembled composite) fits
 * the same shape as a locally-resolved clip and travels the same code path.
 */
type ResolvedWelcomeVideo =
  | { state: "ready"; videoUrl: string; thumbnailUrl: string | null; scope: string; videoProjectId: string }
  | { state: "in_progress"; reason: string }
  | { state: "none"; reason: string }

/**
 * A finished video the CALLER already resolved. The sweeper reads the assembled
 * composite's URL off the Remotion render row a tick before render-composition
 * stamps it onto `ai_video_projects.video_url`; without this the welcome would
 * either mail the un-assembled avatar track or wait an extra tick for a stamp it
 * can already see. Supplying it SKIPS the local lookup entirely.
 */
export interface WelcomeVideoOverride {
  videoUrl: string
  thumbnailUrl: string | null
  /** Provenance, carried verbatim into the ledger evidence line. */
  scope: string
  videoProjectId: string
}

export interface EnsureClientWelcomeOptions {
  videoOverride?: WelcomeVideoOverride | null
}

/**
 * LIVE: produce and SEND the welcome package for a newly-added client.
 * Best-effort (never fails contact creation); idempotent per contact.
 */
export async function ensureClientWelcome(svc: Svc, contact: {
  id: string
  brokerageId: string
  contactType: string | null
  firstName: string | null
  lastName: string | null
  preferredName?: string | null
}, opts: EnsureClientWelcomeOptions = {}): Promise<WelcomeOutcome> {
  const side = resolveWelcomeSide(contact.contactType)
  if (!side) return SKIPPED

  // IDEMPOTENCY. Same tag the first-touch surface reads.
  const { data: prior, error: priorError } = await svc.from("agent_client_messages")
    .select("id")
    .eq("recipient_contact_id", contact.id)
    .ilike("rationale", `${WELCOME_RATIONALE_TAG}%`)
    .limit(1).maybeSingle()
  // supabase-js RESOLVES a refusal: an unchecked error here reads exactly like
  // "no welcome yet" and would send a SECOND welcome to a client who already
  // had one. Fail closed — a missing welcome is recoverable, a duplicate is not.
  if (priorError) return { ...SKIPPED, reason: `welcome ledger unreadable: ${priorError.message}` }
  if (prior) return SKIPPED

  // ── WHO IS THIS FROM, AND WHERE DOES IT GO ─────────────────────────────────
  // contacts.agent_id is an AGENTS id; agents.id and users.id are DISJOINT, so
  // the users id is reached only through agents.user_id.
  const { data: contactRow, error: contactError } = await svc
    .from("contacts")
    .select(
      "id, agent_id, email, email_opt_out, email_unsubscribed, preferred_name, first_name, last_name, " +
        // THE SITUATION (them-first ruling). Every one of these is a live column on
        // `contacts` that the converter carries across from the lead — the welcome
        // never reaches back to `leads`, because conversion is FINAL (§5).
        "contact_type, contact_persona, timeline, city, state, property_type, budget_min, budget_max, beds",
    )
    .eq("id", contact.id)
    .maybeSingle()
  if (contactError) return { ...SKIPPED, reason: `contact unreadable: ${contactError.message}` }
  const c = (contactRow ?? {}) as {
    agent_id?: string | null; email?: string | null
    email_opt_out?: boolean | null; email_unsubscribed?: boolean | null
    preferred_name?: string | null; first_name?: string | null; last_name?: string | null
  } & WelcomeSituationContact
  const agentRecordId = c.agent_id ?? null

  let agentUserId: string | null = null
  let agentName: string | null = null
  let agentFirstName: string | null = null
  if (agentRecordId) {
    const { data: agentRow, error: agentError } = await svc
      .from("agents").select("user_id").eq("id", agentRecordId).maybeSingle()
    if (agentError) return { ...SKIPPED, reason: `agent record unreadable: ${agentError.message}` }
    agentUserId = ((agentRow as { user_id?: string | null } | null)?.user_id) ?? null
    if (agentUserId) {
      const { data: u } = await svc.from("users")
        .select("first_name, last_name").eq("id", agentUserId).maybeSingle()
      const uu = (u ?? {}) as { first_name?: string | null; last_name?: string | null }
      agentFirstName = uu.first_name ?? null
      agentName = [uu.first_name, uu.last_name].filter(Boolean).join(" ").trim() || null
    }
  }

  // ── THE COPY ───────────────────────────────────────────────────────────────
  const { resolveAddressing } = await import("@/lib/kernel/addressing")
  const addressing = resolveAddressing({
    firstName: contact.firstName ?? c.first_name ?? null,
    lastName: contact.lastName ?? c.last_name ?? null,
    preferredName: contact.preferredName ?? c.preferred_name ?? null,
    namePronunciation: null, salutationStyle: null,
  })
  const fallback = composeClientWelcome({ side, addressAs: addressing.addressAs, agentName })

  // PERSONA-GENERATED body (never hardcoded); the deterministic journey map is
  // the fact set AND the guaranteed fallback — the generator personalizes,
  // it never invents steps.
  const steps = side === "buyer" ? BUYER_JOURNEY : SELLER_JOURNEY

  // ── THEM-FIRST, SITUATIONAL, COMPLIANCE-SCREENED BEFORE THE PROMPT ─────────
  // Owner ruling: "we only sent content to leads and contacts that are
  // personalized and situation, them first messaging." The facts are drawn from
  // the CONTACT row by the ONE resolver the welcome video already uses — no
  // second personalizer — and a HIGH-severity fair-housing phrase in the CRM's
  // own free text is DROPPED before the writer can see it (§5). The directives
  // ride in `directives`, NOT in `facts`: a constraint the model mistakes for a
  // fact is a constraint it can repeat back to the reader.
  const situation = buildWelcomeSituation(c as WelcomeSituationContact)
  const situationWarnings = [...situation.warnings, ...describeDroppedFacts(situation.droppedFacts)]

  const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
  const draft = await generatePersonaCopy(
    {
      goal: `a warm welcome for a brand-new ${side} client — introduce how the team works, walk the journey map steps IN ORDER, and promise that every update ends with "here's what's next"; no one is dropped into complexity`,
      facts: [
        `Address them as "${addressing.addressAs}"`,
        ...(agentName ? [`The sender is their assigned agent, ${agentName}`] : []),
        ...steps.map((s, i) => `Journey step ${i + 1}: ${s}`),
        ...situation.facts,
      ],
      directives: situation.complianceDirectives,
      channel: agentUserId && c.email ? "email" : "portal",
      persona: { name: addressing.addressAs, audience: side, situation: `just became a ${side} client` },
      words: 140,
    },
    { body: fallback.body },
  )
  const copy = { subject: fallback.subject, body: draft.body }

  // ── (b) PORTAL ACCESS + (c) THE PERSONAL VIDEO ────────────────────────────
  const portalAccess = await ensurePortalAccess(contact.id, agentUserId)
  // A caller-supplied finished video SHORT-CIRCUITS the lookup — see
  // WelcomeVideoOverride for why the sweeper knows the assembled URL first.
  const video: ResolvedWelcomeVideo = opts.videoOverride
    ? { state: "ready", ...opts.videoOverride }
    : agentRecordId
      ? await resolveVideo(svc, { brokerageId: contact.brokerageId, contactId: contact.id, agentRecordId })
      : { state: "none", reason: "no assigned agent — there is nobody for the video to be from" }
  const videoReady = video.state === "ready" ? video : null

  // ── THE GOVERNED LEDGER ROW ───────────────────────────────────────────────
  // Written FIRST and always: it is the evidence the first-touch surface reads,
  // and it is the approval draft if the autonomy gate holds the send.
  const canEmail = !!(c.email && !c.email_opt_out && !c.email_unsubscribed)
  const channel: "email" | "portal" = agentUserId && canEmail ? "email" : "portal"
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const res = await proposeClientMessage({
    brokerageId: contact.brokerageId,
    agentKind: side === "buyer" ? "shopping_agent" : "listing_concierge",
    entityType: "contact",
    entityId: contact.id,
    recipientContactId: contact.id,
    audience: side,
    subject: copy.subject,
    body: copy.body,
    rationale: `${WELCOME_RATIONALE_TAG} — warm onboarding welcome + journey map for a new ${side} client (concierge methodology: no one is dropped into complexity).`,
    channel,
    outreachReason: "welcome",
  }, svc)
  if (!res.ok || !res.id) {
    return {
      ...SKIPPED,
      reason: res.error ?? "welcome ledger write failed",
      videoReason: video.state === "ready" ? null : video.reason,
      situational: situation.isSituational,
      situationWarnings,
    }
  }
  const messageId = res.id

  const base: WelcomeOutcome = {
    proposed: true, sent: false, state: "held_for_approval", messageId,
    reason: null, videoIncluded: false,
    situational: situation.isSituational, situationWarnings,
    // Narrowed on `video` itself, not on the derived `videoReady` boolean: the
    // union only carries `reason` on its in_progress/none arms, and TypeScript
    // cannot discriminate one value from a truthiness test on another.
    videoReason: video.state === "ready" ? null : video.reason, portalAccess,
  }

  // No agent, or no reachable inbox → there is no agent-signed email to send.
  // The gated draft stands and the agent is told why.
  if (!agentUserId) {
    await notifyAgentBestEffort(svc, {
      brokerageId: contact.brokerageId, agentUserId: null, contactId: contact.id,
      contactName: addressing.addressAs, sent: false,
      reason: "this contact has no assigned agent, so no agent-signed welcome could be sent",
      videoReason: base.videoReason,
    })
    return { ...base, state: "no_assigned_agent", reason: "contact has no assigned agent" }
  }
  if (!canEmail) {
    await notifyAgentBestEffort(svc, {
      brokerageId: contact.brokerageId, agentUserId, contactId: contact.id,
      contactName: addressing.addressAs, sent: false,
      reason: c.email ? "this contact has opted out of email" : "this contact has no email address on file",
      videoReason: base.videoReason,
    })
    return { ...base, state: "no_email_on_file", reason: c.email ? "contact opted out of email" : "contact has no email" }
  }

  // ── (a) THE SEND — canonical governed dispatch, FROM the assigned agent ────
  const html = composeWelcomeEmailHtml({
    body: copy.body,
    portalUrl: portalAccess ? portalUrlFor(contact.id) : null,
    hasVideo: !!videoReady,
    agentFirstName,
  })
  const { embedVideoInEmail } = await import("@/lib/ai-isa/video-generator")
  // The token is only present when videoReady — so this call can never render
  // the helper's "being prepared" placeholder.
  const finalHtml = videoReady
    ? await embedVideoInEmail(html, videoReady.videoUrl, videoReady.thumbnailUrl)
    : html

  const { dispatchEmail } = await import("@/lib/providers/dispatch")
  const send = await dispatchEmail({
    brokerageId: contact.brokerageId,
    contactId: contact.id,
    // users.id — the class assembleEmail's signature waterfall looks up. Passing
    // the AGENTS id here (the prior defect) matched no users row and fell all the
    // way through to the BROKERAGE signature, which is the opposite of "from the
    // assigned agent".
    userId: agentUserId,
    // agents.id — kept for vendor-usage attribution, which is agents-class.
    agentId: agentRecordId ?? undefined,
    // THE FROM ADDRESS: the agent's own connected Gmail/Outlook when they have
    // one, so the client can simply hit reply. `from` is deliberately undefined —
    // a caller's guess must never beat the tenant's verified sender.
    sendAsAgentUserId: agentUserId,
    to: c.email as string,
    subject: copy.subject,
    html: finalHtml,
    text: copy.body,
    channelPurpose: "conversation",
    systemSource: WELCOME_SYSTEM_SOURCE,
    // THE APPROVAL RULE: a governed autonomous manager send. An explicit
    // approval_required posture, a platform/tenant halt, or a failed accuracy
    // gate HOLDS this and leaves the draft for the Command Center.
    managerKey: side === "buyer" ? "shopping_agent" : "listing_concierge",
    metadata: {
      welcome_side: side,
      welcome_video_scope: videoReady?.scope ?? null,
      welcome_video_project_id: videoReady?.videoProjectId ?? null,
      portal_access: portalAccess,
    },
  })

  if (!send.success) {
    const held = send.providerKey === "autonomy_gate"
    const reason = send.error ?? "welcome send failed"
    if (held) {
      // The broker's posture says a human reviews this one. The row STAYS
      // 'proposed' — approveClientMessage will send it on the email channel.
      await notifyAgentBestEffort(svc, {
        brokerageId: contact.brokerageId, agentUserId, contactId: contact.id,
        contactName: addressing.addressAs, sent: false,
        reason: "the welcome is drafted and waiting on brokerage approval before it goes out",
        videoReason: base.videoReason,
      })
      return { ...base, state: "held_for_approval", reason }
    }
    await svc.from("agent_client_messages")
      .update({ status: "failed", send_error: reason.slice(0, 500) })
      .eq("id", messageId)
    await notifyAgentBestEffort(svc, {
      brokerageId: contact.brokerageId, agentUserId, contactId: contact.id,
      contactName: addressing.addressAs, sent: false,
      reason: `the welcome could not be sent — ${reason}`,
      videoReason: base.videoReason,
    })
    return { ...base, state: "send_failed", reason }
  }

  // ── EVIDENCE. 'sent' is written ONLY here, behind a provider ACCEPT. ───────
  const sentAt = new Date().toISOString()
  const evidence = `${WELCOME_RATIONALE_TAG} — warm onboarding welcome + journey map for a new ${side} client (concierge methodology: no one is dropped into complexity). | delivered via ${send.providerKey}${send.messageId ? ` ref ${send.messageId}` : ""} at ${sentAt}${videoReady ? ` | personal video ${videoReady.scope} ${videoReady.videoProjectId}` : " | no personal video on file"}`
  const { error: stampError } = await svc.from("agent_client_messages")
    .update({ status: "sent", sent_at: sentAt, rationale: evidence.slice(0, 2000) })
    .eq("id", messageId)
  if (stampError) {
    // The email really went out; the ledger did not record it. Say so loudly —
    // the first-touch surface will under-report, which is the safe direction.
    console.error(`[client-welcome] send succeeded but ledger stamp failed for ${messageId}: ${stampError.message}`)
  }

  // The approval alert proposeClientMessage fires is now moot — this message
  // already went out, and an "approve me" bell for a sent message is a lie.
  const { error: staleAlertError } = await svc.from("notifications").delete()
    .eq("entity_type", "agent_client_message").eq("entity_id", messageId)
    .eq("type", "approval_needed")
  if (staleAlertError) {
    console.error(`[client-welcome] could not clear the moot approval alert for ${messageId}: ${staleAlertError.message}`)
  }

  // ── (c, portal half) THE VIDEO IS VISIBLE IN THE PORTAL TOO ───────────────
  await writePortalWelcomeCard(svc, {
    brokerageId: contact.brokerageId, contactId: contact.id, agentRecordId,
    subject: copy.subject, body: copy.body, video: videoReady, messageId,
  })

  // ── (d) THE AGENT IS TOLD, TWICE, ABOUT TWO DIFFERENT FACTS ───────────────
  await notifyAgentBestEffort(svc, {
    brokerageId: contact.brokerageId, agentUserId, contactId: contact.id,
    contactName: addressing.addressAs, sent: true,
    reason: null, videoReason: base.videoReason,
    providerKey: send.providerKey, sentAt,
  })

  return {
    ...base, sent: true, state: "sent", reason: null,
    videoIncluded: !!videoReady,
  }
}

// ─── Helpers (all best-effort; a welcome never fails on one) ─────────────────

/**
 * The absolute portal URL, or NULL when the platform has no configured app URL.
 *
 * A relative `/portal/…` href in an email is a dead link — mail clients have no
 * origin to resolve it against. So an unconfigured NEXT_PUBLIC_APP_URL suppresses
 * the portal block entirely rather than shipping a button that goes nowhere; the
 * invite row still exists and the agent can share the link by hand.
 */
function portalUrlFor(contactId: string): string | null {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(base)) return null
  return `${base}/portal/${contactId}`
}

/**
 * (b) PORTAL ACCESS. Reuses the ONE portal-invite core
 * (lib/portal/portal-invite-core) rather than minting a second invite path.
 *
 * `sendMagicLink: false` on purpose: the ruling asks for ONE welcome email from
 * the agent CARRYING portal access, and the invite core's magic-link option
 * sends a SEPARATE Supabase OTP mail. The invite row is what grants access; the
 * agent's email carries the door. The contact signs in with the same address.
 */
async function ensurePortalAccess(contactId: string, agentUserId: string | null): Promise<boolean> {
  if (!agentUserId) return false
  try {
    const { createSystemPortalInvite } = await import("@/lib/portal/portal-invite-core")
    const r = await createSystemPortalInvite({ contactId, agentUserId, sendMagicLink: false })
    return r.success === true
  } catch {
    return false
  }
}

async function resolveVideo(
  svc: Svc,
  input: { brokerageId: string; contactId: string; agentRecordId: string },
): Promise<ResolvedWelcomeVideo> {
  try {
    const { resolveWelcomePersonalVideo } = await import("@/lib/kernel/welcome-personal-video")
    return await resolveWelcomePersonalVideo(svc, input)
  } catch (e) {
    return { state: "none", reason: `video lookup unavailable: ${(e as Error).message}` }
  }
}

/**
 * The portal half of (c). The SAME `transparency_updates` card
 * approveClientMessage writes, so there is one portal rail, not two — with the
 * playable URL on `metadata.welcome_video_url` where the portal home feed reads
 * it. No URL is written when there is no video.
 *
 * transparency_updates.agent_id is agents(id) since m366.
 */
async function writePortalWelcomeCard(svc: Svc, args: {
  brokerageId: string
  contactId: string
  agentRecordId: string | null
  subject: string
  body: string
  video: { videoUrl: string; thumbnailUrl: string | null; scope: string; videoProjectId: string } | null
  messageId: string
}): Promise<void> {
  const { error } = await svc.from("transparency_updates").insert({
    brokerage_id: args.brokerageId,
    contact_id: args.contactId,
    ...(args.agentRecordId ? { agent_id: args.agentRecordId } : {}),
    title: args.subject,
    plain_language_summary: args.body,
    message: args.body,
    update_type: "client_welcome",
    is_visible_to_client: true,
    metadata: {
      audience: "client",
      channel: "portal",
      agent_client_message_id: args.messageId,
      welcome_video_url: args.video?.videoUrl ?? null,
      welcome_video_thumbnail_url: args.video?.thumbnailUrl ?? null,
      welcome_video_scope: args.video?.scope ?? null,
      welcome_video_project_id: args.video?.videoProjectId ?? null,
    },
    created_at: new Date().toISOString(),
  })
  if (error) console.error(`[client-welcome] portal welcome card write failed: ${error.message}`)
}

/**
 * (d) TWO DISTINCT FACTS, TWO DISTINCT NOTIFICATIONS.
 *
 *   `new_contact_assigned`  — "you have a new contact". Always.
 *   `welcome_package_sent`  — "the welcome packet WAS SENT". Written ONLY when a
 *                             provider accepted; otherwise its place is taken by
 *                             a `welcome_package_not_sent` row carrying the
 *                             reason, so an agent is never left assuming.
 *
 * THE TENANT. `notifications.brokerage_id` must be the RECIPIENT'S
 * `users.brokerage_id` — that is the exact expression the unread badge count
 * compares against (`resolveRecipientBrokerageId` is the one resolver). A row
 * stamped with the contact's brokerage, or with NULL, leaves the bell dark.
 */
async function notifyAgentBestEffort(svc: Svc, args: {
  brokerageId: string
  agentUserId: string | null
  contactId: string
  contactName: string
  sent: boolean
  reason: string | null
  videoReason: string | null
  providerKey?: string
  sentAt?: string
}): Promise<void> {
  if (!args.agentUserId) return
  try {
    const { resolveRecipientBrokerageId } = await import("@/lib/notifications/recipient-tenant")
    const tenant = await resolveRecipientBrokerageId(svc, args.agentUserId)
    // A REFUSED read is not "this user has no brokerage". Writing NULL would
    // leave the badge dark; skipping is the honest failure.
    if (!tenant.ok) {
      console.error(`[client-welcome] recipient tenant unresolved: ${tenant.reason}`)
      return
    }
    const brokerageId = tenant.brokerageId
    if (!brokerageId) return

    const rows: Array<Record<string, unknown>> = [{
      user_id: args.agentUserId,
      brokerage_id: brokerageId,
      type: "new_contact_assigned",
      title: `New contact: ${args.contactName}`,
      body: `${args.contactName} has been added and assigned to you.`,
      entity_type: "contact",
      entity_id: args.contactId,
      priority: "medium",
      is_read: false,
    }]

    if (args.sent) {
      const videoLine = args.videoReason
        ? ` It went WITHOUT a personal video — ${args.videoReason}.`
        : " Your personal video rode along with it."
      rows.push({
        user_id: args.agentUserId,
        brokerage_id: brokerageId,
        type: "welcome_package_sent",
        title: `Welcome package sent to ${args.contactName}`,
        body: `Their welcome email went out from you${args.providerKey ? ` via ${args.providerKey}` : ""} with portal access.${videoLine}`,
        entity_type: "contact",
        entity_id: args.contactId,
        priority: "low",
        is_read: false,
      })
    } else {
      rows.push({
        user_id: args.agentUserId,
        brokerage_id: brokerageId,
        type: "welcome_package_not_sent",
        title: `Welcome package NOT sent to ${args.contactName}`,
        body: `No welcome has gone out yet — ${args.reason ?? "the send did not complete"}.`,
        entity_type: "contact",
        entity_id: args.contactId,
        priority: "medium",
        is_read: false,
      })
    }

    const { error } = await svc.from("notifications").insert(rows)
    if (error) console.error(`[client-welcome] agent notification write failed: ${error.message}`)
  } catch (e) {
    console.error(`[client-welcome] agent notification failed: ${(e as Error).message}`)
  }
}
