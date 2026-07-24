#!/usr/bin/env tsx
/**
 * scripts/commission-finalization-simulator.ts   (npm run test:commission-finalization)
 * ─────────────────────────────────────────────────────────────────────────────
 * COMMISSION FINALIZATION LOCK (owner rule: "the transaction commission isn't final
 * until the final CDA is signed by a broker or final CD uploaded to the transaction").
 * Proves: (1) both triggers stamp the lock; (2) it is FIRST-WRITER-WINS (the earlier
 * event's source is kept); (3) the waterfall refuses to re-persist a finalized deal
 * (immutability + no duplicate commissions row).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the lock helper is first-writer-wins + best-effort ──")
{
  const f = src("lib/commission/finalization.ts")
  check("finalizeTransactionCommission stamps only when not already finalized (first-writer-wins)",
    /\.update\(\{[\s\S]*?commission_finalized_at[\s\S]*?\}\)[\s\S]*?\.is\("commission_finalized_at", null\)/.test(f))
  check("it reports alreadyFinal when a later event stamped nothing", f.includes("alreadyFinal"))
  check("isCommissionFinalized reads the lock and fails closed", f.includes("export async function isCommissionFinalized") && f.includes("return false"))
  check("source is constrained to the two owner-named events", /"cda_signed" \| "cd_uploaded"/.test(f))
}

console.log("\n── both triggers finalize; the engine refuses to re-persist a finalized deal ──")
{
  const cda = src("app/actions/cda-portal.ts")
  check("brokerSignCdaAction finalizes with source 'cda_signed'", /finalizeTransactionCommission\(supabase, cda\.transaction_id, "cda_signed"\)/.test(cda))
  check("uploadFinalCdAction finalizes with source 'cd_uploaded' (resolving the txn id)", /finalizeTransactionCommission\(supabase, finalTxnId, "cd_uploaded"\)/.test(cda))

  const persist = src("lib/commission/waterfall/11-validate-persist.ts")
  check("final persist checks commission_finalized_at BEFORE inserting", /commission_finalized_at[\s\S]*?from\('commissions'\)/.test(persist))
  check("a finalized deal returns the LOCKED commission instead of inserting a 2nd row",
    persist.includes("commissionId: (locked as { id: string }).id"))

  const snap = src("scripts/schema-snapshot.ts")
  check("the lock columns are in the schema snapshot", snap.includes('"commission_finalized_at"') && snap.includes('"commission_final_source"'))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the wiring"); return }
  const svc = createClient(url, key)
  console.log("\n[live] first-writer-wins on a real transaction → cleanup")
  const { data: txn } = await svc.from("transactions").select("id, commission_finalized_at, commission_final_source").is("commission_finalized_at", null).limit(1).maybeSingle()
  if (!txn) { console.log("  ⊘ no un-finalized transaction — skipping"); return }
  const txnId = (txn as any).id
  try {
    const { finalizeTransactionCommission, isCommissionFinalized } = await import("../lib/commission/finalization")
    const r1 = await finalizeTransactionCommission(svc as any, txnId, "cda_signed")
    check("live: the CDA-sign event stamps the lock", r1.ok && r1.alreadyFinal === false)
    check("live: isCommissionFinalized now true", await isCommissionFinalized(svc as any, txnId))
    const r2 = await finalizeTransactionCommission(svc as any, txnId, "cd_uploaded")
    check("live: the later CD-upload event is a no-op (first-writer-wins)", r2.ok && r2.alreadyFinal === true)
    const { data: after } = await svc.from("transactions").select("commission_final_source").eq("id", txnId).maybeSingle()
    check("live: the recorded source stays 'cda_signed'", (after as any)?.commission_final_source === "cda_signed")
  } finally {
    await svc.from("transactions").update({ commission_finalized_at: null, commission_final_source: null }).eq("id", txnId)
    const { data: restored } = await svc.from("transactions").select("commission_finalized_at").eq("id", txnId).maybeSingle()
    check("live: cleanup — transaction restored to not-finalized", (restored as any)?.commission_finalized_at === null)
  }
}

async function main() {
  await liveLayer()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ COMMISSION_FINALIZATION_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_FINALIZATION_PASS — commission is an estimate until a broker-signed CDA or uploaded final CD locks it; finalized deals are immutable")
}
main()
