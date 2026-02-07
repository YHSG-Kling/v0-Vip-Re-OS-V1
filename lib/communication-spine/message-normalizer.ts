/**
 * SYSTEM 3.1: COMMUNICATION SPINE
 * Inbound Message Normalizer
 * 
 * THIS IS INFRASTRUCTURE-ONLY. NO UI. NO AI LOGIC.
 * 
 * Purpose: Normalize messages from different channels into
 * a consistent format for storage.
 */

export type MessageChannel = 'email' | 'sms' | 'voice_transcript' | 'social_dm_facebook' | 'social_dm_instagram' | 'social_dm_linkedin'
export type MessageDirection = 'inbound' | 'outbound'

export interface RawInboundMessage {
  channel: MessageChannel
  from: string // Email, phone, social handle
  to: string
  subject?: string
  body: string
  timestamp?: Date
  attachments?: string[]
  metadata?: Record<string, any>
}

export interface NormalizedMessage {
  channel: MessageChannel
  direction: MessageDirection
  authorType: string
  subject?: string
  body: string
  attachmentUrls: string[]
  timestamp: Date
  metadata: Record<string, any>
}

/**
 * NORMALIZE INBOUND MESSAGE
 * 
 * Converts raw channel-specific messages into a standardized format.
 * This ensures consistent storage regardless of source.
 */
export function normalizeInboundMessage(
  raw: RawInboundMessage,
  contactId: string
): NormalizedMessage {
  return {
    channel: raw.channel,
    direction: 'inbound',
    authorType: 'contact', // Assume inbound is from contact
    subject: raw.subject || inferSubject(raw),
    body: raw.body,
    attachmentUrls: raw.attachments || [],
    timestamp: raw.timestamp || new Date(),
    metadata: {
      ...raw.metadata,
      from: raw.from,
      to: raw.to,
      contactId,
    },
  }
}

/**
 * NORMALIZE OUTBOUND MESSAGE
 * 
 * Converts system-generated messages into standardized format.
 */
export function normalizeOutboundMessage(
  channel: MessageChannel,
  authorType: string,
  body: string,
  options: {
    subject?: string
    attachments?: string[]
    metadata?: Record<string, any>
  } = {}
): NormalizedMessage {
  return {
    channel,
    direction: 'outbound',
    authorType,
    subject: options.subject,
    body,
    attachmentUrls: options.attachments || [],
    timestamp: new Date(),
    metadata: options.metadata || {},
  }
}

/**
 * Helper: Infer subject from body or channel
 */
function inferSubject(raw: RawInboundMessage): string {
  if (raw.channel === 'sms' || raw.channel.startsWith('social_dm')) {
    return 'Direct Message'
  }
  
  if (raw.channel === 'voice_transcript') {
    return 'Voice Call Transcript'
  }

  // Email without subject
  const preview = raw.body.substring(0, 50).trim()
  return preview ? `Re: ${preview}` : 'No Subject'
}
