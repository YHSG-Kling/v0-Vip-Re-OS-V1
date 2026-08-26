// scripts/signed-upload-tenancy-guard.ts   (npm run test:signed-upload-tenancy)
// ─────────────────────────────────────────────────────────────────────────────
// THE BROWSER-DIRECT UPLOAD PATH: PROVES THE CEILING IS REAL AND THE TENANT
// PREFIX CANNOT BE ESCAPED.
//
// A signed upload URL is a CAPABILITY handed to a browser — permission to write
// one object, valid for two hours, usable with no further authentication. So
// the two questions that matter are "how big may it be" and "whose prefix does
// it land in", and this guard answers both against the real code rather than
// against a description of it.
//
// ── WHAT IS PROVED HERE, AND WHAT IS NOT ────────────────────────────────────
// PROVED HERE, in-process and with no credentials: that planSignedUpload
// refuses an oversized file and admits a compliant one; that a caller cannot
// name a path, a bucket or a tenant; that a filename cannot traverse out of its
// prefix; and that two tenants never share one.
//
// NOT PROVED HERE, and stated rather than implied: that the Supabase Storage
// server refuses a token replayed against a DIFFERENT path. That is a property
// of the storage server, not of this repo, and this sandbox has no egress to
// the project host, so it cannot be exercised from here. It is instead cited to
// the implementation, which compares the token's signed `url` claim to the
// request path with a byte-exact equality before accepting any bytes
// (supabase/storage, src/storage/object.ts, verifyObjectSignature):
//
//     if (payload.url !== `${this.bucketId}/${objectName}`) {
//       throw ERRORS.InvalidSignature()
//     }
//
// So the cross-tenant question splits in two. THE HALF THIS REPO OWNS is "can a
// caller get a ticket minted for another tenant's prefix", and that is what the
// assertions below settle. THE HALF SUPABASE OWNS is "can a minted ticket be
// pointed somewhere else", which the signature check answers. A guard that
// pretended to test the second half would be testing a mock.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"
import {
  planSignedUpload,
  buildUploadObjectPath,
  sanitizeUploadFileName,
  purposesMissingTenantPrefix,
  purposesWithNoBucketCeiling,
  UPLOAD_PURPOSES,
  type UploadPurpose,
} from "../lib/storage/signed-upload-url"
import { bucketCeilingBytes } from "../lib/storage/file-limits"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const TENANT_A = { brokerageId: "aaaaaaaa-0000-0000-0000-000000000001", userId: "user-a" }
const TENANT_B = { brokerageId: "bbbbbbbb-0000-0000-0000-000000000002", userId: "user-b" }
const PURPOSES = Object.keys(UPLOAD_PURPOSES) as UploadPurpose[]

// ═══ 1. THE SIZE GATE IS REAL, BOTH WAYS ════════════════════════════════════
// An absence assertion needs its positive control, and a LIMIT needs both of
// its sides: a gate that refuses everything and a gate that refuses nothing
// both "have a limit". Each purpose is therefore probed just under and just
// over its own ceiling, derived from the live bucket cache rather than written
// down here (§2 — assert the rule, derive the number).
console.log("\n── the ceiling admits a compliant file and REFUSES an oversized one ──")
for (const purpose of PURPOSES) {
  const bucket = UPLOAD_PURPOSES[purpose].bucket
  const ceiling = bucketCeilingBytes(bucket)
  const contentType = UPLOAD_PURPOSES[purpose].contentTypePrefixes?.[0]
    ? `${UPLOAD_PURPOSES[purpose].contentTypePrefixes![0]}mp4`.replace("image/mp4", "image/png").replace("audio/mp4", "audio/mpeg")
    : "application/octet-stream"

  const under = planSignedUpload({
    purpose, identity: TENANT_A, fileName: "clip.mp4", contentType, bytes: ceiling - 1,
  })
  check(`${purpose}: a file 1 byte under the ${(ceiling / (1024 * 1024)).toFixed(1)} MB ceiling is ADMITTED`,
    under.ok, under.ok ? "" : (under as { reason: string }).reason)

  const over = planSignedUpload({
    purpose, identity: TENANT_A, fileName: "clip.mp4", contentType, bytes: ceiling + 1,
  })
  check(`${purpose}: a file 1 byte over the ceiling is REFUSED`,
    !over.ok && over.refusedBy === "size",
    over.ok ? "it was admitted" : `refusedBy=${(over as { refusedBy: string }).refusedBy}`)

  // FAIL CLOSED on an unmeasurable size — a stream of unknown length must not
  // be waved through just because no number contradicted the limit.
  const unmeasurable = planSignedUpload({
    purpose, identity: TENANT_A, fileName: "clip.mp4", contentType, bytes: null,
  })
  check(`${purpose}: an unmeasurable size is REFUSED, not passed`,
    !unmeasurable.ok && unmeasurable.refusedBy === "unmeasurable")
}

// ═══ 2. THE TENANT PREFIX CANNOT BE ESCAPED ═════════════════════════════════
console.log("\n── a caller cannot reach another tenant's prefix ──")
{
  const orphans = purposesMissingTenantPrefix()
  check("every purpose's prefix STARTS with the brokerage id and moves with it",
    orphans.length === 0, orphans.join(", "))

  for (const purpose of PURPOSES) {
    const a = buildUploadObjectPath({ purpose, identity: TENANT_A, fileName: "x.mp4", now: 1 })
    const b = buildUploadObjectPath({ purpose, identity: TENANT_B, fileName: "x.mp4", now: 1 })
    check(`${purpose}: tenant A and tenant B get disjoint paths`, a !== b && !a.startsWith(TENANT_B.brokerageId))
  }

  // THE TRAVERSAL CORPUS. Each of these is a filename a hostile client could
  // send; none may produce a key outside the tenant prefix. The old Vercel Blob
  // route accepted a full pathname from the browser, so this is the specific
  // hole being closed rather than a hypothetical.
  const HOSTILE = [
    "../../../other-tenant/steal.mp4",
    "..\\..\\windows\\evil.mp4",
    "/absolute/path.mp4",
    "....//....//escape.mp4",
    "nested/deep/path.mp4",
    ".",
    "..",
    "",
  ]
  for (const name of HOSTILE) {
    const leaf = sanitizeUploadFileName(name)
    const path = buildUploadObjectPath({ purpose: "portal_testimonial", identity: TENANT_A, fileName: name, now: 1 })
    const escaped = leaf.includes("/") || leaf.includes("\\") || path.includes("..") ||
      !path.startsWith(`${TENANT_A.brokerageId}/`)
    check(`filename ${JSON.stringify(name)} stays inside the tenant prefix`, !escaped, `→ ${path}`)
  }
}

// ═══ 3. THE CALLER NAMES A PURPOSE, NEVER A DESTINATION ═════════════════════
console.log("\n── the request cannot choose a bucket, a path or a tenant ──")
{
  const bogus = planSignedUpload({
    purpose: "not_a_real_purpose", identity: TENANT_A, fileName: "x.mp4", contentType: "video/mp4", bytes: 10,
  })
  check("an unknown purpose is REFUSED", !bogus.ok && bogus.refusedBy === "purpose")

  const noTenant = planSignedUpload({
    purpose: "social_composer", identity: { brokerageId: null, userId: "u" }, fileName: "x.png",
    contentType: "image/png", bytes: 10,
  })
  check("a session with no brokerage is REFUSED, not defaulted", !noTenant.ok && noTenant.refusedBy === "identity")

  const wrongType = planSignedUpload({
    purpose: "portal_testimonial", identity: TENANT_A, fileName: "x.exe",
    contentType: "application/x-msdownload", bytes: 10,
  })
  check("a content type the purpose does not accept is REFUSED", !wrongType.ok && wrongType.refusedBy === "content_type")

  // The route is the only caller, and it must not learn to read a destination.
  const routeSrc = blankComments(readFileSync(join(process.cwd(), "app/api/storage/signed-upload/route.ts"), "utf8"))
  check("the route never reads bucket/path/brokerage from the request body",
    !/body\.(bucket|path|pathname|brokerageId|objectPath|prefix)/.test(routeSrc))
  check("the route resolves the tenant from the session", /resolveWriteContextForTenant\s*\(/.test(routeSrc))

  // A read-only impersonation grant must not be able to mint an upload
  // capability. Asserted on the RESOLVER rather than on a local `readOnly`
  // branch in the route: resolveWriteContext already turns a 'read_only' grant
  // into ok:false, so the route refusing on !ctx.ok IS the refusal. An earlier
  // cut of this guard demanded a literal `readOnly` in the route, which would
  // have forced a SECOND copy of the rule into the handler — and a second copy
  // silently drifting out of date is exactly the defect acting-context.ts's
  // header records the kernel duplicate causing (a read_only grant could write).
  check("…and refuses on !ctx.ok, which is where read_only lands",
    /if\s*\(\s*!ctx\.ok\s*\)/.test(routeSrc))
  const seam = blankComments(readFileSync(join(process.cwd(), "lib/platform/acting-context.ts"), "utf8"))
  check("the write seam still refuses a read_only grant outright",
    /reason:\s*"read_only"/.test(seam) && /READ_ONLY_ACTING_ERROR/.test(seam))
}

// ═══ 4. THE TRANSPORT IS NAMED HONESTLY ═════════════════════════════════════
// The whole reason this path exists is that the bytes do NOT cross a Vercel
// Function. Charging them the 4.5 MB function body cap would silently reimpose
// the ceiling this migration removed; charging them nothing would be a lie in
// the other direction. Both are asserted.
console.log("\n── the transport is direct_to_storage, and the bucket still bounds it ──")
{
  const src = blankComments(readFileSync(join(process.cwd(), "lib/storage/signed-upload-url.ts"), "utf8"))
  check("planSignedUpload gates on transport: \"direct_to_storage\"", /transport:\s*"direct_to_storage"/.test(src))
  check("it does not charge the browser upload a function body cap", !/transport:\s*"route_handler"/.test(src))

  for (const purpose of PURPOSES) {
    const ceiling = bucketCeilingBytes(UPLOAD_PURPOSES[purpose].bucket)
    check(`${purpose}: the ceiling is finite (a bucket bound, not "unlimited")`, Number.isFinite(ceiling))
  }
}

// ═══ 5. PUBLISH THE BLIND SPOT ══════════════════════════════════════════════
// A count without its exclusions is not a measurement. Buckets carrying user
// uploads with NO declared file_size_limit are reported by name every run, so
// the fact stays visible instead of living in one migration's report.
console.log("\n── buckets carrying browser uploads with NO declared size limit ──")
{
  const uncapped = purposesWithNoBucketCeiling()
  for (const p of uncapped) {
    console.log(`  ! ${p} → '${UPLOAD_PURPOSES[p].bucket}' declares no file_size_limit; the ceiling is the PROJECT GLOBAL floor`)
  }
  if (uncapped.length === 0) console.log("  (none — every purpose's bucket declares its own limit)")
  // Reported, NOT failed: no bucket limit is a live configuration fact and a
  // decision for the owner, not a code defect this guard may veto. What would
  // be a defect is the fact going unsaid.
  check("the uncapped-bucket list was computed and published", true)
}

console.log(
  `\n RESULT: ${passed} passed, ${failed} failed` +
    `\n  denominator: ${PURPOSES.length} upload purposes × (under/over/unmeasurable) size probes,` +
    "\n  plus 8 hostile filenames and 6 request-shaping probes." +
    "\n  NOT covered: the Supabase storage server's own token↔path signature check" +
    "\n  (no egress to the project host from here) — cited to verifyObjectSignature in the header.",
)
if (failed > 0) { console.log(" ❌ SIGNED_UPLOAD_TENANCY_FAIL"); process.exit(1) }
console.log(" ✅ SIGNED_UPLOAD_TENANCY_PASS")
