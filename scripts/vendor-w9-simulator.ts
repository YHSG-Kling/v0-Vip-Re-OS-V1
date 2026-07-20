#!/usr/bin/env tsx
/**
 * scripts/vendor-w9-simulator.ts   (suggested npm name: test:vendor-w9 —
 *   "test:vendor-w9": "tsx scripts/vendor-w9-simulator.ts")
 *   npx tsx scripts/vendor-w9-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VENDOR W-9 ON FILE (owner round 43). Locks:
 *
 *  1. CAPTURE SHAPE — the TIN is NEVER stored in a general column: the
 *     vendor_tax_documents schema carries tin_type ONLY (EIN|SSN); a grep lock
 *     over the migration + snapshot + code proves no tin/ssn/ein value column
 *     or param exists. The certified record is the PDF on the EXISTING
 *     client-documents rail (bucket + client_documents row — no new storage path).
 *  2. STATUS VOCABULARY — 'missing' | 'on_file' | 'expired'; expiry is DERIVED
 *     from a legal-name change after filing (never a clock, never fabricated).
 *  3. SOFT GATE — payout + invoice lanes are NEVER hard-blocked on a missing
 *     W-9; both surface the honest w9Warning (vendor banner + brokerage badge).
 *  4. THE CHASE — governed b2b transactional dispatchEmail only (the round-34
 *     vendor-notification idiom), deduped once per period via CLAIM-then-send
 *     on reminder_last_sent_at.
 *  5. CONSOLE BADGE + CRITICAL SETUP — the brokerage vendor console shows
 *     on_file/missing per vendor; the vendor-role critical-setup item exists
 *     with an honest DB-derived checker (flips false→true on w9OnFile alone).
 *  6. MIGRATION CONTENT LOCK — m275 creates the table with the exact CHECK
 *     vocabularies, one row per vendor, RLS enabled.
 */
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  W9_STATUSES,
  W9_BUSINESS_TYPES,
  W9_TIN_TYPES,
  W9_REMINDER_PERIOD_DAYS,
  deriveW9Status,
  w9SoftGateWarning,
  shouldSendW9Reminder,
} from "../lib/vendors/w9"
import {
  CRITICAL_SETUP_ITEMS,
  composeSetupReadiness,
  emptyCriticalSetupFacts,
} from "../lib/onboarding/critical-setup"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")

// ─── 1 · PURE — status vocabulary + derivation ───────────────────────────────
console.log("\n[1 · status vocabulary + derived expiry — pure]")
{
  check("status vocabulary is exactly missing|on_file|expired",
    W9_STATUSES.length === 3 && W9_STATUSES.join(",") === "missing,on_file,expired")
  check("business types are the W-9 line-3 classification enum (7 values incl. individual/sole prop, LLC)",
    W9_BUSINESS_TYPES.length === 7 &&
    W9_BUSINESS_TYPES.includes("individual_sole_proprietor") && W9_BUSINESS_TYPES.includes("llc"))
  check("TIN TYPE vocabulary is exactly ein|ssn — a type, never a number",
    W9_TIN_TYPES.length === 2 && W9_TIN_TYPES.includes("ein") && W9_TIN_TYPES.includes("ssn"))

  check("no record ⇒ missing", deriveW9Status(null, "Acme Roofing") === "missing")
  check("stored missing ⇒ missing", deriveW9Status({ status: "missing", vendorNameAtFiling: null }, "Acme") === "missing")
  check("on_file + unchanged name ⇒ on_file",
    deriveW9Status({ status: "on_file", vendorNameAtFiling: "Acme Roofing" }, "Acme Roofing") === "on_file")
  check("on_file + legal name changed after filing ⇒ EXPIRED",
    deriveW9Status({ status: "on_file", vendorNameAtFiling: "Acme Roofing" }, "Acme Roofing LLC") === "expired")
  check("cosmetic case/whitespace change never fabricates an expiry",
    deriveW9Status({ status: "on_file", vendorNameAtFiling: "Acme Roofing" }, "  ACME roofing ") === "on_file")
  check("on_file with no filing snapshot ⇒ on_file (never a fabricated expiry)",
    deriveW9Status({ status: "on_file", vendorNameAtFiling: null }, "Acme Roofing") === "on_file")
  check("stored expired stays expired", deriveW9Status({ status: "expired", vendorNameAtFiling: "X" }, "X") === "expired")
}

// ─── 2 · PURE — soft gate + reminder dedupe ──────────────────────────────────
console.log("\n[2 · soft-gate warning + reminder dedupe — pure]")
{
  check("on_file ⇒ NO warning (lane runs clean)", w9SoftGateWarning("on_file") === null)
  check("missing ⇒ honest warning that payments still proceed",
    /W-9 not on file/.test(w9SoftGateWarning("missing") ?? "") && /still proceed/i.test(w9SoftGateWarning("missing") ?? ""))
  check("expired ⇒ honest updated-W-9 warning", /no longer matches/.test(w9SoftGateWarning("expired") ?? ""))

  const NOW = new Date("2026-07-20T00:00:00Z")
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
  check("on_file ⇒ never remind",
    !shouldSendW9Reminder({ status: "on_file", reminderLastSentAt: null, now: NOW }))
  check("missing + never reminded ⇒ remind",
    shouldSendW9Reminder({ status: "missing", reminderLastSentAt: null, now: NOW }))
  check(`missing + reminded 5d ago ⇒ DEDUPED (period ${W9_REMINDER_PERIOD_DAYS}d)`,
    !shouldSendW9Reminder({ status: "missing", reminderLastSentAt: daysAgo(5), now: NOW }))
  check("missing + reminded 1 period + 1d ago ⇒ remind again",
    shouldSendW9Reminder({ status: "missing", reminderLastSentAt: daysAgo(W9_REMINDER_PERIOD_DAYS + 1), now: NOW }))
  check("expired ⇒ also chased (same dedupe)",
    shouldSendW9Reminder({ status: "expired", reminderLastSentAt: null, now: NOW }))
  check("unparseable timestamp counts as never-sent (honest)",
    shouldSendW9Reminder({ status: "missing", reminderLastSentAt: "nope", now: NOW }))
}

// ─── 3 · TIN NEVER IN A PLAIN COLUMN — grep lock ─────────────────────────────
console.log("\n[3 · TIN posture — type only, never the number]")
{
  const migration = src("supabase/migrations/m275-vendor-tax-documents.sql")
  const cols = SCHEMA_SNAPSHOT["vendor_tax_documents"] ?? []
  check("vendor_tax_documents is in the schema snapshot", cols.length > 0)
  const tinish = cols.filter((c) => /(^|_)(tin|ssn|ein|taxpayer)($|_)/.test(c))
  check(`the ONLY tin-ish column is tin_type (found: ${tinish.join(",") || "none"})`,
    tinish.length === 1 && tinish[0] === "tin_type")
  check("migration constrains tin_type to ('ein','ssn')",
    /tin_type\s+text\s+check\s*\(tin_type in \('ein','ssn'\)\)/.test(migration))
  check("migration has NO tin/ssn value column",
    !/tin_number|ssn_number|social_security|taxpayer_identification/i.test(migration))
  for (const f of ["lib/vendors/w9.ts", "lib/vendors/w9-vocab.ts", "app/actions/vendor-w9.ts", "app/vendor/documents/w9-card.tsx"]) {
    check(`${f} never handles a TIN value (no tin_number/ssn_number/social_security param)`,
      !/tin_number|tinNumber|ssn_number|ssnNumber|social_security|socialSecurity/i.test(src(f)))
  }
  check("the action captures tinType (the type) and documents the never-store posture",
    /tinType: W9TinType/.test(src("app/actions/vendor-w9.ts")) &&
    /NEVER accepted or stored/i.test(src("app/actions/vendor-w9.ts")))
}

// ─── 4 · CAPTURE RIDES THE EXISTING DOC RAIL ─────────────────────────────────
console.log("\n[4 · capture — existing client-documents rail, portal-gated]")
{
  const action = src("app/actions/vendor-w9.ts")
  check("upload is portal-gated (requireVendorActor — the caller must BE the vendor)",
    action.includes("requireVendorActor(input.vendorId)"))
  check("PDF lands in the EXISTING 'client-documents' storage bucket (no new storage path)",
    action.includes('.from("client-documents")') && action.includes(".upload("))
  check("a client_documents row records the doc (document_type 'vendor_w9')",
    action.includes('from("client_documents")') && action.includes('"vendor_w9"'))
  check("structured basics upsert onto vendor_tax_documents (one row per vendor)",
    action.includes('from("vendor_tax_documents")') && action.includes('onConflict: "vendor_id"'))
  check("filing snapshots vendors.name for honest expiry derivation",
    action.includes("vendor_name_at_filing"))
  const page = src("app/vendor/documents/page.tsx")
  check("the vendor documents surface mounts the W-9 card", page.includes("VendorW9Card"))
  check("the W-9 card drives the upload action", src("app/vendor/documents/w9-card.tsx").includes("uploadVendorW9Action"))
  check("the client card imports ONLY the pure vocab half (dispatch rail stays server-side)",
    src("app/vendor/documents/w9-card.tsx").includes('from "@/lib/vendors/w9-vocab"') &&
    !src("app/vendor/documents/w9-card.tsx").includes('from "@/lib/vendors/w9"'))
}

// ─── 5 · SOFT GATE — lanes never hard-blocked ────────────────────────────────
console.log("\n[5 · soft gate — payout + invoice lanes warn, never block]")
{
  const payments = src("app/actions/vendor-payments.ts")
  check("initiateVendorPayout reads the W-9 and surfaces w9Warning",
    /initiateVendorPayout[\s\S]*?w9SoftGateWarning/.test(payments) &&
    /payoutId: payout\.id, w9Warning/.test(payments))
  check("createAndSendVendorClientInvoice surfaces w9Warning",
    /emailSent, emailError, w9Warning/.test(payments))
  check("NO lane returns success:false over a W-9 (hard block would strand mid-flight vendors)",
    !/success:\s*false,\s*error:\s*[`"'][^`"'\n]*W-?9/i.test(payments))
  check("the soft-gate verdict is documented in the lane",
    /NEVER hard-blocks? on a\s+[\s\S]{0,80}missing W-9/.test(payments) || /SOFT gate/.test(payments))
  const invoicesPage = src("app/vendor/invoices/page.tsx")
  check("VENDOR side sees the warning banner on the invoice lane (link to upload)",
    invoicesPage.includes("w9SoftGateWarning") && invoicesPage.includes("/vendor/documents"))
  const console_ = src("app/dashboard/vendors/page.tsx")
  check("BROKERAGE console shows the per-vendor W-9 badge (who to chase)",
    console_.includes("readW9StatusMap") && console_.includes("W9Badge") &&
    console_.includes("W-9 on file") && console_.includes("W-9 missing"))
}

// ─── 6 · THE CHASE — governed, deduped, claim-then-send ──────────────────────
console.log("\n[6 · reminder — governed dispatch, once per period]")
{
  const w9 = src("lib/vendors/w9.ts")
  const fn = w9.slice(w9.indexOf("export async function maybeSendVendorW9Reminder"))
  check("reminder rides the governed dispatchEmail (b2b transactional — the round-34 vendor idiom)",
    fn.includes('await import("@/lib/providers/dispatch")') &&
    fn.includes('channelPurpose: "transactional"') &&
    fn.includes('systemSource: "vendor_w9_reminder"'))
  check("no raw sender anywhere in the W-9 module (governed send only — SENDGRID_FROM_EMAIL is just the from-address env the governed lanes share)",
    !/nodemailer|@sendgrid\/|createTransport|smtpTransport|new SMTP/i.test(w9) &&
    !w9.includes('import("@sendgrid'))
  check("dedupe is CLAIM-then-send on reminder_last_sent_at (conditional update)",
    fn.includes("reminder_last_sent_at.is.null") && fn.includes("reminder_last_sent_at.lt."))
  const claimIdx = fn.indexOf("reminder_last_sent_at.is.null")
  const sendIdx = fn.indexOf('await import("@/lib/providers/dispatch")')
  check("the claim happens BEFORE the send (concurrent lanes can never double-send)",
    claimIdx > -1 && sendIdx > claimIdx)
  check("shouldSendW9Reminder gates the period (pure dedupe drives the IO)",
    fn.includes("shouldSendW9Reminder("))
  check("on_file vendors are never chased", fn.includes('if (read.status === "on_file") return'))
  const payments = src("app/actions/vendor-payments.ts")
  check("payout activity triggers the chase (trigger: 'payout')", payments.includes('trigger: "payout"'))
  check("invoice activity triggers the chase (trigger: 'invoice')", payments.includes('trigger: "invoice"'))
}

// ─── 7 · CRITICAL SETUP — honest checker + invite-accept surfacing ───────────
console.log("\n[7 · critical-setup item + checker honesty]")
{
  const item = CRITICAL_SETUP_ITEMS.find((i) => i.key === "vendor_w9")
  check("vendor_w9 item exists (role vendor)", !!item && item.role === "vendor")
  check("settingHref lands on the real W-9 surface (/vendor/documents)",
    item?.settingHref === "/vendor/documents" && existsSync(join(root, "app/vendor/documents/page.tsx")))
  check("why-line is honest (1099 reporting)", /1099/.test(item?.why ?? ""))

  const empty = emptyCriticalSetupFacts("brokerage")
  const before = composeSetupReadiness({ role: "vendor", facts: empty })
  check("empty facts ⇒ vendor_w9 NOT configured",
    before.items.some((i) => i.key === "vendor_w9" && !i.configured))
  const after = emptyCriticalSetupFacts("brokerage")
  after.vendor = { profileComplete: false, payoutConnected: false, booksConnected: false, w9OnFile: true }
  const flipped = composeSetupReadiness({ role: "vendor", facts: after })
  check("w9OnFile alone flips vendor_w9 configured (checker reads only the loaded fact)",
    flipped.items.some((i) => i.key === "vendor_w9" && i.configured) &&
    flipped.items.some((i) => i.key === "vendor_profile" && !i.configured))

  const registry = src("lib/onboarding/critical-setup.ts")
  check("facts loader reads vendor_tax_documents (a real table — snapshot-guarded)",
    registry.includes('from("vendor_tax_documents")') && "vendor_tax_documents" in SCHEMA_SNAPSHOT)
  check("loader derives expiry from the filing snapshot (same rule as deriveW9Status)",
    registry.includes("vendor_name_at_filing"))
  check("round-42 onboarding sim's fullFacts keeps the lock honest (w9OnFile: true)",
    src("scripts/onboarding-readiness-simulator.ts").includes("w9OnFile: true"))

  const accept = src("app/vendor-invite/[token]/accept-form.tsx")
  check("invite-accept flow surfaces the W-9 step (link to /vendor/documents)",
    accept.includes("W-9") && accept.includes("/vendor/documents"))
}

// ─── 8 · MIGRATION CONTENT LOCK ──────────────────────────────────────────────
console.log("\n[8 · migration m275 content lock]")
{
  const m = src("supabase/migrations/m275-vendor-tax-documents.sql")
  check("creates vendor_tax_documents", /create table if not exists vendor_tax_documents/.test(m))
  check("one W-9 row per vendor (vendor_id unique, FK to vendors)",
    /vendor_id\s+uuid not null unique references vendors\(id\)/.test(m))
  check("status CHECK is the exact vocabulary",
    /check \(status in \('missing','on_file','expired'\)\)/.test(m))
  check("business_type CHECK is the W-9 line-3 enum",
    /'individual_sole_proprietor','c_corporation','s_corporation'/.test(m) && /'partnership','trust_estate','llc','other'/.test(m))
  check("doc reference points at the client-documents rail (client_document_id + document_url)",
    m.includes("client_document_id") && m.includes("document_url"))
  check("reminder_last_sent_at dedupe anchor exists", m.includes("reminder_last_sent_at"))
  check("RLS enabled with vendor self-read + brokerage read",
    m.includes("enable row level security") &&
    m.includes("vendor reads own tax doc") && m.includes("brokerage reads vendor tax docs"))
  check("TIN posture documented in the migration itself", /TIN itself[\s\S]{0,120}(never|NEVER)/i.test(m) || /never the TIN/i.test(m))
}

// ─── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`)
console.log(`vendor-w9 simulator: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("FAILURES:")
  for (const f of failures) console.log(`  • ${f}`)
  process.exit(1)
}
console.log("ALL CHECKS PASSED")
