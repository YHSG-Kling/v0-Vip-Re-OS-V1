/**
 * Form Simplicity Provider Implementation
 *
 * Wraps Form Simplicity's transaction + forms API (Florida Realtors' platform;
 * also widely licensed by other state associations). Bearer-token auth, REST+JSON.
 * Form Simplicity's core strength is its state-association FORM LIBRARY, and it
 * provides e-signature via its Authentisign integration.
 *
 * Credentials shape (platform_credentials row):
 *   api_key         — Form Simplicity API token (Bearer).
 *   account_id      — Member / account id (passed as accountId, optional).
 *   config.base_uri — Required for production; the partner API host is provisioned
 *                     per integration. Defaults to https://api.formsimplicity.com/v1.
 *
 * Endpoint paths follow Form Simplicity's conventional REST shape; base_uri is
 * configurable so the exact partner host/version is set at connect time.
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

export class FormSimplicityProvider implements ITransactionProvider {
  readonly name = "formsimplicity"

  private accessToken: string
  private accountId:   string | undefined
  private baseUri:     string

  constructor(credentials: { apiKey: string; profileId?: string; baseUri?: string }) {
    if (!credentials?.apiKey) throw new Error("Form Simplicity: api_key (Bearer token) required")
    this.accessToken = credentials.apiKey
    this.accountId   = credentials.profileId
    this.baseUri     = (credentials.baseUri ?? "https://api.formsimplicity.com/v1").replace(/\/$/, "")
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    }
  }

  async createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse> {
    try {
      const res = await fetch(`${this.baseUri}/transactions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          accountId:       this.accountId,
          propertyAddress: request.propertyAddress,
          transactionType: request.transactionType === "purchase" ? "purchase" : "listing",
          price:           request.purchasePrice,
          closingDate:     request.estimatedCloseDate,
        }),
      })
      if (!res.ok) return { success: false, error: `FormSimplicity createTransaction ${res.status}: ${await res.text()}` }
      const data = await res.json()
      const id = data.id ?? data.transactionId
      if (!id) return { success: false, error: "FormSimplicity returned no transaction id" }
      return { success: true, externalTransactionId: String(id) }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity createTransaction failed" }
    }
  }

  async attachForms(request: AttachFormsRequest): Promise<AttachFormsResponse> {
    try {
      let attached = 0
      for (const form of request.forms) {
        const res = await fetch(`${this.baseUri}/transactions/${request.externalTransactionId}/forms`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ formId: form.formName, formUrl: form.formUrl, data: form.formData ?? {} }),
        })
        if (res.ok) attached++
      }
      return { success: true, attachedCount: attached }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity attachForms failed" }
    }
  }

  async sendForSignature(request: SendForSignatureRequest): Promise<SendForSignatureResponse> {
    try {
      const res = await fetch(`${this.baseUri}/transactions/${request.externalTransactionId}/signature-requests`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          documentId: request.documentId,
          signers: request.signers.map((s, i) => ({ order: i + 1, email: s.email, name: s.name, role: s.role })),
          message: request.message ?? "Please review and sign.",
        }),
      })
      if (!res.ok) return { success: false, error: `FormSimplicity sendForSignature ${res.status}: ${await res.text()}` }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity sendForSignature failed" }
    }
  }

  async getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse> {
    try {
      const res = await fetch(`${this.baseUri}/transactions/${externalTransactionId}/signature-requests`, {
        headers: this.headers(),
      })
      if (!res.ok) return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: `FormSimplicity status ${res.status}` }
      const data = await res.json()
      const items: any[] = data.signers ?? data.signatures ?? []
      const total = items.length
      const signed = items.filter((s) => ["signed", "completed"].includes((s.status ?? "").toString().toLowerCase())).length
      return { success: true, total, signed, pending: total - signed, percentComplete: total > 0 ? Math.round((signed / total) * 100) : 0 }
    } catch (err: any) {
      return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: err?.message }
    }
  }

  async voidTransaction(request: VoidTransactionRequest): Promise<VoidTransactionResponse> {
    try {
      const res = await fetch(`${this.baseUri}/transactions/${request.externalTransactionId}`, {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ status: "cancelled", reason: request.reason ?? "Cancelled by agent" }),
      })
      if (!res.ok) return { success: false, error: `FormSimplicity void ${res.status}: ${await res.text()}` }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const res = await fetch(`${this.baseUri}/transactions/${request.externalTransactionId}/documents`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ name: request.documentName, url: request.documentUrl, folder: request.folderName ?? "Documents" }),
      })
      if (!res.ok) return { success: false, error: `FormSimplicity upload ${res.status}: ${await res.text()}` }
      const data = await res.json()
      return { success: true, externalDocumentId: String(data.id ?? data.documentId ?? "") }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity uploadDocument failed" }
    }
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    try {
      const res = await fetch(`${this.baseUri}/transactions/${request.externalTransactionId}/documents`, {
        headers: this.headers(),
      })
      if (!res.ok) return { success: false, syncedCount: 0, documents: [], error: `FormSimplicity list ${res.status}` }
      const data = await res.json()
      const documents: ProviderDocument[] = (data.documents ?? data ?? []).map((d: any) => ({
        externalDocumentId: String(d.id ?? d.documentId),
        documentName:       d.name,
        folderName:         d.folder ?? "Documents",
        isSigned:           Boolean(d.signed ?? d.isSigned),
        url:                d.url ?? d.downloadUrl,
        uploadedAt:         d.createdAt,
        lastModified:       d.updatedAt,
      }))
      return { success: true, documents, syncedCount: documents.length }
    } catch (err: any) {
      return { success: false, syncedCount: 0, documents: [], error: err?.message }
    }
  }

  async listForms(request: ListFormsRequest): Promise<ListFormsResponse> {
    try {
      const params = new URLSearchParams()
      if (request.stateCode) params.set("state", request.stateCode)
      if (request.category)  params.set("category", request.category)
      if (request.query)     params.set("q", request.query)
      if (this.accountId)    params.set("accountId", this.accountId)
      params.set("limit", String(request.pageSize ?? 100))

      const res = await fetch(`${this.baseUri}/forms?${params.toString()}`, { headers: this.headers() })
      if (!res.ok) return { success: false, error: `FormSimplicity listForms ${res.status}: ${await res.text()}` }
      const data = await res.json()
      const items: any[] = data.forms ?? data.items ?? data ?? []
      const forms: ProviderForm[] = items.map((f) => ({
        formId:     String(f.formId ?? f.id),
        name:       f.name ?? f.title ?? "Form",
        issuer:     f.association ?? f.publisher,
        stateCode:  f.state ?? f.stateCode,
        category:   mapCategory(f.category ?? f.type),
        version:    f.version,
        previewUrl: f.previewUrl ?? f.url,
      }))
      return { success: true, forms }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity listForms failed" }
    }
  }
}

function mapCategory(c: string | undefined): ProviderForm["category"] {
  const s = (c ?? "").toString().toLowerCase()
  if (s.includes("listing")) return "listing"
  if (s.includes("purchase") || s.includes("offer")) return "offer"
  if (s.includes("addendum")) return "addendum"
  if (s.includes("disclosure")) return "disclosure"
  if (s.includes("agency")) return "agency"
  return "other"
}
