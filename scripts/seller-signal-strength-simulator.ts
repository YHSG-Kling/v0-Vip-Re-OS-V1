#!/usr/bin/env tsx
/**
 * scripts/seller-signal-strength-simulator.ts   (npm run test:seller-signal-strength)
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVES: the motivated-seller component of the lead score can actually score.
 *
 * THE DEFECT. `motivated_seller_signals.signal_strength` is TEXT and every
 * writer stores a WORD. The one reader that scored them compared that word
 * against a NUMBER:
 *
 *     sellerSignals.filter((s) => s.signal_strength > 0.7).length
 *
 * `"strong" > 0.7` coerces the string to NaN and NaN > 0.7 is false, for every
 * value in the vocabulary. The component contributed exactly ZERO of its
 * possible 30 points, always.
 *
 * The negative control below is the whole point of this file: it re-runs the OLD
 * comparison over the SAME rows and asserts it returns zero. If someone ever
 * reverts to a numeric threshold, that control goes green-for-the-wrong-reason
 * and the positive assertions above it go red — you cannot satisfy both.
 *
 * No database. Pure functions and a static reading of the two call sites.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  SELLER_SIGNAL_STRENGTHS,
  STRONG_SELLER_SIGNAL_THRESHOLD,
  countStrongSellerSignals,
  isSellerSignalStrength,
  isStrongSellerSignal,
  rankOf,
} from "../lib/lead-governance/seller-signal-strength"
import { blankComments } from "./strip-comments"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? `   ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("══════════════════════════════════════════════════")
console.log(" motivated-seller signal strength — one vocabulary, one threshold")
console.log("══════════════════════════════════════════════════")

// ── 1. The ladder ───────────────────────────────────────────────────────────
check("the vocabulary is exactly the four words every writer in the tree emits",
  SELLER_SIGNAL_STRENGTHS.join(",") === "weak,moderate,strong,urgent")
check("the ladder is ordered weakest → strongest",
  rankOf("weak") < rankOf("moderate") && rankOf("moderate") < rankOf("strong") && rankOf("strong") < rankOf("urgent"))
check("'strong' and 'urgent' count; 'weak' and 'moderate' do not",
  isStrongSellerSignal("strong") && isStrongSellerSignal("urgent")
  && !isStrongSellerSignal("moderate") && !isStrongSellerSignal("weak"))
check("the threshold is named, not a magic number",
  STRONG_SELLER_SIGNAL_THRESHOLD === "strong")

// ── 2. Everything OUTSIDE the vocabulary is unreadable, not weak ─────────────
// -1 rather than 0 is deliberate: scoring an unknown spelling as the bottom of
// the ladder would launder bad data into a real (if small) score.
for (const bogus of [null, undefined, "", "STRONG", "high", 8, 0.9, {}, []]) {
  check(`rankOf(${JSON.stringify(bogus)}) is -1 — unreadable, not 'weak'`, rankOf(bogus) === -1)
  check(`isStrongSellerSignal(${JSON.stringify(bogus)}) is false`, isStrongSellerSignal(bogus) === false)
}
check("the numeric reading used by OTHER tables is refused here",
  !isSellerSignalStrength(10) && !isSellerSignalStrength("10"))

// ── 3. The score can now move ───────────────────────────────────────────────
const rows = [
  { signal_strength: "strong" },    // permit lane, demolition
  { signal_strength: "urgent" },    // unified-profile lane
  { signal_strength: "moderate" },  // equity / life event
  { signal_strength: "weak" },      // routine maintenance permit
  { signal_strength: null },        // lane could not judge
]
check("two of these five rows are strong", countStrongSellerSignals(rows) === 2)
check("the component scores 30 (capped) rather than 0",
  Math.min(countStrongSellerSignals(rows) * 15, 30) === 30)
check("one strong row scores 15, not 0",
  Math.min(countStrongSellerSignals([{ signal_strength: "strong" }]) * 15, 30) === 15)
check("no strong rows still scores 0 — the fix does not invent points",
  Math.min(countStrongSellerSignals([{ signal_strength: "weak" }, { signal_strength: "moderate" }]) * 15, 30) === 0)

// ── 4. NEGATIVE CONTROL — the shipped comparison, re-run ────────────────────
const oldWay = rows.filter((s: any) => s.signal_strength > 0.7).length
check("NEGATIVE CONTROL: the old `> 0.7` comparison finds ZERO strong rows in the same data",
  oldWay === 0, `oldWay=${oldWay}`)
check("NEGATIVE CONTROL: it is zero for EVERY word in the vocabulary, one at a time",
  SELLER_SIGNAL_STRENGTHS.every((w) => !((w as any) > 0.7)))

// ── 5. The call sites ───────────────────────────────────────────────────────
const scorer = src("lib/services/lead-management.service.ts")
check("the scorer calls the shared counter",
  scorer.includes("countStrongSellerSignals(sellerSignals"))
// COMMENTS BLANKED FIRST, and this file learned that the hard way: the fix at
// the call site QUOTES the old `signal_strength > 0.7` line in the comment that
// explains it, so a raw-source scan reported the defect as still present. That
// is the same "prose read as code" failure the schema-drift guard was just
// cured of. blankComments is the one correct way to ask this question here.
const scorerCode = blankComments(scorer)
check("the scorer no longer carries a numeric threshold against this column",
  !/signal_strength\s*[<>]=?\s*[\d.]/.test(scorerCode),
  "a numeric comparison against signal_strength is back")
// Positive control for the line above: the pattern DOES fire on the shipped
// defect, so a green result means the code changed and not that the regex rotted.
check("POSITIVE CONTROL: that pattern still recognises the original defect",
  /signal_strength\s*[<>]=?\s*[\d.]/.test('filter((s: any) => s.signal_strength > 0.7)'))

const permits = src("lib/external/permit-signals.ts")
check("the permit lane derives its narrower type from the canonical ladder",
  permits.includes("Extract<SellerSignalStrength"),
  "permit-signals restated the literals instead of deriving them")
check("the permit lane still cannot spell 'urgent' — a permit describes a structure, not a person",
  !/SignalStrength\s*=\s*[^=\n]*urgent/.test(permits))

// ── 6. The migration matches the code ───────────────────────────────────────
const m500 = src("supabase/migrations/m500-motivated-seller-signal-strength-is-a-vocabulary-nothing-was-enforcing.sql")
check("m500's CHECK admits exactly the four words the code knows",
  SELLER_SIGNAL_STRENGTHS.every((w) => m500.includes(`'${w}'`))
  && /IN \('weak', 'moderate', 'strong', 'urgent'\)/.test(m500))
check("m500 lets NULL through — 'could not judge' is not 'weak'",
  m500.includes("signal_strength IS NULL OR"))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log(" ✅ the motivated-seller component can score, and only on words it knows")
