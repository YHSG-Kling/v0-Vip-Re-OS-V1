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
 *
 * ── TOMBSTONE: THREE COPIES OF THE REMOTION SKILL, NOW ONE (2026-08-25) ──────
 *
 * The vendored Remotion agent skill existed THREE times, and no two agreed:
 *
 *   · .claude/skills/remotion-best-practices/     SKILL.md + 36 flat rules/
 *   · .agents/skills/remotion-best-practices/     byte-identical to the above
 *   · plugins/ecc/skills/remotion-video-creation/ SKILL.md + 29 flat rules/,
 *     a RENAMED fork carrying an older upstream snapshot
 *
 * Neither rule set was a superset of the other, so whichever one an agent
 * happened to load decided what it knew — and the ecc fork's different NAME meant
 * §6 could not even see them as the same thing. `plugins/ecc/skills/manim-video/
 * SKILL.md` pointed readers at the stale fork by that name.
 *
 * SURVIVOR: .claude/skills/remotion-best-practices/, re-vendored whole from
 * upstream remotion-dev/skills@7c5c10caa5294d01b168a08c9648b4deef717274
 * (`skills/remotion-best-practices/`, plugin version 4.0.517) — the exact source
 * skills-lock.json already named, and content-identical to the published plugin
 * github.com/remotion-dev/remotion/tree/main/packages/claude-code-plugin except
 * for five .tsx specimen components that upstream's own build.mts filters out
 * while its TECHNIQUE.md files still link to them. Upstream restructured the
 * skill: the flat rules/ directory is gone, replaced by a SKILL.md router over
 * eleven embedded sub-skills (remotion-markup/, remotion-multimedia/, …), each
 * fronted by REFERENCE.md rather than a second SKILL.md.
 *
 * .agents/skills/remotion-best-practices/ is KEPT as a byte-identical mirror,
 * NOT collapsed: nothing in this repo reads .agents/ (runtime-roots.ts:93 calls
 * it "config, not runtime"), but a skill directory is loaded by CONVENTION, not
 * by an import, so §1's "unreferenced is not dead" applies and whether some other
 * harness loads it is UNRESOLVED. The defect that was real — the two copies
 * drifting apart in silence — is closed by section 6 below instead.
 *
 * plugins/ecc/skills/remotion-video-creation/ (32 files) is DELETED. Three of its
 * rules have no successor upstream at all — charts.md, can-decode.md and
 * extract-frames.md, which upstream retired in the restructure. They are not lost:
 * they remain retrievable at remotion-dev/skills before that commit. Upstream is
 * the authority on Remotion content, and upstream retiring a rule is upstream
 * disagreeing with our copy about whether it should exist.
 *
 * Everything else the fork carried WAS already on the survivor under a different
 * spelling, so those gaps were renames rather than gaps: fonts.md is upstream's
 * google-fonts.md + local-fonts.md, assets.md is images.md + embedding-videos.md
 * + audio.md, animations.md is timing.md + effects.md.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, relative } from "node:path"
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

console.log("\n═══ 6. ONE vendored Remotion skill, and it matches upstream ═══")
{
  // Sanctioned homes. The survivor is what Claude Code loads; the mirror is kept
  // because §1's "unreferenced is not dead" applies to a convention-loaded skill
  // directory. Both are listed so a THIRD copy cannot appear unnoticed.
  const SURVIVOR = ".claude/skills/remotion-best-practices"
  const MIRROR = ".agents/skills/remotion-best-practices"

  /**
   * Does this SKILL.md declare a Remotion agent skill?
   *
   * Frontmatter `name:` only. Upstream fronts its ELEVEN embedded sub-skills with
   * REFERENCE.md rather than SKILL.md, so the survivor's own subtree contributes
   * exactly one manifest and nesting cannot inflate the count.
   */
  function isRemotionSkillManifest(content: string): boolean {
    const fm = content.split(/^---\s*$/m)[1]
    return fm !== undefined && /^name:\s*remotion[\w-]*\s*$/m.test(fm)
  }

  /** Every SKILL.md in the tree that declares a Remotion skill. */
  function findRemotionSkillManifests(root: string): string[] {
    const found: string[] = []
    const walk = (dir: string) => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".next" || e.name === ".vercel") continue
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name === "SKILL.md") {
          let src = ""
          try { src = readFileSync(full, "utf8") } catch { continue }
          if (isRemotionSkillManifest(src)) found.push(relative(root, full).replace(/\\/g, "/"))
        }
      }
    }
    walk(root)
    return found.sort()
  }

  // ── POSITIVE CONTROL (§2: an absence assertion must prove its finder works) ──
  // A broken frontmatter parse and a clean tree both report "no extra copies".
  ok("finder recognises a Remotion skill manifest",
    isRemotionSkillManifest("---\nname: remotion-video-creation\ndescription: x\n---\n# body"))
  ok("...and the current survivor's own manifest",
    isRemotionSkillManifest(readFileSync(`${SURVIVOR}/SKILL.md`, "utf8")))
  ok("...and does NOT fire on a non-Remotion skill (no false duplicates)",
    !isRemotionSkillManifest("---\nname: manim-video\ndescription: remotion-best-practices is related\n---"))
  ok("...nor on prose that merely MENTIONS the skill — a tombstone is not a manifest",
    !isRemotionSkillManifest("---\nname: video-editing\n---\nsee .claude/skills/remotion-best-practices"))

  const manifests = findRemotionSkillManifests(".")
  const expected = [`${SURVIVOR}/SKILL.md`, `${MIRROR}/SKILL.md`].sort()
  const strays = manifests.filter((m) => !expected.includes(m))

  ok("the survivor exists — the skill an agent actually loads", existsSync(`${SURVIVOR}/SKILL.md`))
  ok(`exactly the ${expected.length} sanctioned copies, no third has reappeared —\n    a renamed fork is how three disagreeing rule sets happened before`,
    strays.length === 0, strays.join(", "))
  ok("...and the finder really did read the tree (not zero files)", manifests.length >= 1,
    `found ${manifests.length}`)

  // The mirror must AGREE with the survivor. Two copies that drift are worse than
  // one copy, because whichever an agent loads silently decides what it knows.
  const fileSet = (root: string): Map<string, string> => {
    const out = new Map<string, string>()
    const walk = (dir: string) => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (statSync(full).isFile()) out.set(relative(root, full).replace(/\\/g, "/"), readFileSync(full).toString("base64"))
      }
    }
    walk(root)
    return out
  }
  if (existsSync(MIRROR)) {
    const a = fileSet(SURVIVOR), b = fileSet(MIRROR)
    const onlyA = [...a.keys()].filter((k) => !b.has(k))
    const onlyB = [...b.keys()].filter((k) => !a.has(k))
    const differing = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k))
    ok(`the .agents mirror carries the same ${a.size} files as the survivor`,
      onlyA.length === 0 && onlyB.length === 0,
      [...onlyA.map((f) => `survivor-only ${f}`), ...onlyB.map((f) => `mirror-only ${f}`)].slice(0, 4).join(" | "))
    ok("...and every one of them byte-for-byte — a drifted mirror teaches a\n    different Remotion to whichever harness loads it",
      differing.length === 0, differing.slice(0, 4).join(" | "))
    ok("...and the comparison actually read files", a.size > 0, `${a.size} files`)
  }

  // Pin the upstream version. Re-vendoring must be a deliberate act that moves
  // this number, not a silent partial edit of a third-party tree.
  const skillMd = readFileSync(`${SURVIVOR}/SKILL.md`, "utf8")
  const version = skillMd.split(/^---\s*$/m)[1]?.match(/^version:\s*(\S+)\s*$/m)?.[1]
  ok("the vendored skill declares the upstream version it came from —\n    otherwise nobody can tell a stale fork from a current one",
    !!version && /^\d+\.\d+\.\d+$/.test(version), `version=${version ?? "absent"}`)
  ok("...and the router names itself remotion-best-practices (§6, one spelling)",
    /^name:\s*remotion-best-practices\s*$/m.test(skillMd.split(/^---\s*$/m)[1] ?? ""))
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
