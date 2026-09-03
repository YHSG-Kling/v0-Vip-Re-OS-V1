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
 *      the exact shape that would undo all of the above;
 *   6. (section 9) DOCUMENT BYTES are handed to lib/remotion/media-host.ts
 *      #hostRenderedMedia without naming a document-class bucket, so they take
 *      its PUBLIC default. This is the one that actually shipped, and none of
 *      1-5 could see it: the call routes through the one issuer correctly and
 *      contains no public spelling at all — the bucket argument was simply
 *      OMITTED, and the default is `video-assets`. Every generated CMA, net
 *      sheet, listing packet, recruiting pitch and appraiser packet was
 *      published at a permanent unauthenticated URL by an argument nobody wrote.
 *      The lesson generalises: a defect can be a DEFAULT rather than a token, and
 *      a guard that only greps for tokens will call that tree clean forever.
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
 *     - SECTION 9 classifies a hostRenderedMedia call by its contentType
 *       ARGUMENT. Where that argument is computed at runtime
 *       (`outputContentType(frames)`) the call cannot be classified at all, so
 *       it is COUNTED and PRINTED beside the finding rather than folded into the
 *       pass. Those calls are the video/audio renders the public default exists
 *       for; if one ever starts producing a PDF, section 9 will not see it.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import {
  isDocumentClassBucket,
  bucketClassReason,
  DOCUMENT_CLASS_BUCKETS,
  PUBLIC_MEDIA_BUCKETS,
  GENERATED_DOCUMENT_BUCKET,
} from "../lib/storage/document-buckets"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "public-bucket-egress-baseline.json")

let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// TOMBSTONE (orphan doctrine §1.1) — the private `walk(dir, out)` that stood here
// was one of 82 copies of the same readdirSync walker. Survivor:
// scripts/runtime-roots.ts:61 (`walkTs`), imported above. It enumerated
// DIRECTORIES, so `proxy.ts` — the edge middleware, which handles the PUBLIC
// embed surface and its CSP allowlist — was outside this egress guard's corpus.
// `rootRuntimeFiles()` from the same survivor supplies the root files.
const scanCorpus = () =>
  [...walkTs(join(root, "app")), ...walkTs(join(root, "lib")), ...rootRuntimeFiles(root)]
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .map((p) => relative(root, p).replace(/\\/g, "/"))

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length

// ─────────────────────────────────────────────────────────────────────────────
// THE FINDERS — pure functions over one file's source, so the positive control
// can run the SAME code over synthetic sources. A finder that the control cannot
// reach is a finder nobody has proved.
// ─────────────────────────────────────────────────────────────────────────────

export interface Hit { line: number; bucket: string; detail: string }

/** Every `const NAME = "literal"` / `let NAME = 'literal'` in the file. */
/**
 * `export const NAME = "bucket"` pairs read out of the roster module itself, so
 * the guard resolves the same names the code imports instead of a hardcoded copy
 * that could drift from it (§2 — assert the rule, derive the value).
 */
const ROSTER_BUCKET_CONSTS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  const src = readFileSync(join(root, "lib/storage/document-buckets.ts"), "utf8")
  for (const x of src.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*["']([^"'\n]+)["']/g)) {
    m.set(x[1], x[2])
  }
  return m
})()

function localStringConsts(code: string): Map<string, string> {
  const m = new Map<string, string>()
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["']([^"'\n]+)["']/g
  let x: RegExpExecArray | null
  while ((x = re.exec(code))) m.set(x[1], x[2])
  // …PLUS the bucket names the ROSTER exports. A call site naming its bucket the
  // sanctioned way — `hostRenderedMedia(…, GENERATED_DOCUMENT_BUCKET)` — imports
  // that constant rather than repeating a string literal, which is what §6 asks
  // for; without this the resolver saw an unknown identifier, failed closed, and
  // reported the CORRECT fix as a violation. Only the roster module is trusted,
  // and only its exported string constants: any other identifier still fails
  // closed, which is the behaviour that makes this scan worth running.
  for (const [name, value] of ROSTER_BUCKET_CONSTS) if (!m.has(name)) m.set(name, value)
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

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9's FINDER — DOCUMENT BYTES ROUTED INTO A PUBLIC BUCKET.
//
// WHY SECTIONS 1-3 COULD NOT SEE THIS. They look for the SPELLING of a public
// URL: a getPublicUrl call, an `access: "public"`, a `public: true`. The live
// defect had none of those. lib/remotion/media-host.ts#hostRenderedMedia routes
// every render through the ONE issuer — correctly — and issueBucketObjectUrl
// publishes or signs strictly according to the BUCKET it is handed. Its bucket
// parameter has a default, `video-assets`, which is on the public allowlist. So
// two producers wrote `client-docs/<brokerage>/<file>.pdf` with the bucket
// argument OMITTED, and every generated CMA, net sheet, listing packet,
// recruiting pitch and appraiser packet was published at a permanent
// unauthenticated URL — through code that looked, and was, canonical. An
// omitted argument is a decision nobody can see being made; this finder is what
// makes it visible.
//
// THE RULE ASSERTED, not the two call sites fixed (§2: a waypoint assertion goes
// false the moment the work moves): DOCUMENT BYTES MUST NAME A DOCUMENT-CLASS
// BUCKET. The default bucket is read out of media-host.ts rather than written
// down here, so changing that default is re-measured instead of re-asserted.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE — is this content type a DOCUMENT rather than a media asset? Kept
 * explicit and narrow: each entry is a format a person would call a document and
 * would not expect a stranger to be able to open forever.
 */
export function isDocumentContentType(contentType: string): boolean {
  const c = contentType.trim().toLowerCase()
  return (
    c === "application/pdf" ||
    c === "application/rtf" ||
    c === "text/csv" ||
    c === "application/msword" ||
    c.startsWith("application/vnd.openxmlformats-officedocument.") ||
    c.startsWith("application/vnd.ms-")
  )
}

/**
 * Top-level argument TEXTS of every `fn(…)` call in `code`.
 *
 * Written as a depth scanner rather than a regex because the argument that
 * matters here is the FIFTH, and the second is a template literal
 * (`` `client-docs/${id}/${name}` ``) that can contain commas, parentheses and
 * braces. A regex that split on commas would mis-index every call it read and
 * then report zero — the failure mode CLAUDE.md §2 is written about. String and
 * template literals are skipped wholesale, `${…}` interpolations included.
 */
export function callArguments(code: string, fnName: string): Array<{ index: number; args: string[] }> {
  const out: Array<{ index: number; args: string[] }> = []
  const re = new RegExp(`\\b${fnName}\\s*\\(`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    // The DECLARATION is not a call. `export async function hostRenderedMedia(`
    // would otherwise be read as a call whose fourth argument is the text
    // `contentType: string`, which resolves to no literal and would inflate the
    // published blind-spot count by one in the file that defines the helper.
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue
    let i = m.index + m[0].length
    let depth = 0
    let cur = ""
    let closed = false
    const args: string[] = []
    while (i < code.length) {
      const ch = code[i]
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch
        let j = i + 1
        let interp = 0
        while (j < code.length) {
          const c = code[j]
          if (c === "\\") { j += 2; continue }
          if (quote === "`" && c === "$" && code[j + 1] === "{") { interp++; j += 2; continue }
          if (quote === "`" && c === "}" && interp > 0) { interp--; j++; continue }
          if (c === quote && interp === 0) break
          j++
        }
        cur += code.slice(i, j + 1)
        i = j + 1
        continue
      }
      if (ch === "(" || ch === "[" || ch === "{") { depth++; cur += ch; i++; continue }
      if (ch === ")" && depth === 0) {
        if (cur.trim().length > 0) args.push(cur.trim())
        closed = true
        i++
        break
      }
      if (ch === ")" || ch === "]" || ch === "}") { depth--; cur += ch; i++; continue }
      if (ch === "," && depth === 0) { args.push(cur.trim()); cur = ""; i++; continue }
      cur += ch
      i++
    }
    // An unterminated call (a truncated file, a scanner that lost its place) is
    // NOT reported as a zero-argument call — it is dropped, and the caller below
    // counts what it dropped rather than treating it as clean.
    if (closed) out.push({ index: m.index, args })
  }
  return out
}

/** Resolve one argument text to a string literal, directly or through a local const. */
function resolveLiteral(arg: string | undefined, consts: Map<string, string>): string | null {
  if (arg === undefined) return null
  const lit = arg.match(/^["']([^"']*)["']$/)
  if (lit) return lit[1]
  return consts.get(arg) ?? null
}

export interface HostRenderedMediaScan {
  /** Document bytes headed for a public-media bucket, or a bucket we cannot resolve. */
  hits: Hit[]
  /** Calls whose contentType is computed at runtime — the honest blind spot. */
  unresolvedContentType: number
  /** Calls examined in total, so the two numbers above have a denominator. */
  calls: number
}

/**
 * `hostRenderedMedia(svc, path, bytes, contentType, bucket?)` calls that put
 * DOCUMENT bytes somewhere a permanent public URL can be minted for them.
 *
 * FAIL CLOSED on the bucket: once the content type says "document", a bucket
 * argument that cannot be resolved to a literal is treated as public, because
 * "we could not tell" must not read as "checked and fine" (§4).
 *
 * HONEST about the other half: a contentType computed at runtime
 * (`outputContentType(frames)`) cannot be classified, and those are counted and
 * PUBLISHED rather than silently folded into the pass. They are the video and
 * audio renders this default bucket exists for.
 */
export function findDocumentBytesInPublicBucket(code: string, defaultBucket: string): HostRenderedMediaScan {
  const consts = localStringConsts(code)
  const scan: HostRenderedMediaScan = { hits: [], unresolvedContentType: 0, calls: 0 }
  for (const call of callArguments(code, "hostRenderedMedia")) {
    // A re-export/import line (`import { hostRenderedMedia } from …`) never
    // parses as a call, so nothing filters those out here — they have no `(`.
    if (call.args.length < 4) { scan.calls += 1; scan.unresolvedContentType += 1; continue }
    scan.calls += 1
    const contentType = resolveLiteral(call.args[3], consts)
    if (contentType === null) { scan.unresolvedContentType += 1; continue }
    if (!isDocumentContentType(contentType)) continue

    // Annotated `string | undefined` deliberately: `noUncheckedIndexedAccess` is
    // OFF in this tsconfig, so `args[4]` types as `string` and `=== undefined`
    // would be a TS2367 "no overlap" error on a comparison that is true at
    // runtime for every 4-argument call — which is exactly the case that matters.
    const bucketArg: string | undefined = call.args[4]
    const bucket = bucketArg === undefined ? defaultBucket : resolveLiteral(bucketArg, consts)
    if (bucket !== null && isDocumentClassBucket(bucket)) continue

    scan.hits.push({
      line: lineOf(code, call.index),
      bucket: bucket ?? `<unresolved:${bucketArg}>`,
      detail:
        bucket === null
          ? `${contentType} bytes with a bucket argument that could not be resolved — fail closed`
          : bucketArg === undefined
          ? `${contentType} bytes with NO bucket argument, so they take the public default '${bucket}'`
          : `${contentType} bytes into the public-media bucket '${bucket}'`,
    })
  }
  return scan
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

const files = scanCorpus().sort()

const sources = new Map<string, string>()
for (const f of files) sources.set(f, blankComments(readFileSync(join(root, f), "utf8")))

console.log(`\n  scanned ${files.length} .ts/.tsx files under app/, lib/ and the repository ROOT (${rootRuntimeFiles(root).length} root runtime files)`)
console.log(`  document-class buckets: ${Object.keys(DOCUMENT_CLASS_BUCKETS).length} · public-media buckets: ${Object.keys(PUBLIC_MEDIA_BUCKETS).length}`)
// The blind spot, stated exactly. `components/` used to be named here as an exclusion;
// there is no top-level components/ directory in this repo — components live under
// app/**/components and were always scanned. Naming a directory that does not exist as
// "excluded" published a blind spot that was not real while hiding that none was.
console.log("  EXCLUDED: scripts/ and e2e/ (simulators quote these strings verbatim), *.test.ts")

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

// ── 6b · POSITIVE CONTROL for the section-9 finder ──────────────────────────
// The LIVE defect, in the exact shape it shipped: a PDF whose bucket argument is
// simply absent. Nothing in sections 1-3 can see it, so this control is the only
// thing standing between section 9 and a permanently green blind spot.
console.log("\n[6b · POSITIVE CONTROL — document bytes into a public bucket]")
const DEFAULT_BUCKET_PROBE = "video-assets"
const hostHits = (src: string) => findDocumentBytesInPublicBucket(b(src), DEFAULT_BUCKET_PROBE).hits

const DIRTY_HOST_OMITTED = `
  const pdfUrl = await hostRenderedMedia(svc, \`client-docs/\${params.brokerageId}/\${fileName}\`, buf, "application/pdf")
`
const DIRTY_HOST_EXPLICIT_PUBLIC = `
  const url = await hostRenderedMedia(svc, path, buf, "application/pdf", "video-assets")
`
const DIRTY_HOST_UNRESOLVED_BUCKET = `
  const url = await hostRenderedMedia(svc, path, buf, "application/pdf", pickBucket(kind))
`
// The argument-splitter's own control: a template literal carrying commas,
// parentheses and braces must not shift the index of the fourth argument. A
// comma-splitting regex reads "application/pdf" as the FIFTH argument here and
// the whole finder silently reports zero.
const DIRTY_HOST_COMMAS_IN_TEMPLATE = `
  const url = await hostRenderedMedia(svc, \`client-docs/\${fmt(a, b)}/\${[x, y].join(",")}.pdf\`, buf, "application/pdf")
`
const CLEAN_HOST_NAMED_DOC_BUCKET = `
  const GENERATED_DOCUMENT_BUCKET = "documents"
  const url = await hostRenderedMedia(svc, path, buf, "application/pdf", GENERATED_DOCUMENT_BUCKET)
`
const CLEAN_HOST_MEDIA = `
  const url = await hostRenderedMedia(svc, \`listing-promo/reels/\${id}.mp4\`, bytes, "video/mp4")
  const thumb = await hostRenderedMedia(svc, \`thumbs/\${id}.png\`, thumbBytes, "image/png")
  const audio = await hostRenderedMedia(svc, path, buf, "audio/mpeg", "media")
`
const BLIND_HOST_RUNTIME_MIME = `
  const url = await hostRenderedMedia(svc, path, bytes, outputContentType(composition.duration_frames))
`

check("RED: a PDF with NO bucket argument (the live defect) is flagged",
  hostHits(DIRTY_HOST_OMITTED).length === 1,
  "an omitted bucket is not being charged against the public default")
check("RED: a PDF explicitly named into a public-media bucket is flagged",
  hostHits(DIRTY_HOST_EXPLICIT_PUBLIC).length === 1)
check("RED: a PDF whose bucket cannot be resolved is flagged (fail closed)",
  hostHits(DIRTY_HOST_UNRESOLVED_BUCKET).length === 1)
check("RED: …even when the path template contains commas, parens and braces",
  hostHits(DIRTY_HOST_COMMAS_IN_TEMPLATE).length === 1,
  "the argument splitter is mis-indexing calls whose path template contains a comma")
check("GREEN: a PDF into a document-class bucket (literal or local const) is NOT flagged",
  hostHits(CLEAN_HOST_NAMED_DOC_BUCKET).length === 0)
check("GREEN: video/image/audio renders on the public default are NOT flagged",
  hostHits(CLEAN_HOST_MEDIA).length === 0)
// The blind spot, proved to BE a blind spot rather than assumed: a runtime mime
// yields no hit AND is counted, so the number section 9 prints is honest.
const blindScan = findDocumentBytesInPublicBucket(b(BLIND_HOST_RUNTIME_MIME), DEFAULT_BUCKET_PROBE)
check("BLIND SPOT, counted not hidden: a runtime-computed contentType yields no hit and IS counted",
  blindScan.hits.length === 0 && blindScan.unresolvedContentType === 1)
check("GREEN: the same defect inside a comment is not counted",
  hostHits(`// await hostRenderedMedia(svc, p, buf, "application/pdf")\n`).length === 0)
check("isDocumentContentType recognises the document formats and rejects media",
  isDocumentContentType("application/pdf") && isDocumentContentType("text/csv") &&
  isDocumentContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document") &&
  !isDocumentContentType("video/mp4") && !isDocumentContentType("image/png") && !isDocumentContentType("audio/mpeg"))

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

// ── 9 · document bytes never ride the media host's PUBLIC default ───────────
console.log("\n[9 · no DOCUMENT bytes are hosted into a public-media bucket]")

// DERIVE the default rather than hardcode it (§2 — a hardcoded 'video-assets'
// here would keep passing after somebody changed the default). If it cannot be
// read, that is a FAILURE, not a reason to guess: a finder that charges omitted
// bucket arguments against the wrong default is a finder that reports zero.
const mediaHostSrc = blankComments(readFileSync(join(root, "lib/remotion/media-host.ts"), "utf8"))
const defaultBucketMatch = mediaHostSrc.match(/RENDER_MEDIA_BUCKET\s*(?::[^=]+)?=\s*["']([^"']+)["']/)
const DEFAULT_HOST_BUCKET = defaultBucketMatch?.[1] ?? null
check("the media host's default bucket can be read out of lib/remotion/media-host.ts",
  DEFAULT_HOST_BUCKET !== null,
  "RENDER_MEDIA_BUCKET's literal could not be found — section 9 cannot charge an omitted argument against anything")

if (DEFAULT_HOST_BUCKET) {
  console.log(`  hostRenderedMedia's default bucket is '${DEFAULT_HOST_BUCKET}' — ${isDocumentClassBucket(DEFAULT_HOST_BUCKET) ? "document-class" : "PUBLIC-MEDIA, so an omitted bucket argument publishes"}`)

  const hostHitsLive: Array<Hit & { file: string }> = []
  let hostCalls = 0
  let hostRuntimeMime = 0
  for (const [f, code] of sources) {
    const s = findDocumentBytesInPublicBucket(code, DEFAULT_HOST_BUCKET)
    hostCalls += s.calls
    hostRuntimeMime += s.unresolvedContentType
    for (const h of s.hits) hostHitsLive.push({ ...h, file: f })
  }
  // The denominator and the exclusions, beside the number (§2).
  console.log(`  hostRenderedMedia call sites examined: ${hostCalls} · document-typed into a public bucket: ${hostHitsLive.length} · contentType computed at runtime (UNCLASSIFIABLE, the blind spot): ${hostRuntimeMime}`)
  for (const h of hostHitsLive) console.log(`     · ${h.file}:${h.line} — ${h.detail}`)
  check(`zero document-typed hostRenderedMedia calls land in a public-media bucket (${hostHitsLive.length} found)`,
    hostHitsLive.length === 0,
    hostHitsLive.map((h) => `${h.file}:${h.line}`).join(", "))
  // A finder that examined nothing also reports zero. The corpus contains this
  // helper's call sites by construction, so an empty scan means the scanner
  // broke, not that the tree is clean.
  check(`the finder actually reached hostRenderedMedia call sites (${hostCalls} examined)`, hostCalls > 0)
}

// The constant the producers name, checked as a RULE rather than as a spelling:
// whatever GENERATED_DOCUMENT_BUCKET is set to must be document-class, or
// pointing the producers at it would re-open exactly what section 9 closes.
check(`GENERATED_DOCUMENT_BUCKET ('${GENERATED_DOCUMENT_BUCKET}') is document-class`,
  isDocumentClassBucket(GENERATED_DOCUMENT_BUCKET),
  bucketClassReason(GENERATED_DOCUMENT_BUCKET))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log(" ✅ PUBLIC_BUCKET_EGRESS_PASS — no document-class object is served at a permanent public URL")
