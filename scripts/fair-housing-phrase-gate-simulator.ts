#!/usr/bin/env tsx
/**
 * scripts/fair-housing-phrase-gate-simulator.ts  (npm run test:fair-housing-phrase-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FAIR HOUSING GATE WAS OPEN, AND IT LOOKED CLOSED.
 *
 * `prohibited_phrases` held ZERO rows from the day migration 051 created the
 * table. lib/application/compliance-monitoring.ts iterated that empty list and
 * therefore reported EVERY piece of listing and marketing copy as passing —
 * "no children", "adults only", "no Section 8", all unflagged. The seeder that
 * was supposed to fill it (lib/seed-compliance-rules.ts) had no caller, and its
 * 17 Fair Housing rows carried `severity: "blocking"` against a CHECK admitting
 * only {info, warning, critical}, so calling it by hand would have taken a 23514
 * on exactly those 17 rows and seeded only the harmless ones.
 *
 * m450 seeds the catalogue (25 phrases, verbatim from the authored file) and
 * m451 asserts it in the database. THIS guard covers the half a migration
 * cannot: that the seeded patterns actually work when the JavaScript scanner
 * runs them, and that the scanner fails CLOSED when the catalogue is missing.
 *
 * The phrases are read from the m450 migration on disk — the source of truth for
 * what is in the table, which m451 asserts the database still matches. No
 * fixture data: every phrase and pattern below is the shipped one.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { scanForProhibitedPhrases, DB_SEVERITY_TO_ISSUE_GRADE } from "../lib/application/compliance-monitoring"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// ── read the shipped catalogue out of the migration ────────────────────────
const migration = src("supabase/migrations/m450-seed-the-fair-housing-phrase-catalogue-that-has-never-had-a-row.sql")
const valuesBlock = migration.slice(migration.indexOf("\nvalues\n"), migration.indexOf("\non conflict"))
const rows = [...valuesBlock.matchAll(/^\s*\('([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',/gm)].map((m) => ({
  phrase: m[1], phrase_pattern: m[2], category: m[3], severity: m[4],
}))

console.log("\n── the shipped catalogue is real, and every pattern compiles ──")
{
  check(`m450 seeds a catalogue (parsed ${rows.length} phrases)`, rows.length >= 25)
  check("it is mostly Fair Housing, the statutory half",
    rows.filter((r) => r.category === "fair_housing").length >= 10)
  check("every stored severity is one the column CHECK admits",
    rows.every((r) => ["info", "warning", "critical"].includes(r.severity)))
  check("at least one phrase is 'critical' — otherwise nothing can fail a scan",
    rows.some((r) => r.severity === "critical"))

  // A pattern that does not compile throws out of `new RegExp` and takes the
  // WHOLE scan down, not just its own phrase.
  const uncompilable = rows.filter((r) => { try { new RegExp(r.phrase_pattern, "gi"); return false } catch { return true } })
  check("every pattern compiles as a JavaScript RegExp", uncompilable.length === 0)
  if (uncompilable.length) console.log("      " + uncompilable.map((r) => r.phrase).join(", "))

  // A pattern that cannot match its own phrase is decorative — it would sit in
  // the catalogue looking like coverage and flag nothing.
  const selfBlind = rows.filter((r) => !new RegExp(r.phrase_pattern, "gi").test(r.phrase))
  check("every pattern matches its own phrase", selfBlind.length === 0)
  if (selfBlind.length) console.log("      " + selfBlind.map((r) => `${r.phrase} !~ ${r.phrase_pattern}`).join("; "))
}

console.log("\n── the REAL scanner, over the REAL catalogue, on real listing copy ──")
{
  // Copy of the kind an agent actually writes, carrying four protected-class
  // violations. Every one of these was silently approved before m450.
  const violating = [
    "Charming 3BR colonial in a quiet cul-de-sac. Perfect for families and close to church,",
    "with a spacious master bedroom and a finished basement that makes a great man cave.",
    "Adults only, please — no Section 8.",
  ].join(" ")

  const issues = scanForProhibitedPhrases(rows, violating)
  const blocking = issues.filter((i) => i.severity === "blocking")

  check("the scan finds the violations", issues.length >= 4)
  check("at least one is graded BLOCKING — this is what makes passed:false",
    blocking.length >= 1)
  check("'perfect for families' is caught", issues.some((i) => i.found === "perfect for families"))
  check("'adults only' is caught", issues.some((i) => i.found === "adults only"))
  check("'close to church' is caught", issues.some((i) => i.found === "close to church"))
  check("'no Section 8' is caught", issues.some((i) => i.found === "no Section 8"))
  check("the non-blocking ones are still reported, not dropped",
    issues.some((i) => i.found === "master bedroom" && i.severity === "warning"))

  // This is the exact expression scanContentComplianceService uses for `passed`,
  // and the exact one submitContentForApprovalService turns into
  // status "pending" vs "needs_revision".
  check("the copy would be routed to needs_revision, not auto-approved",
    !(issues.filter((i) => i.severity === "blocking").length === 0))

  // Clean copy must still pass — a gate that fails everything is as useless as
  // one that passes everything.
  const clean = "Charming 3BR colonial on a quiet cul-de-sac, with a renovated kitchen, " +
    "a finished lower level and a fenced yard. Walkable to the town green."
  check("clean listing copy produces no issues at all", scanForProhibitedPhrases(rows, clean).length === 0)
}

console.log("\n── the two severity vocabularies are reconciled at the boundary ──")
{
  check("'critical' (what the column stores) becomes 'blocking' (what decides pass/fail)",
    DB_SEVERITY_TO_ISSUE_GRADE.critical === "blocking")
  const passthrough = scanForProhibitedPhrases(
    [{ phrase: "x", phrase_pattern: "x", category: "c", severity: "warning" }], "x")
  check("'warning' and 'info' pass through unchanged", passthrough[0].severity === "warning")
  check("an unmapped severity is not silently upgraded to blocking",
    scanForProhibitedPhrases(
      [{ phrase: "x", phrase_pattern: "x", category: "c", severity: "info" }], "x")[0].severity === "info")
}

console.log("\n── the service fails CLOSED when it cannot read the catalogue ──")
{
  const svc = src("lib/application/compliance-monitoring.ts")
  const fn = svc.slice(svc.indexOf("export async function scanContentComplianceService"))

  // supabase-js RESOLVES a failed query: without `error` destructured, a denial
  // arrives as `data: null` and reads as "nothing prohibited found".
  check("the catalogue read destructures error, so a denial is not read as a clean scan",
    /from\("prohibited_phrases"\)[\s\S]{0,200}?/.test(fn) && /error:\s*phrasesError/.test(fn))
  check("a failed read throws instead of continuing", /if \(phrasesError\)[\s\S]{0,300}?throw new Error/.test(fn))
  check("an EMPTY catalogue throws too — zero rows is a gate that says yes to everything",
    /length === 0\)[\s\S]{0,400}?throw new Error/.test(fn))
  check("the service uses the shared scanner rather than a second copy of the loop",
    /scanForProhibitedPhrases\(prohibitedPhrases,/.test(fn))
  check("pass/fail is still decided on the 'blocking' grade the mapping produces",
    /passed: issues\.filter\(\(i\) => i\.severity === "blocking"\)\.length === 0/.test(svc))
}

console.log("\n── the AI-chat lane reads the SAME catalogue and had the SAME defects ──")
{
  // checkMessageCompliance ran its own copy of the scan and inherited both:
  // it graded on `severity === "blocking"` against {info, warning, critical},
  // and it swallowed the read error. sendMessage turns its verdict into
  // `compliance_flagged`, so a Fair Housing violation was stored UNFLAGGED.
  const chat = src("app/actions/ai-chat.ts")
  const fn = chat.slice(chat.indexOf("async function checkMessageCompliance"), chat.indexOf("// AI RESPONSE GENERATION"))

  check("it uses the shared scanner, not a second copy of the loop",
    /scanForProhibitedPhrases\(prohibitedPhrases, message\)/.test(fn) &&
    /import \{ scanForProhibitedPhrases \} from "@\/lib\/application\/compliance-monitoring"/.test(chat))
  check("no second inline RegExp loop survives over the catalogue",
    !/prohibitedPhrases\?\.forEach/.test(fn))
  check("the catalogue read destructures error", /error: phrasesError/.test(fn))
  // This lane FLAGS rather than blocks, so failing closed means raising an issue
  // that makes `passed` false — not throwing and killing the send.
  check("an unreadable or empty catalogue raises a blocking issue instead of passing silently",
    /if \(phrasesError \|\| !prohibitedPhrases \|\| prohibitedPhrases\.length === 0\)[\s\S]{0,400}?severity: "blocking"/.test(fn))
  check("its verdict still drives compliance_flagged on the stored message",
    /compliance_flagged: !complianceCheck\.passed/.test(chat))
}

console.log("\n── the rest of the authored catalogue was merged forward, not dropped ──")
{
  // Auditing lib/seed-compliance-rules.ts FOR DELETION is what surfaced these.
  // Merge first, delete second — the file is gone only because m452 carries them.
  const m452 = src("supabase/migrations/m452-the-suggested-alternative-the-scanner-already-reads-and-the-disclosures-that-are-checkable.sql")

  check("suggested_alternative — a column both readers already emit — is created",
    /add column if not exists suggested_alternative text/.test(m452))
  const alts = [...m452.matchAll(/^\s*\('([^']*)',\s*'((?:[^']|'')*)'\),?$/gm)]
  check(`enough phrases get an alternative to be worth rendering (${alts.length})`, alts.length >= 15)
  check("the scanner surfaces it on every hit",
    /suggestedAlternative: phrase\.suggested_alternative/.test(src("lib/application/compliance-monitoring.ts")))
  check("the AI-chat lane surfaces it too",
    /alternative: hit\.suggestedAlternative/.test(src("app/actions/ai-chat.ts")))
  // Two real screens render it, and both were guaranteed blank because the
  // column did not exist. This is the screen effect of m452.
  check("the submit-content screen renders 'Try instead: …'",
    /issue\.suggestedAlternative/.test(src("app/components/shared/compliance/submit-content-form.tsx")))
  check("the pending-approvals screen renders 'Suggestion: …'",
    /issue\.suggestedAlternative/.test(src("app/components/shared/compliance/pending-approvals-list.tsx")))

  // required_disclosures was the OTHER empty catalogue — same `|| []` shape, so
  // the missing-disclosure warning had never fired either.
  const discs = [...m452.matchAll(/^\s*\('([a-z_]+)',\n\s*'((?:[^']|'')*)',/gm)].map((m) => ({ type: m[1], text: m[2] }))
  check(`the disclosure catalogue is seeded (${discs.length} rows)`, discs.length >= 3)
  check("equal_housing is among them — the row with statutory force",
    discs.some((d) => d.type === "equal_housing"))
  // The reader tests contentBody.includes(disclosure_text), so a LABEL like
  // "Brokerage Name Required" would warn on 100% of content forever. m452 leaves
  // the two per-tenant placeholders out on purpose; this pins that they stay out.
  check("no seeded disclosure text is a placeholder rather than the literal itself",
    discs.every((d) => d.text.length >= 8 && !/required|placeholder|TBD/i.test(d.text)))

  check("m453 asserts both halves in the database",
    src("supabase/migrations/m453-assert-the-alternative-is-reachable-and-the-disclosure-check-can-fire.sql")
      .includes("suggested_alternative"))
  check("the superseded seeder is gone",
    !existsSync(join(process.cwd(), "lib/seed-compliance-rules.ts")))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ FAIR_HOUSING_PHRASE_GATE_FAIL"); process.exit(1) }
console.log(" ✅ FAIR_HOUSING_PHRASE_GATE_PASS — the phrase catalogue has rows, every pattern works, violating copy is blocked, and an unreadable catalogue fails closed")
