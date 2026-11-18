// lib/storage/put-and-sign.ts
// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD BYTES AND GET A URL — OR LEAVE NOTHING BEHIND.
//
// Owner ruling (wave 12): "…along with the orphaned storage objects for supabase
// buckets."
//
// THE DEFECT. Every document lane in this codebase has the same two-step shape:
// put the bytes in the bucket, then mint a URL for them. `signedDocUrl` returns
// `""` on failure — deliberately, "so callers can guard exactly as they did for
// publicUrl" — and every one of the eleven callers DOES guard. Every one of them
// guards by returning AFTER the bytes are already in the bucket:
//
//   const { data: up } = await svc.storage.from(bucket).upload(path, buf)
//   const url = await signedDocUrl(svc, bucket, up.path)
//   if (!url) return { handled: false }        // ← the file is still up there
//
// The object survives with no `documents` row, no `offers` row and no log line
// naming it. Nothing in the tree has ever swept a bucket. The bytes are a
// client's contract, W-9 or KYC packet, so this is not merely wasted storage.
//
// THE SHAPE OF THE FIX is a COMPENSATING DELETE, not a ledger of everything that
// ever went wrong. When the second step fails we undo the first. Only when the
// UNDO ALSO FAILS is there a genuine orphan, and only then does a row get
// written to `storage_orphaned_objects` (m387) for the sweeper to retry. A
// ledger that recorded every hiccup would be a log; this one is a WORKLIST, and
// an empty worklist means what it says.
//
// PRE-ROLLOUT the buckets are empty. "The sweep found nothing" is therefore not
// evidence of health, and neither is "no orphans were recorded" — which is why
// the failure to record one is itself returned to the caller rather than
// swallowed.

//
// SIGN ON READ (wave 154, lane 154M; open-loop 146A-SO-02). The second step no longer MINTS a link: it returns the
// object's `docref://` REFERENCE (lib/storage/signed-doc-url.ts toDocumentRef) — what the caller's row stores. Until wave
// 154 it returned a TEN-YEAR signed URL that every caller persisted, a bearer link that outlived revocation. TOMBSTONE (§1):
// the `signedUrl` field is gone; survivor: `ref`. A person opens it through documentOpenHref → app/api/documents/open; a
// server consumer resolves it at use time (resolveDocumentLink; the connector gateway does it for byte fetches). The name `putAndSign` is kept so the
// door census in scripts/transfer-classification-guard.ts keeps seeing every upload through it.

import type { SupabaseClient } from "@supabase/supabase-js"
import { toDocumentRef } from "./signed-doc-url"

export type PutAndSignFailure = {
  ok: false
  /** Which half failed — the upload never happened, or the URL did not mint. */
  stage: "upload" | "sign"
  error: string
  /** The object left in the bucket by the failed attempt, if any. */
  orphanPath: string | null
  /** true = the compensating delete removed it and nothing is left behind. */
  orphanRemoved: boolean
  /** true = it could NOT be removed and a worklist row was written. */
  orphanRecorded: boolean
  /** Set when even the worklist write was refused — nothing knows about it. */
  orphanUnrecordedReason: string | null
}

export type PutAndSignResult =
  /** `ref` is the `docref://` reference a row stores — never a link (lib/storage/signed-doc-url.ts). */
  | { ok: true; path: string; ref: string }
  | PutAndSignFailure

/**
 * Put bytes in a private bucket and return a usable URL, or leave the bucket
 * exactly as it was found.
 *
 * `brokerageId` is carried only so an orphan worklist row can be attributed to a
 * tenant; it is never used to build the path (callers already do that).
 */
export async function putAndSign(
  client: SupabaseClient,
  params: {
    bucket:       string
    path:         string
    body:         Buffer | Uint8Array | Blob | ArrayBuffer
    contentType?: string
    upsert?:      boolean
    brokerageId?: string | null
    /** Why these bytes were being stored — recorded on a worklist row. */
    reason?:      string
  },
): Promise<PutAndSignResult> {
  const { data: up, error: upErr } = await client.storage
    .from(params.bucket)
    .upload(params.path, params.body as never, {
      contentType: params.contentType,
      upsert:      params.upsert ?? false,
    })

  if (upErr || !up?.path) {
    // Nothing landed, so there is nothing to compensate for.
    return {
      ok: false,
      stage: "upload",
      error: upErr?.message ?? "the storage upload returned no path",
      orphanPath: null,
      orphanRemoved: false,
      orphanRecorded: false,
      orphanUnrecordedReason: null,
    }
  }

  let ref = ""
  try { ref = toDocumentRef(params.bucket, up.path) } catch { ref = "" }
  if (ref) return { ok: true, path: up.path, ref }

  const compensation = await removeOrRecordOrphan(client, {
    bucket:      params.bucket,
    objectPath:  up.path,
    reason:      params.reason ?? "signed_url_failed",
    detail:      "the bytes uploaded but no storable reference could be formed for them, so no database row was ever created for them",
    brokerageId: params.brokerageId ?? null,
  })

  return {
    ok: false,
    stage: "sign",
    error: "the file uploaded but no storable reference could be formed for it",
    orphanPath: up.path,
    ...compensation,
  }
}

/**
 * THE COMPENSATING DELETE. Exported on its own because several lanes upload and
 * then fail for a reason of their own (a NOT-NULL column they cannot fill, a
 * refused insert) — they have the same object to undo and must not re-implement
 * the undo.
 *
 * Every result is REPORTED. A silent compensation is the same class of bug as
 * the orphan it is cleaning up.
 */
export async function removeOrRecordOrphan(
  client: SupabaseClient,
  params: {
    bucket:      string
    objectPath:  string
    reason:      string
    detail?:     string | null
    brokerageId?: string | null
  },
): Promise<{
  orphanRemoved: boolean
  orphanRecorded: boolean
  orphanUnrecordedReason: string | null
}> {
  const { error: rmErr } = await client.storage.from(params.bucket).remove([params.objectPath])
  if (!rmErr) {
    return { orphanRemoved: true, orphanRecorded: false, orphanUnrecordedReason: null }
  }

  // The undo itself was refused — THIS is a real orphan. Record it so a sweeper
  // can retry, and say so out loud if even that write fails, because at that
  // point nothing in the system knows the object exists.
  const row = {
    brokerage_id: params.brokerageId ?? null,
    bucket:       params.bucket,
    object_path:  params.objectPath,
    reason:       params.reason,
    detail:       [params.detail, `remove refused: ${rmErr.message}`].filter(Boolean).join(" — "),
  }
  const { error: insErr } = await client
    .from("storage_orphaned_objects")
    .upsert(row, { onConflict: "bucket,object_path", ignoreDuplicates: true })

  if (insErr) {
    console.error(
      `[storage] ORPHAN NOT RECORDED — ${params.bucket}/${params.objectPath} could not be removed ` +
      `(${rmErr.message}) and the worklist write was refused (${insErr.message}). ` +
      "Nothing else in the system knows this object exists.",
    )
    return { orphanRemoved: false, orphanRecorded: false, orphanUnrecordedReason: insErr.message }
  }

  return { orphanRemoved: false, orphanRecorded: true, orphanUnrecordedReason: null }
}
