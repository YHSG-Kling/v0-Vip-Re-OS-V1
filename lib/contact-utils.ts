import type { ContactType, ContactPersona, ContactTimeline, ContactStatus } from "@/types/contact"

export const CONTACT_TYPE_LABELS: Record<ContactType, string> = {
  buyer: "Buyer",
  seller: "Seller",
  investor: "Investor",
  lender: "Lender",
  commercial: "Commercial",
  agent: "Agent/Partner",
  vendor: "Vendor",
  TC: "Transaction Coordinator",
  other: "Other",
}

export const CONTACT_PERSONA_LABELS: Record<ContactPersona, string> = {
  first_time_buyer: "First-Time Buyer",
  luxury_buyer: "Luxury Buyer",
  luxury_seller: "Luxury Seller",
  investor: "Investor",
  first_time_seller: "First-Time Seller",
  motivated_seller: "Motivated Seller",
  relocating: "Relocating",
  empty_nester: "Empty Nester",
  probate: "Probate",
  remote_seller: "Remote Seller",
  divorce: "Divorce",
  upsizers: "Upsizers",
  senior: "Senior",
  expired: "Expired Listing",
  fsbo: "FSBO",
  other: "Other",
}

export const TIMELINE_LABELS: Record<ContactTimeline, string> = {
  "0-3_months": "0-3 Months",
  "3-6_months": "3-6 Months",
  "6-12_months": "6-12 Months",
  "12+_months": "12+ Months",
}

export const STATUS_LABELS: Record<ContactStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  appointment_booked: "Appointment Booked",
  signed_agreement: "Signed Agreement",
  pre_listing: "Pre-Listing",
  active_listing: "Active Listing",
  contingent: "Contingent",
  pending: "Pending",
  sold: "Sold",
  lifetime_customer: "Lifetime Customer",
}

export function getTimelineColor(timeline: ContactTimeline): string {
  switch (timeline) {
    case "0-3_months":
      return "bg-red-100 text-red-800 border-red-300"
    case "3-6_months":
      return "bg-yellow-100 text-yellow-800 border-yellow-300"
    case "6-12_months":
      return "bg-blue-100 text-blue-800 border-blue-300"
    case "12+_months":
      return "bg-gray-100 text-gray-800 border-gray-300"
  }
}

export function getTimelineUrgency(timeline: ContactTimeline): "urgent" | "soon" | "normal" | "planning" {
  switch (timeline) {
    case "0-3_months":
      return "urgent"
    case "3-6_months":
      return "soon"
    case "6-12_months":
      return "normal"
    case "12+_months":
      return "planning"
  }
}

// getPersonaDashboardRoute — DELETED (orphan burn-down w44).
//
// REPLACED BY: the literal `/portal/${contactId}`, which is what every portal
// surface already builds inline (app/components/portal/*, PortalUserMenu,
// PortalSettingsPage, MilestoneProgressBar, SellerOfferCard, … ~20 sites).
//
// It was the residue of a routing scheme that no longer exists: its own docstring
// recorded that /portal/[contactId]/dashboard/[persona] had been REMOVED and that
// /dashboard/contact/[persona] never existed, which left it returning a constant
// and IGNORING its `persona` argument. A helper that takes a persona and does
// nothing with it is a trap for the next caller, not a route abstraction — the
// persona-specific view is chosen by lib/kernel/portal.ts from the contact, never
// from the URL.

export function getPersonaDescription(persona: ContactPersona): string {
  const descriptions: Record<ContactPersona, string> = {
    first_time_buyer: "Never owned before, needs education and guidance",
    luxury_buyer: "High-end purchase, expects premium service",
    luxury_seller: "High-end property sale, sophisticated needs",
    investor: "Investment focused, ROI driven",
    first_time_seller: "First time selling, needs process guidance",
    motivated_seller: "Needs to sell quickly, time-sensitive",
    relocating: "Moving for job/life change, dual market needs",
    empty_nester: "Downsizing after children leave",
    probate: "Inherited property, legal complexities",
    remote_seller: "Selling from distance, remote management",
    divorce: "Divorce-related sale, sensitive situation",
    upsizers: "Buying larger property, growing family",
    senior: "Senior citizen with age-specific needs",
    expired: "Previous listing expired, needs new strategy",
    fsbo: "For Sale By Owner, considering agent representation",
    other: "Other type of contact",
  }
  return descriptions[persona]
}

export function getUrgencyColor(timeline: string | null | undefined): {
  bg: string
  text: string
  dot: string
} {
  const daysUntil = calculateDaysUntilTimeline(timeline)

  if (daysUntil === null) {
    return {
      bg: "bg-slate-100",
      text: "text-slate-600",
      dot: "bg-slate-400",
    }
  }

  if (daysUntil <= 7) {
    return {
      bg: "bg-red-100",
      text: "text-red-700",
      dot: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]",
    }
  }

  if (daysUntil <= 30) {
    return {
      bg: "bg-amber-100",
      text: "text-amber-700",
      dot: "bg-amber-500",
    }
  }

  if (daysUntil <= 90) {
    return {
      bg: "bg-blue-100",
      text: "text-blue-700",
      dot: "bg-blue-500",
    }
  }

  return {
    bg: "bg-slate-100",
    text: "text-slate-600",
    dot: "bg-slate-400",
  }
}

export function calculateDaysUntilTimeline(timeline: string | null | undefined): number | null {
  if (!timeline) return null

  // Handle specific date formats (ISO dates)
  const dateMatch = timeline.match(/^\d{4}-\d{2}-\d{2}/)
  if (dateMatch) {
    const targetDate = new Date(timeline)
    const today = new Date()
    const diffTime = targetDate.getTime() - today.getTime()
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
    return diffDays
  }

  // Handle relative time descriptions
  const lowerTimeline = timeline.toLowerCase()

  if (lowerTimeline.includes("asap") || lowerTimeline.includes("immediately")) {
    return 0
  }

  if (lowerTimeline.includes("week")) {
    const weeks = Number.parseInt(lowerTimeline.match(/(\d+)/)?.[1] || "1")
    return weeks * 7
  }

  if (lowerTimeline.includes("month")) {
    const months = Number.parseInt(lowerTimeline.match(/(\d+)/)?.[1] || "1")
    return months * 30
  }

  if (lowerTimeline.includes("year")) {
    const years = Number.parseInt(lowerTimeline.match(/(\d+)/)?.[1] || "1")
    return years * 365
  }

  // Default patterns
  if (lowerTimeline.includes("3 months") || lowerTimeline.includes("3m")) {
    return 90
  }

  if (lowerTimeline.includes("6 months") || lowerTimeline.includes("6m")) {
    return 180
  }

  if (lowerTimeline.includes("12 months") || lowerTimeline.includes("1 year")) {
    return 365
  }

  return null
}

export function getStatusColor(status: string): {
  text: string
  dot: string
} {
  const statusLower = status.toLowerCase()

  if (["active", "qualified", "signed"].some((s) => statusLower.includes(s))) {
    return {
      text: "text-green-700",
      dot: "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]",
    }
  }

  if (["contacted", "pending"].some((s) => statusLower.includes(s))) {
    return {
      text: "text-blue-700",
      dot: "bg-blue-500",
    }
  }

  if (["new"].some((s) => statusLower.includes(s))) {
    return {
      text: "text-indigo-700",
      dot: "bg-indigo-500",
    }
  }

  if (["closed", "sold"].some((s) => statusLower.includes(s))) {
    return {
      text: "text-emerald-700",
      dot: "bg-emerald-500",
    }
  }

  if (["inactive", "lost"].some((s) => statusLower.includes(s))) {
    return {
      text: "text-slate-500",
      dot: "bg-slate-400",
    }
  }

  return {
    text: "text-slate-600",
    dot: "bg-slate-400",
  }
}
