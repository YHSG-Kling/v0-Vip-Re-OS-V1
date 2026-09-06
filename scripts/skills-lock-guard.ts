#!/usr/bin/env tsx
/**
 * scripts/skills-lock-guard.ts   (npm run test:skills-lock) — pure, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────
 * A LOCK FILE NOBODY VERIFIES IS AN ORPHAN.
 *
 * `skills-lock.json` records the five externally-installed Claude skills — where
 * each came from, which SKILL.md inside that repo, and a `computedHash`. It had no
 * reader. Not one: the only mention of it anywhere in this repo is a prose line in
 * scripts/remotion-setup-guard.ts:43. A lock file exists to be CHECKED against
 * reality; unchecked, it is just five sentences that were true once.
 *
 * ── WHAT MADE THIS AN OPEN LOOP, AND WHAT MEASURING IT ACTUALLY FOUND ────────
 *
 * The Remotion lane set `remotion-best-practices.computedHash` to null rather than
 * invent a value, because the recorded hashes are not sha256 of the SKILL.md they
 * name and nothing in-repo reproduces the algorithm. That was the right call, and
 * checking it turned up something larger:
 *
 *   NONE of the five hashes is reproducible here — not just the null one.
 *
 * Measured against `.claude/skills/<name>/SKILL.md` (2026-08-26): plain sha256,
 * whitespace-trimmed sha256, CRLF-normalised sha256, `git hash-object`, and a
 * concatenation of the whole skill directory all disagree with every recorded
 * value. The hashes come from the external installer that wrote this file; the
 * repo cannot recompute them. So the four non-null entries are NOT verified
 * either — they merely LOOK verified, which is worse than the null, because null
 * says so out loud. §2's rule that a guard which cannot see what it judges is
 * worse than no guard applies just as well to a lock file.
 *
 * ── SO THIS GUARD CHECKS WHAT IS ACTUALLY CHECKABLE, AND SAYS WHAT IS NOT ────
 *
 * It does NOT recompute hashes; fabricating an algorithm to make the column look
 * green would be the exact defect it was written to record. It holds the claims
 * the repo CAN adjudicate — that the lock and the installed tree still describe
 * the same five skills — and it PUBLISHES the blind spot beside the number (§2:
 * "a count without its denominator and exclusions is not a measurement").
 *
 * WHY NULL STAYS. `computedHash: null` is the honest state for an entry whose
 * hash this repo cannot verify or reproduce. Replacing it with any locally
 * computed value would assert a verification that never happened — a number that
 * reads as evidence and is not. If the installer's algorithm is ever documented,
 * the fix is a real verifier here, not a plausible-looking string in the lock.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const LOCK_PATH = join(root, "skills-lock.json")
const SKILLS_DIR = join(root, ".claude", "skills")

export interface LockEntry {
  source?: string
  sourceType?: string
  skillPath?: string
  sourceRef?: string
  skillVersion?: string
  computedHash?: string | null
}
export interface SkillsLock {
  version?: number
  skills?: Record<string, LockEntry>
}

/** PURE — lock entries whose skill is not installed at .claude/skills/<name>/SKILL.md. */
export function missingInstalls(
  skills: Record<string, LockEntry>,
  installed: (name: string) => boolean,
): string[] {
  return Object.keys(skills).filter((n) => !installed(n)).sort()
}

/** PURE — entries missing a field the lock exists to record. */
export function incompleteEntries(skills: Record<string, LockEntry>): string[] {
  return Object.entries(skills)
    .filter(([, e]) => !e.source || !e.sourceType || !e.skillPath)
    .map(([n]) => n)
    .sort()
}

/**
 * PURE — a recorded hash must be either null (honestly unverified) or a 64-char
 * hex digest. Anything else — "", "unknown", a truncated value, a placeholder —
 * is a fabricated-looking entry, which is the one failure this file exists to
 * prevent. Shape is all the repo can judge; it deliberately does not recompute.
 */
export function malformedHashes(skills: Record<string, LockEntry>): string[] {
  return Object.entries(skills)
    .filter(([, e]) => {
      const h = e.computedHash
      if (h === null || h === undefined) return false
      return typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)
    })
    .map(([n]) => n)
    .sort()
}

let pass = 0, fail = 0
const failures: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; failures.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}

console.log("══════════════════════════════════════════════════")
console.log(" Skills lock — the lock and the installed tree agree")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — POSITIVE CONTROL: the finders still recognise their defects]")
{
  // §2: the repo section below claims zeroes. A broken finder claims zero too.
  const specimen: Record<string, LockEntry> = {
    good:        { source: "o/r", sourceType: "github", skillPath: "skills/good/SKILL.md", computedHash: "a".repeat(64) },
    honest_null: { source: "o/r", sourceType: "github", skillPath: "skills/hn/SKILL.md",   computedHash: null },
    uninstalled: { source: "o/r", sourceType: "github", skillPath: "skills/un/SKILL.md",   computedHash: null },
    no_source:   { sourceType: "github", skillPath: "skills/ns/SKILL.md",                  computedHash: null },
    fabricated:  { source: "o/r", sourceType: "github", skillPath: "skills/fb/SKILL.md",   computedHash: "unknown" },
    truncated:   { source: "o/r", sourceType: "github", skillPath: "skills/tr/SKILL.md",   computedHash: "abc123" },
  }
  const installedNames = new Set(["good", "honest_null", "no_source", "fabricated", "truncated"])
  const missing = missingInstalls(specimen, (n) => installedNames.has(n))
  check("flags a locked skill that is not installed", missing.includes("uninstalled"))
  check("…and only that one", missing.length === 1, missing.join(", "))
  const incomplete = incompleteEntries(specimen)
  check("flags an entry with no `source`", incomplete.includes("no_source"))
  check("…and only that one", incomplete.length === 1, incomplete.join(", "))
  const bad = malformedHashes(specimen)
  check("flags a placeholder hash", bad.includes("fabricated"))
  check("flags a truncated hash", bad.includes("truncated"))
  check("ACCEPTS an honest null — refusing to invent a value is not a defect",
    !bad.includes("honest_null"))
  check("accepts a well-formed digest", !bad.includes("good"))
}

console.log("\n[repo]")
check("skills-lock.json exists and parses", existsSync(LOCK_PATH))
const lock = (existsSync(LOCK_PATH)
  ? JSON.parse(readFileSync(LOCK_PATH, "utf8"))
  : {}) as SkillsLock
const skills = lock.skills ?? {}
const names = Object.keys(skills)

// A skill can be installed as a real directory OR as a SYMLINK into another tree
// (vercel-react-best-practices points at ../../.agents/skills/…). readdirSync's
// dirent reports a symlink as NOT a directory — lstat semantics — so filtering on
// `d.isDirectory()` made this guard's first run accuse a correctly installed skill
// of being missing. Exactly the shape §2 keeps naming: the instrument was wrong,
// not the tree. `existsSync` follows the link, so ask the only question that
// matters — is there a readable SKILL.md at that name?
const installedNames = existsSync(SKILLS_DIR)
  ? readdirSync(SKILLS_DIR).filter((n) => existsSync(join(SKILLS_DIR, n, "SKILL.md")))
  : []
const installedDir = new Set(installedNames)
const isInstalled = (n: string) => existsSync(join(SKILLS_DIR, n, "SKILL.md"))

const missing = missingInstalls(skills, isInstalled)
const incomplete = incompleteEntries(skills)
const malformed = malformedHashes(skills)
const nullHashes = names.filter((n) => skills[n].computedHash == null)

console.log(`  · ${names.length} locked skills · ${installedDir.size} skills installed under .claude/skills (dirs and symlinks both counted)`)
check(`every locked skill is installed with a SKILL.md (${missing.length} missing)`,
  missing.length === 0, missing.join(", "))
check(`every entry records source + sourceType + skillPath (${incomplete.length} incomplete)`,
  incomplete.length === 0, incomplete.join(", "))
check(`every recorded hash is null or a 64-hex digest (${malformed.length} malformed)`,
  malformed.length === 0, malformed.join(", "))

// ── THE BLIND SPOT, PUBLISHED BESIDE THE NUMBERS (§2) ───────────────────────
// Stated, not asserted: this is a fact about the installer, not a repo defect,
// so it must not fail CI — but a reader scanning the ✓ column above would
// otherwise conclude the hashes were checked. They were not, and cannot be.
console.log(
  `  · BLIND SPOT — hash VERIFICATION is not performed: ${names.length}/${names.length} entries ` +
  `carry a digest this repo cannot reproduce (sha256 of the named SKILL.md, trimmed, ` +
  `CRLF-normalised, git hash-object and whole-directory variants were all measured ` +
  `and all disagree). ${nullHashes.length} entr${nullHashes.length === 1 ? "y is" : "ies are"} ` +
  `honestly null: ${nullHashes.join(", ") || "none"}.`,
)
console.log(
  "  · So a non-null hash here means \"the installer wrote this\", NOT \"the content was verified\". " +
  "Do not fabricate a value to fill a null; wire a real verifier if the algorithm is ever published.",
)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ SKILLS_LOCK_FAIL — the lock and the installed tree disagree")
  process.exit(1)
}
console.log(" ✅ SKILLS_LOCK_PASS — every locked skill is installed and every entry is honestly recorded")
