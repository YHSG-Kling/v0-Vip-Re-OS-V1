/**
 * POST /api/workflow/buyer-intake/upload
 *
 * Token-authed file upload for the buyer self-serve intake flow.
 * Buyer's browser submits multipart/form-data with the file + their intake
 * token. We validate the token, store the bytes in the PRIVATE
 * `client-documents` Supabase bucket, and return a TIME-LIMITED signed URL.
 *
 * WAS: `put(…, { access: "public" })` to Vercel Blob. A driver's licence photo,
 * a pre-approval letter and a proof-of-funds letter are the buyer's financial
 * and identity paperwork — that shipped each one to a permanent,
 * unauthenticated URL with no TTL, no session and no RLS, handed straight back
 * to an unauthenticated browser holding only an intake token. It now goes to
 * the bucket that was already created private for exactly this class, and the
 * URL comes from the ONE issuer, which FAILS CLOSED: no signed URL → 502 and
 * the object is removed, never a public link.
 *
 * Files expected (one at a time):
 *   - DL photo (image/jpeg, image/png, image/webp) — max 8 MB
 *   - Pre-approval letter (application/pdf) — max 5 MB
 *   - POF letter (application/pdf) — max 5 MB
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { issueBucketObjectUrl } from "@/lib/storage/document-buckets"
import { removeOrRecordOrphan } from "@/lib/storage/put-and-sign"
import { DOCUMENT_BUCKET } from "@/lib/kernel/document-autofile"
import { checkUpload } from "@/lib/storage/file-limits"

const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic",
  "application/pdf",
])

export async function POST(req: NextRequest): Promise<NextResponse> {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
  }

  const token  = formData.get("token") as string | null
  const kind   = formData.get("kind")  as string | null    // 'dl' | 'pre_approval' | 'pof'
  const file   = formData.get("file")  as File | null

  if (!token || !kind || !file) {
    return NextResponse.json({ error: "token, kind, and file required" }, { status: 400 })
  }
  if (!["dl", "pre_approval", "pof"].includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 })
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: `Unsupported file type: ${file.type}` }, { status: 415 })
  }
  // "8 MB" was picked to match next.config.ts's serverActions.bodySizeLimit —
  // but this is a ROUTE HANDLER, not a Server Action, and neither number is what
  // a user meets: Vercel caps a function request body at 4.5 MB in front of both.
  // One ceiling, derived from the transport and the destination bucket.
  const gate = checkUpload({
    bucket: DOCUMENT_BUCKET,
    transport: "route_handler",
    bytes: file.size,
    contentType: file.type,
  })
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason }, { status: 413 })
  }

  // Validate token
  const svc = createServiceClient()
  const { data: tokenRow } = await svc
    .from("buyer_intake_tokens")
    .select("id, contact_id, status, expires_at")
    .eq("token", token)
    .maybeSingle()
  if (!tokenRow) return NextResponse.json({ error: "Invalid token" }, { status: 404 })
  if (tokenRow.status !== "pending") return NextResponse.json({ error: "Token already used" }, { status: 410 })
  if (new Date(tokenRow.expires_at) < new Date()) {
    await svc.from("buyer_intake_tokens").update({ status: "expired" }).eq("id", tokenRow.id)
    return NextResponse.json({ error: "Token expired" }, { status: 410 })
  }

  // Store in the PRIVATE client-documents bucket (never a public blob store).
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
  const slug = Math.random().toString(36).slice(2, 9)
  const path = `buyer-intake/${tokenRow.contact_id}/${kind}-${Date.now()}-${slug}.${ext}`

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    // supabase-js RESOLVES refusals (CLAUDE.md §3) — read the error.
    const { error: upErr } = await svc.storage
      .from(DOCUMENT_BUCKET)
      .upload(path, buffer, { contentType: file.type, upsert: false })
    if (upErr) {
      return NextResponse.json({ error: `Storage upload failed: ${upErr.message}` }, { status: 500 })
    }

    const issued = await issueBucketObjectUrl(svc as never, { bucket: DOCUMENT_BUCKET, objectPath: path })
    if (!issued.ok) {
      // FAIL CLOSED. No governed URL → undo the upload and refuse. Falling back
      // to a public URL here would undo the whole point of the private bucket.
      await removeOrRecordOrphan(svc as never, {
        bucket: DOCUMENT_BUCKET, objectPath: path,
        reason: "buyer_intake_sign_failed", detail: issued.reason,
      })
      return NextResponse.json({ error: issued.reason }, { status: 502 })
    }
    return NextResponse.json({ url: issued.url, kind })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
