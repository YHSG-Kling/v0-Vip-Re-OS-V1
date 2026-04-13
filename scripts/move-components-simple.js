const fs = require("fs")
const path = require("path")
const glob = require("glob")

const ROOT = "/vercel/share/v0-project"
const APP = path.join(ROOT, "app")
const DEST = path.join(APP, "components")

console.log("[v0] Starting component migration to app/components/")
console.log("[v0] ROOT:", ROOT)
console.log("[v0] APP:", APP) 
console.log("[v0] DEST:", DEST)

// Find all component files outside app/components
const pattern = path.join(APP, "**", "components", "**", "*.{tsx,ts,jsx,js}")
console.log("[v0] Searching pattern:", pattern)

const allComponentFiles = glob.sync(pattern, { nodir: true })
console.log("[v0] Found total component files:", allComponentFiles.length)

// Filter to only files NOT already in app/components
const filesToMove = allComponentFiles.filter(f => !f.startsWith(DEST + path.sep))
console.log("[v0] Files needing migration:", filesToMove.length)

if (filesToMove.length > 0) {
  console.log("[v0] Sample files to move:")
  filesToMove.slice(0, 5).forEach(f => console.log("  -", path.relative(ROOT, f)))
}

// Build move map
const moveMap = new Map()
for (const src of filesToMove) {
  const rel = path.relative(APP, src)
  const parts = rel.split(path.sep)
  const compIdx = parts.lastIndexOf("components")
  
  // Route namespace (everything before "components")
  const namespace = parts.slice(0, compIdx).map(p => p.replace(/^\((.+)\)$/, "$1")).join(path.sep)
  // Path after "components"
  const subpath = parts.slice(compIdx + 1).join(path.sep)
  
  const dst = path.join(DEST, namespace, subpath)
  moveMap.set(src, dst)
}

console.log("[v0] Moving", moveMap.size, "files...")

// Execute moves
let moved = 0
for (const [src, dst] of moveMap) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.renameSync(src, dst)
  moved++
  if (moved % 50 === 0) console.log("[v0] Progress:", moved, "/", moveMap.size)
}

console.log("[v0] Moved", moved, "files successfully")
console.log("[v0] Migration complete - imports will need manual update or run a separate rewrite script")
