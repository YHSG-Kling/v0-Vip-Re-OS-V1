/**
 * lib/documents/client-document-producer.ts
 *
 * The delivery half of the client-PDF engine: resolve the tenant brand
 * (brokerage color/name + agent attribution + license), render the spec to
 * real PDF bytes, host on Supabase storage (media-host rule — we own the
 * delivery URL), and record the piece in generated_documents so it shows in
 * the document library and is auditable.
 *
 * Producers call ONE function with a spec builder — the presentation builder
 * attaches the CMA leave-behind, the lead-magnet runner attaches the guide
 * booklet, and future document types ride the same line.
 */
import "server-only"
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import {
  renderClientPdf,
  type ClientPdfBrand,
  type ClientPdfSpec,
} from "./client-pdf"

/** Brokerage + agent → the brand block every client PDF carries. */
export async function resolvePdfBrand(
  svc: any,
  params: { brokerageId: string; agentUserId?: string | null },
): Promise<ClientPdfBrand> {
  let brokerageName = "Your Brokerage"
  let primaryColor: string | null = null
  let agentName: string | null = null
  let agentPhone: string | null = null
  let agentEmail: string | null = null
  let licenseLine: string | null = null
  try {
    const [{ data: b }, userRes] = await Promise.all([
      svc.from("brokerages").select("name, primary_color, license_number, license_state").eq("id", params.brokerageId).maybeSingle(),
      params.agentUserId
        ? svc.from("users").select("first_name, last_name, email, phone").eq("id", params.agentUserId).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    if (b?.name) brokerageName = String(b.name)
    primaryColor = b?.primary_color ?? null
    if (b?.license_number) licenseLine = `Brokerage Lic #${b.license_number}${b.license_state ? ` (${b.license_state})` : ""}`
    const u = (userRes as any)?.data
    if (u) {
      agentName = [u.first_name, u.last_name].filter(Boolean).join(" ") || null
      agentPhone = u.phone ?? null
      agentEmail = u.email ?? null
    }
    if (params.agentUserId) {
      const { data: ag } = await svc
        .from("agents").select("id").eq("user_id", params.agentUserId).maybeSingle()
      if (ag?.id) {
        const { data: lic } = await svc
          .from("agent_licenses").select("license_number, license_state")
          .eq("agent_id", ag.id).limit(1).maybeSingle()
        if (lic?.license_number) {
          licenseLine = `Lic #${lic.license_number}${lic.license_state ? ` (${lic.license_state})` : ""}`
        }
      }
    }
  } catch { /* defaults above keep the render valid */ }
  return { primaryColor, brokerageName, agentName, agentPhone, agentEmail, licenseLine, showEhoMark: true }
}

export interface ProducedDocument {
  ok: boolean
  documentId: string | null
  pdfUrl: string | null
  error: string | null
}

/** Render + host + record. Never throws — callers treat the PDF as best-effort garnish. */
export async function produceClientDocument(
  svc: any,
  params: {
    brokerageId: string
    agentUserId?: string | null
    contactId?: string | null
    listingId?: string | null
    documentType: "cma" | "net_sheet" | "buyer_guide" | "seller_guide" | "listing_presentation" | "listing_brochure"
    spec: ClientPdfSpec
    metadata?: Record<string, unknown>
  },
): Promise<ProducedDocument> {
  try {
    const bytes = await renderClientPdf(params.spec)
    const buf = Buffer.from(bytes)
    const fileName = `${params.documentType}-${Date.now()}.pdf`
    const pdfUrl = await hostRenderedMedia(svc, `client-docs/${params.brokerageId}/${fileName}`, buf, "application/pdf")

    const { data: doc } = await svc.from("generated_documents").insert({
      brokerage_id: params.brokerageId,
      agent_id: params.agentUserId ?? null,
      contact_id: params.contactId ?? null,
      listing_id: params.listingId ?? null,
      document_type: params.documentType,
      blob_url: pdfUrl,
      blob_id: `client-docs/${params.brokerageId}/${fileName}`,
      file_name: fileName,
      file_size: buf.length,
      metadata: { ...(params.metadata ?? {}), title: params.spec.title },
    }).select("id").single()

    return { ok: true, documentId: (doc as { id: string } | null)?.id ?? null, pdfUrl, error: null }
  } catch (e) {
    return { ok: false, documentId: null, pdfUrl: null, error: e instanceof Error ? e.message : String(e) }
  }
}
