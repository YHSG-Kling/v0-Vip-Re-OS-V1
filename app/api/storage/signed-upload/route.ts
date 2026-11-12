// app/api/storage/signed-upload/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PLACE A BROWSER IS HANDED PERMISSION TO WRITE TO STORAGE.
//
// SURVIVOR of app/api/blob/upload/route.ts, which was deleted when the owner
// ruled that all file storage lives in Supabase buckets. The mechanics and the
// citations live in lib/storage/signed-upload-url.ts; this file is only the
// session gate in front of them.
//
// WHAT THIS RETURNS IS A CAPABILITY, not data — a token that lets whoever holds
// it write one object for the next two hours. So the order here matters and is
// the pattern named at lib/kernel/manager-registry.ts: RESOLVE THE SESSION
// FIRST, then use the service client. The tenant prefix is built from what the
// session says, and this handler never reads a path, a bucket or a brokerage id
// out of the request body — the body carries a PURPOSE, a filename and a size,
// and nothing else is trusted.
//
// The deleted route did the opposite: it checked that a session existed and
// then signed whatever pathname the browser asked for, which let any signed-in
// user write any other tenant's object. See the tombstone in
// lib/storage/signed-upload-url.ts for the three call sites that exploited it
// by accident.
//
// NOT A DUPLICATE OF app/api/storage/upload-temp/route.ts, though they sit in
// the same folder and both end in a Supabase object. That route takes the FILE
// ITSELF through the function (`transport: "route_handler"`), so it is bounded
// by Vercel's 4.5 MB body cap and is the right door for small agent media — a
// D-ID photo, a voice sample. This route never touches the bytes at all; it
// hands out permission and the browser uploads directly, which is the only
// shape that works above 4.5 MB. Merging them would silently reimpose the cap
// on the large uploads, which is the exact defect this migration exists to
// avoid.

import { type NextRequest, NextResponse } from "next/server"
import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"
import {
  mintSignedUpload,
  type SignedUploadRefusal,
  type SignedUploadTicket,
  type SignedUploadWireResponse,
} from "@/lib/storage/signed-upload-url"
import { issueBucketObjectUrl } from "@/lib/storage/document-buckets"

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 })
  }

  // ── GATE FIRST ────────────────────────────────────────────────────────────
  // resolveWriteContextForTenant() with no argument resolves the tenant from
  // the SESSION. FAIL CLOSED: if it cannot resolve, nothing is minted.
  // A read-only impersonation grant is refused HERE by virtue of being refused
  // upstream: resolveWriteContext turns a 'read_only' grant into ok:false with
  // READ_ONLY_ACTING_ERROR, so support staff walking an account cannot deposit
  // files in the tenant they are inspecting. That refusal deliberately lives in
  // the one seam (lib/platform/acting-context.ts) rather than being re-checked
  // here — a second copy of the rule is how the kernel's duplicate came to miss
  // it entirely, which is the defect that seam's header documents.
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) {
    return NextResponse.json({ error: ctx.error || "Unauthorized" }, { status: 401 })
  }

  // ── THEN THE SERVICE CLIENT ───────────────────────────────────────────────
  // ANNOTATED, not inferred. This route is the only consumer of the mint's
  // return union, and it BRANCHES on it — `ticket.ok` picks between issuing a
  // capability and refusing with a status code. Naming the union here pins that
  // contract at the call site: widen or re-shape mintSignedUpload's return and
  // the break lands in the file that branches on it, rather than being absorbed
  // by inference and changing which arm runs.
  const ticket: SignedUploadTicket | SignedUploadRefusal = await mintSignedUpload(createServiceClient() as never, {
    purpose: body.purpose,
    identity: { brokerageId: ctx.brokerageId, userId: ctx.userId },
    fileName: typeof body.fileName === "string" ? body.fileName : "",
    contentType: typeof body.contentType === "string" ? body.contentType : null,
    bytes: typeof body.bytes === "number" ? body.bytes : null,
  })

  if (!ticket.ok) {
    // 413 for a size refusal so the browser can tell "too big" from "not
    // allowed"; 400 for everything else.
    const status = ticket.refusedBy === "size" ? 413 : ticket.refusedBy === "identity" ? 403 : 400
    return NextResponse.json({ error: ticket.reason, refusedBy: ticket.refusedBy }, { status })
  }

  // THE URL IS DECIDED HERE, not in the browser. issueBucketObjectUrl is the one
  // place that knows whether a bucket may serve a permanent unauthenticated URL
  // or must be signed (lib/storage/document-buckets.ts), and it can only answer
  // that where the bucket is a known literal — which is here, and is not the
  // browser. Every purpose currently targets a public-media bucket, so this
  // returns a permanent URL; a purpose pointed at a document-class bucket would
  // be signed instead, without the client changing.
  //
  // getPublicUrl is pure string construction, so minting the URL BEFORE the
  // bytes land is correct rather than premature.
  const issued = await issueBucketObjectUrl(createServiceClient() as never, {
    bucket: ticket.bucket,
    objectPath: ticket.path,
  })
  if (!issued.ok) {
    // FAIL CLOSED: no URL, no capability. Handing out an upload token whose
    // result we could not address would strand the bytes with nothing pointing
    // at them — the orphan shape lib/storage/put-and-sign.ts exists to avoid.
    return NextResponse.json({ error: issued.reason }, { status: 502 })
  }

  // TYPED, not an anonymous literal. SignedUploadWireResponse is the ONE
  // declaration of this shape and lib/storage/browser-upload.ts parses against
  // the same type, so dropping or renaming a field here fails the build on both
  // halves instead of leaving the browser reading `undefined` at runtime.
  const wire: SignedUploadWireResponse = {
    bucket: ticket.bucket,
    path: ticket.path,
    token: ticket.token,
    url: issued.url,
    ceilingBytes: ticket.ceilingBytes,
  }
  return NextResponse.json(wire)
}
