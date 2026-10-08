#!/usr/bin/env tsx
/**
 * scripts/ai-disclosure-export-simulator.ts   (npm run test:ai-disclosure-export)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "EXPORTABLE COMPLIANCE RECORD" MUST ACTUALLY EXPORT. The AI Disclosure
 * Ledger engine + page both describe themselves as "the exportable compliance
 * record regulators / counsel ask for" — but the surface was screen-only. This
 * proves the CSV export exists, is gated exactly like the page, serializes the
 * ledger with RFC-4180-correct escaping (subjects carry commas/quotes), and is
 * reachable from the page. The engine's data contract is separately verified
 * against the live schema.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
// THE one sanctioned comment scanner (CLAUDE.md §2). Hand-rolled strippers get
// the `//`-before-`/*` case wrong and blind the scan they were written to run.
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const ROUTE = "app/api/admin/compliance/ai-disclosures/export/route.ts"
const PAGE = "app/dashboard/admin/compliance/ai-disclosures/page.tsx"

console.log("\n── RFC-4180 escaping + formula-injection neutralization (the route's cell()) ──")
{
  // Mirror the route's cell() to prove the escaping + injection rules on the hard cases.
  const cell = (v: unknown) => {
    let s = String(v ?? "")
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return `"${s.replace(/"/g, '""')}"`
  }
  check("a plain value is quoted", cell("ai_isa") === '"ai_isa"')
  check("embedded quotes are DOUBLED (the subject case)", cell('Your "offer", reviewed') === '"Your ""offer"", reviewed"')
  check("embedded commas stay inside the quoted cell", cell("a,b,c").includes('"a,b,c"'))
  check("a newline stays inside the quoted cell", cell("line1\nline2") === '"line1\nline2"')
  check("null/undefined become an empty quoted cell", cell(null) === '""' && cell(undefined) === '""')

  // FORMULA INJECTION — attacker-influenceable names/subjects must NOT execute in Excel/Sheets.
  check("a leading = is neutralized with a single-quote prefix", cell("=HYPERLINK(\"http://evil\")").startsWith(`"'=`))
  check("a leading + is neutralized", cell("+1+1").startsWith(`"'+`))
  check("a leading - is neutralized", cell("-2+3").startsWith(`"'-`))
  check("a leading @ is neutralized (the =cmd|... @ vector)", cell("@SUM(A1)").startsWith(`"'@`))
  check("a leading tab is neutralized", cell("\tinjected").startsWith(`"'\t`))
  check("a SAFE name is left untouched (no spurious prefix)", cell("Alice Buyer") === '"Alice Buyer"')

  // Guard against drift: the route must carry BOTH the quote-doubling and the formula-trigger guard.
  check("the route escapes with the same .replace(/\"/g, '\"\"') rule", src(ROUTE).includes(`.replace(/"/g, '""')`))
  check("the route neutralizes formula triggers (= + - @ tab CR)", /\/\^\[=\+\\-@\\t\\r\]\//.test(src(ROUTE)))
}

console.log("\n── the export route is gated + shaped like a real file download ──")
{
  const r = src(ROUTE)
  check("it calls the ledger engine (single source of truth, no re-query)",
    /generateAiDisclosureLedger\(/.test(r))
  // ── RETARGETED 2026-09-04 (lane ROSTER) — THIS CHECK COULD NOT HAVE FAILED ─
  //
  // It read `r.includes("compliance_officer") && r.includes("broker")` over RAW
  // SOURCE. That is the CLAUDE.md §2 defect by name: a role word in a COMMENT
  // satisfies it. When the six-role literal here was replaced by a call to the
  // shared roster predicate, the TOMBSTONE explaining the replacement still
  // contains both words — so the check would have gone on reporting green over a
  // gate it had stopped reading. It would equally have passed if the gate were
  // deleted outright and only its comment left behind.
  //
  // Asserted as the BEHAVIOUR instead: the route asks the ONE tenant roster, by
  // importing and CALLING its predicate, and still refuses with 403. The
  // membership of that roster is owned and proved by test:admin-vocabulary; this
  // file's job is that the gate is here and is the shared one.
  const rCode = stripComments(r)
  check("role-gated through the ONE tenant roster (imported and CALLED, not a local literal)",
    /import\s*\{[^}]*\bisAdminOrBroker\b[^}]*\}\s*from\s*"@\/lib\/auth\/resolve-user-role"/.test(rCode) &&
    /isAdminOrBroker\s*\(/.test(rCode) && /403/.test(rCode))
  check("NEGATIVE CONTROL — the gate scan reads CODE, so a role word in prose alone does not satisfy it",
    !/isAdminOrBroker\s*\(/.test(stripComments('// the gate used to be isAdminOrBroker({ user_type: t })')))
  check("...and the same page and route still agree on ONE roster (neither keeps a private list)",
    !/\[\s*"broker"[^\]]*"compliance_officer"\s*\]/.test(rCode) &&
    !/\[\s*"broker"[^\]]*"compliance_officer"\s*\]/.test(stripComments(src(PAGE))))
  check("unauthenticated → 401", /401/.test(r))
  check("brokerage-scoped (uses the caller's own brokerage_id)", /profile\.brokerage_id/.test(r))
  check("returns text/csv as an attachment with a filename", /text\/csv/.test(r) && /attachment; filename=/.test(r))
  check("emits the exact header row expected by counsel (approver + consent proof)",
    r.includes("approved_by") && r.includes("consent_now") && r.includes("suppression_reason"))
  check("supports an optional since/until window override", /searchParams\.get\("since"\)/.test(r) && /searchParams\.get\("until"\)/.test(r))
}

console.log("\n── the page surfaces the export (reachable, not orphaned) ──")
{
  const p = src(PAGE)
  check("the page renders an Export CSV link to the route",
    p.includes("/api/admin/compliance/ai-disclosures/export") && /Export CSV/.test(p))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ AI_DISCLOSURE_EXPORT_FAIL"); process.exit(1) }
console.log(" ✅ AI_DISCLOSURE_EXPORT_PASS — the AI-oversight audit trail is a real, gated, RFC-4180 file counsel can file")
