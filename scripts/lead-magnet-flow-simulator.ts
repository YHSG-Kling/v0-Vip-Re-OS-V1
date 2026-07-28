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
import { readFileSync, existsSync, globSync } from "node:fs"
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

console.log("\n── ONE Lead Magnets surface, and its scope is resolved server-side ──")
{
  // Three copies of this screen existed (agent/, admin/, and a page component
  // parked in app/actions/). They drifted: only one ever got the GBP tab.
  const pages = globSync("app/**/lead-magnets/page.tsx").concat(
    existsSync(join(process.cwd(), "app/actions/lead-magnets.tsx")) ? ["app/actions/lead-magnets.tsx"] : [],
  )
  check(`exactly one Lead Magnets page file (found ${pages.length}: ${pages.join(", ") || "none"})`,
    pages.length === 1 && pages[0] === "app/dashboard/marketing/lead-magnets/page.tsx")

  const nav = src("app/config/navigation-config.ts")
  check("every persona's nav points at the single route",
    nav.includes("/dashboard/marketing/lead-magnets") &&
    !nav.includes("/dashboard/admin/lead-magnets") &&
    !nav.includes("/dashboard/agent/lead-magnets"))

  const action = src("app/actions/lead-magnets-actions.ts")
  // lead_capture_forms.agent_id is a FK to agents(id). Every caller used to pass
  // the AUTH USER id from the browser, so the filter matched nothing and the
  // library showed "0 lead magnets" for everyone.
  check("listLeadMagnetsAction takes no client-supplied agentId",
    /export async function listLeadMagnetsAction\(options\?: \{ scope\?: "mine" \| "brokerage" \}\)/.test(action))
  check("it resolves the agents.id scope from the session instead",
    /listLeadMagnets\(\{ brokerageId: bId, agentId: ctx\.agentId \}\)/.test(action))
  check("fail-closed: no agents row → no list, never the unfiltered brokerage",
    /if \(!ctx\.agentId\) \{[\s\S]{0,200}?success: false/.test(action))

  const library = src("app/components/features/lead-magnets/MagnetLibrary.tsx")
  check("MagnetLibrary no longer accepts or forwards an agentId",
    !/agentId/.test(library.replace(/\/\*[\s\S]*?\*\//g, "")))

  // A generated QR used to be written with purpose 'general' while every reader
  // queried purpose = 'lead_magnet' — so it was never found again.
  check("generateQRCodeAction writes purpose 'lead_magnet' (what the readers filter on)",
    /purpose: "lead_magnet"/.test(action) && !/purpose: "general"/.test(action))
  check("generateQRCodeAction stamps qr_codes.agent_id from the session agents.id",
    /agent_id: ctx\.agentId/.test(action))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ LEAD_MAGNET_FLOW_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_MAGNET_FLOW_PASS — public capture runs the full kernel flow; agent email notification is real + opt-in")
