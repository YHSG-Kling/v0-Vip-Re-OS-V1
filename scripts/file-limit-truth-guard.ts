/**
 * scripts/file-limit-truth-guard.ts — npm run test:file-limits
 * ─────────────────────────────────────────────────────────────────────────────
 * A FILE SIZE LIMIT THE PLATFORM WILL NOT HONOUR IS A LIE, NOT A POLICY.
 *
 * Owner ruling (2026-08-26): "research why we have file limits." The research is
 * written up in lib/storage/file-limits.ts with its citations; this guard is the
 * regression that keeps the answer true. What it found when it was written:
 *
 *   · FILE_LIMITS (lib/constants/index.ts:541) declared IMAGE 10 MB / VIDEO
 *     500 MB / DOCUMENT 50 MB, was imported by NOTHING, and contradicted the
 *     live buckets on all three lines.
 *   · Eleven upload boundaries each carried their OWN hand-kept ceiling — 2, 5,
 *     8, 10, 15, 20, 25, 50 and 100 MB — and four boundaries carried none at all.
 *   · Every number above 4.5 MB on a boundary that routes through a Next.js
 *     route handler or Server Action was unreachable, because Vercel refuses a
 *     larger function request body ahead of our code.
 *
 * WHAT THIS ASSERTS — the RULE, never a waypoint number (CLAUDE.md §2). Every
 * expected value below is DERIVED from the live bucket cache or from a cited
 * platform limit, so a bucket edit moves the guard rather than breaking it.
 *
 *   1  the bucket cache is machine-written and unedited (body-sha256), and —
 *      where credentials exist — still matches the live project;
 *   2  FILE_LIMITS agrees with the buckets: no class ceiling exceeds the
 *      smallest limit enforced on a bucket of that class;
 *   3  every declared bucket limit is at or below the provable project floor,
 *      and the ensureBucket creation default is too;
 *   4  the CLASS_BUCKETS document roster equals DOCUMENT_CLASS_BUCKETS, so the
 *      one vocabulary (§6) cannot fork;
 *   5  next.config.ts's serverActions.bodySizeLimit is recorded accurately in
 *      file-limits.ts, and is NOT treated as the effective ceiling;
 *   6  the gate is wired: every server-side upload boundary that hands bytes to
 *      Storage calls checkUpload;
 *   7  no ad-hoc megabyte literal is left standing beside a gated boundary;
 *   8  POSITIVE CONTROL — the gate REFUSES an oversized file, an unmeasurable
 *      one, an unknown bucket and a wrong content type, and ADMITS a compliant
 *      one. Checks 2/3/6/7 are absence assertions; without this a broken finder
 *      and a clean tree report the same zero.
 *
 * COMMENT-STRIPPED, per §2: this file's own prose names `checkUpload` and every
 * megabyte literal it hunts for. Scanning raw source would make each of the
 * boundary files' TOMBSTONES — which quote the numbers they replaced, and are
 * meant to stay — read as live code, and the guard would accuse the repo of the
 * defect its tombstones record having fixed.
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { bodyOf, hashBody, parseStamp, liveCredentials } from "./schema-cache-provenance"
import { LIVE_BUCKET_CONFIG } from "../lib/storage/bucket-limits"
import { DOCUMENT_CLASS_BUCKETS } from "../lib/storage/document-buckets"
import {
  FILE_LIMITS,
  CLASS_BUCKETS,
  bucketCeilingBytes,
  classCeilingBytes,
  checkUpload,
  transportCeilingBytes,
  uploadCeilingBytes,
  BUCKET_CREATION_DEFAULT_LIMIT_BYTES,
  PROJECT_GLOBAL_FILE_SIZE_FLOOR_BYTES,
  MOST_RESTRICTIVE_BUCKET_LIMIT_BYTES,
  VERCEL_FUNCTION_BODY_LIMIT_BYTES,
  NEXT_SERVER_ACTION_BODY_LIMIT_BYTES,
  type UploadClass,
} from "../lib/storage/file-limits"

const ROOT = process.cwd()
let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ""): void {
  checks++
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`)
  }
}

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
}

/** Comments gone AND string contents blanked — a name in a fixture is not a call. */
function code(rel: string): string {
  return blankStrings(stripComments(read(rel)))
}

/** Comments gone, string contents KEPT — for finding a bucket name a call passes. */
function codeWithStrings(rel: string): string {
  return stripComments(read(rel))
}

const MB = (n: number) => `${(n / (1024 * 1024)).toFixed(2)} MB`

// ═══ 1. THE CACHE IS A CACHE ════════════════════════════════════════════════
console.log("\n[1] lib/storage/bucket-limits.ts is machine-written and unedited")

const cacheRel = "lib/storage/bucket-limits.ts"
const cacheText = read(cacheRel)
const stampParsed = parseStamp(cacheText)
const cacheBody = bodyOf(cacheText)

check("the cache carries a provenance stamp", stampParsed !== null, "no generated:/source:/body-sha256: header")
check(
  "body-sha256 matches the committed bytes (no hand-edit)",
  stampParsed !== null && cacheBody !== null && hashBody(cacheBody) === stampParsed.bodySha256,
  stampParsed && cacheBody !== null
    ? `header says ${stampParsed.bodySha256.slice(0, 16)}…, bytes hash to ${hashBody(cacheBody).slice(0, 16)}…  — regenerate with scripts/generate-bucket-limits.ts`
    : "",
)
check(
  "the cache names the live project as its source",
  stampParsed?.source.includes("hrvaqgvukzxfskkcrwbt") === true,
  `source: ${stampParsed?.source ?? "(none)"}`,
)
check("the cache is not empty", Object.keys(LIVE_BUCKET_CONFIG).length > 0)

// ═══ 2. FILE_LIMITS AGREES WITH THE BUCKETS ═════════════════════════════════
console.log("\n[2] FILE_LIMITS agrees with what the live buckets enforce")

const classKeys: Record<UploadClass, keyof typeof FILE_LIMITS> = {
  image: "IMAGE_MAX_SIZE",
  video: "VIDEO_MAX_SIZE",
  document: "DOCUMENT_MAX_SIZE",
}

for (const cls of Object.keys(classKeys) as UploadClass[]) {
  const declared = FILE_LIMITS[classKeys[cls]]
  const derived = classCeilingBytes(cls)
  const tightest = CLASS_BUCKETS[cls]
    .map((b) => ({ b, cap: bucketCeilingBytes(b) }))
    .sort((x, y) => x.cap - y.cap)[0]
  check(
    `${classKeys[cls]} = ${MB(declared)} — the smallest ceiling any ${cls} bucket enforces (${tightest.b})`,
    declared === derived && declared === tightest.cap,
    `declared ${MB(declared)}, derived ${MB(derived)}, tightest bucket ${tightest.b} at ${MB(tightest.cap)}`,
  )
}

// The import PATH is a string, so this pass keeps string contents — blanking
// them would leave `export { FILE_LIMITS } from ""` and the check could never
// pass, which is the "guard cannot see the code it judges" failure of §2.
check(
  "lib/constants/index.ts re-exports FILE_LIMITS rather than declaring a second copy",
  /export\s*\{\s*FILE_LIMITS\s*\}\s*from\s*["']@\/lib\/storage\/file-limits["']/.test(
    codeWithStrings("lib/constants/index.ts"),
  ) && !/export\s+const\s+FILE_LIMITS\s*=/.test(code("lib/constants/index.ts")),
  "the constants barrel still declares its own FILE_LIMITS literal",
)

// ═══ 3. NOTHING CLAIMS MORE THAN THE PROJECT CAN GIVE ═══════════════════════
console.log("\n[3] every declared ceiling sits under the provable project floor")

for (const [bucket, cfg] of Object.entries(LIVE_BUCKET_CONFIG)) {
  if (cfg.fileSizeLimitBytes === null) continue
  check(
    `${bucket} (${MB(cfg.fileSizeLimitBytes)}) is at or below the project floor ${MB(PROJECT_GLOBAL_FILE_SIZE_FLOOR_BYTES)}`,
    cfg.fileSizeLimitBytes <= PROJECT_GLOBAL_FILE_SIZE_FLOOR_BYTES,
  )
}
check(
  `the ensureBucket creation default ${MB(BUCKET_CREATION_DEFAULT_LIMIT_BYTES)} is at or below the project floor`,
  BUCKET_CREATION_DEFAULT_LIMIT_BYTES <= PROJECT_GLOBAL_FILE_SIZE_FLOOR_BYTES,
  "a bucket created above the global limit is refused by Supabase at creation time",
)
check(
  "the creation default has ONE spelling — no bare 50 MB literal left in either ensureBucket",
  !/50\s*\*\s*1024\s*\*\s*1024/.test(code("lib/storage/buckets.ts")) &&
    !/50\s*\*\s*1024\s*\*\s*1024/.test(code("app/actions/twin-studio-upload.ts")),
  "one of the two ensureBucket implementations still hardcodes the limit",
)
check(
  `the most restrictive live bucket limit is ${MB(MOST_RESTRICTIVE_BUCKET_LIMIT_BYTES)} — the fail-closed answer for an unnamed bucket`,
  MOST_RESTRICTIVE_BUCKET_LIMIT_BYTES <= PROJECT_GLOBAL_FILE_SIZE_FLOOR_BYTES,
)

// ═══ 4. ONE VOCABULARY FOR "DOCUMENT BUCKET" ════════════════════════════════
console.log("\n[4] the document roster has not forked (§6)")

const rosterA: string[] = [...CLASS_BUCKETS.document].sort()
const rosterB = Object.keys(DOCUMENT_CLASS_BUCKETS).sort()
check(
  `CLASS_BUCKETS.document (${rosterA.length}) equals DOCUMENT_CLASS_BUCKETS (${rosterB.length})`,
  rosterA.join("|") === rosterB.join("|"),
  `only in file-limits: ${rosterA.filter((b) => !rosterB.includes(b)).join(", ") || "—"} · ` +
    `only in document-buckets: ${rosterB.filter((b) => !rosterA.includes(b)).join(", ") || "—"}`,
)

// ═══ 5. THE TRANSPORT CEILING IS THE ONE THAT DECIDES ═══════════════════════
console.log("\n[5] the Server Action body limit is recorded, and is not the effective ceiling")

const nextConfig = read("next.config.ts")
const declaredMb = /bodySizeLimit:\s*['"](\d+)mb['"]/i.exec(stripComments(nextConfig))?.[1]
check(
  "next.config.ts still sets serverActions.bodySizeLimit",
  declaredMb !== undefined,
  "if it was removed, NEXT_SERVER_ACTION_BODY_LIMIT_BYTES must fall back to the Next.js default of 1 MB",
)
check(
  `file-limits.ts records it as ${MB(NEXT_SERVER_ACTION_BODY_LIMIT_BYTES)}, matching next.config.ts's ${declaredMb}mb`,
  declaredMb !== undefined && Number(declaredMb) * 1024 * 1024 === NEXT_SERVER_ACTION_BODY_LIMIT_BYTES,
  `next.config.ts says ${declaredMb}mb, file-limits.ts holds ${MB(NEXT_SERVER_ACTION_BODY_LIMIT_BYTES)}`,
)
check(
  "a Server Action's effective ceiling is Vercel's cap, NOT the framework's",
  transportCeilingBytes("server_action") === Math.min(VERCEL_FUNCTION_BODY_LIMIT_BYTES, NEXT_SERVER_ACTION_BODY_LIMIT_BYTES) &&
    transportCeilingBytes("server_action") === VERCEL_FUNCTION_BODY_LIMIT_BYTES,
  `server_action ceiling is ${MB(transportCeilingBytes("server_action"))}`,
)
check(
  "base64 costs a third of the budget",
  transportCeilingBytes("server_action_base64") < transportCeilingBytes("server_action") &&
    transportCeilingBytes("server_action_base64") === Math.floor(transportCeilingBytes("server_action") * (3 / 4)),
  `base64 ceiling is ${MB(transportCeilingBytes("server_action_base64"))}`,
)
check(
  "direct-to-storage is bounded by the bucket alone — no function is in the path",
  transportCeilingBytes("direct_to_storage") === Number.POSITIVE_INFINITY &&
    uploadCeilingBytes({ bucket: "listing-media", transport: "direct_to_storage" }) ===
      bucketCeilingBytes("listing-media"),
)

// ═══ 6. THE GATE IS WIRED AT THE REAL BOUNDARIES ════════════════════════════
console.log("\n[6] every server-side upload boundary calls the gate")

/**
 * A boundary is a server file that hands caller-supplied bytes to Storage. Each
 * is listed with the bucket it writes, so a boundary that is retired shows up as
 * a missing FILE rather than as a silently-passing check.
 */
const BOUNDARIES: readonly { file: string; bucket: string }[] = [
  { file: "app/api/storage/upload-temp/route.ts", bucket: "video-assets" },
  { file: "app/api/offers/upload/route.ts", bucket: "offer-documents" },
  { file: "app/api/offers/[offerId]/upload-document/route.ts", bucket: "documents" },
  { file: "app/api/listings/[listingId]/upload-document/route.ts", bucket: "documents" },
  { file: "app/api/workflow/buyer-intake/upload/route.ts", bucket: "client-documents" },
  { file: "app/api/admin/transaction-forms/route.ts", bucket: "brokerage-forms" },
  { file: "app/actions/documents.ts", bucket: "client-documents" },
  { file: "app/actions/buyer-financial.ts", bucket: "client-documents" },
  { file: "app/actions/financials.ts", bucket: "receipts" },
  { file: "app/actions/vendor-portal.ts", bucket: "transaction-documents" },
  { file: "app/actions/vendor-w9.ts", bucket: "client-documents" },
  { file: "app/actions/onboarding/brand.ts", bucket: "brokerage-assets" },
  { file: "app/actions/twin-studio-upload.ts", bucket: "twin-avatars" },
]

for (const b of BOUNDARIES) {
  if (!existsSync(resolve(ROOT, b.file))) {
    check(`${b.file} exists`, false, "the boundary moved or was deleted — update this roster, do not delete the check")
    continue
  }
  const src = code(b.file)
  check(`${b.file} calls checkUpload`, /\bcheckUpload\s*\(/.test(src), "bytes reach Storage with no size gate")
}

// The bucket names a boundary passes are real strings, so this pass keeps them.
for (const b of BOUNDARIES) {
  if (!existsSync(resolve(ROOT, b.file))) continue
  const src = codeWithStrings(b.file)
  const namesBucket = src.includes(`"${b.bucket}"`) || src.includes(`'${b.bucket}'`) || /transport:/.test(src)
  check(`${b.file} names a destination on the gate`, namesBucket, `expected the gate to name ${b.bucket}`)
}

// ═══ 7. NO AD-HOC CEILING LEFT BESIDE A GATED BOUNDARY ══════════════════════
console.log("\n[7] no hand-kept megabyte ceiling survives at a gated boundary")

/** `N * 1024 * 1024` compared against a length/size — the shape that was removed. */
const ADHOC = /(?:\.size|\.length|bytes|Bytes)\s*>\s*\d+\s*\*\s*1024\s*\*\s*1024/g

for (const b of BOUNDARIES) {
  if (!existsSync(resolve(ROOT, b.file))) continue
  const src = code(b.file)
  const hits = [...src.matchAll(ADHOC)].map((m) => m[0].trim())
  check(`${b.file} has no hand-kept size comparison`, hits.length === 0, hits.join(" · "))
}

// ═══ 8. POSITIVE CONTROL ════════════════════════════════════════════════════
console.log("\n[8] POSITIVE CONTROL — the gate refuses what it is for, and admits what it is not")

// It REFUSES an oversized file.
const tooBig = checkUpload({
  bucket: "listing-media",
  transport: "direct_to_storage",
  bytes: bucketCeilingBytes("listing-media") + 1,
  contentType: "video/mp4",
})
check(
  `REFUSES one byte over the listing-media limit (${MB(bucketCeilingBytes("listing-media"))})`,
  !tooBig.ok && tooBig.refusedBy === "size",
  tooBig.ok ? "the gate admitted an oversized file — every absence check above is unproven" : "",
)
if (!tooBig.ok) console.log(`      refusal: ${tooBig.reason}`)

// It ADMITS a compliant file.
const okFile = checkUpload({
  bucket: "listing-media",
  transport: "direct_to_storage",
  bytes: bucketCeilingBytes("listing-media"),
  contentType: "video/mp4",
})
check(
  "ADMITS a file exactly at the limit — the gate is not refusing everything",
  okFile.ok,
  okFile.ok ? "" : `refused a compliant file: ${(okFile as { reason: string }).reason}`,
)

// The TRANSPORT is what refuses a 40 MB video through a function.
const throughFunction = checkUpload({
  bucket: "listing-media",
  transport: "route_handler",
  bytes: 40 * 1024 * 1024,
  contentType: "video/mp4",
})
check(
  "REFUSES a 40 MB video routed through a function, though the bucket would take it",
  !throughFunction.ok &&
    throughFunction.ceilingBytes === VERCEL_FUNCTION_BODY_LIMIT_BYTES &&
    bucketCeilingBytes("listing-media") > 40 * 1024 * 1024,
  "the transport ceiling is not being folded in — this is the defect the research found",
)
if (!throughFunction.ok) console.log(`      refusal: ${throughFunction.reason}`)

// FAIL CLOSED — an unmeasurable size.
for (const bad of [null, undefined, Number.NaN, -1] as const) {
  const r = checkUpload({ bucket: "documents", transport: "route_handler", bytes: bad, contentType: "application/pdf" })
  check(`REFUSES an unmeasurable size (${String(bad)}) rather than passing it`, !r.ok && r.refusedBy === "unmeasurable")
}

// FAIL CLOSED — a bucket nobody has heard of resolves to a real ceiling, never Infinity.
const unknownCeiling = bucketCeilingBytes("a-bucket-that-does-not-exist")
check(
  `an unknown bucket resolves to ${MB(unknownCeiling)}, not "unlimited"`,
  Number.isFinite(unknownCeiling) && unknownCeiling > 0,
)
const noBucket = bucketCeilingBytes(null)
check(
  `no bucket named at all resolves to the strictest live limit (${MB(noBucket)})`,
  noBucket === MOST_RESTRICTIVE_BUCKET_LIMIT_BYTES,
)

// FAIL CLOSED — a bucket that declares mime types refuses an unnamed content type.
const noType = checkUpload({ bucket: "brokerage-assets", transport: "server_action", bytes: 1024, contentType: null })
check(
  "REFUSES an upload to a mime-restricted bucket that names no content type",
  !noType.ok && noType.refusedBy === "content_type",
)
const wrongType = checkUpload({
  bucket: "brokerage-assets",
  transport: "server_action",
  bytes: 1024,
  contentType: "application/pdf",
})
check("REFUSES a PDF into the image-only brokerage-assets bucket", !wrongType.ok && wrongType.refusedBy === "content_type")
const rightType = checkUpload({
  bucket: "brokerage-assets",
  transport: "server_action",
  bytes: 1024,
  contentType: "image/png",
})
check("ADMITS a PNG into brokerage-assets", rightType.ok)

// The finders in [7] still recognise the defect they were written for.
const SPECIMEN = "  if (file.size > 20 * 1024 * 1024) { return }"
check(
  "the ad-hoc-ceiling finder still matches the shape it was written for",
  new RegExp(ADHOC.source).test(SPECIMEN),
  "the regex in [7] no longer recognises `file.size > 20 * 1024 * 1024` — every zero above is meaningless",
)
check(
  "…and does NOT match the same text inside a comment (tombstones must stay)",
  [...blankStrings(stripComments(`// was: ${SPECIMEN.trim()}`)).matchAll(ADHOC)].length === 0,
  "the finder is reading comments — a tombstone would be reported as live code",
)

// ═══ 9. OPTIONAL LIVE COMPARISON ════════════════════════════════════════════
console.log("\n[9] live comparison — the cache against the actual buckets")

const creds = liveCredentials()
if (!creds) {
  console.log("  ○ SKIPPED — no SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in this environment.")
  console.log("    BLIND SPOT, stated rather than implied: nothing above claims the cache still")
  console.log("    matches the live project — only that it is machine-shaped, unedited, and")
  console.log("    that the code agrees with it.")
} else {
  try {
    const res = await fetch(`${creds.url}/storage/v1/bucket`, {
      headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`storage/v1/bucket refused: ${res.status} ${text.slice(0, 200)}`)
    const live = JSON.parse(text) as {
      id: string
      public: boolean
      file_size_limit: number | null
      allowed_mime_types: string[] | null
    }[]

    const drift: string[] = []
    for (const row of live) {
      const cached = LIVE_BUCKET_CONFIG[row.id]
      if (!cached) {
        drift.push(`${row.id} exists live and is NOT in the cache`)
        continue
      }
      if ((row.file_size_limit ?? null) !== cached.fileSizeLimitBytes) {
        drift.push(`${row.id}.file_size_limit — live ${row.file_size_limit}, cache ${cached.fileSizeLimitBytes}`)
      }
      const liveMimes = row.allowed_mime_types ? [...row.allowed_mime_types].sort().join(",") : null
      const cacheMimes = cached.allowedMimeTypes ? [...cached.allowedMimeTypes].sort().join(",") : null
      if (liveMimes !== cacheMimes) drift.push(`${row.id}.allowed_mime_types — live ${liveMimes}, cache ${cacheMimes}`)
      if (row.public !== cached.isPublic) drift.push(`${row.id}.public — live ${row.public}, cache ${cached.isPublic}`)
    }
    for (const id of Object.keys(LIVE_BUCKET_CONFIG)) {
      if (!live.some((r) => r.id === id)) drift.push(`${id} is in the cache and NOT live`)
    }

    check(
      `the cache matches all ${live.length} live buckets`,
      drift.length === 0,
      `${drift.slice(0, 8).join(" · ")} — regenerate with scripts/generate-bucket-limits.ts`,
    )
  } catch (e) {
    check("the live bucket read succeeded", false, (e as Error).message)
  }
}

// ═══ RESULT ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks` +
    `\n  denominator: ${Object.keys(LIVE_BUCKET_CONFIG).length} live buckets, ${BOUNDARIES.length} server-side upload boundaries.` +
    "\n  NOT covered: client-side courtesy checks (they are not gates); Vercel Blob uploads via" +
    "\n  app/api/blob/upload/route.ts, which bypass both ceilings by going browser→blob and are" +
    "\n  governed by the owner's own-storage rule rather than by a size limit.",
)
if (failures > 0) process.exit(1)
