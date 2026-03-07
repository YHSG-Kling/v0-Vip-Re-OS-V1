// ─── ROLE VALIDATOR ───────────────────────────────────────────────────────────
export type { AuthorType, MessageAction, RoleValidationContext, RoleValidationResult } from "./role-validator"
export { validateMessageInitiationRules } from "./role-validator"

// ─── MESSAGE NORMALIZER ───────────────────────────────────────────────────────
export type { MessageChannel, MessageDirection, RawInboundMessage, NormalizedMessage } from "./message-normalizer"
export { normalizeInboundMessage, normalizeOutboundMessage } from "./message-normalizer"

// ─── MESSAGE PERSISTER ────────────────────────────────────────────────────────
export type { MessagePersistContext, MessagePersistResult } from "./message-persister"
export { persistMessageWithContext } from "./message-persister"

// ─── INGEST MESSAGE SERVICE ───────────────────────────────────────────────────
export type { IngestMessageParams, IngestMessageResult } from "./ingest-message-service"
export { ingestMessageService } from "./ingest-message-service"

// ─── CONVERSATION MANAGER ─────────────────────────────────────────────────────
export type { ConversationContext, ConversationResult } from "./conversation-manager"
export { getOrCreateConversation } from "./conversation-manager"
