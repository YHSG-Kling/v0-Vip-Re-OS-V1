// lib/storage/file-limits.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHY WE HAVE FILE LIMITS, AND WHOSE LIMIT ACTUALLY DECIDES.
//
// Owner ruling (2026-08-26): "research why we have file limits."
//
// The honest answer is that WE mostly do not — two platforms do, and until this
// module existed the numbers written down in this tree contradicted both of them.
// `FILE_LIMITS` in lib/constants/index.ts declared IMAGE 10 MB / VIDEO 500 MB /
// DOCUMENT 50 MB, was imported by nothing (verified comment-stripped, one
// declaration and zero consumers), and every one of those three numbers was
// unreachable in production. A constant nobody reads cannot break a request; the
// danger is the day someone reads it and believes it.
//
// THERE ARE THREE REAL CEILINGS, and an upload meets whichever is lowest.
//
//  1. THE TRANSPORT CEILING — 4.5 MB, and it is the one that bites.
//     "The maximum payload size for the request body or the response body of a
//     Vercel Function is 4.5 MB. If a Vercel Function receives a payload in
//     excess of the limit it will return an error 413: FUNCTION_PAYLOAD_TOO_LARGE"
//       https://vercel.com/docs/functions/limitations
//       https://vercel.com/docs/errors/FUNCTION_PAYLOAD_TOO_LARGE
//     It is enforced at the infrastructure level, ahead of our code, and cannot be
//     raised from vercel.json or from application code:
//       https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
//     EVERY Next.js route handler and EVERY Server Action in this repo is a Vercel
//     Function. So a 500 MB video cap was never a product promise the platform
//     could keep — a 5 MB one already is not.
//     next.config.ts sets `serverActions.bodySizeLimit: '8mb'`, above the Next.js
//     default of 1 MB (https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions).
//     That raises the FRAMEWORK's ceiling and cannot lower Vercel's, so the
//     effective Server Action ceiling in production is 4.5 MB, not 8 MB — and for
//     the actions that send a PDF as base64 (uploadTwinAvatar, the CDA template
//     uploads next.config.ts's own comment names) it is 4.5 MB of ENCODED bytes,
//     which is ~3.4 MB of real file.
//     A browser that PUTs straight to Supabase Storage never touches a Vercel
//     Function and never meets this ceiling — which is exactly why the transport
//     is a parameter here and not a constant.
//
//  2. THE BUCKET CEILING — per bucket, enforced by Supabase Storage itself.
//     "you can specify the maximum file size on a per bucket level"
//       https://supabase.com/docs/guides/storage/uploads/file-limits
//     Three live buckets carry one today (measured 2026-08-26, cached in
//     ./bucket-limits.ts): brokerage-assets 5 MB image-only, agent-documents
//     10 MB, listing-media 50 MB image+video. This is a REAL gate: the Storage
//     API refuses an oversized PUT whether or not our code looked first, which
//     makes it the SURVIVOR (CLAUDE.md §1) and makes any application constant
//     that disagrees with it a lie rather than a policy.
//
//  3. THE PROJECT GLOBAL — "You can set the maximum file size across all your
//     buckets… a per bucket level… can't be higher than this global limit."
//       https://supabase.com/docs/guides/storage/uploads/file-limits
//     It is not readable from SQL, so it is not claimed here. What IS provable is
//     a FLOOR: the global cannot be below the largest bucket limit that exists,
//     so it is derived below rather than guessed. Under-promising is the safe
//     direction; over-promising is the failure this module exists to end.
//
// AND THE REASONS BEHIND THE PLATFORMS' REASONS, which is the part a product
// decision actually turns on: bytes in a bucket are billed by GB-hour and bytes
// leaving it are billed as egress (https://supabase.com/docs/guides/storage/production/scaling
// recommends a bucket cap for exactly this), and a function that buffers a large
// body pays for it in memory and duration. §5 already makes a wrong number in a
// cost ledger a wrong invoice; storage is the same shape.
//
// ── HOW TO USE THIS ─────────────────────────────────────────────────────────
// Server-side, at the boundary where bytes arrive, before the upload:
//
//     const gate = checkUpload({ bucket: "documents", transport: "route_handler",
//                                bytes: file.size, contentType: file.type })
//     if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 413 })
//
// A client-side check is a COURTESY — it makes the error immediate instead of
// arriving after a long upload — and never a gate. The gate is server-side
// (CLAUDE.md §4), and it FAILS CLOSED: an unknown bucket, an unmeasurable size
// or a bucket that declares mime types the caller cannot name is REFUSED, never
// waved through. "Nobody checked" must not render as "checked and fine".

import { LIVE_BUCKET_CONFIG, type LiveBucketConfig } from "./bucket-limits"

// ─── PLATFORM FACTS ─────────────────────────────────────────────────────────

/**
 * Vercel's function request-body cap. Documented as "4.5 MB"; the decimal
 * reading (4,500,000) is smaller than the binary one (4,718,592), so the decimal
 * one is used. When a platform states a limit ambiguously, the conservative
 * reading is the only one that cannot promise more than the platform delivers.
 */
export const VERCEL_FUNCTION_BODY_LIMIT_BYTES = 4_500_000

/**
 * `experimental.serverActions.bodySizeLimit` in next.config.ts. Recorded so the
 * guard can prove the two are not read as independent budgets: Next.js enforces
 * this in the framework, Vercel enforces 4.5 MB in front of it, and the smaller
 * one is what a user meets. Raising this number alone changes nothing in
 * production.
 */
export const NEXT_SERVER_ACTION_BODY_LIMIT_BYTES = 8 * 1024 * 1024

/**
 * base64 carries 3 bytes in every 4 characters. Server Actions here that accept
 * a `base64` string (app/actions/twin-studio-upload.ts, and the CDA template
 * uploads next.config.ts's comment names) spend their body budget on the ENCODED
 * form, so the decodable payload is three quarters of the ceiling.
 */
export const BASE64_PAYLOAD_RATIO = 3 / 4

/**
 * The `fileSizeLimit` lib/storage/buckets.ts#ensureBucket stamps on a bucket it
 * creates on first write. Exported so that default has ONE spelling (§6): it was
 * written out twice as a bare `50 * 1024 * 1024`, in ensureBucket and again in
 * app/actions/twin-studio-upload.ts, where a change to one would silently not
 * reach the other.
 */
export const BUCKET_CREATION_DEFAULT_LIMIT_BYTES = 50 * 1024 * 1024

// ─── DERIVED FROM THE LIVE BUCKETS ──────────────────────────────────────────

const DECLARED_BUCKET_LIMITS: readonly number[] = Object.values(LIVE_BUCKET_CONFIG)
  .map((b) => b.fileSizeLimitBytes)
  .filter((n): n is number => typeof n === "number" && n > 0)

/**
 * A PROVABLE FLOOR for the project-wide Storage limit, not a claim about the
 * dashboard setting. Supabase forbids a bucket limit above the global, so the
 * global is at least the largest bucket limit that exists. DERIVED, per §2 —
 * hardcoding a number here would pin the assertion to a waypoint that the next
 * bucket edit makes permanently false.
 */
export const PROJECT_GLOBAL_FILE_SIZE_FLOOR_BYTES: number =
  DECLARED_BUCKET_LIMITS.length > 0 ? Math.max(...DECLARED_BUCKET_LIMITS) : BUCKET_CREATION_DEFAULT_LIMIT_BYTES

/**
 * The most restrictive ceiling any live bucket enforces. This is the answer for
 * a bucket nobody named or nobody has heard of — fail closed (§4): the number
 * that is true of every bucket is the only one safe to give when we do not know
 * which bucket the bytes are headed for.
 */
export const MOST_RESTRICTIVE_BUCKET_LIMIT_BYTES: number =
  DECLARED_BUCKET_LIMITS.length > 0 ? Math.min(...DECLARED_BUCKET_LIMITS) : BUCKET_CREATION_DEFAULT_LIMIT_BYTES

// ─── TRANSPORT ──────────────────────────────────────────────────────────────

/**
 * HOW the bytes reach storage — which decides whether a Vercel Function sits in
 * the path at all. This is a required argument on every call in this module
 * because it is the difference between a 50 MB upload working and being refused
 * by infrastructure our code never sees.
 */
export type UploadTransport =
  /** multipart/form-data or a raw body into an app/api/**\/route.ts handler. */
  | "route_handler"
  /** a "use server" action argument (Buffer, Uint8Array, File). */
  | "server_action"
  /** a "use server" action argument carrying the file as a base64 STRING. */
  | "server_action_base64"
  /** the browser PUTs straight to Supabase Storage — no Vercel Function in the path. */
  | "direct_to_storage"

/** PURE — the largest payload this transport can carry, before any bucket limit. */
export function transportCeilingBytes(transport: UploadTransport): number {
  switch (transport) {
    case "route_handler":
      return VERCEL_FUNCTION_BODY_LIMIT_BYTES
    case "server_action":
      // Vercel's cap sits IN FRONT of the framework's, so the smaller wins.
      return Math.min(VERCEL_FUNCTION_BODY_LIMIT_BYTES, NEXT_SERVER_ACTION_BODY_LIMIT_BYTES)
    case "server_action_base64":
      return Math.floor(
        Math.min(VERCEL_FUNCTION_BODY_LIMIT_BYTES, NEXT_SERVER_ACTION_BODY_LIMIT_BYTES) * BASE64_PAYLOAD_RATIO,
      )
    case "direct_to_storage":
      return Number.POSITIVE_INFINITY
  }
}

// ─── BUCKETS ────────────────────────────────────────────────────────────────

/**
 * PURE — the live configuration of a bucket, or null when it does not exist yet.
 *
 * MODULE-LOCAL on purpose. It is fully wired — checkUpload's content-type branch
 * is its consumer — but publishing it would invite a caller to read
 * `fileSizeLimitBytes: null` as "unlimited", which is the exact misreading this
 * module exists to prevent. Ask bucketCeilingBytes instead; it resolves that null.
 */
function liveBucketConfig(bucket: string | null | undefined): LiveBucketConfig | null {
  if (!bucket) return null
  return LIVE_BUCKET_CONFIG[bucket] ?? null
}

/**
 * PURE — the largest object this bucket will accept, resolved three ways and
 * never "unlimited":
 *   · a declared bucket limit  → that number, the thing Storage enforces;
 *   · a live bucket with none  → the project global, of which only a FLOOR is
 *     provable, so the floor is used (under-promise, never over-promise);
 *   · a bucket that does not exist yet → the limit ensureBucket will stamp on it
 *     when the first write creates it, capped by the global floor;
 *   · no bucket named at all → the most restrictive limit any live bucket
 *     enforces. FAIL CLOSED.
 */
export function bucketCeilingBytes(bucket: string | null | undefined): number {
  if (!bucket) return MOST_RESTRICTIVE_BUCKET_LIMIT_BYTES
  const cfg = LIVE_BUCKET_CONFIG[bucket]
  if (!cfg) return Math.min(BUCKET_CREATION_DEFAULT_LIMIT_BYTES, PROJECT_GLOBAL_FILE_SIZE_FLOOR_BYTES)
  if (cfg.fileSizeLimitBytes === null) return PROJECT_GLOBAL_FILE_SIZE_FLOOR_BYTES
  return cfg.fileSizeLimitBytes
}

/**
 * PURE — the effective ceiling for one upload: the SMALLER of what the transport
 * can carry and what the bucket will accept. Both halves are required; asking
 * for one without the other is how a 50 MB bucket limit came to be quoted at a
 * user whose bytes could never get past 4.5 MB of Vercel.
 */
export function uploadCeilingBytes(params: { bucket: string | null | undefined; transport: UploadTransport }): number {
  return Math.min(bucketCeilingBytes(params.bucket), transportCeilingBytes(params.transport))
}

// ─── THE GATE ───────────────────────────────────────────────────────────────

export type UploadGateResult =
  | { ok: true; ceilingBytes: number }
  | { ok: false; ceilingBytes: number; reason: string; refusedBy: "size" | "content_type" | "unmeasurable" }

/**
 * PURE — "5.0 MB", for a message a user reads. MODULE-LOCAL: its consumer is the
 * refusal text checkUpload builds, and a caller wanting the number formatted
 * should take it from `gate.reason` rather than re-deriving a second wording of
 * the same limit (§6).
 */
function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unlimited"
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * THE SERVER-SIDE GATE. Refuses before the bytes are handed to Storage.
 *
 * FAIL CLOSED in three places, each of which is a real shape seen in this tree:
 *   · a size that is not a finite non-negative number (a missing `file.size`, a
 *     stream of unknown length) is REFUSED as unmeasurable — a gate that cannot
 *     run must refuse, not pass;
 *   · a bucket the cache has never seen resolves to the creation default rather
 *     than to no limit;
 *   · a bucket that DECLARES allowed_mime_types refuses a caller who supplies no
 *     content type, because the Storage API is about to refuse it anyway and a
 *     413/415 after the upload is a worse answer than a 400 before it.
 *
 * A bucket with NO declared mime list accepts any type; that is the live
 * configuration, not an assumption, so no type check is invented for it.
 */
export function checkUpload(params: {
  bucket: string | null | undefined
  transport: UploadTransport
  bytes: number | null | undefined
  contentType?: string | null
}): UploadGateResult {
  const ceilingBytes = uploadCeilingBytes(params)

  if (typeof params.bytes !== "number" || !Number.isFinite(params.bytes) || params.bytes < 0) {
    return {
      ok: false,
      ceilingBytes,
      refusedBy: "unmeasurable",
      reason:
        "The size of this upload could not be measured, so it cannot be checked against the " +
        `${describeBytes(ceilingBytes)} limit. Refused rather than passed through unchecked.`,
    }
  }

  if (params.bytes > ceilingBytes) {
    // When the two round to the same string the message would read "5.0 MB is
    // over the 5.0 MB limit", which reads as a bug rather than as a limit — so
    // the exact counts are shown instead.
    const overBy =
      describeBytes(params.bytes) === describeBytes(ceilingBytes)
        ? `That file is ${params.bytes.toLocaleString()} bytes, just over the ${ceilingBytes.toLocaleString()}-byte limit`
        : `That file is ${describeBytes(params.bytes)}. The limit here is ${describeBytes(ceilingBytes)}`
    return {
      ok: false,
      ceilingBytes,
      refusedBy: "size",
      reason: `${overBy}${whyCeiling(params)}.`,
    }
  }

  const cfg = liveBucketConfig(params.bucket)
  if (cfg?.allowedMimeTypes) {
    const supplied = (params.contentType ?? "").trim().toLowerCase()
    if (!supplied) {
      return {
        ok: false,
        ceilingBytes,
        refusedBy: "content_type",
        reason:
          `The '${params.bucket}' bucket accepts only ${cfg.allowedMimeTypes.join(", ")}, and this upload named no ` +
          "content type — so it cannot be checked, and is refused rather than left for storage to reject.",
      }
    }
    if (!cfg.allowedMimeTypes.some((m) => m.toLowerCase() === supplied)) {
      return {
        ok: false,
        ceilingBytes,
        refusedBy: "content_type",
        reason: `'${supplied}' is not accepted by the '${params.bucket}' bucket, which takes ${cfg.allowedMimeTypes.join(", ")}.`,
      }
    }
  }

  return { ok: true, ceilingBytes }
}

/** PURE — names WHICH ceiling bound this upload, so a refusal is actionable. */
function whyCeiling(params: { bucket: string | null | undefined; transport: UploadTransport }): string {
  const bucketCap = bucketCeilingBytes(params.bucket)
  const transportCap = transportCeilingBytes(params.transport)
  if (transportCap < bucketCap) {
    return params.transport === "server_action_base64"
      ? " — the request body cap on a serverless function, spent on base64, which is a third larger than the file"
      : " — the request body cap on a serverless function"
  }
  return params.bucket ? ` — the '${params.bucket}' bucket's own limit` : " — the strictest bucket limit in the project"
}

// ─── THE CLASS ROSTERS, AND FILE_LIMITS ─────────────────────────────────────

/**
 * WHICH BUCKETS AN UPLOAD OF EACH CLASS ACTUALLY LANDS IN, from the upload paths
 * that exist. Written out rather than inferred from allowed_mime_types, because
 * most buckets declare none and "accepts everything" says nothing about what a
 * bucket is FOR — inferring would have put a licence scan's 10 MB bucket in the
 * way of listing video.
 *
 * The DOCUMENT roster is the key set of DOCUMENT_CLASS_BUCKETS in
 * ./document-buckets.ts — the existing vocabulary for that idea (§6). It is
 * repeated here rather than imported so this module stays a leaf that a client
 * bundle can hold; scripts/file-limit-truth-guard.ts asserts the two agree, so a
 * bucket added to one and not the other is loud.
 */
export const CLASS_BUCKETS = {
  image: [
    "listing-media",
    "agent-media",
    "brokerage-assets",
    "business-cards",
    "media",
    "video-assets",
    "twin-avatars",
    "agent-documents",
  ],
  video: ["listing-media", "video-assets", "media", "twin-avatars"],
  document: [
    "client-documents",
    "offer-documents",
    "transaction-documents",
    "documents",
    "brokerage-forms",
    "cda-templates",
    "cda-filled",
    "commission-agreements",
    "receipts",
    "agent-documents",
  ],
} as const satisfies Record<string, readonly string[]>

export type UploadClass = keyof typeof CLASS_BUCKETS

/**
 * PURE — the ceiling true of EVERY bucket that class of file lands in. This is
 * the answer to a bucket-less question, so it is the strictest one: a caller who
 * has not said where the bytes are going gets the number that cannot be wrong.
 * A caller who HAS a bucket should ask uploadCeilingBytes and get a real answer.
 */
export function classCeilingBytes(cls: UploadClass): number {
  return Math.min(...CLASS_BUCKETS[cls].map((b) => bucketCeilingBytes(b)))
}

/**
 * FILE_LIMITS — kept, corrected, and DERIVED so it cannot drift again.
 *
 * The declaration this replaces lived at lib/constants/index.ts:541 and said
 * IMAGE 10 MB / VIDEO 500 MB / DOCUMENT 50 MB. All three were wrong, and all
 * three move DOWN:
 *   · IMAGE     10 MB → 5 MB   — brokerage-assets enforces 5 MB on the logo
 *                                upload that is the smallest image surface.
 *   · VIDEO    500 MB → 50 MB  — listing-media enforces 50 MB, and 500 MB was
 *                                never reachable by any route: Supabase would
 *                                have refused it and, through a function, Vercel
 *                                would have refused it 110× sooner.
 *   · DOCUMENT  50 MB → 10 MB  — agent-documents enforces 10 MB.
 * None of these is the number a real upload meets through a serverless function;
 * that is VERCEL_FUNCTION_BODY_LIMIT_BYTES, and checkUpload folds it in.
 */
export const FILE_LIMITS = {
  IMAGE_MAX_SIZE: classCeilingBytes("image"),
  VIDEO_MAX_SIZE: classCeilingBytes("video"),
  DOCUMENT_MAX_SIZE: classCeilingBytes("document"),
} as const
