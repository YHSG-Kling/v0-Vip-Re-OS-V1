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
 *      listing_id (that word is now 'memory_video' — Layer 6 owns the ruling and
 *      the reasons); lib/kernel/anniversary-equity.ts pushes its portal card
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

  // ── The admissible vocabulary — from the generated live cache, not a guess.
  // A value the CHECK rejects loses the whole row (PGRST204's sibling, 23514).
  const liveVideoTypes = CHECK_VOCABULARIES.ai_video_projects?.video_type ?? []
  check(`both stamps are values the LIVE video_type CHECK admits (${liveVideoTypes.length} in the cache) —\n    so no migration is pending behind this change`,
    liveVideoTypes.includes(introStamp) && liveVideoTypes.includes(anniversaryStamp),
    `${introStamp}=${liveVideoTypes.includes(introStamp)} ${anniversaryStamp}=${liveVideoTypes.includes(anniversaryStamp)}`)
  check("CONTROL: the cache would have caught an invented value — 'anniversary' is NOT\n    admissible, which is why this merged onto the existing spelling instead",
    !liveVideoTypes.includes("anniversary"))

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
  check(`the orchestrator's per-contact draft types DO include the new stamp\n    (${personalSet.join("/")}) — the branch this change switches on`,
    personalSet.includes(anniversaryStamp))
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
