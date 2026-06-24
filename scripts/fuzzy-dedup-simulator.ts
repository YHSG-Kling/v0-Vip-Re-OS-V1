#!/usr/bin/env tsx
/**
 * scripts/fuzzy-dedup-simulator.ts   (npm run test:fuzzy-dedup)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the raw-lead fuzzy dedup can't conflate distinct people who share a name.
 *
 * calculateFuzzyMatch returns a weighted average over the fields PRESENT in both
 * records, so a NAME-ONLY match scores a perfect 1.0 (0.3 / 0.3). findBestMatch used to
 * auto-merge on score alone — so a scraped "John Smith" with no email/phone merged into
 * an existing different "John Smith". isConfidentMatch now requires a STRONG identifier
 * (exact email OR phone) for an auto-merge; name-only matches are never merged (they
 * proceed to enrichment and re-dedup with a real identifier).
 */
import {
  calculateFuzzyMatch,
  isConfidentMatch,
  DEDUP_MERGE_THRESHOLD,
} from "../lib/lead-pipeline/fuzzy-matcher"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const N = (first: string, last: string, email?: string, phone?: string) => ({ first_name: first, last_name: last, email: email ?? null, phone: phone ?? null })

function main(): void {
  console.log(`\n[fuzzy score — the raw similarity (weighted avg over present fields)]`)
  // Name-only exact: score normalizes to a perfect 1.0 — the trap.
  const nameOnly = calculateFuzzyMatch(N("John", "Smith"), N("John", "Smith"))
  check("name-only exact match still SCORES ~1.0 (the misleading signal)", nameOnly.score > 0.99)

  console.log("\n[isConfidentMatch — auto-merge requires a STRONG identifier]")
  check("THE BUG: name-only exact match is NOT a confident merge", isConfidentMatch(nameOnly) === false)

  // Same name, different person's email — must NOT merge.
  const sameNameDiffEmail = calculateFuzzyMatch(N("John", "Smith", "john@a.com"), N("John", "Smith", "john2@b.com"))
  check("same name, DIFFERENT email ⇒ not confident (distinct people protected)", isConfidentMatch(sameNameDiffEmail) === false)

  // Exact email match ⇒ confident (same person).
  const emailMatch = calculateFuzzyMatch(N("John", "Smith", "john@a.com"), N("Jon", "Smith", "john@a.com"))
  check("exact email match (even with a name typo) ⇒ confident merge", isConfidentMatch(emailMatch) === true)

  // Exact phone match (format-insensitive) ⇒ confident.
  const phoneMatch = calculateFuzzyMatch(N("John", "Smith", undefined, "(512) 555-1212"), N("John", "Smith", undefined, "5125551212"))
  check("exact phone match across formats ⇒ confident merge", isConfidentMatch(phoneMatch) === true)

  // Email case/whitespace normalized.
  const emailCase = calculateFuzzyMatch(N("John", "Smith", "  John@A.com "), N("John", "Smith", "john@a.com"))
  check("email match is case/whitespace-insensitive ⇒ confident", isConfidentMatch(emailCase) === true)

  // Name + email both match ⇒ confident, high score.
  const full = calculateFuzzyMatch(N("John", "Smith", "john@a.com"), N("John", "Smith", "john@a.com"))
  check("name + email both match ⇒ confident", isConfidentMatch(full) === true && full.score >= DEDUP_MERGE_THRESHOLD)

  // A different person entirely (different name + email) ⇒ not confident.
  const different = calculateFuzzyMatch(N("Jane", "Doe", "jane@x.com"), N("Bob", "Lee", "bob@y.com"))
  check("totally different records ⇒ not confident", isConfidentMatch(different) === false)

  // Strong identifier but the overall score below threshold (same phone, wildly different name) ⇒ not confident.
  const phoneButDiffName = calculateFuzzyMatch(N("Aaaaaa", "Bbbbbb", undefined, "5551212"), N("Zzzzzz", "Yyyyyy", undefined, "5551212"))
  check("same phone but totally different name ⇒ below threshold ⇒ not auto-merged", isConfidentMatch(phoneButDiffName) === false)

  // Two-pass design: name-only at pre-enrichment defers; with an identifier post-enrichment it merges.
  check("two-pass: name-only pre-enrich is NOT merged (defers to enrichment)",
    isConfidentMatch(calculateFuzzyMatch(N("John", "Smith"), N("John", "Smith", "john@a.com"))) === false)
  check("two-pass: post-enrich with the resolved email DOES merge",
    isConfidentMatch(calculateFuzzyMatch(N("John", "Smith", "john@a.com"), N("John", "Smith", "john@a.com"))) === true)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ FUZZY_DEDUP_FAIL"); process.exit(1) }
  console.log(" ✅ FUZZY_DEDUP_PASS — auto-merge requires a strong identifier (no same-name PII conflation)")
}

main()
