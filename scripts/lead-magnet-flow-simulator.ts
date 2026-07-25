#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-flow-simulator.ts   (npm run test:lead-magnet-flow)
 * ─────────────────────────────────────────────────────────────────────────────
 * LEAD MAGNETS MUST WORK TOGETHER. The public /lm/[slug] forms used to submit
 * through a THIN action that only inserted a form_submissions row — leaving the
 * whole flow dark (no contact, no delivery, no notification, no sequence). And
 * the agent email notification was a disabled "coming soon" switch. This proves
 * the public capture now runs the ONE kernel flow, and the email notification is
 * real (opt-in via settings.notify_on_submission, delivered by the gated email
 * rail to the agent).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the public capture runs the FULL kernel flow (not a bare insert) ──")
{
  const action = src("app/actions/lead-magnet-capture.ts")
  check("captureFormSubmissionAction delegates to the kernel captureFormSubmission",
    action.includes("captureFormSubmission") && action.includes('from "@/lib/kernel/lead-magnets"'))
  check("it no longer does its own bare form_submissions insert",
    !action.includes('.from("form_submissions")'))
}

console.log("\n── the agent EMAIL notification is real (opt-in, gated rail) ──")
{
  const kernel = src("lib/kernel/lead-magnets.ts")
  check("the form read now includes settings (+ landing_content fallback) for the notify flag",
    /\.select\("[^"]*settings[^"]*landing_content[^"]*"\)/.test(kernel) || /settings, landing_content/.test(kernel))
  check("notify flag read from settings first, landing_content as fallback",
    /notify_on_submission\s*\?\?\s*legacyBag\.notify_on_submission/.test(kernel) || /settingsBag\.notify_on_submission/.test(kernel))
  check("emails the AGENT via the gated dispatchEmail rail",
    kernel.includes("dispatchEmail") && kernel.includes('systemSource:   "lead_magnet_notify"'))
  check("internal transactional send — no contactId (no outbound-to-contact gate), transactional purpose",
    /channelPurpose: "transactional"/.test(kernel))
  check("best-effort — a mail failure never fails the capture the lead completed",
    /if \(notifyByEmail && agentEmail\)[\s\S]*?try \{[\s\S]*?dispatchEmail[\s\S]*?\} catch/.test(kernel))
}

console.log("\n── the builder switch is live and persisted to the settings column ──")
{
  const builder = src("app/components/features/lead-magnets/MagnetBuilder.tsx")
  check("the email switch is enabled (no 'coming soon', not disabled)",
    !builder.includes("coming soon") && /onCheckedChange=\{setNotifyByEmail\}/.test(builder))
  check("handleCreate passes notify_on_submission from the switch",
    /createLeadMagnetAction\(\{[\s\S]*?notify_on_submission: notifyByEmail/.test(builder))

  const action = src("app/actions/lead-magnets-actions.ts")
  check("createLeadMagnetAction persists the flag to the settings column (not landing_content)",
    /\.update\(\{ settings: \{ notify_on_submission/.test(action))

  const snap = src("scripts/schema-snapshot.ts")
  check("lead_capture_forms.settings is in the schema snapshot", /lead_capture_forms:.*"settings"/.test(snap))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ LEAD_MAGNET_FLOW_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_MAGNET_FLOW_PASS — public capture runs the full kernel flow; agent email notification is real + opt-in")
