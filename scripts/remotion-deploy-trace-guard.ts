#!/usr/bin/env tsx
/**
 * scripts/remotion-deploy-trace-guard.ts   (npm run test:remotion-deploy-trace — pure, no DB, no network, no build)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 153, LANE 153J — A RENDER FUNCTION MUST SHIP WHAT ITS RUNTIME BUNDLE READS.
 *
 * The render routes call getBundle (lib/remotion/bundle-cache.ts) → @remotion/bundler INSIDE the function, against
 * remotion/index.ts. Webpack then reads every composition file, the pure lib modules they import and the
 * composition-only packages FROM THE FUNCTION'S DISK, and the renderer spawns the compositor's native binaries. None
 * of that is an import Next's file tracer can follow: MEASURED with Next's own @vercel/nft (the options
 * collect-build-traces.js passes) over the route's runtime references, the trace held remotion/index.ts and
 * remotion/Root.tsx and NOTHING else first-party (72 of 74 bundle-graph files absent), none of
 * @remotion/{media,motion-blur,google-fonts}, and only index.js + package.json of @remotion/compositor-linux-x64-gnu
 * (its `remotion`, `ffmpeg`, `ffprobe` and lib*.so binaries are located by computed path). A FUNCTION-FILESYSTEM
 * REPLAY (those traced files alone, copied into an empty root, then the real bundler + renderer run from there)
 * failed `Can't resolve '../lib/video/duration-model' in '<fnroot>/remotion'`; with the includes below it bundled,
 * then failed ENOENT on the compositor's ffmpeg; with the compositor included it rendered a playable MP4.
 * Nothing had noticed because nothing has been deployed: the live render table holds 0 rows.
 *
 * THE RULE (derived, never pinned): for every app route whose code reaches getBundle, next.config.ts
 * outputFileTracingIncludes — matched against the route path the way Next matches it (picomatch, contains) — must
 * cover (1) every first-party file reachable from remotion/index.ts, (2) the package.json and ESM entry of every bare
 * package that graph imports which @remotion/bundler / @remotion/renderer do not already pull in, and (3) every file
 * of the linux-x64-gnu compositor (the Vercel runtime). outputFileTracingExcludes must not remove any of them.
 *
 * Blind spots, printed below: in-process renders OUTSIDE app/**\/route.ts (the direct-mail postcard path, reached from
 * server actions, crons and workflow chains) are listed, not judged — route-keyed includes cannot follow a server
 * action into its page function; and function SIZE is not computed here (the replay measured it).
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import ts from "typescript"
import { blankComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const req = createRequire(import.meta.url)
const picomatch = req("next/dist/compiled/picomatch") as (g: string | string[], o?: object) => (s: string) => boolean

let passed = 0, failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n── ${s} ──`)
const read = (rel: string) => readFileSync(join(root, rel), "utf8")

/** Every import/export/require specifier in a file, by the TypeScript pre-processor (comments and strings handled). */
const specifiersOf = (src: string) => ts.preProcessFile(src, true, true).importedFiles.map((f) => f.fileName)
const IMPORTS_BUNDLE_CACHE = /["']@\/lib\/remotion\/bundle-cache["']|\bgetBundle\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p, out) }
    else out.push(p)
  }
  return out
}

/** The app routes (route.ts) whose own code reaches the runtime bundle. Route path the way Next normalizes it. */
function runtimeBundlingRoutes(): Array<{ file: string; route: string }> {
  return walk(join(root, "app")).filter((f) => /[\\/]route\.ts$/.test(f))
    .filter((f) => IMPORTS_BUNDLE_CACHE.test(blankComments(readFileSync(f, "utf8"))))
    .map((f) => {
      const rel = relative(root, f).replace(/\\/g, "/")
      const route = "/" + rel.replace(/^app\//, "").replace(/\/route\.ts$/, "").split("/").filter((seg) => !/^\(.*\)$/.test(seg)).join("/")
      return { file: rel, route }
    })
}

/** The first-party bundle graph from remotion/index.ts, plus the bare specifiers it uses. */
function bundleGraph() {
  const files = new Set<string>(), bare = new Set<string>()
  const queue = [join(root, "remotion/index.ts")]
  while (queue.length) {
    const f = queue.pop()!
    if (files.has(f)) continue
    files.add(f)
    for (const spec of specifiersOf(readFileSync(f, "utf8"))) {
      if (spec.startsWith(".")) {
        const base = join(dirname(f), spec)
        const hit = [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx"), base].find((c) => /\.(ts|tsx)$/.test(c) && existsSync(c))
        if (hit) queue.push(hit)
      } else bare.add(spec)
    }
  }
  return { files: [...files].map((f) => relative(root, f).replace(/\\/g, "/")).sort(), bare: [...bare].sort() }
}
const pkgOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0])

/** The file webpack loads for a bare specifier: package.json `exports` (import → module → default), else module/main. */
function esmEntryOf(spec: string): string | null {
  const pkg = pkgOf(spec)
  const dir = join(root, "node_modules", pkg)
  if (!existsSync(join(dir, "package.json"))) return null
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports?: Record<string, unknown>; module?: string; main?: string }
  const sub = "." + spec.slice(pkg.length) // "." or "./Inter"
  const pick = (v: unknown): string | null => typeof v === "string" ? v : v && typeof v === "object" ? pick((v as Record<string, unknown>).import ?? (v as Record<string, unknown>).module ?? (v as Record<string, unknown>).default) : null
  let target: string | null = null
  if (pj.exports) {
    if (pj.exports[sub] !== undefined) target = pick(pj.exports[sub])
    else for (const [k, v] of Object.entries(pj.exports)) {
      if (!k.includes("*")) continue
      const [pre, post] = k.split("*")
      if (sub.startsWith(pre) && sub.endsWith(post)) { const t = pick(v); if (t) target = t.replace("*", sub.slice(pre.length, sub.length - post.length || undefined)); break }
    }
  } else target = sub === "." ? (pj.module ?? pj.main ?? "index.js") : sub
  return target ? relative(root, join(dir, target)).replace(/\\/g, "/") : null
}

/** Packages @remotion/bundler and @remotion/renderer pull in themselves — nft traces those from the route's require(). */
function alreadyTraced(): Set<string> {
  const out = new Set<string>(["react-dom"])
  for (const p of ["@remotion/bundler", "@remotion/renderer"]) {
    const pj = JSON.parse(readFileSync(join(root, "node_modules", p, "package.json"), "utf8")) as { dependencies?: object; peerDependencies?: object }
    for (const d of [...Object.keys(pj.dependencies ?? {}), ...Object.keys(pj.peerDependencies ?? {})]) out.add(d)
  }
  return out
}

/** outputFileTracingIncludes / Excludes as written in next.config.ts, read through the TypeScript AST. */
function tracingConfig(src: string): { includes: Record<string, string[]>; excludes: Record<string, string[]> } {
  const sf = ts.createSourceFile("next.config.ts", src, ts.ScriptTarget.Latest, true)
  const out = { includes: {} as Record<string, string[]>, excludes: {} as Record<string, string[]> }
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && /^outputFileTracing(Includes|Excludes)$/.test(n.name.text) && ts.isObjectLiteralExpression(n.initializer)) {
      const into = n.name.text.endsWith("Includes") ? out.includes : out.excludes
      for (const p of n.initializer.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isArrayLiteralExpression(p.initializer)) continue
        const key = ts.isStringLiteral(p.name) || ts.isIdentifier(p.name) ? p.name.text : null
        if (key) into[key] = p.initializer.elements.filter(ts.isStringLiteralLike).map((e) => e.text)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** What a route actually gets, the way collect-build-traces.js combines keys (picomatch dot + contains on the route). */
function globsFor(route: string, map: Record<string, string[]>): string[] {
  return Object.entries(map).filter(([k]) => picomatch(k, { dot: true, contains: true })(route)).flatMap(([, v]) => v.map((g) => g.replace(/^\.\//, "")))
}
function uncovered(required: string[], includeGlobs: string[], excludeGlobs: string[]): string[] {
  const inc = includeGlobs.length ? picomatch(includeGlobs, { dot: true }) : () => false
  const exc = excludeGlobs.length ? picomatch(excludeGlobs, { dot: true }) : () => false
  return required.filter((f) => !inc(f) || exc(f))
}

const BUILTINS = new Set(req("node:module").builtinModules as string[])
/**
 * Everything webpack reads for one bare specifier the bundler/renderer do not already pull in: the package.json, the ESM
 * entry, every file that entry reaches by RELATIVE import inside the package, and — recursively — the same for each bare
 * dependency it imports (@remotion/media → mediabunny, @mediabunny/prores). A lower bound: an include that names only the
 * entry file would pass a shallower check and still fail at bundle time on the entry's own imports.
 */
function packageClosure(spec: string, traced: Set<string>, seen: Set<string>, out: Set<string>, unresolved: string[]) {
  const pkg = pkgOf(spec.replace(/^node:/, ""))
  if (traced.has(pkg) || BUILTINS.has(pkg) || spec.startsWith("node:")) return
  const entry = esmEntryOf(spec)
  if (!entry || !existsSync(join(root, entry))) { unresolved.push(spec); return }
  out.add(`node_modules/${pkg}/package.json`)
  const queue = [entry]
  while (queue.length) {
    const f = queue.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    out.add(f)
    for (const s of specifiersOf(readFileSync(join(root, f), "utf8"))) {
      if (s.startsWith(".")) {
        const base = join(root, dirname(f), s)
        const hit = [base, base + ".mjs", base + ".js", join(base, "index.mjs"), join(base, "index.js")].find((c) => existsSync(c) && statSync(c).isFile())
        if (hit) queue.push(relative(root, hit).replace(/\\/g, "/"))
      } else packageClosure(s, traced, seen, out, unresolved)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section("derivation — which routes bundle at runtime, and what the bundle reads from disk")
const routes = runtimeBundlingRoutes()
const graph = bundleGraph()
const traced = alreadyTraced()
const compositionOnly = [...new Set(graph.bare.filter((s) => !traced.has(pkgOf(s))))]
const compositor = "node_modules/@remotion/compositor-linux-x64-gnu"
const compositorFiles = existsSync(join(root, compositor)) ? readdirSync(join(root, compositor)).filter((f) => statSync(join(root, compositor, f)).isFile()).map((f) => `${compositor}/${f}`) : []
const closure = new Set<string>(), unresolvedSpecs: string[] = []
for (const s of compositionOnly) packageClosure(s, traced, new Set(), closure, unresolvedSpecs)
const pkgFiles = [...closure].sort()
const closurePkgs = [...new Set(pkgFiles.map((f) => pkgOf(f.replace(/^node_modules\//, ""))))]
const required = [...new Set([...graph.files, ...pkgFiles, ...compositorFiles])]
console.log(`  routes that bundle at runtime: ${routes.map((r) => r.route).join(", ") || "none"}`)
console.log(`  bundle graph: ${graph.files.length} first-party files (remotion/ ${graph.files.filter((f) => f.startsWith("remotion/")).length}, lib/ ${graph.files.filter((f) => f.startsWith("lib/")).length}); bare: ${graph.bare.join(" ")}`)
console.log(`  composition-only specifiers (not pulled in by the bundler/renderer): ${compositionOnly.join(" ") || "none"} → closure over ${closurePkgs.join(" ")}: ${pkgFiles.length} file(s); compositor binaries: ${compositorFiles.length}`)
check("every package in the closure resolves to an installed ESM entry (nothing silently dropped)", unresolvedSpecs.length === 0, unresolvedSpecs.join(", "))
console.log(`  closure depth: ${compositionOnly.length} specifier(s) → ${closurePkgs.length} package(s) once their own dependencies are followed`)
check("the route finder sees the render routes (the specimen: the generic render-composition endpoint)", routes.some((r) => r.route === "/api/internal/remotion/render-composition"))
check("CONTROL: the finder recognizes the import shape and ignores it inside a comment", IMPORTS_BUNDLE_CACHE.test(`import { getBundle } from "@/lib/remotion/bundle-cache"`) && !IMPORTS_BUNDLE_CACHE.test(blankComments(`// was: import { getBundle } from "@/lib/remotion/bundle-cache"\nexport const x = 1`)))
check("the graph walker reaches past Root.tsx into the compositions and lib/ (what nft does NOT follow)", graph.files.includes("remotion/Root.tsx") && graph.files.some((f) => f.startsWith("lib/")) && graph.files.filter((f) => f.startsWith("remotion/")).length > 2)
check("every composition-only specifier resolves to an installed ESM entry (none silently dropped)", compositionOnly.every((s) => { const e = esmEntryOf(s); return !!e && existsSync(join(root, e)) }), compositionOnly.map((s) => `${s} → ${esmEntryOf(s)}`).join("; "))
check("the linux-x64-gnu compositor is installed with its native binaries (the files a Vercel function spawns)", compositorFiles.some((f) => /\/remotion$/.test(f)) && compositorFiles.some((f) => /\/ffmpeg$/.test(f)))

// ═══════════════════════════════════════════════════════════════════════════
section("the rule — next.config.ts ships the graph to every runtime-bundling route")
const cfg = tracingConfig(blankComments(read("next.config.ts")))
for (const r of routes) {
  const miss = uncovered(required, globsFor(r.route, cfg.includes), globsFor(r.route, cfg.excludes))
  check(`${r.route}: all ${required.length} required files are traced (includes cover them, excludes spare them)`, miss.length === 0,
    `${miss.length} absent — e.g. ${miss.slice(0, 4).join(", ")} (lane 153J Outside-lane request R1: next.config.ts outputFileTracingIncludes)`)
}

// ═══════════════════════════════════════════════════════════════════════════
section("controls — the checker sees the defect it was written for")
check("CONTROL: with NO includes, every required file is reported absent", uncovered(required, [], []).length === required.length && required.length > 0)
check("CONTROL: a directory glob covers a composition but not a lib dir it does not name", uncovered(["remotion/X.tsx", "lib/new-dir/x.ts"], ["remotion/**/*.{ts,tsx}"], []).join() === "lib/new-dir/x.ts")
check("CONTROL: an exclude that removes a required file is reported even when an include names it", uncovered([`${compositor}/ffmpeg`], [`${compositor}/**/*`], [`${compositor}/ffmpeg`]).length === 1)
check("CONTROL: route keys match the way Next matches them (picomatch contains)", globsFor("/api/internal/remotion/render-composition", { "/api/internal/remotion/**": ["./a"] }).join() === "a" && globsFor("/api/cron/dispatch", { "/api/internal/remotion/**": ["./a"] }).length === 0)
check("CONTROL: the AST reader reads both maps and ignores a commented-out one", (() => {
  const c = tracingConfig(blankComments(`const n = { outputFileTracingIncludes: { "/x/**": ["./remotion/**/*"] }, outputFileTracingExcludes: { "/x/**": ["./y"] } }\n// outputFileTracingIncludes: { "/z": ["./q"] }`))
  return c.includes["/x/**"]?.[0] === "./remotion/**/*" && c.excludes["/x/**"]?.[0] === "./y" && !c.includes["/z"]
})())
check("CONTROL: the ESM entry resolver follows an exports pattern (\"./*\" → dist/esm/*.mjs) and a plain \".\"", esmEntryOf("@remotion/google-fonts/Inter")?.endsWith("@remotion/google-fonts/dist/esm/Inter.mjs") === true && !!esmEntryOf("remotion"))

// ═══════════════════════════════════════════════════════════════════════════
section("blind spots (listed, not judged)")
const inProcess = walk(join(root, "lib")).filter((f) => /\.tsx?$/.test(f) && IMPORTS_BUNDLE_CACHE.test(blankComments(readFileSync(f, "utf8")))).map((f) => relative(root, f).replace(/\\/g, "/")).filter((f) => f !== "lib/remotion/bundle-cache.ts")
console.log(`  · in-process renders outside app/**/route.ts (reached from server actions / crons / chains, so route-keyed includes cannot follow them): ${inProcess.join(", ") || "none"} — lane 153J Outside-lane request R2`)
console.log("  · function SIZE is not computed here: the lane-153J replay measured 214 MB for the traced set + includes, 153 MB with the musl variants excluded, before render-composition's 77 MB ffmpeg-static (Vercel's unzipped function limit is 250 MB)")

console.log(`\n Denominators: ${routes.length} runtime-bundling route(s); ${required.length} required files (${graph.files.length} first-party + ${pkgFiles.length} package + ${compositorFiles.length} compositor).`)
console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
