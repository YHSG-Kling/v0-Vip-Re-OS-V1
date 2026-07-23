// lib/storage/buckets.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE Supabase Storage helper — the platform stores ALL uploads/downloads in
// Supabase buckets (owner rule), never a third-party blob store. Server-only.
// Mirrors the pattern already used by app/actions/twin-studio-upload.ts so every
// upload flow migrating off Vercel Blob shares one implementation.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

/** Create the bucket if it doesn't exist yet (idempotent). */
export async function ensureBucket(
  name: string,
  opts?: { public?: boolean; fileSizeLimit?: number },
): Promise<void> {
  const svc = createServiceClient()
  const { data: list } = await svc.storage.listBuckets()
  if (list?.some((b) => b.name === name)) return
  await svc.storage.createBucket(name, {
    public: opts?.public ?? true,
    fileSizeLimit: opts?.fileSizeLimit ?? 50 * 1024 * 1024, // 50 MB
  })
}

/** Upload bytes to a Supabase bucket and return a URL. Public buckets return a
 *  public URL; private buckets return a time-limited signed URL. */
export async function uploadBufferToBucket(params: {
  bucket: string
  path: string
  buffer: Buffer
  contentType: string
  /** Bucket visibility on first creation (default public). */
  public?: boolean
  upsert?: boolean
  /** Signed-URL TTL seconds for a private bucket (default 1h). */
  signedTtlSeconds?: number
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const isPublic = params.public ?? true
  await ensureBucket(params.bucket, { public: isPublic })
  const svc = createServiceClient()

  const { error } = await svc.storage
    .from(params.bucket)
    .upload(params.path, params.buffer, { contentType: params.contentType, upsert: params.upsert ?? false })
  if (error) return { ok: false, error: error.message }

  if (isPublic) {
    const { data } = svc.storage.from(params.bucket).getPublicUrl(params.path)
    return { ok: true, url: data.publicUrl }
  }
  const { data, error: signErr } = await svc.storage
    .from(params.bucket)
    .createSignedUrl(params.path, params.signedTtlSeconds ?? 3600)
  if (signErr || !data) return { ok: false, error: signErr?.message ?? "sign_failed" }
  return { ok: true, url: data.signedUrl }
}
