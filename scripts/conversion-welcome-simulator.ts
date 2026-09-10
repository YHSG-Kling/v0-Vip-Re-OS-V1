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
  console.log("\nLayer 1 — the email waits ONLY for a render that is actually in flight")

  check("a freshly commissioned render ARMS the wait",
    decideWelcomeTiming({ commissioned: true, reason: "commissioned" }).action === "wait_for_video")

  check("a render already commissioned on an earlier attempt ARMS the wait too\n    (a retried conversion must not race the sweeper with a second send)",
    decideWelcomeTiming({ commissioned: true, reason: "already_commissioned" }).action === "wait_for_video")

  // THE DEFAULT CASE ON THIS PLATFORM. agent_voice_profiles holds ZERO rows, so
  // the reactor's honest refusal is what every conversion hits right now.
  const noProfile = decideWelcomeTiming({ commissioned: false, reason: "agent_not_video_ready" })
  check("an agent with NO voice/avatar profile sends the welcome IMMEDIATELY —\n    the live default, and an email waiting on a video that cannot exist is worse\n    than one that goes without it",
    noProfile.action === "send_now")
  check("...and it SAYS why, so the agent can fix it",
    /voice \/ avatar|voice\/avatar/.test(noProfile.reason) && noProfile.reason.length > 40)

  check("a contact who turned video off sends immediately",
    decideWelcomeTiming({ commissioned: false, reason: "video_opt_out" }).action === "send_now")
  check("an excluded contact type sends immediately",
    decideWelcomeTiming({ commissioned: false, reason: "excluded_contact_type" }).action === "send_now")
  check("a hard refusal (compliance / provider) sends immediately",
    decideWelcomeTiming({ commissioned: false, reason: "refused" }).action === "send_now")
  check("an unavailable spine sends immediately",
    decideWelcomeTiming({ commissioned: false, reason: "unavailable" }).action === "send_now")

  // FAIL CLOSED ON THE WAIT. A reason nobody has written yet must not hold an
  // email forever — "we don't recognise this" must never render as "wait".
  check("an UNKNOWN reason falls to send_now — an unrecognised outcome may never\n    arm an unbounded wait",
    decideWelcomeTiming({ commissioned: false, reason: "a_reason_invented_next_year" }).action === "send_now")

  // POSITIVE CONTROL: the finder can still see the defect. If the rule were
  // "always wait", the assertions above would be vacuous.
  const everyReason = [
    "commissioned", "already_commissioned", "video_opt_out", "agent_not_video_ready",
    "excluded_contact_type", "unavailable", "refused",
  ] as const
  const waiters = everyReason.filter((r) => decideWelcomeTiming({ commissioned: r === "commissioned", reason: r }).action === "wait_for_video")
  check("CONTROL: EXACTLY TWO of the seven reasons arm the wait — not all, not none",
    waiters.length === 2, `armed: ${waiters.join(", ") || "none"}`)

  // A `commissioned` reason that did NOT actually commission cannot arm the wait:
  // there would be no agent_intro_videos row for the sweeper to find.
  check("CONTROL: reason 'commissioned' with commissioned=false does NOT wait —\n    the wait is armed by the LEDGER ROW existing, not by a label",
    decideWelcomeTiming({ commissioned: false, reason: "commissioned" }).action === "send_now")
}

// ─── LAYER 2 — THE SWEEPER ───────────────────────────────────────────────────

function layer2_sweeper() {
  console.log("\nLayer 2 — the sweeper releases the welcome, and NOTHING waits forever")

  const base = {
    status: "rendering" as string | null,
    ageMs: 5 * 60 * 1000,
    composite: "landed" as "not_requested" | "pending" | "landed" | "abandoned" | null,
    hasRenderedUrl: true,
    videoOptOut: false,
    hasEmail: true,
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
  check("past the deadline the welcome goes WITHOUT the video EVEN THOUGH the\n    assembly is still 'pending' — the deadline is checked BEFORE the assembly\n    gate, which is the whole reason nothing stalls",
    classifyPendingWelcome(overdue).action === "send_without_video")
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
  check("the fair-housing floor is present even before any market is named",
    buildWelcomeSituation({ contact_type: "buyer" }).complianceDirectives.length === WELCOME_FAIR_HOUSING_DIRECTIVES.length)

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
  console.log("    the email waits for the personal video only while one is really coming,")
  console.log("    and never forever.")
}
main().catch((e) => { console.error(e); process.exit(1) })
