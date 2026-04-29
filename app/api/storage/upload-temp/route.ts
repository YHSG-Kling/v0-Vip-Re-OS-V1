/**
 * POST /api/storage/upload-temp
 * Uploads a file to Supabase Storage and returns a public URL.
 * Used for temporary agent asset uploads (D-ID photos, voice samples, etc.)
 *
 * Multipart form body:
 *   file: File (image or audio)
 *   bucket?: string  (default: "video-assets")
 *   folder?: string  (default: "temp")
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

const MAX_SIZE_MB = 50
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/x-m4a",
])

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const formData = await request.formData()
    const file = formData.get("file") as File | null
    const bucket = (formData.get("bucket") as string | null) ?? "video-assets"
    const folder = (formData.get("folder") as string | null) ?? "temp"

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json(
        { error: `File exceeds ${MAX_SIZE_MB}MB limit` },
        { status: 400 }
      )
    }

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}` },
        { status: 400 }
      )
    }

    const ext = file.name.split(".").pop() ?? "bin"
    const safeName = `${folder}/${auth.user!.id}/${Date.now()}.${ext}`

    const arrayBuffer = await file.arrayBuffer()
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(safeName, arrayBuffer, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      console.error("[upload-temp] Storage upload error:", uploadError)
      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(safeName)

    return NextResponse.json({ url: publicData.publicUrl, path: safeName })
  } catch (error: any) {
    console.error("[upload-temp] Error:", error)
    return NextResponse.json({ error: error.message ?? "Upload failed" }, { status: 500 })
  }
}
