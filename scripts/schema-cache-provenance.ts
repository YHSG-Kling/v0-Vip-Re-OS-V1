/**
 * scripts/schema-cache-provenance.ts — shared by the schema-cache generators and their drift guard.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LIVE DATABASE IS THE SOURCE OF TRUTH FOR SCHEMA. Three files in scripts/ describe it —
 * the column snapshot, the FK map, the CHECK vocabularies — and they exist ONLY because CI has
 * no database credentials: without them every schema guard in the repo goes blind. They are a
 * CACHE of the database, never a second opinion about it.
 *
 * A cache is only worth having if it is provably in sync, and the failure this module exists to
 * end is the one that already happened: two of those three files carried a "GENERATED — do not
 * hand-edit" banner with NO generator behind it, so the only way to update them was the thing the
 * banner forbade. They were hand-edited, the banners kept saying otherwise, and the numbers in
 * their own headers drifted away from their own contents (the vocabulary file claimed 428 tables /
 * 730 columns while holding 427 / 736). A comment asking politely is not an invariant.
 *
 * WHAT THIS PROVIDES
 *   • fetchLiveJson()  — the credentialed read of the live schema, through the service-role-only
 *     RPCs. information_schema and pg_constraint are NOT reachable through PostgREST (supabase-js
 *     `.from()` only sees exposed schemas), so a plain script cannot read them even holding the
 *     service key. The RPCs are the door: live_schema_json() (pre-existing), plus live_fk_map_json()
 *     and live_check_constraints_json() from m485.
 *   • stamp()/parseStamp()/bodyOf() — the provenance stamp every generated file carries, and the
 *     hash that makes a hand-edit loud. body-sha256 covers everything below the BODY marker, so
 *     editing one character of the data turns the guard red. Editing the stamp to match requires
 *     recomputing a sha256, which is no longer a *silent* hand-edit — it is a deliberate forgery,
 *     and that is the most a file-level mechanism can promise.
 *
 * IDEMPOTENCE. `generated:` is carried forward unchanged when a regeneration produces a
 * byte-identical body. A regen that finds nothing must be a no-op on disk, or every nightly run
 * would rewrite the file and the existing scripts/check-live-schema-drift.ts — which compares the
 * file before and after regenerating — would report drift that does not exist.
 */
import { createHash } from "node:crypto"
import { readSync } from "node:fs"

/**
 * Everything piped in, or "" when nothing was — and never a blocking read on a terminal.
 *
 * `readFileSync(0)` is not enough: on a pipe carrying a few hundred KB (the live schema is ~200)
 * the descriptor can be non-blocking, and that call then returns EAGAIN with the payload half
 * unread — which looks exactly like "nothing was piped" and sends the generator down its
 * credentials path with a full stdin waiting. So the read loops until EOF.
 */
export function readStdinRaw(): string {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  const buf = Buffer.alloc(1 << 16)
  const idle = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    let n: number
    try {
      n = readSync(0, buf, 0, buf.length, null)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "EAGAIN") {
        Atomics.wait(idle, 0, 0, 5) // the writer has not caught up yet
        continue
      }
      if (code === "EOF") break
      return chunks.length ? Buffer.concat(chunks).toString("utf8") : ""
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** Marks where the hashed body begins. Everything after this line is covered by body-sha256. */
export const BODY_MARKER =
  "// ─── BODY — body-sha256 covers every byte from the next line to EOF ─────────"

export type Stamp = { generated: string; source: string; bodySha256: string }

/** PURE — the hashed region of a generated file: everything after the BODY marker line. */
export function bodyOf(fileText: string): string | null {
  const i = fileText.indexOf(BODY_MARKER)
  if (i < 0) return null
  const nl = fileText.indexOf("\n", i)
  return nl < 0 ? "" : fileText.slice(nl + 1)
}

/** PURE — sha256 of a body region, hex. */
export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex")
}

/** PURE — read the stamp out of a generated file's header, or null if it carries none. */
export function parseStamp(fileText: string): Stamp | null {
  const generated = /^ \* generated:\s*(\S+)/m.exec(fileText)?.[1]
  const source = /^ \* source:\s*(.+?)\s*$/m.exec(fileText)?.[1]
  const bodySha256 = /^ \* body-sha256:\s*([0-9a-f]{64})\s*$/m.exec(fileText)?.[1]
  if (!generated || !source || !bodySha256) return null
  return { generated, source, bodySha256 }
}

/**
 * PURE — assemble a stamped file from its prose header and its generated body.
 * `previous` is the file currently on disk (if any); when its body is byte-identical the old
 * `generated:` date is kept so the write is a no-op.
 */
export function stamp(header: string, body: string, source: string, previous: string | null): string {
  const bodySha256 = hashBody(body)
  const prior = previous ? parseStamp(previous) : null
  const priorBody = previous ? bodyOf(previous) : null
  const generated =
    prior && priorBody !== null && hashBody(priorBody) === bodySha256
      ? prior.generated
      : new Date().toISOString().slice(0, 10)

  return `${header.replace(/\s*$/, "")}
 *
 * ── PROVENANCE — this file is MACHINE-WRITTEN. Do not hand-edit it. ──────────
 * generated: ${generated}
 * source: ${source}
 * body-sha256: ${bodySha256}
 *
 * scripts/schema-cache-drift-guard.ts recomputes body-sha256 from the bytes below and compares
 * this file against the LIVE database. A hand-edit fails the first check even with no credentials;
 * a schema change the cache has not absorbed fails the second wherever credentials exist.
 * To update: regenerate (\`npm run schema:regen\`), review the diff, commit it.
 * \`generated:\` is carried forward when a regeneration changes nothing, so a no-op regen writes
 * no bytes.
 */
${BODY_MARKER}
${body}`
}

/** Credentials for the live read, or null when this environment has none. */
export function liveCredentials(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return url && key ? { url, key } : null
}

/**
 * Call one of the service-role-only schema-metadata RPCs and return its JSON.
 * PostgREST answers a refusal with a status + body rather than throwing, exactly as supabase-js
 * resolves with `{ error }` — so the body is surfaced, never swallowed.
 */
export async function fetchLiveJson(fn: string, creds: { url: string; key: string }): Promise<unknown> {
  const res = await fetch(`${creds.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}`, "Content-Type": "application/json" },
    body: "{}",
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${fn}() refused: ${res.status} ${text.slice(0, 400)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${fn}() returned non-JSON: ${text.slice(0, 200)}`)
  }
  if (parsed === null || parsed === undefined) throw new Error(`${fn}() returned null`)
  return parsed
}

/**
 * Read a JSON payload piped on stdin. THE BOOTSTRAP PATH, and deliberately not the default:
 * it is how the caches were first built (a human runs SQL through the MCP and pipes the result),
 * how scripts/check-live-schema-drift.ts feeds the snapshot generator, and how these generators
 * ran before m485 created the RPCs they now prefer.
 * Tolerates the MCP/SQL wrappers: a bare value, or a single-row `[{ "<col>": … }]`.
 */
export function readStdinJson(raw: string, column: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error("nothing on stdin")

  // The payload may arrive wrapped in prose (an MCP result block), so fall back to the widest
  // bracketed span rather than demanding the whole stream be JSON.
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const arr = trimmed.indexOf("[")
    const obj = trimmed.indexOf("{")
    const start = arr >= 0 && (arr < obj || obj < 0) ? arr : obj
    const end = start === arr ? trimmed.lastIndexOf("]") : trimmed.lastIndexOf("}")
    if (start < 0 || end < start) throw new Error("no JSON found on stdin")
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  }

  if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === "object") {
    const row = parsed[0] as Record<string, unknown>
    if (column in row) return row[column]
  }
  return parsed
}
