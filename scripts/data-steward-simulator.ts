#!/usr/bin/env tsx
/**
 * scripts/data-steward-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Data Steward (10th manager) — proves the manager's ONE rule end-to-end:
 * data moves across the spine's boundaries WITHOUT silent loss.
 *
 *   Layer 1 — the pure steward core (no DB):
 *     • mergeIdentityFields  — dedup-merge: most-complete value wins, a real
 *       conflict is preserved (returned for notes), never silently dropped.
 *     • routeUnknownToNotes  — ingress: known canonical fields map to columns,
 *       EVERYTHING else routes to notes ("match their field to the best
 *       matching and anything else gets put in as notes").
 *     • CANONICAL_CONTACT_FIELDS — the protected identity/address field set
 *       must stay in lockstep with the live contacts schema snapshot.
 *
 *   Layer 2 — live DB round-trip (real schema, full cleanup):
 *     Drives the same write shapes contact-capture.ts uses — a CRM-flavored
 *     CSV row routed through the REAL routeUnknownToNotes lands as a contact
 *     (mapped columns + unmapped-to-notes), then a colliding second capture is
 *     merged with the REAL mergeIdentityFields and the conflict line is
 *     verified in notes. Deletes every test row (including on failure).
 *     Requires SUPABASE_SERVICE_ROLE_KEY; skips cleanly without it.
 *
 * Run:  npx tsx scripts/data-steward-simulator.ts   (npm run test:data-steward)
 */
import {
  CANONICAL_CONTACT_FIELDS,
  mergeIdentityFields,
  routeUnknownToNotes,
} from "../lib/data-steward/field-steward"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — pure steward core
// ─────────────────────────────────────────────────────────────────────────────

function testCanonicalFieldSet() {
  console.log("\n[Layer 1 · canonical field set ⟷ live contacts schema]")
  // Every protected field must exist on the live contacts snapshot — if a rename
  // ever lands in the DB, this fails before any boundary starts dropping data.
  const contactsCols = new Set(SCHEMA_SNAPSHOT.contacts)
  const missing = CANONICAL_CONTACT_FIELDS.filter((f) => !contactsCols.has(f))
  check("every canonical field exists on contacts", missing.length === 0, missing.join(", "))
  const leadsCols = new Set(SCHEMA_SNAPSHOT.leads)
  const missingLeads = CANONICAL_CONTACT_FIELDS.filter((f) => !leadsCols.has(f))
  check("every canonical field exists on leads (lossless promotion)", missingLeads.length === 0, missingLeads.join(", "))
}

function testLosslessMerge() {
  console.log("\n[Layer 1 · mergeIdentityFields — lossless dedup merge]")
  const m1 = mergeIdentityFields<Record<string, string | null>>(
    { first_name: "Ann", email: "", phone: "3055550100", city: null },
    { email: "ann@x.com", phone: "3055559999", city: "Miami" },
  )
  check("empty fields filled from incoming", m1.merged.email === "ann@x.com" && m1.merged.city === "Miami")
  check("existing non-empty value survives", m1.merged.phone === "3055550100")
  check("conflicting incoming value preserved as conflict, not dropped",
    m1.conflicts.length === 1 && m1.conflicts[0].includes("3055559999"))
  check("same value (case/space-insensitive) → no conflict",
    mergeIdentityFields({ email: "A@X.com" }, { email: " a@x.com " }).conflicts.length === 0)
  check("null/undefined incoming never overwrites",
    mergeIdentityFields({ phone: "111" }, { phone: null as any }).merged.phone === "111")
  // The exact own-but-don't-live case: mailing must merge independently of physical.
  const m2 = mergeIdentityFields<Record<string, string | null>>(
    { address: "1 Main St", mailing_address: null },
    { address: null, mailing_address: "PO Box 9" },
  )
  check("mailing fills independently of physical address",
    m2.merged.address === "1 Main St" && m2.merged.mailing_address === "PO Box 9" && m2.conflicts.length === 0)
}

function testIngressRouting() {
  console.log("\n[Layer 1 · routeUnknownToNotes — import field routing]")
  const crmRow = {
    "First Name": "Lin", "Last Name": "Wu", "Email Address": "lin@x.com",
    "Mobile Phone": "3055550111", "Home Phone": "3055550222",
    "Street Address": "9 Palm Ave", City: "Miami", State: "FL", Zip: "33133",
    "Anniversary": "2019-06-12", "Favorite Color": "teal",
  }
  const aliases = {
    "First Name": "first_name", "Last Name": "last_name", "Email Address": "email",
    "Mobile Phone": "phone", "Home Phone": "phone_secondary",
    "Street Address": "address", City: "city", State: "state", Zip: "zip_code",
  }
  const r = routeUnknownToNotes(crmRow, { aliases })
  check("aliased CRM headers map to canonical columns",
    r.mapped.first_name === "Lin" && r.mapped.phone === "3055550111" &&
    r.mapped.phone_secondary === "3055550222" && r.mapped.zip_code === "33133")
  check("unmapped columns route to notes (never dropped)",
    r.notes.includes("Anniversary=2019-06-12") && r.notes.includes("Favorite Color=teal"))
  check("unmapped kv also returned structured", r.unmapped["Favorite Color"] === "teal")
  check("fully-mapped payload → empty notes", routeUnknownToNotes({ email: "a@x.com" }).notes === "")
  check("empty values are skipped, not noted", !routeUnknownToNotes({ junk: "" }).notes.includes("junk"))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — live DB round-trip (real schema, real steward functions, cleanup)
// ─────────────────────────────────────────────────────────────────────────────

type Cleanup = { table: string; column: string; value: string }

async function testLiveImportAndMerge() {
  console.log("\n[Layer 2 · live import → contact → colliding capture → lossless merge]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer still ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const RUN = `__steward_${Date.now()}__`
  const email = `${RUN}@example.com`
  const cleanup: Cleanup[] = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage in DB."); return }
    const brokerageId = (brk as { id: string }).id

    // 1. IMPORT: a CRM-flavored row through the REAL ingress router, then the same
    //    insert shape contact-capture's CREATE path writes.
    const row = {
      first_name: "Stew", last_name: "Ardman", email, phone: "3055550100",
      "Home Phone": "3055550222", address: "9 Palm Ave", city: "Miami",
      state: "FL", "Zip": "33133", "Mailing Address": "PO Box 9",
      "Anniversary": "2019-06-12",
    }
    const { mapped, notes } = routeUnknownToNotes(row, {
      aliases: { "Home Phone": "phone_secondary", "Zip": "zip_code", "Mailing Address": "mailing_address" },
    })
    const { data: created, error: cErr } = await svc.from("contacts").insert({
      brokerage_id: brokerageId,
      first_name: mapped.first_name, last_name: mapped.last_name,
      email: mapped.email, phone: mapped.phone, phone_secondary: mapped.phone_secondary,
      address: mapped.address, city: mapped.city, state: mapped.state,
      zip_code: mapped.zip_code, mailing_address: mapped.mailing_address,
      notes: notes || null, source: "import", tcpa_consent: false, dnc_status: false,
    }).select("*").single()
    check("import row lands as contact", !cErr && !!created, cErr?.message)
    if (!created) throw new Error("contact insert failed")
    cleanup.push({ table: "contacts", column: "id", value: (created as any).id })
    check("mapped CRM columns persisted (phone_secondary / zip_code / mailing_address)",
      (created as any).phone_secondary === "3055550222" &&
      (created as any).zip_code === "33133" &&
      (created as any).mailing_address === "PO Box 9")
    check("unmapped column preserved in notes", `${(created as any).notes}`.includes("Anniversary=2019-06-12"))

    // 2. MERGE: colliding capture (same email, conflicting phone, new mailing city)
    //    through the REAL steward merge, then the same update shape the MERGE path writes.
    const incoming = { first_name: "Stew", last_name: "Ardman", email, phone: "3055559999", mailing_city: "Tampa" }
    const { merged, conflicts } = mergeIdentityFields(created as any, incoming)
    const noteLine = conflicts.length ? `[merge via import] ${conflicts.join("; ")}` : ""
    const mergedNotes = [(created as any).notes, noteLine].filter(Boolean).join("\n")
    const { error: uErr } = await svc.from("contacts").update({
      first_name: merged.first_name, last_name: merged.last_name, email: merged.email,
      phone: merged.phone, phone_secondary: merged.phone_secondary,
      address: merged.address, city: merged.city, state: merged.state, zip_code: merged.zip_code,
      mailing_address: merged.mailing_address, mailing_city: merged.mailing_city,
      mailing_state: merged.mailing_state, mailing_zip: merged.mailing_zip,
      notes: mergedNotes, updated_at: new Date().toISOString(),
    }).eq("id", (created as any).id)
    check("steward merge update succeeds against live schema", !uErr, uErr?.message)

    const { data: after } = await svc.from("contacts").select("*").eq("id", (created as any).id).single()
    check("existing phone survives the collision", (after as any)?.phone === "3055550100")
    check("conflicting phone preserved in notes (lossless)",
      `${(after as any)?.notes}`.includes("3055559999"))
    check("empty mailing_city filled from incoming", (after as any)?.mailing_city === "Tampa")
    check("original import note still intact after merge",
      `${(after as any)?.notes}`.includes("Anniversary=2019-06-12"))
  } catch (err) {
    check("live steward round-trip completed", false, err instanceof Error ? err.message : String(err))
  } finally {
    for (const c of cleanup.reverse()) {
      await svc.from(c.table).delete().eq(c.column, c.value)
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("email", email)
    check("cleanup: zero test rows left", (count ?? 0) === 0)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Data Steward simulator (lossless boundaries: import · dedup-merge · promotion)")
  console.log("══════════════════════════════════════════════════")
  testCanonicalFieldSet()
  testLosslessMerge()
  testIngressRouting()
  await testLiveImportAndMerge()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Data Steward verified — no boundary drops a field (test rows cleaned up)")
}

main()
