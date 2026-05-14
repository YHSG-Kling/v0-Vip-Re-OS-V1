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

  private url(path: string): string {
    return `${this.baseUri}/restapi/v2.1/accounts/${this.accountId}${path}`
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
      // Create a draft envelope; documents + recipients are added in
      // subsequent calls so the AI cockpit can stream them in.
      const res = await fetch(this.url("/envelopes"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          emailSubject: `${request.propertyAddress} — ${request.transactionType === "purchase" ? "Purchase Agreement" : "Listing Agreement"}`,
          emailBlurb:   `This is a real estate transaction envelope for ${request.propertyAddress}.`,
          status:       "created",   // 'created' = draft; flips to 'sent' on sendForSignature
        }),
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign createEnvelope ${res.status}: ${await res.text()}` }
      }
      const data = await res.json()
      if (!data.envelopeId) {
        return { success: false, error: "DocuSign returned no envelopeId" }
      }
      return { success: true, externalTransactionId: data.envelopeId }
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
          const f = await fetch(form.formUrl)
          if (!f.ok) continue
          const buf = Buffer.from(await f.arrayBuffer())
          documentBase64 = buf.toString("base64")
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

      const res = await fetch(this.url(`/envelopes/${request.externalTransactionId}/documents`), {
        method: "PUT",   // DocuSign uses PUT for bulk add
        headers: this.headers(),
        body: JSON.stringify({ documents }),
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign attachForms ${res.status}: ${await res.text()}` }
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
      const recipientsRes = await fetch(this.url(`/envelopes/${request.externalTransactionId}/recipients`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ signers }),
      })
      if (!recipientsRes.ok) {
        return { success: false, error: `DocuSign addRecipients ${recipientsRes.status}: ${await recipientsRes.text()}` }
      }

      // 2. Flip status='sent' to actually email signers
      const sendRes = await fetch(this.url(`/envelopes/${request.externalTransactionId}`), {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({
          status:       "sent",
          emailSubject: request.message ?? "Please review and sign",
        }),
      })
      if (!sendRes.ok) {
        return { success: false, error: `DocuSign sendEnvelope ${sendRes.status}: ${await sendRes.text()}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "DocuSign sendForSignature failed" }
    }
  }

  async getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse> {
    try {
      const res = await fetch(this.url(`/envelopes/${externalTransactionId}/recipients`), {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: `DocuSign getRecipients ${res.status}` }
      }
      const data = await res.json()
      const signers: any[] = data.signers ?? []
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
      const res = await fetch(this.url(`/envelopes/${request.externalTransactionId}`), {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({
          status:       "voided",
          voidedReason: request.reason ?? "Cancelled by agent",
        }),
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign voidEnvelope ${res.status}: ${await res.text()}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "DocuSign voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const f = await fetch(request.documentUrl)
      if (!f.ok) {
        return { success: false, error: `Could not fetch document from ${request.documentUrl}` }
      }
      const buf = Buffer.from(await f.arrayBuffer())
      const documentBase64 = buf.toString("base64")
      const m = request.documentUrl.match(/\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/)
      const fileExtension = m ? m[1].toLowerCase() : "pdf"
      const documentId = String(Date.now())

      const res = await fetch(this.url(`/envelopes/${request.externalTransactionId}/documents`), {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({
          documents: [{ documentBase64, name: request.documentName, fileExtension, documentId }],
        }),
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign uploadDocument ${res.status}: ${await res.text()}` }
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
      const params = new URLSearchParams()
      if (request.query)    params.set("search_text", request.query)
      params.set("count", String(request.pageSize ?? 100))
      params.set("order_by", "name")

      const res = await fetch(this.url(`/templates?${params.toString()}`), {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, error: `DocuSign listTemplates ${res.status}: ${await res.text()}` }
      }
      const data = await res.json()
      let forms: ProviderForm[] = (data.envelopeTemplates ?? []).map((t: any) => {
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
      const res = await fetch(this.url(`/envelopes/${request.externalTransactionId}/documents`), {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, syncedCount: 0, documents: [], error: `DocuSign listDocuments ${res.status}` }
      }
      const data = await res.json()
      const documents: ProviderDocument[] = (data.envelopeDocuments ?? []).map((d: any) => ({
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
