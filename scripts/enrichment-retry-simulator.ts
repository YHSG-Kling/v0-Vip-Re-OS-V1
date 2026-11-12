#!/usr/bin/env tsx
/**
 * scripts/enrichment-retry-simulator.ts   (npm run test:enrichment-retry)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the enrichment queue terminalizes correctly — no zombie 'pending' entries.
 *
 * The no-match path used to ALWAYS reset a failed enrichment to 'pending' + increment
 * retry_count. Once retry_count hit MAX_RETRIES the entry was excluded from the fetch
 * (.lt('retry_count', MAX_RETRIES)) yet still 'pending' — a zombie that's never retried,
 * never resolved, never surfaced. enrichmentRetryOutcome (now shared by BOTH the
 * exception and no-match paths) terminalizes to 'failed' on the final attempt.
 */
import {
  enrichmentRetryOutcome, MAX_RETRIES,
  classifyEnrichmentFault, escalateConfigFaultOnce, ESCALATE_ONCE_WINDOW_HOURS,
} from "../lib/lead-pipeline/enrichment-retry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

async function main(): Promise<void> {
  console.log(`\n[enrichmentRetryOutcome — terminalize at MAX_RETRIES=${MAX_RETRIES}, never a zombie]`)

  const r0 = enrichmentRetryOutcome(0)
  check("retry 0 → attempt 1, not final, stays 'pending'", r0.nextRetry === 1 && !r0.isFinal && r0.status === "pending")
  const r1 = enrichmentRetryOutcome(1)
  check("retry 1 → attempt 2, not final, stays 'pending'", r1.nextRetry === 2 && !r1.isFinal && r1.status === "pending")

  const rFinal = enrichmentRetryOutcome(MAX_RETRIES - 1)
  check("THE BUG: at the final attempt → 'failed' (NOT a zombie 'pending')",
    rFinal.nextRetry === MAX_RETRIES && rFinal.isFinal && rFinal.status === "failed")

  check("past the cap stays 'failed'", enrichmentRetryOutcome(MAX_RETRIES + 2).status === "failed")
  check("custom maxRetries=1 → first failure is already final", (() => { const r = enrichmentRetryOutcome(0, 1); return r.isFinal && r.status === "failed" })())
  check("custom maxRetries=5 → attempt 3 still retrying", enrichmentRetryOutcome(2, 5).status === "pending")

  // The invariant that kills the zombie: a 'pending' result is ALWAYS below the cap,
  // so the fetch (.lt(retry_count, MAX)) can always pick it up again.
  let invariant = true
  for (let rc = 0; rc < MAX_RETRIES + 5; rc++) {
    const o = enrichmentRetryOutcome(rc)
    if (o.status === "pending" && o.nextRetry >= MAX_RETRIES) invariant = false
  }
  check("invariant: a 'pending' outcome is never at/over the cap (no unfetchable zombie)", invariant)

  // ── WAVE 66 — CONFIG fault (BatchData "token ability missing" / "provisioning required")
  // is NEVER treated as transient, and self_heal_events escalates it ONCE, not per record ──
  console.log("\n[classifyEnrichmentFault — CONFIG vs TRANSIENT]")
  check("BatchData 'token ability missing' (403) → config",
    classifyEnrichmentFault("BatchData refused: token ability missing for this endpoint", 403) === "config")
  check("BatchData 'Provisioning required' (case-insensitive, 403) → config",
    classifyEnrichmentFault("Provisioning Required for skip-trace on this account", 403) === "config")
  check("same wording WITHOUT a 403 (a different status entirely) → transient",
    classifyEnrichmentFault("token ability missing", 500) === "transient")
  check("a generic timeout/rate-limit message → transient", classifyEnrichmentFault("ETIMEDOUT: request timed out", undefined) === "transient")
  check("no error message at all → transient (nothing to classify as config)", classifyEnrichmentFault(null) === "transient")
  // POSITIVE CONTROL — the classifier must still recognise BOTH known BatchData signatures;
  // a broken regex/substring match would report "transient" for everything (CLAUDE.md §2).
  check("POSITIVE CONTROL: an unrelated 403 (no config-fault wording) → transient, not config",
    classifyEnrichmentFault("Forbidden: invalid API key", 403) === "transient")

  console.log("\n[enrichmentRetryOutcome — a CONFIG fault terminalizes on attempt 1, never retries]")
  const cfgFirstAttempt = enrichmentRetryOutcome(0, MAX_RETRIES, "config")
  check("CONFIG fault on retryCount=0 is ALREADY final/'failed' (not 'pending' for two more attempts)",
    cfgFirstAttempt.isFinal === true && cfgFirstAttempt.status === "failed")
  check("a TRANSIENT fault at the same retryCount=0 still retries (unchanged default behavior)",
    enrichmentRetryOutcome(0, MAX_RETRIES, "transient").status === "pending")
  check("omitting `fault` entirely behaves exactly as before (default 'transient')",
    enrichmentRetryOutcome(0).status === "pending" && enrichmentRetryOutcome(0).isFinal === false)

  console.log("\n[escalateConfigFaultOnce — self_heal_events domain 'connector', outcome 'escalated', deduped]")
  {
    const inserted: Array<{ table: string; row: any }> = []
    const freshSvc: any = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ limit: async () => ({ data: [] }) }) }) }) }),
        }),
        insert: (row: any) => ({ then: (res: any) => { inserted.push({ table, row }); res?.(); return Promise.resolve() } }),
      }),
    }
    const r1 = await escalateConfigFaultOnce(freshSvc, { brokerageId: "b-1", vendor: "batchdata", errorMessage: "token ability missing" })
    check("first call for a fresh fault → escalated", r1.escalated === true && r1.alreadyEscalated === false)
    check("…writes exactly ONE self_heal_events row", inserted.length === 1 && inserted[0].table === "self_heal_events")
    const w = inserted[0].row
    check("…domain 'connector' / outcome 'escalated' / subject names the vendor",
      w.domain === "connector" && w.outcome === "escalated" && w.subject === "batchdata_config_fault")
    check("…detail carries the vendor + the real error text (never fabricated)",
      w.detail?.vendor === "batchdata" && w.detail?.error === "token ability missing")

    // A SECOND fault within the window must find the first escalation and NOT re-escalate.
    const alreadyEscalatedSvc: any = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ limit: async () => ({ data: [{ id: "existing-1" }] }) }) }) }) }),
        }),
        insert: () => { throw new Error("must not insert a second escalation within the window") },
      }),
    }
    const r2 = await escalateConfigFaultOnce(alreadyEscalatedSvc, { brokerageId: "b-1", vendor: "batchdata", errorMessage: "token ability missing" })
    check("second fault, same vendor, within the window → NOT re-escalated (escalate ONCE)",
      r2.escalated === false && r2.alreadyEscalated === true)
    check(`escalate-once window is ${ESCALATE_ONCE_WINDOW_HOURS}h (named, not a magic number)`, ESCALATE_ONCE_WINDOW_HOURS === 24)

    // A broken ledger client must never throw — escalation is best-effort.
    const brokenSvc: any = { from: () => { throw new Error("ledger down") } }
    const r3 = await escalateConfigFaultOnce(brokenSvc, { brokerageId: null, vendor: "batchdata", errorMessage: "provisioning required" })
    check("a broken ledger client fails closed (no throw), never escalated", r3.escalated === false)
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ENRICHMENT_RETRY_FAIL"); process.exit(1) }
  console.log(" ✅ ENRICHMENT_RETRY_PASS — enrichment terminalizes to 'failed' at the cap (no zombie pending); CONFIG faults never retry and escalate once")
}

main()
