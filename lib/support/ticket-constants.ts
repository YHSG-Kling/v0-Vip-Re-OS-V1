// lib/support/ticket-constants.ts
// Support ticket + help-article constants and types. Lives OUTSIDE the "use server"
// action file so client components can import the const arrays/types directly — a
// "use server" file may only export async functions (exporting a const array breaks
// the RSC page-data build).

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const
export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const
export const TICKET_CATEGORIES = ["general", "technical", "billing", "onboarding", "compliance", "feature_request"] as const

/**
 * THE TWO SUPPORT LANES (owner ruling: "support is for submitting support tickets
 * to platform from tenant and also agents and vendors support ticket to the
 * brokerage office staff"). They are not the same conversation and never share a
 * queue:
 *
 *   tenant_to_platform   the brokerage raising a ticket TO the platform, answered
 *                        by platform staff holding platform_role 'support'.
 *   user_to_brokerage  an agent or a vendor raising a ticket to their OWN
 *                        brokerage's office staff. THE PLATFORM IS NOT A PARTY.
 *
 * Mirrors support_tickets_lane_check on the live table (m468). The column is NOT
 * NULL with NO DEFAULT, deliberately: every writer states its lane, and a writer
 * that forgets gets 23502 instead of a silently mis-routed ticket.
 */
export const TICKET_LANES = ["tenant_to_platform", "user_to_brokerage"] as const

export type TicketStatus = (typeof TICKET_STATUSES)[number]
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]
export type TicketLane = (typeof TICKET_LANES)[number]

/** PURE: is this a lane the database will actually store? */
export function isTicketLane(v: unknown): v is TicketLane {
  return typeof v === "string" && (TICKET_LANES as readonly string[]).includes(v)
}

/** The two organisations that answer support, and they are not interchangeable. */
export type TicketAnswerer = "platform_support" | "brokerage_office"

/**
 * PURE: WHO OWES A REPLY on this lane — the one place that decision is made.
 *
 * It was previously made nowhere: every new ticket and every requester reply
 * alerted platform staff, in both directions, because there was no lane to ask
 * about. So a brokerage-internal ticket paged the platform (which cannot answer it)
 * and never reached the brokerage's own office (which owes the answer).
 *
 * Returns null for a lane this build does not know. Callers must treat that as
 * "route nowhere" rather than falling through to a default — guessing an answerer
 * is how a support conversation is delivered to strangers.
 */
export function ticketAnsweredBy(lane: string | null | undefined): TicketAnswerer | null {
  if (lane === "tenant_to_platform") return "platform_support"
  if (lane === "user_to_brokerage") return "brokerage_office"
  return null
}

export interface SupportTicket {
  id: string
  subject: string
  description: string | null
  status: string
  priority: string
  category: string | null
  agentId: string | null
  /** Which of the two conversations this is. See TICKET_LANES. */
  lane: string
  /** The VENDOR that raised it (user_to_brokerage lane), when one did. */
  vendorId: string | null
  /** The users.id that filed it — the submitter fact that works for every user class. */
  submittedByUserId: string | null
  createdAt: string
  updatedAt: string | null
}

export interface HelpArticle {
  id: string
  source: "article" | "kb"
  title: string
  excerpt: string | null
  category: string | null
  slug: string | null
  helpfulCount: number
  viewCount: number
}
