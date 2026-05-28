/**
 * Authentisign Provider Implementation  (Lone Wolf Authentisign)
 *
 * Wraps Lone Wolf's Authentisign signing API.
 * https://developer.lwolf.com (Bearer-token auth, REST + JSON).
 *
 * Credentials shape (platform_credentials row):
 *   api_key     — Lone Wolf OAuth access token (Bearer).
 *   account_id  — Lone Wolf account / brokerage id.
 *   config.base_uri — Optional. Defaults to https://api.lwolf.com.
 *
 * Endpoint shape:
 *   POST /authentisign/v1/signings                    → signingId
 *   POST /authentisign/v1/signings/{id}/documents     (attach docs)
 *   POST /authentisign/v1/signings/{id}/participants  (add signers)
 *   POST /authentisign/v1/signings/{id}/send          (begin signing flow)
 *   GET  /authentisign/v1/signings/{id}               (status)
 *   POST /authentisign/v1/signings/{id}/cancel        (void)
 *   GET  /authentisign/v1/signings/{id}/documents     (list/sync)
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

export class AuthentisignProvider implements ITransactionProvider {
  readonly name = "authentisign"

  private accessToken: string
  private accountId:   string
  private baseUri:     string

  constructor(credentials: { apiKey: string; profileId: string; baseUri?: string }) {
    if (!credentials?.apiKey)    throw new Error("Authentisign: access token required (api_key)")
    if (!credentials?.profileId) throw new Error("Authentisign: account_id required (profileId)")
    this.accessToken = credentials.apiKey
    this.accountId   = credentials.profileId
    this.baseUri     = (credentials.baseUri ?? "https://api.lwolf.com").replace(/\/$/, "")
  }

  private url(path: string): string {
    return `${this.baseUri}/authentisign/v1${path}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "X-LW-AccountId": this.accountId,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extra,
    }
  }

  async createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse> {
    try {
      const res = await fetch(this.url("/signings"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          name:    `${request.propertyAddress} — ${request.transactionType === "purchase" ? "Purchase" : "Listing"}`,
          subject: "Please review and sign.",
          accountId: this.accountId,
        }),
      })
      if (!res.ok) {
        return { success: false, error: `Authentisign createSigning ${res.status}: ${await res.text()}` }
      }
      const data = await res.json()
      const signingId = data.signingId ?? data.id
      if (!signingId) {
        return { success: false, error: "Authentisign returned no signingId" }
      }
      return { success: true, externalTransactionId: String(signingId) }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Authentisign createTransaction failed" }
    }
  }

  async attachForms(request: AttachFormsRequest): Promise<AttachFormsResponse> {
    try {
      let attached = 0
      for (const form of request.forms) {
        if (!form.formUrl) continue
        const res = await fetch(this.url(`/signings/${request.externalTransactionId}/documents`), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            name:         form.formName,
            sourceUri:    form.formUrl,
            metadata:     form.formData ?? {},
          }),
        })
        if (res.ok) attached++
      }
      return { success: true, attachedCount: attached }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Authentisign attachForms failed" }
    }
  }

  async sendForSignature(request: SendForSignatureRequest): Promise<SendForSignatureResponse> {
    try {
      // Authentisign requires participants added before send.
      const participantsRes = await fetch(this.url(`/signings/${request.externalTransactionId}/participants`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          participants: request.signers.map((s, i) => ({
            order: i + 1,
            email: s.email,
            name:  s.name,
            role:  s.role,
          })),
        }),
      })
      if (!participantsRes.ok) {
        return { success: false, error: `Authentisign addParticipants ${participantsRes.status}: ${await participantsRes.text()}` }
      }
      const sendRes = await fetch(this.url(`/signings/${request.externalTransactionId}/send`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ message: request.message ?? "Please review and sign." }),
      })
      if (!sendRes.ok) {
        return { success: false, error: `Authentisign send ${sendRes.status}: ${await sendRes.text()}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Authentisign sendForSignature failed" }
    }
  }

  async getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse> {
    try {
      const res = await fetch(this.url(`/signings/${externalTransactionId}`), {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: `Authentisign status ${res.status}` }
      }
      const data = await res.json()
      const items: any[] = data.participants ?? []
      const total = items.length
      const signed = items.filter(p => (p.status ?? "").toString().toLowerCase() === "signed"
                                     || (p.status ?? "").toString().toLowerCase() === "completed").length
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
      const res = await fetch(this.url(`/signings/${request.externalTransactionId}/cancel`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ reason: request.reason ?? "Cancelled by agent" }),
      })
      if (!res.ok) {
        return { success: false, error: `Authentisign cancel ${res.status}: ${await res.text()}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Authentisign voidTransaction failed" }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const res = await fetch(this.url(`/signings/${request.externalTransactionId}/documents`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          name:      request.documentName,
          sourceUri: request.documentUrl,
          folder:    request.folderName ?? "Documents",
        }),
      })
      if (!res.ok) {
        return { success: false, error: `Authentisign upload ${res.status}: ${await res.text()}` }
      }
      const data = await res.json()
      return { success: true, externalDocumentId: String(data.documentId ?? data.id ?? "") }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Authentisign uploadDocument failed" }
    }
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    try {
      const res = await fetch(this.url(`/signings/${request.externalTransactionId}/documents`), {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, syncedCount: 0, documents: [], error: `Authentisign list ${res.status}` }
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

  async listForms(request: ListFormsRequest): Promise<ListFormsResponse> {
    try {
      // Lone Wolf Authentisign exposes the form library under /forms with
      // optional state + category filters.
      const params = new URLSearchParams()
      if (request.stateCode) params.set("state",    request.stateCode)
      if (request.category)  params.set("category", request.category)
      if (request.query)     params.set("q",         request.query)
      params.set("limit", String(request.pageSize ?? 100))

      const res = await fetch(this.url(`/forms?${params.toString()}`), {
        headers: this.headers(),
      })
      if (!res.ok) {
        return { success: false, error: `Authentisign listForms ${res.status}: ${await res.text()}` }
      }
      const data = await res.json()
      const items: any[] = data.forms ?? data.items ?? data ?? []
      const forms: ProviderForm[] = items.map(f => ({
        formId:    String(f.formId ?? f.id),
        name:      f.name ?? f.title ?? "Form",
        issuer:    f.association ?? f.publisher,
        stateCode: f.state ?? f.stateCode,
        category:  mapAuthentisignCategory(f.category ?? f.type),
        version:   f.version,
        previewUrl: f.previewUrl ?? f.url,
      }))
      return { success: true, forms }
    } catch (err: any) {
      return { success: false, error: err?.message ?? "Authentisign listForms failed" }
    }
  }
}

function mapAuthentisignCategory(c: string | undefined): ProviderForm["category"] {
  const s = (c ?? "").toString().toLowerCase()
  if (s.includes("listing"))    return "listing"
  if (s.includes("purchase") || s.includes("offer")) return "offer"
  if (s.includes("addendum"))   return "addendum"
  if (s.includes("disclosure")) return "disclosure"
  if (s.includes("agency"))     return "agency"
  return "other"
}
