#!/usr/bin/env tsx
/**
 * scripts/integration-status-simulator.ts   (npm run test:integration-status) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * CONNECTING A BROKERAGE CRM COULD NOT SUCCEED.
 *
 * brokerage_integrations.status carries a live CHECK:
 *
 *   CHECK (status = ANY (ARRAY['connected','error','not_configured']))
 *
 * There is no 'active'. `connectCrmAction` upserted exactly that:
 *
 *     .upsert({ …, status: 'active', … })
 *     if (intErr) return { ok: false, error: intErr.message }
 *
 * Verified live: the insert raises check_violation. The credential upsert runs
 * FIRST and succeeds, so a brokerage that clicked Connect ended with the CRM
 * credential stored, no integration row, and an error message — a half-connected
 * state with no way to tell from the UI which half landed.
 *
 * Three reads asked for the same impossible value:
 *
 *   app/actions/crm-connect.ts (getCrmStatus)   → always reported no active CRM
 *   lib/crm/sync.ts                             → never resolved a brokerage-level
 *                                                 provider, always fell back
 *   lib/workflow/adapters/schedule-showing.ts   → never found the ShowingTime API
 *                                                 key, always took the manual path
 *
 * Measured live with a probe integration row stored as 'connected':
 * the old filter returned 0, the corrected one 1.
 *
 * The rest of the codebase already had this right — the OAuth callback writes
 * 'connected', and onboarding's tech-stack surface even had the correct union
 * typed inline. That inline union now comes from the one module too.
 */
import { readFileSync } from "node:fs"
import {
  INTEGRATION_STATUSES,
  INTEGRATION_STATUS_CONNECTED,
  INTEGRATION_STATUS_NOT_CONFIGURED,
  INTEGRATION_STATUS_ERROR,
  isIntegrationConnected,
} from "../lib/integrations/integration-status"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

console.log("\n── the module matches the live CHECK ──")
{
  const live = CHECK_VOCABULARIES.brokerage_integrations?.status ?? []
  check(`the snapshot carries 3 statuses (${live.join(", ")})`, live.length === 3)
  check("every status the module declares is admitted",
    INTEGRATION_STATUSES.every((s) => live.includes(s)))
  check("every status the CHECK admits is declared",
    live.every((s) => (INTEGRATION_STATUSES as readonly string[]).includes(s)))
  check("'active' is NOT admitted — this is the whole bug", !live.includes("active"))
  check("the three named constants are all real values",
    [INTEGRATION_STATUS_CONNECTED, INTEGRATION_STATUS_NOT_CONFIGURED, INTEGRATION_STATUS_ERROR]
      .every((s) => live.includes(s)))
}

console.log("\n── connected means connected, and nothing else does ──")
{
  check("'connected' is connected", isIntegrationConnected("connected"))
  check("'active' is NOT connected", !isIntegrationConnected("active"))
  check("'error' is not connected — a failing integration is not usable",
    !isIntegrationConnected("error"))
  check("'not_configured' is not connected", !isIntegrationConnected("not_configured"))
  check("null is not connected", !isIntegrationConnected(null))
  check("undefined is not connected", !isIntegrationConnected(undefined))
}

console.log("\n── the CRM connect/disconnect round trip uses the vocabulary ──")
{
  const crm = src("app/actions/crm-connect.ts")
  check("connect writes INTEGRATION_STATUS_CONNECTED",
    /status: INTEGRATION_STATUS_CONNECTED/.test(crm))
  check("disconnect writes INTEGRATION_STATUS_NOT_CONFIGURED",
    /status: INTEGRATION_STATUS_NOT_CONFIGURED/.test(crm))
  check("getCrmStatus reads the same constant it writes",
    /\.eq\("status", INTEGRATION_STATUS_CONNECTED\)/.test(crm))
  check("no 'active' literal remains on this table's queries",
    !/"status",\s*"active"/.test(crm) && !/status: "active"/.test(crm))
  check("the connect failure is still surfaced rather than swallowed",
    /if \(intErr\) return \{ ok: false, error: intErr\.message \}/.test(crm))
}

console.log("\n── the two silent fallbacks now find their integration ──")
{
  const sync = src("lib/crm/sync.ts")
  check("the sync layer resolves a brokerage provider on 'connected'",
    /\.eq\("status", INTEGRATION_STATUS_CONNECTED\)/.test(sync))
  check("it no longer asks for 'active'", !/"status", "active"/.test(sync))

  const showing = src("lib/workflow/adapters/schedule-showing.ts")
  check("the showing adapter looks up its ShowingTime key on 'connected'",
    /\.eq\("status", INTEGRATION_STATUS_CONNECTED\)/.test(showing))
  check("it no longer asks for 'active'", !/"status", "active"/.test(showing))
}

console.log("\n── the inline copy of the union is gone ──")
{
  const tech = src("app/actions/onboarding/tech-stack.ts")
  check("tech-stack types its status from the one module",
    /status: IntegrationStatus/.test(tech))
  check("it carries no inline copy of the three values",
    !/"connected"\s*\|\s*"error"\s*\|\s*"not_configured"/.test(tech))
  check("its disconnect path still writes a real value",
    /status: "not_configured"/.test(tech))

  const oauth = src("app/api/integrations/oauth/[provider]/route.ts")
  check("the OAuth callback still writes 'connected' (it always did)",
    /status: "connected"/.test(oauth))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ INTEGRATION_STATUS_FAIL"); process.exit(1) }
console.log(" ✅ INTEGRATION_STATUS_PASS — a connected integration is written, found, and disconnectable")
