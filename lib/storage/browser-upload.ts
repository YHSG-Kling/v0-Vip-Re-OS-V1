"use client"

// lib/storage/browser-upload.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE BROWSER HALF OF A DIRECT-TO-STORAGE UPLOAD.
//
// SURVIVOR of `upload()` from "@vercel/blob/client", which this replaces at
// every call site after the owner ruled that all file storage lives in Supabase
// buckets. The server half is app/api/storage/signed-upload/route.ts; the
// mechanics, the citations and the tenancy argument are in
// lib/storage/signed-upload-url.ts.
//
// THE SHAPE IS THE SAME TWO-STEP HANDSHAKE the Vercel client did, and for the
// same reason — the bytes must not pass through a Vercel Function, whose
// request body is capped at 4.5 MB by infrastructure ahead of our code
// (https://vercel.com/docs/functions/limitations). Step 1 asks our server for
// permission and gets back a path plus a token; step 2 PUTs the file straight
// to Supabase Storage. Only step 1 touches a function, and it carries three
// scalars rather than a file.
//
// WHAT CHANGED, AND IT IS NOT COSMETIC: the old helper let the CALLER choose
// the object path, and the old route signed whatever it was given. Here the
// caller names a PURPOSE and a filename; the server decides the bucket and
// builds the tenant-scoped path. A caller cannot ask for another tenant's
// prefix because there is no parameter in which to ask.

import { createClient } from "@/lib/supabase/client"
import type { SignedUploadWireResponse, UploadPurpose } from "./signed-upload-url"

export type BrowserUploadResult =
  | { ok: true; bucket: string; path: string; url: string }
  | { ok: false; error: string }

/**
 * WHAT CAME BACK FROM THE ROUTE, BEFORE IT HAS BEEN CHECKED.
 *
 * Every field is optional because this is the parse of an untrusted `res.json()`
 * — the server may answer with the refusal shape instead, and a non-2xx body
 * carries `error` and nothing else. The optionality is the point; what is NOT
 * negotiable is the field NAMES, so they are derived from the one wire contract
 * in ./signed-upload-url rather than retyped here.
 *
 * TOMBSTONE (§1.1, §6): this used to be a hand-written `TicketResponse`
 * declaring bucket/path/token/url/ceilingBytes itself. It was the second
 * spelling of a shape the server also spelled inline in its
 * NextResponse.json(...), with nothing tying the two together — rename a field
 * on the mint and this file kept compiling and read `undefined` at runtime. The
 * survivor is SignedUploadWireResponse at lib/storage/signed-upload-url.ts. The
 * `url` note below is preserved because it records WHY the browser must not
 * compute that field itself.
 */
// ON `url`, which the wire contract carries and the browser must NOT compute:
// it is the address to persist once the bytes land, produced SERVER-SIDE by the
// one issuer (lib/storage/document-buckets.ts#issueBucketObjectUrl). An earlier
// cut called `getPublicUrl(ticket.bucket)` right here, and
// scripts/public-bucket-egress-guard.ts flagged it correctly: the bucket arrives
// at runtime, so no reader — human or static — can prove it is a public-media
// bucket rather than a document-class one, and a permanent unauthenticated URL
// for a document is the exact defect document-buckets.ts exists to prevent.
// Failing closed on an unresolvable bucket is the right call, so the decision
// moved to where the bucket IS a known literal: the server.
type TicketResponse = Partial<SignedUploadWireResponse> & {
  error?: string
}

/**
 * Upload one file straight to Supabase Storage and return the URL to persist.
 *
 * Never throws for an expected refusal — an oversized file, a wrong content
 * type or a session that cannot mint comes back as `{ ok: false, error }` with
 * the SERVER's wording, so the user reads the real ceiling rather than a
 * generic failure. Callers were previously wrapping `upload()` in try/catch and
 * surfacing `(e as Error).message`; this returns the same information without
 * the throw.
 *
 * The size check happens server-side before a token exists (the browser's own
 * `file.size` is a courtesy, not a gate — it is the client's number). That
 * ordering matters here more than usual: on this transport the bytes never
 * reach our code, so a check after the fact is a check that never happens.
 */
export async function uploadViaSignedUrl(params: {
  purpose: UploadPurpose
  file: File
  /** Overrides the file's own name for the stored object. Sanitised server-side. */
  fileName?: string
}): Promise<BrowserUploadResult> {
  const { purpose, file } = params
  const fileName = params.fileName ?? file.name

  // ── STEP 1: ask our server for permission ────────────────────────────────
  let ticket: TicketResponse
  try {
    const res = await fetch("/api/storage/signed-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose,
        fileName,
        contentType: file.type || "application/octet-stream",
        bytes: file.size,
      }),
    })
    ticket = (await res.json()) as TicketResponse
    if (!res.ok) {
      return { ok: false, error: ticket.error || `Upload was refused (${res.status}).` }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach the upload service." }
  }

  if (!ticket.bucket || !ticket.path || !ticket.token || !ticket.url) {
    return { ok: false, error: ticket.error || "The upload service returned an incomplete ticket." }
  }

  // ── STEP 2: PUT the bytes straight to Storage ────────────────────────────
  // No Vercel Function is in this path, which is the entire point.
  //
  // supabase-js RESOLVES refusals (CLAUDE.md §3) — the storage error is read
  // rather than assumed absent. A bucket-level size or mime refusal surfaces
  // HERE even though the server already checked, because the bucket's own
  // configuration is the real gate and it is allowed to disagree with us.
  const supabase = createClient()
  const { error } = await supabase.storage
    .from(ticket.bucket)
    .uploadToSignedUrl(ticket.path, ticket.token, file, {
      contentType: file.type || "application/octet-stream",
    })

  if (error) {
    return { ok: false, error: error.message }
  }

  // The URL was decided at mint time by the one issuer, on the server, where the
  // bucket is a known literal and its class can actually be checked.
  return { ok: true, bucket: ticket.bucket, path: ticket.path, url: ticket.url }
}
