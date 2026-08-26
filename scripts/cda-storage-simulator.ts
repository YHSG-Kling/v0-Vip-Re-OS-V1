// scripts/cda-storage-simulator.ts   (npm run test:cda-storage)
// ─────────────────────────────────────────────────────────────────────────────
// CDA STORAGE — proves the CDA template + filled-PDF flow stores in SUPABASE
// BUCKETS, never Vercel Blob. Root bug: the CDA template PDF uploaded through
// /api/blob/upload, whose allowedContentTypes excluded application/pdf, so every
// CDA template upload failed with a blob error. Owner rule: all upload/download
// storage is Supabase buckets.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
/**
 * COMMENT-STRIPPED source. Every check below asks whether a file CONTAINS or
 * DOES NOT CONTAIN a code token, and this guard is built almost entirely out of
 * absence assertions ("does NOT use Vercel Blob"). Reading raw source makes a
 * TOMBSTONE — which CLAUDE.md §1 requires to name the thing it replaced, and
 * therefore to spell `@vercel/blob` — count as a live import, so the guard
 * would report the migration it is checking for as un-done, forever, and go
 * red precisely BECAUSE the orphan doctrine was followed. That is the exact
 * failure §2 records five guards hitting in one wave. scripts/strip-comments.ts
 * is the one correct scanner; nothing here hand-rolls one.
 */
const src = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))

console.log("\n── the shared Supabase bucket helper ──")
{
  const h = src("lib/storage/buckets.ts")
  check("ensureBucket + uploadBufferToBucket exist and use the Supabase storage API",
    h.includes("export async function ensureBucket") &&
    h.includes("export async function uploadBufferToBucket") &&
    h.includes(".storage.") && h.includes("createBucket"))
  // The branch this used to assert INSIDE buckets.ts moved to the ONE issuer,
  // lib/storage/document-buckets.ts#issueBucketObjectUrl, so that "how a bucket
  // object URL is minted" has a single spelling (CLAUDE.md §6). The invariant is
  // unchanged and is asserted at its new home; buckets.ts must now DELEGATE
  // rather than carry its own copy.
  // Matched on the CALL shape (leading dot + paren), not the bare word — the
  // file names getPublicUrl in prose to say it never falls back to one, and
  // reading a mention as a use is the mistake scripts/strip-comments.ts exists for.
  check("uploadBufferToBucket delegates URL minting to the ONE issuer",
    h.includes("issueBucketObjectUrl(") && !h.includes(".getPublicUrl(") && !h.includes(".createSignedUrl("))
  const iss = src("lib/storage/document-buckets.ts")
  check("private buckets return a signed URL, public buckets a public URL",
    iss.includes(".getPublicUrl(") && iss.includes("signedDocUrl("))
}

console.log("\n── CDA template upload is Supabase, role-gated, PDF-validated ──")
{
  const a = src("app/actions/cda-storage.ts")
  check("uploadCdaTemplateFile uploads via the Supabase bucket helper",
    a.includes("uploadBufferToBucket") && a.includes('"cda-templates"'))
  // The gate is asserted by WHERE IT COMES FROM, not by the identifier it is
  // spelled with. This line used to pin the name `isAdminOrBroker`, and it broke
  // the moment m472 moved CDA storage onto the narrower money predicate — which
  // the owner's ruling names explicitly ("CDA storage") among the gates team_lead
  // is held out of. A probe pinned to a name reports a CORRECT tightening as a
  // regression, so it is pinned to the canonical roster module instead: there is
  // exactly one module allowed to answer "is this caller an admin", and any gate
  // imported from it is the shared answer rather than a local literal.
  check("role-gated from the ONE roster module, and validates application/pdf",
    /from\s+["']@\/lib\/auth\/resolve-user-role["']/.test(a) && a.includes('"application/pdf"'))
  check("...and specifically on the FINANCE tier, which the ruling names CDA storage into",
    a.includes("isBrokerageFinanceAdmin"))
  check("app/actions/cda-storage.ts does NOT use Vercel Blob", !a.includes("@vercel/blob"))

  const panel = src("app/dashboard/admin/onboarding/components/os/cda-setup-panel.tsx")
  check("the CDA setup panel calls the Supabase action, not @vercel/blob",
    panel.includes("uploadCdaTemplateFile") && !panel.includes("@vercel/blob"))
}

console.log("\n── the FILLED CDA PDF is stored in a Supabase bucket ──")
{
  const f = src("app/actions/cda-template-field-actions.ts")
  check("filled CDA PDF uploads via uploadBufferToBucket (bucket cda-filled)",
    f.includes("uploadBufferToBucket") && f.includes('"cda-filled"'))
  check("the filled-PDF path no longer imports @vercel/blob's put",
    !f.includes('await import("@vercel/blob")'))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ CDA_STORAGE_FAIL"); process.exit(1) }
console.log(" ✅ CDA_STORAGE_PASS — CDA template + filled PDF store in Supabase buckets, not Vercel Blob")
