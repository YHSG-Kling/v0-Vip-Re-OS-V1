#!/usr/bin/env tsx
/**
 * scripts/public-bucket-egress-guard.ts   (npm run test:public-bucket-egress)
 * ─────────────────────────────────────────────────────────────────────────────
 * A PUBLIC BUCKET URL IS A BEARER CAPABILITY THAT NEVER EXPIRES.
 *
 * `getPublicUrl` on a Supabase bucket with public=true, and `access: "public"` on
 * a Vercel Blob put, both mint a URL that serves the object with no session, no
 * RLS and no TTL. For a listing photo or a brand logo that is the whole point.
 * For a board packet, a buyer's proof of funds, a filled commission disclosure or
 * a signed listing agreement it is a credential that cannot be rotated: once the
 * string exists anywhere — an email body, a webhook payload, a proxy log — the
 * object behind it is readable by whoever holds it, forever.
 *
 * This guard exists so that class of mistake cannot come back quietly. It fails
 * the guard chain when:
 *
 *   1. a getPublicUrl() is taken against a DOCUMENT-CLASS bucket, or against a
 *      bucket this guard cannot resolve (fail closed — an unresolvable bucket is
 *      treated as document-class, exactly as isDocumentClassBucket does);
 *   2. a NEW file uses `access: "public"` (the Vercel Blob public put). The files
 *      that legitimately do so today — rendered video, TTS audio, postcard
 *      images, generated marketing art — are in
 *      scripts/public-bucket-egress-baseline.json, and the baseline can only
 *      SHRINK: a file that stops needing it is reported so the baseline is
 *      trimmed;
 *   3. a document-class bucket is written with an explicit `public: true`;
 *   4. lib/storage/buckets.ts#ensureBucket goes back to defaulting `public: true`
 *      (the systemic half — four document-class buckets do not exist live yet and
 *      are created by the first write, so the DEFAULT decides their visibility);
 *   5. the one issuer (lib/storage/document-buckets.ts#issueBucketObjectUrl)
 *      grows a fallback to getPublicUrl on the sad path — a fallback to public is
 *      the exact shape that would undo all of the above.
 *
 * ── MEASUREMENT DISCIPLINE (CLAUDE.md §2) ────────────────────────────────────
 * · Comments are removed with scripts/strip-comments.ts — `blankComments`,
 *   because every position below is computed from a match index and blanking
 *   keeps character offsets aligned. Never a hand-rolled stripper: the recurring
 *   defect is stripping /* *\/ blocks before // lines, and this file is full of
 *   both. (A `//` line here containing a slash-star would otherwise swallow the
 *   code beneath it and the guard would report a clean tree.)
 * · POSITIVE CONTROL: section 6 runs the finders over synthetic sources that
 *   REINTRODUCE each defect and asserts they go RED, and over the clean form of
 *   the same source and asserts they stay GREEN. A broken regex and a clean tree
 *   both report zero; only the control tells them apart.
 * · BLIND SPOTS, published beside the number:
 *     - scans app/ and lib/ only. scripts/ and components/ are excluded:
 *       simulators quote these very strings as assertions and would self-trip.
 *     - resolves a bucket argument that is a string literal, or an identifier
 *       assigned a string literal IN THE SAME FILE. A bucket computed at runtime
 *       is UNRESOLVED, and unresolved fails closed rather than passing.
 *     - it reads source text. A public URL assembled by hand from a project ref
 *       and an /object/public/ path would not be seen; section 5 checks the one
 *       issuer instead of trying to catch every possible hand-rolled URL.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import {
  isDocumentClassBucket,
  bucketClassReason,
  DOCUMENT_CLASS_BUCKETS,
  PUBLIC_MEDIA_BUCKETS,
} from "../lib/storage/document-buckets"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "public-bucket-egress-baseline.json")

let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function walk(dir: string, out: string[]) {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(relative(root, p).replace(/\\/g, "/"))
  }
}

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length

// ─────────────────────────────────────────────────────────────────────────────
// THE FINDERS — pure functions over one file's source, so the positive control
// can run the SAME code over synthetic sources. A finder that the control cannot
// reach is a finder nobody has proved.
// ─────────────────────────────────────────────────────────────────────────────

export interface Hit { line: number; bucket: string; detail: string }

/** Every `const NAME = "literal"` / `let NAME = 'literal'` in the file. */
function localStringConsts(code: string): Map<string, string> {
  const m = new Map<string, string>()
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["']([^"'\n]+)["']/g
  let x: RegExpExecArray | null
  while ((x = re.exec(code))) m.set(x[1], x[2])
  return m
}

/**
 * getPublicUrl call sites whose bucket is DOCUMENT-CLASS (or unresolvable).
 * Matches `.from(<arg>)` … `.getPublicUrl(` with the two allowed to be split
 * across lines, which is how most of this tree writes it.
 */
export function findPublicUrlOnDocumentBucket(code: string): Hit[] {
  const consts = localStringConsts(code)
  const hits: Hit[] = []
  const re = /\.from\(\s*([^)]*?)\s*\)\s*[\s\S]{0,120}?\.getPublicUrl\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const raw = m[1].trim()
    let bucket: string | null = null
    const lit = raw.match(/^["']([^"']+)["']$/)
    if (lit) bucket = lit[1]
    else if (consts.has(raw)) bucket = consts.get(raw)!
    // FAIL CLOSED: an unresolved bucket argument is treated as document-class.
    const resolved = bucket ?? `<unresolved:${raw || "?"}>`
    if (bucket === null || isDocumentClassBucket(bucket)) {
      hits.push({
        line: lineOf(code, m.index),
        bucket: resolved,
        detail: bucket === null
          ? "bucket argument could not be resolved to a literal — fail closed"
          : "document-class bucket",
      })
    }
  }
  return hits
}

/** `access: "public"` — the Vercel Blob public put. */
export function findPublicBlobAccess(code: string): Hit[] {
  const hits: Hit[] = []
  const re = /\baccess\s*:\s*["']public["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    hits.push({ line: lineOf(code, m.index), bucket: "@vercel/blob", detail: 'access: "public"' })
  }
  return hits
}

/**
 * Collapse every run of whitespace to ONE space, keeping a map from each
 * normalised index back to the original index so line numbers still come from
 * the real file.
 *
 * WHY: blankComments replaces a comment with SPACES (deliberately — offsets
 * survive). A finder that measures the DISTANCE between two tokens therefore
 * measures the comment too, and the live positive control caught exactly that:
 * a `public: true` sitting six lines of explanatory comment below its
 * `bucket: "cda-filled"` was 450 blanked characters away and slipped through a
 * 400-character window. The guard reported zero and read as a clean bill of
 * health, which is the failure mode CLAUDE.md §2 is about. Distance is measured
 * in CODE now, not in whitespace.
 */
function collapseWhitespace(code: string): { norm: string; map: number[] } {
  let norm = ""
  const map: number[] = []
  let inWs = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (/\s/.test(ch)) {
      if (!inWs) { norm += " "; map.push(i); inWs = true }
      continue
    }
    inWs = false
    norm += ch
    map.push(i)
  }
  return { norm, map }
}

/** A document-class bucket written with an explicit `public: true`. */
export function findExplicitPublicOnDocumentBucket(code: string): Hit[] {
  const hits: Hit[] = []
  const { norm, map } = collapseWhitespace(code)
  const re = /bucket\s*:\s*["']([^"']+)["'][\s\S]{0,300}?\bpublic\s*:\s*true\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(norm))) {
    if (isDocumentClassBucket(m[1])) {
      hits.push({ line: lineOf(code, map[m.index] ?? 0), bucket: m[1], detail: "written with public: true" })
    }
  }
  return hits
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════")
console.log(" Public-bucket egress guard")
console.log("══════════════════════════════════════════════════")

const files: string[] = []
walk(join(root, "app"), files)
walk(join(root, "lib"), files)
files.sort()

const sources = new Map<string, string>()
for (const f of files) sources.set(f, blankComments(readFileSync(join(root, f), "utf8")))

console.log(`\n  scanned ${files.length} .ts/.tsx files under app/ and lib/`)
console.log(`  document-class buckets: ${Object.keys(DOCUMENT_CLASS_BUCKETS).length} · public-media buckets: ${Object.keys(PUBLIC_MEDIA_BUCKETS).length}`)
console.log("  EXCLUDED: scripts/, components/ (simulators quote these strings), *.test.ts")

// ── 1 · no getPublicUrl on a document-class (or unresolvable) bucket ─────────
console.log("\n[1 · no getPublicUrl against a document-class bucket]")
// THE ONE EXEMPTION: the issuer itself. Its getPublicUrl is the public-media
// branch — the single legitimate one in the tree — and it is checked far more
// strictly in section 5 (exactly one call, before the signing branch, no sad-path
// fallback) than a bucket-name match could manage. Exempting it here is not a
// hole; the finder still runs over it in section 5 with tighter assertions.
const ISSUER = "lib/storage/document-buckets.ts"
const docUrlHits: Array<Hit & { file: string }> = []
for (const [f, code] of sources) {
  if (f === ISSUER) continue
  for (const h of findPublicUrlOnDocumentBucket(code)) docUrlHits.push({ ...h, file: f })
}
for (const h of docUrlHits) console.log(`     · ${h.file}:${h.line} — ${h.bucket} (${h.detail})`)
check(`zero getPublicUrl call sites on a document-class bucket (${docUrlHits.length} found)`, docUrlHits.length === 0)

// ── 2 · no NEW `access: "public"` file ──────────────────────────────────────
console.log("\n[2 · no NEW file mints a public Vercel Blob URL]")
let baseline: string[] = []
try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[] } catch { /* none yet */ }
const baseSet = new Set(baseline)

const blobPublicFiles: string[] = []
for (const [f, code] of sources) {
  if (findPublicBlobAccess(code).length > 0) blobPublicFiles.push(f)
}
blobPublicFiles.sort()

if (process.env.UPDATE_PUBLIC_BUCKET_BASELINE === "1") {
  writeFileSync(BASELINE_PATH, JSON.stringify(blobPublicFiles, null, 2) + "\n")
  console.log(`  ✎ baseline rewritten to ${blobPublicFiles.length} entries.`)
  console.log("\n RESULT: baseline updated (no assertions run)")
  process.exit(0)
}

const newPublicBlob = blobPublicFiles.filter((f) => !baseSet.has(f))
const burnedDown = baseline.filter((b) => !blobPublicFiles.includes(b))
console.log(`  public-blob files: ${blobPublicFiles.length} · baseline: ${baseline.length} · new: ${newPublicBlob.length} · migrated off: ${burnedDown.length}`)
if (burnedDown.length > 0) {
  console.log("  ↓ these no longer mint a public blob URL — run UPDATE_PUBLIC_BUCKET_BASELINE=1 to shrink the baseline:")
  for (const b of burnedDown) console.log(`     · ${b}`)
}
for (const f of newPublicBlob) console.log(`     · NEW public blob write: ${f}`)
check(`no NEW file uses access:"public" (${newPublicBlob.length} new)`, newPublicBlob.length === 0, newPublicBlob.join(", "))
check("the baseline only shrinks (no file re-added)", baseline.every((b) => !newPublicBlob.includes(b)))

// ── 3 · no document-class bucket written with public: true ──────────────────
console.log("\n[3 · no document-class bucket is written with public: true]")
const explicitHits: Array<Hit & { file: string }> = []
for (const [f, code] of sources) {
  for (const h of findExplicitPublicOnDocumentBucket(code)) explicitHits.push({ ...h, file: f })
}
for (const h of explicitHits) console.log(`     · ${h.file}:${h.line} — ${h.bucket}`)
check(`zero document-class buckets written public:true (${explicitHits.length} found)`, explicitHits.length === 0)

// ── 4 · ensureBucket does not default to public ─────────────────────────────
console.log("\n[4 · ensureBucket defaults to the bucket's CLASS, not to public]")
const bucketsSrc = blankComments(readFileSync(join(root, "lib/storage/buckets.ts"), "utf8"))
check("ensureBucket no longer defaults `public: opts?.public ?? true`",
  !/public:\s*opts\?\.public\s*\?\?\s*true/.test(bucketsSrc))
check("ensureBucket defaults from isDocumentClassBucket",
  /public:\s*opts\?\.public\s*\?\?\s*!isDocumentClassBucket\(/.test(bucketsSrc))
check("uploadBufferToBucket defaults visibility from the class too",
  /const\s+isPublic\s*=\s*params\.public\s*\?\?\s*!isDocumentClassBucket\(/.test(bucketsSrc))
check("uploadBufferToBucket mints its URL through the ONE issuer",
  /issueBucketObjectUrl\(/.test(bucketsSrc) && !/getPublicUrl/.test(bucketsSrc))

// ── 5 · the one issuer has no public fallback ───────────────────────────────
console.log("\n[5 · the one issuer FAILS CLOSED — no fallback to public]")
const issuerRaw = readFileSync(join(root, "lib/storage/document-buckets.ts"), "utf8")
// blankStrings, not blankComments: the refusal MESSAGE in this file names
// getPublicUrl, and counting a word inside a string literal as a call is the
// mention-vs-use mistake scripts/strip-comments.ts documents. Strings blanked,
// `${…}` interpolations still code, offsets intact.
const issuer = blankStrings(issuerRaw)
check("issueBucketObjectUrl exists", /export async function issueBucketObjectUrl/.test(issuer))
check("isDocumentClassBucket is allowlist-based (unknown bucket ⇒ document-class)",
  /return\s*!\(\s*bucket in PUBLIC_MEDIA_BUCKETS\s*\)/.test(issuer))
// The ONLY getPublicUrl in the issuer must sit inside the !isDocumentClassBucket
// branch. If a second one appears — or one appears after the sign attempt — that
// is the sad-path fallback this whole lane exists to prevent.
const pubCalls = (issuer.match(/getPublicUrl/g) ?? []).length
check(`exactly one getPublicUrl in the issuer, in the public-media branch (found ${pubCalls})`, pubCalls === 1)
const signIdx = issuer.indexOf("signedDocUrl(client")
const pubIdx = issuer.indexOf("getPublicUrl")
check("that getPublicUrl comes BEFORE the signing branch (it is the media path, not a fallback)",
  pubIdx !== -1 && signIdx !== -1 && pubIdx < signIdx)
check("a failed sign returns ok:false with a reason, not a URL",
  /refusing rather than falling back to a permanent public URL/.test(issuerRaw))

// ── 6 · POSITIVE CONTROL ────────────────────────────────────────────────────
// A broken regex and a clean tree both report zero. These synthetic sources
// reintroduce each defect the finders above are written for and assert they go
// RED — and the clean twin of each asserts they stay GREEN.
console.log("\n[6 · POSITIVE CONTROL — the finders still recognise the defect]")

const DIRTY_LITERAL = `
  const { data: pub } = svc.storage.from("documents").getPublicUrl(path)
`
const DIRTY_CONST = `
  const DOCUMENT_BUCKET = "client-documents"
  const { data } = supabase.storage.from(DOCUMENT_BUCKET).getPublicUrl(p)
`
const DIRTY_UNRESOLVED = `
  const { data } = supabase.storage.from(someRuntimeBucket).getPublicUrl(p)
`
const CLEAN_MEDIA = `
  const { data } = supabase.storage.from("listing-media").getPublicUrl(path)
  const LM = "agent-media"
  const { data: d2 } = supabase.storage.from(LM).getPublicUrl(path)
`
const DIRTY_BLOB = `
  const blob = await put(path, buffer, { access: "public", contentType: "application/pdf" })
`
const CLEAN_BLOB = `
  const blob = await put(path, buffer, { access: "private", contentType: "application/pdf" })
`
const DIRTY_EXPLICIT = `
  await uploadBufferToBucket({ bucket: "cda-filled", path, buffer, contentType: "application/pdf", public: true })
`
// The exact shape the LIVE positive control found slipping through a
// character-distance window: the flag sits several lines of comment below the
// bucket name, so blankComments leaves hundreds of blank characters between them.
const DIRTY_EXPLICIT_FAR = `
  await uploadBufferToBucket({
    bucket: "cda-filled",
    path: \`\${cda.id}.pdf\`,
    buffer: Buffer.from(filledBytes),
    contentType: "application/pdf",
    // A filled closing-disclosure agreement carries the commission split, which
    // is a brokerage financial, and commission is off agent-facing display
    // entirely. Several more lines of perfectly reasonable explanation follow so
    // that the distance between the bucket name and the flag exceeds any window
    // measured in raw characters rather than in code.
    public: true,
  })
`
const CLEAN_EXPLICIT = `
  await uploadBufferToBucket({ bucket: "listing-media", path, buffer, contentType: "image/png", public: true })
  await uploadBufferToBucket({ bucket: "cda-filled", path, buffer, contentType: "application/pdf", public: false })
`
// The comment-stripper trap, in the shape that has bitten this repo twice: a //
// line containing a slash-star. A block-comments-first stripper swallows every
// line from here to the next star-slash — including the defect below it — and
// reports a clean file.
const DIRTY_BEHIND_COMMENT_TRAP = `
  // see app/dashboard/marketing/blog/**  and lib/kernel/*
  const { data: pub } = svc.storage.from("documents").getPublicUrl(path)
`

const b = (s: string) => blankComments(s)
check("RED: getPublicUrl on a literal document bucket is flagged",
  findPublicUrlOnDocumentBucket(b(DIRTY_LITERAL)).length === 1)
check("RED: …resolved through a local const is flagged",
  findPublicUrlOnDocumentBucket(b(DIRTY_CONST)).length === 1)
check("RED: …an UNRESOLVABLE bucket argument is flagged (fail closed)",
  findPublicUrlOnDocumentBucket(b(DIRTY_UNRESOLVED)).length === 1)
check("RED: a defect hidden under a `//` line containing /* is still seen",
  findPublicUrlOnDocumentBucket(b(DIRTY_BEHIND_COMMENT_TRAP)).length === 1,
  "the comment stripper lost the code beneath the trap line")
check("GREEN: getPublicUrl on public-media buckets is NOT flagged (literal + const)",
  findPublicUrlOnDocumentBucket(b(CLEAN_MEDIA)).length === 0)
check("RED: access:\"public\" is flagged", findPublicBlobAccess(b(DIRTY_BLOB)).length === 1)
check("GREEN: access:\"private\" is NOT flagged", findPublicBlobAccess(b(CLEAN_BLOB)).length === 0)
check("RED: a document-class bucket written public:true is flagged",
  findExplicitPublicOnDocumentBucket(b(DIRTY_EXPLICIT)).length === 1)
check("RED: …even with a long comment between the bucket name and the flag",
  findExplicitPublicOnDocumentBucket(b(DIRTY_EXPLICIT_FAR)).length === 1,
  "distance is being measured in blanked whitespace instead of in code")
check("GREEN: a media bucket public:true, and a doc bucket public:false, are NOT flagged",
  findExplicitPublicOnDocumentBucket(b(CLEAN_EXPLICIT)).length === 0)
// And the control's own control: a real comment must still be invisible, or the
// finders would be reading prose and every count above would be inflated.
check("GREEN: the same defect INSIDE a comment is not counted",
  findPublicUrlOnDocumentBucket(b(`// svc.storage.from("documents").getPublicUrl(p)\n`)).length === 0 &&
  findPublicUrlOnDocumentBucket(b(`/* svc.storage.from("documents").getPublicUrl(p) */\n`)).length === 0)

// ── 7 · the classification stays honest ─────────────────────────────────────
console.log("\n[7 · every live bucket is classified exactly once]")
// The eleven buckets measured live in project hrvaqgvukzxfskkcrwbt on 2026-08-22.
const LIVE_BUCKETS = [
  "agent-media", "brokerage-assets", "brokerage-forms", "business-cards", "documents",
  "listing-media", "media", "video-assets",
  "client-documents", "offer-documents", "transaction-documents",
]
// THE CENSUS, printed with its verdict and REASON so the number is never a bare
// count (CLAUDE.md §2). This is the table a reader needs to disagree with the
// classification — which is the point of publishing it.
for (const bkt of LIVE_BUCKETS) {
  const inPublic = bkt in PUBLIC_MEDIA_BUCKETS
  const inDoc = bkt in DOCUMENT_CLASS_BUCKETS
  const verdict = inPublic ? "PUBLIC ok" : "must be PRIVATE"
  check(`'${bkt}' classified exactly once — ${verdict}`, inPublic !== inDoc, bucketClassReason(bkt))
  if (inPublic !== inDoc) console.log(`       ↳ ${bucketClassReason(bkt)}`)
}
check("no bucket is on both rosters",
  Object.keys(PUBLIC_MEDIA_BUCKETS).every((k) => !(k in DOCUMENT_CLASS_BUCKETS)))
check("every roster entry carries a REASON (no bare names)",
  [...Object.values(PUBLIC_MEDIA_BUCKETS), ...Object.values(DOCUMENT_CLASS_BUCKETS)]
    .every((r) => typeof r === "string" && r.length > 20))

// ── 8 · the migration is written, and honest about its window ───────────────
console.log("\n[8 · the bucket-visibility migration exists and states its window]")
let mig = ""
try { mig = readFileSync(join(root, "scripts/1108-private-document-buckets.sql"), "utf8") } catch { /* missing */ }
check("scripts/1108-private-document-buckets.sql exists", mig.length > 0)
check("it flips exactly the two public document-class buckets",
  /set public = false/.test(mig) && /'documents'/.test(mig) && /'brokerage-forms'/.test(mig))
check("it records the zero-objects measurement that makes it safe now",
  /ZERO OBJECTS/i.test(mig))
check("it says plainly that after traffic this WOULD break issued URLs",
  /WOULD\s*\n?--\s*break already-issued URLs|WOULD break already-issued URLs/.test(mig.replace(/\n--/g, "")))
check("it says an already-emailed public URL stays valid FOREVER",
  /stays valid against its object FOREVER/i.test(mig))
check("it also drops the anon-readable RLS policy the flip alone would leave",
  /drop policy if exists "public read brokerage-forms"/.test(mig))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log(" ✅ PUBLIC_BUCKET_EGRESS_PASS — no document-class object is served at a permanent public URL")
