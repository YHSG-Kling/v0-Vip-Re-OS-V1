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
 *
 * ── THE BUCKET IS NAMED, DELIBERATELY (was: whatever the default happened to be) ──
 * This line used to read
 *
 *     hostRenderedMedia(svc, `client-docs/…`, buf, "application/pdf")
 *
 * and took hostRenderedMedia's DEFAULT bucket — `video-assets`, which is on the
 * PUBLIC_MEDIA_BUCKETS allowlist. issueBucketObjectUrl therefore did the correct
 * thing for the bucket it was given and returned a PERMANENT UNAUTHENTICATED
 * URL: a bearer capability with no session, no RLS and no expiry, persisted onto
 * generated_documents.blob_url and mailed into notifications. A CMA carries a
 * named client's valuation, a net sheet carries a seller's proceeds (§5:
 * contacts see no financials but their own), a recruiting pitch carries the
 * brokerage's terms. Those are documents, and lib/storage/document-buckets.ts
 * says in its own words that a permanent public URL is never correct for one.
 *
 * The fix is the bucket, not a second URL mechanism: GENERATED_DOCUMENT_BUCKET
 * is document-class, so the SAME issuer now signs instead of publishing. The
 * stored URL stays a working URL — signed at DOC_URL_TTL_SECONDS because every
 * reader persists it (the library anchor, notification bodies, the lead-magnet
 * email) — which is the bridge lib/storage/signed-doc-url.ts documents.
 */
import "server-only"
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import { GENERATED_DOCUMENT_BUCKET } from "@/lib/storage/document-buckets"
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
    documentType: "cma" | "net_sheet" | "buyer_guide" | "seller_guide" | "listing_presentation" | "listing_brochure" | "listing_packet" | "recruiting_pitch"
    spec: ClientPdfSpec
    metadata?: Record<string, unknown>
  },
): Promise<ProducedDocument> {
  try {
    const bytes = await renderClientPdf(params.spec)
    const buf = Buffer.from(bytes)
    const fileName = `${params.documentType}-${Date.now()}.pdf`
    // ONE spelling of the object key (§6). It was the upload path AND the
    // `blob_id` recorded on the row; blob_id is gone (tombstone below, no reader),
    // so the path now lives in exactly one place — inside the URL the issuer
    // returns — and there is nothing left for it to drift against.
    const objectPath = `client-docs/${params.brokerageId}/${fileName}`
    const pdfUrl = await hostRenderedMedia(svc, objectPath, buf, "application/pdf", GENERATED_DOCUMENT_BUCKET)

    // generated_documents.agent_id is agents-class. This used to file the USERS id,
    // which the FK rejected — so every client PDF this produced was hosted and then
    // lost its ledger row, and the document never appeared in the agent's library.
    let docAgentId: string | null = null
    if (params.agentUserId) {
      const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
      docAgentId = await resolveUserIdToAgentRecord(params.agentUserId, params.brokerageId)
    }

    // `agent_id` IS NOT WRITE-ONLY — it is the LIBRARY'S SCOPE PREDICATE.
    // app/actions/generated-documents.ts:getGeneratedDocumentLibrary narrows a
    // non-elevated seat with `q = q.eq("agent_id", ctx.agentId)` — applied to a
    // reassigned query BUILDER inside an `if`, not inside the `.from(…)` chain,
    // which is why the opposite-missing census cannot see the term and reports
    // the column as read by nobody. Deleting it would hand every agent the whole
    // brokerage's client PDFs (§4). Nothing to build and nothing to delete (§1).
    const { data: doc } = await svc.from("generated_documents").insert({
      brokerage_id: params.brokerageId,
      agent_id: docAgentId,
      contact_id: params.contactId ?? null,
      listing_id: params.listingId ?? null,
      document_type: params.documentType,
      blob_url: pdfUrl,
      // TOMBSTONE (§1.1, w26 lane C8): `blob_id` DELETED from this insert — the second
      // of its two writers. SURVIVOR: `blob_url` on the same row, read by
      // app/actions/generated-documents.ts:65. It held the storage object PATH and no
      // reader ever selected it. Full reasoning at the sibling tombstone,
      // lib/kernel/appraiser-packet.ts.
      file_name: fileName,
      file_size: buf.length,
      metadata: { ...(params.metadata ?? {}), title: params.spec.title },
    }).select("id").single()

    return { ok: true, documentId: (doc as { id: string } | null)?.id ?? null, pdfUrl, error: null }
  } catch (e) {
    return { ok: false, documentId: null, pdfUrl: null, error: e instanceof Error ? e.message : String(e) }
  }
}
