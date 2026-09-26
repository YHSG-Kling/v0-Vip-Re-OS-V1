// lib/remotion/media-host.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE media host for every finished render. The finished product lives in
// SUPABASE STORAGE — we host the delivery URL.
//
// ── THE FALLBACK IS GONE, AND THAT IS THE POINT ─────────────────────────────
// This function used to end with:
//
//     } catch { /* fall through to blob */ }
//     const { put } = await import("@vercel/blob")
//     const uploaded = await put(path, bytes, { access: "public", contentType })
//     return uploaded.url
//
// Owner ruling (2026-08-26): "supabase buckets should be used for any file
// storage." So the fallback is deleted rather than kept as a safety net, and
// this is now the only host. Survivor for the Vercel Blob half: this function.
//
// WHAT THE FALLBACK ACTUALLY BOUGHT was not resilience, it was SILENCE. The
// `catch {}` swallowed every storage refusal — a missing bucket, an oversized
// object, a wrong mime type — and returned a working blob URL, so a
// misconfiguration that broke Supabase hosting looked exactly like success and
// could persist indefinitely with every render quietly landing somewhere the
// owner had ruled out. Removing it makes those failures LOUD, which is the
// behaviour CLAUDE.md §4 asks for: "nobody checked" must never render as
// "checked and fine".
//
// SO THIS NOW THROWS on failure, deliberately. Callers already sit inside a
// try/catch that marks the render failed (the coordinator, the render routes,
// poll-did-videos) — a render that cannot be hosted has not succeeded, and
// returning a URL that does not exist would be worse than raising.

import { checkUpload } from "@/lib/storage/file-limits"
import { issueBucketObjectUrl } from "@/lib/storage/document-buckets"
import { removeOrRecordOrphan } from "@/lib/storage/put-and-sign"

/**
 * The default host bucket: PUBLIC, and what every existing caller used.
 *
 * READ THIS BEFORE OMITTING THE BUCKET ARGUMENT. `video-assets` is on
 * lib/storage/document-buckets.ts#PUBLIC_MEDIA_BUCKETS, so an object stored here
 * is issued a PERMANENT UNAUTHENTICATED URL — correct for a rendered reel, a TTS
 * track or a thumbnail a render worker fetches with no session, and wrong for
 * anything a person would call a document. Two producers of client PDFs took
 * this default by omission and every generated CMA, net sheet, listing packet,
 * recruiting pitch and appraiser packet received a never-expiring public link;
 * they now name lib/storage/document-buckets.ts#GENERATED_DOCUMENT_BUCKET.
 * scripts/public-bucket-egress-guard.ts section 9 holds that rule.
 */
export const RENDER_MEDIA_BUCKET = "video-assets"

/**
 * Store finished render bytes and return the URL to persist.
 *
 * @param bucket  Overrides the default `video-assets`. Added so the audio and
 *                print lanes that used to call Vercel Blob directly can name
 *                the bucket their asset actually belongs in (carrier-fetched
 *                audio → `media`, for instance) instead of piling every media
 *                class into one bucket. Existing callers omit it and are
 *                unaffected — but see RENDER_MEDIA_BUCKET above: omitting it is
 *                a decision to publish a permanent public URL, so DOCUMENT bytes
 *                (`application/pdf` and friends) must always name their bucket.
 *
 * @throws if the bytes cannot be stored or no URL can be minted.
 */
export async function hostRenderedMedia(
  svc: any,
  path: string,
  bytes: Buffer,
  contentType: string,
  bucket: string = RENDER_MEDIA_BUCKET,
): Promise<string> {
  // THE GATE, before the bytes move. These bytes are server-generated rather
  // than caller-supplied, so this is not an untrusted-input check — it is a
  // check that the destination can actually hold what we are about to send.
  // A render that exceeds its bucket's limit fails here with a readable reason
  // instead of as an opaque storage refusal halfway through the upload.
  //
  // The transport is NOT a Vercel function body here: the bytes are already in
  // this process and go out through the Storage API, so `direct_to_storage` is
  // the honest transport and the bucket's own limit is the only ceiling.
  const gate = checkUpload({
    bucket,
    transport: "direct_to_storage",
    bytes: bytes.length,
    contentType,
  })
  if (!gate.ok) {
    throw new Error(`[media-host] refusing to store ${bucket}/${path}: ${gate.reason}`)
  }

  // supabase-js RESOLVES refusals (CLAUDE.md §3) — read the error rather than
  // assuming a settled promise means the object landed.
  const { error } = await svc.storage
    .from(bucket)
    .upload(path, bytes, { contentType, upsert: true })
  if (error) {
    throw new Error(`[media-host] ${bucket}/${path} upload refused: ${error.message}`)
  }

  // ONE issuer (lib/storage/document-buckets.ts) rather than a bare
  // getPublicUrl, so a bucket that is later reclassified as document-class
  // starts being signed here without this file changing.
  const issued = await issueBucketObjectUrl(svc, { bucket, objectPath: path })
  if (!issued.ok) {
    // THE BYTES ARE ALREADY IN THE BUCKET AT THIS POINT, so throwing without
    // undoing the upload leaves an object nothing in the system knows about —
    // exactly the orphan class lib/storage/put-and-sign.ts was written for, and
    // its `removeOrRecordOrphan` is the survivor for the undo (do NOT re-roll it
    // here). This branch used to be unreachable in practice: every caller took
    // the public-media path, where issuing a URL is local string building that
    // cannot be refused. It became REACHABLE the moment document-class callers
    // arrived, because signing is a network call that can fail — so the
    // compensation has to exist before the failure does, not after.
    const undo = await removeOrRecordOrphan(svc, {
      bucket,
      objectPath: path,
      reason: "media_host_url_issue_failed",
      detail: `issueBucketObjectUrl refused: ${issued.reason}`,
    })
    throw new Error(
      `[media-host] ${bucket}/${path} stored but no URL could be issued: ${issued.reason}` +
        (undo.orphanRemoved
          ? " (the stored object was removed)"
          : undo.orphanRecorded
          ? " (the object could NOT be removed and was recorded on storage_orphaned_objects)"
          : ` (the object could NOT be removed and the worklist write was refused: ${undo.orphanUnrecordedReason})`),
    )
  }
  return issued.url
}
