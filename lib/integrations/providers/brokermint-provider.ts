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
import { callConnector, type GatewayResponse } from "@/lib/agentic-os/connector-gateway"

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

  /** Single egress choke point — every Brokermint API call leaves through the connector-gateway.
   *  Brokermint authenticates via an api_key query param (gateway "query" auth style). */
  private request<T = any>(
    path: string,
    opts: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<GatewayResponse<T>> {
    return callConnector<T>({
      connector: "brokermint",
      baseUrl: this.baseUri,
      path,
      method: opts.method,
      body: opts.body,
      query: opts.query,
      auth: { style: "query", name: "api_key", value: this.apiKey },
    })
  }

  async createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse> {
    try {
      const res = await this.request<{ id?: string; transaction?: { id?: string } }>("/transactions", {
        method: "POST",
        body: {
          address:        request.propertyAddress,
          status:         "active",
          transaction_type: request.transactionType === "purchase" ? "purchase" : "listing",
          price:          request.purchasePrice,
          closing_date:   request.estimatedCloseDate,
        },
      })
      if (!res.ok) return { success: false, error: `Brokermint createTransaction ${res.status}: ${res.error}` }
      const id = res.data?.id ?? res.data?.transaction?.id
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
        const res = await this.request(`/transactions/${request.externalTransactionId}/documents`, {
          method: "POST",
          body: { name: form.formName, url: form.formUrl },
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
      const res = await this.request(`/transactions/${request.externalTransactionId}`, {
        method: "PUT",
        body: { status: "cancelled", cancellation_reason: request.reason ?? "Cancelled by agent" },
      })
      if (!res.ok) return { success: false, error: `Brokermint void ${res.status}: ${res.error}` }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Brokermint voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const res = await this.request<{ id?: string }>(`/transactions/${request.externalTransactionId}/documents`, {
        method: "POST",
        body: { name: request.documentName, url: request.documentUrl, folder: request.folderName },
      })
      if (!res.ok) return { success: false, error: `Brokermint upload ${res.status}: ${res.error}` }
      return { success: true, externalDocumentId: String(res.data?.id ?? "") }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Brokermint uploadDocument failed" }
    }
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    try {
      const res = await this.request<any>(`/transactions/${request.externalTransactionId}/documents`)
      if (!res.ok) return { success: false, syncedCount: 0, documents: [], error: `Brokermint list ${res.status}` }
      const data = res.data
      const documents: ProviderDocument[] = (Array.isArray(data) ? data : data?.documents ?? []).map((d: any) => ({
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
