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
import { enrichmentRetryOutcome, MAX_RETRIES } from "../lib/lead-pipeline/enrichment-retry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main(): void {
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

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ENRICHMENT_RETRY_FAIL"); process.exit(1) }
  console.log(" ✅ ENRICHMENT_RETRY_PASS — enrichment terminalizes to 'failed' at the cap (no zombie pending)")
}

main()
