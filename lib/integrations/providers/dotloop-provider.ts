/**
 * Dotloop Provider Implementation
 * 
 * Wraps all direct Dotloop API calls.
 * Moves logic from ai-offer-creation.ts, ai-listing-intake.ts, platform-sync.service.ts
 * 
 * DOES NOT delete dotloop-integration.ts (keeps legacy for backward compatibility)
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

const DOTLOOP_API_BASE = "https://api-gateway.dotloop.com/public/v2"

export class DotloopProvider implements ITransactionProvider {
  readonly name = "dotloop"

  private injectedCredentials?: { apiKey: string; profileId: string }

  constructor(credentials?: { apiKey: string; profileId: string }) {
    this.injectedCredentials = credentials
  }

  private getCredentials() {
    // Injected DB credentials take priority over env vars
    if (this.injectedCredentials) return this.injectedCredentials

    const apiKey = process.env.DOTLOOP_API_KEY
    const profileId = process.env.DOTLOOP_PROFILE_ID

    if (!apiKey || !profileId) {
      return null
    }

    return { apiKey, profileId }
  }

  /** Single egress choke point — every Dotloop API call leaves through the connector-gateway. */
  private request<T = any>(
    apiKey: string,
    path: string,
    opts: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<GatewayResponse<T>> {
    return callConnector<T>({
      connector: "dotloop",
      baseUrl: DOTLOOP_API_BASE,
      path,
      method: opts.method,
      body: opts.body,
      query: opts.query,
      auth: { style: "bearer", token: apiKey },
    })
  }

  async createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse> {
    try {
      const credentials = this.getCredentials()
      if (!credentials) return { success: false, error: "Dotloop not configured (missing API key / profile)" }

      const { apiKey, profileId } = credentials

      const response = await this.request<{ data?: { loop_id?: string } }>(apiKey, `/profile/${profileId}/loop`, {
        method: "POST",
        body: {
          name: `${request.propertyAddress} - ${request.transactionType}`,
          status: "Active",
          transaction_type: request.transactionType === "purchase" ? "Purchase" : "Listing for Sale",
          street_address: request.propertyAddress,
        },
      })
      if (!response.ok) throw new Error(`Dotloop API error: ${response.status} - ${response.error}`)
      const loopId = response.data?.data?.loop_id
      if (!loopId) throw new Error("No loop_id returned from Dotloop")
      return { success: true, externalTransactionId: loopId }
    } catch (error: any) {
      console.error("[v0] Dotloop createTransaction error:", error)
      return {
        success: false,
        error: error.message,
      }
    }
  }

  async attachForms(request: AttachFormsRequest): Promise<AttachFormsResponse> {
    try {
      const credentials = this.getCredentials()
      if (!credentials) return { success: false, error: "Dotloop not configured (missing API key / profile)" }

      const { apiKey, profileId } = credentials
      let attachedCount = 0

      for (const form of request.forms) {
        if (!form.formUrl) continue
        const response = await this.request(
          apiKey,
          `/profile/${profileId}/loop/${request.externalTransactionId}/folder/Documents/document`,
          { method: "POST", body: { name: form.formName, file_url: form.formUrl } },
        )
        if (response.ok) attachedCount++
      }

      return { success: true, attachedCount }
    } catch (error: any) {
      console.error("[v0] Dotloop attachForms error:", error)
      return {
        success: false,
        error: error.message,
      }
    }
  }

  async sendForSignature(request: SendForSignatureRequest): Promise<SendForSignatureResponse> {
    try {
      const credentials = this.getCredentials()
      if (!credentials) return { success: false, error: "Dotloop not configured (missing API key / profile)" }

      const { apiKey, profileId } = credentials

      // Add participants to the loop
      for (const signer of request.signers) {
        await this.request(
          apiKey,
          `/profile/${profileId}/loop/${request.externalTransactionId}/participant`,
          { method: "POST", body: { email: signer.email, full_name: signer.name, role: signer.role } },
        )
      }

      return { success: true }
    } catch (error: any) {
      console.error("[v0] Dotloop sendForSignature error:", error)
      return {
        success: false,
        error: error.message,
      }
    }
  }

  async getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse> {
    try {
      const credentials = this.getCredentials()
      if (!credentials) {
        return { success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: "Dotloop not configured (missing API key / profile)" }
      }

      const { apiKey, profileId } = credentials

      const response = await this.request<{ data?: any[] }>(
        apiKey,
        `/profile/${profileId}/loop/${externalTransactionId}/folder`,
      )
      if (!response.ok) throw new Error(`Dotloop API error: ${response.status} - ${response.error}`)

      const folders = response.data ?? {}
      let totalDocs = 0
      let signedDocs = 0

      for (const folder of folders.data || []) {
        for (const doc of folder.documents || []) {
          totalDocs++
          if (doc.is_signed) signedDocs++
        }
      }

      return {
        success: true,
        total: totalDocs,
        signed: signedDocs,
        pending: totalDocs - signedDocs,
        percentComplete: totalDocs > 0 ? Math.round((signedDocs / totalDocs) * 100) : 0,
      }
    } catch (error: any) {
      console.error("[v0] Dotloop getSignatureStatus error:", error)
      return {
        success: false,
        total: 0,
        signed: 0,
        pending: 0,
        percentComplete: 0,
        error: error.message,
      }
    }
  }

  async voidTransaction(request: VoidTransactionRequest): Promise<VoidTransactionResponse> {
    try {
      const credentials = this.getCredentials()
      if (!credentials) return { success: false, error: "Dotloop not configured (missing API key / profile)" }

      const { apiKey, profileId } = credentials

      const response = await this.request(
        apiKey,
        `/profile/${profileId}/loop/${request.externalTransactionId}`,
        { method: "PATCH", body: { status: "Canceled" } },
      )
      if (!response.ok) throw new Error(`Dotloop API error: ${response.status} - ${response.error}`)

      return { success: true }
    } catch (error: any) {
      console.error("[v0] Dotloop voidTransaction error:", error)
      return {
        success: false,
        error: error.message,
      }
    }
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse> {
    try {
      const credentials = this.getCredentials()
      if (!credentials) return { success: false, error: "Dotloop not configured (missing API key / profile)" }

      const { apiKey, profileId } = credentials
      const folderName = request.folderName || "Documents"

      const response = await this.request<{ data?: { document_id?: string } }>(
        apiKey,
        `/profile/${profileId}/loop/${request.externalTransactionId}/folder/${folderName}/document`,
        { method: "POST", body: { name: request.documentName, file_url: request.documentUrl } },
      )
      if (!response.ok) throw new Error(`Dotloop API error: ${response.status} - ${response.error}`)

      return { success: true, externalDocumentId: response.data?.data?.document_id }
    } catch (error: any) {
      console.error("[v0] Dotloop uploadDocument error:", error)
      return {
        success: false,
        error: error.message,
      }
    }
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    try {
      const credentials = this.getCredentials()
      if (!credentials) return { success: false, documents: [], syncedCount: 0, error: "Dotloop not configured (missing API key / profile)" }

      const { apiKey, profileId } = credentials

      const response = await this.request<{ data?: any[] }>(
        apiKey,
        `/profile/${profileId}/loop/${request.externalTransactionId}/folder`,
      )
      if (!response.ok) throw new Error(`Dotloop API error: ${response.status} - ${response.error}`)

      const folders = response.data ?? {}
      const documents: ProviderDocument[] = []

      for (const folder of folders.data || []) {
        for (const doc of folder.documents || []) {
          documents.push({
            externalDocumentId: doc.document_id,
            documentName: doc.name,
            folderName: folder.name,
            isSigned: doc.is_signed || false,
            url: doc.url,
            uploadedAt: doc.created_at,
            lastModified: doc.updated_at,
          })
        }
      }

      return {
        success: true,
        documents,
        syncedCount: documents.length,
      }
    } catch (error: any) {
      console.error("[v0] Dotloop syncDocuments error:", error)
      return {
        success: false,
        documents: [],
        syncedCount: 0,
        error: error.message,
      }
    }
  }

  async listForms(request: ListFormsRequest): Promise<ListFormsResponse> {
    try {
      const credentials = this.getCredentials()
      if (!credentials) return { success: true, forms: [] }

      const { apiKey, profileId } = credentials

      // Dotloop exposes the brokerage form library under /profile/{id}/loop-template
      // and /profile/{id}/form. We use the form endpoint which returns the
      // forms available to this profile (state association + brokerage custom).
      const query: Record<string, string> = { page_size: String(request.pageSize ?? 100) }
      if (request.stateCode) query.state = request.stateCode
      if (request.query)     query.q = request.query

      const response = await this.request<{ data?: any[] }>(apiKey, `/profile/${profileId}/form`, { query })
      if (!response.ok) {
        return { success: false, error: `Dotloop listForms ${response.status}: ${response.error}` }
      }
      const data = response.data
      const forms: ProviderForm[] = ((data?.data ?? (Array.isArray(data) ? data : [])) as any[]).map((f: any) => ({
        formId:    String(f.form_id ?? f.id),
        name:      f.name ?? f.title ?? "Form",
        issuer:    f.association ?? f.issuer,
        stateCode: f.state ?? f.state_code,
        category:  mapDotloopCategory(f.category ?? f.type),
        version:   f.version,
        previewUrl: f.preview_url ?? f.url,
      }))
      return { success: true, forms }
    } catch (err: any) {
      console.error("[v0] Dotloop listForms error:", err)
      return { success: false, error: err.message }
    }
  }
}

function mapDotloopCategory(c: string | undefined): ProviderForm["category"] {
  const s = (c ?? "").toString().toLowerCase()
  if (s.includes("listing"))     return "listing"
  if (s.includes("purchase"))    return "offer"
  if (s.includes("offer"))       return "offer"
  if (s.includes("addendum"))    return "addendum"
  if (s.includes("disclosure"))  return "disclosure"
  if (s.includes("agency"))      return "agency"
  return "other"
}
