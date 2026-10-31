// lib/storage/parse-object-url.ts
// ─────────────────────────────────────────────────────────────────────────────
// TURN A STORED SUPABASE OBJECT URL BACK INTO { bucket, objectPath }.
//
// WHY THIS EXISTS. Rows persist a URL, not a path — `transaction_documents
// .storage_url`, `client_documents.document_url`, `podcast_episodes.audio_url`
// and a dozen siblings all hold the string a writer minted. So the DELETE side
// has only a URL to work from, and deleting an object requires the bucket and
// the key.
//
// It is ONE function rather than a parse at each call site (CLAUDE.md §6)
// because getting it subtly wrong is silent: `storage.remove()` on a path that
// matches nothing RESOLVES with no error and an empty array, byte-identical to
// a delete that worked (CLAUDE.md §3). A parser that returns a slightly wrong
// key therefore reports success while the bytes stay in the bucket forever —
// which is precisely the orphan class lib/storage/put-and-sign.ts exists to
// prevent on the write side.
//
// THE TWO SHAPES Supabase serves, both of which appear in live rows:
//   public: https://<proj>.supabase.co/storage/v1/object/public/<bucket>/<key>
//   signed: https://<proj>.supabase.co/storage/v1/object/sign/<bucket>/<key>?token=…
// A signed URL's `?token=` is stripped: it is a capability, not part of the key.

export type ParsedStorageObject = { bucket: string; objectPath: string }

/**
 * PURE. Returns null for anything that is not a Supabase Storage object URL —
 * a legacy Vercel Blob URL, a data: URI, an empty string, a third-party CDN
 * link. NULL MEANS "NOT OURS TO DELETE", and callers must treat it that way
 * rather than guessing a bucket: a wrong guess deletes someone else's object or,
 * more likely, silently deletes nothing at all.
 */
export function parseStorageObjectUrl(url: string | null | undefined): ParsedStorageObject | null {
  if (!url || typeof url !== "string") return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  // /storage/v1/object/{public|sign|authenticated}/{bucket}/{key…}
  const segments = parsed.pathname.split("/").filter(Boolean)
  const objectAt = segments.findIndex((s) => s === "object")
  if (objectAt === -1 || segments[objectAt - 2] !== "storage") return null

  let cursor = objectAt + 1
  if (["public", "sign", "authenticated"].includes(segments[cursor] ?? "")) cursor += 1

  const bucket = segments[cursor]
  const keyParts = segments.slice(cursor + 1)
  if (!bucket || keyParts.length === 0) return null

  // Path segments arrive percent-encoded; the storage key is the decoded form.
  // A segment that fails to decode is left as-is rather than dropped, so a
  // malformed key produces a wrong-but-visible delete rather than a truncated
  // one that silently matches nothing.
  const objectPath = keyParts
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
    .join("/")

  return { bucket, objectPath }
}
