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
// ── AND FROM THE RENDERER THAT TURNS THAT SOURCE INTO PIXELS (2026-09-02) ───
//
// The source hash was still only HALF of "the code that produced these frames".
// The bump from remotion 4.0.473 → 4.0.520 changed nothing under remotion/ and
// nothing in the env, so every artifact rendered under 4.0.473 stayed reusable
// and was served under 4.0.520 with no re-render, while probeRenderCache
// reported a healthy hit. A behaviour change with no type-surface footprint —
// encoder defaults, font rasterisation, the mediabunny decode path,
// interpolate()'s own arithmetic — is exactly what this cache exists to
// invalidate on, and it could not see one.
//
// So the INSTALLED VERSIONS of the packages that execute the source are folded
// into the revision beside the source hash. They are READ from each package's
// own package.json (never a literal typed here — that would be a waypoint pin
// that lies after the next bump). The frame key therefore moves when the source
// moves OR when the renderer moves, and never otherwise.
//
// AND IT CAN SAY "I DON'T KNOW". resolveCodeRevision returns null when it
// cannot establish the revision, and a null revision DISABLES CACHING rather
// than falling back to a constant. Rendering something we could have reused is
// a wasted minute; serving a stale cut of a listing video to a client is not
// recoverable. The conservative branch is the one that costs money.
//
// THE ENV FALLBACK, and why it survives the package half: when EITHER half of
// the derived revision is unreadable (no remotion/ tree, or a runtime where the
// package manifests cannot be resolved), we fall back to the deploy identity
// (VERCEL_GIT_COMMIT_SHA, then VERCEL_DEPLOYMENT_ID) and to null after that. A
// deploy sha is a SUPERSET proxy: it moves on every deploy, and a package bump
// is a commit, so the fallback is never less conservative than the derived key
// — it only discards more. A source hash WITHOUT a package version is never
// emitted: that would be the exact version-blind key this pass retires.

// NOT marked `server-only` on purpose: test:render-cache imports this to prove
// both branches (a real source tree resolves; an unreadable one returns null and
// disables the cache), and the marker throws outside a server component. It is
// still server-only in effect — it imports node:fs, which no client bundle can
// resolve. Do not add the marker back without moving the proof to a subprocess.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { hashSourceFiles } from "./composition-cache"

/** Extensions that can change what a composition renders. */
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".css"])

/**
 * The packages whose installed VERSION is part of frame identity.
 *
 *   remotion            — interpolate(), <Sequence>, <Img>, the runtime every
 *                         composition executes inside
 *   @remotion/media     — <Video>/<Audio>: the decode path (mediabunny) that
 *                         puts b-roll and narration pixels/samples on screen
 *   @remotion/renderer  — Chromium orchestration + the ffmpeg encode defaults
 *                         that turn frames into the file we cache
 *
 * Order matters only for the divergent-version spelling below; keep it stable.
 */
export const REVISION_PACKAGES = ["remotion", "@remotion/media", "@remotion/renderer"] as const
export type RevisionPackage = (typeof REVISION_PACKAGES)[number]

/** undefined = not yet computed; null = computed and unknowable. */
let memo: string | null | undefined

/**
 * The identity of the deployed composition code, or null if it cannot be known.
 *
 * Memoized for the process lifetime: composition source cannot change under a
 * running server, and walking the tree on every render would be a needless
 * filesystem hit on a hot path.
 *
 * `opts.readVersions` is a TEST SEAM (like __resetCodeRevisionMemo): the proof
 * uses it to show that a readable tree with unreadable packages falls to the
 * env proxy and never to a version-blind key. Production callers pass nothing.
 */
export function resolveCodeRevision(
  root: string = process.cwd(),
  opts: { readVersions?: (root: string) => Record<RevisionPackage, string> | null } = {},
): string | null {
  if (memo !== undefined) return memo
  memo = fromSource(root, opts.readVersions ?? readInstalledPackageVersions) ?? fromEnv() ?? null
  return memo
}

/** Test seam — lets a proof exercise both branches without a real deploy. */
export function __resetCodeRevisionMemo(): void {
  memo = undefined
}

/**
 * PURE: the revision string from its two halves.
 *
 * `src_<hash of remotion/**>_rm<installed versions>`. When the three packages
 * agree (the normal, pinned-together state) the token is the one version, so a
 * human reading a ledger row sees `rm4.0.520` and knows which renderer made it.
 * When they diverge every version is spelled, in REVISION_PACKAGES order, so a
 * half-applied bump cannot collapse onto the fully-applied one.
 */
export function composeCodeRevision(
  sourceHash: string,
  versions: Readonly<Record<RevisionPackage, string>>,
): string {
  const ordered = REVISION_PACKAGES.map((p) => versions[p])
  const token = new Set(ordered).size === 1
    ? ordered[0]
    : REVISION_PACKAGES.map((p, i) => `${p.replace(/^@remotion\//, "")}@${ordered[i]}`).join("+")
  return `src_${sourceHash}_rm${token}`
}

/**
 * The installed version of each REVISION_PACKAGES entry, read from its own
 * package.json, or null when ANY of them cannot be resolved from `root`.
 *
 * All-or-nothing on purpose: a key built from two of three versions would look
 * complete and be blind to the third.
 */
export function readInstalledPackageVersions(root: string): Record<RevisionPackage, string> | null {
  try {
    const req = createRequire(path.join(root, "package.json"))
    const out = {} as Record<RevisionPackage, string>
    for (const p of REVISION_PACKAGES) {
      const v = (req(`${p}/package.json`) as { version?: unknown }).version
      if (typeof v !== "string" || v.length === 0) return null
      out[p] = v
    }
    return out
  } catch {
    return null
  }
}

function fromSource(
  root: string,
  readVersions: (root: string) => Record<RevisionPackage, string> | null,
): string | null {
  try {
    const dir = path.join(root, "remotion")
    const files: Array<{ path: string; content: string }> = []
    collect(dir, dir, files, 0)
    if (files.length === 0) return null
    const versions = readVersions(root)
    // The package half is unknowable: fall through to the deploy proxy (see the
    // header). NEVER emit a source-only key — that is the version-blind key.
    if (!versions) return null
    return composeCodeRevision(hashSourceFiles(files), versions)
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
