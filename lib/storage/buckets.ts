// lib/storage/buckets.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE Supabase Storage helper — the platform stores ALL uploads/downloads in
// Supabase buckets (owner rule), never a third-party blob store. Server-only.
// Mirrors the pattern already used by app/actions/twin-studio-upload.ts so every
// upload flow migrating off Vercel Blob shares one implementation.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { isDocumentClassBucket, issueBucketObjectUrl } from "./document-buckets"

/**
 * Create the bucket if it doesn't exist yet (idempotent).
 *
 * THE DEFAULT USED TO BE `public: true`. That is the systemic half of this
 * finding: four of the buckets this tree writes to — cda-templates, cda-filled,
 * commission-agreements, receipts — DO NOT EXIST in the live project yet, so
 * the first write creates them, and the default decided their visibility.
 * Commission disclosures and signed contractor agreements would have been born
 * world-readable, permanently, because nobody passed a flag.
 *
 * The default is now the CLASSIFICATION (lib/storage/document-buckets.ts), which
 * itself fails closed: a bucket nobody has classified is created PRIVATE. An
 * explicit `public: true` still wins — that is how a marketing bucket is
 * declared — but it has to be written down.
 */
export async function ensureBucket(
  name: string,
  opts?: { public?: boolean; fileSizeLimit?: number },
): Promise<void> {
  const svc = createServiceClient()
  const { data: list } = await svc.storage.listBuckets()
  if (list?.some((b) => b.name === name)) return
  await svc.storage.createBucket(name, {
    public: opts?.public ?? !isDocumentClassBucket(name),
    fileSizeLimit: opts?.fileSizeLimit ?? 50 * 1024 * 1024, // 50 MB
  })
}

/**
 * Upload bytes to a Supabase bucket and return a URL.
 *
 * The URL comes from the ONE issuer (issueBucketObjectUrl): a document-class
 * bucket gets a TIME-LIMITED signed URL, a public-media bucket gets a public
 * one. FAIL CLOSED — if a document-class URL cannot be signed this returns
 * ok:false with the reason; it never falls back to getPublicUrl.
 */
export async function uploadBufferToBucket(params: {
  bucket: string
  path: string
  buffer: Buffer
  contentType: string
  /** Bucket visibility on first creation. Default: the bucket's CLASS. */
  public?: boolean
  upsert?: boolean
  /** Signed-URL TTL seconds for a private bucket. Default: DOC_URL_TTL_SECONDS,
   *  because callers persist the URL to a column. */
  signedTtlSeconds?: number
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const isPublic = params.public ?? !isDocumentClassBucket(params.bucket)
  await ensureBucket(params.bucket, { public: isPublic })
  const svc = createServiceClient()

  const { error } = await svc.storage
    .from(params.bucket)
    .upload(params.path, params.buffer, { contentType: params.contentType, upsert: params.upsert ?? false })
  if (error) return { ok: false, error: error.message }

  const issued = await issueBucketObjectUrl(svc as never, {
    bucket: params.bucket,
    objectPath: params.path,
    ttlSeconds: params.signedTtlSeconds,
  })
  if (!issued.ok) return { ok: false, error: issued.reason }
  return { ok: true, url: issued.url }
}
