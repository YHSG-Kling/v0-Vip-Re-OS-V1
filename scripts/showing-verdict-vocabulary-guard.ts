#!/usr/bin/env tsx
/**
 * scripts/showing-verdict-vocabulary-guard.ts   (npm run test:showing-verdict-vocabulary)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE VOCABULARY FOR THE SHOWING VERDICT (§6, m568).
 *
 * The buyer's verdict on the HOUSE is one fact with two speakers:
 *   showings.buyer_interest_level / tour_stops.buyer_interest_level — the buyer's
 *     own tap: love_it | like_it | maybe | no
 *   showing_feedback.overall_impression — the third-party showing agent's
 *     tokenized form, which historically spoke a private dialect:
 *     loved_it | liked_it | neutral | not_interested
 *
 * m568 keeps BOTH columns (showing_feedback.showing_id is NOT NULL — one showing
 * can carry both verdicts and they may disagree; merging columns destroys who
 * said it) and retires the dialect: the CHECK moves onto the one vocabulary.
 *
 * WHAT THIS GUARD HOLDS IN PLACE — asserting the RULE, not a waypoint (§2):
 *   1. The m568 migration file maps every old token onto its canonical rung and
 *      installs a CHECK naming exactly the canonical four.
 *   2. The tokenized form submits ONLY canonical tokens.
 *   3. The API writer normalises the boundary: every old token maps to its
 *      canonical rung (a tab opened pre-deploy must not lose a real verdict),
 *      canonical tokens pass through, junk becomes null.
 *   4. No live (comment-stripped) code outside that one boundary normaliser
 *      still compares or assigns an old-dialect token against overall_impression.
 *   5. The retired bridge impressionToRating is GONE from stripped source and
 *      its tombstone names the survivor (tourInterestToRating).
 *   6. The survivor speaks every canonical rung (delegated proof also lives in
 *      test:showing-feedback-learning; re-derived here so this guard fails
 *      closed on its own).
 *
 * BLIND SPOTS, published beside the number (§2):
 *   · The DB CHECK itself is proven by m568's own post-state DO block at apply
 *     time and by the regenerated vocabulary cache afterwards — this guard is
 *     pure and does not dial the database, so between apply and cache-regen it
 *     cannot see the live constraint.
 *   · scripts/check-vocabularies.ts is GENERATED; until the integrator applies
 *     m568 and regenerates it, its overall_impression entry still lists the old
 *     dialect. This guard deliberately does NOT compare against that cache —
 *     check-vocabulary-guard owns that comparison, and pinning this guard to
 *     either generation of the cache would make it a waypoint assertion.
 *   · String-built column names would evade the scans below; none exist for
 *     overall_impression today, and the positive controls prove the finders see
 *     the tokens they hunt.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import { stripComments } from "./strip-comments"
import { tourInterestToRating, isPositiveShowingInterest, isNegativeShowingInterest } from "../lib/behavior-learning/signal-mapping"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const CANON = ["love_it", "like_it", "maybe", "no"] as const
const OLD = ["loved_it", "liked_it", "neutral", "not_interested"] as const
const MAP: Record<string, string> = { loved_it: "love_it", liked_it: "like_it", neutral: "maybe", not_interested: "no" }

// ── POSITIVE CONTROL: the stripper + finder recognise the defect they hunt ───
console.log("\n[Positive controls — the finders can see what they look for]")
{
  const specimen = `const x = fb.overall_impression === "loved_it" // loved_it in a comment`
  const stripped = stripComments(specimen)
  check("stripped specimen keeps the live old-token comparison", stripped.includes(`=== "loved_it"`))
  check("stripped specimen drops the commented token", !stripped.includes("comment"))
  check("a comment-only mention strips to nothing", !stripComments(`// overall_impression === "loved_it"`).includes("loved_it"))
}

// ── 1. The migration file ────────────────────────────────────────────────────
console.log("\n[m568 — the migration maps the dialect and installs the one CHECK]")
{
  const files = execSync(`ls ${join(root, "supabase", "migrations")}`).toString().split("\n").filter((f) => f.startsWith("m568-"))
  check("exactly one m568 migration file exists", files.length === 1, `found ${files.length}`)
  if (files.length === 1) {
    const sql = readFileSync(join(root, "supabase", "migrations", files[0]), "utf8")
    for (const [from, to] of Object.entries(MAP)) {
      const re = new RegExp(`WHEN\\s+'${from}'\\s+THEN\\s+'${to}'`)
      check(`migration maps ${from} → ${to}`, re.test(sql))
    }
    check("migration drops the OLD constraint by its live name", sql.includes("DROP CONSTRAINT IF EXISTS showing_feedback_overall_impression_check"))
    // The new CHECK admits exactly the canonical four — derived, not pinned:
    const checkDef = sql.match(/ADD CONSTRAINT showing_feedback_overall_impression_check\s+CHECK \(([^;]+)\);/)
    check("migration re-adds the CHECK under the same name", !!checkDef)
    if (checkDef) {
      const admitted = [...checkDef[1].matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()
      check("the new CHECK admits exactly the canonical four", JSON.stringify(admitted) === JSON.stringify([...CANON].sort()), admitted.join(","))
      check("the new CHECK admits NO old-dialect token", admitted.every((t) => !OLD.includes(t as any)))
    }
    check("migration asserts its own post-state (old rows impossible)", sql.includes("old-vocabulary rows survived") || sql.includes("RAISE EXCEPTION"))
  }
}

// ── 2. The form submits only canonical tokens ────────────────────────────────
console.log("\n[The tokenized form speaks canon]")
{
  const src = stripComments(readFileSync(join(root, "app/showings/feedback/[token]/feedback-form.tsx"), "utf8"))
  const block = src.match(/const IMPRESSION_OPTIONS[^=]*=\s*\[[^\]]+\]/)?.[0] ?? ""
  check("IMPRESSION_OPTIONS found", block.length > 0)
  const values = [...block.matchAll(/value:\s*"([a-z_]+)"/g)].map((m) => m[1])
  check("form offers exactly the canonical four values", JSON.stringify([...values].sort()) === JSON.stringify([...CANON].sort()), values.join(","))
  check("form offers no old-dialect value", values.every((v) => !OLD.includes(v as any)))
}

// ── 3. The boundary normaliser (run the real function) ───────────────────────
console.log("\n[The API writer normalises the boundary — run, not grep]")
{
  const routePath = join(root, "app/api/showings/feedback/[token]/route.ts")
  const raw = readFileSync(routePath, "utf8")
  const stripped = stripComments(raw)
  // Extract normalizeImpression and evaluate it. Brace-matched, not lazy-regexed
  // (the anniversary wave's finder bug — a lazy regex returns the signature).
  const start = stripped.indexOf("function normalizeImpression")
  check("normalizeImpression exists in stripped source", start >= 0)
  if (start >= 0) {
    let depth = 0, i = stripped.indexOf("{", start), end = -1
    for (; i < stripped.length; i++) {
      if (stripped[i] === "{") depth++
      else if (stripped[i] === "}") { depth--; if (depth === 0) { end = i + 1; break } }
    }
    const body = stripped.slice(start, end)
    check("extraction control: the extracted text contains the switch", body.includes("switch"))
    // new Function speaks JS, not TS — erase the signature's annotations only
    // (the body is annotation-free by construction: a switch over string cases).
    const js = body.replace(/function normalizeImpression\([^)]*\)[^{]*\{/, "function normalizeImpression(v) {")
    check("extraction control: annotation erasure kept the switch intact", js.includes("switch (v)") || js.includes("switch(v)"))
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${js}; return normalizeImpression`)() as (v: unknown) => string | null
    for (const [from, to] of Object.entries(MAP)) check(`normaliser maps stale ${from} → ${to}`, fn(from) === to)
    for (const c of CANON) check(`normaliser passes canonical ${c} through`, fn(c) === c)
    check("normaliser refuses junk as null (not a 500, not a write)", fn("banana") === null && fn(undefined) === null)
    // The write must use the normalised value, not the raw body field:
    check("the UPDATE payload writes the normalised value", /overall_impression:\s*impression\b/.test(stripped))
    check("the UPDATE payload does NOT write the raw body field", !/overall_impression:\s*overallImpression/.test(stripped))
  }

  // MUTATION CONTROL: a normaliser that returns its input unchanged would pass
  // the pass-through checks — prove the old→new arms are load-bearing.
  const mutated = ((v: unknown) => (typeof v === "string" ? v : null)) as (v: unknown) => string | null
  check("MUTATION CONTROL: an identity normaliser would fail the old→new checks", Object.entries(MAP).some(([from, to]) => mutated(from) !== to))
}

// ── 4. No live code outside the boundary still speaks the dialect ────────────
console.log("\n[No live reader/writer speaks the old dialect against overall_impression]")
{
  const files = execSync(
    `grep -rl "overall_impression" --include='*.ts' --include='*.tsx' ${join(root, "app")} ${join(root, "lib")} 2>/dev/null || true`
  ).toString().trim().split("\n").filter(Boolean)
  check("scan denominator is non-trivial (the finder found the readers)", files.length >= 8, `${files.length} files`)

  // The finder, factored so the historical defect shape can be replayed against
  // it as a control. not_interested / neutral legitimately belong to OTHER
  // columns (saved_properties.interest_level, portal tour feedback, ISA
  // outcomes, the derived positive|neutral|negative sentiment), so a token only
  // counts near overall_impression: ±5 lines for the three unambiguous tokens,
  // SAME line for "neutral" (published blind spot: a "neutral" old-dialect
  // literal held in a variable a line away from its overall_impression use
  // would evade; the sentiment vocabulary makes the wide window a false
  // accuser for that one token).
  const findOffenders = (stripped: string, path: string): string[] => {
    const out: string[] = []
    const lines = stripped.split("\n")
    for (const t of OLD) {
      if (!new RegExp(`["']${t}["']`).test(stripped)) continue
      lines.forEach((l, idx) => {
        if (!new RegExp(`["']${t}["']`).test(l)) return
        const window = lines.slice(Math.max(0, idx - 5), idx + 6).join("\n")
        const hit = t === "neutral"
          ? (l.includes("overall_impression") || l.includes("overallImpression"))
          : (window.includes("overall_impression") || window.includes("overallImpression") || window.includes("IMPRESSION_OPTIONS"))
        if (hit) out.push(`${path}:${idx + 1} ${t}`)
      })
    }
    return out
  }

  // POSITIVE CONTROL: the exact defect shape this repo shipped (portal-seller's
  // private POSITIVE set, four lines above its overall_impression use) must be
  // caught, or the zero below is blindness rather than cleanliness.
  const specimen = [
    `const POSITIVE = new Set(["loved_it", "liked_it"])`,
    `const NEGATIVE = new Set(["not_interested"])`,
    `const breakdown = { positive: 0, neutral: 0, negative: 0 }`,
    `for (const fb of allFeedback) {`,
    `  const impression = fb.overall_impression`,
    `  if (POSITIVE.has(impression)) breakdown.positive++`,
    `}`,
  ].join("\n")
  check("POSITIVE CONTROL: the finder catches the shipped defect shape", findOffenders(specimen, "specimen").length > 0)

  let offenders: string[] = []
  for (const f of files) {
    const stripped = stripComments(readFileSync(f, "utf8"))
    // The one sanctioned home for old tokens is the boundary normaliser's case arms.
    const scoped = f.endsWith("app/api/showings/feedback/[token]/route.ts")
      ? stripped.replace(/function normalizeImpression[\s\S]*?\n}/, "")
      : stripped
    offenders.push(...findOffenders(scoped, f))
  }
  check("0 old-dialect literals adjacent to overall_impression in live code", offenders.length === 0, offenders.join(" | "))
  console.log(`  · denominator: ${files.length} files naming overall_impression under app/ + lib/; window = ±5 lines (same-line for "neutral")`)
}

// ── 5. The retired bridge ────────────────────────────────────────────────────
console.log("\n[impressionToRating is retired INTO tourInterestToRating (§1)]")
{
  const sm = readFileSync(join(root, "lib/behavior-learning/signal-mapping.ts"), "utf8")
  const stripped = stripComments(sm)
  check("impressionToRating is GONE from stripped source", !stripped.includes("impressionToRating"))
  check("BLINDNESS CONTROL: the name IS still in the raw file (the tombstone) — the stripper is what makes the line above true", sm.includes("impressionToRating"))
  check("the tombstone names the survivor", /TOMBSTONE[\s\S]*tourInterestToRating/.test(sm))
  const importers = execSync(
    `grep -rl "impressionToRating" --include='*.ts' --include='*.tsx' ${join(root, "app")} ${join(root, "lib")} ${join(root, "scripts")} 2>/dev/null || true`
  ).toString().trim().split("\n").filter(Boolean).filter((f) => !f.endsWith("signal-mapping.ts") && !f.endsWith("showing-verdict-vocabulary-guard.ts") && !f.endsWith("manager-registry.ts"))
  const liveImporters = importers.filter((f) => stripComments(readFileSync(f, "utf8")).includes("impressionToRating"))
  check("no live code still imports/calls the retired bridge", liveImporters.length === 0, liveImporters.join(","))
}

// ── 6. The survivor speaks every canonical rung ──────────────────────────────
console.log("\n[The survivor ladder covers the whole vocabulary]")
{
  for (const c of CANON) check(`tourInterestToRating(${c}) is a number`, typeof tourInterestToRating(c) === "number")
  check("positive set = the two rungs above maybe", isPositiveShowingInterest("love_it") && isPositiveShowingInterest("like_it") && !isPositiveShowingInterest("maybe"))
  check("negative set = the bottom rung only", isNegativeShowingInterest("no") && !isNegativeShowingInterest("maybe") && !isNegativeShowingInterest("like_it"))
  check("an unanswered verdict is in NEITHER set", !isPositiveShowingInterest(null) && !isNegativeShowingInterest(null))
  // MUTATION CONTROL: the guard would notice a ladder that lost a rung.
  const crippled = (v: string) => (v === "love_it" ? 5 : null)
  check("MUTATION CONTROL: a ladder missing like_it would fail the coverage check", CANON.some((c) => typeof crippled(c) !== "number"))
}

console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error(" ❌ SHOWING_VERDICT_VOCABULARY_FAIL")
  process.exit(1)
}
console.log(" ✅ SHOWING_VERDICT_VOCABULARY_PASS — one vocabulary, two speakers, both kept")
