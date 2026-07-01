#!/usr/bin/env tsx
/**
 * scripts/mailing-cass-gate-simulator.ts   (npm run test:mailing-cass)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the MAILING-ADDRESS CASS GATE: leads.mailing_address_verified is set true at promotion merely
 * because an address STRING exists — never CASS-verified — yet dispatchDirectMail trusts it "so we don't
 * pay Lob for an undeliverable piece." This gate CASS-verifies ONCE at the send chokepoint and makes the
 * flag honest: deliverable → standardize + mark lob_cass; undeliverable → block + correct the flag so
 * speed-to-lead stops choosing direct_mail.
 *
 * PURE:   needsCassCheck (only a flag-verified, not-yet-lob_cass, has-address lead needs a check) +
 *         interpretLobForGate (deliverable→proceed+standardize, undeliverable→block+false, null→defer).
 * SOURCE: dispatchDirectMail runs the gate at the single lead chokepoint; provider-gated; reuses the
 *         existing mailing_address_source column; owned by data_steward with a runnable proof.
 * LIVE (creds-gated): seed a naively-flagged lead → simulate the two Lob verdicts through the persistence
 *         path → assert deliverable standardizes + marks lob_cass (idempotent re-check skipped) and
 *         undeliverable flips verified=false → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { needsCassCheck, interpretLobForGate, CASS_SOURCE } from "../lib/providers/mailing-cass-gate"
import type { LobVerificationResult } from "../lib/external/lob-address-verify"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const baseLead = { mailing_address_verified: true, mailing_address_source: null, mailing_address: "123 Main St", mailing_city: "Austin", mailing_state: "TX", mailing_zip: "78701" }
const deliverable = (): LobVerificationResult => ({ verified: true, deliverability: "deliverable", standardized: { primary_line: "123 MAIN ST", city: "AUSTIN", state: "TX", zip_code: "78701-1234" }, raw: {}, error: null })
const undeliverable = (): LobVerificationResult => ({ verified: false, deliverability: "undeliverable", standardized: {}, raw: {}, error: null })

function pureLayer() {
  console.log("\n[needsCassCheck · pure — only a naively-flagged, unverified-by-lob, has-address lead]")
  check("flag-verified + no lob_cass + has address ⇒ needs a check", needsCassCheck(baseLead) === true)
  check("already lob_cass ⇒ trusted, no re-check", needsCassCheck({ ...baseLead, mailing_address_source: CASS_SOURCE }) === false)
  check("flag NOT verified ⇒ existing gate handles it, skip", needsCassCheck({ ...baseLead, mailing_address_verified: false }) === false)
  check("no address string ⇒ nothing to verify, skip", needsCassCheck({ ...baseLead, mailing_address: "" }) === false)
  check("null address ⇒ skip", needsCassCheck({ ...baseLead, mailing_address: null }) === false)

  console.log("\n[interpretLobForGate · pure — the three verdicts]")
  const d = interpretLobForGate(deliverable())
  check("deliverable ⇒ PROCEED", d.action === "proceed")
  check("deliverable ⇒ marks lob_cass", d.patch.mailing_address_source === CASS_SOURCE)
  check("deliverable ⇒ writes Lob's STANDARDIZED address", d.patch.mailing_address === "123 MAIN ST" && d.patch.mailing_zip === "78701-1234")
  check("deliverable ⇒ keeps verified true", d.patch.mailing_address_verified === true)

  const u = interpretLobForGate(undeliverable())
  check("undeliverable ⇒ BLOCK", u.action === "block")
  check("undeliverable ⇒ corrects the naive flag to false", u.patch.mailing_address_verified === false)
  check("undeliverable ⇒ marks lob_cass so we don't re-verify a known-bad address", u.patch.mailing_address_source === CASS_SOURCE)

  const nul = interpretLobForGate(null)
  check("null (no key / transient) ⇒ DEFER", nul.action === "defer")
  check("defer ⇒ writes NOTHING (no fabricated disposition)", Object.keys(nul.patch).length === 0)
}

function sourceLayer() {
  console.log("\n[wiring — the gate runs at the single dispatch chokepoint; provider-gated; owned]")
  const disp = src("lib/providers/dispatch.ts")
  check("dispatchDirectMail selects the mailing address fields for the CASS gate", /select\("brokerage_id, mailing_address_verified, mailing_address_source, mailing_address, mailing_city, mailing_state, mailing_zip"\)/.test(disp))
  check("gate calls needsCassCheck before verifying", /needsCassCheck\(l\)/.test(disp))
  check("gate CASS-verifies via the existing verifyAddressViaLob", /verifyAddressViaLob\(/.test(disp))
  check("undeliverable BLOCKS the Lob send", /decision\.action === "block"[\s\S]*?success:\s*false/.test(disp))
  check("verify spend is metered through the existing vendor gateway", /meterVendorSpend\(\{[\s\S]*?vendorName:\s*"lob"[\s\S]*?address_verify/.test(disp))
  const mod = src("lib/providers/mailing-cass-gate.ts")
  check("provider-gated — null Lob result defers (never blocks on missing/flaky verify)", /if \(!lob\)[\s\S]*?action: "defer"/.test(mod))
  check("reuses the existing mailing_address_source column as the idempotency marker (no migration)", /CASS_SOURCE = "lob_cass"/.test(mod))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /mailing_address_cass_gate:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:mailing-cass"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a naively-flagged lead → apply each Lob verdict through the persistence path → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: lead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: "Cass", last_name: "Test",
      mailing_address: "123 main st", mailing_city: "austin", mailing_state: "tx", mailing_zip: "78701",
      mailing_address_verified: true, mailing_address_source: null, lifecycle_state: "unconsented",
    }).select("id").single()
    if (!lead) { console.log("  ⊘ lead insert failed — skipping"); return }
    const leadId = (lead as any).id
    cleanup.push({ table: "leads", id: leadId })

    // The seeded lead is exactly the naive-flag state the gate must catch.
    const seeded = { mailing_address_verified: true, mailing_address_source: null, mailing_address: "123 main st", mailing_city: "austin", mailing_state: "tx", mailing_zip: "78701" }
    check("live: seeded lead needs a CASS check (naive flag, no lob_cass)", needsCassCheck(seeded) === true)

    // DELIVERABLE verdict → persist the proceed patch, then assert standardized + lob_cass + idempotent.
    const dPatch = interpretLobForGate(deliverable()).patch
    await svc.from("leads").update({ ...dPatch, updated_at: new Date().toISOString() }).eq("id", leadId)
    const { data: afterD } = await svc.from("leads").select("mailing_address, mailing_zip, mailing_address_source, mailing_address_verified").eq("id", leadId).maybeSingle()
    check("live: deliverable standardized the address on the row", (afterD as any)?.mailing_address === "123 MAIN ST" && (afterD as any)?.mailing_zip === "78701-1234")
    check("live: deliverable marked mailing_address_source=lob_cass", (afterD as any)?.mailing_address_source === CASS_SOURCE)
    check("live: now trusted — a re-check is skipped (idempotent)", needsCassCheck(afterD as any) === false)

    // UNDELIVERABLE verdict → persist the block patch, then assert the naive flag is corrected to false.
    const uPatch = interpretLobForGate(undeliverable()).patch
    await svc.from("leads").update({ ...uPatch, updated_at: new Date().toISOString() }).eq("id", leadId)
    const { data: afterU } = await svc.from("leads").select("mailing_address_verified, mailing_address_source").eq("id", leadId).maybeSingle()
    check("live: undeliverable corrected mailing_address_verified=false", (afterU as any)?.mailing_address_verified === false)
    check("live: undeliverable stays marked lob_cass (won't re-verify a known-bad address)", (afterU as any)?.mailing_address_source === CASS_SOURCE)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MAILING_CASS_FAIL"); process.exit(1) }
  console.log(" ✅ MAILING_CASS_PASS — the verified flag is CASS-honest at the send chokepoint; no Lob spend on undeliverable mail, no cold lead stamped first_touched by a doomed piece")
}
main()
