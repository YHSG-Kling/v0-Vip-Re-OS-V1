/**
 * SkySlope Provider Implementation
 *
 * Wraps SkySlope's transaction + signing API.
 * https://api.skyslope.com (Bearer-token auth, REST + JSON).
 *
 * Credentials shape (platform_credentials row):
 *   api_key     — SkySlope OAuth access token (Bearer).
 *   account_id  — SkySlope Office ID (the listing/sale belongs to an office).
 *   config.base_uri — Optional. Defaults to https://api.skyslope.com.
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
    this.baseUri     = (credentials.baseUri ?? "https://api.skyslope.com").replace(/\/$/, "")
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extra,
    }
  }

  async createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse> {
    try {
      const res = await fetch(`${this.baseUri}/files`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          officeId:         this.officeId,
          fileType:         request.transactionType === "purchase" ? "Sale" : "Listing",
          propertyAddress:  request.propertyAddress,
          purchasePrice:    request.purchasePrice,
          estimatedCloseDate: request.estimatedCloseDate,
          status:           "Pending",
        }),
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope createFile ${res.status}: ${await res.text()}` }
      }
      const data = await res.json()
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
        const res = await fetch(`${this.baseUri}/files/${request.externalTransactionId}/documents`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            name:         form.formName,
            source:       "url",
            sourceUrl:    form.formUrl,
            metadata:     form.formData ?? {},
          }),
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
      const res = await fetch(`${this.baseUri}/files/${request.externalTransactionId}/signatures`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          documentId: request.documentId,
          signers: request.signers.map((s, i) => ({
            order: i + 1,
            email: s.email,
            name:  s.name,
            role:  s.role,
          })),
          message: request.message ?? "Please review and sign.",
        }),
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope sendSignatures ${res.status}: ${await res.text()}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope sendForSignature failed" }
    }
  }

  async getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse> {
    try {
      const res = await fetch(`${this.baseUri}/files/${externalTransactionId}/signatures`, {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: `SkySlope status ${res.status}` }
      }
      const data = await res.json()
      const items: any[] = data.signers ?? data.signatures ?? []
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
      const res = await fetch(`${this.baseUri}/files/${request.externalTransactionId}`, {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ status: "Cancelled", cancellationReason: request.reason ?? "Cancelled by agent" }),
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope void ${res.status}: ${await res.text()}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const res = await fetch(`${this.baseUri}/files/${request.externalTransactionId}/documents`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          name:      request.documentName,
          source:    "url",
          sourceUrl: request.documentUrl,
          folder:    request.folderName ?? "Documents",
        }),
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope upload ${res.status}: ${await res.text()}` }
      }
      const data = await res.json()
      return { success: true, externalDocumentId: String(data.documentId ?? data.id ?? "") }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "SkySlope uploadDocument failed" }
    }
  }

  async listForms(request: ListFormsRequest): Promise<ListFormsResponse> {
    try {
      // SkySlope's form library lives under /forms with state + category filters.
      const params = new URLSearchParams()
      if (request.stateCode) params.set("state",    request.stateCode)
      if (request.category)  params.set("category", request.category)
      if (request.query)     params.set("q",         request.query)
      params.set("officeId", this.officeId)
      params.set("limit",   String(request.pageSize ?? 100))

      const res = await fetch(`${this.baseUri}/forms?${params.toString()}`, {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, error: `SkySlope listForms ${res.status}: ${await res.text()}` }
      }
      const data = await res.json()
      const items: any[] = data.forms ?? data.items ?? data ?? []
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
      const res = await fetch(`${this.baseUri}/files/${request.externalTransactionId}/documents`, {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, syncedCount: 0, documents: [], error: `SkySlope list ${res.status}` }
      }
      const data = await res.json()
      const documents: ProviderDocument[] = (data.documents ?? data ?? []).map((d: any) => ({
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

function mapSkyslopeCategory(c: string | undefined): ProviderForm["category"] {
  const s = (c ?? "").toString().toLowerCase()
  if (s.includes("listing"))    return "listing"
  if (s.includes("purchase") || s.includes("offer")) return "offer"
  if (s.includes("addendum"))   return "addendum"
  if (s.includes("disclosure")) return "disclosure"
  if (s.includes("agency"))     return "agency"
  return "other"
}
