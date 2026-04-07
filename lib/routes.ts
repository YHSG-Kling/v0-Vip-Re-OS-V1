export const ROUTES = {
  // Auth
  LOGIN: "/login",
  ONBOARDING: "/dashboard/onboarding",

  // Core
  DASHBOARD: "/dashboard",
  AGENT_DASHBOARD: "/dashboard/agent",
  CRM: "/crm",
  LEADS: "/leads",

  // Transactions + Listings
  TRANSACTIONS: "/dashboard/transactions",
  LISTINGS: "/dashboard/listings",
  BUYERS: "/dashboard/buyers",

  // OS Surfaces
  CALENDAR: "/dashboard/calendar",
  COMMUNICATIONS: "/dashboard/communications/inbox",
  SOCIAL: "/dashboard/social",
  REPORTS: "/dashboard/reports",
  DIAGNOSIS: "/dashboard/diagnosis",
  MOTIVATION: "/dashboard/motivation",
  AI_TOOLS: "/dashboard/ai-tools",
  AI_CHAT: "/dashboard/chat",

  // Admin
  ADMIN: "/dashboard/admin",
  SETTINGS: "/dashboard/settings",
} as const

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES]
