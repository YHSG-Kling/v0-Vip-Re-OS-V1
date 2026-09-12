/**
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
 * a raw `fileSizeLimitBytes: null` means "the project global applies", not
 * "unlimited", and file-limits.ts is where that is resolved and where the
 * transport ceiling (a Vercel function body cap far below every number here) is
 * folded in.
 *
 * ── PROVENANCE — this file is MACHINE-WRITTEN. Do not hand-edit it. ──────────
 * generated: 2026-08-26
 * source: storage.buckets (project hrvaqgvukzxfskkcrwbt)
 * body-sha256: 13a95fdc209980b07bf80deac8c222d91509eb9e444428040a3992973ea19376
 *
 * scripts/file-limit-truth-guard.ts recomputes body-sha256 from the bytes below, so a
 * hand-edit is loud even with no credentials; where SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY exist it also re-reads the live buckets and compares.
 * To update: regenerate with scripts/generate-bucket-limits.ts, review the diff, commit it.
 */
// ─── BODY — body-sha256 covers every byte from the next line to EOF ─────────
export type LiveBucketConfig = {
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
  "agent-documents": { isPublic: false, fileSizeLimitBytes: 10485760, allowedMimeTypes: null },
  "agent-media": { isPublic: true, fileSizeLimitBytes: null, allowedMimeTypes: null },
  "brokerage-assets": { isPublic: true, fileSizeLimitBytes: 5242880, allowedMimeTypes: ["image/png", "image/svg+xml", "image/jpeg"] },
  "brokerage-forms": { isPublic: false, fileSizeLimitBytes: null, allowedMimeTypes: null },
  "business-cards": { isPublic: true, fileSizeLimitBytes: null, allowedMimeTypes: null },
  "client-documents": { isPublic: false, fileSizeLimitBytes: null, allowedMimeTypes: null },
  "documents": { isPublic: false, fileSizeLimitBytes: null, allowedMimeTypes: null },
  "listing-media": { isPublic: true, fileSizeLimitBytes: 52428800, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "video/mp4", "video/quicktime", "video/webm"] },
  "media": { isPublic: true, fileSizeLimitBytes: null, allowedMimeTypes: null },
  "offer-documents": { isPublic: false, fileSizeLimitBytes: null, allowedMimeTypes: null },
  "transaction-documents": { isPublic: false, fileSizeLimitBytes: null, allowedMimeTypes: null },
  "video-assets": { isPublic: true, fileSizeLimitBytes: null, allowedMimeTypes: null },
}
