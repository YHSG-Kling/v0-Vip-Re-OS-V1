#!/usr/bin/env tsx
/**
 * scripts/scraper-health-simulator.ts   (npm run test:scraper-health)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the scraper-failure → self-heal → platform-admin loop is CLOSED.
 *
 * Raw scraping is PLATFORM-owned, so a sustained source outage is handed to the Data
 * Steward's self-contained fixer (the connector-healer): on the Nth CONSECUTIVE
 * platform-wide failure for a source, escalateScraperFailureIfNeeded maps the source
 * to its connector and invokes proposeConnectorHealing — which auto-fixes the SAFE
 * cases autonomously and escalates the rest to platform staff. Deduped so a flapping
 * source doesn't spawn a proposal per execution.
 *
 * Layer 1 (pure): shouldEscalateScraperFailure fires only on N consecutive failures;
 *   scraperTypeToConnector maps the tracked sources to their connectors.
 * Layer 2 (live, gated): seed N failed executions → escalate invokes the (injected)
 *   healer for the right connector → a pending heal proposal DEDUPES a second pass.
 *   Reverse-delete; cleanup == 0.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import {
  shouldEscalateScraperFailure,
  scraperTypeToConnector,
  SCRAPER_FAILURE_THRESHOLD,
} from "../lib/lead-pipeline/scraper-health"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log(`\n[Layer 1 · shouldEscalateScraperFailure — threshold ${SCRAPER_FAILURE_THRESHOLD}, most-recent-first]`)
  check("3 consecutive failures ⇒ heal", shouldEscalateScraperFailure(["failed", "failed", "failed"]) === true)
  check("2 failures (below threshold) ⇒ no heal", shouldEscalateScraperFailure(["failed", "failed"]) === false)
  check("a recovery (most recent = completed) ⇒ no heal", shouldEscalateScraperFailure(["completed", "failed", "failed", "failed"]) === false)
  check("a completed inside the window ⇒ no heal", shouldEscalateScraperFailure(["failed", "completed", "failed"]) === false)
  check("3 failed then an OLD completed ⇒ heal (window is the recent 3)", shouldEscalateScraperFailure(["failed", "failed", "failed", "completed"]) === true)
  check("empty history ⇒ no heal", shouldEscalateScraperFailure([]) === false)
  check("custom threshold 2 honored", shouldEscalateScraperFailure(["failed", "failed"], 2) === true)

  console.log("\n[Layer 1 · scraperTypeToConnector — source → connector the healer fixes]")
  check("zillow_behavior → zenrows", scraperTypeToConnector("zillow_behavior") === "zenrows")
  check("batchdata_motivated → batchdata", scraperTypeToConnector("batchdata_motivated") === "batchdata")
  check("social_intent → apify", scraperTypeToConnector("social_intent") === "apify")
  check("an untracked source → null (no heal target)", scraperTypeToConnector("osint_signal") === null)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the escalation rule")
    return
  }
  console.log("\n[Layer 2 · live — seed N failures → self-heal invoked for the connector → deduped]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { escalateScraperFailureIfNeeded, setScraperHealer } = await import("../lib/lead-pipeline/scraper-health")
  const svc = createServiceClient()
  const tag = `scrh-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const scraperType = "zillow_behavior"
  const execIds: string[] = []
  let healerCalls: Array<{ connector: string }> = []
  setScraperHealer(async ({ connector }) => { healerCalls.push({ connector }); return { proposalId: `fake-${connector}` } })
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (scraper health)` })

    // Seed N consecutive failed executions with RECENT timestamps so they are the latest 3.
    const now = Date.now()
    const rows = Array.from({ length: SCRAPER_FAILURE_THRESHOLD }, (_, i) => {
      const id = randomUUID(); execIds.push(id)
      return { id, brokerage_id: brokerageId, scraper_type: scraperType, status: "failed",
        started_at: new Date(now - (SCRAPER_FAILURE_THRESHOLD - i) * 60_000).toISOString(), error_message: "connection timeout" }
    })
    await svc.from("scraper_executions").insert(rows)

    const r1 = await escalateScraperFailureIfNeeded(svc, { scraperType, errorMessage: "connection timeout", nowMs: now })
    check("escalated on the Nth consecutive failure", r1.escalated === true)
    check("resolved the source to its connector (zenrows)", r1.connector === "zenrows")
    check("the self-healer was invoked once for zenrows", healerCalls.length === 1 && healerCalls[0].connector === "zenrows")

    // Dedup: a pending heal proposal for the connector means the Steward is already on it.
    const proposalId = randomUUID()
    const ins = await svc.from("connector_healing_proposals").insert({
      id: proposalId, connector: "zenrows", status: "pending", proposal_kind: "no_evidence",
      proposal_summary: `${tag} dedup probe`, confidence: 0, failure_signature: "sim", failure_sample: [],
      detected_at: new Date(now).toISOString(),
    })
    if (ins.error) { console.log(`  (note: proposal insert: ${ins.error.message})`) }
    healerCalls = []
    const r2 = await escalateScraperFailureIfNeeded(svc, { scraperType, errorMessage: "connection timeout", nowMs: now })
    check("re-escalating is deduped while a heal proposal is pending", r2.escalated === false && r2.reason === "heal already pending")
    check("the healer is NOT invoked again (no duplicate proposal)", healerCalls.length === 0)

    await svc.from("connector_healing_proposals").delete().eq("id", proposalId)
  } finally {
    setScraperHealer(null)
    await svc.from("scraper_executions").delete().in("id", execIds)
    await svc.from("connector_healing_proposals").delete().eq("connector", "zenrows").ilike("proposal_summary", `${tag}%`)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("scraper_executions").select("id", { count: "exact", head: true }).in("id", execIds)
    check("cleanup complete (no test rows remain)", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SCRAPER_HEALTH_FAIL"); process.exit(1) }
  console.log(" ✅ SCRAPER_HEALTH_PASS — a sustained scraper outage self-heals → platform admin (loop closed)")
}

main().catch((e) => { console.error(e); process.exit(1) })
