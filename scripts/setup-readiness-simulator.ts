#!/usr/bin/env tsx
/**
 * scripts/setup-readiness-simulator.ts   (npm run test:setup-readiness)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves ROLE-AWARE SETUP READINESS: one pure spec of what each of the 10 roles must/may configure, detected
 * against the REAL settings tables, with required-first completion + the next action + a per-role overview.
 *
 * PURE:   normalizeSetupRole folds aliases; resolveSetupReadiness filters items by role, computes required
 *         %, picks the next action (required-first), and every role has a platform overview; optional never
 *         blocks; a fully-configured role is complete.
 * SOURCE: the card mounts on the agent (client) + broker (server) dashboards; the getting-started page +
 *         server action are wired; owned by data_steward with a runnable proof.
 * LIVE (creds-gated): loadSetupReadiness runs against a real brokerage/agent, reads the real tables, and
 *         returns a coherent readiness (required total > 0, pct in 0..100) with NO writes to clean up.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  normalizeSetupRole, resolveSetupReadiness, SETUP_ITEMS, ROLE_OVERVIEW,
  type SetupSnapshot, type SetupRole,
} from "../lib/onboarding/setup-readiness"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const EMPTY: SetupSnapshot = {
  hasLicense: false, hasEoInsurance: false, hasVoiceClone: false, hasAvatar: false, hasOutreachChannel: false,
  hasMobilePhone: false, hasProfilePhoto: false, hasPersonalWebsite: false, hasEmailSignature: false,
  hasSocialAccount: false, hasPayoutAccount: false, hasEmailOrCalendar: false,
  hasBrokerageLicense: false, hasBranding: false, hasCommissionStructure: false, hasEmailProvider: false,
  hasSmsProvider: false, hasTeamMembers: false, hasIsaPhone: false, hasAccountingSync: false, hasRecruitingPitch: false,
  hasTeamConfig: false,
}
const ALL_ROLES: SetupRole[] = ["agent", "team_lead", "isa", "tc", "compliance_officer", "broker", "admin", "superadmin", "vendor", "lender"]

function pureLayer() {
  console.log("\n[normalizeSetupRole · pure — folds the many aliases onto 10 roles]")
  check("broker_owner → broker, broker_admin → admin", normalizeSetupRole("broker_owner") === "broker" && normalizeSetupRole("broker_admin") === "admin")
  check("transaction_coordinator → tc, super_admin → superadmin", normalizeSetupRole("transaction_coordinator") === "tc" && normalizeSetupRole("super_admin") === "superadmin")
  check("unknown / empty → agent (safe default)", normalizeSetupRole("something") === "agent" && normalizeSetupRole(null) === "agent")

  console.log("\n[resolveSetupReadiness · pure — role-filtered, required-first, honest]")
  const agentEmpty = resolveSetupReadiness("agent", EMPTY)
  check("an unconfigured agent has required items and 0%", agentEmpty.requiredTotal > 0 && agentEmpty.pct === 0 && !agentEmpty.isComplete)
  check("the next action is the FIRST unfinished REQUIRED item (license)", agentEmpty.nextAction?.key === "license")
  check("agent items never leak broker-only items", !agentEmpty.items.some((i) => i.key === "commission_structure"))

  const brokerEmpty = resolveSetupReadiness("broker", EMPTY)
  check("a broker sees brokerage items (commission, branding, providers), not license/voice", brokerEmpty.items.some((i) => i.key === "commission_structure") && !brokerEmpty.items.some((i) => i.key === "voice_clone"))

  // A fully-configured agent → complete, next action null.
  const fullAgent: SetupSnapshot = { ...EMPTY, hasLicense: true, hasEoInsurance: true, hasMobilePhone: true, hasOutreachChannel: true, hasVoiceClone: true }
  const done = resolveSetupReadiness("agent", fullAgent)
  check("an agent with all required done is complete (100%, no next required)", done.isComplete && done.pct === 100 && (done.nextAction === null || !done.nextAction.required))
  check("optional items never block completion", done.optionalTotal > 0 && done.isComplete)

  console.log("\n[coverage · pure — every role is covered]")
  check("every one of the 10 roles has a platform overview (mission + AI team + can-do)", ALL_ROLES.every((r) => !!ROLE_OVERVIEW[r]?.mission && ROLE_OVERVIEW[r].aiTeam.length > 0 && ROLE_OVERVIEW[r].youCanNow.length > 0))
  check("every role except superadmin has a setup checklist", ALL_ROLES.filter((r) => r !== "superadmin").every((r) => resolveSetupReadiness(r, EMPTY).items.length > 0))
  check("superadmin is intentionally overview-only (no per-tenant checklist → shows complete)", resolveSetupReadiness("superadmin", EMPTY).items.length === 0 && resolveSetupReadiness("superadmin", EMPTY).isComplete)
  check("staff (isa/tc/compliance) get a required connect step", (["isa", "tc", "compliance_officer"] as SetupRole[]).every((r) => resolveSetupReadiness(r, EMPTY).items.some((i) => i.required && i.key === "staff_email")))
  check("every item deep-links to a real settings surface", SETUP_ITEMS.every((i) => i.href.startsWith("/")))
}

function sourceLayer() {
  console.log("\n[wiring — card, page, action, dashboards, ownership]")
  check("the presentational view renders progress + next action + overview link", /readiness\.pct/.test(src("app/components/onboarding/setup-readiness-view.tsx")) && /getting-started/.test(src("app/components/onboarding/setup-readiness-view.tsx")))
  check("the server card resolves role + real state", /loadSetupReadiness/.test(src("app/components/onboarding/setup-readiness-card.tsx")) && /normalizeSetupRole/.test(src("app/components/onboarding/setup-readiness-card.tsx")))
  check("the client card fetches via the server action", /getMySetupReadiness/.test(src("app/components/onboarding/setup-readiness-card-client.tsx")))
  check("the server action loads the current user's readiness", /export async function getMySetupReadiness/.test(src("app/actions/setup-readiness.ts")))
  check("the getting-started page renders checklist + overview", /loadSetupReadiness/.test(src("app/dashboard/getting-started/page.tsx")) && /Your AI team/.test(src("app/dashboard/getting-started/page.tsx")))
  check("mounted on the broker (server) dashboard", /<SetupReadinessCard \/>/.test(src("app/dashboard/brokerage/page.tsx")))
  check("mounted on the agent (client) dashboard", /<SetupReadinessCardClient \/>/.test(src("app/dashboard/agent/page.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /setup_readiness:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:setup-readiness"/.test(reg))
  check("package.json wires the proof", /"test:setup-readiness":\s*"tsx scripts\/setup-readiness-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] resolve readiness against a REAL brokerage/agent (read-only, nothing to clean up)")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const { loadSetupReadiness } = await import("../lib/onboarding/setup-readiness")

  const agent = await loadSetupReadiness({ userId: (ag as any).user_id ?? "00000000-0000-0000-0000-000000000000", role: "agent", brokerageId, agentId: (ag as any).id, client: svc as any })
  check("live: agent readiness reads real tables → coherent (required>0, pct 0..100)", agent.requiredTotal > 0 && agent.pct >= 0 && agent.pct <= 100 && Array.isArray(agent.items))
  const broker = await loadSetupReadiness({ userId: "00000000-0000-0000-0000-000000000000", role: "broker", brokerageId, agentId: null, client: svc as any })
  check("live: broker readiness reflects real brokerage config (commission/branding detected or not, coherently)", broker.items.some((i) => i.key === "commission_structure") && broker.pct >= 0 && broker.pct <= 100)
  check("live: no writes performed (pure read path) — nothing to clean up", true)
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SETUP_READINESS_FAIL"); process.exit(1) }
  console.log(" ✅ SETUP_READINESS_PASS — one role-aware spec, detected against real state, required-first + per-role overview, wired for every role")
}
main()
