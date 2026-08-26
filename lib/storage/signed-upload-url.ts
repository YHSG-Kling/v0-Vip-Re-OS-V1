// lib/storage/signed-upload-url.ts
// ─────────────────────────────────────────────────────────────────────────────
// HOW A BROWSER UPLOADS A LARGE FILE WITHOUT A VERCEL FUNCTION IN THE PATH.
//
// Owner ruling (2026-08-26): "supabase buckets should be used for any file
// storage." That settles the question app/api/blob/upload/route.ts was left
// open on — see the tombstone there. This module is what replaces it.
//
// ── THE PROBLEM THE DELETED ROUTE ACTUALLY SOLVED ───────────────────────────
// A Vercel Function's request body is capped at 4.5 MB, enforced by
// infrastructure ahead of our code and not raisable from vercel.json or from
// application code:
//   https://vercel.com/docs/functions/limitations
//   https://vercel.com/docs/errors/FUNCTION_PAYLOAD_TOO_LARGE
// EVERY route handler and EVERY Server Action in this repo is a Vercel
// Function. So routing a 50 MB testimonial video through one is not a slow
// upload, it is a 413 — which is why a naive "just post it to a route handler"
// migration would have silently capped every user upload at 4.5 MB.
//
// Vercel Blob's browser upload dodged that by having the browser PUT straight
// to the blob store. Supabase Storage has the same primitive, and this module
// is it: the SERVER mints a short-lived signed upload URL, the BROWSER PUTs the
// bytes directly to Storage, and no function ever holds the payload. The
// transport ceiling is therefore `direct_to_storage` (unbounded by Vercel), not
// `route_handler` — see lib/storage/file-limits.ts#transportCeilingBytes.
//
// ── WHAT SUPABASE GUARANTEES, AND WHERE ─────────────────────────────────────
// `createSignedUploadUrl(path)` returns `{ signedUrl, token, path }` and the
// token is "valid for 2 hours":
//   https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl
// The browser then calls `uploadToSignedUrl(path, token, file)`, which PUTs to
//   /object/upload/sign/<bucket>/<path>?token=<jwt>
//   https://supabase.com/docs/reference/javascript/file-buckets-uploadtosignedurl
//
// THE TOKEN IS BOUND TO THE PATH, CRYPTOGRAPHICALLY. The upload token is a JWT
// carrying a `url` claim, and the storage server compares that claim to the
// path in the request URL with a byte-exact string equality before it will
// accept a single byte (supabase/storage, src/storage/object.ts,
// verifyObjectSignature):
//
//     if (payload.url !== `${this.bucketId}/${objectName}`) {
//       throw ERRORS.InvalidSignature()
//     }
//
// That is the fact this module's tenancy story rests on: a URL minted for
// tenant A's prefix CANNOT be redirected to tenant B's, because changing the
// path invalidates the signature. It is not an advisory check we perform, it is
// the storage server refusing.
//
// Two further properties, from the same file:
//   · the token is scope-checked (SIGNED_URL_SCOPE_UPLOAD) — an upload token
//     cannot be replayed as a download token;
//   · `canUpload` (the RLS INSERT check) runs at MINT time, not at upload time.
//     So the mint IS the authorization point, which is precisely why the gate
//     below sits here and not on some later callback.
//
// NOT ONE-SHOT — say it plainly, because it would be easy to assume otherwise.
// The token carries only `exp`; nothing consumes it. Within its lifetime it may
// be replayed against THE SAME path. What bounds the damage is `upsert`: minted
// `upsert: false` (the default here), a replay onto an already-written path is
// refused as a duplicate. A caller that needs overwrite must ask for it, and
// that is a decision with a blast radius rather than a convenience.
//
// ── TENANCY (CLAUDE.md §4), AND THE HOLE THIS CLOSES ────────────────────────
// The deleted Vercel Blob route checked only that SOME session existed and then
// signed whatever `pathname` the browser asked for. The three callers passed:
//   · `testimonials/${contactId}/…` — contactId from client props;
//   · `stock-library/${file.name}`  — no tenant in the path at all;
//   · `${file.name}`                — a bare filename at the bucket root.
// So any authenticated user could write any other tenant's object, and two
// brokerages uploading `intro.mp4` wrote the same key. That is the
// body-supplied-tenant IDOR shape §4 names, and it was live.
//
// THE FIX IS STRUCTURAL: a caller cannot name a path here. It names a PURPOSE.
// The purpose decides the bucket, and the prefix is built from the SESSION's
// brokerage id — never from a parameter, never from the request body. The only
// thing the client contributes is a filename, which is sanitised to a leaf and
// can never climb out of its prefix. There is no purpose whose prefix omits the
// tenant.

import { checkUpload, type UploadGateResult } from "./file-limits"

// ─── FILENAME SANITISATION ──────────────────────────────────────────────────

/**
 * Supabase restricts object key characters to alphanumerics, `_-.',`, the set
 * `!*&$@=;:+?()` and whitespace:
 *   https://supabase.com/docs/guides/storage/uploads/file-limits#file-name-restrictions
 * Rather than encode that permissive set, this reduces to the conservative
 * intersection every one of those readings allows, which also removes every
 * character that could matter structurally.
 *
 * PURE. Returns a LEAF, never a path: `/`, `\` and `.` runs are collapsed, so
 * `../../other-tenant/x` becomes `.._.._other-tenant_x` and stays inside the
 * prefix it is appended to. A caller cannot traverse out of its tenant even by
 * trying, and does not need to be trusted not to.
 */
export function sanitizeUploadFileName(raw: string | null | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? ""
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .slice(0, 120)
  return cleaned || "upload"
}

// ─── THE PURPOSE REGISTRY ───────────────────────────────────────────────────

/**
 * The session facts a prefix may be built from. Every field here comes from the
 * SERVER's resolution of the session (lib/platform/acting-context.ts), never
 * from the request — that is the whole point of passing a context object rather
 * than letting a purpose read a parameter.
 */
export type UploadIdentity = {
  brokerageId: string
  userId: string
}

export type UploadPurposeSpec = {
  /** Which live bucket the bytes land in. */
  readonly bucket: string
  /** Human reason this purpose stores where it does — quoted in reports. */
  readonly why: string
  /**
   * The object-key prefix, built ONLY from session identity. Every prefix in
   * this registry begins with the brokerage id; assertPurposePrefixesAreTenantScoped
   * below proves that mechanically rather than by review.
   */
  readonly prefix: (id: UploadIdentity) => string
  /**
   * Content types this purpose accepts, as a courtesy refusal before the bytes
   * move. The bucket's own allowed_mime_types still decides — this cannot widen
   * it, only narrow it. null = defer entirely to the bucket.
   */
  readonly contentTypePrefixes: readonly string[] | null
}

/**
 * EVERY browser-direct upload this app performs. A purpose absent from here
 * cannot be minted, which is what makes "the client cannot name a path" true
 * rather than aspirational.
 *
 * Bucket choices, and why each is NOT just "whichever bucket was handy":
 *
 *  · social_composer  → `media`. Public by design: a scheduled post's image or
 *    video is fetched unauthenticated by the social provider at publish time,
 *    the same way lib/providers/dispatch.ts's carrier audio is. Signing it
 *    would be theatre (lib/storage/document-buckets.ts says so in as many
 *    words) and would expire before the post went out.
 *
 *  · stock_library    → `video-assets`. Brokerage-scoped B-roll and music beds
 *    that the Remotion render workers fetch BY URL while compositing. Those
 *    workers hold no session, so the URL must be permanently fetchable —
 *    `video-assets` is exactly the bucket document-buckets.ts describes for
 *    "TTS audio and rendered video the Remotion workers and public players
 *    fetch by URL".
 *
 *  · portal_testimonial → `video-assets`. A finished testimonial is published
 *    marketing that plays on a public page, so it belongs with the other public
 *    video rather than in a document bucket. Noted honestly: this is a
 *    CLIENT-SUBMITTED recording landing in a PUBLIC bucket. That is correct for
 *    a testimonial, which exists to be shown — but it is a deliberate call, and
 *    the tenant+contact prefix below is what keeps one client's upload from
 *    being enumerable as another's.
 *
 * NONE of these three buckets declares a file_size_limit live, so for all three
 * the only ceiling is the transport — and on this path the transport is
 * `direct_to_storage`, which Vercel does not bound. See PURPOSE_HAS_NO_BUCKET_CEILING
 * below, which derives that list rather than asserting it, and the report that
 * accompanies this change.
 */
export const UPLOAD_PURPOSES = {
  social_composer: {
    bucket: "media",
    why: "Post media a social provider fetches unauthenticated at publish time.",
    prefix: (id) => `${id.brokerageId}/social/${id.userId}`,
    contentTypePrefixes: ["image/", "video/"],
  },
  stock_library: {
    bucket: "video-assets",
    why: "Brokerage B-roll and music beds the Remotion render workers fetch by URL.",
    prefix: (id) => `${id.brokerageId}/stock-library`,
    contentTypePrefixes: ["image/", "video/", "audio/"],
  },
  portal_testimonial: {
    bucket: "video-assets",
    why: "Client testimonial video published on public marketing surfaces.",
    prefix: (id) => `${id.brokerageId}/testimonials/${id.userId}`,
    contentTypePrefixes: ["video/"],
  },
} as const satisfies Record<string, UploadPurposeSpec>

export type UploadPurpose = keyof typeof UPLOAD_PURPOSES

/** PURE — is this an upload purpose we will mint for? Narrows an untrusted string. */
export function isUploadPurpose(value: unknown): value is UploadPurpose {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UPLOAD_PURPOSES, value)
}

/**
 * PURE — the object key for one upload, tenant prefix and all.
 *
 * The timestamp is not decoration: `upsert` is false on every mint below, so a
 * replayed token lands on a key that already exists and is refused. A stable
 * key would make replay an overwrite instead.
 */
export function buildUploadObjectPath(params: {
  purpose: UploadPurpose
  identity: UploadIdentity
  fileName: string
  now?: number
}): string {
  const spec = UPLOAD_PURPOSES[params.purpose]
  const stamp = params.now ?? Date.now()
  return `${spec.prefix(params.identity)}/${stamp}-${sanitizeUploadFileName(params.fileName)}`
}

/**
 * PURE, and a POSITIVE CONTROL in library form (CLAUDE.md §2). Every purpose's
 * prefix must begin with the brokerage id, or a purpose added later could ship
 * a path that two tenants share. Asserting the RULE rather than a hardcoded
 * list of purpose names means adding a purpose cannot quietly opt out of it.
 *
 * Returns the offending purpose names; empty means the rule holds.
 */
export function purposesMissingTenantPrefix(): UploadPurpose[] {
  const probe: UploadIdentity = { brokerageId: "BROKERAGE-PROBE", userId: "USER-PROBE" }
  const other: UploadIdentity = { brokerageId: "OTHER-BROKERAGE", userId: "USER-PROBE" }
  const bad: UploadPurpose[] = []
  for (const name of Object.keys(UPLOAD_PURPOSES) as UploadPurpose[]) {
    const spec = UPLOAD_PURPOSES[name]
    const mine = spec.prefix(probe)
    // Must START with the tenant — a tenant segment buried mid-path still lets
    // a sibling prefix collide — and must MOVE when the tenant moves.
    if (!mine.startsWith(`${probe.brokerageId}/`)) bad.push(name)
    else if (mine === spec.prefix(other)) bad.push(name)
  }
  return bad
}

/**
 * PURE — purposes whose bucket declares no file_size_limit, so the only ceiling
 * on them is the transport. DERIVED from the live bucket cache rather than
 * written down, because a bucket gaining a limit should shrink this list by
 * itself (§2: assert the rule, derive the number).
 */
const PROJECT_FLOOR = checkUpload({
  bucket: "__no-such-bucket-probe__",
  transport: "direct_to_storage",
  bytes: 0,
  contentType: "application/octet-stream",
}).ceilingBytes

export function purposesWithNoBucketCeiling(): UploadPurpose[] {
  // bucketCeilingBytes resolves a null bucket limit to the PROJECT GLOBAL FLOOR,
  // so "no bucket limit" is detected by comparing the bucket's resolved ceiling
  // against that floor rather than by reading null (which file-limits.ts
  // deliberately does not publish, precisely so it cannot be misread as
  // "unlimited").
  const names = Object.keys(UPLOAD_PURPOSES) as UploadPurpose[]
  return names.filter((n) => {
    const gate = checkUpload({
      bucket: UPLOAD_PURPOSES[n].bucket,
      transport: "direct_to_storage",
      bytes: 0,
      contentType: "application/octet-stream",
    })
    // A bucket with a real declared limit yields a finite ceiling well below the
    // project floor; one with none yields the floor itself.
    return gate.ok && gate.ceilingBytes === PROJECT_FLOOR
  })
}

// ─── THE GATE ───────────────────────────────────────────────────────────────

export type SignedUploadPlan = {
  ok: true
  bucket: string
  objectPath: string
  /** The ceiling actually in force — bucket-bound, since transport is unbounded here. */
  ceilingBytes: number
}

export type SignedUploadRefusal = {
  ok: false
  reason: string
  refusedBy: "purpose" | "size" | "content_type" | "unmeasurable" | "identity"
}

/**
 * PURE — decide whether this upload may happen and where it goes. Split out
 * from the minting so it is testable without a Supabase client, which is what
 * lets the positive control below run with no credentials and no network.
 *
 * FAIL CLOSED at every branch: an unknown purpose, a missing session tenant, an
 * unmeasurable size and a content type the purpose does not accept are all
 * refusals. Nothing here has a "pass it through and let storage decide" path,
 * because a 413 after a 50 MB upload is a worse answer than a 400 before it —
 * and because on this transport the bytes never reach us to be checked later.
 */
export function planSignedUpload(params: {
  purpose: unknown
  identity: { brokerageId: string | null | undefined; userId: string | null | undefined }
  fileName: string
  contentType: string | null | undefined
  bytes: number | null | undefined
  now?: number
}): SignedUploadPlan | SignedUploadRefusal {
  if (!isUploadPurpose(params.purpose)) {
    return {
      ok: false,
      refusedBy: "purpose",
      reason:
        `'${String(params.purpose)}' is not an upload purpose this app mints for. ` +
        `Known purposes: ${Object.keys(UPLOAD_PURPOSES).join(", ")}.`,
    }
  }
  const spec = UPLOAD_PURPOSES[params.purpose]

  // The tenant comes from the SESSION. A caller without one is refused rather
  // than defaulted into somebody's bucket prefix.
  const brokerageId = params.identity.brokerageId
  const userId = params.identity.userId
  if (!brokerageId || !userId) {
    return {
      ok: false,
      refusedBy: "identity",
      reason: "This session has no brokerage, so there is no tenant prefix to upload into.",
    }
  }

  const contentType = (params.contentType ?? "").trim().toLowerCase()
  if (spec.contentTypePrefixes) {
    if (!contentType) {
      return {
        ok: false,
        refusedBy: "content_type",
        reason: `This upload named no content type, and '${params.purpose}' accepts only ${spec.contentTypePrefixes.join(", ")}.`,
      }
    }
    if (!spec.contentTypePrefixes.some((p) => contentType.startsWith(p))) {
      return {
        ok: false,
        refusedBy: "content_type",
        reason: `'${contentType}' is not accepted for ${params.purpose}, which takes ${spec.contentTypePrefixes.join(", ")}.`,
      }
    }
  }

  // THE TRANSPORT IS `direct_to_storage`, and that is the entire reason this
  // module exists: the browser PUTs to Supabase, so Vercel's 4.5 MB function
  // body cap is not in the path and must not be charged against this upload.
  // The bucket's own limit still applies and is what checkUpload returns here.
  const gate: UploadGateResult = checkUpload({
    bucket: spec.bucket,
    transport: "direct_to_storage",
    bytes: params.bytes,
    contentType: contentType || null,
  })
  if (!gate.ok) return { ok: false, reason: gate.reason, refusedBy: gate.refusedBy }

  return {
    ok: true,
    bucket: spec.bucket,
    objectPath: buildUploadObjectPath({
      purpose: params.purpose,
      identity: { brokerageId, userId },
      fileName: params.fileName,
      now: params.now,
    }),
    ceilingBytes: gate.ceilingBytes,
  }
}

// ─── THE MINT ───────────────────────────────────────────────────────────────

export type SignedUploadTicket = {
  ok: true
  bucket: string
  path: string
  token: string
  signedUrl: string
  ceilingBytes: number
}

/**
 * Mint the capability. Call ONLY after the caller's session has been resolved
 * server-side — `identity` must carry the session's brokerage, never a value
 * that arrived in the request.
 *
 * supabase-js RESOLVES refusals (CLAUDE.md §3), so the `{ data, error }` from
 * createSignedUploadUrl is destructured and the error is read. A mint that
 * failed must not return a half-built ticket the browser would PUT into.
 *
 * `upsert` is deliberately NOT exposed. Every ticket is non-upsert, which is
 * what turns a replay of a still-valid token into a duplicate refusal instead
 * of an overwrite of somebody's file.
 */
export async function mintSignedUpload(
  client: {
    storage: {
      from: (bucket: string) => {
        createSignedUploadUrl: (
          path: string,
        ) => Promise<{ data: { signedUrl: string; token: string; path: string } | null; error: { message: string } | null }>
      }
    }
  },
  params: {
    purpose: unknown
    identity: { brokerageId: string | null | undefined; userId: string | null | undefined }
    fileName: string
    contentType: string | null | undefined
    bytes: number | null | undefined
    now?: number
  },
): Promise<SignedUploadTicket | SignedUploadRefusal> {
  const plan = planSignedUpload(params)
  if (!plan.ok) return plan

  const { data, error } = await client.storage.from(plan.bucket).createSignedUploadUrl(plan.objectPath)
  if (error || !data?.token || !data?.signedUrl) {
    return {
      ok: false,
      refusedBy: "purpose",
      reason: error?.message ?? "Storage returned no signed upload URL for this path.",
    }
  }

  return {
    ok: true,
    bucket: plan.bucket,
    path: data.path ?? plan.objectPath,
    token: data.token,
    signedUrl: data.signedUrl,
    ceilingBytes: plan.ceilingBytes,
  }
}
