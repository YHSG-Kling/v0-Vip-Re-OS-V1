// lib/remotion/code-revision.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHAT VERSION OF THE COMPOSITION CODE IS THIS?
//
// The cache is only safe if the key changes when the FRAMES would change. Props
// are half of that; the other half is the composition source itself — edit
// MarketUpdateReel.tsx and the same props render a different video.
//
// The first cut of this keyed on VERCEL_GIT_COMMIT_SHA. That was wrong twice
// over, and the owner caught it by asking the obvious question — what IS that
// value here?
//
//   · It is not guaranteed. Nothing in this repo sets, exposes, or verifies it.
//     On any runtime where it is absent the revision silently collapsed to
//     "dev" — permanently — and a composition edit would have served last
//     week's frames from cache. A cache that is wrong is worse than no cache,
//     and this one would have been wrong SILENTLY, which is the failure mode
//     this codebase keeps finding.
//   · Even when present it is a proxy, not the thing. It changes on every
//     deploy, including deploys that touched no composition, throwing away
//     every cached artifact for no reason.
//
// So the revision is now DERIVED FROM THE COMPOSITION SOURCE ITSELF. The render
// endpoint already reads `remotion/index.ts` off disk to bundle it, so the
// directory is present at runtime; we hash it. That changes exactly when
// composition code changes, and never otherwise.
//
// AND IT CAN SAY "I DON'T KNOW". resolveCodeRevision returns null when it
// cannot establish the revision, and a null revision DISABLES CACHING rather
// than falling back to a constant. Rendering something we could have reused is
// a wasted minute; serving a stale cut of a listing video to a client is not
// recoverable. The conservative branch is the one that costs money.

// NOT marked `server-only` on purpose: test:render-cache imports this to prove
// both branches (a real source tree resolves; an unreadable one returns null and
// disables the cache), and the marker throws outside a server component. It is
// still server-only in effect — it imports node:fs, which no client bundle can
// resolve. Do not add the marker back without moving the proof to a subprocess.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { hashSourceFiles } from "./composition-cache"

/** Extensions that can change what a composition renders. */
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".css"])

/** undefined = not yet computed; null = computed and unknowable. */
let memo: string | null | undefined

/**
 * The identity of the deployed composition code, or null if it cannot be known.
 *
 * Memoized for the process lifetime: composition source cannot change under a
 * running server, and walking the tree on every render would be a needless
 * filesystem hit on a hot path.
 */
export function resolveCodeRevision(root: string = process.cwd()): string | null {
  if (memo !== undefined) return memo
  memo = fromSource(root) ?? fromEnv() ?? null
  return memo
}

/** Test seam — lets a proof exercise both branches without a real deploy. */
export function __resetCodeRevisionMemo(): void {
  memo = undefined
}

function fromSource(root: string): string | null {
  try {
    const dir = path.join(root, "remotion")
    const files: Array<{ path: string; content: string }> = []
    collect(dir, dir, files, 0)
    if (files.length === 0) return null
    return `src_${hashSourceFiles(files)}`
  } catch {
    // The directory is unreadable in this runtime — fall through to the env
    // proxy, and to null if that is absent too.
    return null
  }
}

function collect(
  dir: string,
  base: string,
  out: Array<{ path: string; content: string }>,
  depth: number,
): void {
  if (depth > 6 || out.length > 500) return
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      collect(full, base, out, depth + 1)
      continue
    }
    if (!SOURCE_EXT.has(path.extname(entry))) continue
    // Relative path, POSIX-normalised, so the hash is identical on any host.
    out.push({
      path: path.relative(base, full).split(path.sep).join("/"),
      content: readFileSync(full, "utf8"),
    })
  }
}

function fromEnv(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  if (sha && sha.length >= 7) return `sha_${sha.slice(0, 12)}`
  const dep = process.env.VERCEL_DEPLOYMENT_ID
  if (dep) return `dep_${dep.slice(0, 12)}`
  return null
}
