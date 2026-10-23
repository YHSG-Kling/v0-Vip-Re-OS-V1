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
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/**
 * EVERY SOURCE ASSERTION IN THIS FILE READS THIS, NOT `raw` (CLAUDE.md §2).
 *
 * Until wave 27 this proof read RAW source, and that was not a theoretical
 * weakness — it was the thing BLOCKING the fix below. `11-validate-persist.ts`
 * read `transactions.commission_finalized_at` inline, a second spelling of the
 * lock beside lib/commission/finalization.ts:isCommissionFinalized (whose own
 * header claimed "the waterfall engine consults isCommissionFinalized" while
 * NOTHING did). Routing the step through the helper — the §6 merge — would have
 * left the literal `commission_finalized_at` present in that file only inside
 * the comment EXPLAINING the change, and a raw-source guard would then have gone
 * green on prose: a live proof converted into a vacuous one, which is worse than
 * the duplicate it was meant to be worth. The same hazard sat on
 * lib/commission/finalization.ts, whose header names every token this file
 * asserts.
 *
 * So: comments are removed before any scan, string CONTENTS are kept (the
 * assertions here are about column names and source values inside quoted
 * literals), and the self-test below proves the stripper is actually running —
 * an absence of comments and a broken stripper look identical in the output.
 */
const code = (p: string) => stripComments(raw(p))

console.log("\n── POSITIVE CONTROLS — a finder that cannot see cannot find ──")
{
  // §2: if a scan reports zero, prove the finder still recognises the thing it
  // is looking for. Both halves are checked: a comment must NOT satisfy a
  // source assertion, and real code MUST still be visible after stripping.
  // The delimiters are ASSEMBLED, never written adjacently in this file's own
  // source. A literal comment-opening or comment-closing token inside a string
  // is exactly what makes a scanner read the rest of a file as a comment, and a
  // proof about comment stripping must not be the thing that breaks the next
  // analyzer to read scripts/.
  const S = "/"
  const fixture = [
    `${S}${S} commission_finalized_at appears here in a comment only`,
    `${S}* and here: isCommissionFinalized( *${S}`,
    'const real = { commission_finalized_at: "kept because it is a real token" }',
  ].join("\n")
  const stripped = stripComments(fixture)
  check("CONTROL: a comment naming the lock column does NOT survive stripping",
    (stripped.match(/commission_finalized_at/g) ?? []).length === 1
    && !/isCommissionFinalized\(/.test(stripped))
  check("CONTROL: real code naming the lock column DOES survive stripping",
    /const real = \{ commission_finalized_at:/.test(stripped))
  // And the files this proof reads must actually be readable as code, or every
  // assertion below would pass or fail for the wrong reason.
  for (const p of [
    "lib/commission/finalization.ts",
    "lib/commission/waterfall/11-validate-persist.ts",
    "app/actions/cda-portal.ts",
    "scripts/schema-snapshot.ts",
  ]) {
    check(`CONTROL: ${p} is present and non-empty after stripping`, code(p).trim().length > 0)
  }
}

console.log("\n── the lock helper is first-writer-wins + best-effort ──")
{
  const f = code("lib/commission/finalization.ts")
  check("finalizeTransactionCommission stamps only when not already finalized (first-writer-wins)",
    /\.update\(\{[\s\S]*?commission_finalized_at[\s\S]*?\}\)[\s\S]*?\.is\("commission_finalized_at", null\)/.test(f))
  check("it reports alreadyFinal when a later event stamped nothing", f.includes("alreadyFinal"))
  check("isCommissionFinalized reads the lock and fails closed", f.includes("export async function isCommissionFinalized") && f.includes("return false"))
  check("source is constrained to the two owner-named events", /"cda_signed" \| "cd_uploaded"/.test(f))
  // §3, and the reason the helper could become the ONE reader: it used to
  // discard the read's error, so a REFUSED lock read was indistinguishable from
  // "not finalized" — the exact swallow the inline reader in the waterfall had
  // already been fixed for. Merging onto a survivor that is worse than the
  // duplicate is not a merge.
  check("the lock read destructures its error and says so before failing open to false",
    /const\s*\{\s*data,\s*error\s*\}\s*=\s*await\s+supabase/.test(f)
    && /if\s*\(error\)[\s\S]{0,300}?console\.error/.test(f))
}

console.log("\n── both triggers finalize; the engine refuses to re-persist a finalized deal ──")
{
  const cda = code("app/actions/cda-portal.ts")
  check("brokerSignCdaAction finalizes with source 'cda_signed'", /finalizeTransactionCommission\(supabase, cda\.transaction_id, "cda_signed"\)/.test(cda))
  check("uploadFinalCdAction finalizes with source 'cd_uploaded' (resolving the txn id)", /finalizeTransactionCommission\(supabase, finalTxnId, "cd_uploaded"\)/.test(cda))

  const persist = code("lib/commission/waterfall/11-validate-persist.ts")
  // KEEP-ONE (m283/m284): the ledger the persist step writes is agent_commissions.
  //
  // RETARGETED IN WAVE 27, from the column literal to the RULE. It asserted
  // `commission_finalized_at` appeared somewhere before `from('agent_commissions')`
  // — which pinned the DUPLICATE inline read and so forbade the §6 merge. The
  // rule it was defending is unchanged and is now stated directly: the step ASKS
  // THE ONE LOCK HELPER, before it touches the ledger, and REFUSES on the answer.
  check("final persist imports the ONE lock helper rather than reading the column itself",
    /import\s*\{[^}]*isCommissionFinalized[^}]*\}\s*from\s*'@\/lib\/commission\/finalization'/.test(persist)
    && !/\.select\('[^']*commission_finalized_at/.test(persist))
  check("...and asks it BEFORE inserting into the commission ledger",
    /isCommissionFinalized\(\s*supabase,\s*context\.transactionId\s*\)/.test(persist)
    && persist.indexOf("isCommissionFinalized(") < persist.indexOf("from('agent_commissions')")
    && persist.indexOf("isCommissionFinalized(") >= 0)
  check("...and the answer reaches a real branch, not a bound-and-ignored variable",
    /const\s+finalized\s*=\s*await\s+isCommissionFinalized\(/.test(persist)
    && /if\s*\(finalized\)\s*\{/.test(persist))
  check("a finalized deal returns the LOCKED commission instead of inserting a 2nd row",
    persist.includes("commissionId: (locked as { id: string }).id"))

  const snap = code("scripts/schema-snapshot.ts")
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
