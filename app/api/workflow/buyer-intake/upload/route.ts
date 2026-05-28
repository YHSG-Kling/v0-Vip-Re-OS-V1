/**
 * POST /api/workflow/buyer-intake/upload
 *
 * Token-authed file upload for the buyer self-serve intake flow.
 * Buyer's browser submits multipart/form-data with the file + their intake
 * token. We validate the token, upload to Vercel Blob server-side, and
 * return the public URL.
 *
 * Files expected (one at a time):
 *   - DL photo (image/jpeg, image/png, image/webp) — max 8 MB
 *   - Pre-approval letter (application/pdf) — max 5 MB
 *   - POF letter (application/pdf) — max 5 MB
 */

import { NextRequest, NextResponse } from "next/server"
import { put } from "@vercel/blob"
import { createServiceClient } from "@/lib/supabase/service"

const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic",
  "application/pdf",
])
const MAX_BYTES = 8 * 1024 * 1024  // 8 MB

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
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File exceeds 8MB limit" }, { status: 413 })
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

  // Upload to Vercel Blob
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
  const slug = Math.random().toString(36).slice(2, 9)
  const path = `buyer-intake/${tokenRow.contact_id}/${kind}-${Date.now()}-${slug}.${ext}`

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const blob = await put(path, buffer, {
      access: "public",
      contentType: file.type,
    })
    return NextResponse.json({ url: blob.url, kind })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
