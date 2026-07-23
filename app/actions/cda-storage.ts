"use server"

// CDA template PDF upload — Supabase Storage (platform buckets), NOT Vercel Blob.
// The old flow uploaded the PDF through /api/blob/upload, whose allowedContentTypes
// list excluded application/pdf — so every CDA template upload failed with a blob
// error. CDA setup is a broker/admin task, so the upload is role-gated.

import { createClient } from "@/lib/supabase/server"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { uploadBufferToBucket } from "@/lib/storage/buckets"

const CDA_TEMPLATE_BUCKET = "cda-templates"

export async function uploadCdaTemplateFile(params: {
  base64: string
  mimeType: string
  fileName: string
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, error: "Unauthorized" }

  const { data: u } = await supabase
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Brokerage not found" }
  if (!isAdminOrBroker(u)) return { ok: false, error: "Forbidden — CDA templates are a broker/admin setting." }

  if (params.mimeType !== "application/pdf") {
    return { ok: false, error: "CDA templates must be PDF files." }
  }

  const safeName = (params.fileName || "template.pdf").replace(/[^\w.\-]+/g, "_").slice(0, 120)
  const path = `${u.brokerage_id}/${crypto.randomUUID()}-${safeName}`
  const buffer = Buffer.from(params.base64, "base64")

  return uploadBufferToBucket({
    bucket: CDA_TEMPLATE_BUCKET,
    path,
    buffer,
    contentType: "application/pdf",
    public: true, // a blank brokerage form; the field-reader fetches it by URL
  })
}
