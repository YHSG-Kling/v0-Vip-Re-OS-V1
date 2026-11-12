/**
 * Form Simplicity Provider Implementation
 *
 * Wraps Form Simplicity's transaction + forms API (Florida Realtors' platform;
 * also widely licensed by other state associations). Bearer-token auth, REST+JSON.
 * Form Simplicity's core strength is its state-association FORM LIBRARY, and it
 * provides e-signature via its Authentisign integration.
 *
 * Credentials shape (platform_credentials row):
 *   api_key         — Form Simplicity OAuth2 access token (Bearer; client_credentials at /oauth/token).
 *   account_id      — Member / account id (passed as accountId, optional).
 *   config.base_uri — Optional; the partner API host is provisioned per integration (the dev host
 *                     is formsapidev.floridarealtors.org). Defaults to VENDOR_CONTRACTS.formsimplicity.baseUrl.
 *
 * WAVE 140 (lane 140I) — CONTRACT VERIFIED (api.formsimplicity.com/docs/{intro,fsforms,oauth},
 * 2026-10-11): the host is https://api.formsimplicity.com with NO /v1 (the old default); the endpoints
 * are RPC-style POSTs — /fsforms/listTrans, /fsforms/getTransById, /fsforms/addTrans (and
 * /officeTransactions/*) — behind OAuth2 client_credentials. createTransaction now speaks
 * /fsforms/addTrans with the documented body keys; the vendor requires stateID + agentNRDSID, which
 * CreateTransactionRequest does not carry — the 400 "Missing Required Parameter" is surfaced, never
 * hidden (open item: thread the agent's NRDS id + state through the request). The forms / signature /
 * documents paths below are NOT in the published docs — kept as they were, published as unverified.
 * The intro page also says the API "is setup for internal use only at this time" (account by request).
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

export class FormSimplicityProvider implements ITransactionProvider {
  readonly name = "formsimplicity"

  private accessToken: string
  private accountId:   string | undefined
  private baseUri:     string

  constructor(credentials: { apiKey: string; profileId?: string; baseUri?: string }) {
    if (!credentials?.apiKey) throw new Error("Form Simplicity: api_key (Bearer token) required")
    this.accessToken = credentials.apiKey
    this.accountId   = credentials.profileId
    this.baseUri     = (credentials.baseUri ?? VENDOR_CONTRACTS.formsimplicity.baseUrl).replace(/\/$/, "")
  }

  /** Single egress choke point — every Form Simplicity API call leaves through the connector-gateway. */
  private request<T = any>(
    path: string,
    opts: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<GatewayResponse<T>> {
    return callConnector<T>({
      connector: "formsimplicity",
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
      // Documented: POST /fsforms/addTrans { userId, stateID, agentNRDSID, transName, streetAddress,
      // propertyType, transactionType, propertyStatus } (api.formsimplicity.com/docs/fsforms).
      const res = await this.request<{ id?: string; transactionId?: string; transId?: string }>("/fsforms/addTrans", {
        method: "POST",
        body: {
          userId:          this.accountId,
          transName:       request.propertyAddress,
          streetAddress:   request.propertyAddress,
          transactionType: request.transactionType === "purchase" ? "purchase" : "listing",
          price:           request.purchasePrice,
          closingDate:     request.estimatedCloseDate,
        },
      })
      if (!res.ok) return { success: false, error: `FormSimplicity createTransaction ${res.status}: ${res.error}` }
      const id = res.data?.id ?? res.data?.transactionId ?? res.data?.transId
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
        const res = await this.request(`/transactions/${request.externalTransactionId}/forms`, {
          method: "POST",
          body: { formId: form.formName, formUrl: form.formUrl, data: form.formData ?? {} },
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
      const res = await this.request(`/transactions/${request.externalTransactionId}/signature-requests`, {
        method: "POST",
        body: {
          documentId: request.documentId,
          signers: request.signers.map((s, i) => ({ order: i + 1, email: s.email, name: s.name, role: s.role })),
          message: request.message ?? "Please review and sign.",
        },
      })
      if (!res.ok) return { success: false, error: `FormSimplicity sendForSignature ${res.status}: ${res.error}` }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity sendForSignature failed" }
    }
  }

  async getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse> {
    try {
      const res = await this.request<{ signers?: any[]; signatures?: any[] }>(`/transactions/${externalTransactionId}/signature-requests`)
      if (!res.ok) return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: `FormSimplicity status ${res.status}` }
      const items: any[] = res.data?.signers ?? res.data?.signatures ?? []
      const total = items.length
      const signed = items.filter((s) => ["signed", "completed"].includes((s.status ?? "").toString().toLowerCase())).length
      return { success: true, total, signed, pending: total - signed, percentComplete: total > 0 ? Math.round((signed / total) * 100) : 0 }
    } catch (err: any) {
      return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: err?.message }
    }
  }

  async voidTransaction(request: VoidTransactionRequest): Promise<VoidTransactionResponse> {
    try {
      const res = await this.request(`/transactions/${request.externalTransactionId}`, {
        method: "PATCH",
        body: { status: "cancelled", reason: request.reason ?? "Cancelled by agent" },
      })
      if (!res.ok) return { success: false, error: `FormSimplicity void ${res.status}: ${res.error}` }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const res = await this.request<{ id?: string; documentId?: string }>(`/transactions/${request.externalTransactionId}/documents`, {
        method: "POST",
        body: { name: request.documentName, url: request.documentUrl, folder: request.folderName ?? "Documents" },
      })
      if (!res.ok) return { success: false, error: `FormSimplicity upload ${res.status}: ${res.error}` }
      return { success: true, externalDocumentId: String(res.data?.id ?? res.data?.documentId ?? "") }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "FormSimplicity uploadDocument failed" }
    }
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    try {
      const res = await this.request<{ documents?: any[] }>(`/transactions/${request.externalTransactionId}/documents`)
      if (!res.ok) return { success: false, syncedCount: 0, documents: [], error: `FormSimplicity list ${res.status}` }
      const docList: any[] = res.data?.documents ?? (Array.isArray(res.data) ? (res.data as any[]) : [])
      const documents: ProviderDocument[] = docList.map((d: any) => ({
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
      const query: Record<string, string> = { limit: String(request.pageSize ?? 100) }
      if (request.stateCode) query.state = request.stateCode
      if (request.category)  query.category = request.category
      if (request.query)     query.q = request.query
      if (this.accountId)    query.accountId = this.accountId

      const res = await this.request<{ forms?: any[]; items?: any[] }>("/forms", { query })
      if (!res.ok) return { success: false, error: `FormSimplicity listForms ${res.status}: ${res.error}` }
      const items: any[] = res.data?.forms ?? res.data?.items ?? (Array.isArray(res.data) ? (res.data as any[]) : [])
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

// TOMBSTONE: local mapCategory merged onto transaction-provider.interface.ts
// mapProviderFormCategory (imported above) — §1/§6 SAME BODY census round 3,
// 2026-09-09.
const mapCategory = mapProviderFormCategory
