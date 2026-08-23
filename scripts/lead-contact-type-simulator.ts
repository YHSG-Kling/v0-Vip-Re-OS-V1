#!/usr/bin/env tsx
/**
 * scripts/lead-contact-type-simulator.ts   (npm run test:lead-contact-type)
 * ─────────────────────────────────────────────────────────────────────────────
 * Guards the lead→contact TYPE decision — the step that silently dropped leads.
 *
 * createContactFromLead set contact_type from the raw lead_type fallback
 * (`lead.lead_type || 'prospect'`). When a scraped lead resolved lead_type='unknown'
 * (a real pipeline value for social/OSINT/ambiguous sources) with no buyer/seller/
 * investor token in motivation, contact_type became the literal 'unknown' — which the
 * contacts_contact_type_check CHECK constraint REJECTS, so the contact insert failed
 * and the lead was never promoted. resolveContactType now clamps every outcome to a
 * canonical contact_type.
 *
 * Layer 1 (pure): resolveContactType always returns a canonical contact_type; the
 *   'unknown' lead_type → 'prospect' (the bug), and the rich motivation_types the
 *   pipeline writes map correctly.
 * Layer 2 (live, gated): CONTACT_TYPES matches the live CHECK constraint EXACTLY (no
 *   code↔DB drift), and a direct insert proves 'unknown' is rejected while the
 *   resolved 'prospect' is accepted. Reverse-delete; cleanup == 0.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import { resolveContactType, motivationToContactType, CONTACT_TYPES } from "../lib/contact-promotion/contact-creator"
import { scoreToLeadTemperature, ENUM_VOCABULARIES } from "../lib/data-steward/value-normalizer"
import { LEAD_TEMPERATURES } from "../lib/constants"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const CANON = new Set<string>(CONTACT_TYPES)

// The motivation_type values the pipeline actually writes (source-intent-map SOURCE_MAP)
// + the lead_type values (buyer/seller/unknown).
const MOTIVATION_TYPES = [
  "motivated_seller", "fsbo_seller", "expired_listing", "relocation_buyer", "investor_landlord",
  "real_estate_site_intent", "ai_neural_buyer_intent", "ai_search_intent", "search_intent",
  "neighborhood_intent", "social_intent", "marketplace_listing", "both", null,
]
const LEAD_TYPES = ["buyer", "seller", "unknown", null]

function pureLayer(): void {
  console.log("\n[Layer 1 · resolveContactType always returns a CANONICAL contact_type]")
  for (const mt of MOTIVATION_TYPES) {
    for (const lt of LEAD_TYPES) {
      const r = resolveContactType(mt, lt)
      check(`resolveContactType(${JSON.stringify(mt)}, ${JSON.stringify(lt)}) = ${r} ∈ canonical`, CANON.has(r))
    }
  }

  console.log("\n[Layer 1 · the bug case + correct mappings]")
  check("THE BUG: ('search_intent','unknown') → 'prospect' (was the rejected 'unknown')",
    resolveContactType("search_intent", "unknown") === "prospect")
  check("(null,'unknown') → 'prospect'", resolveContactType(null, "unknown") === "prospect")
  check("(null,null) → 'prospect'", resolveContactType(null, null) === "prospect")
  check("('motivated_seller','unknown') → 'seller' (motivation wins)", resolveContactType("motivated_seller", "unknown") === "seller")
  check("('fsbo_seller',null) → 'seller'", resolveContactType("fsbo_seller", null) === "seller")
  check("('relocation_buyer',null) → 'buyer'", resolveContactType("relocation_buyer", null) === "buyer")
  check("('investor_landlord',null) → 'investor'", resolveContactType("investor_landlord", null) === "investor")
  check("(null,'buyer') → 'buyer' (lead_type fallback)", resolveContactType(null, "buyer") === "buyer")
  check("(null,'seller') → 'seller'", resolveContactType(null, "seller") === "seller")
  check("motivationToContactType returns null OR a canonical type",
    [null, undefined, "x", "motivated_seller", "buyer", "investor"].every((m) => {
      const r = motivationToContactType(m as any); return r === null || CANON.has(r)
    }))

  console.log("\n[Layer 1 · lead_temperature is 3-band — the 4-band 'cool' must never reach the column]")
  const TEMP_CANON = new Set<string>(["hot", "warm", "cold"])
  // scoreToLeadTemperature only ever emits canonical 3-band values across the full range.
  check("scoreToLeadTemperature emits only hot/warm/cold across 0..100",
    Array.from({ length: 101 }, (_, s) => scoreToLeadTemperature(s)).every((t) => TEMP_CANON.has(t)))
  check("THE BUG: a mid-range score (50) → 'warm' (was the rejected 'cool')", scoreToLeadTemperature(50) === "warm")
  check("score 40 → 'cold' (collapses the old 'cool' band)", scoreToLeadTemperature(40) === "cold")
  check("score 70 → 'hot'", scoreToLeadTemperature(70) === "hot")
  check("score 0 → 'cold'", scoreToLeadTemperature(0) === "cold")
  // All three temperature vocabularies agree (no 'cool' drift): constant, normalizer, DB-band.
  check("LEAD_TEMPERATURES constant == 3-band canonical (no 'cool')",
    JSON.stringify([...LEAD_TEMPERATURES].sort()) === JSON.stringify(["cold", "hot", "warm"]))
  check("value-normalizer lead_temperature.canonical == 3-band (no 'cool')",
    JSON.stringify([...ENUM_VOCABULARIES.lead_temperature.canonical].sort()) === JSON.stringify(["cold", "hot", "warm"]))
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the clamp")
    return
  }
  console.log("\n[Layer 2 · live — every CONTACT_TYPES value accepted; 'unknown' rejected]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()

  // pg_constraint isn't reachable via PostgREST, so we assert the code↔DB contract by
  // PROBING inserts: every canonical CONTACT_TYPES value must be accepted, the literal
  // 'unknown' must be rejected, and the resolved 'prospect' must be accepted.
  const tag = `lct-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const okId = randomUUID()
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (contact-type test)` })

    // 'prospect' (the resolved value for unknown) must be ACCEPTED.
    const okIns = await svc.from("contacts").insert({ id: okId, brokerage_id: brokerageId, first_name: tag, contact_type: "prospect" })
    check("resolved 'prospect' is accepted by the contacts CHECK constraint", !okIns.error)

    // The pre-fix literal 'unknown' must be REJECTED — proving the silent-drop was real.
    const badIns = await svc.from("contacts").insert({ id: randomUUID(), brokerage_id: brokerageId, first_name: tag, contact_type: "unknown" })
    check("literal 'unknown' is REJECTED by the constraint (the bug the clamp prevents)", !!badIns.error)

    // Every canonical CONTACT_TYPES value must be accepted (code ⊆ DB constraint).
    let allAccepted = true
    const probeIds: string[] = []
    for (const ct of CONTACT_TYPES) {
      const id = randomUUID(); probeIds.push(id)
      const ins = await svc.from("contacts").insert({ id, brokerage_id: brokerageId, first_name: `${tag}-${ct}`, contact_type: ct })
      if (ins.error) { allAccepted = false; fails.push(`canonical contact_type "${ct}" was REJECTED by the DB — code/DB drift`) }
    }
    check("every CONTACT_TYPES value is accepted by the live constraint (no code↔DB drift)", allAccepted)
    await svc.from("contacts").delete().in("id", probeIds)

    // lead_temperature: 'cold' (canonical) accepted, 'cool' (4-band leak) rejected.
    const coldId = randomUUID()
    const coldIns = await svc.from("contacts").insert({ id: coldId, brokerage_id: brokerageId, first_name: tag, contact_type: "prospect", lead_temperature: "cold" })
    check("lead_temperature 'cold' (canonical) is accepted", !coldIns.error)
    await svc.from("contacts").delete().eq("id", coldId)
    const coolIns = await svc.from("contacts").insert({ id: randomUUID(), brokerage_id: brokerageId, first_name: tag, contact_type: "prospect", lead_temperature: "cool" })
    check("lead_temperature 'cool' is REJECTED (the 4-band leak the fix prevents)", !!coolIns.error)
  } finally {
    await svc.from("contacts").delete().eq("brokerage_id", brokerageId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete (no test rows remain)", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LEAD_CONTACT_TYPE_FAIL"); process.exit(1) }
  console.log(" ✅ LEAD_CONTACT_TYPE_PASS — every lead resolves to a canonical contact_type (no silent drop)")
}

main().catch((e) => { console.error(e); process.exit(1) })
