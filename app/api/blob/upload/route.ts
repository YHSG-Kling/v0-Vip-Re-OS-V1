import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { createClient } from "@/lib/supabase/server"
import { type NextRequest, NextResponse } from "next/server"

/**
 * Vercel Blob client-side upload handler.
 * Called by @vercel/blob/client `upload()` during the two-step handshake.
 * Auth: user must be authenticated (checked via Supabase session).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    // Auth gate — require a valid Supabase session
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => ({
        allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime"],
        maximumSizeInBytes: 50 * 1024 * 1024, // 50 MB
        tokenPayload: JSON.stringify({ userId: user.id, pathname }),
      }),
      onUploadCompleted: async ({ blob }) => {
        // Optional: log upload to DB or trigger downstream jobs
        console.log("[blob/upload] Upload completed:", blob.pathname)
      },
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    console.error("[blob/upload] Error:", error)
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
