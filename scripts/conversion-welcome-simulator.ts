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
 *   Layer 3  ONE EMAIL, NEVER TWO AND NEVER ZERO: resolveWelcomeSide decides, and
 *            the magic-link fallback is armed by exactly its complement.
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
import { resolveWelcomeSide } from "../lib/kernel/client-welcome"
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
  console.log("\nLayer 3 — exactly one welcome email per converted contact")

  // Every value the conversion lanes can produce (resolveContactType clamps to
  // the live contacts_contact_type_check vocabulary).
  const liveTypes = CHECK_VOCABULARIES.contacts?.contact_type ?? []
  check("CONTROL: the live contacts.contact_type vocabulary is readable",
    liveTypes.length > 0, `read ${liveTypes.length} values`)

  check("a buyer gets the buyer journey", resolveWelcomeSide("buyer") === "buyer")
  check("a seller gets the seller journey", resolveWelcomeSide("seller") === "seller")
  check("an INVESTOR gets a welcome (buyer journey) — the conversion lanes produce\n    this type and it used to fall through to no welcome at all",
    resolveWelcomeSide("investor") === "buyer")
  check("'both' starts on the SELLER side — a dual-sided move starts with the home\n    they already own",
    resolveWelcomeSide("both") === "seller")
  check("a VENDOR gets no agent welcome — a counterparty is not a client",
    resolveWelcomeSide("vendor") === null)
  check("a REFERRAL PARTNER gets no agent welcome",
    resolveWelcomeSide("referral_partner") === null)
  check("an empty/unknown type gets no welcome rather than a guessed journey",
    resolveWelcomeSide(null) === null && resolveWelcomeSide("") === null && resolveWelcomeSide("prospect") === null)

  // THE ONE-EMAIL INVARIANT. The magic link is armed by EXACTLY the complement of
  // resolveWelcomeSide, so no contact type can produce two emails or none.
  const conversionSource = src("lib/contact-promotion/conversion-welcome.ts")
  check("the invite core's magic link is armed by exactly `side === null` — the\n    complement of 'an agent welcome is going out', which is what makes the count\n    exactly one for every contact type",
    /sendMagicLink:\s*side === null/.test(conversionSource))
  check("CONTROL: the finder would see a hardcoded `sendMagicLink: true` here",
    !/sendMagicLink:\s*true/.test(conversionSource))

  // THE SAME RULE ON THE WARM-CAPTURE PATH. captureContact runs the survivor and
  // then (re)issues the portal invite; with the OTP mail unconditionally armed
  // that was a SECOND generic email on top of the agent-signed one — the same
  // duplicate, one lane over.
  const capture = src("lib/contact-pipeline/contact-capture.ts")
  check("the warm-capture path arms its magic link by the SAME complement, so it\n    cannot stack a generic OTP mail on top of the agent-signed welcome",
    /sendMagicLink:\s*resolveWelcomeSide\([\s\S]{0,60}?\)\s*===\s*null/.test(capture))
  check("CONTROL: capture still issues the invite ROW unconditionally — the grant\n    and the email are different things",
    /createSystemPortalInvite\(\{/.test(capture))

  // POSITIVE CONTROL for the whole layer: at least one live type on each side.
  const sided = liveTypes.filter((t) => resolveWelcomeSide(t) !== null)
  const unsided = liveTypes.filter((t) => resolveWelcomeSide(t) === null)
  check("CONTROL: the live vocabulary splits BOTH ways — some types welcome, some\n    do not (a resolver that answered uniformly would pass every case above)",
    sided.length > 0 && unsided.length > 0,
    `welcomed: ${sided.join(",")} | not: ${unsided.join(",")}`)
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
  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ ONE welcome email: the portal grant is immediate, the email waits for")
  console.log("    the personal video only while one is really coming, and never forever.")
}
main().catch((e) => { console.error(e); process.exit(1) })
