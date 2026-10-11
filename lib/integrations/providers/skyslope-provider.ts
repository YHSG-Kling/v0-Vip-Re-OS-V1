/**
 * SkySlope Provider Implementation
 *
 * Wraps SkySlope's transaction + signing API.
 * WAVE 140 (lane 140I) — CONTRACT VERIFIED (VENDOR_CONTRACTS.skyslope, 2026-10-11): the SkySlope
 * Partnership API (Files / Auth / Forms / Documents / Envelopes …) publishes its production server as
 * https://forms.skyslope.com/partner/api (OpenAPI spec servers; docs forms.skyslope.com/partner/api/docs;
 * token POST /ext/token). https://api.skyslope.com named no published spec — retired as the default.
 * Published paths match the ones below for files + documents (POST /files, /files/{id}/documents); the
 * spec names envelopes as POST /files/{id}/envelopes where this client still posts /signatures — the
 * envelope BODY shape is not in the spec excerpt, so that path is an open item, not a blind rename.
 *
 * Credentials shape (platform_credentials row):
 *   api_key     — SkySlope OAuth access token (Bearer).
 *   account_id  — SkySlope Office ID (the listing/sale belongs to an office).
 *   config.base_uri — Optional. Defaults to VENDOR_CONTRACTS.skyslope.baseUrl.
 *
 * Endpoint shape (SkySlope's file + DigiSign API):
 *   POST /files                                  → fileId      (transaction)
 *   POST /files/{fileId}/documents               (attach docs)
 *   POST /files/{fileId}/signatures              (send for signing)
 *   GET  /files/{fileId}                         (status / progress)
 *   PATCH /files/{fileId}                        (status=Cancelled to void)
 *   GET  /files/{fileId}/documents               (list/sync)
 */

import type {
  ITransactionProvider,
  CreateTransactionRequest,
  CreateTransactionResponse,
  AttachFormsRequest,
  AttachFormsResponse,
  SendForSignatureRequest,
  SendForSignatureResponse,
  SignatureStatusResponse,
  SyncDocumentsRequest,
  SyncDocumentsResponse,
  VoidTransactionRequest,
  VoidTransactionResponse,
  UploadDocumentRequest,
  UploadDocumentResponse,
  ProviderDocument,
  ListFormsRequest,
  ListFormsResponse,
  ProviderForm,
} from "./transaction-provider.interface"
import { mapProviderFormCategory } from "./transaction-provider.interface"
import { callConnector, type GatewayResponse } from "@/lib/agentic-os/connector-gateway"
import { VENDOR_CONTRACTS } from "@/lib/agentic-os/connector-registry"

export class SkyslopeProvider implements ITransactionProvider {
  readonly name = "skyslope"

  private accessToken: string
  private officeId:    string
  private baseUri:     string

  constructor(credentials: { apiKey: string; profileId: string; baseUri?: string }) {
    if (!credentials?.apiKey)    throw new Error("SkySlope: access token required (api_key)")
    if (!credentials?.profileId) throw new Error("SkySlope: office_id required (profileId)")
    this.accessToken = credentials.apiKey
    this.officeId    = credentials.profileId
    this.baseUri     = (credentials.baseUri ?? VENDOR_CONTRACTS.skyslope.baseUrl).replace(/\/$/, "")
  }

  /** Single egress choke point — every SkySlope API call leaves through the connector-gateway. */
  private request<T = any>(
    path: string,
    opts: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<GatewayResponse<T>> {
    return callConnector<T>({
      connector: "skyslope",
      baseUrl: this.baseUri,
      path,
      method: opts.method,
      body: opts.body,
      query: opts.query,
      auth: { style: "bearer", token: this.accessToken },
    })
  }

  async createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse> {
    try {
      const res = await this.request<{ fileId?: string; id?: string; file?: { id?: string } }>("/files", {
        method: "POST",
        body: {
          officeId:         this.officeId,
          fileType:         request.transactionType === "purchase" ? "Sale" : "Listing",
          propertyAddress:  request.propertyAddress,
          purchasePrice:    request.purchasePrice,
          estimatedCloseDate: request.estimatedCloseDate,
          status:           "Pending",
        },
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope createFile ${res.status}: ${res.error}` }
      }
      const data = res.data ?? {}
      const fileId = data.fileId ?? data.id ?? data.file?.id
      if (!fileId) {
        return { success: false, error: "SkySlope returned no fileId" }
      }
      return { success: true, externalTransactionId: String(fileId) }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope createTransaction failed" }
    }
  }

  async attachForms(request: AttachFormsRequest): Promise<AttachFormsResponse> {
    try {
      let attached = 0
      for (const form of request.forms) {
        if (!form.formUrl) continue
        const res = await this.request(`/files/${request.externalTransactionId}/documents`, {
          method: "POST",
          body: {
            name:         form.formName,
            source:       "url",
            sourceUrl:    form.formUrl,
            metadata:     form.formData ?? {},
          },
        })
        if (res.ok) attached++
      }
      return { success: true, attachedCount: attached }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope attachForms failed" }
    }
  }

  async sendForSignature(request: SendForSignatureRequest): Promise<SendForSignatureResponse> {
    try {
      // Placement fields per signer (when the wizard supplied anchor tags). anchorsForProvider
      // ("skyslope") shaped each as { kind, field, role }; group by canonical role.
      const { tabsByCanonicalRole } = await import("@/lib/forms/esign-anchor-adapters")
      const fieldsByRole = tabsByCanonicalRole((request.tags ?? []) as any)
      const res = await this.request(`/files/${request.externalTransactionId}/signatures`, {
        method: "POST",
        body: {
          documentId: request.documentId,
          signers: request.signers.map((s, i) => ({
            order: i + 1,
            email: s.email,
            name:  s.name,
            role:  s.role,
            ...(fieldsByRole[s.role] ? { fields: fieldsByRole[s.role] } : {}),
          })),
          message: request.message ?? "Please review and sign.",
        },
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope sendSignatures ${res.status}: ${res.error}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope sendForSignature failed" }
    }
  }

  async getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse> {
    try {
      const res = await this.request<{ signers?: any[]; signatures?: any[] }>(`/files/${externalTransactionId}/signatures`)
      if (!res.ok) {
        return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: `SkySlope status ${res.status}` }
      }
      const items: any[] = res.data?.signers ?? res.data?.signatures ?? []
      const total = items.length
      const signed = items.filter(s => (s.status ?? "").toString().toLowerCase() === "signed"
                                    || (s.status ?? "").toString().toLowerCase() === "completed").length
      return {
        success: true,
        total,
        signed,
        pending: total - signed,
        percentComplete: total > 0 ? Math.round((signed / total) * 100) : 0,
      }
    } catch (err: any) {
      return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: err?.message }
    }
  }

  async voidTransaction(request: VoidTransactionRequest): Promise<VoidTransactionResponse> {
    try {
      const res = await this.request(`/files/${request.externalTransactionId}`, {
        method: "PATCH",
        body: { status: "Cancelled", cancellationReason: request.reason ?? "Cancelled by agent" },
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope void ${res.status}: ${res.error}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const res = await this.request<{ documentId?: string; id?: string }>(`/files/${request.externalTransactionId}/documents`, {
        method: "POST",
        body: {
          name:      request.documentName,
          source:    "url",
          sourceUrl: request.documentUrl,
          folder:    request.folderName ?? "Documents",
        },
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope upload ${res.status}: ${res.error}` }
      }
      return { success: true, externalDocumentId: String(res.data?.documentId ?? res.data?.id ?? "") }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope uploadDocument failed" }
    }
  }

  async listForms(request: ListFormsRequest): Promise<ListFormsResponse> {
    try {
      // SkySlope's form library lives under /forms with state + category filters.
      const query: Record<string, string> = { officeId: this.officeId, limit: String(request.pageSize ?? 100) }
      if (request.stateCode) query.state = request.stateCode
      if (request.category)  query.category = request.category
      if (request.query)     query.q = request.query

      const res = await this.request<{ forms?: any[]; items?: any[] }>("/forms", { query })
      if (!res.ok) {
        return { success: false, error: `SkySlope listForms ${res.status}: ${res.error}` }
      }
      const items: any[] = res.data?.forms ?? res.data?.items ?? (Array.isArray(res.data) ? (res.data as any[]) : [])
      const forms: ProviderForm[] = items.map(f => ({
        formId:    String(f.formId ?? f.id),
        name:      f.name ?? f.title ?? "Form",
        issuer:    f.association ?? f.publisher,
        stateCode: f.state ?? f.stateCode,
        category:  mapSkyslopeCategory(f.category ?? f.type),
        version:   f.version,
        previewUrl: f.previewUrl ?? f.url,
      }))
      return { success: true, forms }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope listForms failed" }
    }
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    try {
      const res = await this.request<{ documents?: any[] }>(`/files/${request.externalTransactionId}/documents`)
      if (!res.ok) {
        return { success: false, syncedCount: 0, documents: [], error: `SkySlope list ${res.status}` }
      }
      const docList: any[] = res.data?.documents ?? (Array.isArray(res.data) ? (res.data as any[]) : [])
      const documents: ProviderDocument[] = docList.map((d: any) => ({
        externalDocumentId: String(d.id ?? d.documentId),
        documentName:       d.name,
        folderName:         d.folder ?? "Documents",
        isSigned:           Boolean(d.isSigned ?? d.signed),
        url:                d.url ?? d.downloadUrl,
        uploadedAt:         d.uploadedAt ?? d.createdAt,
        lastModified:       d.updatedAt,
      }))
      return { success: true, documents, syncedCount: documents.length }
    } catch (err: any) {
      return { success: false, syncedCount: 0, documents: [], error: err?.message }
    }
  }
}

// TOMBSTONE: local mapSkyslopeCategory merged onto
// transaction-provider.interface.ts mapProviderFormCategory (imported above)
// — §1/§6 SAME BODY census round 3, 2026-09-09.
const mapSkyslopeCategory = mapProviderFormCategory
