#!/usr/bin/env tsx
/**
 * scripts/conversion-welcome-simulator.ts   (npm run test:conversion-welcome)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE WELCOME EMAIL, AND IT IS THE FIRST THING A CONVERTED CONTACT RECEIVES.
 *
 * OWNER RULING, verbatim: "the welcome email is the first on conversion that has
 * the welcome with portal info to also inclue the embedded personal video." With
 * the earlier one — "the video for the welcome email/portal info for the newly
 * converted lead to contact, finishes and then embeds into the email" — the
 * design is settled: ONE email, carrying portal info AND the embedded personal
 * video, and it WAITS for the video.
 *
 * THREE senders were doing welcome-ish work when this was written:
 *   1. lib/portal/portal-invite-core.ts — an immediate magic-link mail with a
 *      HARDCODED GENERIC body ("Hi ${first_name}, your client portal is ready.");
 *   2. lib/kernel/client-welcome.ts::ensureClientWelcome — the full package,
 *      running on NEITHER conversion lane;
 *   3. /api/cron/intro-video-email-backfill — the video in a SEPARATE later mail.
 *
 * WHAT THIS HARNESS PROVES (two-sided — every absence assertion carries a control
 * that makes the finder demonstrate it can still see the defect it was written
 * for, CLAUDE.md §2):
 *
 *   (WAVE 145, owner ruling 17 — REVERSES wave 144's ruling 13: the ONE welcome WAITS
 *   for the agent's personal video and is auto-sent with it; a video that cannot be
 *   produced or selected HOLDS it for a human-approved exception. Layers 1-2 assert
 *   that rule; the wave-144 follow-up arms stay for rows whose welcome already went.)
 *   Layer 1  THE WAIT RULE. Only a render actually in flight arms the wait; an
 *            agent with no voice profile (live: 0 rows — the DEFAULT case today)
 *            sends immediately. An unknown reason must NOT wait.
 *   Layer 2  THE SWEEPER STATE MACHINE, including the deadline that is checked
 *            BEFORE the assembly gate so nothing waits forever, and the ledger
 *            statuses derived from the LIVE CHECK vocabulary rather than hardcoded.
 *   Layer 3  ONE EMAIL, NEVER TWO AND NEVER ZERO, AND IT IS PICKED UP BY A NAMED
 *            MANAGER: resolveWelcomeManagers decides WHO owns it (seller →
 *            listing_concierge, buyer → shopping_agent, both → BOTH), and the
 *            magic-link fallback is armed by exactly the complement — the EMPTY
 *            manager set.
 *
 *            OWNER RULING 2026-08-26, REVERSING THE WAVE BEFORE IT: "lifetime
 *            should not get the welcome and client isn't a type." The lifetime
 *            arm previously returned ["sphere_of_influence"] and this harness
 *            asserted that; it now returns the EMPTY set, which ARMS the magic
 *            link for a converting lifetime customer. The other three routings
 *            were REAFFIRMED and are unchanged. Both directions of the complement
 *            are asserted over the LIVE contact_type vocabulary, with mutation
 *            controls that fail on the routing the owner struck AND on each of
 *            the three he kept. `client` is no longer in that vocabulary at all
 *            (m563), so it cannot appear on either side.
 *   Layer 4  THEM-FIRST AND COMPLIANCE-FIRST: the situation resolver is the one
 *            personalizer, a HIGH-severity fair-housing phrase in the CRM never
 *            reaches the writing prompt, medium/low rides through as a warning.
 *   Layer 5  THE DIRECTIVES SEAM: constraints reach the writer as directives, not
 *            as facts, and omitting them reproduces the prior prompt.
 *   Layer 6  THE WIRING, read from STRIPPED source (a tombstone is not a call
 *            site), with a positive control per matcher.
 *
 * PURE — no database, no provider, no paid render. The avatar spine is never
 * called: the reactor's outcome is represented by the `WelcomeAvatarVideoReason`
 * it returns, and the Remotion assembly by the composite state string the
 * classifier reads.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  decideWelcomeTiming,
  classifyPendingWelcome,
  PENDING_WELCOME_STATUSES,
  WELCOME_VIDEO_WAIT_MS,
} from "../lib/contact-promotion/conversion-welcome"
import {
  resolveWelcomeManagers,
  welcomeJourneyFor,
  composeClientWelcome,
  WELCOME_CO_OWNERSHIP_SIGNAL,
  type WelcomeManagerKey,
} from "../lib/kernel/client-welcome"
import { PORTAL_EXCLUDED_CONTACT_TYPES } from "../lib/contact-promotion/portal-access"
import { MANAGERS, MANAGER_COLLABORATIONS } from "../lib/kernel/manager-registry"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { contactReelPersona } from "../lib/ai-isa/contact-reel-situation"
import {
  buildWelcomeSituation,
  describeDroppedFacts,
  WELCOME_FAIR_HOUSING_DIRECTIVES,
  type WelcomeOrigin,
} from "../lib/contact-promotion/welcome-situation"
import { generatePersonaCopy, type CopyRequest } from "../lib/kernel/ai-copy"
import { COMPOSITE_WAIT_MS } from "../lib/video/avatar-render-orchestrator"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
/** Every source scan reads STRIPPED source. A tombstone is not a call site. */
const src = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const HOUR = 60 * 60 * 1000

// ─── LAYER 1 — THE WAIT RULE ─────────────────────────────────────────────────

function layer1_waitRule() {
  console.log("\nLayer 1 — the ONE welcome WAITS for the agent's video; a failure is a human-approved exception (owner ruling 17, wave 145)")

  // WAVE 145 (lane 145E) — the RULE re-asserted, not the waypoint: owner ruling 17 (2026-10-27) — "the welcome email with the
  // login info for the newly converted contact has to wait for the avatar welcome email from the agent to finish and auto send
  // after" — REVERSED ruling 13's "the welcome goes now and the video follows". A render in flight HOLDS the welcome again; a
  // video that cannot be produced or selected HOLDS it for a person (never sent without it on its own). The contact's own choices
  // (video off, a stated no-video format) and a type that gets no video still send at once.
  check("a freshly commissioned render HOLDS the one welcome for the video (hold_for_video)",
    decideWelcomeTiming({ commissioned: true, reason: "commissioned" }).action === "hold_for_video")

  check("a render already commissioned on an earlier attempt holds it too\n    (a retried conversion must not race the sweeper with a second send)",
    decideWelcomeTiming({ commissioned: true, reason: "already_commissioned" }).action === "hold_for_video")

  // THE DEFAULT CASE ON THIS PLATFORM. agent_voice_profiles holds ZERO rows, so
  // the reactor's honest refusal is what every conversion hits right now.
  const noProfile = decideWelcomeTiming({ commissioned: false, reason: "agent_not_video_ready" })
  check("an agent with NO voice/avatar profile and no standing video HOLDS the welcome\n    for a human-approved exception — never sent without the video on its own",
    noProfile.action === "hold_for_exception")
  check("...and it SAYS why, so the agent can fix it",
    /voice \/ avatar|voice\/avatar/.test(noProfile.reason) && noProfile.reason.length > 40)
  check("...unless the agent's STANDING personal video is ready (selected + validated): then the welcome goes now WITH it",
    decideWelcomeTiming({ commissioned: false, reason: "agent_not_video_ready", standingVideoReady: true }).action === "send_now")

  check("a contact who turned video off sends immediately (their choice)",
    decideWelcomeTiming({ commissioned: false, reason: "video_opt_out" }).action === "send_now")
  check("a STATED accessibility preference for a format without video sends immediately — even with a render in flight (contract C3)",
    decideWelcomeTiming({ commissioned: true, reason: "commissioned", statedNoVideo: true }).action === "send_now")
  check("an excluded contact type sends immediately",
    decideWelcomeTiming({ commissioned: false, reason: "excluded_contact_type" }).action === "send_now")
  check("a hard refusal (compliance / provider) HOLDS for a human exception",
    decideWelcomeTiming({ commissioned: false, reason: "refused" }).action === "hold_for_exception")
  check("an unavailable spine HOLDS for a human exception",
    decideWelcomeTiming({ commissioned: false, reason: "unavailable" }).action === "hold_for_exception")

  // FAIL CLOSED: a reason nobody has written yet is never "send without the video" and never a silent wait — a PERSON decides.
  check("an UNKNOWN reason HOLDS for a human exception — never falsely sent, never an unbounded silent wait",
    decideWelcomeTiming({ commissioned: false, reason: "a_reason_invented_next_year" }).action === "hold_for_exception")

  // POSITIVE CONTROL: the finder can still see the defect. If the rule were
  // "always wait" or "always send", the assertions above would be vacuous.
  const everyReason = [
    "commissioned", "already_commissioned", "video_opt_out", "agent_not_video_ready",
    "excluded_contact_type", "unavailable", "refused",
  ] as const
  const waiters = everyReason.filter((r) => decideWelcomeTiming({ commissioned: r === "commissioned", reason: r }).action === "hold_for_video")
  check("CONTROL: EXACTLY TWO of the seven reasons hold the welcome for a video in flight — not all, not none",
    waiters.length === 2, `held: ${waiters.join(", ") || "none"}`)
  const sendsNow = everyReason.filter((r) => decideWelcomeTiming({ commissioned: r === "commissioned", reason: r }).action === "send_now")
  check("CONTROL: only the contact's own choice and the excluded type send at once without a standing video (2 of 7)",
    sendsNow.length === 2 && sendsNow.includes("video_opt_out") && sendsNow.includes("excluded_contact_type"), `send_now: ${sendsNow.join(", ")}`)
  check("NO outcome sends the welcome without the video on the system's own say: every failure reason — and an unknown one — is a human exception",
    (["agent_not_video_ready", "unavailable", "refused", "a_reason_invented_next_year"] as const).every((r) => decideWelcomeTiming({ commissioned: false, reason: r }).action === "hold_for_exception"))

  // A `commissioned` reason that did NOT actually commission cannot arm the wait:
  // there would be no agent_intro_videos row for the sweeper to find.
  check("CONTROL: reason 'commissioned' with commissioned=false does NOT wait for a video —\n    the wait is armed by the LEDGER ROW existing, not by a label (it becomes a human exception)",
    decideWelcomeTiming({ commissioned: false, reason: "commissioned" }).action === "hold_for_exception")
}

// ─── LAYER 2 — THE SWEEPER ───────────────────────────────────────────────────

function layer2_sweeper() {
  console.log("\nLayer 2 — the sweeper releases the welcome, and NOTHING waits forever")

  // The HELD-welcome branch (welcomeState 'none' — a pre-wave-144 row whose welcome never went): released exactly as before.
  const base = {
    status: "rendering" as string | null,
    ageMs: 5 * 60 * 1000,
    composite: "landed" as "not_requested" | "pending" | "landed" | "abandoned" | null,
    hasRenderedUrl: true,
    videoOptOut: false,
    hasEmail: true,
    welcomeState: "none" as "sent" | "held" | "failed" | "none" | null | undefined,
  }

  check("a landed assembly with a rendered URL releases the welcome WITH the video",
    classifyPendingWelcome(base).action === "send_with_video")
  check("...and stamps 'delivered'",
    classifyPendingWelcome(base).ledgerStatus === "delivered")

  check("a render still in flight WAITS",
    classifyPendingWelcome({ ...base, hasRenderedUrl: false, composite: null }).action === "wait")
  check("an assembly still pending WAITS — mailing the bare avatar track is the\n    defect the assembly step exists to fix",
    classifyPendingWelcome({ ...base, composite: "pending" }).action === "wait")
  check("an ABANDONED assembly does NOT wait — the D-ID cut ships rather than the\n    welcome never arriving",
    classifyPendingWelcome({ ...base, composite: "abandoned" }).action === "send_with_video")

  // THE DEADLINE, AND ITS POSITION IN THE ORDER.
  const overdue = { ...base, composite: "pending" as const, ageMs: WELCOME_VIDEO_WAIT_MS + 1 }
  // WAVE 145 (ruling 17) — RE-ASSERTED: past the deadline the welcome is no longer sent without the video; a PERSON decides.
  check("past the deadline the welcome is HELD for a human-approved exception EVEN THOUGH the\n    assembly is still 'pending' — the deadline is checked BEFORE the assembly\n    gate (nothing stalls), and nothing is sent without the video on the sweeper's own say",
    classifyPendingWelcome(overdue).action === "hold_for_exception")
  check("...and the ledger records 'failed' with the timeout as the reason",
    classifyPendingWelcome(overdue).ledgerStatus === "failed"
    && /has not landed within \d+ minutes/.test(classifyPendingWelcome(overdue).reason))
  check("CONTROL: one millisecond INSIDE the deadline still waits — the boundary\n    is real, not a regex that matches everything",
    classifyPendingWelcome({ ...overdue, ageMs: WELCOME_VIDEO_WAIT_MS }).action === "wait")
  check("an unknown age is treated as FRESH, never as overdue — a null created_at\n    must not mail a welcome the instant the sweeper first sees the row",
    classifyPendingWelcome({ ...base, composite: "pending", ageMs: null }).action === "wait")

  // A LATE OPT-OUT BEATS A FINISHED VIDEO.
  const lateOptOut = { ...base, videoOptOut: true }
  check("a contact who turned video off DURING the render still gets the welcome —\n    without the video",
    classifyPendingWelcome(lateOptOut).action === "send_without_video")
  check("...recorded as 'suppressed', not 'failed' — their choice is not an incident",
    classifyPendingWelcome(lateOptOut).ledgerStatus === "suppressed")

  // NO EMAIL: the welcome still resolves (the survivor writes the portal rail).
  check("no email address still RELEASES the welcome (the survivor routes it to the\n    portal rail and tells the agent) rather than leaving the row pending forever",
    classifyPendingWelcome({ ...base, hasEmail: false }).action === "send_without_video")

  // TERMINAL ROWS ARE NOT RE-SENT. This is the no-double-send guard at the sweep.
  for (const terminal of ["delivered", "failed", "suppressed"]) {
    check(`a '${terminal}' row is SKIPPED — the sweeper never re-sends a resolved welcome`,
      classifyPendingWelcome({ ...base, status: terminal }).action === "skip")
  }
  check("a null status is skipped too",
    classifyPendingWelcome({ ...base, status: null }).action === "skip")

  // THE SET THE SWEEPER SELECTS IS EXACTLY THE NON-TERMINAL VOCABULARY, DERIVED
  // FROM THE LIVE CHECK — not a hardcoded list that a future status would escape.
  const liveStatuses = CHECK_VOCABULARIES.agent_intro_videos?.status ?? []
  check("CONTROL: the live agent_intro_videos.status vocabulary is readable — a\n    guard that cannot see the vocabulary it judges reports zero and reads clean",
    liveStatuses.length > 0, `read ${liveStatuses.length} values`)
  const terminalByRule = liveStatuses.filter((s) => !PENDING_WELCOME_STATUSES.includes(s))
  check("every PENDING status is in the live CHECK vocabulary — the sweeper cannot\n    select a value the database would never store",
    PENDING_WELCOME_STATUSES.every((s) => liveStatuses.includes(s)),
    `pending: ${PENDING_WELCOME_STATUSES.join(",")} vs live: ${liveStatuses.join(",")}`)
  check("every status the classifier can WRITE is in the live CHECK vocabulary —\n    'abandoned' is refused by the live constraint (23514, proved against\n    hrvaqgvukzxfskkcrwbt), so a timed-out render is recorded as 'failed'",
    (["delivered", "failed", "suppressed"] as const).every((s) => liveStatuses.includes(s)))
  check("CONTROL: 'abandoned' is NOT in the live vocabulary, so the classifier must\n    never produce it",
    !liveStatuses.includes("abandoned"))
  check("every terminal status derived from the live vocabulary is SKIPPED by the\n    classifier — the rule is asserted, the list is derived (§2: no waypoints)",
    terminalByRule.every((s) => classifyPendingWelcome({ ...base, status: s }).action === "skip"),
    `terminal by rule: ${terminalByRule.join(",")}`)

  // ── WAVE 144: THE WELCOME ALREADY WENT — THE VIDEO FOLLOWS IT, OR IS CLOSED ──
  const sent = { ...base, welcomeState: "sent" as const }
  check("W144 welcome SENT + a landed assembly → ONE video FOLLOW-UP (never a second welcome), stamped 'delivered' on a real send",
    classifyPendingWelcome(sent).action === "send_video_follow_up" && classifyPendingWelcome(sent).ledgerStatus === "delivered")
  check("W144 …still in flight / assembly pending → wait (the bare avatar track is never mailed)",
    classifyPendingWelcome({ ...sent, hasRenderedUrl: false, composite: null }).action === "wait" && classifyPendingWelcome({ ...sent, composite: "pending" }).action === "wait")
  check("W144 …past the deadline → CLOSED, 'failed', and NO mail (the welcome already went; no late video email)",
    classifyPendingWelcome({ ...sent, composite: "pending", ageMs: WELCOME_VIDEO_WAIT_MS + 1 }).action === "close_video_follow_up" && classifyPendingWelcome({ ...sent, ageMs: WELCOME_VIDEO_WAIT_MS + 1 }).ledgerStatus === "failed")
  check("W144 …a late video opt-out → closed 'suppressed'; no email on file → closed 'failed' (the video stays on the portal card)",
    classifyPendingWelcome({ ...sent, videoOptOut: true }).ledgerStatus === "suppressed" && classifyPendingWelcome({ ...sent, videoOptOut: true }).action === "close_video_follow_up"
    && classifyPendingWelcome({ ...sent, hasEmail: false }).action === "close_video_follow_up")
  check("W144 a welcome HELD for approval → the video waits BEHIND it (never precedes it), and is closed past the deadline",
    classifyPendingWelcome({ ...base, welcomeState: "held" }).action === "wait" && classifyPendingWelcome({ ...base, welcomeState: "held", ageMs: WELCOME_VIDEO_WAIT_MS + 1 }).action === "close_video_follow_up")
  check("W144 a FAILED / rejected welcome → closed: a video never goes out without its welcome",
    classifyPendingWelcome({ ...base, welcomeState: "failed" }).action === "close_video_follow_up")
  check("W144 FAIL CLOSED: a caller that does not say (undefined) or could not read (null) the welcome's state RELEASES NOTHING and stamps nothing — a deduped welcome must never read as a delivered video",
    classifyPendingWelcome({ ...base, welcomeState: undefined }).action === "wait" && classifyPendingWelcome({ ...base, welcomeState: undefined }).ledgerStatus === null
    && classifyPendingWelcome({ ...base, welcomeState: null }).action === "wait")
  check("W145 …and an unstated state past the deadline stamps the row 'failed' and HOLDS the welcome for a person — nothing hangs silently, nothing is sent on a guess, 'delivered' is never stamped without the state",
    classifyPendingWelcome({ ...base, welcomeState: undefined, ageMs: WELCOME_VIDEO_WAIT_MS + 1 }).action === "hold_for_exception" && classifyPendingWelcome({ ...base, welcomeState: undefined, ageMs: WELCOME_VIDEO_WAIT_MS + 1 }).ledgerStatus === "failed")
  check("W144 CONTROL: the same row with the state stated DOES release — the fail-closed arm is not a classifier that always waits",
    classifyPendingWelcome({ ...base, welcomeState: "none" }).action === "send_with_video" && classifyPendingWelcome(sent).action === "send_video_follow_up")
  check("W144 a terminal row is skipped whatever the welcome's state",
    (["sent", "held", "failed", "none", undefined] as const).every((w) => classifyPendingWelcome({ ...base, status: "delivered", welcomeState: w }).action === "skip"))

  // THE BOUND IS NOT A SECOND NUMBER (§6).
  check("the welcome's wait bound IS the video pipeline's existing bound — one\n    vocabulary per function, not a second timeout constant",
    WELCOME_VIDEO_WAIT_MS === COMPOSITE_WAIT_MS)
  check("...and it is a real, finite, hours-scale bound",
    WELCOME_VIDEO_WAIT_MS > 0 && WELCOME_VIDEO_WAIT_MS <= 24 * HOUR)
}

// ─── LAYER 3 — ONE EMAIL, NEVER TWO AND NEVER ZERO ───────────────────────────

function layer3_oneEmail() {
  console.log("\nLayer 3 — exactly one welcome email per converted contact, picked up by a NAMED manager")

  // Every value the conversion lanes can produce (resolveContactType clamps to
  // the live contacts_contact_type_check vocabulary).
  const liveTypes = CHECK_VOCABULARIES.contacts?.contact_type ?? []
  check("CONTROL: the live contacts.contact_type vocabulary is readable",
    liveTypes.length > 0, `read ${liveTypes.length} values`)

  // ── THE OWNER'S FOUR CASES, VERBATIM ──────────────────────────────────────
  // "the welcome email is picked up by the listing concierge if it is a seller,
  //  shopping agent for a buyer, both listing concierge and shopping agent for both
  //  seller and buyer, sphere if lifetime."
  const eq = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i])

  check("a SELLER is picked up by the listing concierge",
    eq(resolveWelcomeManagers("seller"), ["listing_concierge"]),
    resolveWelcomeManagers("seller").join(",") || "none")
  check("a BUYER is picked up by the shopping agent",
    eq(resolveWelcomeManagers("buyer"), ["shopping_agent"]),
    resolveWelcomeManagers("buyer").join(",") || "none")
  check("'both' is picked up by BOTH the listing concierge AND the shopping agent —\n    two managers, not one; the old resolver collapsed this to seller-only",
    eq(resolveWelcomeManagers("both"), ["listing_concierge", "shopping_agent"]),
    resolveWelcomeManagers("both").join(",") || "none")
  // ── THE LIFETIME REVERSAL (owner, 2026-08-26) ─────────────────────────────
  // "lifetime should not get the welcome and client isn't a type."
  // The previous wave routed lifetime_customer → sphere_of_influence and this
  // harness asserted exactly that. The owner reversed it; the OTHER THREE routings
  // above were reaffirmed and are unchanged.
  check("a LIFETIME CUSTOMER is picked up by NOBODY — owner ruling 2026-08-26,\n    reversing the sphere_of_influence routing built one wave earlier",
    resolveWelcomeManagers("lifetime_customer").length === 0,
    resolveWelcomeManagers("lifetime_customer").join(",") || "none")

  // MUTATION CONTROLS — every assertion above must FAIL on the behaviour it replaced.
  // (§2: an assertion that passes on the code it was written to rule out is worthless.)
  const collapsedBoth = ["listing_concierge"]                      // the OLD `both` → "seller"
  const spheredLifetime = ["sphere_of_influence"]                  // the REVERSED lifetime routing
  check("CONTROL: a 'both' contact routed to only ONE manager FAILS the assertion\n    above — the finder can still see the exact defect it was written for",
    !eq(collapsedBoth, resolveWelcomeManagers("both")))
  check("CONTROL: routing a 'lifetime_customer' back to sphere_of_influence FAILS the\n    assertion above — the finder can see the routing the owner struck",
    !eq(spheredLifetime, resolveWelcomeManagers("lifetime_customer")))
  check("CONTROL: the three REAFFIRMED routings each fail if broken — seller must not\n    reach shopping_agent, buyer must not reach listing_concierge, and 'both' must\n    not collapse to either one alone",
    !eq(resolveWelcomeManagers("seller"), ["shopping_agent"])
    && !eq(resolveWelcomeManagers("buyer"), ["listing_concierge"])
    && !eq(resolveWelcomeManagers("both"), ["shopping_agent"])
    && !eq(resolveWelcomeManagers("both"), ["listing_concierge"]))

  // A RETIRED SPELLING IS THE SAME PERSON (m539 retired 'lifetime'/'past_client'),
  // and the tolerant test is now load-bearing in the NEGATIVE direction: without it
  // a legacy `past_client` row would fall through to the substring arms and be
  // handed a transaction welcome.
  check("a legacy 'past_client' or 'lifetime' row is ALSO picked up by nobody — the\n    canonical isLifetimeCustomerType is tolerant of the spellings m539 retired, so\n    an imported row reaches the same answer instead of falling through",
    resolveWelcomeManagers("past_client").length === 0
    && resolveWelcomeManagers("lifetime").length === 0
    && resolveWelcomeManagers("past_seller").length === 0)
  check("CONTROL: that tolerance is real and not an accident of the empty default —\n    'past_seller' contains the substring 'seller' and would reach\n    listing_concierge if the lifetime test were removed",
    "past_seller".includes("seller") && resolveWelcomeManagers("seller").length === 1)

  check("an INVESTOR is picked up by the shopping agent — the conversion lanes\n    produce this type and it used to fall through to no welcome at all",
    eq(resolveWelcomeManagers("investor"), ["shopping_agent"]))
  check("a VENDOR is picked up by nobody — a counterparty is not a client",
    resolveWelcomeManagers("vendor").length === 0)
  check("a REFERRAL PARTNER is picked up by nobody",
    resolveWelcomeManagers("referral_partner").length === 0)
  check("an empty/unknown type is picked up by nobody rather than a guessed journey",
    resolveWelcomeManagers(null).length === 0
    && resolveWelcomeManagers("").length === 0
    && resolveWelcomeManagers("prospect").length === 0)

  // EVERY NAME IS A REAL REGISTERED MANAGER (§6 — no second spelling).
  const everyManager = liveTypes.flatMap((t) => resolveWelcomeManagers(t))
  check("every manager the resolver can name is a REAL key of the manager registry",
    everyManager.length > 0 && everyManager.every((m) => m in MANAGERS),
    `named: ${[...new Set(everyManager)].join(",")}`)
  check("CONTROL: the registry lookup is real — an invented manager is NOT a key",
    !("listing_conceirge" in MANAGERS))

  // ── THE JOURNEY VOCABULARY IS THE ONE THE REEL ALREADY USES (§6) ──────────
  check("the journey is derived from the MANAGER SET, not from contact_type a\n    second time: seller→seller, buyer→buyer, both→both",
    welcomeJourneyFor(resolveWelcomeManagers("seller")) === "seller"
    && welcomeJourneyFor(resolveWelcomeManagers("buyer")) === "buyer"
    && welcomeJourneyFor(resolveWelcomeManagers("both")) === "both")
  check("...and an empty manager set has NO journey — which is now the LIFETIME case\n    too, so a lifetime customer reaches no journey map at all",
    welcomeJourneyFor([]) === null
    && welcomeJourneyFor(resolveWelcomeManagers("vendor")) === null
    && welcomeJourneyFor(resolveWelcomeManagers("lifetime_customer")) === null)
  check("the EMAIL's journey and the welcome REEL's persona agree on every type the\n    email is sent for — one vocabulary for 'which lane is this person on', not\n    two (the reel side already honoured the ruling while the email collapsed it)",
    liveTypes
      .filter((t) => resolveWelcomeManagers(t).length > 0)
      .every((t) => welcomeJourneyFor(resolveWelcomeManagers(t)) === contactReelPersona(t)),
    liveTypes.filter((t) => resolveWelcomeManagers(t).length > 0)
      .map((t) => `${t}:${welcomeJourneyFor(resolveWelcomeManagers(t))}/${contactReelPersona(t)}`).join(" "))
  check("CONTROL: the two resolvers are NOT trivially equal — contactReelPersona\n    defaults a vendor to 'buyer' while the welcome sends them nothing, so the\n    agreement above is a real match and not an identity",
    contactReelPersona("vendor") === "buyer" && resolveWelcomeManagers("vendor").length === 0)

  // EVERY JOURNEY HAS ITS OWN COPY — a 'both' or a lifetime client must not be
  // handed the seller map with a different subject line.
  // EVERY JOURNEY THE RESOLVER CAN PRODUCE, DERIVED — not a typed list (§2: do not
  // pin an assertion to a waypoint). This read `["buyer","seller","both","lifetime"]`
  // with `.size === 4`, which was true only while the lifetime journey existed; the
  // property worth asserting is that each REACHABLE journey has its own copy.
  const reachableJourneys = [...new Set(
    liveTypes.map((t) => welcomeJourneyFor(resolveWelcomeManagers(t))).filter((j): j is NonNullable<typeof j> => j !== null),
  )]
  const bodies = reachableJourneys
    .map((j) => composeClientWelcome({ journey: j, addressAs: "Sam", agentName: "Dana Reed" }))
  check("every REACHABLE journey composes a distinct subject AND a distinct body —\n    no journey is a relabelled copy of another",
    reachableJourneys.length > 1
    && new Set(bodies.map((b) => b.subject)).size === reachableJourneys.length
    && new Set(bodies.map((b) => b.body)).size === reachableJourneys.length,
    `reachable: ${reachableJourneys.join(",")}`)
  check("CONTROL: the reachable set is exactly the three transaction sides — 'lifetime'\n    is NOT among them (owner ruling 2026-08-26), and the set is derived from the\n    LIVE contact_type vocabulary rather than typed here",
    [...reachableJourneys].sort().join(",") === "both,buyer,seller",
    reachableJourneys.join(","))
  const bothBody = bodies[reachableJourneys.indexOf("both")]
  check("the BOTH welcome names BOTH halves of the move",
    /sell/i.test(bothBody.body) && /search|next one|buy/i.test(bothBody.body))
  check("no reachable welcome carries the retired LIFETIME copy — the journey map,\n    the subject line and the opening all went with the ruling (§1)",
    bodies.every((b) => !/stay in your corner|stays yours long after the closing|keep showing up/i.test(b.subject + b.body)))
  check("CONTROL: that finder really recognises the deleted lifetime copy",
    /stay in your corner/i.test("Welcome — here's how I stay in your corner"))

  // ── HOW THE SECOND MANAGER ACTUALLY PICKS IT UP ───────────────────────────
  const welcome = src("lib/kernel/client-welcome.ts")
  check("the co-ownership signal type is CATALOGUED in the signal registry — an\n    uncatalogued published type is the orphan test:signal-integrity fails on",
    !!SIGNAL_REGISTRY[WELCOME_CO_OWNERSHIP_SIGNAL])
  check("...and its declared kind matches the live classifier (the feed renders it\n    as declared)",
    SIGNAL_REGISTRY[WELCOME_CO_OWNERSHIP_SIGNAL]?.kind === classifyCoordination(WELCOME_CO_OWNERSHIP_SIGNAL))
  check("...and it is FEED-ONLY with no declared consumer, so it promises no handler\n    that does not exist",
    SIGNAL_REGISTRY[WELCOME_CO_OWNERSHIP_SIGNAL]?.disposition === "feed_only"
    && (SIGNAL_REGISTRY[WELCOME_CO_OWNERSHIP_SIGNAL]?.consumers.length ?? 1) === 0)
  check("the co-owner is reached on the EXISTING inter-manager bus — publishManagerSignal,\n    not a second rail invented for this",
    /publishManagerSignal\(/.test(welcome) && /manager-signals/.test(welcome))
  check("CONTROL: the survivor writes NO second agent_client_messages row for the\n    co-owner — a second ledger row would be a second welcome",
    (welcome.match(/proposeClientMessage\(\{/g) ?? []).length === 1)
  const bothRoute = resolveWelcomeManagers("both") as WelcomeManagerKey[]
  check("the `both` route is a DECLARED collaboration edge in the manager registry —\n    the co-ownership signal rides governance that already existed",
    Object.values(MANAGER_COLLABORATIONS).some((d) =>
      bothRoute.every((m) => (d.managers as readonly string[]).includes(m))))
  check("CONTROL: an UNDECLARED pair would not be found by that matcher",
    !Object.values(MANAGER_COLLABORATIONS).some((d) =>
      (d.managers as readonly string[]).includes("sphere_of_influence")
      && (d.managers as readonly string[]).includes("cron_manager")))
  check("the co-ownership signal is published as soon as the LEDGER ROW exists, not\n    behind a successful send — a co-owner who only hears about the welcomes that\n    went out cannot notice the ones the autonomy gate held",
    welcome.indexOf("notifyCoOwningManagers(") > -1
    && welcome.indexOf("notifyCoOwningManagers(", welcome.indexOf("const messageId = res.id"))
       < welcome.indexOf("const send = await dispatchEmail("))

  // THE OWNING MANAGER IS THE ONE ON BOTH ARTEFACTS.
  check("the ledger row's agent_kind AND the governed send's managerKey are the SAME\n    owning manager — one manager gates what one manager is credited with",
    /agentKind:\s*owningManager/.test(welcome) && /managerKey:\s*owningManager/.test(welcome))
  check("CONTROL: the retired `welcome_side` metadata spelling is gone — one\n    vocabulary, not two (§6)",
    !/welcome_side/.test(welcome) && /welcome_journey/.test(welcome))

  // ── THE ONE-EMAIL INVARIANT ───────────────────────────────────────────────
  // The magic link is armed by EXACTLY the complement of resolveWelcomeManagers,
  // so no contact type can produce two emails or none.
  const conversionSource = src("lib/contact-promotion/conversion-welcome.ts")
  check("the invite core's magic link is armed by exactly `welcomeManagers.length === 0`\n    — the complement of 'a manager picks this welcome up', which is what makes the\n    count exactly one for every contact type",
    /sendMagicLink:\s*welcomeManagers\.length === 0/.test(conversionSource))
  check("CONTROL: the finder would see a hardcoded `sendMagicLink: true` here",
    !/sendMagicLink:\s*true/.test(conversionSource))

  // THE SAME RULE ON THE WARM-CAPTURE PATH. captureContact runs the survivor and
  // then (re)issues the portal invite; with the OTP mail unconditionally armed
  // that was a SECOND generic email on top of the agent-signed one — the same
  // duplicate, one lane over.
  const capture = src("lib/contact-pipeline/contact-capture.ts")
  check("the warm-capture path arms its magic link by the SAME complement, so it\n    cannot stack a generic OTP mail on top of the agent-signed welcome",
    /sendMagicLink:\s*resolveWelcomeManagers\([\s\S]{0,60}?\)\.length === 0/.test(capture))
  check("CONTROL: capture still issues the invite ROW unconditionally — the grant\n    and the email are different things",
    /createSystemPortalInvite\(\{/.test(capture))

  // THE COMPLEMENT, ASSERTED IN BOTH DIRECTIONS ON THE LIVE VOCABULARY — not just
  // as a source regex. Every contact_type must land on exactly one delivery.
  const magicLinkArmed = (t: string) => resolveWelcomeManagers(t).length === 0
  check("EVERY live contact_type gets EXACTLY ONE delivery: either an agent-signed\n    welcome (non-empty manager set, magic link suppressed) or the invite core's\n    magic link (empty set) — never both and never neither",
    liveTypes.every((t) => magicLinkArmed(t) !== (resolveWelcomeManagers(t).length > 0)))
  check("THE LIFETIME CONSEQUENCE, stated as an assertion: a converting lifetime\n    customer now gets the portal invite's OWN magic-link mail and NO agent-signed\n    welcome — the direct result of the empty manager set",
    magicLinkArmed("lifetime_customer")
    && magicLinkArmed("past_client")
    && !PORTAL_EXCLUDED_CONTACT_TYPES.includes("lifetime_customer"),
    `lifetime magic link armed: ${magicLinkArmed("lifetime_customer")}`)
  check("CONTROL: the OTHER direction still holds — a buyer, a seller and a 'both'\n    each SUPPRESS the magic link, so the complement is a real split and not a\n    resolver that answers 'empty' for everything",
    !magicLinkArmed("buyer") && !magicLinkArmed("seller") && !magicLinkArmed("both")
    && !magicLinkArmed("investor"))
  check("CONTROL: a PORTAL-EXCLUDED type gets neither — it has no portal to be told\n    about, which is why the exclusion list is imported rather than re-typed",
    PORTAL_EXCLUDED_CONTACT_TYPES.every((t) => resolveWelcomeManagers(t).length === 0))

  // POSITIVE CONTROL for the whole layer: at least one live type on each side.
  const welcomed = liveTypes.filter((t) => resolveWelcomeManagers(t).length > 0)
  const unwelcomed = liveTypes.filter((t) => resolveWelcomeManagers(t).length === 0)
  check("CONTROL: the live vocabulary splits BOTH ways — some types welcome, some\n    do not (a resolver that answered uniformly would pass every case above)",
    welcomed.length > 0 && unwelcomed.length > 0,
    `welcomed: ${welcomed.join(",")} | not: ${unwelcomed.join(",")}`)
  check("CONTROL: EXACTLY ONE live contact_type produces a TWO-manager welcome —\n    'both'. A resolver that co-owned everything would pass the `both` case above",
    liveTypes.filter((t) => resolveWelcomeManagers(t).length > 1).join(",") === "both",
    liveTypes.filter((t) => resolveWelcomeManagers(t).length > 1).join(",") || "none")
}

// ─── LAYER 4 — THEM-FIRST, COMPLIANCE-FIRST ──────────────────────────────────

function layer4_situation() {
  console.log("\nLayer 4 — the copy is situational, and fair housing is IN the prompt")

  const situational = buildWelcomeSituation({
    contact_type: "buyer",
    timeline: "1-3_months",
    city: "Austin",
    state: "TX",
    beds: 3,
    budget_min: 400000,
    budget_max: 650000,
  })
  check("a real contact row produces real situational facts",
    situational.isSituational && situational.facts.length >= 4)
  check("the timeline stays in BUCKETS (§5) — never 30/60/90",
    situational.facts.some((f) => /one to three months/.test(f))
    && !situational.facts.some((f) => /\b(30|60|90)\b/.test(f)))
  check("a named market forces its own steering ban INTO the writing prompt",
    situational.complianceDirectives.some((d) => /Austin, TX/.test(d) && /say nothing about its people/i.test(d)))
  // + 1 (wave 51): every situation now also carries the "write in {language}"
  // directive (owner ruling: default to DEFAULT_LANGUAGE when none is known) —
  // see Layer 9. The count MOVED because the language directive is real, not
  // because the fair-housing floor grew or shrank (asserted by content below).
  check("the fair-housing floor is present even before any market is named",
    buildWelcomeSituation({ contact_type: "buyer" }).complianceDirectives.length === WELCOME_FAIR_HOUSING_DIRECTIVES.length + 1)
  check("...and it is the SAME floor array, unchanged, not a shrunk substitute",
    WELCOME_FAIR_HOUSING_DIRECTIVES.every((d) =>
      buildWelcomeSituation({ contact_type: "buyer" }).complianceDirectives.includes(d)))

  // THE HARD FLAG. A HIGH-severity phrase in the CRM's own free text is DROPPED
  // before the writer sees it — laundering it through "the CRM said so" is still
  // authoring it.
  const dirty = buildWelcomeSituation({ contact_type: "buyer", contact_persona: "perfect for families" })
  check("a HARD fair-housing phrase in contacts.contact_persona is DROPPED",
    dirty.droppedFacts.length > 0
    && !dirty.facts.some((f) => /perfect for families/i.test(f)))
  check("...and the drop is REPORTED, never silent",
    describeDroppedFacts(dirty.droppedFacts).some((l) => /HARD fair-housing phrase/.test(l)))
  check("CONTROL: the identical row WITHOUT the phrase keeps its persona fact —\n    the screener drops the phrase, not the field",
    buildWelcomeSituation({ contact_type: "buyer", contact_persona: "first_time" })
      .facts.some((f) => /first_time/.test(f)))

  // Every fact is written from the client's side of the table.
  check("every situational fact is them-first (\"they\"/\"their\"), never\n    brokerage-first (\"we specialise in\")",
    situational.facts.every((f) => /\b(they|their|them)\b/i.test(f)))

  // ── THE WORDING IS CHOSEN BY SITUATION OR PERSONA, NOT BY CONTACT TYPE ────
  // OWNER RULING: "kernel says that the wording is by their situation or persona".
  const withPersona = buildWelcomeSituation({ contact_type: "buyer", contact_persona: "first_time" })
  check("the ONE situation resolver publishes the contact's SCREENED persona, so the\n    writing prompt's `situation` can be their persona rather than their type",
    withPersona.personaLabel === "first_time")
  check("...and a row with NO persona publishes NULL — the journey phrase is the\n    honest floor, never a guessed persona",
    buildWelcomeSituation({ contact_type: "buyer" }).personaLabel === null)
  check("CONTROL: a HARD fair-housing phrase in contact_persona leaves personaLabel\n    NULL — the screen governs THIS exit too, so the wording door cannot be used\n    to walk a dropped phrase past the writer (§5)",
    dirty.personaLabel === null && dirty.droppedFacts.length > 0)

  // Every persona the live CHECK admits must survive the screen — a vocabulary
  // value the screener silently ate would be a wording nobody could ever use.
  const livePersonas = CHECK_VOCABULARIES.contacts?.contact_persona ?? []
  check("CONTROL: the live contacts.contact_persona vocabulary is readable",
    livePersonas.length > 0, `read ${livePersonas.length} values`)
  check("every persona the live CHECK admits reaches the writer as the situation",
    livePersonas.every((p) => buildWelcomeSituation({ contact_type: "buyer", contact_persona: p }).personaLabel === p),
    livePersonas.filter((p) => buildWelcomeSituation({ contact_type: "buyer", contact_persona: p }).personaLabel !== p).join(",") || "all pass")

  const welcomeSrc = src("lib/kernel/client-welcome.ts")
  check("the welcome feeds that persona to the writer as the CopyPersona.situation,\n    falling back to the journey phrase only when there is no persona on file",
    /situation\.personaLabel/.test(welcomeSrc) && /JOURNEY_SITUATION\[journey\]/.test(welcomeSrc))
  check("CONTROL: the retired type-derived spelling `just became a ${side} client` is\n    gone from the prompt — that was the wording keyed off contact_type",
    !/just became a \$\{side\}/.test(welcomeSrc))

  // A LIFETIME CUSTOMER REACHES THE WRITER WITH A REAL SITUATION FACT.
  //
  // THIS SURVIVES THE 2026-08-26 RULING, AND THE REASON IS THE POINT. The owner
  // struck the lifetime WELCOME EMAIL, not the lifetime lane. buildWelcomeSituation
  // has a SECOND reader — lib/contact-promotion/welcome-avatar-video.ts, the video
  // side, which the ruling does not govern and which routes on
  // contactReelPersona's four values including `lifetime`. §1 permits deleting an
  // orphan; this arm is not one, so it stays and is still proved.
  const lifetime = buildWelcomeSituation({ contact_type: "lifetime_customer", city: "Austin", state: "TX" })
  check("a LIFETIME customer still produces a situational side fact for the VIDEO\n    path — the shared situation resolver keeps its lifetime arm because the reel\n    reads it, even though no lifetime welcome EMAIL is composed any more",
    lifetime.isSituational && lifetime.facts.some((f) => /already closed with us/i.test(f)))
  check("...and it says nothing is being sold to them",
    lifetime.facts.some((f) => /nothing is being sold/i.test(f)))
  check("CONTROL: the lifetime arm is reached through the CANONICAL tolerant test —\n    a legacy 'past_client' row gets the same fact, not a generic hello",
    buildWelcomeSituation({ contact_type: "past_client" }).facts.some((f) => /already closed with us/i.test(f)))
  check("CONTROL: that arm really has a second reader, so keeping it is not a\n    courtesy — welcome-avatar-video.ts calls buildWelcomeSituation itself",
    /buildWelcomeSituation\(/.test(src("lib/contact-promotion/welcome-avatar-video.ts")))
}

// ─── LAYER 5 — THE DIRECTIVES SEAM ───────────────────────────────────────────

async function layer5_directives() {
  console.log("\nLayer 5 — constraints reach the writer as DIRECTIVES, not as facts")

  let seen: CopyRequest | null = null
  const capture = async (req: CopyRequest) => { seen = req; return { body: "generated" } }

  await generatePersonaCopy(
    { goal: "g", facts: ["a fact"], channel: "email", persona: {}, directives: ["a constraint"] },
    { body: "fallback" },
    { generator: capture },
  )
  check("directives reach the generator", (seen as CopyRequest | null)?.directives?.[0] === "a constraint")
  check("...and they are NOT smuggled into `facts`, which the prompt declares is\n    the closed set the copy may draw ON (a constraint mistaken for a fact is a\n    constraint the model can repeat back to the reader)",
    ((seen as CopyRequest | null)?.facts ?? []).every((f) => !/a constraint/.test(f)))

  seen = null
  await generatePersonaCopy(
    { goal: "g", facts: ["a fact"], channel: "email", persona: {} },
    { body: "fallback" },
    { generator: capture },
  )
  check("CONTROL: omitting directives leaves the field undefined — the addition is\n    additive and no existing caller's request changed shape",
    (seen as CopyRequest | null)?.directives === undefined)

  const copy = src("lib/kernel/ai-copy.ts")
  check("the system prompt's directives block is CONDITIONAL, so a request without\n    directives reproduces the prior prompt byte-for-byte",
    /\.\.\.\(req\.directives\?\.length[\s\S]{0,200}?:\s*\[\]\)/.test(copy))
  check("CONTROL: the matcher would see an unconditional block",
    !/^\s*"5\. Additional non-negotiable/m.test(copy))
}

// ─── LAYER 6 — THE WIRING ────────────────────────────────────────────────────

function layer6_wiring() {
  console.log("\nLayer 6 — three senders became one, on BOTH lanes (read from STRIPPED source)")

  const manual = src("lib/contact-promotion/promote-lead-to-contact.ts")
  const auto = src("lib/kernel/lead-acquisition-handlers.ts")
  const inviteCore = src("lib/portal/portal-invite-core.ts")
  const cron = src("app/api/cron/intro-video-email-backfill/route.ts")
  const conversion = src("lib/contact-promotion/conversion-welcome.ts")
  const welcome = src("lib/kernel/client-welcome.ts")

  // BOTH LANES, ONE FUNCTION (§6).
  check("the MANUAL converter calls deliverConversionWelcome",
    /deliverConversionWelcome\(/.test(manual))
  check("the AUTOMATIC converter calls deliverConversionWelcome",
    /deliverConversionWelcome\(/.test(auto))
  check("CONTROL: the matcher can still see a missing call (it is absent from a\n    file that legitimately does not convert)",
    !/deliverConversionWelcome\(/.test(inviteCore))

  // NEITHER LANE HOLDS A COPY.
  for (const [name, source] of [["manual", manual], ["automatic", auto]] as const) {
    check(`the ${name} lane no longer calls the portal invite or the video spine\n    directly — one entry point, no copy to drift (§6)`,
      !/createSystemPortalInvite\(/.test(source)
      && !/grantPortalAccessForPromotedContact\(/.test(source)
      && !/ensureWelcomeAvatarVideo\(/.test(source))
  }
  check("CONTROL: those matchers still fire — the shared entry point DOES call both",
    /grantPortalAccessForPromotedContact\(/.test(conversion) && /ensureWelcomeAvatarVideo\(/.test(conversion))

  // THE ORDER: THE GRANT IS FIRST, ALWAYS.
  //
  // Sliced to the LIVE function body, not the whole file: `decideWelcomeTiming`
  // is also DEFINED in this file, above the entry point, and an index computed
  // over the whole source would compare a definition against a call site.
  const bodyStart = conversion.indexOf("export async function deliverConversionWelcome")
  check("CONTROL: the shared entry point is findable in the stripped source",
    bodyStart > -1)
  const body = conversion.slice(bodyStart)
  const grantAt = body.indexOf("grantPortalAccessForPromotedContact(")
  const videoAt = body.indexOf("ensureWelcomeAvatarVideo(")
  const timingAt = body.indexOf("decideWelcomeTiming(")
  check("the portal GRANT runs BEFORE the video is commissioned — a render that\n    fails or is suppressed can never cost a contact their portal access",
    grantAt > -1 && videoAt > grantAt)
  check("...and before the email timing is even decided",
    timingAt > videoAt)
  check("the grant is NOT gated on the video outcome — no early return between them",
    !/return[\s\S]{0,400}?ensureWelcomeAvatarVideo\(/.test(body.slice(grantAt, videoAt + 40)))

  // THE GENERIC BODY IS GONE.
  check("the hardcoded generic portal greeting is GONE from the invite core",
    !/your client portal is ready/i.test(inviteCore))
  check("CONTROL: the finder still recognises that string — it is quoted in the\n    tombstone, which STRIPPING correctly removes (§2: a tombstone is not a call\n    site), so the raw file still carries it and the stripped one does not",
    /your client portal is ready/i.test(raw("lib/portal/portal-invite-core.ts")))
  check("the invite core no longer writes a client_portal_messages greeting at all",
    !/client_portal_messages/.test(inviteCore))

  // THE CRON AUTHORS NOTHING.
  check("the cron no longer authors client-facing copy — its hardcoded subject and\n    body are gone",
    !/a quick intro from your agent/.test(cron) && !/I wanted to introduce myself/.test(cron))
  check("the cron delegates to the ONE welcome composer instead",
    /ensureClientWelcome\(/.test(cron))
  check("the cron no longer embeds a video into its own email body",
    !/embedVideoInEmail\(/.test(cron))
  check("CONTROL: embedVideoInEmail is still the ONE embed helper, used by the\n    survivor — the capability moved, it was not deleted",
    /embedVideoInEmail\(/.test(welcome))
  check("the cron sweeps every NON-TERMINAL status, not just 'rendering' — a row\n    stuck at 'queued' owed a welcome nobody would ever have sent",
    /\.in\("status", PENDING_WELCOME_STATUSES/.test(cron))
  check("CONTROL: the old single-status filter is gone",
    !/\.eq\("status", "rendering"\)[\s\S]{0,200}?contact_agent_assigned/.test(cron))

  // THE SURVIVOR CARRIES WHAT WAS MERGED ONTO IT.
  check("the survivor accepts the sweeper's already-resolved composite URL\n    (`videoOverride`) — the cron's one piece of knowledge with no home here",
    /videoOverride/.test(welcome) && /videoOverride/.test(cron))
  check("the survivor builds its copy from the ONE situation resolver — no second\n    personalizer was written",
    /buildWelcomeSituation\(/.test(welcome))
  check("...and passes its fair-housing directives INTO the writing prompt (§5)",
    /directives:\s*situation\.complianceDirectives/.test(welcome))
  check("CONTROL: the survivor is the only welcome composer — welcome-situation is\n    not re-implemented anywhere in the conversion path",
    !/TIMELINE_BUCKET_PHRASE/.test(welcome) && !/TIMELINE_BUCKET_PHRASE/.test(conversion))

  // NO DOUBLE SEND: the idempotency check is respected, not duplicated.
  check("the survivor still refuses a second welcome on its rationale tag, and\n    FAILS CLOSED when that ledger read is refused",
    /WELCOME_RATIONALE_TAG/.test(welcome) && /priorError/.test(welcome))
  check("...and a prior welcome RETURNS — the check is a gate, not a log line.\n    Three senders becoming one must not become two on a retried conversion",
    /if \(prior\) return SKIPPED/.test(welcome)
    && /if \(priorError\) return \{/.test(welcome))
  check("the shared entry point adds NO fourth idempotency check of its own — it\n    respects the existing one",
    !/agent_client_messages/.test(conversion))
  check("exactly ONE call site of ensureClientWelcome exists on the conversion\n    path (the shared entry point) plus the sweeper — never one per lane",
    (conversion.match(/ensureClientWelcome\(/g) ?? []).length === 1
    && !/ensureClientWelcome\(/.test(manual)
    && !/ensureClientWelcome\(/.test(auto))
}

// ─── LAYER 7 — THE LOOP CLOSES: THE GENERIC SPHERE WELCOME IS GONE, AND THE ────
// ─── THIRD (LEAD-DESK) LANE NOW REACHES THE SAME SURVIVOR ──────────────────────
//
// Wave 49, owner ruling 2026-09-10, verbatim: "the welcome note for when lead
// becomes a contact should come from either the listing or shopping manager
// depending on the contact type and their portal credentials, video and welcome
// goes out, not generic message."
//
// event-reactor.ts's D-undecies case 3 used to publish a signal_type
// "lead_converted_to_contact" that manager-signals.ts's
// "sphere_of_influence:lead_converted_to_contact" turned into a HARDCODED,
// ALWAYS-sphere_of_influence proposeClientMessage ("Hi ${firstName} — welcome! I'm
// here to help...") — a SECOND, WRONG welcome fired a few milliseconds AFTER the
// correct one, because the only call site that ever dispatches this KernelEvent
// (lib/kernel/lead-acquisition-handlers.ts handleLeadAssigned) already calls
// deliverConversionWelcome synchronously moments earlier. Both are DELETED. This
// layer proves the deletion is real and complete, and that it did not leave a
// hole: lib/kernel/crm.ts's THIRD converter (the manual lead-desk lane, reached
// from app/actions/lead-lifecycle.ts) had NO welcome of any kind before this wave
// — not even the generic one, because it never reaches processKernelEvent for
// this event at all — and now reaches the SAME shared entry point as the other
// two, so all three converters route by contact type through ONE resolver.
function layer7_loopCloses() {
  console.log("\nLayer 7 — the generic sphere welcome is gone; the third lane is wired (STRIPPED source)")

  const reactor = src("lib/kernel/event-reactor.ts")
  const signals = src("lib/kernel/manager-signals.ts")
  const registry = src("lib/kernel/signal-registry.ts")
  const crm = src("lib/kernel/crm.ts")
  const conversion = src("lib/contact-promotion/conversion-welcome.ts")

  // NO GENERIC SPHERE WELCOME REMAINS.
  check("event-reactor.ts no longer publishes signal_type lead_converted_to_contact",
    !/signalType:\s*["']lead_converted_to_contact["']/.test(reactor))
  check("manager-signals.ts no longer has a sphere_of_influence:lead_converted_to_contact handler",
    !/["']sphere_of_influence:lead_converted_to_contact["']/.test(signals))
  check("the hardcoded generic welcome body is gone from manager-signals.ts",
    !/I'm here to help with anything real-estate related/.test(signals))
  check("signal-registry.ts no longer catalogues lead_converted_to_contact as a published type",
    !/^\s*lead_converted_to_contact:\s*\{/m.test(registry))

  // POSITIVE CONTROLS (§2): every matcher above must still be ABLE to see the
  // exact defect it was written for. Built from a FIXTURE string containing the
  // retired shape — not from the live files (which no longer contain it) — so the
  // control proves the REGEX still fires, not that the file still has the bug.
  const retiredReactorFixture =
    'if (params.event === KernelEvent.LEAD_CONVERTED_TO_CONTACT) {\n' +
    '  await publishManagerSignal({ toManager: "sphere_of_influence", signalType:  "lead_converted_to_contact" })\n' +
    '}'
  const retiredHandlerFixture =
    '"sphere_of_influence:lead_converted_to_contact": async (signal, ctx) => {\n' +
    '  body: `Hi ${firstName} — welcome! I\'m here to help with anything real-estate related, now or down the road.`,\n' +
    '}'
  const retiredRegistryFixture =
    '  lead_converted_to_contact:      { consumers: ["sphere_of_influence"], disposition: "handled", kind: "update", what: "x" },\n'
  check("CONTROL: the signalType matcher still fires on the retired shape",
    /signalType:\s*["']lead_converted_to_contact["']/.test(retiredReactorFixture))
  check("CONTROL: the handler-key matcher still fires on the retired shape",
    /["']sphere_of_influence:lead_converted_to_contact["']/.test(retiredHandlerFixture))
  check("CONTROL: the generic-body matcher still fires on the retired shape",
    /I'm here to help with anything real-estate related/.test(retiredHandlerFixture))
  check("CONTROL: the registry-row matcher still fires on the retired shape",
    /^\s*lead_converted_to_contact:\s*\{/m.test(retiredRegistryFixture))

  // TOMBSTONES NAME THE SURVIVOR. A tombstone lives ONLY in a comment by
  // definition, so — unlike every other matcher on this layer — this one reads
  // RAW source (comments included) rather than stripped: stripping would erase
  // the very thing being asserted exists.
  check("event-reactor.ts's tombstone names the survivor at file:line",
    /deliverConversionWelcome/.test(raw("lib/kernel/event-reactor.ts")) && /conversion-welcome\.ts:342/.test(raw("lib/kernel/event-reactor.ts")))
  check("manager-signals.ts's tombstone names the survivor at file:line",
    /deliverConversionWelcome/.test(raw("lib/kernel/manager-signals.ts")) && /conversion-welcome\.ts:342/.test(raw("lib/kernel/manager-signals.ts")))
  check("signal-registry.ts's tombstone names the survivor at file:line",
    /deliverConversionWelcome/.test(raw("lib/kernel/signal-registry.ts")) && /conversion-welcome\.ts:342/.test(raw("lib/kernel/signal-registry.ts")))
  check("CONTROL: the tombstone check would fail without the survivor named —\n    a fixture carrying only the function name, no file:line, does not satisfy it",
    /deliverConversionWelcome/.test("// deliverConversionWelcome handles this now")
    && !/conversion-welcome\.ts:342/.test("// deliverConversionWelcome handles this now"))

  // THE THIRD LANE IS WIRED.
  check("lib/kernel/crm.ts (the manual lead-desk convertLeadToContact) now calls\n    deliverConversionWelcome — the gap this wave closed",
    /deliverConversionWelcome\(/.test(crm))
  check("CONTROL: the matcher can still see a missing call (it is absent from a\n    file that legitimately does not convert)",
    !/deliverConversionWelcome\(/.test(src("lib/portal/portal-invite-core.ts")))
  check("crm.ts does not hold its own copy of the portal grant or the video spine\n    — it reaches them only through the shared entry point (§6)",
    !/createSystemPortalInvite\(/.test(crm)
    && !/grantPortalAccessForPromotedContact\(/.test(crm)
    && !/ensureWelcomeAvatarVideo\(/.test(crm)
    && !/ensureClientWelcome\(/.test(crm))
  check("the call is gated on !isDuplicate — a re-converted (already-linked) lead\n    does not re-trigger a welcome lookup, matching the audience-promote guard\n    beside it",
    /if \(!result\.isDuplicate\) \{[\s\S]{0,800}?deliverConversionWelcome\(/.test(crm))

  // ALL THREE CONVERTERS NOW SHARE ONE ROUTING RESOLVER — no converter re-derives
  // "which manager owns this welcome" itself; every one of them delegates to
  // deliverConversionWelcome, which is the only caller of resolveWelcomeManagers
  // on the conversion path (client-welcome.ts defines it; the sweeper does not
  // call it — the sweeper releases an ALREADY-ROUTED welcome).
  const manual = src("lib/contact-promotion/promote-lead-to-contact.ts")
  const auto = src("lib/kernel/lead-acquisition-handlers.ts")
  for (const [name, source] of [["manual (direct-intake)", manual], ["automatic", auto], ["manual (lead-desk)", crm]] as const) {
    check(`${name} lane does not re-derive the welcome manager itself\n    (no local resolveWelcomeManagers copy)`,
      !new RegExp(`function resolveWelcomeManagers`).test(source))
  }
  check("CONTROL: resolveWelcomeManagers IS defined, exactly once, on the survivor's\n    own resolver file",
    (src("lib/kernel/client-welcome.ts").match(/export function resolveWelcomeManagers/g) ?? []).length === 1)
}

// ─── LAYER 8 — THE FOURTH CONVERTER: THE AI ISA'S BUYER INTENT-CONVERSION LANE ──
//
// Wave 49 pt.2, owner ruling 2026-09-10, same words as Layer 7: "the welcome
// note for when lead becomes a contact should come from either the listing or
// shopping manager depending on the contact type... portal credentials, video
// and welcome goes out, not generic message."
//
// lib/ai-isa/convert-buyer-lead-on-intent.ts::convertBuyerLeadOnIntent is the
// FOURTH lead→contact converter (Layer 7 proved the first three share one
// resolver). Unlike the third lane, this one did NOT have zero welcome — it had
// its OWN, a direct "buyer_welcome_reel_handoff" publish to the Asset Manager:
// a second video-commissioning pipeline (Director "lead_intro" via
// commissionVideo) duplicating the ONE avatar spine the other three lanes
// share, feeding a GATED email that never granted real portal credentials and
// needed a human approval the assigned agent cannot give for their own welcome.
// This layer proves that duplicate is GONE and the fourth lane now reaches the
// SAME ONE welcome path, EXACTLY ONCE, gated the same way the other three are.
function layer8_fourthConverter() {
  console.log("\nLayer 8 — the AI ISA buyer intent-conversion lane reaches the ONE welcome path exactly once (STRIPPED source)")

  const buyerIntent = src("lib/ai-isa/convert-buyer-lead-on-intent.ts")
  const signals = src("lib/kernel/manager-signals.ts")
  const registry = src("lib/kernel/signal-registry.ts")
  const reelSituation = src("lib/ai-isa/contact-reel-situation.ts")

  // ── THE FOURTH LANE NOW CALLS THE SURVIVOR, EXACTLY ONCE ─────────────────
  check("convertBuyerLeadOnIntent calls deliverConversionWelcome",
    /deliverConversionWelcome\(/.test(buyerIntent))
  check("...exactly ONCE — never two welcomes for one conversion",
    (buyerIntent.match(/deliverConversionWelcome\(/g) ?? []).length === 1)
  check("CONTROL: the matcher can still see a missing call (absent from a sibling\n    file that legitimately does not convert a buyer)",
    !/deliverConversionWelcome\(/.test(src("lib/ai-isa/convert-seller-lead-on-intent.ts")))

  // ── THE DUPLICATE IS GONE ─────────────────────────────────────────────────
  check("the lane no longer publishes its own buyer_welcome_reel_handoff signal",
    !/signalType:\s*["']buyer_welcome_reel_handoff["']/.test(buyerIntent))
  check("...and no longer holds its own copy of the portal grant or the video spine\n    — one entry point, no copy to drift (§6)",
    !/grantPortalAccessForPromotedContact\(/.test(buyerIntent)
    && !/ensureWelcomeAvatarVideo\(/.test(buyerIntent)
    && !/commissionVideo\(/.test(buyerIntent))
  check("CONTROL: the matcher still fires on the retired shape — a fixture built\n    from the exact literal this lane used to publish",
    /signalType:\s*["']buyer_welcome_reel_handoff["']/.test(
      'await publishManagerSignal({ toManager: "asset_manager", signalType: "buyer_welcome_reel_handoff" })',
    ))

  // ── GATED ON A FRESH CONVERSION — A RE-CONVERSION NEVER RE-WELCOMES ───────
  // Sliced to the live function body so an unrelated `wasAlreadyConverted` text
  // earlier in the file (the pre-read comment) cannot satisfy the ordering check.
  const fnStart = buyerIntent.indexOf("export async function convertBuyerLeadOnIntent")
  check("CONTROL: the function is findable in the stripped source", fnStart > -1)
  const fnBody = buyerIntent.slice(fnStart)
  const guardAt = fnBody.indexOf("if (!wasAlreadyConverted && agentId)")
  const welcomeAt = fnBody.indexOf("deliverConversionWelcome(")
  check("the welcome call sits INSIDE the `!wasAlreadyConverted` guard — a\n    re-conversion (the idempotent replay every reason can trigger) never\n    re-welcomes an already-converted contact",
    guardAt > -1 && welcomeAt > guardAt)
  check("CONTROL: that guard is the SAME one the agent notification (Step 2) already\n    used — this call was added to an existing gate, not a new, looser one",
    /if \(!wasAlreadyConverted && agentId\) \{[\s\S]{0,600}?notifications["')]/.test(fnBody))

  // ── THE OLD VIDEO SITUATION BUILDER IS GONE TOO — THE ORPHAN THE RETIREMENT
  //    LEFT BEHIND (§1), NOT A SECOND CAPABILITY LEFT DANGLING ──────────────
  check("the Director situation builder the retired handler used\n    (buildContactWelcomeSituation) no longer exists — its only caller is gone,\n    and the capability it built (a buyer welcome video) already lives at the\n    survivor's shared avatar spine",
    !/export function buildContactWelcomeSituation/.test(reelSituation))
  check("CONTROL: the sibling persona resolver in the SAME file is untouched — the\n    matcher distinguishes 'this one function' from 'the whole file'",
    /export function contactReelPersona/.test(reelSituation))

  // ── THE HANDLER AND THE REGISTRY ROW ARE BOTH GONE ────────────────────────
  check("manager-signals.ts no longer has an asset_manager:buyer_welcome_reel_handoff handler",
    !/["']asset_manager:buyer_welcome_reel_handoff["']/.test(signals))
  check("signal-registry.ts no longer catalogues buyer_welcome_reel_handoff as a\n    published type",
    !/^\s*buyer_welcome_reel_handoff:\s*\{/m.test(registry))
  check("CONTROL: both matchers still fire on the retired shapes",
    /["']asset_manager:buyer_welcome_reel_handoff["']/.test(
      '"asset_manager:buyer_welcome_reel_handoff": async (signal, ctx) => { return null },',
    )
    && /^\s*buyer_welcome_reel_handoff:\s*\{/m.test(
      '  buyer_welcome_reel_handoff:{ consumers: ["asset_manager"], disposition: "handled", kind: "handoff", what: "x" },\n',
    ))

  // ── AND (LAYER-1-STYLE CONTROL): SIGNAL-INTEGRITY MUST STILL SEE THE
  //    HANDLED/CATALOGUED PAIR IT WAS BUILT TO CATCH — A NEIGHBOUR THAT
  //    STAYED, PROVING THE STRIPPED SCAN ABOVE ISN'T JUST BLIND ─────────────
  check("CONTROL: a NEIGHBOURING reel handoff this wave did NOT touch is still both\n    catalogued and handled — the retirement removed exactly one pair, not the\n    whole shape the scanner looks for",
    /["']asset_manager:seller_conversion_reel_handoff["']/.test(signals)
    && /^\s*seller_conversion_reel_handoff:\s*\{/m.test(registry))

  // ── TOMBSTONES NAME THE SURVIVOR (raw source — a tombstone lives in a comment) ─
  check("manager-signals.ts's tombstone names the survivor at file:line",
    /deliverConversionWelcome/.test(raw("lib/kernel/manager-signals.ts")) && /conversion-welcome\.ts:342/.test(raw("lib/kernel/manager-signals.ts")))
  check("signal-registry.ts's tombstone names the survivor at file:line",
    /deliverConversionWelcome/.test(raw("lib/kernel/signal-registry.ts")) && /conversion-welcome\.ts:342/.test(raw("lib/kernel/signal-registry.ts")))
  check("contact-reel-situation.ts's tombstone names where the capability now lives",
    /ensureWelcomeAvatarVideo/.test(raw("lib/ai-isa/contact-reel-situation.ts"))
    && /conversion-welcome\.ts:342/.test(raw("lib/ai-isa/contact-reel-situation.ts")))
  check("convert-buyer-lead-on-intent.ts's own tombstone names the survivor too",
    /deliverConversionWelcome/.test(raw("lib/ai-isa/convert-buyer-lead-on-intent.ts"))
    && /conversion-welcome\.ts:342/.test(raw("lib/ai-isa/convert-buyer-lead-on-intent.ts")))
  check("CONTROL: the tombstone check would fail without the survivor named — a\n    fixture carrying only the function name, no file:line, does not satisfy it",
    /deliverConversionWelcome/.test("// deliverConversionWelcome handles this now")
    && !/conversion-welcome\.ts:342/.test("// deliverConversionWelcome handles this now"))

  // ── THE FOURTH LANE JOINS THE SAME "NO LOCAL RESOLVER COPY" PROOF AS THE
  //    OTHER THREE (§6 — one resolver, four callers) ─────────────────────────
  check("the buyer intent-conversion lane does not re-derive the welcome manager\n    itself (no local resolveWelcomeManagers copy) — same rule Layer 7 proved for\n    the other three converters",
    !/function resolveWelcomeManagers/.test(buyerIntent))
}

// ─── LAYER 9 — FORMS REACH THE ONE WELCOME PATH EXACTLY ONCE, NEVER A GENERIC
//     DRAFT; OPEN-HOUSE ORIGIN REACHES BOTH THE COPY AND THE VIDEO SCRIPT; THE
//     DEFAULT LANGUAGE IS "en" WHEREVER NONE IS KNOWN (STRIPPED source + pure) ──
//
// Owner rulings, 2026-09-10 wave 51, verbatim:
//   "if a form was submitted, then the welcome message with login to their
//   portal/welcome video should be going out"
//   "contact came from open house — same welcome email but mentions the open
//   house with welcome video/portal invite"
//   "the default language is english"
function layer9_formsAndOpenHouse() {
  console.log("\nLayer 9 — forms reach the ONE welcome path exactly once; open-house origin reaches copy + video; default language (STRIPPED source + pure)")

  const reactor = src("lib/kernel/event-reactor.ts")
  const signals = src("lib/kernel/manager-signals.ts")
  const registry = src("lib/kernel/signal-registry.ts")

  // ── FORMS: THE GENERIC FIRST-TOUCH DRAFT IS GONE ──────────────────────────
  check("manager-signals.ts no longer has the generic ai_isa:form_submission_received\n    first-touch draft",
    !/["']ai_isa:form_submission_received["']/.test(signals))
  check("...its hardcoded 'Thanks for reaching out' string is gone with it",
    !/Thanks for reaching out/.test(signals))
  check("CONTROL: both matchers still fire on the retired shapes",
    /["']ai_isa:form_submission_received["']/.test('"ai_isa:form_submission_received": async () => null,')
    && /Thanks for reaching out/.test('`Thanks for reaching out, ${firstName}!`'))

  // ── FORMS: THE READER CALLS THE ONE WELCOME PATH, EXACTLY ONCE, NEVER A DRAFT ──
  const formStart = reactor.indexOf("if (params.event === KernelEvent.FORM_SUBMISSION_RECEIVED)")
  check("CONTROL: the FORM_SUBMISSION_RECEIVED handler is findable in stripped source", formStart > -1)
  const formNextIf = reactor.indexOf("if (params.event === KernelEvent.", formStart + 40)
  const formBlock = reactor.slice(formStart, formNextIf > -1 ? formNextIf : formStart + 4000)
  check("the FORM_SUBMISSION_RECEIVED handler calls deliverConversionWelcome",
    /deliverConversionWelcome\(/.test(formBlock))
  check("...exactly once",
    (formBlock.match(/deliverConversionWelcome\(/g) ?? []).length === 1)
  check("...routed by resolveWelcomeManagers (contact type decides listing_concierge\n    vs shopping_agent), never a hardcoded manager",
    /resolveWelcomeManagers\(/.test(formBlock))
  check("...and it does NOT stage a generic first-touch message — the ruling forbids\n    a generic draft, and captureContact's own inline welcome already covers the\n    'send something' half",
    !/proposeClientMessage\(/.test(formBlock))
  check("CONTROL: a sibling handler this wave did not touch (AUTHORITY_BLOCKED) has\n    neither call — the matchers aren't just matching everywhere in the file",
    (() => {
      const s = reactor.indexOf("if (params.event === KernelEvent.AUTHORITY_BLOCKED)")
      const block = reactor.slice(s, s + 1200)
      return s > -1 && !/deliverConversionWelcome\(/.test(block) && !/resolveWelcomeManagers\(/.test(block)
    })())

  // ── FORMS: THE REGISTRY AGREES WITH THE CODE ──────────────────────────────
  check("signal-registry.ts routes form_submission_received to the real welcome\n    managers (listing_concierge / shopping_agent), not ai_isa",
    /form_submission_received:\s*\{\s*consumers:\s*\["listing_concierge",\s*"shopping_agent"\]/.test(registry))
  check("CONTROL: the matcher would still catch the OLD ai_isa-only routing",
    /form_submission_received:\s*\{\s*consumers:\s*\["ai_isa"\]/.test(
      'form_submission_received:   { consumers: ["ai_isa"], disposition: "handled", kind: "update", what: "x" },',
    ))

  // ── FORMS: AN ADMIN CAN DECLARE A FORM'S PERSONA (BUILD, §1.2 — no invented
  //    classifier for a generic admin-built form with no persona field) ──────
  // Wave 142 (lane 142E): the route's capture consolidated onto the kernel's captureFormSubmission (the ONE
  // capture command); the declared persona moved with it. The survivor is asserted, the route is asserted to use it.
  const formsRoute = src("app/api/forms/submit/route.ts"), formsKernel = src("lib/kernel/lead-magnets.ts")
  check("captureFormSubmission (lib/kernel/lead-magnets.ts — the survivor of /api/forms/submit's capture) reads an admin-declared default_contact_type\n    from lead_capture_forms.settings and applies it to the new contact, instead\n    of guessing one; the route captures through it",
    /default_contact_type/.test(formsKernel) && /newRow\.contact_type = resolvedContactType/.test(formsKernel) && /captureFormSubmission\(/.test(formsRoute))

  // ── OPEN HOUSE: ALL THREE READERS/CALLERS REACH THE ONE WELCOME PATH ──────
  const attendedStart = reactor.indexOf("if (params.event === KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED)")
  const resolvedStart = reactor.indexOf("if (params.event === KernelEvent.OPEN_HOUSE_CONTACT_RESOLVED)")
  check("CONTROL: both open-house event-reactor handlers are findable", attendedStart > -1 && resolvedStart > -1)
  const attendedBlock = reactor.slice(attendedStart, attendedStart + 2600)
  const resolvedBlock = reactor.slice(resolvedStart, resolvedStart + 2600)
  check("OPEN_HOUSE_ATTENDEE_CAPTURED hands the contact to deliverConversionWelcome\n    with an origin resolved via resolveOpenHouseWelcomeOrigin",
    /deliverConversionWelcome\(/.test(attendedBlock) && /resolveOpenHouseWelcomeOrigin\(/.test(attendedBlock))
  check("OPEN_HOUSE_CONTACT_RESOLVED does too — the attendee's becomes-a-contact moment",
    /deliverConversionWelcome\(/.test(resolvedBlock) && /resolveOpenHouseWelcomeOrigin\(/.test(resolvedBlock))
  const sellerOpenHouse = src("app/actions/seller-open-house.ts")
  check("seller-open-house.ts's convertAttendeeToContact (the agent-driven post-event\n    conversion lane) calls deliverConversionWelcome too — a third entry point,\n    the same ONE path",
    /deliverConversionWelcome\(/.test(sellerOpenHouse) && /resolveOpenHouseWelcomeOrigin\(/.test(sellerOpenHouse))
  check("CONTROL: dedupe is by CONTACT ID, not by which of the three reached it first\n    — ensureClientWelcome's own per-contact ledger tag check is unchanged by this\n    wave (still reads agent_client_messages before writing)",
    /ilike\("rationale", `\$\{WELCOME_RATIONALE_TAG\}%`\)/.test(src("lib/kernel/client-welcome.ts")))

  // ── OPEN HOUSE: A NEW ATTENDEE IS CLASSIFIED SO THE WELCOME CAN ROUTE ─────
  const attendRoute = src("app/api/open-house/attend/route.ts")
  check("app/api/open-house/attend/route.ts classifies a new open-house contact as\n    'buyer' — the codebase's OWN existing convention (resolveOrCreateOpenHouseContact\n    and convertAttendeeToContact already did this before this wave), not a new guess",
    /contact_type:\s*["']buyer["']/.test(attendRoute))
  check("CONTROL: the two pre-existing open-house contact-creation paths already used\n    this exact classification — proving it is precedent, not invention",
    /contact_type:\s*["']buyer["']/.test(src("lib/kernel/open-house.ts"))
    && /contact_type:\s*["']buyer["']/.test(sellerOpenHouse))

  // ── OPEN HOUSE: endOpenHouseEvent's ATTENDEE-SCORED emit REACHES THE REACTOR
  //    TOO (wave 52) — was a raw lifecycle_events insert with no fan-out, so
  //    the OPEN_HOUSE_ATTENDEE_CAPTURED handler above never ran for an
  //    attendee scored at event-close. Isolated to the function so a
  //    processKernelEvent call anywhere else in the file (e.g.
  //    convertAttendeeToContact's CONTACT_CREATED emit) cannot false-positive
  //    this check. ──────────────────────────────────────────────────────────
  const endEventStart = sellerOpenHouse.indexOf("export async function endOpenHouseEvent")
  const endEventNextExport = sellerOpenHouse.indexOf("export async function", endEventStart + 40)
  check("CONTROL: endOpenHouseEvent is findable in the stripped source", endEventStart > -1 && endEventNextExport > endEventStart)
  const endEventBlock = sellerOpenHouse.slice(endEventStart, endEventNextExport > -1 ? endEventNextExport : endEventStart + 6000)
  // RE-ANCHORED TO THE RULE (wave 101C, CLAUDE.md §2 — no waypoint pins): the rule is "the audit row is
  // written AND the reactor runs for the same event, with the attendee's contact". Wave 100 spelled it as an
  // auditOnly emit + a separate processKernelEvent; wave 101C merged the pair into ONE emitKernelEvent that
  // writes the row and fans out (no auditOnly), carrying contactId. Either spelling satisfies the rule.
  const oneEmit = /emitKernelEvent\(\{(?:(?!auditOnly)[^}])*event:\s*KernelEvent\.OPEN_HOUSE_ATTENDEE_CAPTURED(?:(?!auditOnly)[^}])*contactId:\s*attendee\.contact_id(?:(?!auditOnly)[^}])*\}/
  const mergedOrPaired = (s: string) => oneEmit.test(s) ||
    (/emitKernelEvent\(\{[^}]*event:\s*KernelEvent\.OPEN_HOUSE_ATTENDEE_CAPTURED[\s\S]{0,500}?auditOnly:\s*true/.test(s) &&
      /processKernelEvent\(\{[^}]*event:\s*KernelEvent\.OPEN_HOUSE_ATTENDEE_CAPTURED/s.test(s))
  check("endOpenHouseEvent still writes the lifecycle_events AUDIT row for\n    OPEN_HOUSE_ATTENDEE_CAPTURED (the fix adds the reactor call, it does not\n    remove the audit trail)",
    /event_type:\s*KernelEvent\.OPEN_HOUSE_ATTENDEE_CAPTURED/.test(endEventBlock) || mergedOrPaired(endEventBlock))
  check("...AND the reactor runs for the SAME event (one fanning-out emit carrying the\n    contact, or the row + a processKernelEvent), so deliverConversionWelcome,\n    when the attendee already resolved to a contact, actually runs",
    mergedOrPaired(endEventBlock))
  check("POSITIVE CONTROL: an audit-only row with NO reactor call fails the rule",
    !mergedOrPaired(`emitKernelEvent({ event: KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED, contactId: attendee.contact_id, auditOnly: true })`))
  check("CONTROL: the matcher requires BOTH the emit call and the enum on the same\n    call — a bare `processKernelEvent(` elsewhere in the block (e.g. a\n    differently-typed event) would not satisfy it",
    !/processKernelEvent\(\{[^}]*event:\s*KernelEvent\.LISTING_OPEN_HOUSE_COMPLETED/s.test(endEventBlock))
  check("no double-delivery: welcome dedup is per-contact via ensureClientWelcome\n    (same ledger check as every other entry point), so a contact already\n    welcomed at check-in time (app/api/open-house/attend/route.ts) is a no-op\n    when endOpenHouseEvent's emit reaches the reactor a second time — never a\n    second send",
    /ilike\("rationale", `\$\{WELCOME_RATIONALE_TAG\}%`\)/.test(src("lib/kernel/client-welcome.ts")))

  // ── ORIGIN REACHES THE COPY (PURE) — NEVER A LITERAL HARDCODED STRING ─────
  const origin: WelcomeOrigin = { kind: "open_house", listingAddress: "123 Main St", openHouseDate: "2026-09-14" }
  const situationWithOrigin = buildWelcomeSituation(null, { origin })
  check("buildWelcomeSituation turns an open-house origin into a THEM-FIRST FACT\n    (the journey map supplies the facts; the writer supplies the wording)\n    mentioning the address and date",
    situationWithOrigin.facts.some((f) => f.includes("123 Main St") && f.includes("2026-09-14")))
  check("...and marks the situation as situational even with no contact row at all\n    — meeting someone in person IS a situational fact on its own",
    situationWithOrigin.isSituational === true)
  const situationWithoutOrigin = buildWelcomeSituation(null)
  check("CONTROL: with no origin, no open-house fact is invented",
    !situationWithoutOrigin.facts.some((f) => f.toLowerCase().includes("open house")))

  const fallbackWithOrigin = composeClientWelcome({ journey: "buyer", addressAs: "Jordan", agentName: "Sam", origin })
  check("the deterministic FALLBACK (the floor used when the AI gateway is down, not\n    only the generated copy) mentions the open-house visit too",
    fallbackWithOrigin.body.includes("123 Main St") && fallbackWithOrigin.body.includes("2026-09-14"))
  const fallbackWithoutOrigin = composeClientWelcome({ journey: "buyer", addressAs: "Jordan", agentName: "Sam" })
  check("CONTROL: without an origin the fallback carries no phantom open-house mention",
    !fallbackWithoutOrigin.body.includes("123 Main St"))

  // ── ORIGIN REACHES THE AVATAR SCRIPT TOO — SAME SITUATION BUILDER, NOT A
  //    SECOND COPY OF THE OPEN-HOUSE SENTENCE (§6) ──────────────────────────
  const avatarVideoSrc = src("lib/contact-promotion/welcome-avatar-video.ts")
  check("welcome-avatar-video.ts threads its `origin` param into the SAME\n    buildWelcomeSituation call the welcome email uses",
    /buildWelcomeSituation\(contact,\s*\{\s*origin:\s*params\.origin/.test(avatarVideoSrc))

  // ── deliverConversionWelcome CARRIES origin TO BOTH THE VIDEO AND THE EMAIL ──
  const conversionWelcomeSrc = src("lib/contact-promotion/conversion-welcome.ts")
  check("deliverConversionWelcome forwards `origin` to ensureWelcomeAvatarVideo\n    (the video 'may mention the visit', per the ruling)",
    /ensureWelcomeAvatarVideo\(supabase,\s*\{[\s\S]{0,200}?origin:\s*params\.origin/.test(conversionWelcomeSrc))
  check("...and to ensureClientWelcome (the email)",
    /ensureClientWelcome\(supabase,\s*\{[\s\S]{0,300}?\},\s*\{\s*origin:\s*params\.origin/.test(conversionWelcomeSrc))

  // ── DEFAULT LANGUAGE: "en", from the ONE shared constant (§6 — never a second
  //    copy), wherever the welcome resolves a language and none is known ──────
  const situationSrc = src("lib/contact-promotion/welcome-situation.ts")
  check("welcome-situation.ts imports DEFAULT_LANGUAGE from its canonical home\n    (lib/video/multilingual-reel.ts — lane JA's shared constant) rather than\n    inventing a second one",
    /import\s*\{\s*DEFAULT_LANGUAGE\s*\}\s*from\s*["']@\/lib\/video\/multilingual-reel["']/.test(situationSrc))
  check("...and every welcome situation carries an explicit 'write in {language}'\n    directive, so both the email copy AND the avatar script (same builder) honor\n    the same default",
    /Write this in \$\{language\}/.test(situationSrc))
  check("CONTROL: no second DEFAULT_LANGUAGE-shaped constant was declared alongside it",
    !/const DEFAULT_LANGUAGE\s*=/.test(situationSrc))
  check("language resolves to DEFAULT_LANGUAGE when the caller passes none — proven\n    live, not just by import (contacts carries no language column today, so this\n    is the ONLY path)",
    buildWelcomeSituation(null).language === buildWelcomeSituation(null, { language: "" }).language)
}

// ─── LAYER 10 — WAVE 145 (lane 145E): THE HUMAN-APPROVED EXCEPTION, ITS RELEASE, AND THE STATED FORMAT ──────
//
// Owner ruling 17: "Failure = visible pending/recoverable state with a human-approved exception, never falsely sent, never
// silently pending forever." Driven at RUNTIME against the in-memory client (scripts/in-memory-supabase.ts), every arm with a
// refusal control; the wiring read from STRIPPED source with a positive control per matcher (CLAUDE.md §2).
async function layer10_exceptionAndFormat() {
  console.log("\nLayer 10 — ruling 17's human-approved exception + its release; contract C3's stated format (runtime + STRIPPED source)")
  const { memSupabase } = await import("./in-memory-supabase")
  const cw = await import("../lib/contact-promotion/conversion-welcome")
  const B = "b-145", OTHER = "b-other", NOW = new Date("2026-10-27T15:00:00Z")

  // FILING — one PENDING approval item per contact, tenant-pinned, counted; a retry never files a second.
  const svc = memSupabase({ approval_items: [] })
  const f1 = await cw.holdWelcomeForException(svc as never, { brokerageId: B, contactId: "c1", agentId: "ag1", reason: "no avatar on file", now: NOW })
  const f2 = await cw.holdWelcomeForException(svc as never, { brokerageId: B, contactId: "c1", agentId: "ag1", reason: "no avatar on file", now: NOW })
  const items = (svc.tables.approval_items ?? []).filter((r) => r.item_type === cw.WELCOME_EXCEPTION_ITEM_TYPE)
  check("W145 a held welcome files ONE pending approval item (item_type welcome_without_video, item_id = the contact, its tenant, its agent) — the visible, recoverable state",
    f1.filed && !f1.existing && items.length === 1 && items[0].status === "pending" && items[0].item_id === "c1" && items[0].brokerage_id === B && items[0].agent_id === "ag1"
    && /Approve:/.test(String(JSON.parse(String(items[0].review_notes)).excerpt)), JSON.stringify({ f1, n: items.length }))
  check("W145 …a retried conversion / sweep files NO second item (idempotent per contact)", f2.filed && f2.existing && items.length === 1)
  const refusedFile = await cw.holdWelcomeForException(memSupabase({}, { refuse: { approval_items: "RLS refused" } }) as never, { brokerageId: B, contactId: "c9", agentId: null, reason: "x" })
  check("W145 a REFUSED approval read files nothing and SAYS so (supabase-js resolves a refusal — fail closed, never 'filed')", !refusedFile.filed && /refused/.test(refusedFile.error ?? ""))

  // RELEASE — only APPROVED items inside the window, only for contacts not yet welcomed, through the sweeper's survivor call.
  const recent = new Date(NOW.getTime() - 2 * HOUR).toISOString(), old = new Date(NOW.getTime() - 30 * 24 * HOUR).toISOString()
  const rel = memSupabase({
    approval_items: [
      { id: "a1", brokerage_id: B, item_type: cw.WELCOME_EXCEPTION_ITEM_TYPE, item_id: "c1", status: "approved", reviewed_at: recent },
      { id: "a2", brokerage_id: B, item_type: cw.WELCOME_EXCEPTION_ITEM_TYPE, item_id: "c2", status: "approved", reviewed_at: recent },
      { id: "a3", brokerage_id: B, item_type: cw.WELCOME_EXCEPTION_ITEM_TYPE, item_id: "c3", status: "pending", reviewed_at: null },
      { id: "a4", brokerage_id: B, item_type: cw.WELCOME_EXCEPTION_ITEM_TYPE, item_id: "c4", status: "rejected", reviewed_at: recent },
      { id: "a5", brokerage_id: B, item_type: cw.WELCOME_EXCEPTION_ITEM_TYPE, item_id: "c5", status: "approved", reviewed_at: old },
      { id: "a6", brokerage_id: OTHER, item_type: cw.WELCOME_EXCEPTION_ITEM_TYPE, item_id: "c6", status: "approved", reviewed_at: recent },
      { id: "a7", brokerage_id: B, item_type: "local_campaign_idea", item_id: "c7", status: "approved", reviewed_at: recent },
    ],
    contacts: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"].map((id) => ({ id, brokerage_id: B, contact_type: "buyer", first_name: id, last_name: "Test" })),
    agent_client_messages: [{ id: "m2", brokerage_id: B, recipient_contact_id: "c2", rationale: "client_welcome_v1 — buyer", status: "sent" }],
  })
  const sent: string[] = []
  const out = await cw.releaseApprovedWelcomeExceptions(rel as never, { now: NOW }, { ensureWelcome: async (c) => { sent.push(c.id); return { state: "sent", reason: null } } })
  check("W145 an APPROVED exception is released through the sweeper's survivor call — exactly once, for the contact with no welcome yet",
    out.error === null && sent.length === 1 && sent[0] === "c1" && out.released === 1, `sent=${sent.join(",")} err=${out.error} results=${JSON.stringify(out.results)}`)
  check("W145 …an already-welcomed contact is NOT sent a second welcome; a PENDING or REJECTED item, a stale approval and another item type are never released",
    out.results.some((r) => r.contactId === "c2" && r.outcome === "already_welcomed") && !sent.includes("c3") && !sent.includes("c4") && !sent.includes("c5") && !sent.includes("c7"))
  check("W145 …and an item whose tenant does not own the contact is refused at the contact read (tenant-pinned), never sent",
    !sent.includes("c6") && out.results.some((r) => r.contactId === "c6" && r.outcome === "skipped"), JSON.stringify(out.results))
  const refusedRel = await cw.releaseApprovedWelcomeExceptions(memSupabase({}, { refuse: { approval_items: "RLS refused" } }) as never, { now: NOW }, { ensureWelcome: async (c) => { sent.push(c.id); return { state: "sent" } } })
  check("W145 a REFUSED approval read releases NOTHING and reports the refusal (a broken read is not an empty queue)", !!refusedRel.error && refusedRel.released === 0 && sent.length === 1)

  // CONTRACT C3 — the welcome's view of the contact's STATED preferences (read through lane 145H's reader; never inferred).
  const pref = memSupabase({ contacts: [
    { id: "p1", brokerage_id: B, preferred_language: "es", accessibility_preferences: { communication_format: "text", captions: true, text_size: "large" } },
    { id: "p2", brokerage_id: B, accessibility_preferences: {} },
    { id: "p3", brokerage_id: B, accessibility_preferences: { portal_modality: "screen_reader", communication_format: "video" } },
  ] })
  const a1 = await cw.readWelcomeAccessibility(pref, { brokerageId: B, contactId: "p1" })
  const a2 = await cw.readWelcomeAccessibility(pref, { brokerageId: B, contactId: "p2" })
  const a3 = await cw.readWelcomeAccessibility(memSupabase({}, { refuse: { contacts: "RLS refused" } }), { brokerageId: B, contactId: "p1" })
  check("W145 C3: a STATED text format means no video wait; captions → the transcript; large text → larger type; the language is carried",
    !!a1.accessibility && a1.accessibility.statedNoVideo && a1.accessibility.transcript && a1.accessibility.largeText && a1.accessibility.language === "es" && a1.accessibility.stated, JSON.stringify(a1))
  check("W145 C3 (control): NOTHING stated → the defaults, nothing guessed about the person", !!a2.accessibility && !a2.accessibility.stated && !a2.accessibility.statedNoVideo && !a2.accessibility.largeText, JSON.stringify(a2))
  check("W145 C3: an unreadable preference read returns NO preferences plus the reason — the defaults apply, never an invented need", a3.accessibility === null && !!a3.blindSpot, JSON.stringify(a3))
  const a4 = await cw.readWelcomeAccessibility(pref, { brokerageId: B, contactId: "p3" })
  check("W145 C3 (H's one table): a screen-reader portal means a transcript; a stated VIDEO format still waits for the video (only 'text' skips it)",
    !!a4.accessibility && a4.accessibility.transcript && !a4.accessibility.statedNoVideo && !a4.accessibility.largeText, JSON.stringify(a4))

  // WIRING (STRIPPED source).
  const cron = src("app/api/cron/intro-video-email-backfill/route.ts")
  const conv = src("lib/contact-promotion/conversion-welcome.ts")
  const comp = src("lib/kernel/client-welcome.ts")
  const entry = conv.slice(conv.indexOf("export async function deliverConversionWelcome"))
  check("W145 WIRED: the sweeper files the exception on hold_for_exception and releases APPROVED ones through ensureClientWelcome",
    /verdict\.action === "hold_for_exception"[\s\S]{0,1200}holdWelcomeForException\(svc/.test(cron) && /releaseApprovedWelcomeExceptions\(svc[\s\S]{0,200}ensureClientWelcome\(/.test(cron))
  check("W145 WIRED: the conversion entry point files the exception and RETURNS before the send when no video can ride the welcome",
    /if \(timing\.action === "hold_for_exception"\)[\s\S]{0,600}holdWelcomeForException\(supabase[\s\S]{0,1600}return out/.test(entry) && entry.indexOf('timing.action === "hold_for_exception"') < entry.indexOf("ensureClientWelcome"))
  check("W145 WIRED (C3): the composer reads the stated preferences through the one reader when the caller did not, and renders large text / the transcript",
    /readWelcomeAccessibility\(svc/.test(comp) && /largeText: accessibility\?\.largeText === true/.test(comp) && /script_content/.test(comp))
  check("(control) the exception-wiring matcher rejects a sweeper that sends without the video past the deadline",
    !/verdict\.action === "hold_for_exception"[\s\S]{0,1200}holdWelcomeForException\(svc/.test('if (verdict.action === "send_without_video") { await ensureClientWelcome(svc, c) }'))
}

async function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(" Conversion welcome simulator (one email, portal + video)")
  console.log("══════════════════════════════════════════════════════════")
  layer1_waitRule()
  layer2_sweeper()
  layer3_oneEmail()
  layer4_situation()
  await layer5_directives()
  layer6_wiring()
  layer7_loopCloses()
  layer8_fourthConverter()
  layer9_formsAndOpenHouse()
  await layer10_exceptionAndFormat()
  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" ❌ CONVERSION_WELCOME_FAIL")
    process.exit(1)
  }
  // The NAMED verdict token, matching the convention its siblings follow
  // (WELCOME_VIDEO_ASSEMBLY / ANNIVERSARY_VIDEO_DELIVERY / …). It is a GREP
  // HANDLE FOR HUMANS, not a contract: scripts/simulator-sweep.ts judges every
  // proof by EXIT CODE (`if (!err) return ok`) and `npm run guard` by GUARD_EXIT
  // (CLAUDE.md §7) — nothing in the tree parses a _PASS line except
  // doc-kernel-simulator, which asserts two specific ones by name and not this.
  // So this line makes the failure and success verdicts findable in a 700-script
  // sweep log; it does not make the proof any more or less enforced.
  console.log(" ✅ CONVERSION_WELCOME_PASS — ONE welcome email: the portal grant is immediate,")
  console.log("    the welcome WAITS for the agent's personal video and is auto-sent with it")
  console.log("    (wave 145, ruling 17); a video that cannot ride it is a human-approved")
  console.log("    exception — never falsely sent, never silently pending, never a second welcome.")
}
main().catch((e) => { console.error(e); process.exit(1) })
