/**
 * scripts/generate-bucket-limits.ts — writes lib/storage/bucket-limits.ts from the LIVE project.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A CACHE AT ALL. CLAUDE.md §3: the live database is the source of truth, and
 * `storage.buckets` is where an upload size limit is actually ENFORCED — the Storage
 * API answers an oversized PUT with 413 whether or not any application code checked
 * first. CI holds no Supabase credentials, so without a committed cache every guard
 * that asks "does this constant agree with the bucket?" goes blind and reports a
 * clean bill of health (§2). This file is a CACHE of that configuration, never a
 * second opinion about it.
 *
 * ── THE SQL, run against project hrvaqgvukzxfskkcrwbt ────────────────────────
 *
 *   select id, name, public, file_size_limit, allowed_mime_types
 *   from storage.buckets
 *   order by id;
 *
 * Pipe the result in:
 *
 *   npx tsx scripts/generate-bucket-limits.ts < buckets.json
 *
 * The rows may arrive bare, or wrapped in an MCP result block — readStdinJson
 * tolerates both, exactly as the schema-cache generators do.
 *
 * ── WHY NOT A CREDENTIALED FETCH LIKE THE SCHEMA CACHES ─────────────────────
 * `storage.buckets` is not in an exposed PostgREST schema, so `.from("buckets")`
 * cannot see it, and there is no live_*_json() RPC for it. The Storage REST API
 * (`GET /storage/v1/bucket`) does return it with a service key — that is the path
 * scripts/file-limit-truth-guard.ts uses for its OPTIONAL live comparison. This
 * generator takes the piped bootstrap path, which is how the caches in this repo
 * were first built and is the path a human with MCP access already has.
 *
 * IDEMPOTENT: a regeneration that changes no bytes carries the old `generated:`
 * date forward, so a no-op regen writes nothing.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { BODY_MARKER, bodyOf, hashBody, parseStamp, readStdinRaw, readStdinJson } from "./schema-cache-provenance"

const OUT = resolve(process.cwd(), "lib/storage/bucket-limits.ts")

type LiveBucketRow = {
  id: string
  name?: string
  public?: boolean
  file_size_limit?: number | string | null
  allowed_mime_types?: string[] | null
}

/**
 * PURE — one cache entry per live bucket, sorted by id so the body is stable.
 * Module-local: the generator's only consumer is the write below it.
 */
function buildBody(rows: readonly LiveBucketRow[]): string {
  const seen = new Set<string>()
  const sorted = [...rows]
    .filter((r) => {
      const id = String(r.id ?? "").trim()
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))

  const lines = sorted.map((r) => {
    const id = String(r.id)
    const limit =
      r.file_size_limit === null || r.file_size_limit === undefined
        ? "null"
        : String(Number(r.file_size_limit))
    const mimes =
      r.allowed_mime_types === null || r.allowed_mime_types === undefined
        ? "null"
        : `[${r.allowed_mime_types.map((m) => JSON.stringify(m)).join(", ")}]`
    return `  ${JSON.stringify(id)}: { isPublic: ${r.public === true}, fileSizeLimitBytes: ${limit}, allowedMimeTypes: ${mimes} },`
  })

  return `export type LiveBucketConfig = {
  /** storage.buckets.public — world-readable object URLs with no expiry. */
  readonly isPublic: boolean
  /** storage.buckets.file_size_limit. null = no bucket limit; the PROJECT global applies. */
  readonly fileSizeLimitBytes: number | null
  /** storage.buckets.allowed_mime_types. null = the bucket accepts any content type. */
  readonly allowedMimeTypes: readonly string[] | null
}

/**
 * Every bucket that EXISTS in the live project, with the limits the Storage API
 * enforces on it. A bucket absent from this map does not exist yet — several are
 * created on first write by lib/storage/buckets.ts#ensureBucket, which is why
 * lib/storage/file-limits.ts answers for an absent bucket with the CREATION
 * default rather than with "no limit".
 */
export const LIVE_BUCKET_CONFIG: Readonly<Record<string, LiveBucketConfig>> = {
${lines.join("\n")}
}
`
}

const HEADER = `/**
 * lib/storage/bucket-limits.ts
 *
 * WHAT THE LIVE SUPABASE PROJECT ACTUALLY ENFORCES ON AN UPLOAD — per bucket.
 *
 * storage.buckets.file_size_limit and storage.buckets.allowed_mime_types are
 * enforced by the Storage API itself: an oversized or wrong-typed PUT is refused
 * with 413 / 415 whether or not any application code looked first. That makes
 * this configuration the SURVIVOR (CLAUDE.md §1) for "how big may a file be",
 * and application constants must AGREE with it rather than contradict it.
 *
 * Read it through lib/storage/file-limits.ts, which is the one vocabulary (§6)
 * for the question. Nothing should index this map directly to make a decision —
 * a raw \`fileSizeLimitBytes: null\` means "the project global applies", not
 * "unlimited", and file-limits.ts is where that is resolved and where the
 * transport ceiling (a Vercel function body cap far below every number here) is
 * folded in.`

const raw = readStdinRaw()
if (!raw.trim()) {
  console.error(
    "nothing on stdin.\n" +
      "Run the SQL in this file's header against project hrvaqgvukzxfskkcrwbt and pipe the JSON in:\n" +
      "  npx tsx scripts/generate-bucket-limits.ts < buckets.json",
  )
  process.exit(1)
}

const parsed = readStdinJson(raw, "result")
const rows = (Array.isArray(parsed) ? parsed : [parsed]) as LiveBucketRow[]
if (rows.length === 0) {
  console.error("the piped payload held no bucket rows — refusing to write an empty cache")
  process.exit(1)
}

const body = buildBody(rows)
const previous = existsSync(OUT) ? readFileSync(OUT, "utf8") : null
const prior = previous ? parseStamp(previous) : null
const priorBody = previous ? bodyOf(previous) : null
const generated =
  prior && priorBody !== null && hashBody(priorBody) === hashBody(body)
    ? prior.generated
    : new Date().toISOString().slice(0, 10)

const file = `${HEADER}
 *
 * ── PROVENANCE — this file is MACHINE-WRITTEN. Do not hand-edit it. ──────────
 * generated: ${generated}
 * source: storage.buckets (project hrvaqgvukzxfskkcrwbt)
 * body-sha256: ${hashBody(body)}
 *
 * scripts/file-limit-truth-guard.ts recomputes body-sha256 from the bytes below, so a
 * hand-edit is loud even with no credentials; where SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY exist it also re-reads the live buckets and compares.
 * To update: regenerate with scripts/generate-bucket-limits.ts, review the diff, commit it.
 */
${BODY_MARKER}
${body}`

if (previous === file) {
  console.log(`no change — ${OUT} already matches the piped rows (${rows.length} buckets)`)
} else {
  writeFileSync(OUT, file, "utf8")
  console.log(`wrote ${OUT} — ${rows.length} buckets, generated ${generated}`)
}
