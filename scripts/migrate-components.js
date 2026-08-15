/**
 * migrate-components.js  (CommonJS so the executor can run it directly)
 *
 * Moves every component file outside app/components/ INTO app/components/
 * preserving route-based sub-folders, then rewrites all import paths.
 */

const fs   = require("fs")
const path = require("path")

const ROOT = "/vercel/share/v0-project"
const APP  = path.join(ROOT, "app")
const DEST = path.join(APP, "components")

// ─── helpers ────────────────────────────────────────────────────────────────

function walk(dir, out) {
  out = out || []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const NEXT_SPECIALS = new Set([
  "page.tsx","page.ts","layout.tsx","layout.ts",
  "loading.tsx","loading.ts","error.tsx","error.ts",
  "not-found.tsx","not-found.ts","route.ts","route.tsx",
])

function isComponentFile(abs) {
  // must NOT already be under app/components/
  if (abs.startsWith(DEST + path.sep)) return false
  const rel   = path.relative(APP, abs)
  const parts = rel.split(path.sep)
  // must have a "components" directory somewhere in the path
  if (!parts.includes("components")) return false
  // never move Next.js special files
  const base = parts[parts.length - 1]
  if (NEXT_SPECIALS.has(base)) return false
  return true
}

function stripParens(seg) {
  return seg.replace(/^\((.+)\)$/, "$1")
}

/**
 * app/<route>/components/<rest>  →  app/components/<route>/<rest>
 */
function computeDest(src) {
  const rel      = path.relative(APP, src)
  const parts    = rel.split(path.sep)
  const compIdx  = parts.lastIndexOf("components")
  const ns       = parts.slice(0, compIdx).map(stripParens).join(path.sep)
  const rest     = parts.slice(compIdx + 1).join(path.sep)
  return ns ? path.join(DEST, ns, rest) : path.join(DEST, rest)
}

function toAlias(abs) {
  return "@/" + path.relative(ROOT, abs).replace(/\\/g, "/").replace(/\.(tsx?|jsx?)$/, "")
}

// ─── 1. Collect ──────────────────────────────────────────────────────────────

const allAppFiles = walk(APP).filter(f => /\.(tsx?|jsx?)$/.test(f))
const toMove      = allAppFiles.filter(isComponentFile)
console.log("Files to migrate: " + toMove.length)

// ─── 2. Build move map ───────────────────────────────────────────────────────

const moveMap = new Map()   // src → dst (absolute paths WITH extension)
const dstSeen = new Map()   // dst → src (collision guard)

for (const src of toMove) {
  const dst = computeDest(src)
  if (dstSeen.has(dst)) {
    console.warn("COLLISION – skipping: " + src + " (conflicts with " + dstSeen.get(dst) + ")")
    continue
  }
  if (src === dst) continue
  moveMap.set(src, dst)
  dstSeen.set(dst, src)
}

console.log("Unique moves: " + moveMap.size)

// ─── 3. Move files ───────────────────────────────────────────────────────────

let moved = 0
for (const [src, dst] of moveMap) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  fs.unlinkSync(src)
  moved++
}
console.log("Moved: " + moved)

// Remove empty component dirs left behind
function rmEmptyDirs(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) rmEmptyDirs(path.join(dir, e.name))
  }
  if (fs.readdirSync(dir).length === 0) try { fs.rmdirSync(dir) } catch (_) {}
}
for (const src of moveMap.keys()) {
  const idx = src.indexOf(path.sep + "components" + path.sep)
  if (idx > -1) rmEmptyDirs(src.slice(0, idx + 1) + "components")
}

// ─── 4. Build rewrite tables ─────────────────────────────────────────────────

// oldAlias (no extension) → newAlias (no extension)
const aliasMap = new Map()
for (const [src, dst] of moveMap) {
  const oldA = toAlias(src)
  const newA = toAlias(dst)
  if (oldA !== newA) aliasMap.set(oldA, newA)
}

// Also build a resolved-path map for rewriting relative imports
// key: absolute path (no ext variants), value: newAlias
const resolvedMap = new Map()
for (const [src, dst] of moveMap) {
  const noExt = src.replace(/\.(tsx?|jsx?)$/, "")
  resolvedMap.set(noExt,       toAlias(dst))
  resolvedMap.set(src,         toAlias(dst))
}

// ─── 5. Rewrite imports ───────────────────────────────────────────────────────

const allFiles = [
  ...walk(APP),
  ...walk(path.join(ROOT, "lib")),
  ...walk(path.join(ROOT, "components")),
]

const EXTS = [".tsx",".ts",".jsx",".js"]
let rewritten = 0

for (const file of allFiles) {
  if (!EXTS.includes(path.extname(file))) continue
  let text
  try { text = fs.readFileSync(file, "utf8") } catch (_) { continue }
  let out = text

  // A) Rewrite @/... alias imports that moved
  for (const [oldA, newA] of aliasMap) {
    const escaped = oldA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Match exact alias string (with optional .tsx/.ts suffix) in quotes
    out = out.replace(
      new RegExp("(['\"])" + escaped + "(?:\\.tsx?|\\.jsx?)?(['\"])", "g"),
      "$1" + newA + "$2"
    )
  }

  // B) Rewrite relative imports pointing into moved components dirs
  out = out.replace(/from\s+(['"])(\.\.?\/[^'"]+)(['"])/g, function(match, q1, imp, q2) {
    const resolved = path.resolve(path.dirname(file), imp)
    const noExt    = resolved.replace(/\.(tsx?|jsx?)$/, "")
    if (resolvedMap.has(noExt))    return "from " + q1 + resolvedMap.get(noExt) + q2
    if (resolvedMap.has(resolved)) return "from " + q1 + resolvedMap.get(resolved) + q2
    // Try index
    for (const ext of ["/index.tsx","/index.ts","/index.jsx","/index.js"]) {
      const candidate = resolved + ext
      if (resolvedMap.has(candidate)) return "from " + q1 + resolvedMap.get(candidate) + q2
    }
    return match
  })

  if (out !== text) {
    fs.writeFileSync(file, out, "utf8")
    rewritten++
  }
}

console.log("Import files rewritten: " + rewritten)
console.log("Done.")
