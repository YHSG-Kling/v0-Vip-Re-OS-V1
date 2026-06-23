// lib/support/ticket-constants.ts
// Support ticket + help-article constants and types. Lives OUTSIDE the "use server"
// action file so client components can import the const arrays/types directly — a
// "use server" file may only export async functions (exporting a const array breaks
// the RSC page-data build).

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const
export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const
export const TICKET_CATEGORIES = ["general", "technical", "billing", "onboarding", "compliance", "feature_request"] as const

export type TicketStatus = (typeof TICKET_STATUSES)[number]
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

export interface SupportTicket {
  id: string
  subject: string
  description: string | null
  status: string
  priority: string
  category: string | null
  agentId: string | null
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
