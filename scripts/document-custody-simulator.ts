#!/usr/bin/env tsx
/**
 * scripts/document-custody-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DOCUMENT STORAGE CUSTODY harness — governed signed-URL access + access audit +
 * per-category retention policy for the `client-documents` Supabase Storage bucket.
 *
 * Layer 1 (pure, no I/O):
 *   · retentionPolicyFor(doc_category) across the canonical enum → {keepYears, basis},
 *     honest defaults (every basis says "default — confirm your state"); off-enum → fallback.
 *   · isRetentionExpired boundaries — not-yet-expired ON the retain-until day, expired
 *     strictly after; unparsable/missing created_at → not expired (cannot judge).
 *   · signedUrlTtlFor(purpose) → seconds (view < download < share < compliance_export;
 *     unknown → shortest safe default).
 *
 * Layer 2 (live, gated): ensure the PRIVATE client-documents bucket + upload a real
 *   object → seed a client_documents row pointing at it → issueGovernedDocumentUrl
 *   → assert a TIME-LIMITED signed URL minted + an access-audit row written to
 *   document_access_log (who/when/why/doc) → a doc with no parsable bucket path is
 *   honestly refused (no URL, no audit row) → seed an OLD doc and runRetentionScan
 *   flags it → reverse-delete + cleanup count == 0.
 *
 * Run: npx tsx scripts/document-custody-simulator.ts  (npm run test:document-custody)
 */
import {
  retentionPolicyFor,
  isRetentionExpired,
  signedUrlTtlFor,
  RETENTION_DEFAULTS,
  DEFAULT_RETENTION,
  DEFAULT_TTL_SECONDS,
  parseBucketObjectPath,
  DOCUMENT_BUCKET,
} from "../lib/kernel/document-custody"
import { DOC_CATEGORIES, type DocCategory } from "../lib/kernel/document-autofile"

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
  console.log(" ✅ Document Custody verified — governed signed-URL access + access audit + retention policy")
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Document Storage Custody simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure retention policy per category]")

  // Every canonical category resolves to a real policy with an honest basis.
  for (const cat of DOC_CATEGORIES) {
    const p = retentionPolicyFor(cat)
    check(`retentionPolicyFor("${cat}") → keepYears ${p.keepYears}`, p.keepYears >= 1 && p.keepYears <= 10, String(p.keepYears))
    check(`  basis is honest (mentions "default" / "confirm")`,
      /default/i.test(p.basis) && /confirm/i.test(p.basis), p.basis)
    check(`  policy === the documented RETENTION_DEFAULTS entry`,
      p === RETENTION_DEFAULTS[cat as DocCategory])
  }

  // The legal-record spine gets the longer (7yr) default; diligence reports shorter (5yr).
  check("offer_form retained 7yr (core transaction record)", retentionPolicyFor("offer_form").keepYears === 7)
  check("contract retained 7yr", retentionPolicyFor("contract").keepYears === 7)
  check("disclosure retained 7yr (longest tail liability)", retentionPolicyFor("disclosure").keepYears === 7)
  check("title retained 7yr (closing record)", retentionPolicyFor("title").keepYears === 7)
  check("inspection_report retained 5yr (supporting record)", retentionPolicyFor("inspection_report").keepYears === 5)
  check("appraisal retained 5yr", retentionPolicyFor("appraisal").keepYears === 5)

  // Off-enum / null → the conservative DEFAULT fallback (never throws).
  check("unknown category → DEFAULT_RETENTION fallback", retentionPolicyFor("not_a_real_category") === DEFAULT_RETENTION)
  check("null category → DEFAULT_RETENTION fallback", retentionPolicyFor(null) === DEFAULT_RETENTION)
  check("undefined category → DEFAULT_RETENTION fallback", retentionPolicyFor(undefined) === DEFAULT_RETENTION)
  check("DEFAULT_RETENTION basis is honest", /default/i.test(DEFAULT_RETENTION.basis) && /confirm/i.test(DEFAULT_RETENTION.basis))

  console.log("\n[Layer 1 · pure retention expiry boundaries]")

  const now = new Date("2026-06-13T12:00:00.000Z")

  // A 5yr-retention doc (inspection_report): 4yr old NOT expired; 6yr old expired.
  const fresh = isRetentionExpired({ doc_category: "inspection_report", created_at: "2022-06-13T12:00:00.000Z" }, now) // ~4yr
  check("inspection_report ~4yr old → NOT expired (5yr window)", fresh.expired === false, JSON.stringify(fresh))
  check("  retainUntil computed (created + 5yr)", (fresh.retainUntil ?? "").startsWith("2027-"), String(fresh.retainUntil))
  const old = isRetentionExpired({ doc_category: "inspection_report", created_at: "2020-06-13T12:00:00.000Z" }, now) // ~6yr
  check("inspection_report ~6yr old → expired (past 5yr window)", old.expired === true, JSON.stringify(old))
  check("  daysOverdue > 0 when expired", old.daysOverdue > 0, String(old.daysOverdue))

  // Boundary honesty: the day retention ENDS is NOT yet expired; one day later IS.
  const onEnd = isRetentionExpired(
    { doc_category: "offer_form", created_at: "2019-06-13T12:00:00.000Z" }, // +7yr = 2026-06-13 (== now)
    now,
  )
  check("ON the retain-until day → NOT yet expired (honest boundary)", onEnd.expired === false, JSON.stringify(onEnd))
  const dayAfter = isRetentionExpired(
    { doc_category: "offer_form", created_at: "2019-06-12T12:00:00.000Z" }, // +7yr = 2026-06-12 (< now)
    now,
  )
  check("one day PAST retain-until → expired", dayAfter.expired === true && dayAfter.daysOverdue >= 1, JSON.stringify(dayAfter))

  // Honest: missing / unparsable created_at → cannot judge → NOT expired, retainUntil null.
  const noDate = isRetentionExpired({ doc_category: "offer_form", created_at: null }, now)
  check("missing created_at → NOT expired (cannot judge), retainUntil null", noDate.expired === false && noDate.retainUntil === null)
  const badDate = isRetentionExpired({ doc_category: "offer_form", created_at: "not-a-date" }, now)
  check("unparsable created_at → NOT expired, retainUntil null", badDate.expired === false && badDate.retainUntil === null)

  // Unknown category still gets the fallback policy applied to the date math.
  const unknownOld = isRetentionExpired({ doc_category: null, created_at: "2010-01-01T00:00:00.000Z" }, now)
  check("very old + unknown category → expired under fallback (7yr)", unknownOld.expired === true && unknownOld.keepYears === 7)

  console.log("\n[Layer 1 · pure signed-URL TTL policy]")

  check("ttl view = 5 min", signedUrlTtlFor("view") === 5 * 60)
  check("ttl download = 15 min", signedUrlTtlFor("download") === 15 * 60)
  check("ttl share = 1 hour", signedUrlTtlFor("share") === 60 * 60)
  check("ttl compliance_export = 24 hours", signedUrlTtlFor("compliance_export") === 24 * 60 * 60)
  check("ttl analysis = 10 min", signedUrlTtlFor("analysis") === 10 * 60)
  check("view < download < share < compliance_export (escalating)",
    signedUrlTtlFor("view") < signedUrlTtlFor("download") &&
    signedUrlTtlFor("download") < signedUrlTtlFor("share") &&
    signedUrlTtlFor("share") < signedUrlTtlFor("compliance_export"))
  check("unknown purpose → shortest safe default (view)", signedUrlTtlFor("bogus") === DEFAULT_TTL_SECONDS && DEFAULT_TTL_SECONDS === 5 * 60)
  check("null purpose → default", signedUrlTtlFor(null) === DEFAULT_TTL_SECONDS)
  check("every TTL is a positive integer", ["view","download","share","compliance_export","analysis"].every((p) => Number.isInteger(signedUrlTtlFor(p)) && signedUrlTtlFor(p) > 0))

  console.log("\n[Layer 1 · pure bucket-path parsing reused for custody]")
  const pub = `https://proj.supabase.co/storage/v1/object/public/${DOCUMENT_BUCKET}/contacts/c1/x.pdf`
  check("parseBucketObjectPath: in-bucket public URL → object key", parseBucketObjectPath(pub) === "contacts/c1/x.pdf")
  check("parseBucketObjectPath: data: URL → null (cannot sign)", parseBucketObjectPath("data:application/pdf;base64,AAA") === null)
  check("parseBucketObjectPath: external URL → null (cannot sign)", parseBucketObjectPath("https://example.test/x.pdf") === null)

  // ───────────────────────────────────────────────────────────────────────────
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live governed access + retention scan]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live governed access + retention scan]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { issueGovernedDocumentUrl, runRetentionScan } = await import("../lib/kernel/document-custody")
  const svc = createServiceClient()
  const TAG = `Custody${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  let uploadedObjectPath: string | null = null

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent with a brokerage."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Ensure the PRIVATE client-documents bucket exists (matches scripts/511 intent:
    // public=false). If it already exists this is a no-op.
    try {
      await (svc as any).storage.createBucket(DOCUMENT_BUCKET, { public: false })
    } catch { /* exists — fine */ }

    // Upload a REAL object so createSignedUrl has something to sign (no mocks).
    uploadedObjectPath = `${brokerageId}/${TAG}/offer_form/${TAG}_psa.pdf`
    const body = Buffer.from(`%PDF-1.4 ${TAG} test purchase agreement\n`)
    const up = await (svc as any).storage.from(DOCUMENT_BUCKET).upload(uploadedObjectPath, body, {
      contentType: "application/pdf", upsert: true,
    })
    if (up.error) {
      console.log(`  ⏭  Skipped live storage — upload failed: ${up.error.message}`)
      report(); return
    }
    const { data: pubData } = (svc as any).storage.from(DOCUMENT_BUCKET).getPublicUrl(uploadedObjectPath)
    const storedUrl = pubData?.publicUrl as string

    // Seed a FILED client_documents row pointing at the real uploaded object.
    const { data: pdoc } = await svc.from("client_documents").insert({
      brokerage_id: brokerageId,
      document_name: `${TAG} Purchase Agreement.pdf`,
      document_url: storedUrl,
      doc_category: "offer_form",
      document_type: "offer_form",
    }).select("id").single()
    const docId = (pdoc as any).id
    cleanup.push({ table: "client_documents", id: docId })

    // ISSUE a governed, time-limited, audited URL.
    const res = await issueGovernedDocumentUrl({
      documentId: docId,
      requestedBy: { type: "agent", id: (agent as any).id, email: "audit@test.local", ipAddress: "127.0.0.1", userAgent: "custody-sim" },
      purpose: "download",
    }, svc)

    check("issueGovernedDocumentUrl: ok", res.ok === true, JSON.stringify(res))
    check("signed URL minted (is a /object/sign/ URL, not bare public)",
      !!res.signedUrl && res.signedUrl.includes("/object/sign/") && res.signedUrl.includes("token="), String(res.signedUrl))
    check("signed for the download TTL (15 min)", res.ttlSeconds === 15 * 60, String(res.ttlSeconds))
    check("signed the correct in-bucket object path", res.objectPath === uploadedObjectPath, String(res.objectPath))
    check("an access-audit row id returned", !!res.auditId, String(res.auditId))
    if (res.auditId) cleanup.push({ table: "document_access_log", id: res.auditId })

    // The audit row records WHO / WHEN / WHY / WHICH DOC.
    const { data: logRow } = await svc.from("document_access_log")
      .select("document_id, accessed_by_type, accessed_by_id, accessed_by_email, access_type, ip_address, accessed_at")
      .eq("id", res.auditId).maybeSingle()
    check("audit row: document_id matches the doc", (logRow as any)?.document_id === docId)
    check("audit row: access_type = the purpose (download)", (logRow as any)?.access_type === "download")
    check("audit row: who (type=agent, email recorded)",
      (logRow as any)?.accessed_by_type === "agent" && (logRow as any)?.accessed_by_email === "audit@test.local")
    check("audit row: when (accessed_at present)", !!(logRow as any)?.accessed_at)

    // HONEST refusal: a doc whose document_url is NOT a parsable bucket object
    // (data: DB-fallback) → no signed URL, NO fabricated audit row.
    const { data: badDoc } = await svc.from("client_documents").insert({
      brokerage_id: brokerageId,
      document_name: `${TAG} fallback.pdf`,
      document_url: "data:application/pdf;base64,JVBERi0xLjQ=",
      doc_category: "other",
    }).select("id").single()
    const badId = (badDoc as any).id
    cleanup.push({ table: "client_documents", id: badId })

    const badRes = await issueGovernedDocumentUrl({
      documentId: badId, requestedBy: { type: "agent" }, purpose: "view",
    }, svc)
    check("honest: data: URL doc → ok false with a reason", badRes.ok === false && !!badRes.reason, JSON.stringify(badRes))
    check("honest: no signed URL fabricated", !badRes.signedUrl)
    const { count: badAuditCount } = await svc.from("document_access_log")
      .select("id", { count: "exact", head: true }).eq("document_id", badId)
    check("honest: NO audit row written for the un-signable doc", (badAuditCount ?? 0) === 0, `got ${badAuditCount}`)

    // RETENTION SCAN: seed an OLD offer_form (created 8yr ago → past 7yr window) and
    // assert the scan flags it. The scan is a REPORT — it never deletes.
    const { data: oldDoc } = await svc.from("client_documents").insert({
      brokerage_id: brokerageId,
      document_name: `${TAG} OLD contract.pdf`,
      document_url: "https://example.test/old.pdf",
      doc_category: "offer_form",
      created_at: daysAgoISO(365 * 8),
    }).select("id").single()
    const oldId = (oldDoc as any).id
    cleanup.push({ table: "client_documents", id: oldId })

    const scan = await runRetentionScan(brokerageId, svc, { limit: 5000 })
    check("retention scan: scanned ≥ the seeded docs", scan.scanned >= 1, JSON.stringify({ scanned: scan.scanned }))
    check("retention scan: no errors", scan.errors.length === 0, scan.errors.join("; "))
    const flagged = scan.overdue.find((f) => f.documentId === oldId)
    check("retention scan: flags the 8yr-old offer_form as overdue", !!flagged, JSON.stringify(scan.overdue.slice(0, 3)))
    check("retention flag: carries keepYears + daysOverdue + honest basis",
      !!flagged && flagged.keepYears === 7 && flagged.daysOverdue > 0 && /default/i.test(flagged.basis), JSON.stringify(flagged))

    // The recent download-test doc (created just now) is NOT flagged overdue.
    check("retention scan: the fresh doc is NOT flagged", !scan.overdue.some((f) => f.documentId === docId))
  } finally {
    // Reverse-delete every seeded row, then remove the uploaded storage object.
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    if (uploadedObjectPath) {
      try { await (svc as any).storage.from(DOCUMENT_BUCKET).remove([uploadedObjectPath]) } catch { /* noop */ }
    }
    const { count: docCount } = await svc.from("client_documents").select("id", { count: "exact", head: true }).like("document_name", `${TAG}%`)
    const { count: logCount } = await svc.from("document_access_log").select("id", { count: "exact", head: true })
      .in("access_type", ["download"]).eq("accessed_by_email", "audit@test.local")
    check("cleanup verified — 0 seeded documents remain", (docCount ?? 0) === 0, `docs=${docCount}`)
    check("cleanup verified — 0 seeded audit rows remain", (logCount ?? 0) === 0, `logs=${logCount}`)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
