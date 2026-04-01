import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

/**
 * GET /api/external-portal/documents/download
 * Downloads a document for an external partner
 * Verifies partner access via partnerId and document ownership
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const docId = searchParams.get("docId")
    const partnerId = searchParams.get("partnerId")
    const partnerType = searchParams.get("partnerType")

    if (!docId || !partnerId || !partnerType) {
      return NextResponse.json(
        { success: false, error: "Missing required parameters: docId, partnerId, partnerType" },
        { status: 400 }
      )
    }

    if (!["vendor", "lender", "title"].includes(partnerType)) {
      return NextResponse.json(
        { success: false, error: "Invalid partnerType" },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    // Verify document exists and belongs to this partner
    const { data: document, error: docError } = await supabase
      .from("documents")
      .select("id, name, file_url, partner_id, partner_type, transaction_id, created_at")
      .eq("id", docId)
      .eq("partner_id", partnerId)
      .eq("partner_type", partnerType)
      .single()

    if (docError || !document) {
      console.error("[v0] Document not found or access denied:", docError)
      return NextResponse.json(
        { success: false, error: "Document not found or access denied" },
        { status: 404 }
      )
    }

    // Log download for audit trail
    await supabase.from("document_downloads").insert({
      document_id: docId,
      partner_id: partnerId,
      partner_type: partnerType,
      downloaded_at: new Date().toISOString(),
    })

    // Return document download link or direct download if file_url is accessible
    if (!document.file_url) {
      return NextResponse.json(
        { success: false, error: "Document file URL not available" },
        { status: 404 }
      )
    }

    // Redirect to the file URL or return it for client-side download
    return NextResponse.json({
      success: true,
      document: {
        id: document.id,
        name: document.name,
        fileUrl: document.file_url,
        downloadedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error("[v0] Error downloading document:", error)
    return NextResponse.json(
      { success: false, error: "Failed to download document" },
      { status: 500 }
    )
  }
}
