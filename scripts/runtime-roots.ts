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

/** Every runtime .ts/.tsx file in the repo. */
export function runtimeFiles(cwd = "."): string[] {
  return runtimeRoots(cwd).flatMap((r) => walkTs(join(cwd, r)))
}
