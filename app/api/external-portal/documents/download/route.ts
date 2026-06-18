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

    // documents has no name/file_url/partner_id/partner_type columns. Real cols are
    // document_type/storage_url; partner access is scoped via the document's transaction
    // membership (title_company_users / lender_portal_users), NOT a column on documents.
    const { data: document, error: docError } = await supabase
      .from("documents")
      .select("id, document_type, storage_url, transaction_id, created_at")
      .eq("id", docId)
      .single()

    if (docError || !document) {
      console.error("[v0] Document not found:", docError)
      return NextResponse.json(
        { success: false, error: "Document not found or access denied" },
        { status: 404 }
      )
    }

    // Partner scoping: confirm this partner is attached to the document's transaction.
    const partnerTable =
      partnerType === "lender" ? "lender_portal_users" :
      partnerType === "title"  ? "title_company_users" : null
    if (!document.transaction_id || !partnerTable) {
      // vendor downloads are not modeled via documents.transaction_id — deny by default.
      return NextResponse.json(
        { success: false, error: "Document not found or access denied" },
        { status: 404 }
      )
    }
    const { data: access } = await supabase
      .from(partnerTable)
      .select("id")
      .eq("user_id", partnerId)
      .eq("transaction_id", document.transaction_id)
      .maybeSingle()
    if (!access) {
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

    if (!document.storage_url) {
      return NextResponse.json(
        { success: false, error: "Document file URL not available" },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      document: {
        id: document.id,
        name: document.document_type,
        fileUrl: document.storage_url,
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
