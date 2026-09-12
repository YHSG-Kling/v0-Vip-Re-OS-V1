/**
 * scripts/processing-status-guard.ts
 *
 * test:processing-status — THE SCRAPE LOOP'S GATE HAS ONE VOCABULARY.
 *
 * raw_scraped_leads.processing_status decides a scraped record's whole fate —
 * enriched, promoted, rejected with a reason, or errored. It was the only column
 * on that table with no CHECK constraint (source_family and source_origin both
 * had one), which made it invisible to test:check-vocabulary: that guard works
 * by comparing code literals against the database's admitted set, and a column
 * with no set cannot be covered by it.
 *
 * The list was ALSO already drifting in code. pipeline-processor.ts declared the
 * union; lead-intake-cockpit.ts declared REJECTION_STATUSES separately with the
 * comment "Kept verbatim from ProcessingStatus" — a hand-copied subset. Two
 * hand-maintained lists of one vocabulary is how the next value gets added to
 * one and not the other, and the cockpit silently stops counting a rejection
 * reason it can no longer see.
 *
 * m330 collapsed both onto lib/lead-pipeline/processing-status.ts and generated
 * the CHECK from that same list. This guard keeps the three in agreement.
 */
import { readFileSync, existsSync } from "node:fs"
import { stripComments } from "./strip-comments"
import {
  RAW_PROCESSING_STATUSES, REJECTION_STATUSES, IN_FLIGHT_STATUSES,
  isRawProcessingStatus, isRejectionStatus,
} from "../lib/lead-pipeline/processing-status"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  stripComments(src(p))

const MIGRATION = "supabase/migrations/m330-raw-processing-status-vocabulary.sql"

console.log("\n═══ 1. One list, imported — not three hand-copied ones ═══")
{
  const proc = code("lib/lead-pipeline/pipeline-processor.ts")
  const cockpit = code("lib/kernel/lead-intake-cockpit.ts")

  ok("pipeline-processor no longer declares its own union — that inline list is\n    what the cockpit was hand-copying from",
    !/type ProcessingStatus =\s*\n\s*\|/.test(proc))
  ok("...it imports the shared type", /import type \{ RawProcessingStatus \} from ".\/processing-status"/.test(proc))
  // The import may carry SIBLING symbols from the same vocabulary module — wave
  // 26 added `isRejectionStatus`, the module's own membership test, replacing a
  // local `new Set(REJECTION_STATUSES)` the cockpit was building to ask the same
  // question. The rule is "imported, not re-declared", never "imported alone",
  // and a single-symbol regex turned a §6 consolidation into a red guard.
  ok("the cockpit imports REJECTION_STATUSES rather than re-declaring it",
    /import \{[^}]*\bREJECTION_STATUSES\b[^}]*\} from "@\/lib\/lead-pipeline\/processing-status"/.test(cockpit))
  // POSITIVE CONTROL — the widened matcher still refuses a cockpit that imports
  // nothing from the vocabulary module, which is the defect it exists for.
  ok("CONTROL the matcher still fails a cockpit with no such import",
    !/import \{[^}]*\bREJECTION_STATUSES\b[^}]*\} from "@\/lib\/lead-pipeline\/processing-status"/.test(
      'const REJECTION_STATUSES = ["unassigned_no_market"]',
    ))
  ok("...and the hand-copied literal block is gone",
    !/REJECTION_STATUSES = \[\s*\n\s*"unassigned_no_market"/.test(cockpit))
}

console.log("\n═══ 2. The vocabulary is coherent ═══")
{
  ok("13 statuses", RAW_PROCESSING_STATUSES.length === 13, String(RAW_PROCESSING_STATUSES.length))
  ok("no duplicates", new Set(RAW_PROCESSING_STATUSES).size === RAW_PROCESSING_STATUSES.length)
  ok("every rejection reason is a real status — `satisfies` makes a typo a\n    compile error rather than a silently-uncounted reason",
    REJECTION_STATUSES.every((r) => (RAW_PROCESSING_STATUSES as readonly string[]).includes(r)))
  ok("every in-flight status is a real status",
    IN_FLIGHT_STATUSES.every((r) => (RAW_PROCESSING_STATUSES as readonly string[]).includes(r)))
  ok("in-flight and rejection do not overlap — a record cannot be both moving\n    and stopped",
    !IN_FLIGHT_STATUSES.some((s) => (REJECTION_STATUSES as readonly string[]).includes(s)))
  ok("the terminal pair is outside both sets",
    !(IN_FLIGHT_STATUSES as readonly string[]).includes("promoted") &&
    !(REJECTION_STATUSES as readonly string[]).includes("promoted") &&
    !(REJECTION_STATUSES as readonly string[]).includes("error"))
  ok("in-flight + rejections + promoted + error accounts for ALL 13, so no\n    status is unclassified",
    IN_FLIGHT_STATUSES.length + REJECTION_STATUSES.length + 2 === RAW_PROCESSING_STATUSES.length)

  ok("the type guards agree with the lists",
    isRawProcessingStatus("promoted") && !isRawProcessingStatus("completed") &&
    isRejectionStatus("territory_mismatch") && !isRejectionStatus("promoted"))
}

console.log("\n═══ 3. The DATABASE admits exactly that list ═══")
{
  const mig = src(MIGRATION)
  ok("the migration exists", mig.length > 0, MIGRATION)
  ok("it constrains processing_status", /raw_scraped_leads_processing_status_check/.test(mig))

  for (const s of RAW_PROCESSING_STATUSES) {
    ok(`  the CHECK admits '${s}'`, new RegExp(`'${s}'`).test(mig))
  }

  // The reverse direction: nothing in the CHECK that the code does not know.
  const inCheck = [...mig.matchAll(/^\s*'([a-z_]+)',?$/gm)].map((m) => m[1])
  const unknown = inCheck.filter((v) => !(RAW_PROCESSING_STATUSES as readonly string[]).includes(v))
  ok("...and admits NOTHING the code does not know — a value only the database\n    accepts is a status no reader will ever handle",
    unknown.length === 0, unknown.join(", "))

  ok("NULL is still allowed, because the column has no default and the pipeline\n    sets it on first touch — forcing NOT NULL here would be a separate change",
    /processing_status is null or/.test(mig))
  ok("the migration states it was verified against an EMPTY table, so the\n    constraint cannot invalidate history",
    /empty live/.test(mig))
}

console.log("\n═══ 4. The reason a drifted value is dangerous is recorded ═══")
{
  const mod = src("lib/lead-pipeline/processing-status.ts")
  ok("the module says WHY an unconstrained status loses rows silently",
    /loses the row in silence|LOSES THE ROW IN SILENCE/i.test(mod))
  ok("...and why a read filter on an impossible value reads as 'no data yet'",
    /no data yet/i.test(mod))
  ok("the drift that already existed is named, so nobody re-creates it",
    /hand-copied|Kept verbatim/i.test(mod))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`PROCESSING STATUS — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nAdd a status in lib/lead-pipeline/processing-status.ts AND the m330")
  console.log("CHECK together. One without the other silently loses scraped leads.")
  process.exit(1)
}
console.log("The scrape loop's gate has one vocabulary, and the database enforces it.")
