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

/** Parse image width/height from raw header bytes — no external deps */
function parseImageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | null {
  try {
    const view = new DataView(bytes.buffer)
    if (mimeType === "image/png") {
      // PNG: signature 8 bytes, IHDR chunk: 4 len + 4 type + 4 width + 4 height
      if (bytes.length < 24) return null
      const w = view.getUint32(16, false)
      const h = view.getUint32(20, false)
      return { width: w, height: h }
    }
    if (mimeType === "image/jpeg") {
      // JPEG: scan SOF markers (0xFFC0..0xFFC3) for height/width
      let i = 0
      if (view.getUint16(0) !== 0xFFD8) return null
      i = 2
      while (i < bytes.length - 8) {
        const marker = view.getUint16(i)
        const len = view.getUint16(i + 2)
        if ((marker & 0xFFF0) === 0xFFC0 && marker !== 0xFFC4 && marker !== 0xFFC8) {
          const h = view.getUint16(i + 5)
          const w = view.getUint16(i + 7)
          return { width: w, height: h }
        }
        i += 2 + len
      }
    }
  } catch {
    // ignore parse errors
  }
  return null
}

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

    // Photo quality validation (when validate_photo=true in form data)
    const warnings: string[] = []
    const validatePhoto = formData.get("validate_photo") === "true"
    if (validatePhoto && (file.type === "image/jpeg" || file.type === "image/png")) {
      const MIN_SIZE_BYTES = 30 * 1024 // 30 KB

      if (file.size < MIN_SIZE_BYTES) {
        warnings.push("Photo file size is very small (< 30 KB). For best D-ID results, use a higher-quality image.")
      }

      const dims = parseImageDimensions(new Uint8Array(arrayBuffer), file.type)
      if (dims) {
        if (dims.width < 400 || dims.height < 400) {
          warnings.push(`Photo dimensions (${dims.width}×${dims.height}) are below the recommended 400×400 minimum for D-ID avatar quality.`)
        }
      }
    }

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

    return NextResponse.json({ url: publicData.publicUrl, path: safeName, warnings })
  } catch (error: any) {
    console.error("[upload-temp] Error:", error)
    return NextResponse.json({ error: error.message ?? "Upload failed" }, { status: 500 })
  }
}
