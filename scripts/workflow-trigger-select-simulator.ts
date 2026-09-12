#!/usr/bin/env tsx
/**
 * scripts/workflow-trigger-select-simulator.ts  (npm run test:workflow-trigger-select)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WORKFLOW/SEQUENCE BUILDERS NO LONGER CRASH ON THE MANUAL TRIGGER.
 * The "Manual Enrollment Only" trigger's canonical value is "" (no auto-fire),
 * but Radix <Select.Item> THROWS on an empty-string value — which took the
 * /dashboard/campaigns/workflows page down entirely ("this page couldn't load —
 * Select.Item must have a value that is not an empty string"). Fix: a shared
 * sentinel (toTriggerSelectValue / fromTriggerSelectValue) renders Manual with a
 * non-empty value and converts back to "" on save. Proves the empty value is
 * never rendered and every trigger dropdown uses the sentinel.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { WORKFLOW_TRIGGERS, toTriggerSelectValue, fromTriggerSelectValue, MANUAL_TRIGGER_VALUE } from "../lib/workflow/triggers"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the sentinel helpers round-trip the empty Manual value ──")
{
  check("Manual's canonical value in the catalog is the empty string",
    WORKFLOW_TRIGGERS.some((t) => t.value === "" && /manual/i.test(t.label)))
  check("toTriggerSelectValue('') → non-empty sentinel", toTriggerSelectValue("") === MANUAL_TRIGGER_VALUE && MANUAL_TRIGGER_VALUE.length > 0)
  check("legacy literal 'manual' also maps to the sentinel", toTriggerSelectValue("manual") === MANUAL_TRIGGER_VALUE)
  check("a real trigger value passes through untouched", toTriggerSelectValue("contact_created") === "contact_created")
  check("fromTriggerSelectValue(sentinel) → '' (canonical stored value)", fromTriggerSelectValue(MANUAL_TRIGGER_VALUE) === "")
  check("fromTriggerSelectValue of a real value passes through", fromTriggerSelectValue("contact_created") === "contact_created")
  // The invariant that matters: NO trigger ever renders as an empty SelectItem value.
  check("every trigger maps to a NON-EMPTY select value",
    WORKFLOW_TRIGGERS.every((t) => toTriggerSelectValue(t.value).length > 0))
}

console.log("\n── every trigger dropdown renders via the sentinel (no raw t.value) ──")
{
  for (const f of [
    "app/dashboard/campaigns/workflows/workflow-builder-client.tsx",
    "app/dashboard/campaigns/sequences/SequencesListClient.tsx",
  ]) {
    const s = src(f)
    check(`${f.split("/").pop()} imports the sentinel helpers`,
      s.includes("toTriggerSelectValue") && s.includes("fromTriggerSelectValue"))
    check(`${f.split("/").pop()} renders trigger SelectItems with toTriggerSelectValue(t.value)`,
      /value=\{toTriggerSelectValue\(t\.value\)\}/.test(s))
    check(`${f.split("/").pop()} converts back with fromTriggerSelectValue on change`,
      s.includes("fromTriggerSelectValue("))
  }
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ WORKFLOW_TRIGGER_SELECT_FAIL"); process.exit(1) }
console.log(" ✅ WORKFLOW_TRIGGER_SELECT_PASS — Manual trigger renders via a sentinel; no empty Select.Item, no crash")
