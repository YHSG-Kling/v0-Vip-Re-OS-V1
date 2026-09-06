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

/**
 * NOTE ON THE ABSENT agentId. This contract used to declare `agentId: string`.
 * All six implementations — dotloop, skyslope, formsimplicity, brokermint,
 * docusign, authentisign — ignored it, and every caller computed a value to
 * satisfy the type. Each provider scopes the transaction by the account in its
 * OWN credentials (dotloop, for instance, posts to /profile/{profileId}/loop
 * using the profileId stored with the API key), so there is no id for the
 * caller to supply. A required field that nothing reads is worse than no field:
 * it reads as wiring, and the next person to add a provider will assume the
 * agent identity arrives here when it never has. Removed rather than wired,
 * because wiring it would invent a requirement no provider actually has.
 */
export interface CreateTransactionRequest {
  propertyAddress: string
  transactionType: "purchase" | "listing"
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

/** A provider-agnostic signature placement tag (from lib/forms/esign-anchor-adapters anchorsForProvider).
 *  The `tab` is already shaped for the target provider's API; providers forward it into their request. */
export interface SignatureTag {
  anchorKey: string
  role: string
  type: "signature" | "initial" | "date"
  recipientRole: string
  tab: Record<string, unknown>
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
  /** OPTIONAL signature/initial/date placement tags. When present, the provider places the marks at
   *  these anchors instead of relying on the agent to drag tabs in the provider UI. Provider-shaped
   *  by anchorsForProvider; absent → current behavior (manual placement in the provider). */
  tags?: SignatureTag[]
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

// ─── Provider form library ──────────────────────────────────────────────────
// Each provider hosts a library of pre-built forms (state association forms,
// brokerage-published forms, NAR forms, etc.). The FormWizard picks BOTH from
// the brokerage's uploaded storage AND from the configured provider's library.

export interface ListFormsRequest {
  /** Optional state filter — return only forms tagged for this state. */
  stateCode?: string
  /** Optional category filter — "offer" | "listing" | "addendum" | "disclosure" | "agency" */
  category?: string
  /** Provider-specific search query (form name contains). */
  query?: string
  /** Pagination — page size. Providers may cap this. Default 100. */
  pageSize?: number
}

export interface ProviderForm {
  /** Provider-internal form id (used at attach time). */
  formId:   string
  /** Human-readable name. */
  name:     string
  /** Issuing association (TAR, CAR, FAR, NAR, brokerage, ...) when known. */
  issuer?:  string
  /** Two-letter state code when the form is state-specific. */
  stateCode?: string
  /** Coarse-grained type. */
  category?: "offer" | "listing" | "addendum" | "disclosure" | "agency" | "other"
  /** Provider's own version label, useful for audit. */
  version?: string
  /** Optional URL the agent can preview before selecting. */
  previewUrl?: string
}

export interface ListFormsResponse {
  success: boolean
  forms?:  ProviderForm[]
  error?:  string
}

/**
 * Transaction Provider Interface
 *
 * All providers must implement these 8 methods
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

  /**
   * List forms available from the provider's library. The FormWizard merges
   * these with the brokerage's uploaded storage forms so the agent can pick
   * from either source.
   */
  listForms(request: ListFormsRequest): Promise<ListFormsResponse>
}
