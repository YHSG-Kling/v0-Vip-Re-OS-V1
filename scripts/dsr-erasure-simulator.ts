#!/usr/bin/env tsx
/**
 * scripts/dsr-erasure-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * RIGHT TO BE FORGOTTEN — the DSAR erasure completeness harness (CCPA §1798.105 /
 * GDPR Art. 17). The original anonymization redacted only 5 fields
 * (first/last/email/phone/notes) while a `contacts` row carries 25+ MORE PII
 * columns — the driver's-license IMAGE (dl_image_url), legal name, full + mailing
 * address, demographics, financial bands, court/public records, social handles,
 * enrichment blobs and external identifiers — all left intact. A de-identification
 * that leaves the DL image + legal name on file is NOT a lawful erasure. This
 * proves the ONE canonical patch (contactRedactionPatch) clears the COMPLETE set.
 *
 * Layer 1 (pure): redactedContactFields covers every PII column; contactRedactionPatch
 *   turns names into non-null redaction markers, nulls everything else, stamps
 *   privacy_anonymized_*; the DL image + legal names + financial + records + social
 *   are all in the null set; retention columns (id/brokerage_id/transaction linkage)
 *   are NOT touched.
 * Layer 2 (source): the fulfilment action actually WIRES contactRedactionPatch (no
 *   drift back to a hand-written 5-field object).
 * Layer 3 (live, gated): seed a contact populated across the WHOLE PII surface + a
 *   CLOSED transaction linked to it; apply the exact erasure patch the action applies;
 *   assert EVERY PII column is null (or the redaction marker for name/email),
 *   privacy_anonymized_at is stamped, AND the transaction row is RETAINED (state RE
 *   retention). Self-cleans with a unique TAG; verifies count == 0.
 *
 * Run: npx tsx scripts/dsr-erasure-simulator.ts   (npm run test:dsr-erasure)
 */
import {
  CONTACT_PII_NULL_COLUMNS,
  contactRedactionPatch,
  redactedContactFields,
} from "../lib/privacy/contact-pii-redaction"
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
  console.log(" ✅ DSAR erasure verified — the COMPLETE PII surface is cleared, transaction retained")
  console.log(" DSR_ERASURE_PASS")
}

// The most sensitive columns a lawful erasure MUST clear — if any survives, the
// "right to be forgotten" is a lie. Kept as an explicit allow-list so the test
// fails loudly if someone drops one from CONTACT_PII_NULL_COLUMNS.
const MUST_CLEAR = [
  "dl_image_url", "legal_first_name", "legal_middle_name", "legal_last_name",
  "mailing_address", "household_income", "credit_score_band", "court_records",
  "public_records", "social_handles", "ghl_contact_id", "peopledata_id",
  "birthday", "occupation", "enrichment_profile",
]

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" DSAR erasure (right to be forgotten) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · redaction patch completeness]")
  const patch = contactRedactionPatch("anon_deadbeef00000000", "req-123")

  // Names/email are non-null redaction markers (columns are often NOT NULL).
  check("names/email become redaction markers (not left as real PII)",
    patch.first_name === "anon_deadbeef00000000" && patch.last_name === "[deleted]" &&
    patch.email === "anon_deadbeef00000000@deleted.local")
  check("phone + notes nulled", patch.phone === null && patch.notes === null)
  check("privacy_anonymized_* stamped (at + reason cite the DSAR request)",
    typeof patch.privacy_anonymized_at === "string" && patch.privacy_anonymized_reason === "DSAR req-123")

  // Every MUST_CLEAR column is present in the patch AND set to null.
  for (const col of MUST_CLEAR) {
    check(`sensitive column cleared: ${col}`, col in patch && patch[col] === null,
      col in patch ? `value=${JSON.stringify(patch[col])}` : "MISSING from patch")
  }

  // Every column in the canonical null set is actually nulled by the patch.
  const notNulled = CONTACT_PII_NULL_COLUMNS.filter((c) => patch[c] !== null)
  check("every CONTACT_PII_NULL_COLUMNS entry is nulled by the patch",
    notNulled.length === 0, notNulled.join(","))

  // redactedContactFields (used by any future audit) is the union — no dupes, covers all.
  const fields = redactedContactFields()
  check("redactedContactFields covers names/email/phone/notes + the whole null set",
    ["first_name", "last_name", "email", "phone", "notes"].every((f) => fields.includes(f)) &&
    CONTACT_PII_NULL_COLUMNS.every((c) => fields.includes(c)))
  check("redactedContactFields has no duplicate columns",
    new Set(fields).size === fields.length)

  // Retention columns must NOT be in the erasure set (referential integrity + lawful retention).
  const RETAIN = ["id", "brokerage_id", "agent_id", "created_at", "contact_type", "status", "buyer_stage"]
  const leaked = RETAIN.filter((c) => c in patch)
  check("retention/linkage columns are NOT touched by the patch (id/brokerage_id/agent_id/created_at/state)",
    leaked.length === 0, leaked.join(","))

  console.log("\n[Layer 2 · the fulfilment action wires the patch]")
  const actionSrc = readFileSync(join(process.cwd(), "app/actions/privacy/data-subject-requests.ts"), "utf8")
  check("fulfillDeleteRequestAction imports contactRedactionPatch",
    // The import may carry sibling symbols (redactedContactFields joined it in
    // wave 26 for the post-erasure completeness check); the intent is "the
    // action imports the canonical patch", not "imports it alone".
    /import\s*\{[^}]*\bcontactRedactionPatch\b[^}]*\}\s*from\s*["']@\/lib\/privacy\/contact-pii-redaction["']/.test(actionSrc))
  check("the anonymize UPDATE applies contactRedactionPatch (not a hand-written field list)",
    /\.update\(\s*contactRedactionPatch\(/.test(actionSrc))
  check("no stale 5-field object left behind (no literal first_name: audit_hash in the update)",
    !/\.update\(\s*\{[\s\S]*?first_name:\s*audit_hash/.test(actionSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live erasure]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `DsrErase${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 3 · live erasure]")
  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const email = `${TAG}@probe.local`.toLowerCase()

    // Seed a contact populated across the WHOLE PII surface. Typed columns get
    // type-correct values; everything else is a text marker. This is the worst
    // case an erasure must fully clear.
    const jsonbCols = new Set(["metadata", "social_handles", "enrichment_profile", "court_records", "public_records", "property_records"])
    const dateCols = new Set(["birthday", "home_anniversary"])
    const tsCols = new Set(["legal_name_verified_at"])
    const numCols = new Set(["household_income"])
    const seed: Record<string, unknown> = {
      brokerage_id: brokerageId, agent_id: (agent as any).id,
      contact_type: "buyer", status: "active",
      first_name: `${TAG}`, last_name: "Probe", email, phone: "+15555550100", notes: "seed notes",
    }
    for (const col of CONTACT_PII_NULL_COLUMNS) {
      if (jsonbCols.has(col)) seed[col] = { seeded: TAG }
      else if (dateCols.has(col)) seed[col] = "1990-01-15"
      else if (tsCols.has(col)) seed[col] = new Date().toISOString()
      else if (numCols.has(col)) seed[col] = 175000
      else seed[col] = `${TAG}-${col}`
    }
    const { data: c, error: cErr } = await svc.from("contacts").insert(seed).select("id").single()
    if (cErr) { check("seed contact with FULL PII surface", false, cErr.message); report(); return }
    const contactId = (c as any).id
    cleanup.push({ table: "contacts", id: contactId })
    check("seed: contact populated across the whole PII surface", !!contactId)

    // A CLOSED transaction linked to the contact — must SURVIVE erasure (retention).
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} deal`, deal_type: "buyer",
      status: "closed", stage: "CLOSED", property_address: `${TAG} 1 Main St`,
      buyer_contact_id: contactId, contact_id: contactId, agent_id: (agent as any).id,
    }).select("id").single()
    if (txn) cleanup.push({ table: "transactions", id: (txn as any).id })

    // Confirm the seed really populated the sensitive columns BEFORE erasure.
    const { data: before } = await svc.from("contacts")
      .select(MUST_CLEAR.join(",") + ",dl_image_url").eq("id", contactId).single()
    check("pre-erasure: sensitive columns hold real values (DL image, legal name, financial…)",
      !!(before as any)?.dl_image_url && !!(before as any)?.legal_first_name && (before as any)?.household_income != null)

    // Apply the EXACT patch the action applies (the action itself needs an auth
    // session; this proves the patch the action was just wired to fully redacts).
    const auditHash = "anon_live" + String(contactId).replace(/-/g, "").slice(0, 10)
    const { error: uErr } = await svc.from("contacts")
      .update(contactRedactionPatch(auditHash, "sim-" + TAG))
      .eq("id", contactId)
    check("erasure UPDATE applied without a column/type error", !uErr, uErr?.message)

    // Read the WHOLE row back and assert every PII column is cleared.
    const { data: after } = await svc.from("contacts").select("*").eq("id", contactId).single()
    const row = (after as any) ?? {}
    const survivors: string[] = []
    for (const col of CONTACT_PII_NULL_COLUMNS) if (row[col] !== null) survivors.push(`${col}=${JSON.stringify(row[col])}`)
    check("post-erasure: EVERY nullable PII column is null (DL image, legal name, address, financial, records, social, ids)",
      survivors.length === 0, survivors.slice(0, 8).join(" | "))
    check("post-erasure: name/email are redaction markers, phone + notes null",
      row.first_name === auditHash && row.last_name === "[deleted]" &&
      row.email === `${auditHash}@deleted.local` && row.phone === null && row.notes === null)
    check("post-erasure: privacy_anonymized_at stamped + reason cites the request",
      typeof row.privacy_anonymized_at === "string" && String(row.privacy_anonymized_reason).includes("sim-" + TAG))
    check("post-erasure: retention columns intact (brokerage_id, agent_id, created_at, contact_type)",
      row.brokerage_id === brokerageId && !!row.created_at && row.contact_type === "buyer")

    // The transaction is RETAINED (state real-estate retention) — erasure de-identifies, never deletes deals.
    const { data: txnStill } = await svc.from("transactions").select("id, status")
      .like("deal_name", `${TAG}%`).maybeSingle()
    check("transaction RETAINED after erasure (not deleted)", !!txnStill && (txnStill as any).status === "closed")
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).ilike("email", `${TAG}%`)
    const { count: tCount } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("deal_name", `${TAG}%`)
    check("cleanup verified — 0 seeded rows remain", (count ?? 0) === 0 && (tCount ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
