/**
 * DocuSign Provider Implementation
 *
 * Wraps DocuSign eSignature REST API v2.1.
 * https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/
 *
 * Credentials shape (platform_credentials row):
 *   api_key     — DocuSign OAuth access token (Bearer). Brokerage admin
 *                 authorizes our app via DocuSign's consent flow; token is
 *                 stored here. Refresh flow is a separate concern outside
 *                 this class.
 *   account_id  — DocuSign Account ID (the X-DocuSign-AccountId header).
 *   config.base_uri — Optional. Defaults to https://www.docusign.net (prod).
 *                     Use https://demo.docusign.net for sandbox.
 *
 * Endpoint shape:
 *   POST /restapi/v2.1/accounts/{accountId}/envelopes        → envelopeId
 *   POST /restapi/v2.1/accounts/{accountId}/envelopes/{id}/documents
 *   POST /restapi/v2.1/accounts/{accountId}/envelopes/{id}/recipients
 *   PUT  /restapi/v2.1/accounts/{accountId}/envelopes/{id}   (status=sent)
 *   GET  /restapi/v2.1/accounts/{accountId}/envelopes/{id}
 *   PUT  /restapi/v2.1/accounts/{accountId}/envelopes/{id}   (status=voided)
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
import { callConnector, type GatewayResponse } from "@/lib/agentic-os/connector-gateway"

export class DocusignProvider implements ITransactionProvider {
  readonly name = "docusign"

  private accessToken: string
  private accountId:   string
  private baseUri:     string

  constructor(credentials: { apiKey: string; profileId: string; baseUri?: string }) {
    if (!credentials?.apiKey)    throw new Error("DocuSign: access token required (api_key)")
    if (!credentials?.profileId) throw new Error("DocuSign: account_id required (profileId)")
    this.accessToken = credentials.apiKey
    this.accountId   = credentials.profileId
    this.baseUri     = (credentials.baseUri ?? "https://www.docusign.net").replace(/\/$/, "")
  }

  /** Single egress choke point — every DocuSign API call leaves through the connector-gateway
   *  (Bearer OAuth token). Arbitrary form/document URL downloads are NOT provider calls and stay
   *  on plain fetch. */
  private request<T = any>(
    subpath: string,
    opts: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<GatewayResponse<T>> {
    return callConnector<T>({
      connector: "docusign",
      baseUrl: this.baseUri,
      path: `restapi/v2.1/accounts/${this.accountId}${subpath}`,
      method: opts.method,
      body: opts.body,
      query: opts.query,
      auth: { style: "bearer", token: this.accessToken },
    })
  }

  async createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse> {
    try {
      // Create a draft envelope; documents + recipients are added in
      // subsequent calls so the AI cockpit can stream them in.
      const res = await this.request<{ envelopeId?: string }>("/envelopes", {
        method: "POST",
        body: {
          emailSubject: `${request.propertyAddress} — ${request.transactionType === "purchase" ? "Purchase Agreement" : "Listing Agreement"}`,
          emailBlurb:   `This is a real estate transaction envelope for ${request.propertyAddress}.`,
          status:       "created",   // 'created' = draft; flips to 'sent' on sendForSignature
        },
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign createEnvelope ${res.status}: ${res.error}` }
      }
      if (!res.data?.envelopeId) {
        return { success: false, error: "DocuSign returned no envelopeId" }
      }
      return { success: true, externalTransactionId: res.data.envelopeId }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "DocuSign createTransaction failed" }
    }
  }

  async attachForms(request: AttachFormsRequest): Promise<AttachFormsResponse> {
    try {
      let attached = 0
      // DocuSign documents must be base64 + named. When formUrl is provided,
      // fetch + base64. When only formData is provided, we synthesize a single
      // text document with the JSON fields rendered — DocuSign requires byte
      // content for every doc.
      const documents: Array<Record<string, unknown>> = []
      for (let i = 0; i < request.forms.length; i++) {
        const form = request.forms[i]
        let documentBase64: string | null = null
        let fileExtension = "pdf"
        if (form.formUrl) {
          const f = await callConnector<Buffer>({
            connector: "asset-download", baseUrl: "", path: "", url: form.formUrl,
            method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
          })
          if (!f.ok || !f.data) continue
          documentBase64 = f.data.toString("base64")
          const m = form.formUrl.match(/\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/)
          if (m) fileExtension = m[1].toLowerCase()
        } else if (form.formData) {
          const txt = JSON.stringify(form.formData, null, 2)
          documentBase64 = Buffer.from(txt, "utf-8").toString("base64")
          fileExtension = "txt"
        } else {
          continue
        }
        documents.push({
          documentBase64,
          name:         form.formName,
          fileExtension,
          documentId:   String(i + 1),
        })
        attached++
      }

      if (documents.length === 0) {
        return { success: true, attachedCount: 0 }
      }

      const res = await this.request(`/envelopes/${request.externalTransactionId}/documents`, {
        method: "PUT",   // DocuSign uses PUT for bulk add
        body: { documents },
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign attachForms ${res.status}: ${res.error}` }
      }
      return { success: true, attachedCount: attached }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "DocuSign attachForms failed" }
    }
  }

  async sendForSignature(request: SendForSignatureRequest): Promise<SendForSignatureResponse> {
    try {
      // 1. Add recipients (signers)
      const signers = request.signers.map((s, i) => ({
        email:        s.email,
        name:         s.name,
        recipientId:  String(i + 1),
        routingOrder: String(i + 1),
        roleName:     s.role,
      }))
      const recipientsRes = await this.request(`/envelopes/${request.externalTransactionId}/recipients`, {
        method: "POST",
        body: { signers },
      })
      if (!recipientsRes.ok) {
        return { success: false, error: `DocuSign addRecipients ${recipientsRes.status}: ${recipientsRes.error}` }
      }

      // 2. Flip status='sent' to actually email signers
      const sendRes = await this.request(`/envelopes/${request.externalTransactionId}`, {
        method: "PUT",
        body: {
          status:       "sent",
          emailSubject: request.message ?? "Please review and sign",
        },
      })
      if (!sendRes.ok) {
        return { success: false, error: `DocuSign sendEnvelope ${sendRes.status}: ${sendRes.error}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "DocuSign sendForSignature failed" }
    }
  }

  async getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse> {
    try {
      const res = await this.request<{ signers?: any[] }>(`/envelopes/${externalTransactionId}/recipients`)
      if (!res.ok) {
        return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: `DocuSign getRecipients ${res.status}` }
      }
      const signers: any[] = res.data?.signers ?? []
      const total = signers.length
      const signed = signers.filter(s => s.status === "completed" || s.status === "signed").length
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
      const res = await this.request(`/envelopes/${request.externalTransactionId}`, {
        method: "PUT",
        body: {
          status:       "voided",
          voidedReason: request.reason ?? "Cancelled by agent",
        },
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign voidEnvelope ${res.status}: ${res.error}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "DocuSign voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const f = await callConnector<Buffer>({
        connector: "asset-download", baseUrl: "", path: "", url: request.documentUrl,
        method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
      })
      if (!f.ok || !f.data) {
        return { success: false, error: `Could not fetch document from ${request.documentUrl}` }
      }
      const documentBase64 = f.data.toString("base64")
      const m = request.documentUrl.match(/\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/)
      const fileExtension = m ? m[1].toLowerCase() : "pdf"
      const documentId = String(Date.now())

      const res = await this.request(`/envelopes/${request.externalTransactionId}/documents`, {
        method: "PUT",
        body: {
          documents: [{ documentBase64, name: request.documentName, fileExtension, documentId }],
        },
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign uploadDocument ${res.status}: ${res.error}` }
      }
      return { success: true, externalDocumentId: documentId }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "DocuSign uploadDocument failed" }
    }
  }

  async listForms(request: ListFormsRequest): Promise<ListFormsResponse> {
    try {
      // DocuSign's form library lives as Templates. /templates returns the
      // account's saved templates which can be reused as offer/listing forms.
      const query: Record<string, string> = { count: String(request.pageSize ?? 100), order_by: "name" }
      if (request.query) query.search_text = request.query

      const res = await this.request<{ envelopeTemplates?: any[] }>("/templates", { query })
      if (!res.ok) {
        return { success: false, error: `DocuSign listTemplates ${res.status}: ${res.error}` }
      }
      let forms: ProviderForm[] = (res.data?.envelopeTemplates ?? []).map((t: any) => {
        const name = String(t.name ?? "Template")
        // Infer state + category from template name when possible (DocuSign
        // doesn't expose structured taxonomy on templates).
        const stateMatch = name.match(/\b([A-Z]{2})\b/)
        const lower = name.toLowerCase()
        const category: ProviderForm["category"] =
          lower.includes("listing")  ? "listing"
          : lower.includes("offer") || lower.includes("purchase") ? "offer"
          : lower.includes("addendum")   ? "addendum"
          : lower.includes("disclosure") ? "disclosure"
          : lower.includes("agency")     ? "agency" : "other"
        return {
          formId:    t.templateId,
          name,
          issuer:    t.owner?.userName,
          stateCode: stateMatch ? stateMatch[1] : undefined,
          category,
          version:   t.lastModified,
        }
      })
      // Optional client-side filter — DocuSign API doesn't accept state filter.
      if (request.stateCode) {
        const sc = request.stateCode.toUpperCase()
        forms = forms.filter(f => !f.stateCode || f.stateCode === sc)
      }
      if (request.category) {
        forms = forms.filter(f => f.category === request.category)
      }
      return { success: true, forms }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "DocuSign listForms failed" }
    }
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    try {
      const res = await this.request<{ envelopeDocuments?: any[] }>(`/envelopes/${request.externalTransactionId}/documents`)
      if (!res.ok) {
        return { success: false, syncedCount: 0, documents: [], error: `DocuSign listDocuments ${res.status}` }
      }
      const documents: ProviderDocument[] = (res.data?.envelopeDocuments ?? []).map((d: any) => ({
        externalDocumentId: d.documentId,
        documentName:       d.name,
        folderName:         "Documents",
        isSigned:           d.status === "completed" || d.signed === true,
        url:                d.uri ? `${this.baseUri}${d.uri}` : undefined,
        uploadedAt:         d.createdDateTime,
        lastModified:       d.lastModifiedDateTime,
      }))
      return { success: true, documents, syncedCount: documents.length }
    } catch (err: any) {
      return { success: false, syncedCount: 0, documents: [], error: err?.message }
    }
  }
}
