#!/usr/bin/env tsx
/**
 * scripts/voice-campaign-command-simulator.ts   (npm run test:voice-campaign-command)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the "launch the campaign for <address>" voice command's pure core — picking
 * WHICH of a listing's campaigns to launch when the broker doesn't name a specific one.
 * The launch itself reuses the admin-gated launchMarketingCampaignAction (role + tenant +
 * compliance enforced there), so the testable piece is the deterministic picker.
 *
 *   PURE: pickLaunchableCampaign — most launch-ready status (approved > scheduled >
 *         pending_review > draft), tie-broken by most recent; ignores live/ended/etc.
 */
import { pickLaunchableCampaign, LAUNCHABLE_STATUS_PRIORITY } from "../lib/voice/campaign-command"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[status priority]")
  check("approved beats draft", pickLaunchableCampaign([
    { id: "d", status: "draft", created_at: "2026-06-30" },
    { id: "a", status: "approved", created_at: "2026-06-01" },
  ])?.id === "a")
  check("scheduled beats pending_review", pickLaunchableCampaign([
    { id: "p", status: "pending_review", created_at: "2026-06-30" },
    { id: "s", status: "scheduled", created_at: "2026-06-01" },
  ])?.id === "s")
  check("draft is still launchable when it's the only one", pickLaunchableCampaign([{ id: "d", status: "draft" }])?.id === "d")

  console.log("\n[recency tie-break within a status]")
  check("same status → most recently created wins", pickLaunchableCampaign([
    { id: "old", status: "approved", created_at: "2026-05-01" },
    { id: "new", status: "approved", created_at: "2026-06-20" },
  ])?.id === "new")

  console.log("\n[non-launchable statuses are ignored — never re-launch a live/ended campaign]")
  check("live/ended/paused/archived/failed → null (nothing to launch)", pickLaunchableCampaign([
    { id: "1", status: "live" }, { id: "2", status: "ended" }, { id: "3", status: "paused" },
    { id: "4", status: "archived" }, { id: "5", status: "failed" },
  ]) === null)
  check("empty list → null", pickLaunchableCampaign([]) === null)
  check("a launchable among non-launchable is found", pickLaunchableCampaign([
    { id: "live", status: "live" }, { id: "ok", status: "approved" },
  ])?.id === "ok")

  console.log("\n[invariants]")
  check("priority order is the 4 launchable statuses", LAUNCHABLE_STATUS_PRIORITY.length === 4 && LAUNCHABLE_STATUS_PRIORITY[0] === "approved")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VOICE_CAMPAIGN_COMMAND_FAIL"); process.exit(1) }
  console.log(" ✅ VOICE_CAMPAIGN_COMMAND_PASS — 'launch the campaign for <address>' picks the most launch-ready campaign")
}
main()
