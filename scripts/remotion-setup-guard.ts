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
 * plugins/ecc/skills/remotion-video-creation/ (32 files) is DELETED.
 *
 * Everything the fork carried WAS already on the survivor under a different
 * spelling, so those gaps were renames rather than gaps: fonts.md is upstream's
 * google-fonts.md + local-fonts.md, assets.md is images.md + embedding-videos.md
 * + audio.md, animations.md is timing.md + effects.md — EXCEPT the three below.
 *
 * ── THREE RULES RESTORED BY OWNER RULING (2026-08-26) ───────────────────────
 *
 * charts.md, can-decode.md and extract-frames.md have no successor upstream:
 * upstream retired them in the 4.0.517 restructure, and the pass above dropped
 * them on the reasoning that "upstream retiring a rule is upstream disagreeing
 * that it should exist". THE OWNER OVERRULED THAT. Upstream is the authority on
 * what Remotion DOES; it is not the authority on what THIS repo builds, and all
 * three capabilities are live here:
 *
 *   · remotion/charts/ holds four chart components (PriceTrendLine, CompsBar,
 *     DaysOnMarketBars, AffordabilityDonut) that CMAReel imports, and
 *     EquityReportReel / ExplainerAnimReel draw over lib/charts/geometry —
 *     charts.md is the rule those components are judged against, and its
 *     "no animation not powered by useCurrentFrame()" is the same rule
 *     section 5 below already enforces on the tree;
 *   · lib/video/broll-picker.ts:306 constructs a Mediabunny
 *     Input/ALL_FORMATS/UrlSource to probe a b-roll clip — the exact shape
 *     can-decode.md documents;
 *   · mediabunny resolves in node_modules (transitively, via the Remotion
 *     encoder packages — broll-picker.ts says so at :295 and imports it through
 *     a variable specifier for that reason), so extract-frames.md describes an
 *     API this repo can call today without adding a dependency.
 *
 * They were recovered with `git show 3867e7fc^:plugins/ecc/skills/
 * remotion-video-creation/rules/<name>.md` and placed where upstream's own
 * structure puts that subject, NOT back into a resurrected flat rules/ dir:
 *
 *   remotion-markup/charts.md               (React markup — charts are markup)
 *   remotion-markup/assets/charts/bar-chart.tsx
 *       the specimen charts.md links to as `assets/charts/bar-chart.tsx`. The
 *       fork had FLATTENED it to rules/assets/charts-bar-chart.tsx, so the link
 *       was already dangling there; §1 says build the missing half, not restore
 *       a rule that points at nothing.
 *   remotion-multimedia/can-decode.md       (the sub-skill IS "Interacting with
 *   remotion-multimedia/extract-frames.md    Mediabunny" — both are Mediabunny)
 *
 * Each is linked from its sub-skill's REFERENCE.md router, marked with an HTML
 * comment naming this tombstone, because a rule no router points at is an orphan
 * that no agent will ever load. THOSE ROUTER EDITS AND THESE FOUR FILES ARE THE
 * ONLY PLACES THE SURVIVOR DIVERGES FROM UPSTREAM 4.0.517 — a future re-vendor
 * must carry them forward rather than silently drop them again.
 *
 * Both sanctioned copies carry them: section 6 below enforces the byte-identical
 * mirror across ALL files, so a restore into one copy alone goes red.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
// TOMBSTONE (2026-08-26): the `REGISTRY` geometry snapshot used to be DECLARED
// in this file. Survivor: lib/remotion/composition-geometry.ts
// (COMPOSITION_GEOMETRY, compositionSeconds, geometryFor). It moved because the
// narration cap needs the same frame counts at RUNTIME and lib/** cannot import
// scripts/** — this file runs its whole check suite at module load. Nothing about
// what this guard proves changed: the snapshot is still compared field-for-field
// against remotion/Root.tsx below, and the SQL that regenerates it now lives in
// the survivor's header. parseRootCompositions STAYED here: reading Root.tsx as
// text is something only this guard needs, and a lib/** export whose only caller
// is a proof is an orphan (§1).
import {
  COMPOSITION_GEOMETRY as REGISTRY,
  compositionSeconds,
  type RegisteredGeometry as Geo,
} from "../lib/remotion/composition-geometry"
import {
  narrationBudget,
  fitNarrationToBudget,
  narrationLengthDirective,
  spokenWords,
  NARRATION_HEADROOM,
  WORDS_PER_MINUTE,
  type NarrationFit,
} from "../lib/video/script-structure"
import { promoNarrationBudget } from "../lib/video/promo-composition"
import { sectionNarrationBudget, SECTION_NARRATION_COMPOSITION } from "../lib/listing-presentation/section-narration"
import { FINISH_PROP_KEYS } from "../lib/remotion/composition-cache"
import { paddingSecondsFor } from "../lib/remotion/voiceover-mixer"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

/** Parse every `<Composition …>` out of Root.tsx. Text, not a Remotion import,
 *  so this runs in a plain node process in milliseconds with no bundling. */
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

  // ── ONE SPELLING FOR TRIMMING A MEDIA CLIP (§6) ────────────────────────────
  // Remotion renamed `startFrom`→`trimBefore` and `endAt`→`trimAfter`. Both
  // spellings still WORK in the installed 4.0.473 — validate-start-from-props.js
  // exports resolveTrimProps, which reads `trimBefore ?? startFrom` — so this is
  // not a rendering bug and never was. It is a §6 defect and a scheduled break:
  // node_modules/remotion/dist/cjs/video/props.d.ts marks both old names
  // @deprecated, and the vendored skill
  // (.claude/skills/remotion-best-practices/remotion-markup/REFERENCE.md,
  // "Delaying, trimming") documents ONLY the new names, so an agent following
  // the skill and a file using the old names disagree about what to write.
  //
  // The two are also NOT interchangeable at the boundary: validateStartFromProps
  // refuses only `endAt < startFrom`, while validateTrimProps refuses
  // `trimAfter <= trimBefore`. A zero-length window used to pass silently and
  // now THROWS — which is the correct behaviour, and one more reason not to keep
  // a second spelling alive with weaker validation.
  const trimProp = /\b(startFrom|endAt)\s*=\s*\{/
  const deprecatedTrim: string[] = []
  for (const f of files) {
    // Strip comments AND string bodies first: this tombstone-shaped comment and
    // any prose specimen must not read as a live prop (§2).
    const src = blankStrings(stripComments(readFileSync(f, "utf8")))
    if (trimProp.test(src)) deprecatedTrim.push(f)
  }
  // POSITIVE CONTROL (§2): a broken regex and a clean tree both report zero.
  ok("the deprecated-trim finder still recognises the defect it was written for",
    trimProp.test(`<Video src={u} startFrom={2 * fps} />`)
    && trimProp.test(`<Video src={u} endAt={10} />`))
  ok("...and does NOT fire on the spelling we converted TO, nor on a longer name",
    !trimProp.test(`<Video src={u} trimBefore={2} trimAfter={10} />`)
    && !trimProp.test(`<X myStartFrom={1} />`))
  ok("...and it read stripped source, so a comment naming startFrom is not a call site",
    !trimProp.test(blankStrings(stripComments(`// use startFrom={0} — no\nconst x = "endAt={1}"`))))
  ok(`no <Video>/<Audio> in remotion/ still uses startFrom/endAt — one spelling,\n    and the new one is the only one the skill documents`,
    deprecatedTrim.length === 0, deprecatedTrim.slice(0, 6).join(", "))

  // ── MEDIA COMPONENTS COME FROM @remotion/media, NOT FROM "remotion" (§6) ───
  //
  // The installed remotion (4.0.473) still EXPORTS `Video` and `Audio`, so an
  // import from "remotion" compiles and renders — which is exactly why this
  // needs a guard rather than a compiler error. Both are marked @deprecated in
  // the installed types (node_modules/remotion/dist/cjs/video/html5-video.d.ts:
  // "This component has been renamed to `Html5Video`";
  // .../audio/html5-audio.d.ts: "…renamed to `Html5Audio`"), and the vendored
  // skill documents ONE source for them —
  // .claude/skills/remotion-best-practices/remotion-markup/REFERENCE.md,
  // "Media components": «Add video and audio using `<Video>` and `<Audio>` from
  // `@remotion/media`». So "remotion" and "@remotion/media" were two spellings
  // of the same component, and an agent following the skill and a file using the
  // old source disagreed about which one to write.
  //
  // THE DEPRECATED SET IS DERIVED FROM THE INSTALLED PACKAGE, not listed here
  // (§2: assert the RULE, don't pin a hardcoded name that a version bump makes
  // a lie). A name only counts if installed `remotion` marks it renamed AND
  // installed `@remotion/media` actually exports a replacement — so this can
  // never demand an import that does not resolve.
  const RM = "node_modules/remotion/dist/cjs"
  const MEDIA_DTS = "node_modules/@remotion/media/dist/index.d.ts"
  const RENAMED = /@deprecated This component has been renamed to `(\w+)`[\s\S]{0,400}?export declare const (\w+)/g
  function deprecatedRenamedExports(root: string): string[] {
    const names = new Set<string>()
    const walk = (dir: string, depth = 0) => {
      if (depth > 3) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) { walk(full, depth + 1); continue }
        if (!e.name.endsWith(".d.ts")) continue
        const src = readFileSync(full, "utf8")
        for (const m of src.matchAll(RENAMED)) names.add(m[2])
      }
    }
    walk(root)
    return [...names].sort()
  }
  const mediaExports = existsSync(MEDIA_DTS)
    ? new Set(
        (readFileSync(MEDIA_DTS, "utf8").match(/export\s*\{([^}]*)\}/g) ?? [])
          .flatMap((s) => s.replace(/export\s*\{|\}/g, "").split(","))
          .map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
          .filter(Boolean),
      )
    : new Set<string>()
  // Fail closed (§4): a gate that cannot read the packages it judges must refuse,
  // not report a clean tree. `npm ci` runs before every guard job.
  ok("the installed remotion + @remotion/media packages are readable — a guard that\n    cannot see them would report zero and read as a clean bill of health",
    existsSync(RM) && existsSync(MEDIA_DTS),
    `remotion dts=${existsSync(RM)} media dts=${existsSync(MEDIA_DTS)}`)
  const movedNames = deprecatedRenamedExports(RM).filter((n) => mediaExports.has(n))
  ok(`the derivation found the renamed components @remotion/media replaces (${movedNames.join(", ") || "none"})`,
    movedNames.length > 0)
  ok("...and it read the deprecation marker, not a guess",
    [...(`/**\n * @deprecated This component has been renamed to \`Html5X\`.\n */\nexport declare const X: unknown`)
      .matchAll(RENAMED)].map((m) => m[2]).join() === "X")

  const BARE_REMOTION_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']remotion["']/g
  /**
   * Which of the moved names this source still pulls from "remotion".
   *
   * A TOMBSTONE IS NOT A CALL SITE (§2) — this very comment block names `Video`
   * and "remotion" in prose, and the block above quotes the skill verbatim, so
   * the scan must read comment-free source.
   *
   * But blankStrings alone CANNOT be that source, and the positive control below
   * is what proved it: blankStrings blanks string CONTENTS, and the module
   * specifier "remotion" IS string content — so `from "remotion"` became
   * `from "        "` and the pattern matched nothing. A clean tree and a finder
   * that can no longer see the defect report the same zero.
   *
   * So the two offset-preserving views are used TOGETHER: match on the
   * comments-blanked text (where the specifier survives), then require that the
   * `import` keyword is still `import` in the strings-blanked text at the SAME
   * offset — which is only true when the statement is code rather than a
   * specimen inside a string literal. blankComments and blankStrings both keep
   * length and offsets, which is exactly what makes the two comparable.
   */
  const legacyMediaNames = (rawSrc: string): string[] => {
    const code = blankComments(rawSrc)
    const masked = blankStrings(rawSrc)
    const out: string[] = []
    for (const m of code.matchAll(BARE_REMOTION_IMPORT)) {
      if (masked.slice(m.index, m.index + "import".length) !== "import") continue
      out.push(...m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => movedNames.includes(s)))
    }
    return out
  }
  const wrongSource: string[] = []
  for (const f of files) {
    const hit = legacyMediaNames(readFileSync(f, "utf8"))
    if (hit.length) wrongSource.push(`${f}: ${hit.join("+")}`)
  }
  // POSITIVE CONTROL (§2): a broken regex and a clean tree both report zero.
  ok("the wrong-source finder still recognises the defect it was written for",
    legacyMediaNames(`import { AbsoluteFill, Video, Audio } from "remotion"`).length === movedNames.length)
  ok("...and does NOT fire on the source we converted TO",
    legacyMediaNames(`import { Audio, Video } from "@remotion/media"\nimport { AbsoluteFill } from "remotion"`).length === 0)
  ok("...nor on a comment or a string that merely names the old import",
    legacyMediaNames(`// import { Video } from "remotion"\nconst s = 'import { Audio } from "remotion"'`).length === 0)
  ok(`no composition imports ${movedNames.join("/")} from "remotion" — one source per\n    component (${files.length} files scanned under remotion/)`,
    wrongSource.length === 0, wrongSource.slice(0, 6).join(" | "))

  // ── objectFit ON <Video> IS A PROP, NEVER A STYLE ──────────────────────────
  // @remotion/media's <Video> paints into a <canvas> and builds the canvas style
  // as `{...style, objectFit: objectFitProp}` with `objectFit ?? "contain"`
  // (node_modules/@remotion/media/dist/esm/index.mjs) — so a style-level
  // objectFit is OVERWRITTEN by the default and a clip that used to fill its
  // frame silently letterboxes. The package says so itself:
  // warn-object-fit-css.ts logs "Use the `objectFit` prop instead of the `style`
  // prop." A render-time console warning is not a gate; this is.
  // Scoped to <Video>: <Img> is still remotion's real <img>, where style
  // objectFit is the correct and only way to say it.
  const videoTag = /<Video\b[\s\S]*?\/>/g
  const fitInStyle = /objectFit\s*:/
  const styledFit: string[] = []
  let videoTags = 0
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"))
    for (const m of src.matchAll(videoTag)) {
      videoTags++
      if (fitInStyle.test(m[0])) styledFit.push(f)
    }
  }
  ok("the style-objectFit finder recognises the shape it looks for",
    [...`<Video src={u} style={{ objectFit: "cover" }} />`.matchAll(videoTag)]
      .some((m) => fitInStyle.test(m[0])))
  ok("...and does NOT fire on the prop form, nor on a sibling <Img>",
    ![...`<Video src={u} objectFit="cover" style={{ width: "100%" }} />`.matchAll(videoTag)]
      .some((m) => fitInStyle.test(m[0]))
    && [...`<Img src={u} style={{ objectFit: "cover" }} />`.matchAll(videoTag)].length === 0)
  ok(`no <Video> hides objectFit in style — it is overwritten by the prop's\n    "contain" default (${videoTags} <Video> elements across remotion/)`,
    styledFit.length === 0, [...new Set(styledFit)].slice(0, 6).join(", "))

  // ── A DECLARED NARRATION PROP MUST HAVE A READER (§1) ──────────────────────
  // buildAvatarRenderRow (lib/video/avatar-render-orchestrator.ts) writes
  // input_props.voiceoverUrl on EVERY avatar render and stamps used_voiceover,
  // and the render coordinator muxes only the different key voiceover_url. So a
  // composition that DECLARES voiceoverUrl but never renders it turns a
  // separate-TTS narration into silence under a ledger row that says "narrated".
  // AgentTalkingHeadReel was exactly that. The RULE is derived, not a list: any
  // composition declaring the prop must also use it.
  // A DECLARATION, not a defaultProps VALUE: Root.tsx is the registry and
  // carries `voiceoverUrl: null` inside defaultProps, which is a value being
  // passed, not a prop a component promises to honour. Anchoring on the TYPE
  // (`?:` or `: string`) separates them by rule rather than by naming Root.tsx
  // in an exclusion list.
  const voDecl = /\bvoiceoverUrl(\?\s*:|\s*:\s*string)/
  const voRead = /<Audio\b[^>]*\bsrc=\{[^}]*voiceoverUrl/
  const declaresVo: string[] = []
  const rendersVo: string[] = []
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"))
    if (voDecl.test(src)) declaresVo.push(f)
    if (voRead.test(src)) rendersVo.push(f)
  }
  const declaredNeverRead = declaresVo.filter((f) => !rendersVo.includes(f))
  ok("the voiceover-reader finder recognises the shape it looks for",
    voRead.test(`{voiceoverUrl && <Audio src={voiceoverUrl} />}`)
    && voRead.test(`{props.voiceoverUrl ? <Audio src={props.voiceoverUrl} /> : null}`))
  ok("...and does NOT count a bare declaration as a reader",
    !voRead.test(`voiceoverUrl?: string`))
  ok("the declaration finder sees both prop spellings, and NOT a defaultProps value",
    voDecl.test(`voiceoverUrl?:  string | null`) && voDecl.test(`voiceoverUrl: string`)
    && !voDecl.test(`defaultProps={{ voiceoverUrl: null }}`))
  ok(`every composition that DECLARES voiceoverUrl also renders it (${rendersVo.length} of\n    ${declaresVo.length}) — a declared-only prop is silence under a "narrated" ledger row`,
    declaredNeverRead.length === 0, declaredNeverRead.join(", "))
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

console.log("\n═══ 7. NARRATION IS CAPPED AT GENERATION, per composition ═══")
{
  // ── THE DEFECT ────────────────────────────────────────────────────────────
  // There are TWO narration keys in a render's input_props and only ONE is
  // protected. `voiceover_url` (snake) is muxed by ffmpeg AFTER the render and
  // m313's tpad HOLDS THE FINAL FRAME for any overrun. `voiceoverUrl` (camel) is
  // an <Audio> INSIDE the composition, against a FIXED durationInFrames —
  // nothing pads it, THE OVERRUN IS CUT, and 14 compositions render that key.
  // Nothing anywhere compared a script's length to the composition that would
  // speak it: the listing-promo prompt asked for 60-80 words (~32s) for events
  // rendering on 12-second cuts, and the presentation-section prompt asked for
  // "3 to 5 sentences" on a composition that then ran TEN seconds.
  //
  // CAPPING WAS ONLY HALF OF IT. A cap sized to a wrong geometry buys silence
  // instead of a cut: ListingSectionReel's 10s bought 20 words — ONE sentence —
  // for the section that has to sell the seller. m566 widened it to 900 frames
  // (30s → 60 words) on both sides, Root.tsx and remotion_compositions, and
  // every number in this section re-derived itself. It is the only producer-fed
  // composition whose geometry can move alone: the other five carry internal
  // storyboards whose frame literals sum to their registered duration, so a
  // longer runtime would freeze their last frame rather than say more.
  //
  // Section 5 above already proves every composition that DECLARES voiceoverUrl
  // RENDERS it. This section proves the other half: every PRODUCER that writes
  // that key sizes its script to the composition's real geometry, and an
  // overrun is trimmed and REPORTED rather than silently cut.

  /** Does a script of this many words fit inside this composition? THE RULE. */
  const fitsComposition = (words: number, compositionId: string): boolean => {
    const geo = REGISTRY[compositionId]
    if (!geo) return false
    return estimateDurationSecondsLocal(words) <= compositionSeconds(geo)
  }
  // estimateDurationSeconds lives in script-structure; aliased so the rule above
  // reads as one line. Same function, no second pace constant (§6).
  function estimateDurationSecondsLocal(words: number): number {
    return Math.round((words / WORDS_PER_MINUTE) * 60)
  }

  // ── THE CENSUS, as a checked fact ─────────────────────────────────────────
  // Every composition rendering the camel key, and what produces its script.
  // A composition that appears in Root.tsx and in neither list fails below —
  // "nobody classified this one" must not read as "this one is fine".
  const PRODUCED: Record<string, string> = {
    // composition            → the producer that writes its narration
    JustListedReel:           "app/api/internal/remotion/render-just-listed/route.ts draftAndClearScript",
    JustSoldReelSquare:       "app/api/internal/remotion/render-just-listed/route.ts draftAndClearScript",
    OpenHouseAnnounceReel:    "app/api/internal/remotion/render-just-listed/route.ts draftAndClearScript",
    ComingSoonReel:           "app/api/internal/remotion/render-just-listed/route.ts draftAndClearScript",
    NewsletterDigestVideo:    "app/api/internal/remotion/render-newsletter-video/route.ts draft()",
    ListingSectionReel:       "lib/listing-presentation/section-narration.ts generateSectionNarration",
  }
  /** Declares + renders voiceoverUrl, but NOTHING in this repo generates a
   *  script for it — the prop is only ever null or supplied from outside.
   *  Listed, not ignored: each is a capability with no producer (§1), and if one
   *  gains a producer it must be capped and moved into PRODUCED above. */
  const NO_LIVE_PRODUCER: Record<string, string> = {
    CMAReel:                   "enqueueCmaReelRender takes voiceoverUrl; its only live caller (section-render.ts:179) passes null",
    AgentTalkingHeadReel:      "buildIntroCompositionRequest sets no voiceover_url — the D-ID avatar track carries its own audio",
    PhotoWalkthroughReel:      "no producer writes input_props for this composition",
    AffordabilitySnapshotReel: "no producer writes input_props for this composition",
    NeighborhoodSpotlightReel: "no producer writes input_props for this composition",
    TestimonialReel:           "no producer writes input_props for this composition",
    JustListedReelSquare:      "the Director's PAID cut; the organic render path routes just_listed to JustListedReel",
    JustListedReelHorizontal:  "no producer writes input_props for this composition",
  }

  const compFiles: string[] = []
  {
    const walk = (dir: string, depth = 0) => {
      if (depth > 3) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue
        const full = `${dir}/${e.name}`
        if (e.isDirectory()) walk(full, depth + 1)
        else if (/\.tsx?$/.test(e.name)) compFiles.push(full)
      }
    }
    walk("remotion")
  }
  // §2: a tombstone is not a call site. Read STRIPPED source, and blank string
  // bodies too — several of these files quote the prop name in prose.
  const voDeclRe = /\bvoiceoverUrl(\?\s*:|\s*:\s*string)/
  const declaring = compFiles
    .filter((f) => voDeclRe.test(blankStrings(stripComments(readFileSync(f, "utf8")))))
    .map((f) => f.replace(/^remotion\//, "").replace(/\.tsx?$/, ""))
    .filter((id) => !!REGISTRY[id])
    .sort()
  const classified = [...Object.keys(PRODUCED), ...Object.keys(NO_LIVE_PRODUCER)].sort()
  ok(`the camel-key census covers every composition that renders voiceoverUrl (${declaring.length})`,
    JSON.stringify(declaring) === JSON.stringify(classified),
    `unclassified: ${declaring.filter((d) => !classified.includes(d)).join(", ") || "none"} | `
    + `stale: ${classified.filter((c) => !declaring.includes(c)).join(", ") || "none"}`)
  ok("...and the census finder really read the tree (not zero files)",
    compFiles.length >= 33 && declaring.length >= 10)

  // ── EVERY PRODUCED COMPOSITION'S BUDGET FITS IT ───────────────────────────
  const promoBudgets = ["just_listed", "just_sold", "open_house_announce", "coming_soon", "price_reduction", "under_contract"]
    .map((e) => ({ eventType: e, budget: promoNarrationBudget(e) }))
  const newsletterBudget = narrationBudget("NewsletterDigestVideo", compositionSeconds(REGISTRY.NewsletterDigestVideo))
  const sectionBudget = sectionNarrationBudget()
  // The producer and the queue must name the SAME composition (§6): section-render
  // inserts a composition_id, and the cap is derived from whatever
  // SECTION_NARRATION_COMPOSITION says. If those two drift, the script is sized
  // for one composition and spoken over another — silently, since both render.
  // Comment-stripped but NOT string-masked: the composition id being looked for
  // IS a string literal, and masking would blank exactly the text in question.
  {
    const sectionRenderSrc = stripComments(readFileSync("lib/listing-presentation/section-render.ts", "utf8"))
    ok("the section producer caps against the composition section-render actually queues",
      sectionBudget.compositionId === SECTION_NARRATION_COMPOSITION
      && new RegExp(`composition_id:\\s*"${SECTION_NARRATION_COMPOSITION}"`).test(sectionRenderSrc))
    ok("...and that finder would notice a drift (control: a different id does not match)",
      !new RegExp(`composition_id:\\s*"SomeOtherReel"`).test(sectionRenderSrc))
  }

  const liveBudgets = [
    ...promoBudgets.map((p) => p.budget),
    newsletterBudget,
    sectionBudget,
  ]
  console.log("    composition            secs   budget  words   producer")
  for (const b of [...new Map(liveBudgets.map((b) => [b.compositionId, b])).values()]) {
    console.log(`    ${b.compositionId.padEnd(22)} ${String(b.compositionSeconds).padStart(4)}s `
      + `${String(b.budgetSeconds).padStart(6)}s ${String(b.maxWords).padStart(5)}   ${PRODUCED[b.compositionId] ?? "?"}`)
  }
  const overrunning = liveBudgets.filter((b) => !fitsComposition(b.maxWords, b.compositionId))
  ok(`every produced composition's word budget fits its own runtime (${liveBudgets.length} checked)`,
    overrunning.length === 0,
    // The REAL runtime from the registry, not the seconds the producer claimed —
    // a producer that derived its budget from the wrong number must not get to
    // print that wrong number as its own defence.
    overrunning.map((b) => `${b.compositionId}: budget ${b.maxWords}w ≈ `
      + `${estimateDurationSecondsLocal(b.maxWords)}s, composition really runs `
      + `${compositionSeconds(REGISTRY[b.compositionId] ?? { duration_frames: 0, fps: 30 })}s`).join(" | "))
  ok("...and every one of them leaves real headroom — 150 wpm is an AVERAGE, not\n    a bound, so a budget that exactly filled the runtime would overrun on any\n    faster-than-average read",
    liveBudgets.every((b) => b.headroom === NARRATION_HEADROOM && b.budgetSeconds < b.compositionSeconds))
  ok("...and each budget is DERIVED, not a literal: every composition gets its own\n    number, so the 12s square cuts are not handed the 25s reel's script length",
    new Set(liveBudgets.map((b) => b.maxWords)).size >= 3)

  // ── POSITIVE CONTROL (§2) — the OLD budgets must FAIL this same check ─────
  // A broken rule and a clean tree both report zero. These are the effective
  // word budgets each producer actually shipped before this pass. If the check
  // cannot see THESE, it is not seeing anything.
  //
  // EACH SPECIMEN CARRIES THE RUNTIME IT SHIPPED AGAINST (`secondsThen`), and
  // that is not decoration — it is §2's "do not pin an assertion to a WAYPOINT"
  // paid for in this very section. These rows used to be measured against the
  // LIVE registry, so m566 widening ListingSectionReel from 10s to 30s turned
  // the 45-word fallback specimen into a passing budget and took the whole
  // positive control red — the control would have failed BECAUSE the defect was
  // fixed. A historical specimen must be judged against the geometry of its own
  // moment; that fact never changes again.
  const RETIRED: Array<{ what: string; words: number; composition: string; secondsThen: number }> = [
    { what: "render-just-listed prompt asked for 60-80 words", words: 80, composition: "JustSoldReelSquare", secondsThen: 12 },
    { what: "render-just-listed prompt asked for 60-80 words", words: 80, composition: "OpenHouseAnnounceReel", secondsThen: 12 },
    { what: "render-just-listed prompt asked for 60-80 words", words: 80, composition: "ComingSoonReel", secondsThen: 12 },
    { what: "render-just-listed maxTokens 220 permitted ~165 words", words: 165, composition: "JustListedReel", secondsThen: 25 },
    { what: "render-newsletter-video maxTokens 150 permitted ~110 words", words: 110, composition: "NewsletterDigestVideo", secondsThen: 20 },
    { what: "section-narration maxTokens 320 permitted ~240 words", words: 240, composition: "ListingSectionReel", secondsThen: 10 },
    { what: "section-narration deterministic fallback ran ~45 words", words: 45, composition: "ListingSectionReel", secondsThen: 10 },
  ]
  const stillPassing = RETIRED.filter((r) => estimateDurationSecondsLocal(r.words) <= r.secondsThen)
  ok(`POSITIVE CONTROL: all ${RETIRED.length} pre-cap budgets FAIL the fit rule against the\n    geometry they shipped on — a budget that exceeds its composition's runtime is\n    caught, so a zero above means clean`,
    stillPassing.length === 0,
    stillPassing.map((r) => `${r.what} still reads as fitting ${r.secondsThen}s`).join(" | "))

  // ...and the LIVE-registry path of the same finder still works. A specimen is
  // allowed to read as fitting ONLY because its composition was deliberately
  // WIDENED since — never because fitsComposition went blind.
  const cured = RETIRED.filter((r) => fitsComposition(r.words, r.composition))
  const liveSeconds = (id: string) => compositionSeconds(REGISTRY[id] ?? { duration_frames: 0, fps: 30 })
  const wronglyCured = cured.filter((r) => liveSeconds(r.composition) <= r.secondsThen)
  ok(`...and the live-registry path agrees: ${RETIRED.length - cured.length}/${RETIRED.length} specimens still overrun their\n    composition TODAY, and every one that no longer does is explained by a real\n    widening — not by the finder going blind`,
    wronglyCured.length === 0,
    wronglyCured.map((r) => `${r.what} reads as fitting ${r.composition} at an unchanged ${r.secondsThen}s`).join(" | "))
  for (const r of cured) {
    console.log(`    · CURED BY GEOMETRY: ${r.what} — ${r.composition} ran ${r.secondsThen}s then, `
      + `${liveSeconds(r.composition)}s now`)
  }
  ok("...and the rule is not simply always-false: a budget that DOES fit passes",
    fitsComposition(20, "ListingSectionReel") && fitsComposition(50, "JustListedReel"))
  ok("...and an unregistered composition never reads as fitting (fail closed)",
    !fitsComposition(1, "NoSuchComposition"))

  // ── THE DERIVATION IS LIVE, not a snapshot of today's numbers ─────────────
  // Change the geometry and the budget must move with it. Proven two ways: over
  // the arithmetic, and over a SCRATCH copy of Root.tsx text (never the file).
  {
    // EVERY NUMBER BELOW IS DERIVED FROM THE COMPOSITION AS IT IS TODAY. The
    // frame counts used to be typed in (300 → 900), which meant this block
    // asserted a waypoint: the moment m566 widened ListingSectionReel the
    // scratch regex matched nothing, the edit silently became a no-op and the
    // assertion went red for the one reason that must never take a guard red —
    // the work landing. §2.
    const liveFrames = REGISTRY.ListingSectionReel.duration_frames
    const asIs = narrationBudget("X", compositionSeconds(REGISTRY.ListingSectionReel))
    const doubled = narrationBudget("X", compositionSeconds({ duration_frames: liveFrames * 2, fps: 30 }))
    const halfFrames = Math.round(liveFrames / 2)
    const halved = narrationBudget("X", compositionSeconds({ duration_frames: halfFrames, fps: 30 }))
    ok(`the budget moves with duration_frames (${liveFrames}f→${asIs.maxWords}w, ${liveFrames * 2}f→${doubled.maxWords}w, ${halfFrames}f→${halved.maxWords}w)`,
      doubled.maxWords === asIs.maxWords * 2 && halved.maxWords === Math.round(asIs.maxWords / 2))
    ok("...and with fps, because seconds is frames/fps and not frames",
      narrationBudget("X", compositionSeconds({ duration_frames: liveFrames, fps: 60 })).maxWords === Math.round(asIs.maxWords / 2))
    ok("a still card (duration_frames<=1) yields NO narration budget rather than an\n    unlimited one — 'no budget' must never read as 'no limit'",
      narrationBudget("X", compositionSeconds(REGISTRY.PostcardFront4x6)).maxWords <= 0)

    // Scratch Root.tsx: the SAME parser the guard uses above, over edited text.
    // The frame count it substitutes is 3× whatever Root.tsx says TODAY, so this
    // proves the derivation at any geometry rather than at one remembered one.
    const rootFrames = root.ListingSectionReel.duration_frames
    const scratchFrames = rootFrames * 3
    const scratch = rootSrc.replace(
      new RegExp(`(<Composition\\s+id="ListingSectionReel"[\\s\\S]*?durationInFrames=\\{)${rootFrames}(\\})`),
      `$1${scratchFrames}$2`)
    const scratchGeo = parseRootCompositions(scratch).ListingSectionReel
    const scratchBudget = narrationBudget("ListingSectionReel", compositionSeconds(scratchGeo))
    ok(`a scratch Root.tsx with ListingSectionReel at ${scratchFrames} frames yields ${scratchBudget.maxWords} words,\n    not the ${sectionBudget.maxWords} the real ${rootFrames}-frame geometry yields — the cap reads the GEOMETRY`,
      scratch !== rootSrc && scratchGeo.duration_frames === scratchFrames
      && scratchBudget.maxWords === sectionBudget.maxWords * 3)
  }

  // ── AN OVERRUN IS TRIMMED AT A SENTENCE BOUNDARY, AND NEVER SILENT ────────
  {
    const b = narrationBudget("T", 10)                    // 8s → 20 words
    const long = "One two three four five six seven eight nine ten. "
      + "Eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty. "
      + "Twenty-one twenty-two twenty-three twenty-four twenty-five."
    const fit: NarrationFit = fitNarrationToBudget(long, b)
    ok(`an over-budget script is trimmed to fit (${spokenWords(long).length}w → ${fit.wordCount}w, budget ${b.maxWords}w)`,
      fit.wordCount <= b.maxWords && fit.wordCount > 0)
    ok("...at a SENTENCE boundary — never mid-word, never mid-clause",
      /[.!?]["'”’)\]]?$/.test(fit.script) && long.startsWith(fit.script))
    ok("...and it SAYS SO: overran, droppedWords and a quotable note. An overrun\n    passing silently is the entire defect being fixed here",
      fit.overran && fit.droppedWords > 0 && fit.note.length > 0 && fit.note.includes("trimmed"))

    const shortEnough = "One two three four five. Six seven eight nine ten."
    const clean = fitNarrationToBudget(shortEnough, b)
    ok("CONTROL: a script that already fits is returned untouched, with no note —\n    the trim does not fire on healthy output",
      clean.script === shortEnough && !clean.overran && clean.droppedWords === 0 && clean.note === "")

    const oneHugeSentence = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ") + "."
    const stuck = fitNarrationToBudget(oneHugeSentence, b)
    ok("a single sentence longer than the whole composition is KEPT (an empty track\n    is worse) but flagged stillOverBudget with a note naming the geometry",
      stuck.stillOverBudget && stuck.overran && stuck.note.includes("too short"))
    ok("...and a composition with NO runtime drops the narration outright rather\n    than baking a track nothing can play",
      fitNarrationToBudget("Anything at all.", narrationBudget("T", 0)).script === ""
      && fitNarrationToBudget("Anything at all.", narrationBudget("T", 0)).note.length > 0)
    ok("empty in, empty out, no note", fitNarrationToBudget("", b).note === "" && fitNarrationToBudget("", b).script === "")
  }

  // ── THE PRODUCERS ACTUALLY DO IT ──────────────────────────────────────────
  // Read STRIPPED, string-masked source: every one of these files now EXPLAINS
  // the cap in a comment, and a comment naming fitNarrationToBudget is not a
  // call to it (§2). `${…}` interpolations survive blankStrings, which is where
  // narrationLengthDirective sits inside each prompt.
  {
    const PRODUCER_FILES = [
      "app/api/internal/remotion/render-just-listed/route.ts",
      "app/api/internal/remotion/render-newsletter-video/route.ts",
      "lib/listing-presentation/section-narration.ts",
    ]
    const srcOf = (f: string) => blankStrings(stripComments(readFileSync(f, "utf8")))
    const constrains = /narrationLengthDirective\s*\(/
    const verifies = /fitNarrationToBudget\s*\(/
    const budgets = /narrationMaxTokens\s*\(/
    const missingConstraint = PRODUCER_FILES.filter((f) => !constrains.test(srcOf(f)))
    const missingVerify = PRODUCER_FILES.filter((f) => !verifies.test(srcOf(f)))
    const missingTokens = PRODUCER_FILES.filter((f) => !budgets.test(srcOf(f)))
    ok("the producer finders recognise the shapes they look for",
      constrains.test("x(`${narrationLengthDirective(b)}`)") && verifies.test("const f = fitNarrationToBudget(t, b)"))
    ok("...and a COMMENT naming them is not a call site (stripped source)",
      !verifies.test(srcOf("scripts/strip-comments.ts"))
      && !constrains.test(blankStrings(stripComments("// calls narrationLengthDirective(b) somewhere"))))
    ok(`all ${PRODUCER_FILES.length} camel-key producers CONSTRAIN the prompt with the derived budget`,
      missingConstraint.length === 0, missingConstraint.join(", "))
    ok(`...and all ${PRODUCER_FILES.length} VERIFY the returned script — telling a model "at most N words"\n    is a request, not a guarantee`,
      missingVerify.length === 0, missingVerify.join(", "))
    ok(`...and all ${PRODUCER_FILES.length} size the model's token budget from the same number, so\n    nobody pays for three times the text they throw away`,
      missingTokens.length === 0, missingTokens.join(", "))

    // The retired literals must be GONE from live code, not merely outnumbered.
    const retiredLiterals: Array<[string, RegExp]> = [
      ["lib/listing-presentation/section-narration.ts", /maxTokens:\s*320/],
      ["app/api/internal/remotion/render-just-listed/route.ts", /maxTokens:\s*220/],
      ["app/api/internal/remotion/render-newsletter-video/route.ts", /maxTokens:\s*150/],
      ["app/api/internal/remotion/render-just-listed/route.ts", /60-80 word/],
      ["lib/listing-presentation/section-narration.ts", /3 to 5 sentences/],
    ]
    // The last two live inside prompt template literals, so they are matched on
    // comment-stripped (NOT string-masked) source — masking would blank exactly
    // the text being looked for.
    const survivors = retiredLiterals.filter(([f, re]) => re.test(stripComments(readFileSync(f, "utf8"))))
    ok("POSITIVE CONTROL: the retired-literal finder still matches what it hunts",
      /maxTokens:\s*320/.test("  maxTokens: 320, temperature: 0.8")
      && /60-80 word/.test("Write a 60-80 word voiceover script"))
    ok(`no producer still carries a hand-written length ceiling (${retiredLiterals.length} retired literals)`,
      survivors.length === 0, survivors.map(([f, re]) => `${f} ${re}`).join(" | "))
  }

  // ── THE TWO KEYS MUST STAY DISTINCT ──────────────────────────────────────
  // The whole design rests on it: snake voiceover_url is a FINISH input the
  // coordinator pads (m313 tpad); camel voiceoverUrl is IN the frames and
  // cannot be padded, which is why its script is capped instead. Collapsing
  // them would silently un-pad the padded half or double the voice on the other.
  ok("input_props.voiceover_url is still a FINISH key (padded by the mux) and\n    voiceoverUrl still is not — the cap exists because only one can be padded",
    (FINISH_PROP_KEYS as readonly string[]).includes("voiceover_url")
    && !(FINISH_PROP_KEYS as readonly string[]).includes("voiceoverUrl"))
  ok("...and the pad still fires for the snake key, so the OUT-OF-SCOPE producers\n    (partners-meeting, deal-room, board-packet, listing-pitch, go-live probe)\n    remain rescued rather than capped",
    paddingSecondsFor(30, 20) > 9 && paddingSecondsFor(10, 20) === 0)
}


console.log(`\n${"═".repeat(70)}`)
console.log(`REMOTION SETUP — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nIf a composition legitimately changed, update BOTH Root.tsx and")
  console.log("remotion_compositions, then refresh COMPOSITION_GEOMETRY in")
  console.log("lib/remotion/composition-geometry.ts (the SQL is in its header).")
  process.exit(1)
}
console.log("What Remotion renders and what the OS believes are the same 33 compositions.")
