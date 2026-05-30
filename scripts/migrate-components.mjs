/**
 * migrate-components.mjs
 *
 * Moves every component file that lives outside app/components/ into
 * app/components/ preserving a logical sub-folder hierarchy, then rewrites
 * all import/require statements across the entire codebase to use the new
 * @/app/components/... absolute alias paths.
 *
 * Rules:
 *  - Source files under app/<route>/components/<...> → app/components/<route>/<...>
 *  - app/(external-portal)/components/<...>         → app/components/external-portal/<...>
 *  - Files already in app/components/ are skipped
 *  - page.tsx / layout.tsx / loading.tsx / error.tsx / route.ts / route.tsx
 *    and any file not inside a "components" directory are never touched
 *  - All .ts/.tsx/.js/.jsx files across the project have their imports rewritten
 */

import fs from "fs"
import path from "path"
import { execSync } from "child_process"

const ROOT = "/vercel/share/v0-project"
const APP  = path.join(ROOT, "app")
const DEST = path.join(APP, "components")

// ─── 1. Collect all component files outside app/components/ ─────────────────

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, results)
    } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
      results.push(full)
    }
  }
  return results
}

const allAppFiles = walk(APP)

// Identify files that are:
//  a) inside a "components" directory (any depth)
//  b) NOT already under app/components/
const PAGE_NAMES = new Set(["page.tsx","layout.tsx","loading.tsx","error.tsx",
                             "not-found.tsx","route.ts","route.tsx",
                             "page.ts","layout.ts","loading.ts","error.ts"])

function isComponentFile(abs) {
  if (abs.startsWith(DEST + path.sep)) return false   // already in destination
  const rel = path.relative(APP, abs)                  // e.g. dashboard/listings/components/foo.tsx
  const parts = rel.split(path.sep)
  // Must have "components" somewhere in the path (not as the first segment because
  // app/components itself is the destination)
  const compIdx = parts.lastIndexOf("components")
  if (compIdx === -1) return false
  // Never move Next.js special files
  if (PAGE_NAMES.has(parts[parts.length - 1])) return false
  return true
}

const filesToMove = allAppFiles.filter(isComponentFile)
console.log(`Found ${filesToMove.length} component files to migrate.`)

// ─── 2. Build move map: source → destination ─────────────────────────────────

/** Strip (group) wrappers like (external-portal) → external-portal */
function stripGroupParens(segment) {
  return segment.replace(/^\((.+)\)$/, "$1")
}

/**
 * Given an absolute source path, compute the target path under app/components/.
 *
 * Strategy:
 *   app/<route>/components/<sub...>/<file>
 *   →  app/components/<route>/<sub...>/<file>
 *
 * where <route> has any group parens stripped.
 */
function destPath(src) {
  const rel   = path.relative(APP, src)          // e.g. "dashboard/listings/components/foo.tsx"
  const parts = rel.split(path.sep)
  const compIdx = parts.lastIndexOf("components")

  // Everything before "components" becomes the namespace (strip parens in each part)
  const namespace = parts.slice(0, compIdx).map(stripGroupParens).join(path.sep)
  // Everything after "components" is preserved
  const rest      = parts.slice(compIdx + 1).join(path.sep)

  if (namespace === "") {
    // Already directly under app/components/ — shouldn't happen (filtered above) but be safe
    return path.join(DEST, rest)
  }
  return path.join(DEST, namespace, rest)
}

const moveMap = new Map() // src → dst
const reverseMap = new Map() // dst → src (for collision detection)

for (const src of filesToMove) {
  const dst = destPath(src)
  if (reverseMap.has(dst)) {
    console.warn(`COLLISION: ${src} and ${reverseMap.get(dst)} both map to ${dst}`)
    continue
  }
  moveMap.set(src, dst)
  reverseMap.set(dst, src)
}

console.log(`Move map built: ${moveMap.size} unique destinations.`)

// ─── 3. Perform the moves ────────────────────────────────────────────────────

let moved = 0
for (const [src, dst] of moveMap) {
  if (src === dst) continue
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  fs.unlinkSync(src)
  moved++
}
console.log(`Moved ${moved} files.`)

// Clean up now-empty component directories (optional, keeps tree clean)
function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name))
  }
  const remaining = fs.readdirSync(dir)
  if (remaining.length === 0) {
    fs.rmdirSync(dir)
  }
}
// Only clean route-level component dirs, not app/components itself
for (const [src] of moveMap) {
  const compDir = src.split(path.sep + "components" + path.sep)[0] + path.sep + "components"
  removeEmptyDirs(compDir)
}

// ─── 4. Build import alias rewrite map ───────────────────────────────────────
//
// For every moved file we need to know:
//   old absolute path → new @/app/components/... alias
//   AND catch relative imports that referenced the old location

function toAlias(abs) {
  return "@/" + path.relative(ROOT, abs).replace(/\\/g, "/")
}

/** Old alias the file used to be reachable as */
function oldAliases(src) {
  const rel = path.relative(ROOT, src)
  return [
    "@/" + rel.replace(/\\/g, "/").replace(/\.(tsx?|jsx?)$/, ""),
    "@/" + rel.replace(/\\/g, "/"),
  ]
}

/** New alias after move */
function newAlias(dst) {
  return toAlias(dst).replace(/\.(tsx?|jsx?)$/, "")
}

// alias rewrite table: Map<oldAlias, newAlias>
const aliasRewrites = new Map()
for (const [src, dst] of moveMap) {
  if (src === dst) continue
  for (const old of oldAliases(src)) {
    aliasRewrites.set(old, newAlias(dst))
  }
}

// ─── 5. Rewrite imports across the entire codebase ───────────────────────────

const allFiles = [
  ...walk(APP),
  ...walk(path.join(ROOT, "lib")),
  ...walk(path.join(ROOT, "components")).catch?.(() => []) ?? (
    fs.existsSync(path.join(ROOT, "components")) ? walk(path.join(ROOT, "components")) : []
  ),
]

let filesRewritten = 0
let totalReplacements = 0

for (const file of allFiles) {
  if (!/\.(tsx?|jsx?)$/.test(file)) continue
  let src
  try { src = fs.readFileSync(file, "utf8") } catch { continue }

  let updated = src

  // A) Rewrite @/app/... absolute alias imports
  for (const [oldAlias, newAliasStr] of aliasRewrites) {
    // Match both quoted forms: "old" and 'old'
    const escaped = oldAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`(['"])${escaped}(['"])`, "g")
    updated = updated.replace(re, `$1${newAliasStr}$2`)
  }

  // B) Rewrite relative imports that point into a now-moved components/ directory.
  //    We resolve relative to the current file and check if the resolved path
  //    was a source in our move map.
  const importRe = /from\s+(['"])(\.\.?\/[^'"]+)(['"])/g
  updated = updated.replace(importRe, (match, q1, importPath, q2) => {
    const resolved = path.resolve(path.dirname(file), importPath)
    // Try with and without extension
    for (const ext of ["", ".tsx", ".ts", ".jsx", ".js"]) {
      const candidate = resolved + ext
      if (moveMap.has(candidate)) {
        const dst = moveMap.get(candidate)
        return `from ${q1}${newAlias(dst)}${q2}`
      }
    }
    // Also try index files
    for (const idx of ["/index.tsx", "/index.ts", "/index.jsx", "/index.js"]) {
      const candidate = resolved + idx
      if (moveMap.has(candidate)) {
        const dst = moveMap.get(candidate)
        return `from ${q1}${newAlias(dst)}${q2}`
      }
    }
    return match
  })

  if (updated !== src) {
    fs.writeFileSync(file, updated, "utf8")
    filesRewritten++
    totalReplacements++
  }
}

console.log(`Rewrote imports in ${filesRewritten} files (${totalReplacements} total changes).`)
console.log("Migration complete.")
