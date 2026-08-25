/**
 * scripts/runtime-roots.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH DIRECTORIES A GUARD MUST READ.
 *
 * Two separate guards independently hard-coded `["app", "lib"]` as their reach.
 * Ten top-level directories ship TypeScript, so both were blind to eight of them —
 * and a pair of live service methods querying a dropped table sat in `services/`
 * for as long as it took someone to read the file by hand.
 *
 * The reach is derived here instead, once: every top-level directory that contains
 * TypeScript and ships as runtime. A new directory is covered the moment it holds a
 * .ts file, without anyone remembering to add it to a list.
 *
 * THE SAME MISTAKE, ONE LEVEL UP — found 2026-08-25 by the opposite-missing census
 * accusing `PUBLIC_ROUTES` and `PROTECTED_ROUTES` of having no importer.
 *
 * They have one. It is `proxy.ts:38`, at the REPOSITORY ROOT — and every guard built
 * on this module was blind to it, because `runtimeFiles()` walked top-level
 * DIRECTORIES and root-level FILES are not directories. Two runtime files sat outside
 * the reach of all six consumers:
 *
 *   · proxy.ts   (296 lines) — the Next 16 edge middleware. The auth gate, the
 *     white-label custom-domain rewrite and the embed CSP allowlist all live in it,
 *     and it queries `tenant_custom_domains` with a SERVICE client. The single most
 *     security-relevant runtime file in the tree was in no guard's corpus.
 *   · types.ts   (1865 lines) — the root vocabulary module: `UserRole`,
 *     `PersonaType` and the rest.
 *
 * The failure shape is the one §2 of CLAUDE.md is about: a scan that cannot see a
 * file does not go quiet, it goes CONFIDENTLY WRONG in BOTH directions at once. It
 * misses every defect inside the invisible file, and it ACCUSES every export the
 * invisible file is the only consumer of. `PUBLIC_ROUTES` is both: an orphan finding
 * that was never true, sitting on the list that decides which paths need no session.
 *
 * So the rule is derived rather than listed here too: a root-level .ts/.tsx file
 * ships as runtime UNLESS it is a `*.config.ts` — toolchain configuration the build
 * or the test runner executes and the application never imports (next.config.ts,
 * playwright.config.ts, remotion.config.ts). A new root file is covered the moment
 * it appears, exactly like a new directory. Consumers that want the old
 * directories-only answer still have `runtimeRoots()`; `runtimeFiles()` is the
 * corpus and now means what its name says.
 */
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** Never descend into these, anywhere in the tree. */
export const NEVER_WALK = new Set(["node_modules", ".next", ".git", ".vercel"])

/**
 * Directories that hold TypeScript but do not ship as application runtime. Every
 * entry names why — this is the one list left, and it is the only remaining way a
 * guard's reach can be narrowed by accident.
 */
export const NON_RUNTIME_ROOTS = new Set([
  "scripts",  // guards, migrations and codemods — they name dropped tables on purpose
  "e2e",      // test harness, not served
  // Claude Code plugin/skill payloads. Skills ship specimen .tsx components —
  // DOCUMENTATION a skill shows an author — and nothing in the shipped tree
  // imports them. (The worked example used to be the three .tsx files under
  // plugins/ecc/skills/remotion-video-creation/rules/assets/; that skill was a
  // stale, renamed fork of the vendored Remotion skill and is gone — survivor
  // .claude/skills/remotion-best-practices, tombstone at
  // scripts/remotion-setup-guard.ts:27. Its specimens now live under that
  // survivor's remotion-maps/techniques/*/assets/, which is a DOT-directory and
  // so is already outside every census by the `startsWith(".")` test below.)
  // The authority is not a judgement call: tsconfig.json carries
  // `"exclude": ["node_modules", "plugins"]`, so the build never compiles them.
  //
  // This module is the answer to "what ships", so it disagreeing with the compiler
  // about what ships is the same defect it exists to prevent, pointed inward: every
  // consumer of runtimeFiles() was scanning skill documentation as if it were
  // application runtime, and any orphan census run over it would report specimen
  // exports as orphans that no one can ever wire. scripts/agent-orchestration-
  // simulator.ts had already worked this out privately and skipped `plugins` in its
  // own walker — one more thing the 82 copies each had to learn separately.
  "plugins",
])

/** Recursively collect .ts/.tsx under a directory. */
export function walkTs(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (NEVER_WALK.has(e)) continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walkTs(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

/** Every top-level directory that contains TypeScript and ships as runtime. */
export function runtimeRoots(cwd = "."): string[] {
  return readdirSync(cwd)
    .filter((name) => {
      if (name.startsWith(".")) return false   // .claude / .agents / .github — config, not runtime
      if (NEVER_WALK.has(name) || NON_RUNTIME_ROOTS.has(name)) return false
      let st
      try { st = statSync(join(cwd, name)) } catch { return false }
      if (!st.isDirectory()) return false
      return walkTs(join(cwd, name)).length > 0
    })
    .sort()
}

/**
 * Root-level .ts/.tsx files that are toolchain configuration rather than application
 * runtime. Derived, not listed: `*.config.ts` is executed by the build or the test
 * runner and imported by nothing the app serves. Everything else at the root ships.
 */
export function isRootConfigFile(name: string): boolean {
  return /\.config\.[cm]?tsx?$/.test(name)
}

/** Every runtime .ts/.tsx FILE sitting at the repository root (not in any directory). */
export function rootRuntimeFiles(cwd = "."): string[] {
  let entries: string[] = []
  try { entries = readdirSync(cwd) } catch { return [] }
  return entries
    .filter((name) => {
      if (name.startsWith(".")) return false
      if (!/\.(ts|tsx)$/.test(name)) return false
      if (isRootConfigFile(name)) return false
      let st
      try { st = statSync(join(cwd, name)) } catch { return false }
      return st.isFile()
    })
    .map((name) => join(cwd, name))
    .sort()
}

/** Every runtime .ts/.tsx file in the repo — top-level directories AND root files. */
export function runtimeFiles(cwd = "."): string[] {
  return [...runtimeRoots(cwd).flatMap((r) => walkTs(join(cwd, r))), ...rootRuntimeFiles(cwd)]
}
