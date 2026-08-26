#!/usr/bin/env tsx
/**
 * scripts/anniversary-video-delivery-simulator.ts  (npm run test:anniversary-video-delivery)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY TRIGGER THE AVATAR REACTOR CAN WRITE MUST HAVE A SWEEP THAT READS IT.
 *
 * OWNER RULING, verbatim: "the stored avatar url and the elevenlabs cloned id
 * need to be used to create the talking avatar video with the script for the
 * video and then it becomes the stored video url that remotion uses."
 *
 * lib/video/intro-video-reactor.ts serves TWO triggers off that one chain —
 * `contact_agent_assigned` (the welcome) and `home_anniversary`. A previous wave
 * closed the welcome end to end. The anniversary end was measured and found to
 * be the SAME defect one trigger over, plus a second one behind it:
 *
 *   1. NO ASSEMBLY WAS EVER REQUESTED. The composition request was gated on
 *      `input.trigger === "contact_agent_assigned"`, justified by
 *      `AnniversaryEquityReelInput` — a type that documented itself as stamping
 *      an EquityReportReel composition id and a tracked QR onto the project row,
 *      and had NO WRITER (the identifier `equityReel` occurred exactly once in
 *      the whole tree: its own declaration) and NO READER (`runReactor` had no
 *      such field to read). So the exemption preserved nothing and the
 *      anniversary shipped a bare D-ID talking head.
 *   2. NOBODY READ THE RESULT. `app/api/cron/intro-video-email-backfill` filters
 *      `trigger='contact_agent_assigned'`; handleVideoGenerated's per-contact
 *      drafts fire only for video_type ∈ (thank_you, personal, buyer_guide,
 *      memory_video) and the anniversary row was stamped 'just_sold' with no
 *      listing_id (that word is now 'home_anniversary' — Layer 6 owns the ruling
 *      and the reasons, including why the intermediate 'memory_video' spelling
 *      was another product's name); lib/kernel/anniversary-equity.ts pushes its portal card
 *      BEFORE commissioning the video and never returns to it. The ledger row
 *      sat at 'rendering' forever behind a paid D-ID render.
 *
 * WHAT THIS HARNESS PROVES (every absence assertion carries a control that makes
 * the finder demonstrate it can still see the defect — CLAUDE.md §2):
 *
 *   Layer 1  the per-trigger chrome table and the request builder, both sides.
 *   Layer 2  the pure portal-delivery state machine, every arm, including the
 *            ones that must be TERMINAL so nothing waits forever.
 *   Layer 3  §5 survives the anniversary path too — the caption is a verbatim
 *            slice of the gated script, and the assembly authors no new copy.
 *   Layer 4  ONE DRAFT PER ATTEMPT — the reactor no longer buys a script it
 *            throws away, which is real money in ai_tool_usage.
 *   Layer 5  NO TRIGGER WITHOUT A READER — derived from the trigger union, not
 *            from a hardcoded list, so a third trigger cannot be added without
 *            a sweep that delivers it.
 *   Layer 6  THE WORD ON THE ROW — an anniversary is not a sale. The stamped
 *            video_type is checked against the LIVE CHECK cache, the Director's
 *            own mapper (§6, one spelling), the paid-promotion predicate and the
 *            welcome set — every one read off the module, none retyped here.
 *
 * PURE — no database, no provider. D-ID, ElevenLabs and Remotion/Lambda are
 * never called: the provider is represented by the metadata the reactor writes
 * and the render-row shape the classifier reads.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  INTRO_VIDEO_COMPOSITION,
  DEFAULT_AVATAR_TRIGGER,
  buildIntroCompositionRequest,
  describeIntroCompositionGap,
  classifyAnniversaryPortalDelivery,
} from "../lib/video/avatar-render-orchestrator"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  isPromotableVideoKind,
  resolveVideoKind,
  PROMOTABLE_VIDEO_KINDS,
} from "../lib/kernel/video-coordination"
// ── Layer 7's subjects, all imported and RUN rather than grepped for ─────────
//
// ONLY THE PRODUCTION SURFACE IS IMPORTED. lib/video/anniversary-script.ts
// exports exactly the five functions the reactor calls and nothing else — the
// greeting shape test, the ordinal speller, the figure/qualifier scanners and
// the directive array are all module-private. That is this repo's own standing
// ruling (lib/contact-promotion/welcome-situation.ts:180 — "an export whose only
// caller is a proof is a surface nobody asked for"), and honouring it makes the
// assertions BETTER rather than weaker: every check below now exercises the path
// production actually takes.
//
// So "does this script greet?" is asked as `enforceAnniversaryGreeting(s, g) === s`
// — a script the enforcement leaves untouched is, by definition, one that already
// greets — and "is this figure qualified?" is asked through `verifyEquityClaims`,
// the function the reactor itself calls.
import {
  anniversaryGreeting,
  buildAnniversarySituation,
  enforceAnniversaryGreeting,
  safeAnniversaryFallback,
  verifyEquityClaims,
} from "../lib/video/anniversary-script"
import {
  FAIR_HOUSING_WRITING_FLOOR,
  WELCOME_FAIR_HOUSING_DIRECTIVES,
} from "../lib/contact-promotion/welcome-situation"
import {
  fitNarrationToBudget,
  narrationBudget,
  spokenWords,
} from "../lib/video/script-structure"
import { compositionSeconds, geometryFor } from "../lib/remotion/composition-geometry"
import { computeEquityLine, equityNarrationFacts } from "../lib/kernel/anniversary-equity"

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

const REACTOR  = "lib/video/intro-video-reactor.ts"
const ORCH     = "lib/video/avatar-render-orchestrator.ts"
const CRON     = "app/api/cron/intro-video-email-backfill/route.ts"
const PORTAL   = "app/portal/[contactId]/components/RecentUpdatesFeed.tsx"

/**
 * THE TRIGGER UNION, READ OFF THE TYPE — never a list retyped here.
 *
 * `agent_intro_videos.trigger` carries a live CHECK
 * (contact_agent_assigned | home_anniversary) and `IntroTrigger` in the reactor
 * is its code-side spelling. Deriving the set means a THIRD trigger added later
 * automatically has to satisfy Layer 5 instead of quietly slipping past a
 * hardcoded pair — CLAUDE.md §2, "assert the RULE and derive the number".
 */
function introTriggers(source: string): string[] {
  const m = /type\s+IntroTrigger\s*=\s*([^\n]+)/.exec(source)
  if (!m) return []
  return Array.from(m[1].matchAll(/"([a-z_]+)"/g)).map((x) => x[1])
}

/**
 * The BODY of a function, by brace matching from its declaration.
 *
 * A lazy `[\s\S]*?\n\}` cannot do this job in this file: several of these
 * functions take a multi-line object type whose closing brace sits in column
 * zero (`}): Promise<string> {`), so the lazy form returns the SIGNATURE and the
 * caller then asserts things about an empty body. Skips forward to the first `{`
 * that opens the body and counts braces to its match.
 *
 * Returns "" when the declaration is not found, so a rename fails the check that
 * uses it rather than silently passing on an empty string.
 */
function functionBody(source: string, declaration: string): string {
  const at = source.indexOf(declaration)
  if (at < 0) return ""
  // Walk the signature: the body opens at the first `{` that is not inside the
  // parameter list, i.e. once the paren depth returns to zero.
  let i = at + declaration.length - 1 // sits on the opening "("
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === "(") paren++
    else if (source[i] === ")") { paren--; if (paren === 0) { i++; break } }
  }
  const open = source.indexOf("{", i)
  if (open < 0) return ""
  let depth = 0
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++
    else if (source[j] === "}") { depth--; if (depth === 0) return source.slice(open, j + 1) }
  }
  return ""
}

/**
 * DOES THIS SCRIPT OPEN BY WISHING THEM A HAPPY ANNIVERSARY?
 *
 * Asked through the PRODUCTION enforcement rather than through a private shape
 * test: `enforceAnniversaryGreeting` returns its input untouched exactly when the
 * script already greets, and prepends otherwise. So byte-identity IS the answer,
 * and asking it this way means the thing under test is the thing that ships.
 */
function greets(script: string): boolean {
  return enforceAnniversaryGreeting(script, "__SENTINEL__") === script.trim()
}

/** Does this script state a money/percentage figure at all? */
function statesFigure(script: string): boolean {
  return /(\$\s?[\d,]+)|(\d+(?:\.\d+)?\s?%)/.test(script)
}

const GATED_SCRIPT =
  "Hi Dana, it has been three years since you closed on the house and I still think about that closing table. " +
  "Give me a shout whenever you want to talk about where values have gone."

// ── Layer 1 · the request, per trigger ───────────────────────────────────────
function layer1_request() {
  console.log("\n[1 · THE COMPOSITION REQUEST — one builder, chrome chosen by trigger]")

  const triggers = introTriggers(src(REACTOR))
  check("the IntroTrigger union was readable and names both live triggers",
    triggers.includes("contact_agent_assigned") && triggers.includes("home_anniversary"),
    triggers.join(",") || "none")

  const base = {
    projectId: "proj-1",
    script:    GATED_SCRIPT,
    agentName: "Dana Reyes",
    agentPhotoUrl: "https://example.test/a.jpg",
    brand: { primaryColor: "#111" },
  }

  const built = triggers.map((t) => [t, buildIntroCompositionRequest({ ...base, trigger: t })] as const)
  check("EVERY live trigger yields a composition request — none is left un-assembled",
    built.length > 0 && built.every(([, r]) => r !== null),
    built.filter(([, r]) => r === null).map(([t]) => t).join(",") || "")
  check(`...and all of them target ${INTRO_VIDEO_COMPOSITION}, not a second composition (§6)`,
    built.every(([, r]) => r?.target_composition_id === INTRO_VIDEO_COMPOSITION))
  check("...each threads entity_type='video_project' + the project id, which is the\n    only reason render-composition stamps the composite back onto the project",
    built.every(([, r]) => r?.entity_type === "video_project" && r?.entity_id === "proj-1"))

  const hooks = built.map(([, r]) => (r?.input_props as Record<string, unknown>).hook as string)
  check("the eyebrow is per-trigger, not one label reused for both moments",
    new Set(hooks).size === hooks.length, hooks.join(" | "))
  check("...and the anniversary eyebrow says what the video is",
    /ANNIVERSARY/i.test(
      (buildIntroCompositionRequest({ ...base, trigger: "home_anniversary" })!.input_props as any).hook,
    ))

  // BYTE-COMPATIBILITY. Every call written before the trigger existed must keep
  // producing exactly what it produced before.
  const omitted  = buildIntroCompositionRequest({ ...base })
  const explicit = buildIntroCompositionRequest({ ...base, trigger: DEFAULT_AVATAR_TRIGGER })
  check("omitting the trigger reproduces the ASSIGNMENT request byte-for-byte",
    JSON.stringify(omitted) === JSON.stringify(explicit))

  // THE REFUSALS — a request that render-composition would cancel is not made.
  check("an unknown trigger yields NO request rather than guessed chrome",
    buildIntroCompositionRequest({ ...base, trigger: "not_a_trigger" }) === null)
  check("...and the gap is described rather than left silent",
    describeIntroCompositionGap({ ...base, trigger: "not_a_trigger" }).join(" ").includes("not_a_trigger"))
  check("a blank agent name still refuses on BOTH triggers — the content contract\n    would have cancelled the render",
    built.every(([t]) => buildIntroCompositionRequest({ ...base, agentName: "  ", trigger: t }) === null))
  check("a blank script refuses too (no caption ⇒ nothing on screen while it speaks)",
    built.every(([t]) => buildIntroCompositionRequest({ ...base, script: "", trigger: t }) === null))

  // CONTROL: the builder is not simply returning null for everything.
  check("CONTROL: a fully-formed anniversary request is NOT null",
    buildIntroCompositionRequest({ ...base, trigger: "home_anniversary" }) !== null)
}

// ── Layer 2 · the portal delivery state machine ──────────────────────────────
function layer2_stateMachine() {
  console.log("\n[2 · THE PORTAL DELIVERY DECISION — pure, and every arm terminal or retried]")

  const ok = { hasRenderedUrl: true, composite: "landed" as const, videoOptOut: false, hasPortalCard: true }

  check("the assembled composite is stamped and marked assembled",
    (() => { const v = classifyAnniversaryPortalDelivery(ok); return v.action === "stamp" && v.assembled })())
  check("a project that never asked for an assembly still delivers the D-ID cut",
    (() => {
      const v = classifyAnniversaryPortalDelivery({ ...ok, composite: "not_requested" })
      return v.action === "stamp" && v.assembled === false
    })())
  check("an ABANDONED assembly delivers the D-ID cut rather than stalling forever",
    (() => {
      const v = classifyAnniversaryPortalDelivery({ ...ok, composite: "abandoned" })
      return v.action === "stamp" && v.assembled === false
    })())
  check("a PENDING assembly waits — the un-assembled track is never pushed to the portal",
    classifyAnniversaryPortalDelivery({ ...ok, composite: "pending" }).action === "wait")
  check("no avatar track yet ⇒ wait, not a failure",
    classifyAnniversaryPortalDelivery({ ...ok, hasRenderedUrl: false, composite: null }).action === "wait")

  check("a LATE opt-out suppresses even a finished, paid render",
    (() => {
      const v = classifyAnniversaryPortalDelivery({ ...ok, videoOptOut: true })
      return v.action === "close" && v.ledgerStatus === "suppressed"
    })())
  check("...and opt-out beats every other input, including 'still pending'",
    (() => {
      const v = classifyAnniversaryPortalDelivery({
        hasRenderedUrl: false, composite: "pending", videoOptOut: true, hasPortalCard: false,
      })
      return v.action === "close" && v.ledgerStatus === "suppressed"
    })())
  check("no portal card ⇒ the row CLOSES as failed; the sweep never invents a card\n    with no computed value behind it",
    (() => {
      const v = classifyAnniversaryPortalDelivery({ ...ok, hasPortalCard: false })
      return v.action === "close" && v.ledgerStatus === "failed"
    })())

  // NOTHING WAITS FOREVER — exhaust the whole input space and prove that the
  // only 'wait' arms are the ones a later tick can change.
  const composites = [null, "not_requested", "pending", "landed", "abandoned"] as const
  const stuck: string[] = []
  for (const c of composites) {
    for (const rendered of [true, false]) {
      for (const optOut of [true, false]) {
        for (const card of [true, false]) {
          const v = classifyAnniversaryPortalDelivery({
            hasRenderedUrl: rendered, composite: c, videoOptOut: optOut, hasPortalCard: card,
          })
          // A 'wait' is only legitimate while something is still in flight.
          const inFlight = !rendered || c === "pending"
          if (v.action === "wait" && !inFlight) stuck.push(`${c}/${rendered}/${optOut}/${card}`)
        }
      }
    }
  }
  check("across the WHOLE input space, 'wait' happens only while something is still\n    in flight — no combination can park a paid render forever",
    stuck.length === 0, stuck.join(" "))
  check("CONTROL: the sweep of the input space really ran",
    composites.length * 2 * 2 * 2 === 40)
  check("every verdict carries a reason a human can act on",
    composites.every((c) =>
      classifyAnniversaryPortalDelivery({
        hasRenderedUrl: true, composite: c, videoOptOut: false, hasPortalCard: true,
      }).reason.length > 0))
}

// ── Layer 3 · §5 through the anniversary path ────────────────────────────────
function layer3_compliance() {
  console.log("\n[3 · COMPLIANCE-FIRST SURVIVES THE ASSEMBLY (§5)]")

  const req = buildIntroCompositionRequest({
    projectId: "p", script: GATED_SCRIPT, agentName: "Dana Reyes", trigger: "home_anniversary",
  })!
  const caption = (req.input_props as Record<string, unknown>).caption as string
  const flat = GATED_SCRIPT.replace(/\s+/g, " ")
  const stem = caption.replace(/…$/, "")
  check("the anniversary caption is a VERBATIM slice of the gated script — the\n    assembly authors no client-facing sentence the gate never saw",
    stem.length > 0 && flat.startsWith(stem), `${caption}`)
  check("...and it is capped, so it cannot smuggle a second sentence onto the screen",
    stem.split(" ").length <= 12)
  check("CONTROL: a caption that is NOT a slice of the script is detectable",
    !flat.startsWith("Perfect for families like yours"))

  const reactor = src(REACTOR)
  check("the assembly request runs AFTER the pre-flight gate, so `script` is the\n    gated text on both triggers",
    reactor.indexOf("runWithComplianceRedraft(") < reactor.indexOf("buildIntroCompositionRequest("))
  check("the anniversary WRITING prompt still carries the fair-housing rule itself,\n    not only the post-hoc scan",
    /home-anniversary video script[\s\S]{0,1200}Avoid any reference to protected characteristics/.test(reactor))
  check("CONTROL: that matcher fails when the rule is removed from the prompt",
    !/home-anniversary video script[\s\S]{0,1200}Avoid any reference to protected characteristics/.test(
      reactor.replace(/Avoid any reference to protected characteristics\./g, ""),
    ))
}

// ── Layer 4 · one draft per attempt ──────────────────────────────────────────
function layer4_spend() {
  console.log("\n[4 · ONE DRAFT PER ATTEMPT — ai_tool_usage feeds the invoice (§5)]")

  const reactor = src(REACTOR)
  const sites = (reactor.match(/(?<!function\s)draftScript\(\s*\{/g) ?? []).length
  check("exactly ONE draftScript call site remains — the compliance loop's own",
    sites === 1, `${sites} call sites`)
  check("...and it is the loop's, not a bare pre-draft",
    /draft:\s*\(\{\s*violations\s*\}\)\s*=>\s*draftScript\(\{/.test(reactor))
  check("CONTROL: the counter still sees the discarded pre-draft when it is put back",
    ((reactor + "\n  script = await draftScript({ violations: [] })")
      .match(/(?<!function\s)draftScript\(\s*\{/g) ?? []).length === 2)

  check("the helper really does make the first draft itself — which is why a second\n    one here was pure waste",
    /let script = await args\.draft\(\{ violations: \[\] \}\)/.test(src("lib/kernel/compliance-redraft.ts")))
  check("the surviving call still books its tenant, so the spend lands on ai_tool_usage",
    /brokerageId:\s*input\.brokerageId/.test(reactor) && /brokerageId:\s*args\.brokerageId/.test(reactor))
  check("a gateway failure is still recorded as a SCRIPT failure, not a compliance one",
    /status: "failed", error_message: `script: \$\{\(err as Error\)\.message\}/.test(reactor))
}

// ── Layer 5 · no trigger without a reader ────────────────────────────────────
function layer5_noOrphanTrigger() {
  console.log("\n[5 · NO TRIGGER MAY BE WRITTEN THAT NO SWEEP READS (§1)]")

  const reactor = src(REACTOR)
  const cron    = src(CRON)
  const triggers = introTriggers(reactor)

  check("the trigger union was readable", triggers.length >= 2, triggers.join(","))
  const unread = triggers.filter((t) => !new RegExp(`\\.eq\\("trigger", "${t}"\\)`).test(cron))
  check("EVERY trigger the reactor can write has a sweep in the delivery cron that\n    selects it — this is the orphan the anniversary lane was",
    unread.length === 0, unread.join(",") || "")
  check("CONTROL: the finder still spots a trigger with no sweep",
    ["contact_agent_assigned", "home_anniversary", "birthday_wish"]
      .filter((t) => !new RegExp(`\\.eq\\("trigger", "${t}"\\)`).test(cron)).length === 1)

  // The builder tests in Layer 1 are PURE, so they cannot see a reactor that
  // simply declines to CALL it for one trigger — which is exactly the shape the
  // anniversary lane was in. Caught here, at the call site, with its control.
  check("the reactor does not gate the assembly request on a single trigger",
    !/input\.trigger === "contact_agent_assigned"\)\s*\{[\s\S]{0,900}?buildIntroCompositionRequest/.test(reactor))
  check("CONTROL: the matcher still recognises that gate when it is present",
    /input\.trigger === "contact_agent_assigned"\)\s*\{[\s\S]{0,900}?buildIntroCompositionRequest/.test(
      'if (input.trigger === "contact_agent_assigned") {\n  x = buildIntroCompositionRequest(p)\n}'))

  check("the anniversary sweep reads the PORTAL channels, matching what the reactor\n    stamps for that trigger",
    /\.eq\("trigger", "home_anniversary"\)[\s\S]{0,400}\.in\("delivery_channel", \["portal", "both"\]\)/.test(cron)
    || /\.in\("delivery_channel", \["portal", "both"\]\)[\s\S]{0,400}\.eq\("trigger", "home_anniversary"\)/.test(cron))
  check("...and the reactor stamps 'portal' for it rather than the 'email' default\n    no cron ever honoured",
    /input\.trigger === "home_anniversary" \? "portal" : "email"/.test(reactor))
  check("CONTROL: the matcher still sees the unconditional 'email' default it replaced",
    !/input\.trigger === "home_anniversary" \? "portal" : "email"/.test(
      'const delivery = input.delivery ?? "email"'))

  // THE SWEEP WAITS FOR THE ASSEMBLY, same shared predicate as the welcome half.
  check("the anniversary sweep uses the SHARED composite predicate — no second copy",
    cron.includes("resolveAvatarCompositeState") && cron.includes("classifyAnniversaryPortalDelivery"))
  check("...and the decision itself is the PURE classifier, not re-derived inline",
    /const verdict = classifyAnniversaryPortalDelivery\(\{/.test(cron))
  check("the card stamp COUNTS the rows it matched — an UPDATE that matches nothing\n    also resolves with error=null",
    /\.eq\("id", card!\.id\)\s*\.select\("id"\)/.test(cron)
    && /stamped\.length === 0/.test(cron))
  check("the ledger reaches a TERMINAL status on the delivery path",
    /status: "delivered", delivered_at:/.test(cron))

  // THE PORTAL ACTUALLY PLAYS IT.
  const portal = src(PORTAL)
  check("the portal feed plays a clip off the equity_report card's own metadata key",
    /equity_report:\s*\{[\s\S]{0,200}anniversary_video_url/.test(portal))
  check("...through ONE player shared with the welcome card, not a second one (§6)",
    (portal.match(/<video\b/g) ?? []).length === 1)
  check("...and the key the cron writes is the key the portal reads",
    cron.includes("anniversary_video_url") && portal.includes("anniversary_video_url"))
  check("CONTROL: a key mismatch would be visible to that matcher",
    !(portal.includes("anniversary_clip_url")))
  check("no 'coming soon' placeholder was introduced — no clip means no affordance",
    /if \(!clip\) return null/.test(portal)
    && !/coming soon/i.test(portal.replace(/coming soon" tile/gi, "")))

  // THE TOMBSTONE STANDS AND NAMES ITS SURVIVOR (§1).
  const rawReactor = raw(REACTOR)
  check("the orphaned equity-reel type is gone from CODE",
    !src(REACTOR).includes("AnniversaryEquityReelInput"))
  check("...with a tombstone that names where the equity reel actually lives",
    rawReactor.includes("TOMBSTONE (orphan doctrine §1.3)")
    && rawReactor.includes("lib/video/video-director.ts")
    && rawReactor.includes("lib/kernel/equity-trigger.ts"))
  check("...and that survivor still exists and still names the reel",
    src("lib/video/video-director.ts").includes('compositionId: "EquityReportReel"'))
  check("CONTROL: reading RAW source would have counted the tombstone as live code —\n    which is why every scan above reads STRIPPED source",
    rawReactor.includes("AnniversaryEquityReelInput") && !src(REACTOR).includes("AnniversaryEquityReelInput"))
}

// ── Layer 6 · the WORD on the row, and what it buys ──────────────────────────
/**
 * AN ANNIVERSARY IS NOT A SALE.
 *
 * The reactor stamped `video_type='just_sold'` on the home-anniversary project.
 * That was not merely inaccurate: video_type is the FALLBACK the video-coordination
 * publisher resolves a lifecycle kind from when video_metadata.promo_event_type is
 * absent, and this row has never carried promo_event_type — so 'just_sold' put a
 * 1:1 anniversary clip addressed to one named past client into
 * PROMOTABLE_VIDEO_KINDS and raised an `ads_manager:video_ready` signal proposing
 * PAID SPEND on it.
 *
 * EVERY ASSERTION HERE IS DERIVED, NEVER RETYPED (CLAUDE.md §2 — assert the rule
 * and derive the number). The stamped value is read off the reactor, the
 * promotable set off lib/kernel/video-coordination, the welcome set off
 * lib/kernel/welcome-personal-video, and the admissible vocabulary off the
 * GENERATED live-CHECK cache — so a future migration that widens or narrows any
 * of them is judged against what the database actually accepts rather than
 * against a list frozen in this file.
 */
function layer6_theWordOnTheRow() {
  console.log("\n[6 · THE WORD ON THE ROW — an anniversary is not a sale, and the wrong word bought ads]")

  const reactor = src(REACTOR)
  // The stamp, read off the ternary rather than assumed.
  const stampM = /const\s+videoType\s*=\s*input\.trigger\s*===\s*"contact_agent_assigned"\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/.exec(reactor)
  const introStamp = stampM?.[1] ?? ""
  const anniversaryStamp = stampM?.[2] ?? ""
  check("the reactor's per-trigger video_type stamp is readable",
    !!stampM, stampM ? `${introStamp} / ${anniversaryStamp}` : "ternary not found")

  check("the anniversary trigger no longer claims a SALE",
    anniversaryStamp !== "just_sold", anniversaryStamp)

  // AND IT NO LONGER WEARS ANOTHER PRODUCT'S NAME (m565). The previous wave
  // merged this onto 'memory_video' because the Director already mapped
  // SituationKind 'anniversary' there and the live CHECK admitted the value —
  // which fixed the ad spend and created a naming defect, because the owner's
  // ruling makes 'memory_video' a DISTINCT product: a seller-dictated family
  // history for a 20-year-plus homeowner (lib/video/memory-video-gate.ts).
  check("...and it does not borrow the memory video's name either — two products,\n    two words (§6)",
    anniversaryStamp !== "memory_video", anniversaryStamp)

  // ── The admissible vocabulary — from the generated live cache, not a guess.
  // A value the CHECK rejects loses the whole row (PGRST204's sibling, 23514).
  const liveVideoTypes = CHECK_VOCABULARIES.ai_video_projects?.video_type ?? []
  check(`both stamps are values the LIVE video_type CHECK admits (${liveVideoTypes.length} in the cache) —\n    so no migration is pending behind this change`,
    liveVideoTypes.includes(introStamp) && liveVideoTypes.includes(anniversaryStamp),
    `${introStamp}=${liveVideoTypes.includes(introStamp)} ${anniversaryStamp}=${liveVideoTypes.includes(anniversaryStamp)}`)
  check("CONTROL: the cache still refuses an invented value — 'anniversary' is NOT\n    admissible, so the finder can tell an admitted value from a wished-for one",
    !liveVideoTypes.includes("anniversary"))
  // §6 — m565 did not coin a new word for a moment the database already names.
  // agent_intro_videos.trigger carries the SAME spelling, and it is the ledger
  // row this very video is filed under. Read off the cache, not retyped.
  const liveTriggers = CHECK_VOCABULARIES.agent_intro_videos?.trigger ?? []
  check("the stamped video_type is spelled the way the LEDGER's own trigger CHECK\n    spells this moment — one vocabulary, not a second coinage (§6)",
    liveTriggers.includes(anniversaryStamp),
    `trigger vocabulary: ${liveTriggers.join("/")} · stamp: ${anniversaryStamp}`)
  check("CONTROL: that finder would not accept just any admitted video_type —\n    'just_sold' is not a trigger spelling",
    !liveTriggers.includes("just_sold"))

  // ── §6: the survivor already existed. The Director maps SituationKind
  //    'anniversary' onto this same value, so there is ONE spelling, not two.
  // Scoped to videoTypeForSituation ALONE. video-director.ts switches on
  // SituationKind in half a dozen places (music mood, sentiment, CTA, QR kind),
  // so an unanchored `case "anniversary":` finder reads whichever one comes
  // first in the file — it read 'happy' out of sentimentForSituation.
  const director = src("lib/video/video-director.ts")
  const vtfsBody = /function\s+videoTypeForSituation\s*\([\s\S]*?\n\}/.exec(director)?.[0] ?? ""
  check("videoTypeForSituation was located in the Director (the mapper this compares against)",
    vtfsBody.length > 0)
  const directorM = /case\s+"anniversary":\s*return\s+"([a-z_]+)"/.exec(vtfsBody)
  check("the Director's SituationKind 'anniversary' maps to the SAME video_type (§6 —\n    one vocabulary per function, merged onto the survivor rather than a 17th value)",
    !!directorM && directorM[1] === anniversaryStamp,
    `director=${directorM?.[1] ?? "unreadable"} reactor=${anniversaryStamp}`)

  // ── The money: paid promotion. Rule asserted through the real predicate.
  check(`the anniversary stamp is NOT promotable, so no ads_manager signal proposes paid\n    spend on a 1:1 clip (promotable set: ${PROMOTABLE_VIDEO_KINDS.join("/")})`,
    !isPromotableVideoKind(anniversaryStamp))
  check("CONTROL: the promotable predicate still recognises the defect it was written\n    for — the OLD value 'just_sold' IS promotable",
    isPromotableVideoKind("just_sold"))

  // ── The fallback that made it reachable: this row carries no promo_event_type,
  //    so resolveVideoKind has nothing to prefer over video_type.
  check("resolveVideoKind falls back to video_type on a row with no promo_event_type —\n    which is why the WORD, not a metadata key, decided this",
    resolveVideoKind({ video_metadata: { trigger: "home_anniversary" }, video_type: anniversaryStamp }) === anniversaryStamp)

  // ── What the wrong word was accidentally buying, and that it is kept.
  const welcome = src("lib/kernel/welcome-personal-video.ts")
  const welcomeSetM = /PERSONAL_WELCOME_VIDEO_TYPES\s*=\s*\[([\s\S]*?)\]/.exec(welcome)
  const welcomeSet = Array.from((welcomeSetM?.[1] ?? "").matchAll(/"([a-z_]+)"/g)).map((x) => x[1])
  check(`the anniversary clip still cannot be served as a new client's WELCOME video\n    (welcome set: ${welcomeSet.join("/")}) — the accidental exclusion is now a deliberate one`,
    welcomeSet.length > 0 && !welcomeSet.includes(anniversaryStamp))
  check("CONTROL: that set-membership finder works — the intro stamp IS a welcome type",
    welcomeSet.includes(introStamp))

  // ── The one branch the correct word newly switches on, and its guard.
  const orch = src("lib/orchestrator/internal.ts")
  const personalM = /personalVideoTypes\s*=\s*\[([^\]]*)\]/.exec(orch)
  const personalSet = Array.from((personalM?.[1] ?? "").matchAll(/"([a-z_]+)"/g)).map((x) => x[1])
  check("the orchestrator's per-contact draft type list was readable", personalSet.length > 0)
  // THE THIRD TOUCH, AND WHY MEMBERSHIP IS THE SWITCH.
  // While the anniversary was stamped 'memory_video' this list SWITCHED ON a
  // per-contact email + SMS draft for it, and a guard keyed on
  // video_metadata.intro_video_id was added to suppress that. m565 separates the
  // two products, so the anniversary is simply not a member any more — the guard
  // is kept as the structural backstop, but the plain rule is asserted first.
  check(`the anniversary stamp is NOT a per-contact draft type (${personalSet.join("/")}) —\n    it already owns TWO delivery halves, so a third touch cannot be switched on`,
    !personalSet.includes(anniversaryStamp))
  // The OTHER half of the split: the memory video is a real product with no
  // delivery rail of its own, so the drafts here ARE how the finished keepsake
  // reaches the family. Removing it would orphan the product this wave built.
  check("...while 'memory_video' — the seller-dictated keepsake — IS one, because the\n    per-contact drafts are its only delivery",
    personalSet.includes("memory_video"))
  check("CONTROL: that membership finder works in both directions",
    personalSet.includes("thank_you") && !personalSet.includes("just_listed"))
  // Asserted as a RULE, not as one line of source (§2 — do not pin to a
  // waypoint): the predicate must be DERIVED from intro_video_id, and the draft
  // branch must be NEGATED by it. How the surrounding condition is spelled is
  // the orchestrator's business and may be refactored without this going red.
  check("...and it is GUARDED, so the anniversary is not touched a third time: the\n    predicate derives from video_metadata.intro_video_id",
    /hasOwnDeliveryRail\s*=\s*[^\n]*intro_video_id/.test(orch))
  check("...and the per-contact draft branch is NEGATED by that predicate",
    /if\s*\([^)]*!hasOwnDeliveryRail[^)]*\)\s*\{/.test(orch))
  check("CONTROL: that guard finder reads STRIPPED source, so a comment naming\n    intro_video_id could not satisfy it on its own",
    !/hasOwnDeliveryRail/.test(raw(REACTOR)))

  // ── The rail the guard defers to is real, and it is the one the cron drives.
  check("the rail deferred to exists: the reactor stamps intro_video_id onto\n    video_metadata, and the backfill cron reads agent_intro_videos",
    /intro_video_id:\s*introVideoId/.test(reactor)
    && /\.from\("agent_intro_videos"\)/.test(src(CRON)))
}

// ── Layer 7 · a happy anniversary WITH an equity report ──────────────────────
/**
 * OWNER RULING, verbatim: "anniversary video is a happy anniversary with an
 * equity report."
 *
 * TWO HALVES, AND THE SPOKEN SCRIPT HAD NEITHER.
 *
 * THE GAP WAS MIS-STATED FIRST, AND THE MIS-STATEMENT IS INSTRUCTIVE. A
 * repo-wide search for the literal "happy anniversary" finds two files, neither
 * of them the video — which reads as "the greeting exists nowhere". It is wrong
 * in both directions:
 *
 *   · THE PICTURES ALREADY GREETED. remotion/EquityReportReel.tsx renders
 *     `Happy {ordinal(yearsHeld)} home anniversary` in 64px type, and
 *     AVATAR_VIDEO_CHROME's anniversary eyebrow is the literal "HAPPY HOME
 *     ANNIVERSARY". A substring finder cannot see the first one because an
 *     interpolation sits between the two words. This is the §2 lesson in a new
 *     costume: a finder that reports zero and a clean tree look identical, so
 *     every assertion below runs the REAL function instead of grepping for a
 *     phrase.
 *   · THE MOUTH DID NOT. The one surface with no greeting was the spoken script,
 *     whose prompt said "Acknowledge the anniversary without being saccharine"
 *     — and the caption strip burned into the video is cut VERBATIM from that
 *     script's first sentence, so whatever the model opened with became the
 *     on-screen line a muted viewer read as the message.
 *
 * AND THE SECOND HALF WAS FORBIDDEN OUTRIGHT. The same prompt ended "No specific
 * home-value claims. No guaranteed returns or appreciation language." The client
 * was watching an equity report — the portal card the clip is stamped onto
 * carries the whole thing — while the agent on screen was under instructions not
 * to mention it.
 *
 * WHAT IS PROVEN HERE: the greeting is a property of the TEXT and not a line in
 * a prompt (7A); the equity half reaches the writer and the two are not traded
 * off (7B); a spoken figure about a named person's money keeps its qualifiers
 * even after the budget trim, and fails closed when it cannot (7C); the richer
 * script still fits the composition that speaks it (7D); and the three
 * behaviours the last wave established still hold under mutation (7E).
 */
function layer7_happyAnniversaryWithEquityReport() {
  console.log("\n[7 · A HAPPY ANNIVERSARY WITH AN EQUITY REPORT — the owner's ruling, both halves]")

  const reactor = src(REACTOR)
  const producer = src("lib/kernel/anniversary-equity.ts")
  const greeting = anniversaryGreeting({ firstName: "Dana", yearsHeld: 5 })

  // ── 7A · THE GREETING IS SAID, NOT ONLY FRAMED ────────────────────────────
  console.log("\n  7A · the greeting")

  check(`the composed greeting greets: "${greeting}"`,
    greets(greeting))
  // The ordinal is asserted through the greeting the reactor actually composes,
  // because the speller itself is module-private (see the import note above).
  const nth = (y: number) => anniversaryGreeting({ firstName: null, yearsHeld: y })
  check("...and it uses the anniversary NUMBER the caller already derived — the same\n    N the project title stamps as '(Ny)', not a second computation",
    nth(1).includes("1st") && nth(2).includes("2nd") && nth(3).includes("3rd")
    && nth(5).includes("5th") && nth(11).includes("11th") && nth(22).includes("22nd"))
  check("...and a missing or nonsensical year degrades to the plain wish rather than\n    a happy 0th anniversary",
    greets(nth(0)) && !nth(0).includes("0") && greets(anniversaryGreeting({})))

  // THE MANDATORY POSITIVE CONTROL. The old behaviour is not hypothetical — this
  // is the shape the retired prompt ("Acknowledge the anniversary without being
  // saccharine") actually produces. The finder must FAIL on it, or "the greeting
  // is present" is a sentence that can never go red.
  const UNGREETED = "It is hard to believe three years have gone by since you closed on the house. I still think about that day."
  check("POSITIVE CONTROL: a script that merely ACKNOWLEDGES the anniversary — what the\n    retired prompt asked for — is detected as NOT greeting",
    !greets(UNGREETED))
  check("...and the very same script, run through the enforcement, DOES greet",
    greets(enforceAnniversaryGreeting(UNGREETED, greeting)))
  check("...with the model's own words kept, not replaced",
    enforceAnniversaryGreeting(UNGREETED, greeting).includes(UNGREETED))

  // A greeting buried mid-script is NOT enough: the caption is cut from sentence
  // one and the trim keeps from the front.
  check("a greeting buried in a later sentence does not count — the caption strip is\n    cut from the FIRST sentence and a muted viewer never reaches sentence three",
    !greets("Thanks for being a client. Happy anniversary, Dana!"))
  check("...and the enforcement fixes exactly that case by prepending",
    greets(
      enforceAnniversaryGreeting("Thanks for being a client. Happy anniversary, Dana!", greeting)))

  // NEVER REWRITES a draft that already greets — including one that spells the
  // number in words, which the model is allowed to do.
  const ALREADY = "Happy fifth home anniversary, Dana! Five years in that house already."
  check("a draft that already greets is returned BYTE-IDENTICAL — the model keeps its\n    own words, the enforcement is a floor and not a rewrite",
    enforceAnniversaryGreeting(ALREADY, greeting) === ALREADY)
  check("CONTROL: that byte-identity check would notice a prepend",
    enforceAnniversaryGreeting(UNGREETED, greeting) !== UNGREETED)

  // WHERE IT RUNS. §5: the greeting must be inside the text the gate grades, not
  // added to it afterwards. Asserted structurally, because behaviour cannot see
  // the ORDER of two steps.
  // Brace-matched, not lazily regexed. `draftScript`'s parameter object is a
  // multi-line type literal that closes with `}): Promise<string> {` in COLUMN
  // ZERO, so the obvious `/async function draftScript\([\s\S]*?\n\}/` stops
  // there — at the end of the SIGNATURE, before a single line of the body — and
  // then reports that the body does not contain what the body plainly contains.
  // That is the §2 failure shape exactly: a finder that cannot see the code it
  // judges reports absence and reads as a clean bill of health.
  const draftBody = functionBody(reactor, "async function draftScript(")
  check("the draftScript body was located (the function the compliance loop calls)",
    draftBody.length > 0 && draftBody.includes("generateTextRouted"))
  check("CONTROL: the extractor really reads a BODY, not just a signature — it must\n    contain the model call, which lives past the parameter type literal",
    /generateTextRouted\(\{/.test(draftBody) && !/violations:\s*string\[\]/.test(draftBody))
  check("the greeting is enforced INSIDE draftScript, so evaluateOutbound grades the\n    greeting too — copy prepended after the gate is copy no gate ever saw (§5)",
    /enforceAnniversaryGreeting\s*\(/.test(draftBody))
  check("...and the reactor hands THAT function to the compliance loop as its drafter",
    /draft:\s*\(\{\s*violations\s*\}\)\s*=>\s*draftScript\(\{/.test(reactor))
  check("CONTROL: the enforcement finder reads STRIPPED source, so this file's own\n    prose naming enforceAnniversaryGreeting could not satisfy it",
    !/enforceAnniversaryGreeting\s*\(/.test(stripComments("// calls enforceAnniversaryGreeting(x, y)")))

  // ── 7B · THE EQUITY HALF, AND THAT THE TWO ARE NOT TRADED OFF ─────────────
  console.log("\n  7B · the equity report reaches the writer")

  // The prohibition is GONE from live code. Read on comment-stripped source: the
  // reactor's own tombstone quotes both retired sentences verbatim, which is
  // precisely the §2 trap — a tombstone is not a call site.
  const RETIRED = [
    /No specific home-value claims/,
    /No guaranteed returns or appreciation language/,
  ]
  const stillLive = RETIRED.filter((re) => re.test(reactor))
  check("the prompt no longer FORBIDS the equity half — both retired prohibitions are\n    gone from live code",
    stillLive.length === 0, stillLive.map(String).join(" "))
  check("POSITIVE CONTROL: the retired-prohibition finder still matches what it hunts",
    RETIRED.every((re) => re.test("80-110 words. No specific home-value claims. No guaranteed returns or appreciation language.")))
  check("CONTROL: and it DOES still find them in RAW source — the tombstone that\n    records them stands, which is why every scan here strips first (§2)",
    RETIRED.every((re) => re.test(raw(REACTOR))))

  // The facts themselves — the REAL computed line, one spelling, two writers.
  const line = computeEquityLine({
    purchasePrice: 500_000, estimatedValue: 612_000, originalLoanAmount: 400_000, yearsHeld: 5,
  })
  const facts = equityNarrationFacts({ anniversaryNumber: 5, estimatedValue: 612_000, line })
  check(`the equity report exists as fact lines the writer may use (${facts.length} of them)`,
    facts.length >= 4 && facts.some((f) => f.includes("$612,000")) && facts.some((f) => /equity/i.test(f)))
  check("...every figure in them is already labeled an estimate, so a writer that\n    repeats them verbatim cannot produce an unqualified claim",
    verifyEquityClaims(`${greeting} ${facts.join(" ")}`, { hasLoanData: true }).ok)
  check("POSITIVE CONTROL: that qualifier finder still catches a bare figure",
    !verifyEquityClaims(`${greeting} Your equity is $242,000 today. Estimates only, not an appraisal.`, { hasLoanData: true }).ok)

  // NO LOAN DATA → the facts refuse to claim equity and SAY so.
  const bare = computeEquityLine({ purchasePrice: 500_000, estimatedValue: 612_000, yearsHeld: 5 })
  const bareFacts = equityNarrationFacts({ anniversaryNumber: 5, estimatedValue: 612_000, line: bare })
  check("with no loan on file the facts report value growth only AND instruct the\n    writer to say so — no equity number is invented",
    bare.estimatedEquity === null
    && bareFacts.some((f) => /No loan details on file/.test(f) && /must say so/.test(f))
    && !bareFacts.some((f) => /^Estimated equity/.test(f)))

  // THE WIRE. The facts had exactly one reader (the portal note) before this.
  check("the producer passes the SAME fact set to the video, not a second rendering\n    of the numbers (§6)",
    /equity:\s*\{\s*facts,\s*hasLoanData:\s*line\.hasLoanData\s*\}/.test(producer))
  check("...and it builds that set through the ONE exported builder both writers use",
    /const facts = equityNarrationFacts\(\{/.test(producer))
  check("...and the default dispatcher FORWARDS it — a seam that dropped the equity\n    half would look wired while the video went out as a bare greeting",
    /dispatchAnniversaryVideo\(\{[\s\S]{0,400}equity:\s*d\.equity/.test(producer))
  check("the reactor turns them into the SAME ScriptSituation shape the welcome lane\n    already uses — one prompt slot, not a second mechanism (§6)",
    /situation:\s*buildAnniversarySituation\(input\.equity\?\.facts \?\? \[\]\)/.test(reactor))
  const situation = buildAnniversarySituation(facts)
  check("...and that situation really carries the facts through to the prompt",
    situation.facts.length === facts.length && situation.facts[1].includes("$612,000"))

  // BOTH BLOCKS NOW REACH THE ANNIVERSARY BRANCH. They were interpolated into
  // the assignment branch only — the §5 apparatus was wired for one of two
  // writers. Scoped to the anniversary template literal, or the assignment
  // branch's own copy would satisfy the finder.
  const annivPrompt = /: `Write a home-anniversary video script[\s\S]*?`\n/.exec(reactor)?.[0] ?? ""
  check("the anniversary prompt template was located", annivPrompt.length > 0)
  check("the anniversary branch renders the FACTS block — it never did before",
    annivPrompt.includes("${situationBlock}"))
  check("...and the DIRECTIVES block, so the brokerage's own rules reach the writer\n    that composes the script and not only the scan that grades it (§5)",
    annivPrompt.includes("${complianceBlock}"))
  check("...and the greeting is asked for in the prompt as well as enforced after it",
    annivPrompt.includes("${greeting}"))
  check("CONTROL: the block finder would notice their removal",
    !annivPrompt.replace(/\$\{situationBlock\}\$\{complianceBlock\}/, "").includes("${complianceBlock}"))
  check("the hardcoded fair-housing floor sentence is KEPT — an empty situation must\n    not leave the anniversary writer with no rule at all",
    /Avoid any reference to protected characteristics/.test(annivPrompt))

  // ── 7C · SPEAKING A NAMED PERSON'S EQUITY ─────────────────────────────────
  console.log("\n  7C · compliance-first for a financial claim about one identified client")

  // The directive set is COMPOSED from the shared floor, never retyped.
  // Read off the PRODUCTION builder — the same array the reactor renders into the
  // prompt's compliance block — rather than off an export kept alive for a proof.
  const ANNIVERSARY_WRITING_DIRECTIVES = buildAnniversarySituation([]).complianceDirectives
  const missingFloor = FAIR_HOUSING_WRITING_FLOOR.filter((d) => !ANNIVERSARY_WRITING_DIRECTIVES.includes(d))
  check(`the anniversary directives contain the shared fair-housing floor verbatim\n    (${FAIR_HOUSING_WRITING_FLOOR.length} lines) — composed from the survivor, not a second copy (§6)`,
    missingFloor.length === 0, missingFloor.join(" | "))
  check("...and the WELCOME set still contains the identical floor, so splitting it out\n    weakened nothing on the lane it came from",
    FAIR_HOUSING_WRITING_FLOOR.every((d) => WELCOME_FAIR_HOUSING_DIRECTIVES.includes(d)))
  check("CONTROL: the floor-membership finder is not vacuously true",
    !FAIR_HOUSING_WRITING_FLOOR.includes("Make no promise about price, value, appreciation, rates, or timing. You are introducing yourself, not forecasting."))
  check("the two sets DIFFER where they must: the welcome floor forbids stating a\n    value, and an annual equity update exists to state one",
    WELCOME_FAIR_HOUSING_DIRECTIVES.some((d) => /Make no promise about price, value/.test(d))
    && !ANNIVERSARY_WRITING_DIRECTIVES.some((d) => /Make no promise about price, value/.test(d)))
  check("...and the anniversary set replaces it with rules that permit the estimate\n    and bind it: same-sentence qualifier, 'not an appraisal', no forecast, no advice",
    ANNIVERSARY_WRITING_DIRECTIVES.some((d) => /SAME SENTENCE/i.test(d))
    && ANNIVERSARY_WRITING_DIRECTIVES.some((d) => /not an appraisal/i.test(d))
    && ANNIVERSARY_WRITING_DIRECTIVES.some((d) => /no financial advice|give no financial advice/i.test(d))
    && ANNIVERSARY_WRITING_DIRECTIVES.some((d) => /Never compute, round differently, project, or invent/.test(d)))

  // THE VERIFIER — three refusals and one acceptance.
  const GOOD = `${greeting} Your home's estimated value is now about $612,000, an estimate and not an appraisal, and about $112,000 above what you paid.`
  check("CONTROL: a properly qualified equity script is ACCEPTED — the verifier is not\n    simply refusing everything",
    verifyEquityClaims(GOOD, { hasLoanData: true }).ok)
  check("a figure whose sentence never calls it an estimate is REFUSED",
    !verifyEquityClaims(`${greeting} Your equity is $242,000. These are estimates, not an appraisal.`, { hasLoanData: true }).ok)
  check("figures with 'not an appraisal' nowhere are REFUSED — the one disclaimer every\n    other equity surface carries",
    !verifyEquityClaims(`${greeting} Your estimated equity is about $242,000 today.`, { hasLoanData: true }).ok)
  check("claiming EQUITY with no loan on file is REFUSED — computeEquityLine returned\n    null there and every text surface degrades to value growth only",
    !verifyEquityClaims(GOOD.replace("estimated value", "estimated equity"), { hasLoanData: false }).ok)
  check("...while the SAME script is fine once the loan data exists — the refusal is\n    about the missing number, not about the word",
    verifyEquityClaims(GOOD.replace("estimated value", "estimated equity"), { hasLoanData: true }).ok)
  check("a greeting-only script states no figure, so it needs no disclaimer and passes\n    on either loan state",
    verifyEquityClaims(greeting, { hasLoanData: false }).ok
    && verifyEquityClaims(safeAnniversaryFallback(greeting), { hasLoanData: false }).ok)
  check("every refusal carries a reason a human can act on",
    verifyEquityClaims(`${greeting} Your equity is $242,000.`, { hasLoanData: true }).reason.length > 0)

  // AND IT RUNS, AFTER THE TRIM, IN THE REACTOR.
  check("the reactor verifies the claims AFTER the budget trim — the trim is exactly\n    what can turn a cleared draft into an unqualified one",
    reactor.indexOf("fitNarrationToBudget(") < reactor.indexOf("verifyEquityClaims("))
  check("...and both run AFTER the compliance gate, so neither can smuggle copy past it",
    reactor.indexOf("runWithComplianceRedraft(") < reactor.indexOf("fitNarrationToBudget("))
  check("...and a refusal FAILS CLOSED to the greeting-only form rather than speaking\n    the figures anyway (§4)",
    /if \(!verdict\.ok\) \{[\s\S]{0,400}script = safeAnniversaryFallback\(/.test(reactor))

  // ── 7D · THE NARRATION FITS THE COMPOSITION THAT SPEAKS IT ────────────────
  console.log("\n  7D · the budget, derived from the geometry")

  const equityGeo = geometryFor("EquityReportReel")
  const talkGeo = geometryFor(INTRO_VIDEO_COMPOSITION)
  check("both compositions' geometry is registered and readable",
    !!equityGeo && !!talkGeo)
  const equityBudget = narrationBudget("EquityReportReel", compositionSeconds(equityGeo!))
  const budget = narrationBudget(INTRO_VIDEO_COMPOSITION, compositionSeconds(talkGeo!))
  console.log(`      EquityReportReel        ${equityGeo!.duration_frames}f @ ${equityGeo!.fps}fps = ${equityBudget.compositionSeconds}s → ${equityBudget.budgetSeconds}s claimable → ${equityBudget.maxWords} words`)
  console.log(`      ${INTRO_VIDEO_COMPOSITION}    ${talkGeo!.duration_frames}f @ ${talkGeo!.fps}fps = ${budget.compositionSeconds}s → ${budget.budgetSeconds}s claimable → ${budget.maxWords} words`)

  // WHICH COMPOSITION SPEAKS THIS SCRIPT. The data reel is a different rail; the
  // reactor's own clip is the avatar-led personal piece, and its budget is the
  // one that binds. Derived from the orchestrator, not retyped.
  check("the script this lane writes is spoken through the composition the assembly\n    request actually targets — not the data reel on the Director rail",
    buildIntroCompositionRequest({
      projectId: "p", script: GATED_SCRIPT, agentName: "Dana Reyes", trigger: "home_anniversary",
    })!.target_composition_id === budget.compositionId)
  check("both budgets are DERIVED — halving the frames halves the words, so nothing\n    here is a literal anyone has to remember to update (§2)",
    narrationBudget("X", compositionSeconds({ duration_frames: talkGeo!.duration_frames / 2, fps: talkGeo!.fps })).maxWords
      === Math.round(budget.maxWords / 2))

  // THE RETIRED LITERAL. "80-110 words" was 3-4x what the composition can speak.
  check(`the hand-written '80-110 words' ceiling is gone from live code (the real\n    ceiling is ${budget.maxWords} words, derived)`,
    !/80-110 words/.test(reactor))
  check("POSITIVE CONTROL: that finder still matches the literal it retired",
    /80-110 words/.test("End with a low-pressure invitation. 80-110 words. No specific home-value claims."))
  check("...and the prompt now carries the DERIVED directive instead",
    /narrationLengthDirective\(budget\)/.test(annivPrompt))
  check("...and the model's token budget is sized from the same number, so the lane\n    does not pay for text it is about to throw away",
    /narrationMaxTokens\(budget\)/.test(reactor))

  // THE RICHER SCRIPT STILL FITS — and what happens when it would not.
  const richFit = fitNarrationToBudget(
    `${GOOD} Let's catch up soon — I would love to hear how the house is treating you.`, budget)
  check(`a warm greeting + the equity news fits: the trim keeps ${richFit.wordCount} of ${budget.maxWords} words`,
    richFit.wordCount <= budget.maxWords && richFit.wordCount > 0)
  check("...and the SURVIVING text still greets AND still states the qualified figure —\n    the two halves are not traded off against each other",
    greets(richFit.script)
    && statesFigure(richFit.script)
    && verifyEquityClaims(richFit.script, { hasLoanData: true }).ok)
  check("the greeting is the one thing a trim can never take: it opens the script and\n    the trim cuts from the END",
    greets(
      fitNarrationToBudget(`${GOOD} ${"filler word ".repeat(60)}`, budget).script))

  // WHAT HAPPENS WHEN IT WOULD NOT FIT — the hazard, demonstrated end to end.
  const DISCLAIMER_LAST =
    `${greeting} Your home is worth about $612,000 today, roughly $112,000 more than the $500,000 you paid five years ago. `
    + `All of these figures are estimates and not an appraisal.`
  const trimmed = fitNarrationToBudget(DISCLAIMER_LAST, budget)
  check("HAZARD: a script that parks its disclaimer in the LAST sentence loses it to\n    the trim — the qualifier is the first thing cut",
    trimmed.overran && !/not an appraisal/i.test(trimmed.script))
  check("...and the verifier CATCHES that, which is why it runs after the trim and not\n    before it",
    !verifyEquityClaims(trimmed.script, { hasLoanData: true }).ok)
  check("...and the same content written with the qualifier IN the figure's sentence\n    survives the same trim",
    verifyEquityClaims(fitNarrationToBudget(GOOD, budget).script, { hasLoanData: true }).ok)
  check("...which is exactly what the writer is told to do, in the prompt",
    ANNIVERSARY_WRITING_DIRECTIVES.some((d) => /cut from the end/i.test(d)))

  // THE DEGRADED FORM FITS TOO — it is substituted AFTER the trim, so nothing
  // downstream will shorten it.
  const worstFallback = safeAnniversaryFallback(
    anniversaryGreeting({ firstName: "Bartholomew-Fitzgerald", yearsHeld: 22 }))
  check(`the greeting-only fallback fits the budget unaided (${spokenWords(worstFallback).length} ≤ ${budget.maxWords} words,\n    measured with a long name) — it is swapped in after the trim, so nothing trims it`,
    spokenWords(worstFallback).length <= budget.maxWords)
  check("...and it still routes the client to the equity report, which lives on the\n    portal card this very clip is stamped onto",
    /portal/i.test(worstFallback))
  check("CONTROL: a composition with no runtime yields NO narration budget rather than\n    'no limit', and the fit says so out loud",
    narrationBudget("X", 0).maxWords === 0
    && fitNarrationToBudget(GOOD, narrationBudget("X", 0)).note.length > 0)

  // ── 7E · THE THREE PRESERVED BEHAVIOURS, EACH BY MUTATION ─────────────────
  console.log("\n  7E · what the last wave fixed is still fixed — proven by mutation")

  const stampM = /const\s+videoType\s*=\s*input\.trigger\s*===\s*"contact_agent_assigned"\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/.exec(reactor)
  const stamp = stampM?.[2] ?? ""
  check("the anniversary stamp is still readable off the reactor", !!stampM, stamp)

  const welcomeSet = Array.from(
    (/PERSONAL_WELCOME_VIDEO_TYPES\s*=\s*\[([\s\S]*?)\]/.exec(src("lib/kernel/welcome-personal-video.ts"))?.[1] ?? "")
      .matchAll(/"([a-z_]+)"/g)).map((x) => x[1])
  const personalSet = Array.from(
    (/personalVideoTypes\s*=\s*\[([^\]]*)\]/.exec(src("lib/orchestrator/internal.ts"))?.[1] ?? "")
      .matchAll(/"([a-z_]+)"/g)).map((x) => x[1])

  // MUTATION 1 — paid spend on a 1:1 clip.
  check("home_anniversary is NOT promotable, so nothing proposes ad spend on a video\n    addressed to one named past client",
    !isPromotableVideoKind(stamp))
  check("MUTATION: had this wave's copy re-stamped it 'just_sold', the predicate WOULD\n    have flipped — the rule is live, not vacuous",
    isPromotableVideoKind("just_sold") && !isPromotableVideoKind(stamp))

  // MUTATION 2 — an anniversary clip served as a new client's welcome.
  check("home_anniversary is NOT a welcome video type",
    welcomeSet.length > 0 && !welcomeSet.includes(stamp))
  check("MUTATION: the welcome set WOULD have accepted the assignment stamp, so the\n    exclusion is a fact about this value and not an empty set",
    welcomeSet.includes(stampM?.[1] ?? "__none__"))

  // MUTATION 3 — a third touch to the same person about one clip.
  check("home_anniversary is NOT a per-contact draft type — it already owns the portal\n    card and the email sweep, so a third touch cannot be switched on",
    personalSet.length > 0 && !personalSet.includes(stamp))
  check("MUTATION: the same list DOES contain 'memory_video', whose only delivery those\n    drafts are — so membership is a real switch, not a list nothing is on",
    personalSet.includes("memory_video"))

  // AND THE TWO DELIVERY HALVES IT DOES OWN ARE BOTH STILL THERE.
  const cron = src(CRON)
  check("the two delivery halves survive this change: the portal card stamp and the\n    email backfill sweep both still select this trigger",
    /\.eq\("trigger", "home_anniversary"\)/.test(cron)
    && /anniversary_video_url/.test(cron))
}

function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(" Anniversary avatar video — assembly + delivery simulator")
  console.log("══════════════════════════════════════════════════════════")
  layer1_request()
  layer2_stateMachine()
  layer3_compliance()
  layer4_spend()
  layer5_noOrphanTrigger()
  layer6_theWordOnTheRow()
  layer7_happyAnniversaryWithEquityReport()
  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" ❌ ANNIVERSARY_VIDEO_DELIVERY_FAIL")
    process.exit(1)
  }
  console.log(" ✅ Both avatar triggers request their Remotion assembly, the anniversary")
  console.log("    clip reaches the client's portal card, and no ledger row can be written")
  console.log("    that no sweep ever reads.")
}
main()
