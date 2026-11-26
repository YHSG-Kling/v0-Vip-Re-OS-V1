#!/usr/bin/env tsx
/**
 * scripts/type-check-coverage-guard.ts   (npm run test:type-check-coverage)
 * ────────────────────────────────────────────────────────────────────────────
 * THE TYPE-CHECK IS TWO PROGRAMS, AND TOGETHER THEY CHECK EVERYTHING ONE DID.
 *
 * `npm run type-check` used to be ONE program over the whole repository. It grew to 14,021 files and a
 * 13.18 GB peak on a 15 GiB runner (measured 2026-11-20, wave 155) — about 1.2 GB under the last heap cap the
 * runner can take. It is now two programs run one after the other, never in parallel:
 *
 *   tsconfig.app.json      every root the whole program had EXCEPT those under scripts/   (12,632 files, 11.47 GB peak)
 *   tsconfig.scripts.json  the roots under scripts/ and whatever they import              ( 9,607 files,  8.03 GB peak)
 *
 * The peak is the larger of the two, not their sum: 11.47 GB, 1.71 GB lower, for 45 s more wall-clock.
 * Measured the same day, alone on the box: both programs 0 errors, and the first-party files they load —
 * 5,441 and 3,465, 2,135 shared — are together exactly the 6,771 the whole program loads (0 missing, 0 extra).
 *
 * A split like this is only safe while it stays a PARTITION. This guard holds the three things that make it one,
 * derived from the configuration files with the compiler's own glob rules (ts.parseJsonConfigFileContent — the
 * root file names, no program is built, so it is light enough for the chain):
 *
 *   1. ROOTS: every root file of tsconfig.json is a root of the app program or of the scripts program.
 *      A root is where a file's errors are guaranteed to be reported; a file reached only by import is checked
 *      too, but only while something imports it. If every whole-program root is a root somewhere, every file the
 *      whole program loaded is loaded by one of the two (the measurement above is that statement, executed).
 *   2. OPTIONS: neither program overrides a compiler option. Same strictness, same module resolution, same paths.
 *   3. THE COMMAND: `type-check` runs BOTH, joined by `&&` (sequential — two 11 GB and 8 GB programs side by side
 *      would not fit), and the guard chain still starts with it. The scripts program is a required check, not an
 *      optional one that can be dropped to save time.
 *
 * BLIND SPOT, stated: this does not re-measure memory, and it does not build the programs — a file that only an
 * UNLISTED root would have imported cannot exist while rule 1 holds, but the guard proves rule 1, not the import
 * graph. The whole-program file list is one command away: `npx tsc --noEmit --listFilesOnly` (4.6 GB, 26 s).
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import ts from "typescript"

const ROOT = process.cwd()
let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`) } else { failed++; console.log(`  ✗ ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`) }
}

interface RawConfig { extends?: string; compilerOptions?: Record<string, unknown>; include?: string[]; exclude?: string[]; files?: string[] }

/** The root files of a configuration, by the compiler's own rules. `raw` lets a control hand in a mutated configuration. */
function rootsOf(configPath: string, raw?: RawConfig): Set<string> {
  const abs = join(ROOT, configPath)
  const json = raw ?? (ts.readConfigFile(abs, ts.sys.readFile).config as RawConfig)
  const parsed = ts.parseJsonConfigFileContent(json, ts.sys, dirname(abs), undefined, abs)
  return new Set(parsed.fileNames.map((f) => relative(ROOT, f).split("\\").join("/")))
}
const rawOf = (configPath: string): RawConfig => ts.readConfigFile(join(ROOT, configPath), ts.sys.readFile).config as RawConfig

/** Whole-program roots that are a root of neither program. Empty = the two programs partition the roots. */
function uncovered(whole: Set<string>, ...programs: Array<Set<string>>): string[] {
  return [...whole].filter((f) => !programs.some((p) => p.has(f))).sort()
}
/** The compiler options a derived configuration overrides (its own `compilerOptions`, not the ones it inherits). */
const overriddenOptions = (raw: RawConfig): string[] => Object.keys(raw.compilerOptions ?? {})
/** Does the command run both programs, one after the other? */
function runsBothInSequence(command: string): boolean {
  const steps = command.split("&&").map((s) => s.trim())
  const app = steps.findIndex((s) => /\btsc\b/.test(s) && /-p\s+tsconfig\.app\.json\b/.test(s) && /--noEmit\b/.test(s))
  const scr = steps.findIndex((s) => /\btsc\b/.test(s) && /-p\s+tsconfig\.scripts\.json\b/.test(s) && /--noEmit\b/.test(s))
  // `&` alone (background), `;` (runs the second even when the first failed) and `|` are not a sequence that stops on failure
  return app >= 0 && scr >= 0 && app !== scr && !/[^&]&[^&]|;|\|/.test(command)
}

console.log("\n[1 · the three configurations exist and derive from the one base]")
for (const f of ["tsconfig.json", "tsconfig.app.json", "tsconfig.scripts.json"]) check(`${f} exists`, existsSync(join(ROOT, f)))
const baseRaw = rawOf("tsconfig.json"), appRaw = rawOf("tsconfig.app.json"), scriptsRaw = rawOf("tsconfig.scripts.json")
check("both programs extend ./tsconfig.json", appRaw.extends === "./tsconfig.json" && scriptsRaw.extends === "./tsconfig.json", { app: appRaw.extends, scripts: scriptsRaw.extends })
check("neither program overrides a compiler option (same strictness, resolution and paths as the whole program)",
  overriddenOptions(appRaw).length === 0 && overriddenOptions(scriptsRaw).length === 0, { app: overriddenOptions(appRaw), scripts: overriddenOptions(scriptsRaw) })
check("neither program names a `files` list (roots come from include / exclude only)", !appRaw.files && !scriptsRaw.files)

console.log("\n[2 · the roots are a partition of the whole program's roots]")
const whole = rootsOf("tsconfig.json"), app = rootsOf("tsconfig.app.json"), scripts = rootsOf("tsconfig.scripts.json")
const missing = uncovered(whole, app, scripts)
check(`every root of the whole program is a root of one of the two (${whole.size} roots = ${app.size} app + ${scripts.size} scripts − ${[...app].filter((f) => scripts.has(f)).length} shared)`, missing.length === 0, missing.slice(0, 8))
const extra = [...app, ...scripts].filter((f) => !whole.has(f))
check("neither program has a root the whole program did not have (nothing new is checked under a different rule)", extra.length === 0, extra.slice(0, 8))
check("the whole program is not empty and scripts/ is a real share of it (the finder can see files)", whole.size > 5000 && scripts.size > 1000 && app.size > 4000, { whole: whole.size, app: app.size, scripts: scripts.size })
const scriptRootsInApp = [...app].filter((f) => f.startsWith("scripts/"))
check("the app program has no root under scripts/ (that is the split; a script the app imports is still loaded by import)", scriptRootsInApp.length === 0, scriptRootsInApp.slice(0, 5))
const nonScriptRootsMissingFromApp = [...whole].filter((f) => !f.startsWith("scripts/") && !app.has(f))
check("every root outside scripts/ is an app-program root", nonScriptRootsMissingFromApp.length === 0, nonScriptRootsMissingFromApp.slice(0, 8))
const scriptRootsMissing = [...whole].filter((f) => f.startsWith("scripts/") && !scripts.has(f))
check("every root under scripts/ is a scripts-program root", scriptRootsMissing.length === 0, scriptRootsMissing.slice(0, 8))

console.log("\n[3 · controls — the finder recognizes each way the partition can break]")
{
  const appDropsLib = rootsOf("tsconfig.app.json", { ...appRaw, exclude: [...(appRaw.exclude ?? []), "lib"] })
  const lost = uncovered(whole, appDropsLib, scripts)
  check(`POSITIVE CONTROL: an app program that also excludes lib/ leaves roots unchecked (${lost.length} found)`, lost.length > 100 && lost.every((f) => f.startsWith("lib/")), lost.slice(0, 3))
  const scriptsNarrowed = rootsOf("tsconfig.scripts.json", { ...scriptsRaw, include: ["scripts/generate-*.ts"] })
  const lostScripts = uncovered(whole, app, scriptsNarrowed)
  check(`POSITIVE CONTROL: a scripts program narrowed to one glob leaves script roots unchecked (${lostScripts.length} found)`, lostScripts.length > 1000 && lostScripts.every((f) => f.startsWith("scripts/")))
  check("POSITIVE CONTROL: a compiler-option override is seen", overriddenOptions({ extends: "./tsconfig.json", compilerOptions: { strict: false } }).join() === "strict")
  check("NEGATIVE CONTROL: the real pair leaves nothing unchecked", missing.length === 0)
}

console.log("\n[4 · the command runs both, in sequence, and the chain starts with it]")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
const typeCheck = pkg.scripts["type-check"] ?? ""
check("`type-check` runs the app program and then the scripts program, joined by && (never in parallel, never optional)", runsBothInSequence(typeCheck), typeCheck)
check("the guard chain still starts with `npm run type-check`", /^npm run type-check\s*&&/.test(pkg.scripts.guard ?? ""))
check("POSITIVE CONTROL: a command that drops the scripts program is refused", !runsBothInSequence("tsc --noEmit -p tsconfig.app.json"))
check("POSITIVE CONTROL: a command that runs the two in parallel is refused", !runsBothInSequence("tsc --noEmit -p tsconfig.app.json & tsc --noEmit -p tsconfig.scripts.json"))
check("POSITIVE CONTROL: a command that runs the second even when the first failed is refused", !runsBothInSequence("tsc --noEmit -p tsconfig.app.json; tsc --noEmit -p tsconfig.scripts.json"))
check("POSITIVE CONTROL: the old single-program command is refused", !runsBothInSequence("tsc --noEmit"))
check("NEGATIVE CONTROL: the two-program sequence is accepted", runsBothInSequence("tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.scripts.json"))
check("the base configuration still names the whole tree (the build and editors read it; the split lives in the two derived files)",
  (baseRaw.include ?? []).includes("**/*.ts") && (baseRaw.include ?? []).includes("**/*.tsx") && !(baseRaw.exclude ?? []).includes("scripts"))

console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log("❌ TYPE_CHECK_COVERAGE_FAIL"); process.exit(1) }
console.log("✅ TYPE_CHECK_COVERAGE_PASS — the app program and the scripts program together have every root the whole program had, under the same compiler options, run one after the other")
