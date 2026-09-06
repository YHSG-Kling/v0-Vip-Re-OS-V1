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
 *   (3) `resolveWelcomeManagers` is EXPORTED, so the conversion lane can ask "will
 *       an agent-signed welcome go out for this contact type?" BEFORE it decides
 *       whether the portal invite's own magic-link mail is needed as the fallback
 *       delivery. That is what keeps the count at exactly one email per contact —
 *       never two, never zero.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-08-25 — THE WELCOME IS ROUTED TO ITS MANAGER(S), NOT TO A "SIDE".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OWNER RULING, verbatim: "contact types are seller, buyer, both, lifetime customer
 * so the welcome email is picked up by the listing concierge if it is a seller,
 * shopping agent for a buyer, both listing concierge and shopping agent for both
 * seller and buyer, sphere if lifetime. kernel says that the wording is by their
 * situation or persona; leads are handled by their type and or persona for content
 * situation."
 *
 * The predecessor of `resolveWelcomeManagers` was `resolveWelcomeSide`, and it
 * answered a TWO-VALUED question ("buyer or seller?") that the ruling does not ask.
 * Two of the four cases came out wrong, and both wrongnesses were invisible:
 *
 *   · `both` collapsed to "seller". A dual-sided move got seller-only copy and ONE
 *     manager, when the ruling names two.
 *   · `lifetime_customer` matched NO branch and fell to null — which, read against
 *     deliverConversionWelcome, armed `sendMagicLink: true` and returned SKIPPED
 *     before any ledger row was written. A converting lifetime customer therefore
 *     received NO agent-signed welcome, NO portal welcome card and NO agent
 *     notification: the only mail they ever got was the invite core's bare Supabase
 *     OTP magic link, which carries no agent voice, no situation and no video.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-08-26 — THE OWNER REVERSED THE LIFETIME HALF OF THAT RULING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OWNER RULING, verbatim: "lifetime should not get the welcome and client isn't a
 * type."
 *
 * The lane immediately above built the OPPOSITE of the first clause: it read the
 * lifetime customer's silence as the defect and routed them to the Sphere Manager,
 * with a bespoke LIFETIME_JOURNEY map, subject line, goal, situation and audience
 * hint written to make that welcome good. The owner has now ruled that a lifetime
 * customer gets NO agent-signed welcome at all. That is a product call reversing
 * recent work, and it is recorded as a reversal rather than quietly absorbed — the
 * three OTHER routings (seller → listing_concierge, buyer → shopping_agent, both →
 * BOTH) were REAFFIRMED and are untouched.
 *
 * ── THE CONSEQUENCE, STATED PLAINLY, BECAUSE IT IS NOT A NO-OP ──────────────
 *
 * `resolveWelcomeManagers` is the exact complement of the magic link: the invite
 * core sends its own Supabase OTP mail if and only if the manager set is EMPTY
 * (deliverConversionWelcome, `sendMagicLink: welcomeManagers.length === 0`; the
 * warm-capture path in lib/contact-pipeline/contact-capture.ts arms it the same
 * way). So returning [] for lifetime does not make a converting lifetime customer
 * silent — IT ARMS THE MAGIC LINK FOR THEM. What they now receive is:
 *
 *   · the portal_contact_invites row (unchanged — the grant never depended on any
 *     of this, and lifetime_customer is not in PORTAL_EXCLUDED_CONTACT_TYPES);
 *   · the portal invite's OWN magic-link mail, and nothing else;
 *   · NO agent-signed welcome, NO journey map, NO embedded personal video, NO
 *     `transparency_updates` portal welcome card, and NO
 *     `new_contact_assigned` / `welcome_package_sent` notification, because
 *     ensureClientWelcome returns SKIPPED before it writes anything.
 *
 * The count stays exactly ONE email per converted contact. It is a different email.
 *
 * ── WHAT IS *NOT* GOVERNED BY THIS RULING ──────────────────────────────────
 *
 * The VIDEO side. `lib/ai-isa/contact-reel-situation.ts::contactReelPersona` still
 * routes the welcome REEL by four values including `lifetime`, and the lifetime arm
 * of lib/contact-promotion/welcome-situation.ts::buildWelcomeSituation still exists
 * because that resolver is shared with lib/contact-promotion/welcome-avatar-video.ts.
 * The owner ruled on the WELCOME EMAIL. Deleting the reel's lifetime lane on the
 * strength of an email ruling would be exactly the guess §1 forbids.
 *
 * THE VOCABULARY IS NOT NEW (§6). `lib/ai-isa/contact-reel-situation.ts`
 * ::contactReelPersona already routes the WELCOME REEL by exactly the owner's four
 * values — buyer / seller / both / lifetime — so the video side had been honouring
 * the ruling while the EMAIL side collapsed it. `WelcomeJourney` IS that type, and
 * `isLifetimeCustomerType` (lib/contact-types) is the same canonical, retired-
 * spelling-tolerant test every other persona resolver in the OS goes through.
 *
 * ── HOW `both` REACHES TWO MANAGERS ─────────────────────────────────────────
 *
 * `agent_client_messages.agent_kind` is ONE text column (verified live) and
 * `dispatchEmail`'s `managerKey` arms ONE manager's autonomy posture. There is no
 * two-manager client message in this schema and inventing one would mean a second
 * ledger row — i.e. a second welcome, which the ruling above forbids. So:
 *
 *   · the FIRST manager in the set OWNS the artefacts — the ledger row's agent_kind
 *     (what resolveActionManager renders in the Command Center) and the governed
 *     send's managerKey. For `both` that is listing_concierge, keeping the reading
 *     this file has always carried: a dual-sided move starts with the home they
 *     already own;
 *   · every OTHER manager in the set picks it up through the EXISTING inter-manager
 *     bus — lib/kernel/manager-signals.ts::publishManagerSignal, the first-class
 *     "managers talking" rail. Nothing parallel was built. The route
 *     listing_concierge → shopping_agent is a DECLARED collaboration edge already
 *     (MANAGER_COLLABORATIONS.listing_demand_bridge), and the signal type
 *     `client_welcome_co_owned` is catalogued in lib/kernel/signal-registry.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildWelcomeSituation,
  describeDroppedFacts,
  type WelcomeSituationContact,
} from "@/lib/contact-promotion/welcome-situation"
import { PORTAL_EXCLUDED_CONTACT_TYPES } from "@/lib/contact-promotion/portal-access"
import { isLifetimeCustomerType } from "@/lib/contact-types"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { ContactReelPersona } from "@/lib/ai-isa/contact-reel-situation"

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

/**
 * The `both` map. NOT the seller map with a buyer sentence bolted on: a move-up is
 * ONE move with two transactions that have to line up, which is the same fact
 * welcome-situation.ts states to the writer ("They are selling AND buying — one
 * move, two transactions that have to line up") and the same fact the
 * `dual_transaction_timing` bus signal exists to coordinate. Both owning managers
 * are visible in it, because both of them are on the file.
 */
const BOTH_JOURNEY = [
  "We map both halves first — what selling your current home takes, and what the next one has to have",
  "Your home gets its pricing story and a prep plan before anything goes live",
  "Your search starts on the SAME calendar, so neither side is waiting on the other",
  "Every showing, every offer, both directions — each one comes back to you with my read",
  "We line the two closings up so you move once — and I keep watching your equity after",
]

// TOMBSTONE (§1, owner ruling 2026-08-26 "lifetime should not get the welcome").
// `LIFETIME_JOURNEY` — a five-step relationship map written for the Sphere
// Manager's welcome — stood here and is DELETED, together with its subject line,
// goal, situation phrase and persona-audience hint below. It had exactly ONE
// reader, `JOURNEY_STEPS.lifetime`, reachable only when `resolveWelcomeManagers`
// returned ["sphere_of_influence"], which it no longer ever does. Nothing else in
// the tree read it (verified by grep over stripped source).
//
// THE CAPABILITY DID NOT MOVE ELSEWHERE AND IS NOT MISSING: the owner ruled that a
// lifetime customer gets no agent-signed welcome, so there is no surviving copy to
// name. What a converting lifetime customer receives instead is the portal invite's
// own magic-link mail — see the header. The relationship-after-the-deal content
// this map expressed continues to exist on its own rails (the Sphere Manager's
// anniversary / equity / referral lanes and the welcome REEL's `lifetime` persona
// in lib/ai-isa/contact-reel-situation.ts), which this ruling does not touch.

/**
 * WHICH JOURNEY MAP THE COPY IS BUILT FROM.
 *
 * Derived from `ContactReelPersona` — the four values lib/ai-isa/contact-reel-
 * situation.ts routes the welcome REEL by (buyer / seller / both / lifetime) —
 * MINUS `lifetime`, which the owner struck from the email side on 2026-08-26.
 *
 * IT IS AN `Exclude<>` AND NOT THREE STRING LITERALS ON PURPOSE, for the same
 * reason `WelcomeManagerKey` is an `Extract<ManagerKey, …>`: it is a COMPILE-TIME
 * proof that the email's journeys remain a SUBSET of the reel's persona vocabulary,
 * so the two can still never drift into two spellings of "which lane is this person
 * on" (§6). The email answers a narrower question than the video; it must not
 * answer it in a different alphabet.
 */
export type WelcomeJourney = Exclude<ContactReelPersona, "lifetime">

const JOURNEY_STEPS: Readonly<Record<WelcomeJourney, readonly string[]>> = Object.freeze({
  buyer:    BUYER_JOURNEY,
  seller:   SELLER_JOURNEY,
  both:     BOTH_JOURNEY,
})

const JOURNEY_SUBJECT: Readonly<Record<WelcomeJourney, string>> = Object.freeze({
  buyer:    "Welcome — here's how we'll find your home",
  seller:   "Welcome — here's how we'll sell your home",
  both:     "Welcome — here's how we'll sell yours and find the next one",
})

/**
 * The `CopyPersona.audience` hint for each journey. Free text on the prompt (see
 * lib/kernel/ai-copy.ts's documented vocabulary "buyer | seller | lead |
 * past_client | investor | neighbor | agent") — NOT the storable
 * `agent_client_messages.audience`, whose live CHECK admits only four values.
 */
const JOURNEY_PERSONA_AUDIENCE: Readonly<Record<WelcomeJourney, string>> = Object.freeze({
  buyer:    "buyer",
  seller:   "seller",
  both:     "buyer and seller",
})

/**
 * THE FALLBACK SITUATION, used ONLY when the contact row carries no persona.
 *
 * The ruling puts the WORDING on the contact's situation or persona, so the
 * type-derived phrase is the floor, never the first answer — see the
 * `personaLabel` read in `ensureClientWelcome`.
 */
/** What the welcome IS, per journey — the generator's brief. */
const JOURNEY_GOAL: Readonly<Record<WelcomeJourney, string>> = Object.freeze({
  buyer:    "a warm welcome for a brand-new buyer client",
  seller:   "a warm welcome for a brand-new seller client",
  both:     "a warm welcome for a brand-new client who is selling their current home AND buying the next one — one move, two transactions that have to line up",
})

const JOURNEY_SITUATION: Readonly<Record<WelcomeJourney, string>> = Object.freeze({
  buyer:    "just became a buyer client",
  seller:   "just became a seller client",
  both:     "is selling their current home and buying the next one",
})

/**
 * The ledger's one-line description of WHAT this welcome is.
 *
 * The `journey === "lifetime"` branch that stood here — "warm lifetime-relationship
 * welcome + what-to-expect map for a past client" — is DELETED with the rest of the
 * lifetime arm (owner ruling 2026-08-26). Every remaining journey is a transaction
 * side, so the sentence is uniform again and needs no special case.
 */
function welcomeRationaleSubject(journey: WelcomeJourney): string {
  return `warm onboarding welcome + journey map for a new ${JOURNEY_PERSONA_AUDIENCE[journey]} client`
}

/** PURE deterministic FALLBACK (owner rule: content is never hardcoded —
 *  production routes through generatePersonaCopy with THIS as the guaranteed
 *  floor; the journey steps are the FACTS the generator may rephrase but
 *  never invent beyond). */
export function composeClientWelcome(input: {
  journey: WelcomeJourney
  addressAs: string
  agentName: string | null
}): { subject: string; body: string } {
  const steps = JOURNEY_STEPS[input.journey] ?? BUYER_JOURNEY
  const who = input.agentName ? `I'm ${input.agentName}, and my` : `My`
  // The `journey === "lifetime"` opening ("…stays yours long after the closing…")
  // is DELETED with the rest of the lifetime arm (owner ruling 2026-08-26). Every
  // remaining journey is a live transaction, so there is one opening again.
  const opening = `${input.addressAs}, welcome. ${who} whole team is now working for you — here's the map so you always know where we are:`
  return {
    subject: JOURNEY_SUBJECT[input.journey] ?? JOURNEY_SUBJECT.buyer,
    body: [
      opening,
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
  /** No manager picks this contact type up, or a welcome already exists. Nothing written. */
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
 * The managers a welcome can be picked up by. `Extract<ManagerKey, …>` rather than
 * bare string literals ON PURPOSE: it is a COMPILE-TIME proof that every name here
 * is a real key of `MANAGERS` in lib/kernel/manager-registry.ts, so another
 * spelling of a manager cannot be introduced here without the registry gaining it
 * first (§6).
 *
 * TOMBSTONE (§1): `sphere_of_influence` was the third member and is REMOVED — the
 * owner ruled on 2026-08-26 that a lifetime customer gets no welcome, so no input
 * can produce it and a union member nothing returns is a promise the code does not
 * keep. THE MANAGER ITSELF IS UNTOUCHED and is still a first-class key of MANAGERS:
 * the Sphere Manager keeps every other thing it owns (the anniversary, equity,
 * referral and win-back lanes). What went is only its arm of THIS resolver.
 */
export type WelcomeManagerKey = Extract<
  ManagerKey,
  "listing_concierge" | "shopping_agent"
>

/**
 * WHICH MANAGER(S) PICK UP THIS WELCOME?
 *
 * OWNER RULING: seller → listing_concierge, buyer → shopping_agent, both → BOTH of
 * those. A LIFETIME CUSTOMER IS PICKED UP BY NOBODY — see the reversal note below;
 * the owner reaffirmed the first three and struck the fourth.
 *
 * ORDER IS MEANINGFUL. The FIRST entry is the OWNER: it becomes
 * `agent_client_messages.agent_kind` (which is what `resolveActionManager` renders
 * in the Command Center) and the governed send's `managerKey` (which is whose
 * autonomy posture gates it). Every later entry is a CO-OWNER, reached through the
 * inter-manager bus — see `notifyCoOwningManagers` below. `both` puts
 * listing_concierge first because a dual-sided move starts with the home they
 * already own; that reading predates this ruling and the ruling does not disturb it.
 *
 * EXPORTED because the conversion lane must ask this question BEFORE it grants
 * portal access: when the answer is non-empty, the agent's welcome IS the delivery
 * and the invite core's own magic-link mail must be suppressed (one email, per the
 * ruling). When the answer is EMPTY, that magic link is the ONLY thing that would
 * ever tell the contact their portal exists, so it must still go. One function
 * answers it for both callers — two spellings of "who gets a welcome" is exactly
 * the §6 defect that produced three senders in the first place.
 *
 * `investor` is a BUYER-side client (the shopping agent's charter is the buyer
 * side, tours and offers). `vendor` and `referral_partner` are counterparties, not
 * clients — the exclusion list is IMPORTED from portal-access rather than re-typed,
 * because two hand-kept copies of "who is not a client" is the same §6 defect one
 * layer down.
 *
 * `lifetime_customer` is STILL matched through `isLifetimeCustomerType`, the
 * canonical test (lib/contact-types) that is deliberately tolerant of the spellings
 * m539 retired — a `past_client` row imported from a legacy CRM is the SAME person,
 * and the point of matching it is that it must reach the SAME (empty) answer rather
 * than falling through the `type.includes("seller")` / `includes("buyer")` arms
 * below and being handed a transaction welcome. The tolerant test is load-bearing in
 * the NEGATIVE direction now; deleting it would silently re-welcome legacy rows.
 *
 * `sphere` is NOT routed here: the ruling enumerates transaction sides and does not
 * name it, and guessing a welcome for a type the owner did not rule on is the kind
 * of invention §1 forbids. (`client` is no longer a contact_type at all — m563.)
 */
export function resolveWelcomeManagers(contactType: string | null | undefined): WelcomeManagerKey[] {
  const type = (contactType ?? "").trim().toLowerCase()
  if (!type) return []
  if (PORTAL_EXCLUDED_CONTACT_TYPES.includes(type)) return []
  // OWNER RULING (2026-08-26): "lifetime should not get the welcome". This arm
  // returned ["sphere_of_influence"] one wave ago; it now returns the EMPTY set,
  // which ARMS the portal invite's own magic-link mail (deliverConversionWelcome
  // passes `sendMagicLink: welcomeManagers.length === 0`). See the reversal note
  // in this file's header for the full consequence.
  if (isLifetimeCustomerType(type)) return []
  if (type === "both") return ["listing_concierge", "shopping_agent"]
  // Tolerant READER of a pre-m593 row: 'investor' left the contact_type
  // vocabulary 2026-08-31 (owner: "investor is a persona and not a contact
  // type") — new investors are contact_type='buyer' + contact_persona='investor'
  // and reach shopping_agent through the buyer arm below. Same destination.
  if (type === "investor") return ["shopping_agent"]
  if (type.includes("seller")) return ["listing_concierge"]
  if (type.includes("buyer")) return ["shopping_agent"]
  return []
}

/**
 * THE JOURNEY MAP THE COPY IS BUILT FROM, derived from the manager set — never from
 * `contact_type` a second time. One resolver decides who picks the welcome up, and
 * the wording follows from that answer; re-reading the type here would be the
 * second spelling all over again.
 *
 * NULL for an empty set: no manager, no welcome, no journey.
 */
export function welcomeJourneyFor(managers: readonly WelcomeManagerKey[]): WelcomeJourney | null {
  // `if (managers.includes("sphere_of_influence")) return "lifetime"` stood here and
  // is DELETED with the rest of the lifetime arm (owner ruling 2026-08-26). It is
  // now unreachable BY TYPE, not merely by data: sphere_of_influence is no longer a
  // member of WelcomeManagerKey, so the compiler refuses the test outright.
  const seller = managers.includes("listing_concierge")
  const buyer = managers.includes("shopping_agent")
  if (seller && buyer) return "both"
  if (seller) return "seller"
  if (buyer) return "buyer"
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
  // WHO PICKS THIS UP. The FIRST manager owns the ledger row and the governed send;
  // the rest are co-owners reached on the bus once the row exists.
  const managers = resolveWelcomeManagers(contact.contactType)
  const journey = welcomeJourneyFor(managers)
  if (managers.length === 0 || !journey) return SKIPPED
  const owningManager = managers[0]
  const coOwningManagers = managers.slice(1)

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
  const fallback = composeClientWelcome({ journey, addressAs: addressing.addressAs, agentName })

  // PERSONA-GENERATED body (never hardcoded); the deterministic journey map is
  // the fact set AND the guaranteed fallback — the generator personalizes,
  // it never invents steps.
  const steps = JOURNEY_STEPS[journey]

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

  // ── THE WORDING IS CHOSEN BY THEIR SITUATION OR PERSONA, NOT BY THEIR TYPE ──
  // OWNER RULING: "kernel says that the wording is by their situation or persona".
  // `personaLabel` is the contact's own `contact_persona` AFTER the fair-housing
  // screen (a HIGH-severity phrase in that column is DROPPED, so it can never reach
  // the writer through this door either — the label is null in that case and the
  // floor below takes over). Underscores are spaced exactly as the LEAD side already
  // does it (lib/ai-isa/lead-reel-brief.ts) so 'first_time' reads as a situation and
  // not as a database value (§6). The type-derived phrase is the FLOOR, used only
  // when the row records no persona at all.
  const personaSituation = situation.personaLabel
    ? situation.personaLabel.replace(/_/g, " ")
    : JOURNEY_SITUATION[journey]

  const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
  const draft = await generatePersonaCopy(
    {
      goal: `${JOURNEY_GOAL[journey]} — introduce how the team works, walk the journey map steps IN ORDER, and promise that every update ends with "here's what's next"; no one is dropped into complexity`,
      facts: [
        `Address them as "${addressing.addressAs}"`,
        ...(agentName ? [`The sender is their assigned agent, ${agentName}`] : []),
        ...steps.map((s, i) => `Journey step ${i + 1}: ${s}`),
        ...situation.facts,
      ],
      directives: situation.complianceDirectives,
      channel: agentUserId && c.email ? "email" : "portal",
      persona: {
        name: addressing.addressAs,
        audience: JOURNEY_PERSONA_AUDIENCE[journey],
        situation: personaSituation,
      },
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
    // THE OWNING MANAGER. One text column, so it carries the FIRST manager in the
    // set; the co-owners are told on the bus below. resolveActionManager reads this
    // to render the Command Center row under a named manager.
    agentKind: owningManager,
    entityType: "contact",
    entityId: contact.id,
    recipientContactId: contact.id,
    // agent_client_messages_audience_check admits ONLY seller|buyer|lead|agent
    // (verified live). A `both` welcome rides its OWNER's side (seller); every other
    // journey is a buyer-side one. The lifetime case this expression also used to
    // carry is gone — that journey no longer exists (owner ruling 2026-08-26) — but
    // the expression is UNCHANGED, because it was already correct for the three
    // survivors and rewriting it would be churn. The real persona travels on
    // `persona.audience` above, which is free text on the prompt.
    audience: journey === "seller" || journey === "both" ? "seller" : "buyer",
    subject: copy.subject,
    body: copy.body,
    rationale: `${WELCOME_RATIONALE_TAG} — ${welcomeRationaleSubject(journey)}, picked up by ${managers.join(" + ")} (concierge methodology: no one is dropped into complexity).`,
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

  // ── EVERY OTHER MANAGER IN THE SET PICKS IT UP TOO ────────────────────────
  // Published as soon as the LEDGER ROW exists, not after the send: the welcome is
  // the co-owner's whether the provider accepted it, the autonomy gate held it, or
  // it failed — and a co-owner who only hears about the ones that went out is a
  // co-owner who cannot notice the ones that did not.
  await notifyCoOwningManagers(svc, {
    brokerageId: contact.brokerageId,
    contactId: contact.id,
    contactName: addressing.addressAs,
    owner: owningManager,
    coOwners: coOwningManagers,
    journey,
    messageId,
  })

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
    // The OWNING manager's posture gates the send — the same one on the ledger row.
    managerKey: owningManager,
    metadata: {
      // `welcome_side` is retired here; `welcome_journey` is the one spelling, and
      // it is the same four-value vocabulary the welcome REEL routes on (§6).
      welcome_journey: journey,
      welcome_managers: managers,
      welcome_owner_manager: owningManager,
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
  const evidence = `${WELCOME_RATIONALE_TAG} — ${welcomeRationaleSubject(journey)}, picked up by ${managers.join(" + ")} (concierge methodology: no one is dropped into complexity). | delivered via ${send.providerKey}${send.messageId ? ` ref ${send.messageId}` : ""} at ${sentAt}${videoReady ? ` | personal video ${videoReady.scope} ${videoReady.videoProjectId}` : " | no personal video on file"}`
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

/** The signal type a co-owned welcome rides. Catalogued in lib/kernel/signal-registry.ts. */
export const WELCOME_CO_OWNERSHIP_SIGNAL = "client_welcome_co_owned"

/**
 * "BOTH LISTING CONCIERGE AND SHOPPING AGENT FOR BOTH SELLER AND BUYER" — the
 * second half of that ruling, made real on the rail that already exists for it.
 *
 * WHY A BUS SIGNAL AND NOT A SECOND LEDGER ROW. `agent_client_messages.agent_kind`
 * is a single text column (verified live: no array, no join table), so a message
 * has exactly one owning manager. A second row would be a second welcome, and the
 * ruling this file exists to serve says there is exactly ONE. The inter-manager bus
 * — `manager_signals`, publishManagerSignal, the Command Center's "managers
 * talking" feed — is the codebase's EXISTING answer to "this belongs to you too",
 * and listing_concierge ↔ shopping_agent is already a DECLARED collaboration edge
 * (MANAGER_COLLABORATIONS.listing_demand_bridge). Nothing parallel was built; one
 * row was added to the signal registry, which is what that registry is for.
 *
 * BEST-EFFORT, like everything else here: a welcome is care, never a dependency.
 * Dynamic import because manager-signals pulls the service client.
 */
async function notifyCoOwningManagers(svc: Svc, args: {
  brokerageId: string
  contactId: string
  contactName: string
  owner: WelcomeManagerKey
  coOwners: readonly WelcomeManagerKey[]
  journey: WelcomeJourney
  messageId: string
}): Promise<void> {
  if (args.coOwners.length === 0) return
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    for (const to of args.coOwners) {
      const r = await publishManagerSignal({
        brokerageId: args.brokerageId,
        fromManager: args.owner,
        toManager: to,
        signalType: WELCOME_CO_OWNERSHIP_SIGNAL,
        message:
          `${args.contactName}'s welcome is co-owned: contact_type '${args.journey}' means this client is ` +
          `on BOTH desks. ${args.owner} owns the one welcome email; you own your side of the same move from here.`,
        entityType: "contact",
        entityId: args.contactId,
        contactId: args.contactId,
        payload: {
          welcome_journey: args.journey,
          agent_client_message_id: args.messageId,
          owning_manager: args.owner,
          co_owning_manager: to,
        },
      }, svc)
      // supabase-js RESOLVES a refusal; publishManagerSignal reports it as ok:false
      // with a reason. Say it out loud rather than letting a silent no-op read as a
      // manager who was told.
      if (!(r as { ok?: boolean }).ok) {
        console.error(
          `[client-welcome] co-ownership signal ${args.owner} → ${to} not published: ` +
            `${(r as { reason?: string }).reason ?? "unknown"}`,
        )
      }
    }
  } catch (e) {
    console.error(`[client-welcome] co-ownership signals failed: ${(e as Error).message}`)
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
