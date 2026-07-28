#!/usr/bin/env tsx
/**
 * scripts/onboarding-ops-simulator.ts   (npm run test:onboarding-ops)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE ROSTER, AND ACTIONS THAT ACT.
 *
 * Two broker-facing surfaces read agent onboarding — the Onboarding Operations
 * console and the agent roster table — and they had drifted into two different
 * answers to the same question. The console filtered `status === 'stalled'`.
 * agent_onboarding.status has a live CHECK admitting exactly in_progress /
 * completed / paused, so that value can never be stored: its "Stalled" card was
 * permanently 0 and the intervention branch behind it was unreachable. The
 * roster table had the honest rule (in_progress + no step completion in 7 days).
 *
 * Everything the console offered to DO was also inert: the Actions tab rendered
 * a batch panel over a selection nothing populated, wired to a handler whose
 * body was a comment saying the panel handled it, and Quick Actions was three
 * buttons with no onClick at all. Two of four command-strip links were 404s.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { isOnboardingStalled, STALL_AFTER_DAYS } from "../lib/onboarding/onboarding-roster"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/**
 * Every check below reads CODE, not commentary. These files explain the defects
 * they fixed, and those explanations quote the exact strings being asserted
 * absent — without this, the guard would flag its own documentation.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
const src = (p: string) => stripComments(raw(p))
const exists = (p: string) => existsSync(join(process.cwd(), p))

const NOW = new Date("2026-07-28T12:00:00Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString()

console.log("\n── the stall rule is DERIVED, and lives in one place ──")
{
  check("in_progress with no activity at all is stalled",
    isOnboardingStalled("in_progress", null, NOW) === true)
  check(`in_progress with activity older than ${STALL_AFTER_DAYS}d is stalled`,
    isOnboardingStalled("in_progress", daysAgo(STALL_AFTER_DAYS + 1), NOW) === true)
  check("in_progress with recent activity is NOT stalled",
    isOnboardingStalled("in_progress", daysAgo(1), NOW) === false)
  check("a COMPLETED onboarding is never stalled (it is done)",
    isOnboardingStalled("completed", null, NOW) === false)
  check("a PAUSED onboarding is never stalled (it was paused deliberately)",
    isOnboardingStalled("paused", null, NOW) === false)

  const roster = src("lib/onboarding/onboarding-roster.ts")
  check("the roster hops agents.user_id → users (agent_onboarding.agent_id is an agents.id)",
    /\.from\("agents"\)[\s\S]{0,120}?select\("id, user_id"\)/.test(roster) &&
    /userIdByAgentId/.test(roster))

  // The literal that could never match. Neither surface may filter on it again.
  const console_ = src("app/dashboard/admin/onboarding/page.tsx")
  const table = src("app/dashboard/onboarding/admin/agents/page.tsx")
  check("no surface filters agent_onboarding on the impossible status 'stalled'",
    !/status\s*===\s*["']stalled["']/.test(console_) && !/status\s*===\s*["']stalled["']/.test(table) &&
    !/status["']?\s*,\s*["']stalled["']/.test(console_))
  check("both broker surfaces load the SAME roster",
    console_.includes("loadOnboardingRoster") && table.includes("loadOnboardingRoster"))
  check("the roster page no longer carries its own copy of the loader",
    !table.includes("getAdminOnboardingData"))
}

console.log("\n── the Actions tab actually acts ──")
{
  const panel = src("app/dashboard/admin/onboarding/components/os/onboarding-batch-actions-panel.tsx")
  check("the batch panel loads a REAL agent list (not a permanent empty state)",
    panel.includes("listOnboardingAgentsAction") &&
    !panel.includes("Select agents from the overview to perform batch actions"))
  check("selection is populated by the panel itself, so the button can enable",
    /onCheckedChange=\{\(\) => toggle\(a\.agentId\)\}/.test(panel))
  check("the nudge calls the real server action",
    panel.includes("nudgeOnboardingAgentsAction"))
  check("a destructive-feeling batch send is confirmed before it fires",
    panel.includes("AlertDialog") && /AlertDialogAction onClick=\{handleNudge\}/.test(panel))
  check("agents with no linked user account are shown as such, not silently dropped",
    panel.includes("No user account") && panel.includes("skipped"))
  check("no 'Enroll in Training' button without an enrolment backend",
    !panel.includes("Enroll in Training"))

  const client = src("app/dashboard/admin/onboarding/admin-onboarding-os-client.tsx")
  check("the no-op onBatchAction handler is gone",
    !client.includes("Batch actions handled by OnboardingBatchActionsPanel"))
  check("Quick Actions hands its selection to the Actions tab",
    client.includes("handleOpenBatchActions") && client.includes("setActiveTab('actions')"))

  const stack = src("app/dashboard/admin/onboarding/components/os/onboarding-action-stack.tsx")
  const buttons = (stack.match(/<Button/g) ?? []).length
  const handlers = (stack.match(/onClick=/g) ?? []).length
  check(`every Quick Actions button has an onClick (${handlers}/${buttons})`, handlers === buttons)
}

console.log("\n── the command strip points at routes that exist ──")
{
  const strip = src("app/dashboard/admin/onboarding/components/os/onboarding-command-strip.tsx")
  const hrefs = [...strip.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
  check(`${hrefs.length} links, and every one resolves to a page file`,
    hrefs.length > 0 &&
    hrefs.every((h) => exists(`app${h}/page.tsx`)),
    )
  check("the two 404s are gone",
    !strip.includes("/dashboard/admin/onboarding/reports") &&
    !strip.includes("/dashboard/admin/onboarding/assignments"))
}

console.log("\n── the nudge write matches the live CHECK vocabularies ──")
{
  const action = src("app/actions/onboarding/onboarding-ops.ts")
  check("notifications.channel ∈ (in_app, email, sms) — writes 'in_app'",
    /channel: "in_app"/.test(action))
  check("notifications.priority ∈ (low, medium, high, critical) — writes 'medium'",
    /priority: "medium"/.test(action))
  check("notifications.user_id is a users(id) FK — the roster's resolved userId is used",
    /user_id: a\.userId/.test(action))
  check("admin/broker gated, and the target agents are re-read from the caller's brokerage",
    action.includes("requireOnboardingOps") && /loadOnboardingRoster\(svc, auth\.brokerageId\)/.test(action))
}

console.log("\n── the unwired twin of this whole surface is gone ──")
{
  check("app/dashboard/onboarding/components/os no longer exists",
    !exists("app/dashboard/onboarding/components/os/index.ts"))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ ONBOARDING_OPS_FAIL"); process.exit(1) }
console.log(" ✅ ONBOARDING_OPS_PASS — one roster, one stall rule, and every action on the console does something")
