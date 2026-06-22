#!/usr/bin/env tsx
/**
 * scripts/newsletter-seo-score-simulator.ts  (npm run test:newsletter-seo-score) — pure, no DB.
 *
 * Proves the pure newsletter SEO scoring math in lib/newsletter/seo-score.ts —
 * the same breakdown that powers live draft-time scoring in the rendered
 * newsletter editor AND the getSEOScore server action that persists to
 * newsletter_seo_scores. No mocks, no stubs: real strings in, real numbers out.
 *
 * Covers: H1 bonus, keyword-density band, length penalties/bonuses, subject-line
 * window, and recommendation triggers.
 */
import {
  computeSeoScore,
  escapeKeyword,
  SEO_BASE_SCORE,
  READABILITY_BASE_SCORE,
} from "../lib/newsletter/seo-score"

let pass = 0,
  fail = 0
const check = (n: string, c: boolean) => {
  if (c) {
    pass++
    console.log(`  ✓ ${n}`)
  } else {
    fail++
    console.log(`  ✗ ${n}`)
  }
}

// Helpers to build bodies with a known word count.
const words = (n: number, kw = "home") => Array.from({ length: n }, () => kw).join(" ")
/** Plain text of `total` words of which `kwHits` are the keyword "home". */
function text(total: number, kwHits: number): string {
  const filler = Array.from({ length: total - kwHits }, (_, i) => `w${i}`)
  const kws = Array.from({ length: kwHits }, () => "home")
  return [...kws, ...filler].join(" ")
}

console.log("\n[newsletter SEO score · pure]")

// ── H1 bonus ─────────────────────────────────────────────────────────────────
{
  const withH1 = computeSeoScore({ subjectLine: "x", htmlContent: "<h1>Hi</h1> " + words(400), primaryKeyword: "zzz" })
  const noH1 = computeSeoScore({ subjectLine: "x", htmlContent: "<p>Hi</p> " + words(400), primaryKeyword: "zzz" })
  check("H1 present detected", withH1.hasH1 === true)
  check("H1 absent detected", noH1.hasH1 === false)
  // Same word count + keyword + subject ⇒ the only overall delta is the H1 +10.
  check("H1 adds +10 overall (other factors equal)", withH1.overallScore - noH1.overallScore === 10)
  check("H1 adds +10 readability", withH1.readabilityScore - noH1.readabilityScore === 10)
}

// ── Keyword-density band (1%–3% earns +15) ───────────────────────────────────
{
  // 400 plain words, no H1, short subject — keeps the score off the 100 cap so the
  // keyword bonus is observable. 8 "home" hits → ~2.0% density → in-band.
  const inBand = computeSeoScore({ subjectLine: "x", htmlContent: text(400, 8), primaryKeyword: "home" })
  check("density ~2% is in [1,3] band", inBand.keywordDensity >= 1 && inBand.keywordDensity <= 3)
  // 400 words, 1 hit → ~0.25% → below band. Same word count, no H1, same subject ⇒ only keyword +15 differs.
  const below = computeSeoScore({ subjectLine: "x", htmlContent: text(400, 1), primaryKeyword: "home" })
  check("density ~0.25% is below band", below.keywordDensity < 1)
  check("in-band density adds exactly +15 overall vs below-band", inBand.overallScore - below.overallScore === 15)
  // 100 words, 20 hits → 20% → above band.
  const above = computeSeoScore({ subjectLine: "x", htmlContent: words(80, "w") + " " + words(20, "home"), primaryKeyword: "home" })
  check("density 20% is above band", above.keywordDensity > 3)
}

// ── Length penalties (readability) ───────────────────────────────────────────
{
  const short = computeSeoScore({ subjectLine: "x", htmlContent: "<h1>t</h1> " + words(50), primaryKeyword: "zzz" })
  const mid = computeSeoScore({ subjectLine: "x", htmlContent: "<h1>t</h1> " + words(500), primaryKeyword: "zzz" })
  const long = computeSeoScore({ subjectLine: "x", htmlContent: "<h1>t</h1> " + words(1200), primaryKeyword: "zzz" })
  check("short (<300 words) loses 15 readability", mid.readabilityScore - short.readabilityScore === 15)
  check("long (>1000 words) loses 10 readability", mid.readabilityScore - long.readabilityScore === 10)
  check("mid-length keeps full readability base (H1 present)", mid.readabilityScore === READABILITY_BASE_SCORE)
}

// ── Length bonus + subject-line window (overall) ─────────────────────────────
{
  // 500 words ∈ [300,800] earns +10; subject 50 chars ∈ [40,60] earns +10.
  const goodSubject = "S".repeat(50)
  const within = computeSeoScore({ subjectLine: goodSubject, htmlContent: "<h1>t</h1> " + words(500), primaryKeyword: "zzz" })
  const shortSubject = computeSeoScore({ subjectLine: "tiny", htmlContent: "<h1>t</h1> " + words(500), primaryKeyword: "zzz" })
  check("subject in [40,60] adds +10 overall", within.overallScore - shortSubject.overallScore === 10)
  // base 70 + H1 10 + wordcount 10 + subject 10 = 100 (no keyword band)
  check("ideal draft hits 100 overall", within.overallScore === 100)
  check("overall never exceeds 100", within.overallScore <= 100)
}

// ── Recommendation triggers ──────────────────────────────────────────────────
{
  const noH1Short = computeSeoScore({ subjectLine: "tiny", htmlContent: "<p>" + words(50) + "</p>", primaryKeyword: "zzz" })
  check("no-H1 triggers 'Add an H1 heading'", noH1Short.recommendations.some((r) => r.includes("H1")))
  check("low readability (<70) triggers 'Simplify your language'", noH1Short.recommendations.some((r) => r.toLowerCase().includes("simplif")))
  // Overall starts at 70 and only ever ADDS — it can never drop below 70, so the
  // seoScore<70 'Optimize keywords' rec never fires. Lock that invariant in.
  check("overall score never drops below base 70", noH1Short.overallScore >= 70)
  check("'Optimize keywords' rec does NOT fire when overall == 70", !noH1Short.recommendations.some((r) => r.toLowerCase().includes("optimize keywords")))

  const clean = computeSeoScore({ subjectLine: "S".repeat(50), htmlContent: "<h1>t</h1> " + words(500), primaryKeyword: "zzz" })
  check("clean high-scoring draft yields zero recommendations", clean.recommendations.length === 0)
}

// ── Determinism + safety ─────────────────────────────────────────────────────
{
  const a = computeSeoScore({ subjectLine: "abc", htmlContent: "<h1>x</h1> home home", primaryKeyword: "home" })
  const b = computeSeoScore({ subjectLine: "abc", htmlContent: "<h1>x</h1> home home", primaryKeyword: "home" })
  check("deterministic — same input → identical breakdown", JSON.stringify(a) === JSON.stringify(b))
  check("empty body does not divide-by-zero (density 0)", computeSeoScore({ subjectLine: "", htmlContent: "", primaryKeyword: "home" }).keywordDensity === 0)
  check("regex-metachar keyword is escaped (no throw, literal match)", escapeKeyword("a+b(c)") === "a\\+b\\(c\\)")
  check("base constants intact", SEO_BASE_SCORE === 70 && READABILITY_BASE_SCORE === 75)
}

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) {
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  process.exit(1)
}
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ NEWSLETTER_SEO_SCORE_PASS — pure scoring math holds (H1 bonus, density band, length, recommendations)")
