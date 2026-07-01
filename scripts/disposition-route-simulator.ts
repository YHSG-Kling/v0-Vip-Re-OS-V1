#!/usr/bin/env tsx
/**
 * scripts/disposition-route-simulator.ts   (npm run test:disposition-route)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the platform-membership disposition router: broker-side steps (CDA signature, compliance
 * approval, send-back) run IN-APP when the account's brokerage is on the platform, and route OUT to the
 * external form platform when a SOLO agent's brokerage is not a customer. Set explicitly at account
 * creation (brokerages.brokerage_on_platform), never guessed.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveDispositionRoute } from "../lib/platform/disposition-route"
import { summarizeBlockerDiscrepancies } from "../lib/finance/auto-dispute"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function main() {
  console.log("\n[resolveDispositionRoute · pure]")
  check("solo agent + brokerage OFF platform ⇒ route to the external form platform",
    (() => { const r = resolveDispositionRoute({ planTier: "solo_agent", brokerageOnPlatform: false }); return r.route === "external_form_platform" && r.brokerageExternal === true })())
  check("solo agent + brokerage ON platform ⇒ in-app (the brokerage's users sign)",
    resolveDispositionRoute({ planTier: "solo_agent", brokerageOnPlatform: true }).route === "in_app")
  check("team tier ⇒ in-app (the org is the customer)", resolveDispositionRoute({ planTier: "team", brokerageOnPlatform: false }).route === "in_app")
  check("brokerage tier ⇒ in-app", resolveDispositionRoute({ planTier: "brokerage", brokerageOnPlatform: false }).route === "in_app")
  check("multi_location tier ⇒ in-app", resolveDispositionRoute({ planTier: "multi_location", brokerageOnPlatform: false }).route === "in_app")
  check("null plan_tier defaults to solo_agent — off-platform ⇒ external", resolveDispositionRoute({ planTier: null, brokerageOnPlatform: false }).route === "external_form_platform")
  check("null plan_tier + brokerage on platform ⇒ in-app", resolveDispositionRoute({ planTier: null, brokerageOnPlatform: true }).route === "in_app")
  check("brokerageExternal is false for any non-solo tier", resolveDispositionRoute({ planTier: "brokerage", brokerageOnPlatform: false }).brokerageExternal === false)
  check("every decision carries a reason", ["solo_agent", "team", null].every((t) => resolveDispositionRoute({ planTier: t as any, brokerageOnPlatform: false }).reason.length > 0))

  console.log("\n[summarizeBlockerDiscrepancies · pure — autonomous dispute reason]")
  check("no blockers ⇒ null (nothing to dispute)", summarizeBlockerDiscrepancies([{ field: "agent_split", expected: 70, actual: 71, deltaPct: 1, severity: "warning" }]) === null)
  const reason = summarizeBlockerDiscrepancies([{ field: "agent_split", expected: 70, actual: 85, deltaPct: 15, severity: "blocker" }])
  check("a blocker split mismatch ⇒ a human reason (CDA vs contract)", !!reason && /agent split[\s\S]*85%[\s\S]*70%/.test(reason))
  check("empty ⇒ null", summarizeBlockerDiscrepancies([]) === null)

  console.log("\n[wiring — membership set at signup, disposition drives CDA broker-side steps + auto-dispute]")
  const signup = src("app/actions/auth/signup-brokerage.ts")
  check("signup writes brokerage_on_platform / team_on_platform (solo → checkbox, org → true)", /brokerage_on_platform:\s*input\.tier === "solo_agent"/.test(signup))
  const form = src("app/signup/signup-form.tsx")
  check("the signup form shows the membership checkboxes for solo agents", /tier === "solo_agent"[\s\S]*?My brokerage is on the platform/.test(form))

  const portal = src("app/actions/cda-portal.ts")
  check("submit resolves the disposition route", /submitCdaForApprovalAction[\s\S]*?resolveDispositionRoute/.test(portal))
  check("external route → notify the AGENT to route out (not the in-app compliance queue)", /external_form_platform[\s\S]*?cda_route_external/.test(portal))
  check("in-app broker-sign + approve are GUARDED against an external brokerage", (portal.match(/handled_via_external_form_platform/g) ?? []).length >= 2)
  check("submit runs autonomous dispute detection on the verdict discrepancies", /submitCdaForApprovalAction[\s\S]*?autoDetectCommissionDispute/.test(portal))

  const ad = src("lib/finance/auto-dispute.ts")
  check("auto-dispute: in-app → auto-file (status disputed), external → flag the agent", /in_app[\s\S]*?status:\s*"disputed"[\s\S]*?agent_flagged|auto_disputed[\s\S]*?agent_flagged/.test(ad))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ DISPOSITION_ROUTE_FAIL"); process.exit(1) }
  console.log(" ✅ DISPOSITION_ROUTE_PASS — broker-side steps run in-app when the brokerage is on-platform, else route to the external form platform")
}
main()
