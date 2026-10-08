/**
 * app/actions/inbox-types.ts
 *
 * Plain type module for the inbox Server Actions.
 *
 * IMPORTANT: app/actions/inbox.ts carries the "use server" directive, and a
 * Server Actions module may ONLY export async functions. Exporting a `type`
 * or `interface` from it makes the Server Actions loader emit a runtime
 * reference to the type name (e.g. `ReferenceError: InboxChannel is not
 * defined`). All inbox-related types therefore live here and are imported
 * back into inbox.ts as type-only imports.
 */

export type {
  InboxChannel,
  InboxMessageRow,
  InboxThread,
} from "@/lib/kernel/communications"

export interface GetInboxMessagesParams {
  channel?: string
  contactId?: string
  unreadOnly?: boolean
  limit?: number
  /** Restrict to one AI-ISA lead's conversation (leads are NOT contacts). */
  leadId?: string
  /** "lead" fetches only the AI-ISA lead lane. */
  party?: "lead"
}

export interface SendInboxMessageParams {
  contactId: string
  body: string
  channel: "sms" | "email" | "portal" | "chat"
}

export interface ForceComplianceOverrideParams {
  contactId: string
  body: string
  channel: "sms" | "email" | "portal" | "chat"
  overrideReason: string
}
