'use server'

/**
 * SYSTEM 3.1: UNIFIED COMMUNICATION SPINE — Server Action entry point.
 * Core logic lives in lib/communication-spine/ingest-message-service.ts.
 * This file exists only to attach the "use server" directive for Next.js.
 */

export {
  ingestMessageService as ingestMessage,
  type IngestMessageParams,
  type IngestMessageResult,
} from '@/lib/communication-spine/ingest-message-service'
