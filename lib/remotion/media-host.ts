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

/** The default host bucket: public, and what every existing caller used. */
export const RENDER_MEDIA_BUCKET = "video-assets"

/**
 * Store finished render bytes and return the URL to persist.
 *
 * @param bucket  Overrides the default `video-assets`. Added so the audio and
 *                print lanes that used to call Vercel Blob directly can name
 *                the bucket their asset actually belongs in (carrier-fetched
 *                audio → `media`, for instance) instead of piling every media
 *                class into one bucket. Existing callers omit it and are
 *                unaffected.
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
    throw new Error(`[media-host] ${bucket}/${path} stored but no URL could be issued: ${issued.reason}`)
  }
  return issued.url
}
