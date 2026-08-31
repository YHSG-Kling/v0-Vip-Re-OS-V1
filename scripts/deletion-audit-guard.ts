/**
 * scripts/deletion-audit-guard.ts — the tombstone ledger is only as good as its
 * survivors.
 *
 * WHY. CLAUDE.md §1 makes every deletion name its survivor in a TOMBSTONE
 * comment — the tree's deletion ledger. The owner's ruling (2026-08-27,
 * verbatim): "make sure that any previous deleted exports are not a
 * functionality that the platform doesn't have." A tombstone whose named
 * survivor no longer exists is exactly that failure mode arriving later: the
 * capability was deleted against a survivor, and then the survivor rotted.
 * This guard makes that rot RED instead of silent.
 *
 * WHAT IT ASSERTS, per tombstone comment block:
 *   1. Every repo path the block names as a SURVIVOR (marker words like
 *      "SURVIVOR", "survivor:", "lives at/in", "moved to", "replaced by",
 *      "wired to", "the capability lives at") must EXIST on disk.
 *   2. Reachability floor: a block whose only EXISTING named paths live under
 *      scripts/ (proof-only), while the block itself sits in product code, is
 *      reported — a survivor that only a guard can reach is not a product
 *      capability. (Reported as a counted warning, not a failure: several
 *      legitimate tombstones name their proof beside their survivor, and the
 *      survivor is often "THIS file" — see blind spots.)
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   · It does not judge paths the block marks as DELETED — those are SUPPOSED
 *     to be missing; flagging them would fight §1 itself (the 2026-08-23
 *     five-guard incident, CLAUDE.md §2, was precisely guards reading
 *     tombstones as live code).
 *   · It reads RAW source, not stripped — tombstones ARE comments; stripping
 *     would delete the ledger it audits. It is therefore NOT a code-token
 *     scanner and must never be extended into one without stripComments.
 *
 * MEASUREMENT DISCIPLINE (§2):
 *   · Positive controls run first: a planted tombstone naming a nonexistent
 *     SURVIVOR must be flagged, and a planted tombstone whose nonexistent path
 *     is marked DELETED must NOT be — a finder that cannot tell those apart
 *     reports garbage in both directions.
 *   · Denominator and blind spots are printed with the verdict: blocks that
 *     name no path at all (survivor described in prose, "THIS file", "below")
 *     are counted as unverifiable-by-path and listed in the blind-spot count —
 *     absence of a finding there is absence of coverage, not proof of health.
 *   · Ambiguous mentions (no survivor marker, no deleted marker) are checked
 *     for existence but a miss is only a warning — prose cites old paths in
 *     history notes; hard-failing those would train people to stop writing
 *     history.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCAN_DIRS = ["app", "lib", "hooks", "services", "components", "constants", "types", "scripts"]
const ROOT_FILES = ["types.ts"]
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"])

// ─── collect files ───────────────────────────────────────────────────────────
function walk(dir: string, out: string[]) {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(e)) walk(p, out)
    } else if (/\.(ts|tsx)$/.test(e)) {
      out.push(p)
    }
  }
}

// ─── tombstone block extraction (raw source, comment lines only) ─────────────
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\{\/\*)/

interface Block {
  file: string
  line: number
  text: string
}

function extractBlocks(file: string, src: string): Block[] {
  const lines = src.split("\n")
  const blocks: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    // The TOMBSTONE token must sit on a COMMENT line. A quoted "TOMBSTONE"
    // inside code (this guard's own regexes, simulators' fixture text) is a
    // mention, not a ledger entry.
    if (!lines[i].includes("TOMBSTONE")) continue
    if (!COMMENT_LINE.test(lines[i])) continue
    const start = i
    const collected: string[] = []
    while (i < lines.length && (COMMENT_LINE.test(lines[i]) || /^\s*$/.test(lines[i]))) {
      collected.push(lines[i])
      // a block-comment terminator ends the block even mid-line
      if (/\*\/\s*\}?\s*$/.test(lines[i]) && collected.length > 1) break
      i++
    }
    blocks.push({ file, line: start + 1, text: collected.join("\n") })
  }
  return blocks
}

// ─── mention classification ──────────────────────────────────────────────────
// NOTE alternation order: the longer extension MUST precede its prefix (`tsx`
// before `ts`, `json` before `js`) — regex alternation is first-match, so
// `ts|tsx` truncates every .tsx mention to .ts and the guard then accuses live
// .tsx survivors of not existing (found the hard way on this tree's very first
// run: 30+ false rot findings, all .tsx files; then baseline.json read as .js).
const PATH_RE =
  /(?:app|lib|hooks|services|components|constants|types|scripts|public|supabase)\/[\w\-./[\]]+\.(?:tsx|ts|json|jsx|js|mjs|sql)/g

// Both marker sets are case-INSENSITIVE — the ledger writes "DELETED", "Deleted"
// and "deleted" in equal measure, and a case-sensitive marker silently reclassifies
// a third of the prose (found on this tree's first run: "Deleted;" matched nothing).
const SURVIVOR_MARKERS =
  /surviv|lives (?:at|in|on|now|below|here)|capability lives|moved (?:to|onto)|now (?:at|in|lives)|replaced by|wired to|merged (?:onto|into)|absorbed (?:by|into)|the one (?:place|home)|its home|reachable (?:at|through|via)/i

const DELETED_MARKERS =
  /delet|remov|retired|is gone|are gone|stood here|lived here|was here|were here|dropped|burn|not applied|untrack|no longer exists|merged here|merged (?:into|onto) this|used to (?:read|be|live|construct|import)|the (?:deleted|old|duplicate|parallel|retired)/i

type MentionKind = "survivor" | "deleted" | "ambiguous"

interface Mention {
  path: string
  kind: MentionKind
  exists: boolean
}

/**
 * Comments in this repo wrap at ~80 columns, so a long path legally splits
 * mid-segment: "app/dashboard/listings/[id]/" at one line's end,
 * "components/open-house-post-event-panel.tsx:118" behind the next line's
 * comment prefix. PATH_RE then sees only the tail fragment — which, when it
 * happens to start with a root dir like `components/`, resolves nowhere and
 * gets accused of rot (found live 2026-08-31: the guard flagged an m3
 * tombstone whose survivor exists at the full, wrapped path). Fuse a line
 * ending mid-path (a "/" tail) with a continuation whose first word carries
 * on the path (a further "/" or a file extension) before extracting.
 */
function joinWrappedPaths(text: string): string {
  return text.replace(
    /([\w\-./[\]]+\/)\r?\n\s*(?:\/\/|\*)?\s*(?=[\w\-.[\]]+(?:\/|\.(?:tsx|ts|json|jsx|js|mjs|sql)\b))/g,
    "$1",
  )
}

function classifyMentions(rawText: string): Mention[] {
  const text = joinWrappedPaths(rawText)
  const out: Mention[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  PATH_RE.lastIndex = 0
  while ((m = PATH_RE.exec(text)) !== null) {
    const p = m[0]
    // context window around the mention decides its role in the prose
    const lo = Math.max(0, m.index - 220)
    const hi = Math.min(text.length, m.index + p.length + 220)
    const ctx = text.slice(lo, hi)
    let kind: MentionKind = "ambiguous"
    // The mention's OWN line decides first — "SURVIVOR: x.ts" and "x.ts DELETED"
    // routinely sit two lines apart in one block, so a shared window cannot
    // separate them but the line always can.
    const lineStart = text.lastIndexOf("\n", m.index) + 1
    const lineEndIdx = text.indexOf("\n", m.index)
    const line = text.slice(lineStart, lineEndIdx === -1 ? text.length : lineEndIdx)
    // Arrow ledger lines ("deleted/path.ts → surviving/path.ts") carry both
    // roles on one line, positionally: left of the arrow is the deleted half,
    // right of it the survivor.
    const arrowIdx = line.indexOf("→")
    if (arrowIdx !== -1) {
      const mentionCol = m.index - lineStart
      kind = mentionCol > arrowIdx ? "survivor" : "deleted"
      const key0 = `${p}|${kind}`
      if (!seen.has(key0)) {
        seen.add(key0)
        out.push({ path: p, kind, exists: existsSync(join(ROOT, p)) || existsSync(join(ROOT, "app", p)) })
      }
      continue
    }
    const lineSurv = SURVIVOR_MARKERS.test(line)
    const lineDel = DELETED_MARKERS.test(line)
    if (lineSurv && !lineDel) kind = "survivor"
    else if (lineDel && !lineSurv) kind = "deleted"
    else if (!lineSurv && !lineDel) {
      // fall back to the window, but only when it is unanimous
      const survivorHit = SURVIVOR_MARKERS.test(ctx)
      const deletedHit = DELETED_MARKERS.test(ctx)
      if (survivorHit && !deletedHit) kind = "survivor"
      else if (deletedHit && !survivorHit) kind = "deleted"
    }
    const key = `${p}|${kind}`
    if (seen.has(key)) continue
    seen.add(key)
    // Existence honors the tsconfig alias fold: "@/components/*" maps to
    // "./app/components/*", and tombstones routinely cite the alias spelling
    // ("components/ui/card.tsx") for a file that lives under app/.
    out.push({ path: p, kind, exists: existsSync(join(ROOT, p)) || existsSync(join(ROOT, "app", p)) })
  }
  return out
}

// ─── positive controls (§2: prove the finder can find) ───────────────────────
function runControls(): string[] {
  const failures: string[] = []
  const plantedBad = [
    "// TOMBSTONE (§1.1): `doThing` was DELETED here.",
    "// SURVIVOR: lib/this-survivor-does-not-exist-xyz.ts — the one true home.",
  ].join("\n")
  const bad = classifyMentions(plantedBad)
  const badSurvivor = bad.find((x) => x.kind === "survivor" && !x.exists)
  if (!badSurvivor) {
    failures.push(
      "POSITIVE CONTROL FAILED: a planted tombstone naming a nonexistent SURVIVOR was not flagged — the finder is blind and every 'all survivors exist' below would be meaningless.",
    )
  }
  const plantedOk = [
    "// TOMBSTONE (§1.3): app/api/never-existed/route.ts DELETED — zero callers.",
    "// SURVIVOR: lib/kernel/communications.ts holds the capability.",
  ].join("\n")
  const ok = classifyMentions(plantedOk)
  const wronglyFlagged = ok.find((x) => x.kind === "survivor" && x.path.includes("never-existed"))
  if (wronglyFlagged) {
    failures.push(
      "NEGATIVE CONTROL FAILED: a path marked DELETED was classified as a survivor — the finder would accuse the ledger of the deletions it exists to record.",
    )
  }
  const okSurvivor = ok.find((x) => x.kind === "survivor" && x.path === "lib/kernel/communications.ts")
  if (!okSurvivor || !okSurvivor.exists) {
    failures.push("CONTROL FAILED: a real existing survivor path was not recognized as an existing survivor.")
  }
  // The 80-column wrap: a survivor path split across two comment lines must be
  // reassembled and found to exist — and the orphaned tail fragment must NOT be
  // extracted as a path of its own (that fragment is what got a live survivor
  // accused of rot).
  const plantedWrapped = [
    "// TOMBSTONE (§1.1): `x` DELETED. SURVIVOR: wired at app/dashboard/listings/[id]/",
    "//     components/open-house-post-event-panel.tsx, the one true home.",
  ].join("\n")
  const wrapped = classifyMentions(plantedWrapped)
  const fused = wrapped.find((x) => x.path === "app/dashboard/listings/[id]/components/open-house-post-event-panel.tsx")
  const fragment = wrapped.find((x) => x.path === "components/open-house-post-event-panel.tsx")
  if (!fused || !fused.exists || fragment) {
    failures.push(
      "CONTROL FAILED: a survivor path wrapped across two comment lines was not reassembled (or its tail fragment leaked as a path) — wrapped tombstones would be accused of rot.",
    )
  }
  return failures
}

// ─── main ────────────────────────────────────────────────────────────────────
const controlFailures = runControls()
if (controlFailures.length > 0) {
  for (const f of controlFailures) console.error(` ❌ ${f}`)
  console.error("\n ❌ DELETION_AUDIT_FAIL — controls red, scan not trustworthy")
  process.exit(1)
}

const files: string[] = []
for (const d of SCAN_DIRS) walk(join(ROOT, d), files)
for (const f of ROOT_FILES) {
  const p = join(ROOT, f)
  if (existsSync(p)) files.push(p)
}

const selfPath = join(ROOT, "scripts/deletion-audit-guard.ts")

let blockCount = 0
let mentionCount = 0
let survivorClaims = 0
let blocksWithoutPaths = 0
let proofOnlyBlocks = 0
const rottedSurvivors: string[] = []
const ambiguousMissing: string[] = []

for (const file of files) {
  if (file === selfPath) continue // this file's doc comments quote marker words
  const src = readFileSync(file, "utf-8")
  if (!src.includes("TOMBSTONE")) continue
  const rel = file.slice(ROOT.length + 1)
  for (const block of extractBlocks(file, src)) {
    blockCount++
    const mentions = classifyMentions(block.text)
    mentionCount += mentions.length
    if (mentions.length === 0) {
      blocksWithoutPaths++
      continue
    }
    const survivors = mentions.filter((x) => x.kind === "survivor")
    survivorClaims += survivors.length
    for (const s of survivors) {
      if (!s.exists) {
        rottedSurvivors.push(`${rel}:${block.line} names survivor ${s.path} — DOES NOT EXIST`)
      }
    }
    for (const a of mentions.filter((x) => x.kind === "ambiguous")) {
      if (!a.exists) ambiguousMissing.push(`${rel}:${block.line} mentions ${a.path} (role unclear) — does not exist`)
    }
    // reachability floor: existing paths, but every one of them under scripts/,
    // while the tombstone itself sits in product code
    const existing = mentions.filter((x) => x.exists && x.kind !== "deleted")
    if (existing.length > 0 && !rel.startsWith("scripts/") && existing.every((x) => x.path.startsWith("scripts/"))) {
      proofOnlyBlocks++
    }
  }
}

console.log("── deletion-audit — the tombstone ledger's survivors ──────────────")
console.log(`files scanned:            ${files.length}`)
console.log(`tombstone blocks:         ${blockCount}`)
console.log(`path mentions classified: ${mentionCount}`)
console.log(`survivor claims checked:  ${survivorClaims}`)
console.log(`blind spot — blocks naming no path (prose/'THIS file' survivors): ${blocksWithoutPaths}`)
console.log(`warning — blocks whose only existing named paths are proof-only (scripts/): ${proofOnlyBlocks}`)
if (ambiguousMissing.length > 0) {
  console.log(`warning — ambiguous mentions of missing paths (history prose, not failed claims): ${ambiguousMissing.length}`)
  for (const w of ambiguousMissing.slice(0, 10)) console.log(`   · ${w}`)
  if (ambiguousMissing.length > 10) console.log(`   · … ${ambiguousMissing.length - 10} more`)
}

if (rottedSurvivors.length > 0) {
  console.error("")
  for (const r of rottedSurvivors) console.error(` ❌ ${r}`)
  console.error(
    `\n ❌ DELETION_AUDIT_FAIL — ${rottedSurvivors.length} tombstone(s) name a survivor that no longer exists. The deletion those tombstones record is now a capability the platform does not have (owner ruling 2026-08-27). Rebuild the survivor or re-point the tombstone at the real one — never delete the tombstone to silence this.`,
  )
  process.exit(1)
}

console.log(
  `\n ✅ DELETION_AUDIT_PASS — every path-named survivor exists (${survivorClaims} claims across ${blockCount} blocks; controls green)`,
)
