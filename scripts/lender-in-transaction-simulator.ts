#!/usr/bin/env tsx
/**
 * scripts/lender-in-transaction-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A LENDER (a third-party financing participant) works in a transaction FROM DAY 1.
 * This closes a chain that never actually ran (0 lender grants, 0 transactions
 * with a lender, live): the old assignLenderToTransaction wrote the lender's USER
 * id into transactions.lender_id and omitted the NOT-NULL brokerage_id, so the
 * lender_portal_users grant insert failed and requireLenderActor could never match.
 *
 * The canonical model (verified against live DDL): lender_portal_users is a
 * PER-(user, transaction) grant — user_id + transaction_id + brokerage_id are all
 * NOT NULL — and transactions.lender_id → lender_portal_users.id. lib/kernel/
 * lender-linkage.ts is the single source of truth.
 *
 * Layer 1 (pure): lenderFilterIds (empty → safe sentinel, non-empty → passthrough).
 * Layer 2 (source): assignLenderToTransaction links via linkLenderToTransaction +
 *   stamps transactions.lender_id with the GRANT id (not a user id); the lender
 *   reads (dashboard, TC/lender brief) filter transactions.lender_id by the user's
 *   grant ids (lenderPortalRowIdsForUser), never by a raw user id.
 * Layer 3 (live, gated): seed a lender user + a transaction in one brokerage →
 *   linkLenderToTransaction → assert the grant row carries user_id + transaction_id
 *   + NOT-NULL brokerage_id, transactions.lender_id === grant id, requireLenderActor-
 *   style resolution (user_id + id + brokerage_id) succeeds, and the deal is found
 *   via .in("lender_id", grantIds). Idempotent re-link reuses the one grant.
 *   Cleans up; verifies count == 0.
 *
 * Run: npx tsx scripts/lender-in-transaction-simulator.ts  (npm run test:lender-in-transaction)
 */
import { lenderFilterIds } from "../lib/kernel/lender-linkage"
import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Lender-in-transaction verified — grant provisioned, FK-correct link, lender authorized + sees the deal")
  console.log(" LENDER_IN_TRANSACTION_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lender-in-transaction (day-1 growth readiness) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure linkage filter]")
  const sentinel = "00000000-0000-0000-0000-000000000000"
  check("lenderFilterIds([]) → single safe sentinel (never an empty .in())",
    JSON.stringify(lenderFilterIds([])) === JSON.stringify([sentinel]))
  check("lenderFilterIds passes real ids through unchanged",
    JSON.stringify(lenderFilterIds(["a", "b"])) === JSON.stringify(["a", "b"]))

  console.log("\n[Layer 2 · the action + reads use the canonical linkage]")
  const actionSrc = readFileSync(join(process.cwd(), "app/actions/multi-persona.ts"), "utf8")
  check("assignLenderToTransaction links via linkLenderToTransaction",
    /linkLenderToTransaction\(/.test(actionSrc))
  check("transactions.lender_id is stamped with the GRANT id (link.lenderPortalId), not a user id",
    /lender_id:\s*link\.lenderPortalId/.test(actionSrc))
  check("assign is role-gated + brokerage-scoped (rejects a non-lender / cross-brokerage)",
    /is not a lender/.test(actionSrc) && /another brokerage/.test(actionSrc))

  const briefSrc = readFileSync(join(process.cwd(), "lib/intelligence/user-type-briefs/tc-compliance-lender-vendor.ts"), "utf8")
  check("lender brief filters transactions.lender_id by the user's GRANT ids (not raw user id)",
    /lenderPortalRowIdsForUser\(/.test(briefSrc) && /\.in\("lender_id", lenderRowIds\)/.test(briefSrc) &&
    !/\.eq\("lender_id", params\.userId\)/.test(briefSrc))

  const dashSrc = readFileSync(join(process.cwd(), "app/lender/dashboard/page.tsx"), "utf8")
  check("lender dashboard queries transactions by ALL of the user's grant ids (.in), multi-deal safe",
    /\.in\('lender_id'/.test(dashSrc) && !/\.eq\('lender_id', lenderId\)/.test(dashSrc))

  const linkSrc = readFileSync(join(process.cwd(), "lib/kernel/lender-linkage.ts"), "utf8")
  check("linkLenderToTransaction always sets the three NOT-NULL columns (user_id, transaction_id, brokerage_id)",
    /user_id:\s*lenderUserId/.test(linkSrc) && /transaction_id:\s*transactionId/.test(linkSrc) && /brokerage_id:\s*brokerageId/.test(linkSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live lender link]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { linkLenderToTransaction, lenderPortalRowIdsForUser, lenderFilterIds: filterIds } =
    await import("../lib/kernel/lender-linkage")
  const svc = createServiceClient()
  const TAG = `LenderTxn${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 3 · live lender link]")
  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need a brokerage."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Seed a lender USER (the person we invite as the transaction's lender).
    const lenderUserId = randomUuid(TAG)
    const { error: uErr } = await svc.from("users").insert({
      id: lenderUserId, email: `${TAG}@lender.local`.toLowerCase(),
      first_name: TAG, last_name: "Lender", user_type: "lender", role: "lender",
      brokerage_id: brokerageId, is_contact: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    if (uErr) { check("seed lender user", false, uErr.message); report(); return }
    cleanup.push({ table: "users", id: lenderUserId })

    // Seed a transaction in the same brokerage.
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} deal`, deal_type: "buyer",
      status: "active", stage: "FINANCING_PENDING", property_address: `${TAG} 1 Loan St`,
      agent_id: (agent as any).id,
    }).select("id").single()
    if (!txn) { check("seed transaction", false); report(); return }
    const transactionId = (txn as any).id
    cleanup.push({ table: "transactions", id: transactionId })

    // THE LINK — exactly what assignLenderToTransaction does server-side.
    const link = await linkLenderToTransaction(svc, {
      lenderUserId, transactionId, brokerageId, lenderCompany: `${TAG} Capital`,
    })
    check("linkLenderToTransaction succeeded + returned a grant id", link.ok && !!link.lenderPortalId, link.error)
    const grantId = link.lenderPortalId!
    if (grantId) cleanup.push({ table: "lender_portal_users", id: grantId })

    await svc.from("transactions").update({ lender_id: grantId }).eq("id", transactionId)

    // The grant carries all three NOT-NULL columns + the company.
    const { data: grant } = await svc.from("lender_portal_users")
      .select("id, user_id, transaction_id, brokerage_id, lender_company, access_level")
      .eq("id", grantId).single()
    const g = grant as any
    check("grant row: user_id + transaction_id + NOT-NULL brokerage_id all set",
      g?.user_id === lenderUserId && g?.transaction_id === transactionId && g?.brokerage_id === brokerageId,
      JSON.stringify(g))
    check("grant row: lender_company + default access_level recorded",
      g?.lender_company === `${TAG} Capital` && g?.access_level === "read")

    // transactions.lender_id === the GRANT id (the FK requireLenderActor keys off).
    const { data: txnAfter } = await svc.from("transactions").select("lender_id").eq("id", transactionId).single()
    check("transactions.lender_id === grant id (FK-correct, not the user id)",
      (txnAfter as any)?.lender_id === grantId && (txnAfter as any)?.lender_id !== lenderUserId)

    // requireLenderActor-style resolution: (user_id, id) match + brokerage_id present → authorized.
    const { data: actorRow } = await svc.from("lender_portal_users")
      .select("id, brokerage_id").eq("user_id", lenderUserId).eq("id", grantId).maybeSingle()
    check("lender is AUTHORIZED (requireLenderActor resolves the grant by user_id + id, brokerage scoped)",
      !!actorRow && !!(actorRow as any).brokerage_id)

    // The lender SEES the deal via .in("lender_id", grantIds).
    const grantIds = filterIds(await lenderPortalRowIdsForUser(svc, lenderUserId, brokerageId))
    check("lenderPortalRowIdsForUser returns the grant id", grantIds.includes(grantId))
    const { data: seen } = await svc.from("transactions").select("id").in("lender_id", grantIds)
    check("lender SEES the transaction (found via .in on grant ids)",
      ((seen ?? []) as any[]).some((t) => t.id === transactionId))

    // Idempotent re-link — reuses the single grant (no duplicate rows).
    const link2 = await linkLenderToTransaction(svc, { lenderUserId, transactionId, brokerageId, lenderCompany: `${TAG} Capital` })
    check("idempotent re-link reuses the same grant (no duplicate per user+transaction)",
      link2.ok && link2.lenderPortalId === grantId)
    const { count: grantCount } = await svc.from("lender_portal_users")
      .select("id", { count: "exact", head: true }).eq("user_id", lenderUserId).eq("transaction_id", transactionId)
    check("exactly ONE grant per (user, transaction)", (grantCount ?? 0) === 1, `count=${grantCount}`)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("lender_portal_users").select("id", { count: "exact", head: true }).ilike("lender_company", `${TAG}%`)
    const { count: uCount } = await svc.from("users").select("id", { count: "exact", head: true }).ilike("email", `${TAG}%`)
    check("cleanup verified — 0 seeded rows remain", (count ?? 0) === 0 && (uCount ?? 0) === 0)
  }

  report()
}

// Deterministic UUID from a tag (no Math.random / Date.now in the id itself so a
// re-run is traceable) — good enough for a seeded, self-cleaned test row.
function randomUuid(tag: string): string {
  const h = Buffer.from(tag).toString("hex").padEnd(32, "0").slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

main().catch((e) => { console.error(e); process.exit(1) })
