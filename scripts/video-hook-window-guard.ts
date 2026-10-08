#!/usr/bin/env tsx
/**
 * scripts/video-hook-window-guard.ts  (npm run test:video-hook-window) — pure, no DB, no network.
 *
 * WAVE 89 (lane 89F) — THE HOOK WINDOW, THE BRAND'S PLACE, AND THE DISCLOSURE
 * EVERY FINISHED VIDEO CAN READ. Owner: avatar + automated videos are the most
 * important capability; "make sure that all remotion videos and with avatar are
 * created correctly … broll/images/music/intro/outro/branding are all correctly
 * calculated in the complete videos using voiceover or an avatar"; hook first.
 * Skills: remotion-best-practices (remotion-markup sequencing / calculate-metadata,
 * remotion-captions display-captions), social-media-manager:video-script (hook
 * 0:00–0:03, captions inside the safe zone), agentic-engineering (eval-first: the
 * real render ran BEFORE and AFTER — lane89F-notes.md).
 *
 * WHAT IS ALREADY PROVEN ELSEWHERE (reused): the talking head's hook-first sting
 * (test:render-from-approval §hook-first), narration starts and the stitched
 * bookend arithmetic (test:video-timing-audit, test:video-stitching), the caption
 * band and the lower-third's place (test:cinema-finish, test:render-from-approval
 * §frame), the safe-area survivor (test:body-visual-model).
 *
 * WHAT THIS ADDS — the rules the lane's two real renders were run against:
 *   §purpose    SEATED_PURPOSES is the closed set of purposes whose viewer sat
 *               down for the film; every other purpose is a scroll format.
 *   §intro      the ONE stitch decision (render-decision.ts stitchedIntroCategory)
 *               drops the brand_intro clip in front of EVERY scroll-format
 *               composition and keeps it for every seated one — derived from the
 *               registry, denominator printed, positive control on both sides.
 *   §cover      a scroll-format composition whose narration starts AFTER its
 *               cover (the PiP explainers, the market update, the equity report,
 *               the testimonial) ends that cover inside HOOK_ON_COVER_MAX_SECONDS
 *               — and the cover's own entrance animations finish inside it (an
 *               interpolate range past the cover would fade a title in after the
 *               card had already cut away). Positive control: the pre-89F 90-frame
 *               explainer cover is recognised as a violation.
 *   §disclosure the Equal Housing / licence footer of every moving composition,
 *               and the shared EndCard, derive their place and size from the ONE
 *               cinemaDisclosureStyle (safe bottom inset, caption type step) —
 *               no typed `bottom: 24` edge footer remains (finder + control).
 *   §badges     the tracked QR badge and the Equal Housing pill sit in the ONE
 *               badge slot (cinemaBadgeSlot): inside the safe sides, above the
 *               caption band and the disclosure footer.
 *   §meter      the listing-pitch reel is gated and counted on the tier video
 *               meter like every other autonomous creation (88D's blind spot).
 *   §census     (published, not asserted) every remaining typed sub-safe corner
 *               in a moving composition, with its file:line — the blind spot.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { blankStrings, stripComments } from "./strip-comments"
import { VIDEO_COMPOSITION_FILES } from "./composition-segments"
import {
  COMPOSITION_DURATION_RULES, HOOK_ON_COVER_MAX_SECONDS, PURPOSE_DURATION_RULES, SEATED_PURPOSES,
  compositionKeepsBrandIntro, movingCompositionIds, narrationStartFrame, purposeOpensOnHook,
  type VideoPurpose,
} from "../lib/video/duration-model"
import { stitchedIntroCategory } from "../lib/remotion/render-decision"
import { geometryFor } from "../lib/remotion/composition-geometry"
import { cinemaBadgeSlot, cinemaCaptionStyle, cinemaDisclosureStyle, cinemaLowerThirdPlacement } from "../lib/video/cinema-finish"
import { safeInsets } from "../lib/video/body-visual-model"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => blankStrings(stripComments(read(rel)))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §purpose · seated vs scroll, one closed set ──")
{
  const purposes = Object.keys(PURPOSE_DURATION_RULES) as VideoPurpose[]
  const seated = purposes.filter((p) => SEATED_PURPOSES.has(p))
  const scroll = purposes.filter((p) => purposeOpensOnHook(p))
  check(`every purpose is exactly one of seated (${seated.length}: ${seated.join(", ")}) or scroll (${scroll.length}) — denominator ${purposes.length}`,
    seated.length + scroll.length === purposes.length && seated.every((p) => !purposeOpensOnHook(p)))
  check("every seated purpose is a registered purpose (a retired spelling cannot sit in the set)", [...SEATED_PURPOSES].every((p) => !!PURPOSE_DURATION_RULES[p]))
  check("the scroll set is the larger side — the reels are the product", scroll.length > seated.length)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §intro · the ONE stitch decision, by purpose, across the registry ──")
{
  const moving = movingCompositionIds().filter((id) => !!COMPOSITION_DURATION_RULES[id])
  const row = (id: string) => ({ composition_id: id, stock_intro_category: "brand_intro" })
  const dropped: string[] = [], kept: string[] = []
  for (const id of moving) {
    const spec = COMPOSITION_DURATION_RULES[id]
    const expectKeep = !spec.hookFirst && SEATED_PURPOSES.has(spec.purpose)
    const got = stitchedIntroCategory(row(id))
    ;(expectKeep ? kept : dropped).push(id)
    check(`${id} (${spec.purpose}${spec.hookFirst ? ", hook-first" : ""}): brand_intro ${expectKeep ? "KEPT" : "dropped"} in front`,
      expectKeep ? got === "brand_intro" : got === null, `got ${String(got)}`)
  }
  console.log(`  · dropped in front of ${dropped.length} scroll-format compositions; kept for ${kept.length} seated: ${kept.join(", ")}`)
  check("both sides exist (the rule is not a blanket)", dropped.length > 0 && kept.length > 0)
  check("compositionKeepsBrandIntro agrees with the decision on every row", moving.every((id) => (stitchedIntroCategory(row(id)) === "brand_intro") === compositionKeepsBrandIntro(id)))
  check("CONTROL an unregistered id keeps whatever category its row carries (pre-89F behaviour)", stitchedIntroCategory({ composition_id: "NotARegisteredReel", stock_intro_category: "brand_intro" }) === "brand_intro")
  check("CONTROL a row with no intro category yields none on either side", stitchedIntroCategory({ composition_id: kept[0], stock_intro_category: null }) === null)
  // The three consumers still ask the ONE decision (87D2's rule, unchanged).
  const coord = code("lib/remotion/render-coordinator.ts"), cache = code("lib/remotion/render-cache.ts"), ready = code("lib/video/plan-asset-readiness.ts")
  check("the coordinator, the render-cache predictor and the readiness pass all ask stitchedIntroCategory",
    /const introCategory = stitchedIntroCategory\(composition\)/.test(coord) && /const introCategory = stitchedIntroCategory\(composition\)/.test(cache) && /stitchedIntroCategory\(c\)/.test(ready))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── §cover · a scroll-format cover that delays the first word ends inside ${HOOK_ON_COVER_MAX_SECONDS}s ──`)
{
  const moving = movingCompositionIds().filter((id) => !!COMPOSITION_DURATION_RULES[id] && COMPOSITION_DURATION_RULES[id].bodyMode === "narration")
  const delayed = moving.filter((id) => purposeOpensOnHook(COMPOSITION_DURATION_RULES[id].purpose) && narrationStartFrame(id) > 0)
  const fromZero = moving.filter((id) => purposeOpensOnHook(COMPOSITION_DURATION_RULES[id].purpose) && narrationStartFrame(id) === 0)
  console.log(`  · ${delayed.length} scroll-format compositions delay the first word to their cover's end; ${fromZero.length} narrate from frame 0 (${fromZero.some((id) => COMPOSITION_DURATION_RULES[id]?.hookFirst === true) ? "incl. the hook-first talking head" : ""})`)
  check("the delayed set is non-empty (the PiP family is the case this rule exists for)", delayed.length > 0)
  for (const id of delayed) {
    const fps = geometryFor(id)?.fps ?? 30
    const onset = narrationStartFrame(id) / fps
    check(`${id}: the first spoken word lands at ${onset}s ≤ ${HOOK_ON_COVER_MAX_SECONDS}s`, onset <= HOOK_ON_COVER_MAX_SECONDS + 1e-9)
    // The cover's own entrance animations finish inside the cover. The cover
    // tile is the Sequence mounted at frame 0 for the registered intro (or the
    // IntroCard component that tile mounts).
    const src = stripComments(read(VIDEO_COMPOSITION_FILES[id]))
    const intro = COMPOSITION_DURATION_RULES[id].introFrames
    const tileStart = src.search(/<Sequence from=\{0\} durationInFrames=\{(COVER|INTRO)\}>/)
    let tile = tileStart >= 0 ? src.slice(tileStart, src.indexOf("</Sequence>", tileStart)) : ""
    const introCard = src.indexOf("const IntroCard")
    if (introCard >= 0) tile += src.slice(introCard, src.indexOf("\n}\n", introCard))
    const ranges = [...tile.matchAll(/interpolate\(frame, \[(\d+), (\d+)\]/g)].map((m) => Number(m[2]))
    check(`${id}: every cover entrance range ends inside the ${intro}-frame cover (${ranges.length} ranges, max ${ranges.length ? Math.max(...ranges) : "—"})`,
      ranges.length > 0 && ranges.every((end) => end <= intro), `ranges ${ranges.join("/")}`)
  }
  // POSITIVE CONTROL — the pre-89F explainer cover (90 frames at 30 fps) fails the number.
  check(`CONTROL the pre-89F 90-frame explainer cover (3.0s) is over ${HOOK_ON_COVER_MAX_SECONDS}s`, 90 / 30 > HOOK_ON_COVER_MAX_SECONDS)
  check("CONTROL a seated purpose is not held to the window (the partners' recap keeps its 75-frame cover)",
    !purposeOpensOnHook("partners_meeting") && COMPOSITION_DURATION_RULES.PartnersMeetingReel.introFrames > 0)
  check("CONTROL the entrance-range finder recognises a range past a 60-frame cover",
    [...`interpolate(frame, [12, 90], [0, 1])`.matchAll(/interpolate\(frame, \[(\d+), (\d+)\]/g)].some((m) => Number(m[2]) > 60))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §disclosure · the footer derives its place from the ONE rule ──")
{
  const files = [...new Set(Object.values(VIDEO_COMPOSITION_FILES))].filter((f) => !/ListingPresentationSlide|BuyerConsultationSlide|CMAReel|ListingSectionReel|PartnersMeetingReel|NewsletterDigestVideo|PhotoWalkthroughReel|MemoryVideoReel|ProductPromoReel|AgentTalkingHeadReel|JustListedReel\.tsx$/.test(f))
  // Files whose outro footer is INLINE (the shared EndCard carries it for the
  // rest — PartnersMeetingReel, NewsletterDigestVideo, PhotoWalkthroughReel,
  // TeammateExplainerReel, MemoryVideoReel; JustListedReel's mark is the badge;
  // the talking head's footer is 87D's own derivation).
  const inline = files.filter((f) => !/TeammateExplainerReel/.test(f))
  const EDGE_FOOTER = /position: "absolute", bottom: 2[0-9], left: 0, right: 0/
  const EDGE_CORNER = /(bottom|top): 2[0-9], (left|right): 2[0-9]/
  for (const f of inline) {
    const c = code(f)
    check(`${f}: the disclosure footer spreads cinemaDisclosureStyle(width, height)`, /\.\.\.(cinemaDisclosureStyle\(width, height\)|disclosure)\s*[,}]/.test(c))
    check(`${f}: no typed edge footer / 24 px corner remains`, !EDGE_FOOTER.test(c) && !EDGE_CORNER.test(c))
  }
  const endCard = code("remotion/components/EndCard.tsx")
  check("the shared EndCard's footer spreads cinemaDisclosureStyle", /\.\.\.cinemaDisclosureStyle\(width, height\)/.test(endCard) && !/bottom: 26,/.test(endCard))
  check("CONTROL the pre-89F footer shape is recognised by the finder", EDGE_FOOTER.test(`position: "absolute", bottom: 24, left: 0, right: 0`) && EDGE_CORNER.test(`bottom: 24, left: 24,`))
  // The numbers: on every frame the footer sits ON the safe bottom inset at the caption step, inside the safe sides.
  for (const [w, h] of [[1080, 1080], [1080, 1920], [1920, 1080]] as Array<[number, number]>) {
    const d = cinemaDisclosureStyle(w, h), s = safeInsets(w, h), cap = cinemaCaptionStyle(w, h)
    check(`${w}×${h}: footer bottom ${d.bottom} = safe bottom, sides ${d.left}/${d.right} = safe sides, ${d.fontSize}px = caption step (${cap.fontSize}px caption text), opacity ≥ 0.8`,
      d.bottom === s.bottom && d.left === s.left && d.right === s.right && d.fontSize > 14 && d.fontSize < cap.fontSize && d.opacity >= 0.8)
  }
  check("CONTROL the pre-89F footer (24 px, 14 px type, 55 %) sits inside the unsafe band on every frame", [[1080, 1080], [1080, 1920], [1920, 1080]].every(([w, h]) => 24 < safeInsets(w, h).bottom))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §badges · the QR badge and the Equal Housing pill sit in the ONE badge slot ──")
{
  const qr = code("remotion/components/QrOutroBadge.tsx"), eho = code("remotion/components/EqualHousingMark.tsx")
  check("QrOutroBadge places itself with cinemaBadgeSlot (no typed 28 px corner)", /cinemaBadgeSlot\(width, height\)/.test(qr) && /bottom: slot\.bottom/.test(qr) && !/bottom: 28,/.test(qr))
  check("EqualHousingMark's badge variant places itself with cinemaBadgeSlot (no typed 24 px corner)", /cinemaBadgeSlot\(width, height\)/.test(eho) && /bottom: slot\.bottom/.test(eho) && !/bottom: 24,/.test(eho))
  for (const [w, h] of [[1080, 1080], [1080, 1920], [1920, 1080]] as Array<[number, number]>) {
    const slot = cinemaBadgeSlot(w, h), s = safeInsets(w, h), cap = cinemaCaptionStyle(w, h), strap = cinemaLowerThirdPlacement(w, h)
    const twoLineBand = Math.ceil(cap.fontSize * cap.lineHeight * 2 + cap.padY * 2 + cap.tickHeight + cap.tickGap)
    check(`${w}×${h}: badge bottom ${slot.bottom} clears a two-line caption band on the safe inset (≥ ${s.bottom + twoLineBand}) and equals the strap's place; sides are the safe insets`,
      slot.bottom >= s.bottom + twoLineBand && slot.bottom === strap.bottom && slot.left === s.left && slot.right === s.right)
  }
  check("CONTROL the pre-89F 28 px corner is inside the unsafe bottom band on every frame", [[1080, 1080], [1080, 1920], [1920, 1080]].every(([w, h]) => 28 < safeInsets(w, h).bottom))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §meter · the listing-pitch reel is on the tier video meter ──")
{
  // stripComments only (the feature literal is a string; no fixture here can match it).
  const pitch = stripComments(read("lib/video/listing-pitch-reel.ts"))
  const iGate = pitch.indexOf("gateVideoCreation({ brokerageId: p.brokerageId, plannedSeconds })")
  const iQueue = pitch.indexOf("recordRenderQueued({")
  const iMeter = pitch.indexOf("meterVideoCreation({")
  check("gated BEFORE the render row is queued, counted AFTER it exists", iGate > 0 && iQueue > iGate && iMeter > iQueue)
  check("the ONE refusal returns without queueing (a tier that excludes video)", /if \(!videoMeter\.allowed\) \{[\s\S]{0,300}return false/.test(pitch))
  check("counted as its own autonomous feature with the planned seconds from the duration plan, keyed on agents.id", /feature: "listing_pitch_reel", projectId: r\.renderId \?\? null, autonomous: true/.test(pitch) && /resolveAgentIdInBrokerage\(svc, p\.agentUserId, p\.brokerageId\)/.test(pitch) && /planPitchDuration\(LISTING_PITCH_COMPOSITION, props\)/.test(pitch))
  const specimen = `const { recordRenderQueued } = await import("@/lib/remotion/registry")\n  const r = await recordRenderQueued({ brokerageId })\n  return r.ok`
  check("CONTROL the pre-89F shape (queue with no meter) is recognised", specimen.indexOf("gateVideoCreation(") < 0 && specimen.indexOf("recordRenderQueued({") > 0)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §census · typed sub-safe corners still in moving compositions (published, not asserted) ──")
{
  let count = 0
  for (const [id, f] of Object.entries(VIDEO_COMPOSITION_FILES)) {
    const geo = geometryFor(id); if (!geo) continue
    const s = safeInsets(geo.width, geo.height)
    const lines = stripComments(read(f)).split("\n")
    lines.forEach((line, i) => {
      const m = /position: "absolute", (top|bottom): (\d+), (left|right): (\d+)/.exec(line)
      if (!m) return
      const v = Number(m[2]), hz = Number(m[4])
      const vInset = m[1] === "top" ? s.top : s.bottom, hInset = m[3] === "left" ? s.left : s.right
      if ((v > 0 && v < vInset) || (hz > 0 && hz < hInset)) { count++; console.log(`  · ${f}:${i + 1} ${m[0]} (safe ${m[1]} ${vInset} / ${m[3]} ${hInset})`) }
    })
  }
  console.log(`  ${count} typed corners inside a platform UI band remain — the blind spot this lane publishes (each needs its own render to move)`)
}

console.log(`\nvideo-hook-window: ${passed} passed, ${failed} failed (denominator ${passed + failed})`)
if (failed > 0) { console.log(failures.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1) }
