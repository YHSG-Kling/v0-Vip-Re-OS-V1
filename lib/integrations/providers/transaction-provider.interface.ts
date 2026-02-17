/**
 * Provider Abstraction Interface
 * 
 * Supports: Dotloop, SkySlope, FormSimplicity, BrokerMint
 * 
 * Provider is TRANSPORT ONLY:
 * - Loop creation
 * - Form attachment
 * - Signature requests
 * - Document sync
 * - Void transaction
 * 
 * Provider does NOT handle:
 * - Compliance scans
 * - Commission calculation
 * - CDA
 * - Accounting
 * - Lifecycle transitions
 */

export interface ProviderDocument {
  externalDocumentId: string
  documentName: string
  folderName: string
  isSigned: boolean
  url?: string
  signers?: Array<{
    name: string
    email: string
    role: string
    signedAt?: string
  }>
  uploadedAt?: string
  lastModified?: string
}

export interface CreateTransactionRequest {
  propertyAddress: string
  transactionType: "purchase" | "listing"
  agentId: string
  contactId?: string
  listingId?: string
  transactionId?: string
  purchasePrice?: number
  estimatedCloseDate?: string
}

export interface CreateTransactionResponse {
  success: boolean
  externalTransactionId?: string
  error?: string
}

export interface AttachFormsRequest {
  externalTransactionId: string
  forms: Array<{
    formName: string
    formUrl?: string
    formData?: Record<string, any>
  }>
}

export interface AttachFormsResponse {
  success: boolean
  attachedCount?: number
  error?: string
}

export interface SendForSignatureRequest {
  externalTransactionId: string
  documentId: string
  signers: Array<{
    email: string
    name: string
    role: string
  }>
  message?: string
}

export interface SendForSignatureResponse {
  success: boolean
  error?: string
}

export interface SignatureStatusResponse {
  success: boolean
  total: number
  signed: number
  pending: number
  percentComplete: number
  error?: string
}

export interface SyncDocumentsRequest {
  externalTransactionId: string
  contactId: string
  transactionId?: string
  listingId?: string
}

export interface SyncDocumentsResponse {
  success: boolean
  documents?: ProviderDocument[]
  syncedCount?: number
  error?: string
}

export interface VoidTransactionRequest {
  externalTransactionId: string
  reason?: string
}

export interface VoidTransactionResponse {
  success: boolean
  error?: string
}

export interface UploadDocumentRequest {
  externalTransactionId: string
  documentName: string
  documentUrl: string
  folderName?: string
}

export interface UploadDocumentResponse {
  success: boolean
  externalDocumentId?: string
  error?: string
}

/**
 * Transaction Provider Interface
 * 
 * All providers must implement these 7 methods
 */
export interface ITransactionProvider {
  /**
   * Provider name (e.g., "dotloop", "skyslope")
   */
  readonly name: string

  /**
   * Create a new transaction/loop
   */
  createTransaction(request: CreateTransactionRequest): Promise<CreateTransactionResponse>

  /**
   * Attach forms to a transaction
   */
  attachForms(request: AttachFormsRequest): Promise<AttachFormsResponse>

  /**
   * Send documents for signature
   */
  sendForSignature(request: SendForSignatureRequest): Promise<SendForSignatureResponse>

  /**
   * Get signature status
   */
  getSignatureStatus(externalTransactionId: string): Promise<SignatureStatusResponse>

  /**
   * Void/cancel a transaction
   */
  voidTransaction(request: VoidTransactionRequest): Promise<VoidTransactionResponse>

  /**
   * Upload a document to the transaction
   */
  uploadDocument(request: UploadDocumentRequest): Promise<UploadDocumentResponse>

  /**
   * Sync documents from provider to internal storage
   */
  syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse>
}
