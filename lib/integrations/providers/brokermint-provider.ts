/**
 * Brokermint Provider Implementation
 *
 * Wraps Brokermint's transaction-management API.
 * https://api.brokermint.com/v1 (api_key auth as a query param, REST + JSON).
 *
 * Credentials shape (platform_credentials row):
 *   api_key         — Brokermint API key.
 *   config.base_uri — Optional. Defaults to https://api.brokermint.com/v1.
 *
 * Brokermint is a transaction / back-office platform — it manages transactions,
 * documents, checklists and accounting, but does NOT provide e-signature itself
 * (brokerages pair it with a separate eSign provider). So sendForSignature /
 * getSignatureStatus return a clear capability error rather than pretending.
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
} from "./transaction-provider.interface"

const ESIGN_UNSUPPORTED =
  "Brokermint does not provide e-signature directly. Connect an eSign provider (DocuSign or Authentisign) for signing."

export class BrokermintProvider implements ITransactionProvider {
  readonly name = "brokermint"

  private apiKey:  string
  private baseUri: string

  constructor(credentials: { apiKey: string; profileId?: string; baseUri?: string }) {
    if (!credentials?.apiKey) throw new Error("Brokermint: api_key required")
    this.apiKey  = credentials.apiKey
    this.baseUri = (credentials.baseUri ?? "https://api.brokermint.com/v1").replace(/\/$/, "")
  }

  /** Brokermint authenticates via an api_key query param. */
  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${this.baseUri}${path}`)
    u.searchParams.set("api_key", this.apiKey)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Accept: "application/json" }
  }

  async createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse> {
    try {
      const res = await fetch(this.url("/transactions"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          address:        request.propertyAddress,
          status:         "active",
          transaction_type: request.transactionType === "purchase" ? "purchase" : "listing",
          price:          request.purchasePrice,
          closing_date:   request.estimatedCloseDate,
        }),
      })
      if (!res.ok) return { success: false, error: `Brokermint createTransaction ${res.status}: ${await res.text()}` }
      const data = await res.json()
      const id = data.id ?? data.transaction?.id
      if (!id) return { success: false, error: "Brokermint returned no transaction id" }
      return { success: true, externalTransactionId: String(id) }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Brokermint createTransaction failed" }
    }
  }

  async attachForms(request: AttachFormsRequest): Promise<AttachFormsResponse> {
    try {
      let attached = 0
      for (const form of request.forms) {
        if (!form.formUrl) continue
        const res = await fetch(this.url(`/transactions/${request.externalTransactionId}/documents`), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ name: form.formName, url: form.formUrl }),
        })
        if (res.ok) attached++
      }
      return { success: true, attachedCount: attached }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Brokermint attachForms failed" }
    }
  }

  async sendForSignature(_request: SendForSignatureRequest): Promise<SendForSignatureResponse> {
    return { success: false, error: ESIGN_UNSUPPORTED }
  }

  async getSignatureStatus(_externalTransactionId: string): Promise<SignatureStatusResponse> {
    return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: ESIGN_UNSUPPORTED }
  }

  async voidTransaction(request: VoidTransactionRequest): Promise<VoidTransactionResponse> {
    try {
      const res = await fetch(this.url(`/transactions/${request.externalTransactionId}`), {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({ status: "cancelled", cancellation_reason: request.reason ?? "Cancelled by agent" }),
      })
      if (!res.ok) return { success: false, error: `Brokermint void ${res.status}: ${await res.text()}` }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Brokermint voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const res = await fetch(this.url(`/transactions/${request.externalTransactionId}/documents`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ name: request.documentName, url: request.documentUrl, folder: request.folderName }),
      })
      if (!res.ok) return { success: false, error: `Brokermint upload ${res.status}: ${await res.text()}` }
      const data = await res.json()
      return { success: true, externalDocumentId: String(data.id ?? "") }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Brokermint uploadDocument failed" }
    }
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    try {
      const res = await fetch(this.url(`/transactions/${request.externalTransactionId}/documents`), {
        headers: this.headers(),
      })
      if (!res.ok) return { success: false, syncedCount: 0, documents: [], error: `Brokermint list ${res.status}` }
      const data = await res.json()
      const documents: ProviderDocument[] = (Array.isArray(data) ? data : data.documents ?? []).map((d: any) => ({
        externalDocumentId: String(d.id),
        documentName:       d.name,
        folderName:         d.folder ?? "Documents",
        isSigned:           Boolean(d.signed),
        url:                d.url ?? d.download_url,
        uploadedAt:         d.created_at,
        lastModified:       d.updated_at,
      }))
      return { success: true, documents, syncedCount: documents.length }
    } catch (err: any) {
      return { success: false, syncedCount: 0, documents: [], error: err?.message }
    }
  }

  async listForms(_request: ListFormsRequest): Promise<ListFormsResponse> {
    // Brokermint does not expose a state-association form library via API; forms
    // are managed as document templates per office. Return empty so the FormWizard
    // falls back to the brokerage's uploaded storage forms.
    return { success: true, forms: [] }
  }
}
