"use server"

/**
 * Vendor W-9 capture (owner round 43).
 *
 * uploadVendorW9Action — the VENDOR (portal actor, requireVendorActor gate)
 * uploads their signed W-9 PDF through the EXISTING client-documents rail
 * (storage bucket 'client-documents' + a client_documents row — the same
 * bucket/table every portal document upload rides; never a new storage
 * path), then upserts the structured basics onto vendor_tax_documents
 * (migration m275): legal name, W-9 line-3 business type, TIN TYPE only
 * (EIN vs SSN — the TIN itself is NEVER accepted or stored; it exists only
 * inside the PDF, which sits in the non-public tenant bucket), signature
 * date, and a vendors.name snapshot for honest expiry derivation.
 *
 * getMyVendorW9Action — the portal read (derived, never-stale status).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireVendorActor } from "@/lib/kernel/portal-auth"
import {
  readVendorW9,
  W9_BUSINESS_TYPES,
  W9_TIN_TYPES,
  type VendorW9Read,
  type W9BusinessType,
  type W9TinType,
} from "@/lib/vendors/w9"

const MAX_W9_BYTES = 10 * 1024 * 1024 // matches the client-documents bucket limit
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/jpg"])

export interface UploadVendorW9Input {
  vendorId: string
  file: { name: string; type: string; base64: string }
  legalName: string
  businessType: W9BusinessType
  tinType: W9TinType
  signatureDate: string // yyyy-mm-dd
}

export interface UploadVendorW9Result {
  success: boolean
  status?: "on_file"
  error?: string
}

export async function uploadVendorW9Action(input: UploadVendorW9Input): Promise<UploadVendorW9Result> {
  // Portal gate — the caller must BE this vendor (user_role_assignments).
  let actor
  try {
    actor = await requireVendorActor(input.vendorId)
  } catch {
    return { success: false, error: "Unauthorized" }
  }

  // Validate the structured basics — NOTE: there is deliberately no TIN field
  // anywhere in this input; only the tin TYPE is captured.
  const legalName = (input.legalName ?? "").trim()
  if (!legalName) return { success: false, error: "Enter the legal name exactly as on the W-9 (line 1)" }
  if (!W9_BUSINESS_TYPES.includes(input.businessType)) {
    return { success: false, error: "Pick the federal tax classification (W-9 line 3)" }
  }
  if (!W9_TIN_TYPES.includes(input.tinType)) {
    return { success: false, error: "Pick which TIN the W-9 certifies (EIN or SSN)" }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.signatureDate ?? "")) {
    return { success: false, error: "Enter the signature date from Part II" }
  }
  if (!input.file?.base64) return { success: false, error: "Attach the signed W-9 file" }
  if (!ALLOWED_MIME.has(input.file.type)) {
    return { success: false, error: "Upload the W-9 as a PDF (or a photo/scan image)" }
  }
  const fileBuffer = Buffer.from(input.file.base64, "base64")
  if (fileBuffer.length === 0) return { success: false, error: "The uploaded file is empty" }
  if (fileBuffer.length > MAX_W9_BYTES) return { success: false, error: "File too large (10MB max)" }

  const supabase = await createClient()
  const svc = createServiceClient()

  // ── EXISTING doc rail: client-documents bucket (round-28 storage rail) ──────
  const safeName = (input.file.name || "w9.pdf").replace(/[^\w.\-]+/g, "_")
  const filePath = `vendors/${actor.vendorId}/w9/${Date.now()}_${safeName}`
  const { error: uploadError } = await supabase.storage
    .from("client-documents")
    .upload(filePath, fileBuffer, { contentType: input.file.type, upsert: false })
  if (uploadError) {
    return { success: false, error: `Upload failed: ${uploadError.message}` }
  }
  const { data: pub } = supabase.storage.from("client-documents").getPublicUrl(filePath)
  const documentUrl = pub.publicUrl

  // The client_documents row — same table the vendor documents surface already
  // reads (fetchVendorAgreements matches uploaded_by = vendor user).
  const { data: docRow, error: docErr } = await svc
    .from("client_documents")
    .insert({
      brokerage_id: actor.brokerageId,
      document_name: `W-9 — ${legalName}`,
      document_url: documentUrl,
      document_type: "vendor_w9",
      doc_category: "other",
      uploaded_by: actor.userId,
    })
    .select("id")
    .maybeSingle()
  if (docErr) {
    return { success: false, error: `Could not record the document: ${docErr.message}` }
  }

  // Snapshot the vendor's current legal identity for expiry derivation.
  const { data: vendor } = await svc
    .from("vendors").select("name").eq("id", actor.vendorId).maybeSingle()

  const nowIso = new Date().toISOString()
  const { error: upsertErr } = await svc
    .from("vendor_tax_documents")
    .upsert({
      vendor_id: actor.vendorId,
      brokerage_id: actor.brokerageId,
      client_document_id: docRow?.id ?? null,
      document_url: documentUrl,
      legal_name: legalName,
      business_type: input.businessType,
      tin_type: input.tinType,
      signature_date: input.signatureDate,
      vendor_name_at_filing: vendor?.name ?? null,
      status: "on_file",
      updated_at: nowIso,
    }, { onConflict: "vendor_id" })
  if (upsertErr) {
    return /vendor_tax_documents/.test(upsertErr.message ?? "")
      ? { success: false, error: "W-9 capture requires database migration m275 (vendor_tax_documents) — ask your administrator to apply it." }
      : { success: false, error: upsertErr.message }
  }

  return { success: true, status: "on_file" }
}

/** Portal read — the vendor's own W-9 posture (derived status, never stale). */
export async function getMyVendorW9Action(vendorId: string): Promise<VendorW9Read | { error: string }> {
  try {
    const actor = await requireVendorActor(vendorId)
    return await readVendorW9(createServiceClient(), actor.vendorId)
  } catch {
    return { error: "Unauthorized" }
  }
}
