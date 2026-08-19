/**
 * scripts/remotion-setup-guard.ts
 *
 * test:remotion-setup — every Remotion composition is properly set up, and the
 * two places that describe it AGREE.
 *
 * WHY THIS EXISTS. A composition is described twice: remotion/Root.tsx is what
 * Remotion actually renders from, and remotion_compositions is what the OS
 * reasons about. Nothing forced them to match, and three separate systems now
 * trust the DB copy:
 *
 *   · the render cache keys frame identity on the DB's width/height/fps/duration,
 *     so a drift would let one geometry serve a cache entry made under another;
 *   · the narration pad (m313) compares the voice length against the DB's
 *     duration to decide how much video to hold, so a wrong duration either cuts
 *     the agent off or freezes a frame for no reason;
 *   · isStillComposition routes on duration_frames <= 1, so a drift there sends
 *     a video down the PNG path or a card down the MP4 path.
 *
 * All three fail SILENTLY and produce a plausible-looking artifact. This turns
 * the agreement into a fact that is checked rather than assumed.
 *
 * Reads Root.tsx as text (no Remotion import, no bundling) against a snapshot of
 * the live registry, so it runs in a plain CI process in milliseconds.
 */
import { readFileSync, readdirSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

interface Geo { width: number; height: number; fps: number; duration_frames: number }

/** Parse every <Composition …> out of Root.tsx. */
export function parseRootCompositions(src: string): Record<string, Geo> {
  const out: Record<string, Geo> = {}
  for (const block of src.split(/<Composition/).slice(1)) {
    const id = block.match(/id="([A-Za-z0-9_]+)"/)?.[1]
    if (!id) continue
    const end = block.indexOf("/>")
    const seg = block.slice(0, end >= 0 ? end : 800)
    out[id] = {
      width: Number(seg.match(/width=\{(\d+)\}/)?.[1] ?? 0),
      height: Number(seg.match(/height=\{(\d+)\}/)?.[1] ?? 0),
      fps: Number(seg.match(/fps=\{(\d+)\}/)?.[1] ?? 0),
      duration_frames: Number(seg.match(/durationInFrames=\{(\d+)\}/)?.[1] ?? 0),
    }
  }
  return out
}

/**
 * The live registry, snapshotted. Regenerate with:
 *   select json_object_agg(composition_id, json_build_object(
 *     'width',width,'height',height,'fps',fps,'duration_frames',duration_frames))
 *   from remotion_compositions;
 */
const REGISTRY: Record<string, Geo> = {
  AffordabilitySnapshotReel: { width: 1080, height: 1080, fps: 30, duration_frames: 450 },
  AgentExplainerReel: { width: 1080, height: 1080, fps: 30, duration_frames: 540 },
  AgentTalkingHeadReel: { width: 1080, height: 1080, fps: 30, duration_frames: 420 },
  BuyerConsultationSlide: { width: 1920, height: 1080, fps: 30, duration_frames: 180 },
  CMAReel: { width: 1080, height: 1080, fps: 30, duration_frames: 720 },
  CarouselSlide: { width: 1080, height: 1350, fps: 30, duration_frames: 1 },
  ComingSoonReel: { width: 1080, height: 1080, fps: 30, duration_frames: 360 },
  DoorHanger: { width: 1350, height: 3375, fps: 30, duration_frames: 1 },
  EquityReportReel: { width: 1080, height: 1080, fps: 30, duration_frames: 540 },
  ExplainerAnimReel: { width: 1080, height: 1080, fps: 30, duration_frames: 540 },
  JustListedReel: { width: 1080, height: 1920, fps: 30, duration_frames: 750 },
  JustListedReelHorizontal: { width: 1920, height: 1080, fps: 30, duration_frames: 600 },
  JustListedReelSquare: { width: 1080, height: 1080, fps: 30, duration_frames: 360 },
  JustSoldReelSquare: { width: 1080, height: 1080, fps: 30, duration_frames: 360 },
  LeadMagnetCard: { width: 1200, height: 630, fps: 30, duration_frames: 1 },
  ListingFlyer: { width: 2625, height: 3375, fps: 30, duration_frames: 1 },
  ListingPresentationSlide: { width: 1920, height: 1080, fps: 30, duration_frames: 180 },
  ListingSectionReel: { width: 1920, height: 1080, fps: 30, duration_frames: 300 },
  MarketUpdateReel: { width: 1080, height: 1080, fps: 30, duration_frames: 480 },
  NeighborhoodSpotlightReel: { width: 1080, height: 1080, fps: 30, duration_frames: 480 },
  NewsletterDigestThumb: { width: 1200, height: 630, fps: 30, duration_frames: 1 },
  NewsletterDigestVideo: { width: 1080, height: 1920, fps: 30, duration_frames: 600 },
  OpenHouseAnnounceReel: { width: 1080, height: 1080, fps: 30, duration_frames: 360 },
  PartnersMeetingReel: { width: 1920, height: 1080, fps: 30, duration_frames: 900 },
  PhotoWalkthroughReel: { width: 1080, height: 1080, fps: 30, duration_frames: 600 },
  PostcardBack4x6: { width: 1275, height: 1875, fps: 30, duration_frames: 1 },
  PostcardBack6x9: { width: 1875, height: 2775, fps: 30, duration_frames: 1 },
  PostcardFront4x6: { width: 1275, height: 1875, fps: 30, duration_frames: 1 },
  PostcardFront6x9: { width: 1875, height: 2775, fps: 30, duration_frames: 1 },
  ProductPromoReel: { width: 1080, height: 1920, fps: 30, duration_frames: 450 },
  TeammateExplainerReel: { width: 1080, height: 1080, fps: 30, duration_frames: 900 },
  TestimonialReel: { width: 1080, height: 1080, fps: 30, duration_frames: 420 },
  VideoCoverThumb: { width: 1200, height: 630, fps: 30, duration_frames: 1 },
}

const rootSrc = readFileSync("remotion/Root.tsx", "utf8")
const root = parseRootCompositions(rootSrc)

console.log("\n═══ 1. The parser itself ═══")
{
  const sample = parseRootCompositions(`
    <Composition
      id="Demo"
      component={X}
      durationInFrames={123}
      fps={24}
      width={100}
      height={200}
    />`)
  ok("parses a composition block", !!sample.Demo)
  ok("...with every field", sample.Demo.width === 100 && sample.Demo.height === 200
    && sample.Demo.fps === 24 && sample.Demo.duration_frames === 123)
  ok("ignores text with no Composition", Object.keys(parseRootCompositions("const x = 1")).length === 0)
}

console.log("\n═══ 2. Root.tsx and the registry describe the SAME set ═══")
{
  const rootIds = Object.keys(root).sort()
  const dbIds = Object.keys(REGISTRY).sort()
  const missingFromDb = rootIds.filter((k) => !REGISTRY[k])
  const missingFromRoot = dbIds.filter((k) => !root[k])

  ok(`Root.tsx registers ${rootIds.length} compositions`, rootIds.length > 0)
  ok("every composition Remotion can render is in the registry — otherwise the OS\n    cannot queue it, tier-gate it, or cost it",
    missingFromDb.length === 0, missingFromDb.join(", "))
  ok("every composition the registry offers actually EXISTS in Root — otherwise a\n    queued render fails at selectComposition with the row already claimed",
    missingFromRoot.length === 0, missingFromRoot.join(", "))
  ok("the counts match exactly", rootIds.length === dbIds.length)
}

console.log("\n═══ 3. Geometry agrees, because three systems trust the DB copy ═══")
{
  let mismatches: string[] = []
  for (const [id, r] of Object.entries(root)) {
    const d = REGISTRY[id]
    if (!d) continue
    for (const f of ["width", "height", "fps", "duration_frames"] as const) {
      if (r[f] !== d[f]) mismatches.push(`${id}.${f} Root=${r[f]} DB=${d[f]}`)
    }
  }
  ok("no geometry drift between what renders and what the OS believes",
    mismatches.length === 0, mismatches.slice(0, 6).join(" | "))

  // The still/moving split routes on duration_frames <= 1. A drift here sends a
  // video down the PNG path or a print card down the MP4 path.
  const stillsInRoot = Object.entries(root).filter(([, g]) => g.duration_frames <= 1).map(([k]) => k).sort()
  const stillsInDb = Object.entries(REGISTRY).filter(([, g]) => g.duration_frames <= 1).map(([k]) => k).sort()
  ok("the STILL set is identical on both sides (the renderStill/renderMedia fork)",
    JSON.stringify(stillsInRoot) === JSON.stringify(stillsInDb))
  ok("...and there really are stills — postcards, flyers, thumbnails",
    stillsInRoot.length >= 8)
}

console.log("\n═══ 4. Every composition is renderable as configured ═══")
{
  const bad: string[] = []
  for (const [id, g] of Object.entries(root)) {
    if (g.width <= 0 || g.height <= 0) bad.push(`${id}: no dimensions`)
    if (g.fps <= 0) bad.push(`${id}: no fps`)
    if (g.duration_frames <= 0) bad.push(`${id}: no duration`)
    // h264 requires even dimensions; an odd one fails the encode at the very
    // end of a render, after all the expensive work is already done.
    if (g.duration_frames > 1 && (g.width % 2 !== 0 || g.height % 2 !== 0)) {
      bad.push(`${id}: odd dimensions on a MOVING composition (h264 needs even)`)
    }
  }
  ok("every composition declares real dimensions, fps and duration", bad.length === 0, bad.slice(0, 5).join(" | "))
}

console.log("\n═══ 5. The rules that silently do not render ═══")
{
  // Remotion animates via useCurrentFrame; CSS transitions and Tailwind
  // animation classes are evaluated once per frame in a fresh browser and
  // produce a STATIC frame — the render succeeds and the motion is missing.
  const files: string[] = []
  const walk = (dir: string, depth = 0) => {
    if (depth > 3) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full, depth + 1)
      else if (/\.(tsx|ts)$/.test(e.name)) files.push(full)
    }
  }
  walk("remotion")

  const offenders: string[] = []
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"))
    if (/\btransition\s*:/.test(src)) offenders.push(`${f}: CSS transition`)
    if (/\banimation\s*:/.test(src)) offenders.push(`${f}: CSS animation`)
    if (/className=["'][^"']*\banimate-/.test(src)) offenders.push(`${f}: Tailwind animate- class`)
  }
  ok(`scanned ${files.length} composition files`, files.length >= 33)
  ok("no CSS transition/animation or Tailwind animate- class — these render as a\n    STATIC frame and the render still reports success",
    offenders.length === 0, offenders.slice(0, 5).join(" | "))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`REMOTION SETUP — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nIf a composition legitimately changed, update BOTH Root.tsx and")
  console.log("remotion_compositions, then refresh the REGISTRY snapshot in this file.")
  process.exit(1)
}
console.log("What Remotion renders and what the OS believes are the same 33 compositions.")
