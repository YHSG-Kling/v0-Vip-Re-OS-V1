// ─── PROVIDER RESOLVER ────────────────────────────────────────────────────────
export {
  getTransactionProvider,
  getAvailableProviders,
  isProviderSupported,
} from './providers/provider-resolver'

// ─── TRANSACTION PROVIDER TYPES ───────────────────────────────────────────────
export type {
  ProviderDocument,
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
  ITransactionProvider,
} from './providers/transaction-provider.interface'

// ─── BROKERAGE AUTHORITY ──────────────────────────────────────────────────────
export {
  getBrokerageAuthoritySettings,
  shouldRunInternalCompliance,
  shouldRunInternalCommission,
  shouldRunInternalAccounting,
  isFullyExternal,
  isHybridMode,
  getProviderName,
} from './providers/brokerage-authority'
export type { BrokerageAuthoritySettings } from './providers/brokerage-authority'

// ─── DOTLOOP PROVIDER ─────────────────────────────────────────────────────────
export { DotloopProvider } from './providers/dotloop-provider'
