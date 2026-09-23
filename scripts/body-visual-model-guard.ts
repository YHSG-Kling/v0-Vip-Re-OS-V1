#!/usr/bin/env tsx
/**
 * scripts/body-visual-model-guard.ts   (npm run test:body-visual-model)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BODY-VISUAL MODEL, PROVEN. Owner (wave 79, lane 79C, verbatim): "nowhere
 * do we discuss what to use in the body if not a full avatar, in regards to
 * what is being displayed on the video screen for the person to see and
 * watch" — and "the zestimate screenshot will be used in some marketing
 * campaigns so there can be many uses for the screenshots."
 *
 * THE RULE (lib/video/body-visual-model.ts): purpose → arc + allowed +
 * preferred treatments + presenter bounds; composition → what it can render;
 * the narration is cut into segments, the duration-model body is tiled by the
 * segments' words, each segment takes the first treatment the purpose allows
 * ∩ the composition renders ∩ the host permits ∩ the assets exist; the
 * presenter share is pulled inside the bounds; a voiceover host never gets an
 * avatar; a composition with no rule fails loudly.
 *
 * WHAT THIS PROVES
 *   §registry     every purpose in PURPOSE_DURATION_RULES has a body-visual
 *                 rule (control: a synthetic purpose is missing); every rule's
 *                 preferences are inside its allowed set and every arc is
 *                 non-empty; every COMPOSITION_DURATION_RULES row has a
 *                 COMPOSITION_TREATMENTS row (control: a synthetic id is
 *                 missing) whose every treatment leaves its render MARK in the
 *                 STRIPPED composition source (control: a fixture without the
 *                 mark is refused)
 *   §host         voiceover / silent compositions never resolve to an avatar
 *                 treatment and never leave a beat without one — with assets
 *                 and with NONE; avatar hosts land inside the purpose bounds
 *                 with an avatar clip, and plan with no presenter without one
 *   §tiling       segments tile the body EXACTLY at the planned duration and
 *                 after a re-fit to another; weightedShotSlots(all-1) ≡
 *                 evenShotSlots; weights move frames in proportion
 *   §loud         an unregistered composition throws / refuses (never a
 *                 silent default plan)
 *   §segments     the script cutter puts the first sentence on the hook, the
 *                 last on the CTA, the proof before it; a one-liner is a hook
 *   §pip          pipCornerStyle lands inside the safe area on 9:16, 1:1 and
 *                 16:9 (control: the old typed 32 px corner on 9:16 does not)
 *   §wiring       the director stages bodyVisualPlan on both commission paths
 *                 and BLOCKS on a refusal; the product spec stages it; the two
 *                 consumer compositions re-fit and read it; AvatarPIP derives
 *                 its corner (no typed corner literal remains)
 *   §screenshots  the multi-use tags round-trip; a legacy row counts for every
 *                 use; a capture row carries the use tags; a public-page pick
 *                 is excluded by default, included on request, never a
 *                 customer-facing value; setScreenshotUses refuses a 0-row
 *                 match (CLAUDE.md §3 counted update)
 *
 * No network. Every DB touch is an injected fake client.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import {
  BODY_TREATMENTS, AVATAR_TREATMENTS, SEGMENT_KINDS, PURPOSE_BODY_VISUAL_RULES, COMPOSITION_TREATMENTS, TREATMENT_MARKS,
  planBodyVisual, stageBodyVisualPlan, fitBodyVisualPlan, segmentScript, segmentAtFrame, assetsFromProps,
  safeInsets, pipCornerStyle, insideSafeArea,
  type BodyTreatment, type BodyVisualAssets, type BodyVisualPlan,
} from "../lib/video/body-visual-model"
import {
  PURPOSE_DURATION_RULES, COMPOSITION_DURATION_RULES, planCompositionDuration, compositionBookends, type VideoPurpose,
} from "../lib/video/duration-model"
import { computeAssemblyTimeline, evenShotSlots, weightedShotSlots } from "../lib/video/assembly-timeline"
import { COMPOSITION_GEOMETRY } from "../lib/remotion/composition-geometry"
import {
  SCREENSHOT_USES, screenshotUseTag, tagsWithUses, usesOfRow, screenshotAssetRow, planScreenshotCapture,
  listScreenshotStillsForUse, setScreenshotUses, SCREENSHOT_ASSET_KIND,
} from "../lib/assets/screenshot-capture"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const readStripped = (rel: string): string => stripComments(readFileSync(join(root, rel), "utf8"))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const SCRIPT = "Hi Dana, congrats on the new place. The market on your block moved this week. Two homes sold above ask in nine days. Buyers are still out there and rates ticked down. Showings doubled since the price change. Text me back when you want the next step."
const FULL_ASSETS: BodyVisualAssets = { avatarClip: true, brollClips: 3, propertyPhotos: 6, screenshots: 4, chartData: true }
const NO_ASSETS: BodyVisualAssets = { avatarClip: false, brollClips: 0, propertyPhotos: 0, screenshots: 0, chartData: false }
const NARRATION_IDS = Object.keys(COMPOSITION_DURATION_RULES)

function planFor(id: string, assets: BodyVisualAssets, script = SCRIPT): BodyVisualPlan {
  const duration = planCompositionDuration({ compositionId: id, wordCount: script.split(/\s+/).length })
  return planBodyVisual({ compositionId: id, duration, script, assets })
}
function tilesExactly(plan: BodyVisualPlan): boolean {
  let cursor = plan.body.from
  for (const s of plan.segments) { if (s.from !== cursor || s.durationInFrames < 1) return false; cursor += s.durationInFrames }
  return cursor === plan.body.from + plan.body.durationInFrames
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §registry · every purpose has a rule, every composition row maps to treatments its source can render ──")
{
  const purposes = Object.keys(PURPOSE_DURATION_RULES) as VideoPurpose[]
  const missingPurpose = purposes.filter((p) => !(p in PURPOSE_BODY_VISUAL_RULES))
  check(`every purpose in PURPOSE_DURATION_RULES (${purposes.length}) has a PURPOSE_BODY_VISUAL_RULES row`, missingPurpose.length === 0, missingPurpose.join(", "))
  check("CONTROL: the missing-rule finder catches a synthetic purpose", ([...purposes, "synthetic_purpose" as VideoPurpose]).filter((p) => !(p in PURPOSE_BODY_VISUAL_RULES)).length === 1)
  for (const [p, r] of Object.entries(PURPOSE_BODY_VISUAL_RULES)) {
    const outside = SEGMENT_KINDS.flatMap((k) => r.prefer[k].filter((t) => !r.allowed.includes(t)))
    const unknown = r.allowed.filter((t) => !(BODY_TREATMENTS as readonly string[]).includes(t))
    check(`${p}: arc ${r.arc.join("/")} non-empty of known kinds; preferences ⊆ allowed; allowed ⊆ vocabulary; bounds sane; a reason and ≥1 source`,
      r.arc.length > 0 && r.arc.every((k) => (SEGMENT_KINDS as readonly string[]).includes(k)) && outside.length === 0 && unknown.length === 0
      && r.avatarShare.min <= r.avatarShare.max && r.avatarShare.max <= 1 && r.avatarShare.fullMax <= 1 && r.why.length > 20 && r.sources.length >= 1,
      [...outside, ...unknown].join(", "))
    check(`${p}: every segment kind keeps a universal floor (kinetic_text or brand_card allowed) so no beat can be left without a screen`,
      r.allowed.includes("kinetic_text") || r.allowed.includes("brand_card"))
  }
  const missingComp = NARRATION_IDS.filter((id) => !(id in COMPOSITION_TREATMENTS))
  check(`every COMPOSITION_DURATION_RULES row (${NARRATION_IDS.length}) has a COMPOSITION_TREATMENTS row`, missingComp.length === 0, missingComp.join(", "))
  check("CONTROL: a synthetic composition id is reported missing", !("SyntheticReel" in COMPOSITION_TREATMENTS))
  const ghosts = Object.keys(COMPOSITION_TREATMENTS).filter((id) => !(id in COMPOSITION_DURATION_RULES) || !(id in COMPOSITION_GEOMETRY))
  check("every treatments row names a registered composition (no ghost rows)", ghosts.length === 0, ghosts.join(", "))
  // A composition that MOUNTS a sibling composition (ListingSectionReel →
  // <ListingPresentationSlide>) renders what the sibling renders: the mark
  // may sit in the mounted source. Only a registered sibling counts, and only
  // when it is both imported from "./<Sibling>" and mounted as JSX.
  const mountedSiblings = (src: string): string[] =>
    Object.keys(COMPOSITION_TREATMENTS).filter((other) => new RegExp(`from "\\./${other}"`).test(src) && new RegExp(`<${other}\\b`).test(src))
  for (const [id, treatments] of Object.entries(COMPOSITION_TREATMENTS)) {
    const own = readStripped(`remotion/${id}.tsx`)
    const siblings = mountedSiblings(own)
    const src = [own, ...siblings.map((s) => readStripped(`remotion/${s}.tsx`))].join("\n")
    const unproven = treatments.filter((t) => !TREATMENT_MARKS[t].test(src))
    check(`${id}: every claimed treatment [${treatments.join(", ")}] leaves its render mark in the stripped source${siblings.length ? ` (or in mounted ${siblings.join("/")})` : ""}`, unproven.length === 0, `unproven: ${unproven.join(", ")}`)
    check(`${id}: kinetic_text and brand_card are claimed (the universal floor)`, treatments.includes("kinetic_text") && treatments.includes("brand_card"))
  }
  const fixture = "export const X = () => <div style={{ opacity: 1 }}>{brand.brokerageName}</div>"
  check("CONTROL: a fixture source with no <AvatarPIP>/<BrollLayer>/<Video src={avatarVideoUrl}> is refused those treatments",
    !TREATMENT_MARKS.avatar_pip.test(fixture) && !TREATMENT_MARKS.broll.test(fixture) && !TREATMENT_MARKS.full_avatar.test(fixture) && TREATMENT_MARKS.brand_card.test(fixture))
  check("CONTROL: a tombstone naming <AvatarPIP> in a comment does not count once stripped",
    !TREATMENT_MARKS.avatar_pip.test(stripComments("// survivor: <AvatarPIP> lives in components\nconst x = 1")))
  check("CONTROL: the sibling finder needs BOTH the import and the JSX mount (a dead import is not a render)",
    mountedSiblings('import { ListingPresentationSlide } from "./ListingPresentationSlide"\nconst unused = ListingPresentationSlide').length === 0
    && mountedSiblings('import { ListingPresentationSlide } from "./ListingPresentationSlide"\n<ListingPresentationSlide kind="x" />').join() === "ListingPresentationSlide")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §host · voiceover/silent never gets an avatar and never a treatment-less beat; avatar hosts sit inside their bounds ──")
{
  for (const id of NARRATION_IDS) {
    const spec = COMPOSITION_DURATION_RULES[id]
    for (const [label, assets] of [["with assets", FULL_ASSETS], ["with NO assets", NO_ASSETS]] as const) {
      const plan = planFor(id, { ...assets, avatarClip: assets.avatarClip && spec.host === "avatar" })
      const allSet = plan.segments.every((s) => (BODY_TREATMENTS as readonly string[]).includes(s.treatment))
      const avatarUsed = plan.segments.some((s) => AVATAR_TREATMENTS.has(s.treatment))
      if (spec.host !== "avatar") {
        check(`${id} (${spec.host}, ${plan.purpose}) ${label}: every segment has a treatment and none is an avatar — [${plan.segments.map((s) => s.treatment).join(" ")}]`, allSet && !avatarUsed && plan.segments.length > 0)
      } else if (assets.avatarClip) {
        check(`${id} (avatar, ${plan.purpose}) ${label}: presenter share ${plan.avatarShare} (full ${plan.fullAvatarShare}) inside [${plan.bounds.min}, ${plan.bounds.max}] / full ≤ ${plan.bounds.fullMax}`, plan.withinBounds && allSet, plan.notes.join(" | "))
      } else {
        check(`${id} (avatar, ${plan.purpose}) ${label}: no clip coming → planned with no presenter, every beat still on a screen`, allSet && !avatarUsed && plan.segments.length > 0)
      }
    }
  }
  // The full-frame cap is enforced where a PiP exists: a welcome on the
  // talking-head reel with b-roll moves a beat off full frame.
  const welcome = planFor("AgentTalkingHeadReel", FULL_ASSETS)
  check("AgentTalkingHeadReel welcome with b-roll: the hook and the CTA are eye-to-lens (full_avatar) and at least one beat floats over footage or cuts away",
    welcome.segments.find((s) => s.kind === "hook")?.treatment === "full_avatar" && welcome.segments.find((s) => s.kind === "cta")?.treatment === "full_avatar"
    && welcome.segments.some((s) => s.kind === "beat" && s.treatment !== "full_avatar"))
  const promo = planFor("ProductPromoReel", FULL_ASSETS)
  // product_demo's arc is hook + 3 beats + proof + cta: five screenshot
  // segments over the four fixture stills, so the indices cycle 0,1,2,3,0.
  check("ProductPromoReel product_demo with stills: every hook/beat/proof is a screenshot, the CTA a brand card, and the stills cycle by index (0,1,2,3,0 over 4 stills)",
    promo.segments.filter((s) => s.kind !== "cta").every((s) => s.treatment === "screenshot") && promo.segments.find((s) => s.kind === "cta")?.treatment === "brand_card"
    && promo.segments.filter((s) => s.treatment === "screenshot").map((s) => s.assetIndex).join(",") === "0,1,2,3,0")
  const listing = planFor("JustListedReel", FULL_ASSETS)
  check("JustListedReel listing_promo: the house is the star — hook and beats are property photos, never a presenter",
    listing.segments.filter((s) => s.kind !== "cta").every((s) => s.treatment === "property_photos"))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §tiling · segments tile the body exactly, before and after a re-fit; the weighted tiler is the even tiler's superset ──")
{
  for (const id of NARRATION_IDS) {
    const plan = planFor(id, FULL_ASSETS)
    check(`${id}: ${plan.segments.length} segments tile [${plan.body.from}, ${plan.body.from + plan.body.durationInFrames}) exactly; caption window = music duck = the body`,
      tilesExactly(plan) && plan.captionWindow.from === plan.body.from && plan.musicDuck.to === plan.body.from + plan.body.durationInFrames)
    const bookends = compositionBookends(id)
    const other = plan.durationInFrames + 97
    const refit = fitBodyVisualPlan(plan, id, other)
    check(`${id}: re-fit to ${other} frames tiles exactly, keeps the treatments, and re-reads the bookends from the registry`,
      !!refit && tilesExactly(refit) && refit.durationInFrames === other && refit.intro.durationInFrames === bookends.introFrames
      && refit.segments.map((s) => s.treatment).join() === plan.segments.map((s) => s.treatment).join())
  }
  const p = planFor("AgentTalkingHeadReel", FULL_ASSETS)
  check("a plan pasted onto another composition is refused by the re-fit (null), never a wrong layout", fitBodyVisualPlan(p, "MarketUpdateReel", p.durationInFrames) === null)
  check("segmentAtFrame finds the segment under the playhead and null in the bookends",
    segmentAtFrame(p, p.body.from) === p.segments[0] && segmentAtFrame(p, 0) === null && segmentAtFrame(p, p.durationInFrames - 1) === null)
  let same = true
  for (const total of [1, 7, 60, 150, 299, 300, 2820]) for (const n of [1, 2, 3, 4, 5, 8, 12]) {
    const a = evenShotSlots(total, n), b = weightedShotSlots(total, Array.from({ length: n }, () => 1))
    if (JSON.stringify(a) !== JSON.stringify(b)) same = false
  }
  check("evenShotSlots(total, n) ≡ weightedShotSlots(total, all-1) across 49 (total, n) pairs — one tiler, two spellings collapsed", same)
  const w = weightedShotSlots(300, [1, 2, 1])
  check("weights move frames in proportion: [1,2,1] over 300 → 75/150/75, tiling exactly", w.map((s) => s.durationInFrames).join() === "75,150,75" && w[2].from + w[2].durationInFrames === 300)
  const z = weightedShotSlots(100, [0, 0, 0])
  check("all-zero weights degrade to the even split (never a 0-frame chain)", z.length === 3 && z.every((s) => s.durationInFrames >= 1) && z[2].from + z[2].durationInFrames === 100)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §loud · an unregistered composition fails loudly ──")
{
  let threw = false
  try { planBodyVisual({ compositionId: "SyntheticReel", duration: planCompositionDuration({ compositionId: "SyntheticReel" }), script: SCRIPT, assets: FULL_ASSETS }) } catch (e) { threw = /COMPOSITION_TREATMENTS/.test((e as Error).message) }
  check("planBodyVisual THROWS for a composition with no treatments row, naming the registry", threw)
  const staged = stageBodyVisualPlan({ compositionId: "SyntheticReel", props: { narrationScript: SCRIPT } })
  check("stageBodyVisualPlan returns ok:false with the reason (the director blocks on it)", !staged.ok && /SyntheticReel/.test((staged as { reason: string }).reason))
  const ok = stageBodyVisualPlan({ compositionId: "AgentTalkingHeadReel", props: { narrationScript: SCRIPT, brollClips: [{ url: "a" }] }, avatarClip: true })
  check("CONTROL: a registered composition stages a plan whose duration equals the duration-model plan for the same props",
    ok.ok && ok.plan.durationInFrames === planCompositionDuration({ compositionId: "AgentTalkingHeadReel", wordCount: SCRIPT.split(/\s+/).length }).durationInFrames)
  const inv = assetsFromProps({ brollClips: [{ url: "a" }, { url: "b" }], imageUrls: ["p1"], comps: [1], avatarVideoUrl: "https://x/y.mp4" })
  check("assetsFromProps reads the producers' own keys (brollClips, imageUrls, chart data, avatarVideoUrl)", inv.brollClips === 2 && inv.propertyPhotos === 1 && inv.chartData === true && inv.avatarClip === true && inv.screenshots === 0)
  check("assetsFromProps: ProductPromoReel's imageUrls ARE screenshot stills", assetsFromProps({ imageUrls: ["s1", "s2"] }, { compositionId: "ProductPromoReel" }).screenshots === 2)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §segments · the script cutter ──")
{
  const segs = segmentScript(SCRIPT, PURPOSE_BODY_VISUAL_RULES.seller_update.arc)
  check("seller_update arc: first sentence → hook, last → cta, the one before → proof, beats share the middle", segs.map((s) => s.kind).join("/") === "hook/beat/beat/proof/cta" && /^Hi Dana/.test(segs[0].text) && /next step\.$/.test(segs[4].text))
  check("every segment's words are counted (weights)", segs.every((s) => s.words > 0) && segs.reduce((a, s) => a + s.words, 0) === SCRIPT.split(/\s+/).length)
  check("a one-sentence script is one hook; an empty script is nothing", segmentScript("Just this.", ["hook", "beat", "cta"]).map((s) => s.kind).join() === "hook" && segmentScript("", ["hook"]).length === 0)
  check("a beat-only arc (memory chapter) carries every sentence as one beat", segmentScript(SCRIPT, ["beat"]).map((s) => s.kind).join() === "beat")
  const noScript = planBodyVisual({ compositionId: "MarketUpdateReel", duration: planCompositionDuration({ compositionId: "MarketUpdateReel" }), assets: FULL_ASSETS })
  check("no narration staged → the purpose arc tiles the body evenly and says so", noScript.segments.length === PURPOSE_BODY_VISUAL_RULES.market_update.arc.length && noScript.notes.some((n) => /no narration staged/.test(n)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §pip · the PiP corner is inside the safe area on every frame shape ──")
{
  const frames: Array<[string, number, number]> = [["9:16", 1080, 1920], ["1:1", 1080, 1080], ["16:9", 1920, 1080]]
  for (const [label, w, h] of frames) {
    for (const corner of ["top-right", "top-left", "bottom-right", "bottom-left"] as const) {
      const style = pipCornerStyle(w, h, corner, 200)
      check(`${label} ${corner}: pipCornerStyle(${JSON.stringify(style)}) sits inside safeInsets ${JSON.stringify(safeInsets(w, h))}`, insideSafeArea(w, h, { ...style, width: 200, height: 200 }))
    }
  }
  check("CONTROL: the old typed corner (top: 32, right: 32) on a 9:16 frame is OUTSIDE the safe area", !insideSafeArea(1080, 1920, { top: 32, right: 32, width: 200, height: 200 }))
  check("CONTROL: the old typed card (bottom: 130, left: 48) on a 9:16 frame is OUTSIDE the safe area", !insideSafeArea(1080, 1920, { bottom: 130, left: 48, width: 560, height: 560 }))
  const tiny = pipCornerStyle(150, 150, "bottom-right", 200)
  check("a PiP larger than the frame is clamped to the frame edge, never negative", (tiny.bottom ?? -1) === 0 && (tiny.right ?? -1) === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §wiring · the director, the product spec, the consumer compositions, AvatarPIP ──")
{
  const director = readStripped("lib/video/video-director.ts")
  check("video-director.ts stages input_props.bodyVisualPlan on BOTH commission paths", (director.match(/bodyVisualPlan:\s*visual\.plan/g) ?? []).length === 2)
  check("video-director.ts BLOCKS a commission whose body visual cannot be planned (body_visual_unplanned), on both paths", (director.match(/body_visual_unplanned/g) ?? []).length === 2 && (director.match(/if \(!visual\.ok\)/g) ?? []).length === 2)
  const product = readStripped("lib/platform/product-content.ts")
  check("composeProductVideoSpec stages the plan from its own hook/beats/CTA segments", /stageBodyVisualPlan\(\{ compositionId: "ProductPromoReel"/.test(product) && /bodyVisualPlan: visual\.plan/.test(product))
  for (const id of ["AgentTalkingHeadReel", "ProductPromoReel"]) {
    const src = readStripped(`remotion/${id}.tsx`)
    check(`${id}: re-fits the staged plan to its own duration (fitBodyVisualPlan(bodyVisualPlan, "${id}", durationInFrames))`, new RegExp(`fitBodyVisualPlan\\(bodyVisualPlan, "${id}", durationInFrames\\)`).test(src))
  }
  const ath = blankStrings(readStripped("remotion/AgentTalkingHeadReel.tsx"))
  check("AgentTalkingHeadReel: the treatment under the playhead comes from segmentAtFrame; the card and the lower-third sit on the safe insets; no typed bottom:130 / bottom={24} remains",
    /segmentAtFrame\(plan, frame\)/.test(ath) && /safeInsets\(width, height\)/.test(ath) && /bottom=\{safe\.bottom\}/.test(ath) && !/bottom:\s*130\b/.test(ath) && !/bottom=\{24\}/.test(ath))
  const pip = blankStrings(readStripped("remotion/components/AvatarPIP.tsx"))
  check("AvatarPIP: the corner is pipCornerStyle(width, height, position, size) from useVideoConfig — no typed corner literal", /pipCornerStyle\(width, height, position, size\)/.test(pip) && !/top:\s*32\b/.test(pip) && !/bottom:\s*64\b/.test(pip))
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json: test:body-visual-model is registered and runs in the guard chain after test:scrapers (ordering only)",
    pkg.scripts["test:body-visual-model"] === "tsx scripts/body-visual-model-guard.ts" && guard.indexOf("npm run test:scrapers") !== -1 && guard.indexOf("npm run test:body-visual-model") > guard.indexOf("npm run test:scrapers"))
  const registry = readStripped("lib/kernel/manager-registry.ts")
  check("manager-registry: MAINTENANCE_DOMAINS.body_visual_model names this proof", /body_visual_model:\s*\{ manager: "asset_manager", proof: "test:body-visual-model"/.test(registry))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §screenshots · one still, many uses; a public-page capture is material, never a customer-facing value ──")
{
  check("SCREENSHOT_USES is the closed set marketing_campaign / product_video / demo / training", SCREENSHOT_USES.join() === "marketing_campaign,product_video,demo,training")
  const tags = tagsWithUses(["library", "screenshot", "use:demo", "use:bogus"], ["product_video", "training"])
  check("tagsWithUses replaces the use:* tags and keeps the rest", tags.join() === "library,screenshot,use:product_video,use:training")
  check("usesOfRow reads the tags, falls back to metadata.uses, and a legacy row counts for every use",
    usesOfRow({ tags }).join() === "product_video,training" && usesOfRow({ tags: ["library"], metadata: { uses: ["demo"] } }).join() === "demo" && usesOfRow({ tags: ["library"], metadata: {} }).length === 4)
  const plan = planScreenshotCapture({ kind: "public_page", url: "https://www.zillow.com/homedetails/1-Main-St/123_zpid/" }, { siteOrigin: "https://app.example.com", now: new Date("2026-09-23T12:00:00Z") })
  check("a public-page capture plans (fixture)", plan.ok, plan.ok ? undefined : plan.reason)
  if (plan.ok) {
    const row = screenshotAssetRow(plan, "https://cdn/x.png", "2026-09-23T12:00:00Z", "puppeteer") as { tags: string[]; approval_status: string; metadata: Record<string, unknown> }
    check("the capture row carries every use tag AND stays approval_status=pending (never a tenant picker)", SCREENSHOT_USES.every((u) => row.tags.includes(screenshotUseTag(u))) && row.approval_status === "pending" && Array.isArray(row.metadata.uses))
  }
  // A fake client: the filters are recorded, the rows are what the fixture holds.
  const rows = [
    { id: "os1", asset_name: "Dashboard", asset_url: "https://cdn/os1.png", approval_status: "approved", tags: ["library", "screenshot", "os_surface", "use:product_video"], updated_at: "2026-09-23", metadata: { asset_kind: "screenshot", screenshot_kind: "os_surface" } },
    { id: "pp1", asset_name: "Zestimate", asset_url: "https://cdn/pp1.png", approval_status: "pending", tags: ["library", "screenshot", "public_page"], updated_at: "2026-09-22", metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", source_url: "https://www.zillow.com/x" } },
    { id: "legacy", asset_name: "Old", asset_url: "https://cdn/legacy.png", approval_status: "approved", tags: ["library", "screenshot", "os_surface"], updated_at: "2026-09-21", metadata: { asset_kind: "screenshot", screenshot_kind: "os_surface" } },
  ]
  const calls: Array<{ op: string; args: unknown[] }> = []
  const fakeSvc = (data: unknown[], opts: { updateMatches?: number } = {}) => {
    const q: Record<string, unknown> = {}
    let op = "select"
    const chain = (name: string) => (...args: unknown[]) => { calls.push({ op: name, args }); if (name === "update" || name === "delete" || name === "insert") op = name; return q }
    for (const m of ["select", "eq", "is", "lt", "in", "order", "update", "insert", "delete"]) q[m] = chain(m)
    q.limit = (...args: unknown[]) => { calls.push({ op: "limit", args }); return Promise.resolve({ data, error: null }) }
    ;(q as { then: unknown }).then = (res: (v: unknown) => void) => res({ data: op === "update" ? data.slice(0, opts.updateMatches ?? 0) : data, error: null })
    return { from: () => q }
  }
  ;(async () => {
    const dflt = await listScreenshotStillsForUse(fakeSvc(rows) as never, "product_video")
    check("product_video by default: the OS still and the legacy still, NOT the public page", dflt.map((p) => p.id).join() === "os1,legacy")
    const withPublic = await listScreenshotStillsForUse(fakeSvc(rows) as never, "marketing_campaign", { includePublicPage: true })
    check("marketing_campaign with includePublicPage: the Zestimate still comes back, still pending, customerFacingValue false, source recorded",
      withPublic.some((p) => p.id === "pp1" && p.approvalStatus === "pending" && p.customerFacingValue === false && p.sourceUrl === "https://www.zillow.com/x") && !withPublic.some((p) => p.id === "os1"))
    check("an unknown use yields nothing (closed vocabulary)", (await listScreenshotStillsForUse(fakeSvc(rows) as never, "billing" as never)).length === 0)
    check("the query is scoped to the screenshot asset kind", calls.some((c) => c.op === "eq" && c.args[0] === "metadata->>asset_kind" && c.args[1] === SCREENSHOT_ASSET_KIND))
    const zero = await setScreenshotUses(fakeSvc([rows[0]], { updateMatches: 0 }) as never, "os1", ["demo"])
    check("setScreenshotUses REFUSES when the counted update matched 0 rows (a delete/update that matches nothing also resolves — CLAUDE.md §3)", !zero.ok && /expected 1/.test((zero as { reason: string }).reason))
    const one = await setScreenshotUses(fakeSvc([rows[0]], { updateMatches: 1 }) as never, "os1", ["demo", "bogus" as never])
    check("setScreenshotUses writes only valid uses and reports them", one.ok && one.uses.join() === "demo")
    const none = await setScreenshotUses(fakeSvc([]) as never, "missing", ["demo"])
    check("setScreenshotUses refuses an id that is not a screenshot row", !none.ok)
    const src = readStripped("lib/assets/screenshot-capture.ts")
    check("the selection helper never reads a value off the page — no price/zestimate/value parsing in the module (positive control: the word 'customerFacingValue: false' is present)",
      !/parse(Price|Value|Zestimate)/.test(src) && /customerFacingValue: false/.test(src))

    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
  })()
}
