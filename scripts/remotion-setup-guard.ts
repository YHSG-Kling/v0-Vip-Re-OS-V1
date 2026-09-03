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
 * ONLY PLACES THE SURVIVOR DIVERGES FROM THE UPSTREAM SNAPSHOT IT DECLARES — a
 * re-vendor must carry them forward rather than silently drop them again.
 *
 * ── RE-VENDORED 2026-09-03 → skill version 4.0.520 ─────────────────────────
 *
 * Source: upstream remotion-dev/skills@54e9b19a612897171e0b3b242e01c2badba4a272
 * (2026-09-01, the only commit whose SKILL.md declares 4.0.520; 7a3d0ca and
 * 357a270/9875d9a between it and 7c5c10c declare .518 and .519). Same layout
 * as before (SKILL.md router over REFERENCE.md-fronted sub-skills — the
 * monorepo's packages/skills fronts them with SKILL.md, the published repo
 * renames on the way out). What actually changed, beyond the version line in
 * all thirteen frontmatters: remotion-captions/display-captions.md +
 * REFERENCE.md gained `pageBreakAfter` and a tokenIndex key; the three
 * remotion-multimedia get-*.md dropped `getRetryDelay: () => null` from
 * UrlSource. Nothing was removed upstream. The four restored files and the two
 * router blocks above were carried forward (their HTML comments now name
 * 4.0.520). The .agents/ mirror was NOT touched by that lane (out of its
 * write set) — section 6's byte-identity assertion is what tells the
 * integrator to sync it, exactly as the paragraph below promises.
 *
 * Both sanctioned copies carry them: section 6 below enforces the byte-identical
 * mirror across ALL files, so a restore into one copy alone goes red.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { createRequire } from "node:module"
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
// The live CHECK snapshot (§3: generated, never hand-edited). Section 7 derives
// the promo narration set from listing_promo_videos.event_type rather than
// retyping the event vocabulary here, so a new event type moves the number.
import { CHECK_VOCABULARIES } from "./check-vocabularies"

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

// ── THE INSTALLED REMOTION, DERIVED ONCE ─────────────────────────────────────
// Several sections below describe "the installed package". That description
// used to carry a version LITERAL in prose (4.0.473, typed on 2026-09-01), and
// the very next day's bump made every one of those sentences false while every
// assertion beside them stayed green — §2's waypoint pin, in comments. So the
// number is derived HERE, from node_modules, and every label that describes the
// installed package prints THIS value. No prose in this file may claim what
// version is installed; section 6 asserts that rule over this file's own text.
//
// FAIL CLOSED (§4): a gate that cannot load the package it judges must refuse,
// not report a clean bill of health — section 6 asserts `installedRemotion` is
// non-null before it trusts the export list.
let installedRemotion: Record<string, unknown> | null = null
let installedVersion = "unreadable"
try {
  const req = createRequire(join(process.cwd(), "package.json"))
  installedRemotion = req("remotion") as Record<string, unknown>
  installedVersion = (req("remotion/package.json") as { version: string }).version
} catch (e) {
  installedRemotion = null
  installedVersion = `unreadable (${(e as Error).message})`
}

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

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 3b. …and the SNAPSHOT still matches the LIVE table ═══")
// THE BLIND SPOT SECTION 3 HAD, NAMED AND CLOSED WHERE IT CAN BE.
//
// Sections 2-3 compare Root.tsx against COMPOSITION_GEOMETRY — a STATIC mirror
// of remotion_compositions checked into lib/. That proves Root and the mirror
// agree; it proves NOTHING about the live table, which is what actually feeds
// the render cache key, the narration pad and the still/moving fork at runtime.
// So the exact drift the guard's own header says it exists to prevent could sit
// in production with every assertion green: edit the live row, leave the mirror
// alone, and the OS offers a video that renders at a geometry nobody checked.
//
// CI has no database, so this cannot be a hard requirement there — a gate that
// cannot run must refuse rather than pass (CLAUDE.md §4), and the honest form of
// "refuse" for a check with no credentials is to SAY IT SKIPPED. It never
// reports ✓ for a comparison it did not make.
//
// Verified by hand against hrvaqgvukzxfskkcrwbt on 2026-08-28: all 33 rows, all
// four geometry fields, ZERO drift across Root.tsx / COMPOSITION_GEOMETRY / live.
{
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  skipped — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")
    console.log("     The static mirror is UNVERIFIED against the live table in this run.")
  } else {
    const { createServiceClient } = await import("../lib/supabase/service")
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("remotion_compositions")
      .select("composition_id, width, height, fps, duration_frames")
    // supabase-js RESOLVES a refusal (§3). A swallowed error would leave `rows`
    // empty and every comparison below vacuously true — the exact "reports zero
    // and reads as a clean bill of health" shape §2 warns about.
    if (error) {
      ok("the live remotion_compositions read succeeded", false, error.message)
    } else {
      const rows = (data ?? []) as Array<{ composition_id: string; width: number; height: number; fps: number; duration_frames: number }>
      const liveById = new Map(rows.map((r) => [r.composition_id, r]))
      ok(`the live table returned rows at all (${rows.length})`, rows.length > 0)
      const onlyLive = rows.map((r) => r.composition_id).filter((id) => !REGISTRY[id])
      const onlyMirror = Object.keys(REGISTRY).filter((id) => !liveById.has(id))
      ok("the live table and the checked-in mirror name the SAME compositions",
        onlyLive.length === 0 && onlyMirror.length === 0,
        [...onlyLive.map((i) => `live-only ${i}`), ...onlyMirror.map((i) => `mirror-only ${i}`)].join(", "))
      const drift: string[] = []
      for (const [id, m] of Object.entries(REGISTRY)) {
        const l = liveById.get(id)
        if (!l) continue
        for (const f of ["width", "height", "fps", "duration_frames"] as const) {
          if (m[f] !== l[f]) drift.push(`${id}.${f} mirror=${m[f]} live=${l[f]}`)
        }
      }
      ok("no geometry drift between the checked-in mirror and the LIVE table —\n    regenerate COMPOSITION_GEOMETRY (the SQL is in its header) if this fails",
        drift.length === 0, drift.slice(0, 6).join(" | "))
    }
  }
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

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 4b. Each component's INTERNAL storyboard sums to its registered duration ═══")
// Sections 2-3 prove Root.tsx, the mirror and the live table agree about
// durationInFrames. None of them look INSIDE the component: most moving
// compositions carry a hand-written frame storyboard (`const FPS = 30`,
// `const TOTAL = COVER + BODY + CTA`, or a `const FRAMES = {...}` table whose
// last *_END is the total), and NOTHING forced that sum to equal the number the
// composition registers. A drift here is the worst of section 3's failure
// shapes moved one level down: the render still succeeds, but the storyboard
// either stops early (frozen last frame under live narration) or overruns
// (sequences cut off mid-beat) — and every registry-level check stays green.
//
// THE RULE IS DERIVED, NOT A LIST (§2): the storyboard total is evaluated from
// each component file's own top-level consts, so a composition that changes its
// beats moves the derived number with it. Components with no derivable
// storyboard (duration comes from useVideoConfig(), or a still card with no
// storyboard at all) are SKIPPED WITH A PRINTED REASON — a skip must never read
// as a pass, and the skip list is published beside the count (§2 blind spots).
{
  /**
   * Evaluate one storyboard expression against previously-bound consts.
   * Accepts numbers, bound identifiers, + - * / and parens; anything else
   * (Easing.bezier(...), object literals, unbound names) returns null and the
   * declaration is simply not bound — never a crash, never a guess.
   */
  const evalStoryboardExpr = (expr: string, env: Record<string, number>): number | null => {
    const substituted = expr
      .replace(/\s+as\s+const\s*$/, "")
      .trim()
      .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => (env[name] !== undefined ? String(env[name]) : name))
    // Math.round/floor/ceil are the one function family a storyboard uses
    // (TeammateExplainerReel: Math.round(2.5 * FPS)); everything else stays
    // unevaluable on purpose.
    const validation = substituted.replace(/Math\.(round|floor|ceil)/g, "")
    if (!/^[\d+\-*/ ().]+$/.test(validation) || validation.trim() === "") return null
    try {
      const v = Function(`"use strict"; return (${substituted})`)() as unknown
      return typeof v === "number" && Number.isFinite(v) ? v : null
    } catch { return null }
  }

  type Storyboard = { total: number; how: string } | { total: null; reason: string }

  /**
   * Derive a component file's storyboard total from COMMENT-STRIPPED,
   * STRING-BLANKED source (§2: a tombstone naming `const TOTAL` in prose, or a
   * fixture inside a template literal, must not read as a storyboard).
   */
  const deriveStoryboardTotal = (rawSrc: string): Storyboard => {
    const src = blankStrings(stripComments(rawSrc))
    // Top-level const bindings, in declaration order, so TOTAL sees its parts.
    const env: Record<string, number> = {}
    for (const m of src.matchAll(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n]+)$/gm)) {
      const v = evalStoryboardExpr(m[2], env)
      if (v !== null) env[m[1]] = v
    }
    if (env.TOTAL !== undefined) return { total: env.TOTAL, how: "const TOTAL" }
    // FRAMES table: the storyboard is absolute frame offsets; the total is the
    // largest value (the final *_END).
    const frames = src.match(/^const\s+FRAMES\s*=\s*\{([\s\S]*?)\}/m)
    if (frames) {
      const values = [...frames[1].matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]))
      if (values.length > 0) return { total: Math.max(...values), how: "FRAMES table max" }
    }
    if (/useVideoConfig\(\)/.test(src)) {
      return { total: null, reason: "duration derives from useVideoConfig() — nothing internal to assert" }
    }
    return { total: null, reason: "no derivable const storyboard (TOTAL / FRAMES) — timing is inline or prop-driven" }
  }

  // ── POSITIVE CONTROLS (§2) — a blind deriver and a clean tree both report zero ──
  ok("the deriver evaluates a TOTAL sum with precedence (COVER + STAT * 3 + CTA)",
    (() => {
      const d = deriveStoryboardTotal("const FPS = 30\nconst COVER = 2 * FPS\nconst STAT = 4 * FPS\nconst CTA = 2 * FPS\nconst TOTAL = COVER + STAT * 3 + CTA\n")
      return d.total === 480
    })())
  ok("...and a FRAMES table by its largest offset",
    deriveStoryboardTotal("const FRAMES = {\n  COVER_END: 60,\n  CTA_START: 660,\n  CTA_END: 750,\n} as const\n").total === 750)
  ok("...and a Math.round beat (TeammateExplainerReel's 2.5s intro)",
    deriveStoryboardTotal("const FPS = 30\nconst INTRO = Math.round(2.5 * FPS)\nconst BODY = Math.round(24.5 * FPS)\nconst OUTRO = 3 * FPS\nconst TOTAL = INTRO + BODY + OUTRO\n").total === 900)
  ok("...and a DESYNCED storyboard is actually caught — a component summing 510\n    against a 540-frame registration reads as 510, not as fine",
    (() => {
      const d = deriveStoryboardTotal("const FPS = 30\nconst COVER = 3 * FPS\nconst DIAGRAM = 11 * FPS\nconst CTA = 3 * FPS\nconst TOTAL = COVER + DIAGRAM + CTA\n")
      // === 510 alone proves the desync is visible (tsc: after narrowing to the
      // literal 510, a second !== 540 comparison is statically vacuous).
      return d.total === 510
    })())
  ok("...and it read STRIPPED source — a comment or a string naming const TOTAL is\n    not a storyboard",
    deriveStoryboardTotal("// const TOTAL = 300\nconst s = `const TOTAL = 300`\n").total === null)
  ok("...and an unbound name never evaluates to a guess (Easing consts are skipped)",
    (() => {
      const d = deriveStoryboardTotal("const ENTER = Easing.bezier(0.16, 1, 0.3, 1)\nconst TOTAL = ENTER + 1\n")
      return d.total === null
    })())

  // ── composition id → component file, via Root.tsx's own imports ────────────
  const importMap: Record<string, string> = {}
  for (const m of blankComments(rootSrc).matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/g)) {
    for (const piece of m[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop()!.trim()
      if (name) importMap[name] = `remotion/${m[2]}.tsx`
    }
  }
  const componentOf: Record<string, string> = {}
  for (const block of blankComments(rootSrc).split(/<Composition/).slice(1)) {
    const id = block.match(/id="([A-Za-z0-9_]+)"/)?.[1]
    const comp = block.match(/component=\{\s*([A-Za-z0-9_]+)/)?.[1]
    if (id && comp) componentOf[id] = comp
  }
  ok("every registered composition names a resolvable component file",
    Object.keys(root).every((id) => !!importMap[componentOf[id] ?? ""]),
    Object.keys(root).filter((id) => !importMap[componentOf[id] ?? ""]).join(", "))

  // ── the assertion ──────────────────────────────────────────────────────────
  const mismatched: string[] = []
  const skipped: string[] = []
  let asserted = 0
  for (const [id, g] of Object.entries(root)) {
    if (g.duration_frames <= 1) { skipped.push(`${id}: still card — no storyboard to sum`); continue }
    const file = importMap[componentOf[id] ?? ""]
    if (!file) { mismatched.push(`${id}: component file unresolvable`); continue }
    const sb = deriveStoryboardTotal(readFileSync(file, "utf8"))
    if (sb.total === null) { skipped.push(`${id}: ${sb.reason}`); continue }
    asserted++
    if (sb.total !== g.duration_frames) {
      mismatched.push(`${id}: storyboard (${sb.how}) sums to ${sb.total}, Root registers ${g.duration_frames}`)
    }
  }
  for (const s of skipped) console.log(`    ⏭  ${s}`)
  ok(`the deriver found a real number of storyboards to assert (${asserted} asserted,\n    ${skipped.length} skipped with reasons above)`, asserted >= 16, `asserted=${asserted}`)
  ok("every derivable internal storyboard sums EXACTLY to the registered\n    durationInFrames — a drift freezes the last frame or cuts a beat, silently",
    mismatched.length === 0, mismatched.slice(0, 6).join(" | "))
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

  // ── `scale` / `translate` / `rotate`, NOT A `transform` STRING ─────────────
  //
  // The vendored skill is explicit
  // (.claude/skills/remotion-best-practices/remotion-markup/REFERENCE.md:50):
  // «Use `scale`, `translate`, `rotate` CSS properties over `transform`», with
  // the 👎 example being exactly `transform: \`scale(${scale})\``. The reason is
  // STUDIO EDITABILITY, not rendering: Remotion Studio can read and write back an
  // individual transform property, while a transform STRING is an opaque
  // template literal it cannot offer to edit. 23 sites in remotion/ were the 👎
  // shape; 22 were converted on 2026-09-01 and this keeps them converted.
  //
  // THIS IS NOT A BLANKET BAN, AND MUST NOT BECOME ONE. The two spellings are
  // NOT universally equivalent: individual properties compose in the fixed order
  // translate → rotate → scale, whereas a transform string composes left to
  // right, so ANY element combining two functions renders differently under the
  // conversion. remotion/PhotoWalkthroughReel.tsx's Ken Burns pan is exactly
  // that case and is deliberately left alone. An exemption is taken by writing
  //
  //     // remotion-transform-string: <why the conversion is not equivalent>
  //
  // in the twelve lines above the site. The marker is read from RAW source
  // (it is a comment) while the hit is found in comment- AND string-blanked
  // source, which is why both offset-preserving views are used together — the
  // same technique the wrong-source finder below records paying for.
  const TRANSFORM_STRING = /\btransform\s*:/g
  const ALLOW_MARKER = /remotion-transform-string\s*:/
  type TransformHit = { file: string; line: number; allowed: boolean }
  const transformHits = (file: string, raw: string): TransformHit[] => {
    const masked = blankStrings(blankComments(raw))   // both keep length + offsets
    const rawLines = raw.split("\n")
    const out: TransformHit[] = []
    for (const m of masked.matchAll(TRANSFORM_STRING)) {
      const line = masked.slice(0, m.index).split("\n").length          // 1-based
      const window = rawLines.slice(Math.max(0, line - 13), line).join("\n")
      out.push({ file, line, allowed: ALLOW_MARKER.test(window) })
    }
    return out
  }
  // POSITIVE CONTROLS (§2) — a broken regex and a clean tree both report zero.
  ok("the transform-string finder recognises both 👎 shapes the skill names",
    transformHits("<c>", "style={{ transform: `scale(${s})` }}").length === 1
    && transformHits("<c>", 'style={{ transform: "rotate(18deg)" }}').length === 1)
  ok("...and does NOT fire on transformOrigin, textTransform, or the properties we\n    converted TO",
    transformHits("<c>", "style={{ scale, transformOrigin: 'center center', textTransform: 'uppercase' }}").length === 0
    && transformHits("<c>", "style={{ translate: `0 ${y}px`, rotate: '18deg' }}").length === 0)
  ok("...nor on a COMMENT or a STRING that merely names transform: (stripped source)",
    transformHits("<c>", "// transform: `scale(2)` was here\nconst s = `text-transform:uppercase`").length === 0)
  ok("...and the exemption marker suppresses a real hit, but only within its window",
    transformHits("<c>", "// remotion-transform-string: two functions\ntransform: `a b`").every((h) => h.allowed)
    && transformHits("<c>", "// remotion-transform-string: stale\n" + "\n".repeat(20) + "transform: `a b`").every((h) => !h.allowed))

  const transformAll = files.flatMap((f) => transformHits(f, readFileSync(f, "utf8")))
  const transformBare = transformAll.filter((h) => !h.allowed)
  const transformExempt = transformAll.filter((h) => h.allowed)
  ok(`no style in remotion/ builds a \`transform\` STRING — ${transformAll.length} site(s) scanned across\n    ${files.length} files, ${transformExempt.length} exempt with an in-tree reason (the skill's rule at\n    remotion-markup/REFERENCE.md:50)`,
    transformBare.length === 0,
    transformBare.slice(0, 8).map((h) => `${h.file}:${h.line}`).join(", "))
  // A STALE EXEMPTION IS ALSO A DEFECT: a marker left behind after its site was
  // converted reads as a standing licence nobody re-earned. Every marker in the
  // tree must sit above a real hit.
  {
    let markers = 0
    const orphanMarkers: string[] = []
    for (const f of files) {
      const raw = readFileSync(f, "utf8")
      const hitLines = new Set(transformHits(f, raw).filter((h) => h.allowed).map((h) => h.line))
      raw.split("\n").forEach((ln, i) => {
        if (!ALLOW_MARKER.test(ln)) return
        markers++
        // the marker is live if some allowed hit sits within the 12 lines below it
        const live = [...hitLines].some((h) => h > i && h <= i + 13)
        if (!live) orphanMarkers.push(`${f}:${i + 1}`)
      })
    }
    ok(`every transform-string exemption is LIVE (${markers} marker line(s)) — a marker left\n    behind after its site was converted is a licence nobody re-earned`,
      orphanMarkers.length === 0, orphanMarkers.slice(0, 5).join(", "))
  }

  // ── ONE SPELLING FOR TRIMMING A MEDIA CLIP (§6) ────────────────────────────
  // Remotion renamed `startFrom`→`trimBefore` and `endAt`→`trimAfter`. Both
  // spellings still WORK in the installed remotion (whatever version
  // node_modules holds — `installedVersion`, printed in the label below, never
  // a literal here): validate-start-from-props.js exports resolveTrimProps,
  // which reads `trimBefore ?? startFrom` — so this is not a rendering bug and
  // never was. It is a §6 defect and a scheduled break:
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
  ok(`no <Video>/<Audio> in remotion/ still uses startFrom/endAt — one spelling,\n    and the new one is the only one the skill documents (installed remotion@${installedVersion}\n    still accepts both, so only this guard sees the drift)`,
    deprecatedTrim.length === 0, deprecatedTrim.slice(0, 6).join(", "))

  // ── EVERY interpolate() CLAMPS ON BOTH SIDES ───────────────────────────────
  //
  // The skill's example scene passes `extrapolateLeft` AND `extrapolateRight` on
  // every call, and Remotion's default on the missing side is "extend" — it keeps
  // extrapolating the line past the input range. That is the same class of defect
  // as the CSS-transition rule above: the render SUCCEEDS and the frame is wrong.
  //
  // WHY THIS GUARD EXISTS RATHER THAN THE PREVIOUS WAVE'S ONE-OFF PASS. A lane
  // reported "all 131 interpolate() calls now clamp"; measured here on
  // 2026-08-28, 105 did and 26 clamped only the RIGHT side, because the sweep
  // looked for `extrapolate` rather than for BOTH keys. Half of a two-sided rule
  // reads exactly like all of it. Eight of those 26 opened on an input range
  // starting after frame 0, so the left extension really produced out-of-range
  // output — remotion/TeammateExplainerReel.tsx's progress bar interpolated to a
  // NEGATIVE width for its first eight frames, which CSS discards, so the bar
  // rendered at full width during the very frames it was supposed to be empty.
  // All 26 now clamp both sides; this keeps the next one from landing.
  //
  // BALANCED-PAREN SCAN, not a line regex: the majority of these calls span
  // several lines, and a per-line test would report every one of them as missing
  // a key that sits two lines down — the accusing direction of §2.
  const unclamped: string[] = []
  let interpolateCalls = 0
  const scanClamps = (src: string, label: string) => {
    const lines = src.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i].indexOf("interpolate(")
      if (at < 0) continue
      interpolateCalls++
      let depth = 0, text = "", started = false
      for (let j = i; j < Math.min(lines.length, i + 30); j++) {
        for (const ch of j === i ? lines[j].slice(at) : lines[j]) {
          text += ch
          if (ch === "(") { depth++; started = true }
          else if (ch === ")") depth--
        }
        if (started && depth === 0) break
      }
      if (!/extrapolateLeft/.test(text) || !/extrapolateRight/.test(text)) {
        unclamped.push(`${label}:${i + 1}`)
      }
    }
  }
  const before = interpolateCalls
  // POSITIVE CONTROL (§2) — a broken scanner and a clean tree both report zero.
  scanClamps(`const a = interpolate(frame, [0, 10], [0, 1])`, "<control-bare>")
  scanClamps(`const b = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" })`, "<control-half>")
  const controlCaught = unclamped.length === 2
  scanClamps(`const c = interpolate(frame, [0, 10], [0, 1], {\n  extrapolateLeft: "clamp",\n  extrapolateRight: "clamp",\n})`, "<control-multiline>")
  const controlClean = unclamped.length === 2
  unclamped.length = 0
  interpolateCalls = before
  ok("the clamp finder still catches a bare call AND a right-only call",
    controlCaught)
  ok("...and does NOT accuse a MULTI-LINE call that clamps both sides",
    controlClean)

  for (const f of files) scanClamps(stripComments(readFileSync(f, "utf8")), f)
  ok(`every interpolate() in remotion/ clamps BOTH sides (${interpolateCalls} call sites) —\n    an unclamped side extends the line past the range and renders a wrong frame`,
    unclamped.length === 0, unclamped.slice(0, 8).join(", "))

  // ── MEDIA COMPONENTS COME FROM @remotion/media, NOT FROM "remotion" (§6) ───
  //
  // The installed remotion (version derived above as `installedVersion` and
  // printed in the label — never typed here) still EXPORTS `Video` and `Audio`,
  // so an import from "remotion" compiles and renders — which is exactly why
  // this needs a guard rather than a compiler error. Both are marked @deprecated in
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
  ok(`no composition imports ${movedNames.join("/")} from "remotion" — one source per\n    component (${files.length} files scanned under remotion/; installed remotion@${installedVersion}\n    still exports the old names, so the compiler cannot see this)`,
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

  // ── GENERALISED: NO DECLARED-BUT-UNREAD PROP, IN ANY COMPOSITION (§1) ─────
  //
  // The voiceoverUrl rule above is one instance of a shape that recurred twice
  // more on 2026-09-03: PartnersMeetingReel declared `narration` (the TTS
  // carrier the producers put in input_props) and VideoCoverThumb declared
  // `seoHint` (REQUIRED by the content contract — renders were being refused
  // over a prop that changed no pixel). A prop in a composition's Props
  // interface that the component never reads is a promise the render does not
  // keep, and the contract cannot see it. The rule is derived over every
  // registered composition's own `<Id>Props` interface, not a list.
  //
  // "READ" means the name occurs in the file outside the interface, with the
  // component's destructuring pattern REMOVED first — `({ a, b }) => …{a}…`
  // pulls `b` out and never uses it, and a finder that counted the pattern as
  // a read would have passed exactly that. A whole-props spread (`{...props}`)
  // forwards everything and counts as reading all. Read on comment-stripped,
  // string-blanked source: a tombstone naming the retired prop (there is one
  // in PartnersMeetingReel.tsx) is not a read.
  //
  // The voiceoverUrl assertion above STAYS beside this one: it is the stronger
  // form for that prop (read is not enough — it must reach an <Audio src>).
  // BLIND SPOTS: only depth-1 keys are checked (a nested `brand.logoUrl`
  // nobody reads is invisible); a prop read only to be forwarded to a child
  // that ignores it counts as read; only `export interface <Id>Props` is
  // parsed, so a composition typing its props another way is reported as
  // "no interface", never as clean.
  type PropsDecl = { names: string[]; start: number; end: number }
  const declaredProps = (src: string, id: string): PropsDecl | null => {
    const m = src.match(new RegExp(`export\\s+interface\\s+${id}Props\\b[^{]*\\{`))
    if (!m || m.index === undefined) return null
    const open = m.index + m[0].length - 1
    let depth = 0, i = open
    for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) break } }
    const names: string[] = []
    let d = 0
    for (const line of src.slice(open + 1, i).split("\n")) {
      if (d === 0) { const k = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/); if (k) names.push(k[1]) }
      for (const ch of line) { if (ch === "{") d++; else if (ch === "}") d-- }
    }
    return { names, start: m.index, end: i + 1 }
  }
  const unreadProps = (raw: string, id: string): { unread: string[]; declared: number } | null => {
    const src = blankStrings(stripComments(raw))
    const decl = declaredProps(src, id)
    if (!decl) return null
    const body = (src.slice(0, decl.start) + src.slice(decl.end))
      .replace(/\(\s*\{[^{}]*\}\s*(?::\s*[^)]*)?\)\s*=>/g, "() =>")   // drop destructuring patterns
    const spreadsAll = /\.\.\.(props|rest|p)\b/.test(body)
    return { declared: decl.names.length, unread: spreadsAll ? [] : decl.names.filter((n) => !new RegExp(`\\b${n}\\b`).test(body)) }
  }
  // POSITIVE CONTROLS (§2) — a blind finder and a clean tree both report zero.
  const FIX = (props: string, comp: string) => `export interface DemoProps {\n${props}\n}\nexport const Demo: React.FC<DemoProps> = ${comp}\n`
  ok("the unread-prop finder catches a prop the component never mentions, and\n    lists nested keys under `brand` as ONE prop",
    JSON.stringify(unreadProps(FIX("  a: string\n  b?: string | null\n  brand: {\n    c: string\n  }", "({ a, brand }) => <div style={{ color: brand.c }}>{a}</div>"), "Demo")?.unread) === '["b"]')
  ok("...and a prop that is DESTRUCTURED but never used — the pattern is not a read",
    JSON.stringify(unreadProps(FIX("  a: string\n  b: string", "({ a, b }) => <div>{a}</div>"), "Demo")?.unread) === '["b"]')
  ok("...and does NOT accuse a `props.b` read, nor a whole-props spread",
    unreadProps(FIX("  a: string\n  b: string", "(props) => <div>{props.a}{props.b}</div>"), "Demo")?.unread.length === 0
    && unreadProps(FIX("  a: string\n  b: string", "(props) => <Child {...props} />"), "Demo")?.unread.length === 0)
  ok("...and a COMMENT or STRING naming the prop is not a read (stripped source)",
    JSON.stringify(unreadProps(FIX("  a: string\n  b: string", "({ a }) => <div>{a}</div> // b: string is read here, honest\nconst s = \"b\""), "Demo")?.unread) === '["b"]')
  ok("...and a file with no `<Id>Props` interface reports null, never clean",
    unreadProps("export const Demo = () => null", "Demo") === null)

  const unreadByComposition: string[] = []
  const noInterface: string[] = []
  let propsDeclared = 0
  for (const id of Object.keys(root)) {
    const file = `remotion/${id}.tsx`
    if (!existsSync(file)) { noInterface.push(`${id}: no remotion/${id}.tsx`); continue }
    const r = unreadProps(readFileSync(file, "utf8"), id)
    if (!r) { noInterface.push(`${id}: no export interface ${id}Props`); continue }
    propsDeclared += r.declared
    if (r.unread.length) unreadByComposition.push(`${id}: ${r.unread.join(", ")}`)
  }
  ok(`every registered composition has a parseable <Id>Props interface (${Object.keys(root).length - noInterface.length} of ${Object.keys(root).length},\n    ${propsDeclared} props declared) — one this finder cannot see is unchecked, not clean`,
    noInterface.length === 0, noInterface.join(" | "))
  ok("no composition declares a prop it never reads — a declared-only prop is a\n    promise the render does not keep (narration and seoHint were exactly that)",
    unreadByComposition.length === 0, unreadByComposition.join(" | "))

  // ── A REMOTE-src <Img> MUST DEGRADE, NOT CANCEL THE RENDER ────────────────
  //
  // The installed remotion's <Img> retries a failed load `maxRetries` times
  // (default 2) and then calls cancelRender() UNLESS an `onError` prop exists
  // — the branch is read out of node_modules below, not remembered. Measured
  // 2026-09-03: ~89 <Img> elements under remotion/, 0 onError, so one rotated
  // MLS photo or one moved brokerage logo failed the WHOLE render and the row
  // went to `failed` with every good photo unseen. THE RULE: every <Img> whose
  // src is a tenant/MLS URL is the SafeImg wrapper
  // (remotion/components/SafeImg.tsx — onError → neutral fallback panel,
  // delayRenderRetries for a hung CDN) or carries its own onError. Data-URL
  // sites (a QR minted in-process) and staticFile() sites stay bare ON
  // PURPOSE: those cannot fail unless the producer is broken, and a print
  // piece with a blank square where the QR was is worse than a failed render.
  //
  // BLIND SPOT (§2): "remote" is decided by the NAME of the src expression —
  // an identifier containing DataUrl/dataUrl, a staticFile() call, or a
  // `data:` literal reads as local; everything else reads as remote. A data
  // URL under a name like `qrPng` would be asked to wrap, which is the safe
  // direction to be wrong in. Read on comment-BLANKED source (offsets kept
  // for line numbers); prose that mentions <Img> is not an element.
  const LOCAL_IMG_SRC = /DataUrl|dataUrl|staticFile\s*\(|^["'`]data:/
  type ImgTag = { file: string; line: number; src: string; local: boolean; onError: boolean }
  const imgTags = (file: string, raw: string): ImgTag[] => {
    const code = blankComments(raw)
    const out: ImgTag[] = []
    for (const m of code.matchAll(/<Img\b/g)) {
      const start = m.index!
      let depth = 0, i = start
      for (; i < code.length; i++) {
        const ch = code[i]
        if (ch === "{") depth++
        else if (ch === "}") depth--
        else if (ch === "/" && code[i + 1] === ">" && depth === 0) { i += 2; break }
      }
      const tag = code.slice(start, i)
      // brace-balanced src expression, so `{{ … }}` siblings and `[idx % n]` survive
      let src = tag.match(/\bsrc=(["'][^"']*["'])/)?.[1] ?? ""
      const at = tag.search(/\bsrc=\{/)
      if (at >= 0) {
        let d = 0, j = at + "src=".length
        for (; j < tag.length; j++) { if (tag[j] === "{") d++; else if (tag[j] === "}") { d--; if (d === 0) break } }
        src = tag.slice(at + "src={".length, j).trim()
      }
      out.push({ file, line: code.slice(0, start).split("\n").length, src, local: LOCAL_IMG_SRC.test(src), onError: /\bonError=/.test(tag) })
    }
    return out
  }
  // POSITIVE CONTROLS (§2): a broken tag scanner and a clean tree both report zero.
  const ctrlBare = imgTags("<c>", '<Img src={heroImageUrl} style={{ width: "100%" }} />')
  ok("the <Img> finder recognises a bare remote-src element",
    ctrlBare.length === 1 && !ctrlBare[0].local && !ctrlBare[0].onError && ctrlBare[0].src === "heroImageUrl")
  const ctrlMulti = imgTags("<c>", "<Img\n  src={images[idx % images.length]}\n  style={{\n    width: 1,\n    objectFit: \"cover\",\n  }}\n/>\n<Img src={x} />")
  ok("...across a multi-line tag with nested braces, as ONE element with its src",
    ctrlMulti.length === 2 && ctrlMulti[0].src === "images[idx % images.length]" && ctrlMulti[0].line === 1 && ctrlMulti[1].line === 8)
  ok("...and reads a data-URL / staticFile site as LOCAL, an onError site as handled",
    imgTags("<c>", "<Img src={qrCodeDataUrl} />")[0].local
    && imgTags("<c>", '<Img src={staticFile("logo.png")} />')[0].local
    && imgTags("<c>", "<Img src={u} onError={fn} />")[0].onError)
  ok("...and does NOT match the SafeImg wrapper, nor a COMMENT naming <Img>",
    imgTags("<c>", "<SafeImg src={u} />").length === 0
    && imgTags("<c>", "// <Img src={u} />\n/* <Img src={v} /> */").length === 0)

  // The PREMISE, derived from the installed package rather than remembered:
  // <Img> cancels the render after its retries unless onError exists. Fail
  // closed (§4) — a guard that cannot read the file it reasons from must not
  // report the rule as holding.
  const imgJs = existsSync(`${RM}/Img.js`) ? readFileSync(`${RM}/Img.js`, "utf8") : ""
  ok("the installed <Img> really does cancelRender() after its retries unless onError\n    exists (read from node_modules/remotion/dist/cjs/Img.js, so a package that\n    changes this behaviour changes this line, not the rule's premise silently)",
    /if \(onError &&[\s\S]{0,400}?onError\(e\);[\s\S]{0,900}?cancelRender\('Error loading image with src: '/.test(imgJs),
    imgJs ? "the cancelRender-unless-onError branch was not found" : "Img.js unreadable")

  const allImgTags = files.flatMap((f) => imgTags(f, readFileSync(f, "utf8")))
  const bareRemote = allImgTags.filter((t) => !t.local && !t.onError)
  const wrapped = files.reduce((n, f) => n + (blankComments(readFileSync(f, "utf8")).match(/<SafeImg\b/g) ?? []).length, 0)
  ok(`the scan saw real elements (${allImgTags.length} bare <Img> — ${allImgTags.filter((t) => t.local).length} local by name,\n    ${allImgTags.filter((t) => t.onError).length} with onError — plus ${wrapped} <SafeImg> wrappers across ${files.length} files)`,
    allImgTags.length + wrapped >= 60 && wrapped >= 40)
  ok("no remote-src <Img> is left to cancel the render — every one is the SafeImg\n    wrapper or carries onError (a stale tenant photo now degrades to a neutral\n    panel instead of failing the row)",
    bareRemote.length === 0, bareRemote.slice(0, 8).map((t) => `${t.file}:${t.line} src=${t.src}`).join(", "))
  {
    // The wrapper itself must be what the rule assumes: it hands <Img> an
    // onError, keeps state to swap in a fallback, and refuses `effects`
    // (with effects <Img> renders a canvas that REJECTS onError).
    // Comment-stripped but NOT string-blanked: the `Omit<…, "effects">` being
    // looked for IS a string literal, and blanking would erase exactly it (the
    // wrong-source finder in this section records paying for the same thing).
    const safeImgSrc = stripComments(readFileSync("remotion/components/SafeImg.tsx", "utf8"))
    ok("SafeImg passes onError to <Img>, keeps a failed state, and omits `effects`\n    from its prop type",
      /<Img\b[^>]*\bonError=\{/.test(safeImgSrc) && /useState/.test(safeImgSrc) && /Omit<ImgProps,\s*(?:[^>]*\|\s*)?["']effects["']/.test(safeImgSrc))
  }

  // ── A COMPOSITION FILE MAY NOT RE-DECLARE ITS OWN REGISTERED GEOMETRY ────
  //
  // Root.tsx registers width/height; lib/remotion/composition-geometry.ts
  // mirrors them and §3 proves the two agree. A THIRD copy typed into the
  // component (`const W = 1080, H = 1350`; `width: 630, height: 630`;
  // `1275 - Math.floor(1275 * 0.52)`) sits OUTSIDE that proof: re-register the
  // composition and the canvas, the knob-hole centre or the indicia keep-out
  // stays at the old number with everything green. useVideoConfig() is the
  // one source. Measured 2026-09-03: the audit named 3 files; this scan found
  // 6 (NewsletterDigestThumb's 630 pane and both postcard backs' keep-out
  // arithmetic were the same defect under a different spelling — §2: the
  // count that moved is the finding). All six now read useVideoConfig().
  //
  // THE RULE IS DERIVED per composition from its OWN registration, so a
  // literal that merely equals SOME composition's dimension (EquityReportReel's
  // 760×180 chart box inside a 1080×1080 canvas) is not an offence. Read on
  // comment-stripped, string-blanked source: a spec block deriving
  // "1350 × 3375 px @ 300 DPI" in prose is documentation, not a declaration.
  // BLIND SPOTS: only 3-4 digit literals are compared, so a dimension reached
  // through arithmetic (`675 * 2`) or a 2-digit canvas is invisible; and a
  // literal that legitimately coincides with a dimension in another role
  // would need an in-line rewrite to a named, derived value.
  const ownGeometryLiterals = (rawSrc: string, g: Geo): string[] => {
    const hits: string[] = []
    blankStrings(stripComments(rawSrc)).split("\n").forEach((ln, i) => {
      for (const m of ln.matchAll(/(?<![\w.])(\d{3,4})(?![\w.])/g)) {
        const n = Number(m[1])
        if (n === g.width || n === g.height) hits.push(`${i + 1}: ${n} (${n === g.width ? "width" : "height"})`)
      }
    })
    return hits
  }
  const demoGeo: Geo = { width: 1080, height: 1350, fps: 30, duration_frames: 1 }
  ok("the geometry-literal finder catches `const W = 1080, H = 1350` in a 1080×1350\n    composition, a style `height: 1350`, and keep-out arithmetic",
    ownGeometryLiterals("const W = 1080, H = 1350\n", demoGeo).length === 2
    && ownGeometryLiterals("style={{ width: \"100%\", height: 1350 }}", demoGeo).length === 1
    && ownGeometryLiterals("const r = 1080 - Math.floor(1080 * 0.52)", demoGeo).length === 2)
  ok("...and does NOT fire on another composition's size, a comment, a string, or a\n    longer number",
    ownGeometryLiterals("const W = 760, H = 180", demoGeo).length === 0
    && ownGeometryLiterals("// const W = 1080\nconst s = `1350px`\nconst n = 11080", demoGeo).length === 0)
  const geometryLiterals: string[] = []
  for (const [id, g] of Object.entries(root)) {
    const file = `remotion/${id}.tsx`
    if (!existsSync(file)) continue
    for (const h of ownGeometryLiterals(readFileSync(file, "utf8"), g)) geometryLiterals.push(`${file}:${h}`)
  }
  ok(`no composition file re-declares its own registered width or height as a literal\n    (${Object.keys(root).length} files checked against their registrations) — useVideoConfig() is the one source`,
    geometryLiterals.length === 0, geometryLiterals.slice(0, 8).join(", "))
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

  // ── THE VERSION THE SKILL DECLARES IS NOT A FACT ABOUT THIS REPO ──────────
  //
  // The assertion above proves the vendored skill DECLARES an upstream version.
  // It cannot prove that version is the one INSTALLED.
  //
  // HISTORY, RESOLVED BY THE BUMP (99b5f076, 2026-09-02). On 2026-09-01 the
  // two were apart: the skill declared 4.0.517 while package.json pinned a
  // caret range whose node_modules resolution then held 4.0.473, and the gap
  // was not cosmetic — the skill's PRIMARY markup pattern is `<Interactive.Div>`
  // and that older package had no `Interactive` export at all, so an agent
  // following the skill verbatim wrote a component that did not compile.
  // Nothing could see it: a declared version and an installed version were two
  // numbers nobody compared. The bump moved all five Remotion packages past
  // the skill's snapshot and `Interactive` now resolves; the assertion below
  // is what proved that on the day, and what keeps proving it.
  //
  // THIS PARAGRAPH NAMES NO CURRENT VERSION ON PURPOSE. The first draft did
  // ("node_modules holds …", "not exported by …") and every clause was false
  // one commit later while the assertion beside it stayed green — the exact
  // §2 waypoint pin. The installed version is derived once at the top of this
  // file (`installedVersion`) and printed in the labels; the rule that no prose
  // here may claim it is asserted at the end of this block over this file's
  // own text.
  //
  // COMPARING THE NUMBERS WOULD BE THE WEAK FORM (§2: do not pin an assertion to
  // a waypoint — a version string is exactly that, and semver skew between a
  // skill snapshot and a caret range is normal and mostly harmless). THE STRICT
  // AND CHEAP FORM IS THE ONE THAT MATTERS: every symbol the skill's REFERENCE.md
  // routers tell an agent to import from "remotion" must actually RESOLVE in the
  // installed package. That is derived from node_modules, like the renamed-media
  // derivation in section 5, and it names the offending symbol so the reader
  // knows which side to fix — bump the dependency, or re-vendor the skill.
  //
  // BLIND SPOTS, published beside the number (§2): only REFERENCE.md files are
  // scanned (the routers an agent loads first), not the ~60 leaf .md rules or
  // the .tsx specimens; only `from "remotion"` is checked, not `@remotion/*`;
  // and `import { type X }` specifiers are skipped because a type is not a
  // runtime export and `in` cannot see one.
  {
    const referenceDocs: string[] = []
    const walkDocs = (dir: string) => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walkDocs(full)
        else if (e.name === "REFERENCE.md") referenceDocs.push(full)
      }
    }
    walkDocs(SURVIVOR)

    const REMOTION_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']remotion["']/g
    /** Value symbols a doc tells an agent to import from "remotion". */
    const importedValueNames = (src: string): string[] => {
      const out: string[] = []
      for (const m of src.matchAll(REMOTION_IMPORT)) {
        for (const raw of m[1].split(",")) {
          const piece = raw.trim()
          if (!piece || /^type\s/.test(piece)) continue   // a type is not a runtime export
          const name = piece.split(/\s+as\s+/)[0].trim()
          if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name)
        }
      }
      return out
    }

    // FAIL CLOSED (§4): a gate that cannot load the package it judges must
    // refuse, not report a clean bill of health. The derivation itself lives at
    // the top of the file (one spelling, §6) so sections 5 and 6 print the
    // same number.
    const installed = installedRemotion
    ok(`the INSTALLED remotion package loaded, so its export list is a fact and not\n    an assumption (${installedVersion})`,
      !!installed && Object.keys(installed).length > 0)

    const wanted = new Map<string, string[]>()
    for (const doc of referenceDocs) {
      for (const name of importedValueNames(readFileSync(doc, "utf8"))) {
        if (!wanted.has(name)) wanted.set(name, [])
        if (!wanted.get(name)!.includes(doc)) wanted.get(name)!.push(doc)
      }
    }
    // POSITIVE CONTROLS (§2): a broken import parser and a skill that imports
    // nothing report the same zero.
    ok("the import finder reads a symbol list out of a REFERENCE.md code fence",
      JSON.stringify(importedValueNames(`import { useCurrentFrame, Easing, interpolate, Interactive } from "remotion";`))
        === JSON.stringify(["useCurrentFrame", "Easing", "interpolate", "Interactive"]))
    ok("...and does NOT claim a runtime export for a type-only specifier, nor for a\n    sibling package",
      importedValueNames(`import {createEffect, type InteractivitySchema} from 'remotion';`).join() === "createEffect"
      && importedValueNames(`import { Audio, Video } from "@remotion/media";`).length === 0)
    ok(`the scan really read the routers (${referenceDocs.length} REFERENCE.md files, ${wanted.size} distinct\n    symbols imported from "remotion")`,
      referenceDocs.length >= 10 && wanted.size >= 5)

    const unresolved = [...wanted.keys()].filter((n) => !installed || !(n in installed)).sort()
    // A CONTROL ON THE RESOLVER ITSELF: a name the package really does export
    // must resolve, and an invented one must not — otherwise "0 unresolved" and
    // "the resolver is broken" look identical.
    ok("the resolver agrees with the package on a name it DOES export, and on one it\n    does not",
      !!installed && "useCurrentFrame" in installed && !("NoSuchRemotionExport" in installed))
    ok(`every symbol the vendored skill imports from "remotion" resolves in the\n    INSTALLED package — the skill declares ${version ?? "?"}, node_modules holds ${installedVersion};\n    a symbol that does not exist makes the skill's own example uncompilable`,
      unresolved.length === 0,
      unresolved.map((n) => `${n} — imported by ${(wanted.get(n) ?? []).join(", ")} but NOT exported by remotion@${installedVersion}`
        + ` (fix ONE side: bump the remotion dependency to a version that exports it, or re-vendor the skill from the upstream snapshot that matches ${installedVersion})`).join(" | "))
    // The symbol the 2026-09-01 gap was about, asserted by NAME so the history
    // above stays a checked fact rather than a story: the skill's primary
    // markup pattern must resolve. Derived from the skill's own imports (it is
    // in `wanted`), not from a hardcoded expectation of the package.
    ok("...and the skill's primary markup symbol (`Interactive`) is among them and resolves",
      wanted.has("Interactive") && !!installed && "Interactive" in installed)

    // ── NO PROSE IN THIS FILE MAY CLAIM THE INSTALLED VERSION (§2) ─────────
    // The guard's own text is scanned RAW (comments are the thing being
    // judged) for the sentence shapes that lied last time. The controls are
    // built by concatenation so the specimens do not themselves sit in the
    // file as matches.
    const CLAIMS_INSTALLED_LITERAL = [
      /\binstalled\s+(?:remotion\s*)?\(?\s*\d+\.\d+\.\d+\)?/i,
      /\bnode_modules\s+holds\s+\d+\.\d+\.\d+/i,
      /\bexported\s+by\s+\d+\.\d+\.\d+/i,
      /\bremotion@\d+\.\d+\.\d+\b/,
    ]
    const guardSelf = readFileSync("scripts/remotion-setup-guard.ts", "utf8")
    const selfHits = CLAIMS_INSTALLED_LITERAL.flatMap((re) => {
      const m = guardSelf.match(re)
      return m ? [`${m[0]} @ line ${guardSelf.slice(0, m.index).split("\n").length}`] : []
    })
    ok("the literal-version finder recognises the retired sentences (control)",
      CLAIMS_INSTALLED_LITERAL[0].test("the installed " + "4.0." + "473")
      && CLAIMS_INSTALLED_LITERAL[0].test("installed remotion (" + "4.0." + "473)")
      && CLAIMS_INSTALLED_LITERAL[1].test("node_modules holds " + "4.0." + "473")
      && CLAIMS_INSTALLED_LITERAL[2].test("not exported by " + "4.0." + "473 at all")
      && CLAIMS_INSTALLED_LITERAL[3].test("remotion@" + "4.0." + "473"))
    ok("...and does NOT fire on the derived spelling or on the skill's own declared version",
      !CLAIMS_INSTALLED_LITERAL.some((re) => re.test("installed remotion@${installedVersion} still exports"))
      && !CLAIMS_INSTALLED_LITERAL.some((re) => re.test("the skill declares 4.0.517")))
    ok("no prose in this guard claims the installed remotion at a version LITERAL —\n    the number is derived (`installedVersion`) and printed, never typed",
      selfHits.length === 0, selfHits.join(" | "))
  }
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

  // ── WHO PRODUCES WHAT — DERIVED, NOT ASSERTED IN PROSE ────────────────────
  //
  // TOMBSTONE (2026-09-01): THE CENSUS WAS RIGHT AND ITS EVIDENCE WAS FALSE.
  // NO_LIVE_PRODUCER used to be a hand-written map whose VALUE was a per-entry
  // prose reason, and FIVE of the eight reasons were factually wrong on the day
  // they were read:
  //
  //   AffordabilitySnapshotReel  "no producer writes input_props" — but
  //                              lib/agents/buyer-match-reel-producer.ts is one.
  //   TestimonialReel            "no producer writes input_props" — but
  //   NeighborhoodSpotlightReel   lib/video/video-director.ts commissions all
  //   PhotoWalkthroughReel        four (selectVideoFormat → commissionVideo →
  //   JustListedReelHorizontal    provider_metadata.input_props).
  //
  // The classification was still CORRECT — none of the five gets a narration
  // SCRIPT — so every assertion stayed green while the stated reason told the
  // next reader the composition had no producer at all. That is §2's "a guard
  // that reports the right number for the wrong reason": the number cannot
  // protect the sentence beside it.
  //
  // SO THE DISTINCTION IS NOW DERIVED. Two independent questions are answered
  // separately, and the classification falls out of the second:
  //
  //   (a) does any producer stage input_props for this composition?
  //       → scanned out of comment-stripped lib/** + app/** source below, and
  //         PRINTED beside every entry. A composition with a props producer can
  //         never again read as having none.
  //   (b) does any producer stage a NARRATION for it?
  //       → derived by RUNNING the one narration contract (promoNarrationBudget
  //         over the live listing_promo event vocabulary, sectionNarrationBudget,
  //         and the newsletter route's own composition constant). A composition
  //         a producer sizes a script for is PRODUCED; one nobody sizes a script
  //         for is what "no live producer" has always meant here.
  //
  // (a) AND (b) ARE NOT THE SAME QUESTION, and the whole defect was reading them
  // as one. The D-ID handoff (lib/video/avatar-render-orchestrator.ts) shows up
  // in (a) for all fourteen camel-key compositions because it stages whatever
  // provider_metadata.target_composition_id names — but it FORWARDS a voiceover
  // URL somebody else synthesized and sizes no script, which is asserted below
  // rather than claimed.
  const producerFiles: string[] = []
  {
    const walk = (dir: string, depth = 0) => {
      if (depth > 10) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue
        const full = `${dir}/${e.name}`
        if (e.isDirectory()) walk(full, depth + 1)
        else if (/\.tsx?$/.test(e.name)) producerFiles.push(full)
      }
    }
    walk("lib"); walk("app")
  }
  // Comment-stripped but NOT string-masked: a composition id IS a string
  // literal, and blankStrings would blank exactly the text being looked for —
  // the same hazard the wrong-source finder in section 5 records paying for.
  const producerSrc = new Map(producerFiles.map((f) => [f, stripComments(readFileSync(f, "utf8"))]))
  // A producer names its composition either as a literal or through a named
  // constant (§6, one spelling: SECTION_NARRATION_COMPOSITION, COMPOSITION_ID,
  // NEWSLETTER_VIDEO_COMPOSITION…). Both are resolved, so a file that imported
  // the constant is not read as naming nothing.
  const aliasOfComposition = new Map<string, string>()
  for (const src of producerSrc.values()) {
    for (const m of src.matchAll(/\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']([A-Za-z0-9_]+)["']/g)) {
      if (REGISTRY[m[2]]) aliasOfComposition.set(m[1], m[2])
    }
  }
  const idPattern = new Map(Object.keys(REGISTRY).map((id) => [id, new RegExp(`["'\`]${id}["'\`]`)]))
  const aliasPattern = new Map([...aliasOfComposition].map(([a, id]) => [a, { re: new RegExp(`\\b${a}\\b`), id }]))
  /** Every composition id this source names, by literal or by constant. */
  const compositionsNamedIn = (src: string): Set<string> => {
    const out = new Set<string>()
    for (const [id, re] of idPattern) if (re.test(src)) out.add(id)
    for (const [, { re, id }] of aliasPattern) if (re.test(src)) out.add(id)
    return out
  }
  /** Does this source stage a Remotion render at all? */
  const STAGES_RENDER = /\binput_props\s*:|\binputProps\b|queue_composition_render/
  const propsStagers: Record<string, string[]> = Object.fromEntries(Object.keys(REGISTRY).map((id) => [id, [] as string[]]))
  for (const [f, src] of producerSrc) {
    if (!STAGES_RENDER.test(src)) continue
    for (const id of compositionsNamedIn(src)) propsStagers[id].push(f)
  }

  // ── POSITIVE CONTROLS (§2) — a blind scanner and a clean tree both find zero ──
  ok(`the producer scan really read the tree (${producerFiles.length} files under lib/ + app/,\n    ${aliasOfComposition.size} composition-id constants resolved)`,
    producerFiles.length >= 500 && aliasOfComposition.size >= 5)
  ok("the props finder recognises a staging site, by literal AND by constant",
    compositionsNamedIn(`const r = { composition_id: "TestimonialReel", input_props: p }`).has("TestimonialReel")
    && STAGES_RENDER.test(`const r = { composition_id: "TestimonialReel", input_props: p }`)
    && compositionsNamedIn(`const X = "CMAReel"\ninsert({ composition_id: X, input_props: p })`).has("CMAReel"))
  ok("...and does NOT fire on a COMMENT naming a composition, nor on a file that\n    names one without staging anything",
    !compositionsNamedIn(stripComments(`// stages "TestimonialReel" input_props one day`)).has("TestimonialReel")
    && !STAGES_RENDER.test(stripComments(`const id = "TestimonialReel"`)))
  ok("...and it found the producers this pass was written over — the five entries\n    that used to read \"no producer writes input_props\" all have one",
    ["AffordabilitySnapshotReel", "TestimonialReel", "NeighborhoodSpotlightReel", "PhotoWalkthroughReel", "JustListedReelHorizontal"]
      .every((id) => propsStagers[id].length > 0),
    ["AffordabilitySnapshotReel", "TestimonialReel", "NeighborhoodSpotlightReel", "PhotoWalkthroughReel", "JustListedReelHorizontal"]
      .filter((id) => propsStagers[id].length === 0).join(", "))
  // THE OTHER DIRECTION, and it is the control the classification rests on: a
  // composition NOTHING stages must come back EMPTY. ListingPresentationSlide is
  // that composition today (adjudicated in remotion/Root.tsx beside its
  // registration) — registered, geometry-mirrored, contract-classified, and
  // reachable only through the manual/agent start_render path. Derived, not
  // pinned: whichever registered compositions have no props producer are listed.
  const unstaged = Object.keys(REGISTRY).filter((id) => propsStagers[id].length === 0).sort()
  ok(`the finder can still say NO — ${unstaged.length} registered composition(s) have no\n    props producer at all: ${unstaged.join(", ") || "none"}`,
    unstaged.length > 0 && !propsStagers.NoSuchCompositionAtAll)

  // ── (b) THE NARRATION SET, DERIVED BY RUNNING THE CONTRACT ────────────────
  // The promo event vocabulary is the LIVE CHECK on listing_promo_videos.event_type,
  // not a list retyped here — a new event type that routes to a fifth composition
  // therefore moves this set on its own (§2: assert the rule, derive the number).
  const promoEventTypes = CHECK_VOCABULARIES.listing_promo_videos?.event_type ?? []
  ok(`the promo event vocabulary came from the live CHECK cache (${promoEventTypes.length} event types)`,
    promoEventTypes.length >= 6)
  const promoBudgets = promoEventTypes.map((e) => ({ eventType: e, budget: promoNarrationBudget(e) }))
  // The newsletter route's composition is read from the route's OWN constant, so
  // a rename there moves this rather than leaving the guard asserting a ghost.
  const newsletterRoute = "app/api/internal/remotion/render-newsletter-video/route.ts"
  const newsletterComposition = stripComments(readFileSync(newsletterRoute, "utf8"))
    .match(/\bconst\s+NEWSLETTER_VIDEO_COMPOSITION\s*=\s*["']([A-Za-z0-9_]+)["']/)?.[1]
  ok(`the newsletter producer names its own composition (${newsletterComposition ?? "NOT FOUND"}) and it is registered`,
    !!newsletterComposition && !!REGISTRY[newsletterComposition])
  const newsletterBudget = narrationBudget(newsletterComposition ?? "", compositionSeconds(REGISTRY[newsletterComposition ?? ""] ?? { duration_frames: 0, fps: 30 }))
  const sectionBudget = sectionNarrationBudget()

  // ── THE CENSUS, as a checked fact ─────────────────────────────────────────
  // Every composition rendering the camel key, and what produces its script.
  // A composition that appears in Root.tsx and in neither list fails below —
  // "nobody classified this one" must not read as "this one is fine".
  const narrationStaged = new Set<string>([
    ...promoBudgets.map((p) => p.budget.compositionId),
    newsletterBudget.compositionId,
    sectionBudget.compositionId,
  ])
  /** Which producer sizes this composition's script. Display only: the KEY SET
   *  is asserted against `narrationStaged` below, so it cannot drift into a
   *  second classification. */
  const PRODUCED: Record<string, string> = {
    // composition            → the producer that writes its narration
    JustListedReel:           "app/api/internal/remotion/render-just-listed/route.ts draftAndClearScript",
    JustSoldReelSquare:       "app/api/internal/remotion/render-just-listed/route.ts draftAndClearScript",
    OpenHouseAnnounceReel:    "app/api/internal/remotion/render-just-listed/route.ts draftAndClearScript",
    ComingSoonReel:           "app/api/internal/remotion/render-just-listed/route.ts draftAndClearScript",
    NewsletterDigestVideo:    "app/api/internal/remotion/render-newsletter-video/route.ts draft()",
    ListingSectionReel:       "lib/listing-presentation/section-narration.ts generateSectionNarration",
  }
  ok(`the PRODUCED table is the DERIVED narration set, not a second opinion (${narrationStaged.size})`,
    JSON.stringify(Object.keys(PRODUCED).sort()) === JSON.stringify([...narrationStaged].sort()),
    `derived-only: ${[...narrationStaged].filter((i) => !PRODUCED[i]).join(", ") || "none"} | `
    + `table-only: ${Object.keys(PRODUCED).filter((i) => !narrationStaged.has(i)).join(", ") || "none"}`)

  /** Extra colour on a composition NOBODY sizes a script for — the part that is
   *  genuinely not derivable. NEVER the classification (that is derived above)
   *  and never a claim about input_props: the props column is printed from the
   *  scan, and the assertion below refuses any note that contradicts it. */
  const NO_PRODUCER_NOTE: Record<string, string> = {
    CMAReel:                   "enqueueCmaReelRender takes voiceoverUrl; its only live caller (section-render.ts:179) passes null",
    AgentTalkingHeadReel:      "buildIntroCompositionRequest sets no voiceover_url — the D-ID avatar track carries its own audio",
    JustListedReelSquare:      "the Director's PAID cut; the organic render path routes just_listed to JustListedReel",
    PhotoWalkthroughReel:      "the Director commissions the visual (photo_walkthrough → kenBurnsPlan); the photos ARE the video, so no script is sized",
    AffordabilitySnapshotReel: "buyer-match-reel-producer stages the facts; the reel speaks on-screen copy, not a generated script",
    NeighborhoodSpotlightReel: "the Director commissions it; the narration would have to come from a producer that does not exist yet",
    TestimonialReel:           "the Director commissions it; the CLIENT's own clip carries the audio, so no script is sized",
    JustListedReelHorizontal:  "the Director's 16:9 YouTube/Facebook cut; the organic promo path never routes here",
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
  const noLiveProducer = declaring.filter((id) => !narrationStaged.has(id)).sort()
  const classified = [...Object.keys(PRODUCED), ...Object.keys(NO_PRODUCER_NOTE)].sort()
  ok(`the camel-key census covers every composition that renders voiceoverUrl (${declaring.length})`,
    JSON.stringify(declaring) === JSON.stringify(classified),
    `unclassified: ${declaring.filter((d) => !classified.includes(d)).join(", ") || "none"} | `
    + `stale: ${classified.filter((c) => !declaring.includes(c)).join(", ") || "none"}`)
  ok("...and the census finder really read the tree (not zero files)",
    compFiles.length >= 33 && declaring.length >= 10)
  ok(`...and the NO-LIVE-PRODUCER half is DERIVED (declares the prop, no producer\n    sizes a script): ${noLiveProducer.length} of ${declaring.length}`,
    JSON.stringify(noLiveProducer) === JSON.stringify(Object.keys(NO_PRODUCER_NOTE).sort()),
    `derived-only: ${noLiveProducer.filter((i) => !NO_PRODUCER_NOTE[i]).join(", ") || "none"} | `
    + `note-only: ${Object.keys(NO_PRODUCER_NOTE).filter((i) => !noLiveProducer.includes(i)).join(", ") || "none"}`)

  // ── THE EVIDENCE, PRINTED — and no note may contradict it ─────────────────
  console.log("    composition                no narration script sized; input_props staged by")
  for (const id of noLiveProducer) {
    console.log(`    ${id.padEnd(26)} ${propsStagers[id].length ? propsStagers[id].join(", ") : "NOBODY"}`)
    console.log(`    ${" ".repeat(26)} note: ${NO_PRODUCER_NOTE[id] ?? "(none)"}`)
  }
  // THE ASSERTION THIS WHOLE PASS EXISTS FOR. A note may not claim an absence
  // the scan contradicts — that is the exact sentence five entries carried.
  const CLAIMS_NO_PRODUCER = /\bno\s+producer\b|\bnothing\s+(?:writes|stages)\b|\bno\s+(?:one|body)\s+(?:writes|stages)\b/i
  const contradicted = noLiveProducer.filter(
    (id) => CLAIMS_NO_PRODUCER.test(NO_PRODUCER_NOTE[id] ?? "") && propsStagers[id].length > 0)
  ok("the contradiction finder recognises the sentence it was written for",
    CLAIMS_NO_PRODUCER.test("no producer writes input_props for this composition")
    && !CLAIMS_NO_PRODUCER.test("the Director's PAID cut; the organic render path routes elsewhere"))
  ok("no note claims an absence the props scan contradicts — a composition WITH a\n    props producer may never be described as having none (§2: the number cannot\n    protect the sentence beside it)",
    contradicted.length === 0,
    contradicted.map((id) => `${id}: "${NO_PRODUCER_NOTE[id]}" vs ${propsStagers[id].join(", ")}`).join(" | "))

  // The D-ID handoff appears beside every camel-key composition in the props
  // column. It is NOT a narration producer, and that is DERIVED rather than
  // asserted: it calls none of the narration-contract functions, so it cannot be
  // sizing a script — it forwards provider_metadata.voiceover_url unchanged.
  {
    const didHandoff = stripComments(readFileSync("lib/video/avatar-render-orchestrator.ts", "utf8"))
    const sizesAScript = /\b(narrationBudget|promoNarrationBudget|sectionNarrationBudget|narrationLengthDirective|fitNarrationToBudget|narrationMaxTokens)\s*\(/
    ok("the D-ID handoff FORWARDS a voiceover it never sizes — it calls no narration\n    contract function, so its name in the props column is not a narration producer",
      !sizesAScript.test(didHandoff) && /\bvoiceoverUrl\s*:/.test(didHandoff))
    ok("...and that finder would notice one that DOES size a script (control: the\n    section producer)",
      sizesAScript.test(stripComments(readFileSync("lib/listing-presentation/section-narration.ts", "utf8"))))
  }

  // ── EVERY PRODUCED COMPOSITION'S BUDGET FITS IT ───────────────────────────
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
