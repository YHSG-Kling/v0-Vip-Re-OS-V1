"use client"

/**
 * PageContextAssistant — thin client wrapper that derives `pageContext`
 * from the current URL and threads it into `InternalAIAssistant`.
 *
 * The InternalAIAssistant already accepts a pageContext prop with
 * { contactId, listingId, transactionId, offerId, pageLabel }; this
 * wrapper is the single canonical place that knows the URL → context
 * mapping so every page instantly inherits the right copilot context
 * without touching individual layouts.
 *
 * URL patterns recognized:
 *   /crm?contact=:contactId                          → contactId
 *   /dashboard/listings/[listingId]/...              → listingId
 *   /dashboard/listings/presentations/[id]           → presentationId (as listingId proxy)
 *   /dashboard/transactions/[transactionId]/...      → transactionId
 *   /dashboard/transactions/[txId]/offers/[offerId]  → transactionId + offerId
 *   /dashboard/listings/[id]/offers/[offerId]        → listingId + offerId
 *   /contacts/[contactId]/offers/[offerId]   → contactId + offerId
 *   /contacts/[contactId]/...                → contactId (legacy)
 *   /dashboard/contacts/[contactId]/...              → contactId
 *   /portal/[contactId]/...                          → contactId
 *
 * Falls back to a `pageLabel` derived from the path for non-entity pages
 * (calendar, marketing, settings, etc.) so the copilot still says "I'm on
 * the calendar page" instead of nothing.
 *
 * PURELY ADDITIVE: when no pattern matches, pageContext is undefined and
 * InternalAIAssistant behaves exactly as before.
 */

import { usePathname, useSearchParams } from "next/navigation"
import { useMemo } from "react"
import { InternalAIAssistant } from "@/app/components/shared/internal-ai-assistant"

interface Props {
  role: string
  userId?: string
  wakeWord?: string
}

interface ResolvedContext {
  contactId?:     string
  listingId?:     string
  transactionId?: string
  offerId?:       string
  pageLabel?:     string
}

function resolveContext(pathname: string, searchParams: URLSearchParams): ResolvedContext {
  const ctx: ResolvedContext = {}

  // /crm?contact=:contactId
  if (pathname === "/crm" || pathname.startsWith("/crm/")) {
    const contactId = searchParams.get("contact") ?? searchParams.get("contactId")
    if (contactId) ctx.contactId = contactId
    ctx.pageLabel = "crm"
  }

  // /dashboard/transactions/[txId]/offers/[offerId]
  let m = pathname.match(/^\/dashboard\/transactions\/([^/]+)\/offers\/([^/]+)/)
  if (m) {
    ctx.transactionId = m[1]
    ctx.offerId = m[2]
    return { ...ctx, pageLabel: "transaction-offer" }
  }
  // /dashboard/transactions/[transactionId]/...
  m = pathname.match(/^\/dashboard\/transactions\/([^/]+)/)
  if (m) {
    ctx.transactionId = m[1]
    return { ...ctx, pageLabel: "transaction" }
  }

  // /dashboard/listings/[id]/offers/[offerId]
  m = pathname.match(/^\/dashboard\/listings\/([^/]+)\/offers\/([^/]+)/)
  if (m && m[1] !== "presentations") {
    ctx.listingId = m[1]
    ctx.offerId = m[2]
    return { ...ctx, pageLabel: "listing-offer" }
  }
  // /dashboard/listings/presentations/[id]  → treat presentation id as a listingId proxy
  m = pathname.match(/^\/dashboard\/listings\/presentations\/([^/]+)/)
  if (m) {
    ctx.listingId = m[1]
    return { ...ctx, pageLabel: "listing-presentation" }
  }
  // /dashboard/listings/[listingId]/...
  m = pathname.match(/^\/dashboard\/listings\/([^/]+)/)
  if (m && m[1] !== "presentations") {
    ctx.listingId = m[1]
    return { ...ctx, pageLabel: "listing" }
  }

  // /contacts/[contactId]/offers/[offerId]
  m = pathname.match(/^\/dashboard\/buyers\/([^/]+)\/offers\/([^/]+)/)
  if (m) {
    ctx.contactId = m[1]
    ctx.offerId = m[2]
    return { ...ctx, pageLabel: "buyer-offer" }
  }
  // /contacts/[contactId]/...
  m = pathname.match(/^\/dashboard\/buyers\/([^/]+)/)
  if (m) {
    ctx.contactId = m[1]
    return { ...ctx, pageLabel: "buyer" }
  }

  // /dashboard/contacts/[contactId]/...
  m = pathname.match(/^\/dashboard\/contacts\/([^/]+)/)
  if (m) {
    ctx.contactId = m[1]
    return { ...ctx, pageLabel: "contact" }
  }

  // /portal/[contactId]/...
  m = pathname.match(/^\/portal\/([^/]+)/)
  if (m) {
    ctx.contactId = m[1]
    return { ...ctx, pageLabel: "portal" }
  }

  // Generic page label fallback for non-entity pages
  if (!ctx.pageLabel) {
    const seg = pathname.split("/").filter(Boolean)[1] ?? pathname.split("/").filter(Boolean)[0] ?? "dashboard"
    ctx.pageLabel = seg
  }

  return ctx
}

export function PageContextAssistant({ role, userId, wakeWord }: Props) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const pageContext = useMemo(() => {
    const sp = new URLSearchParams(searchParams?.toString() ?? "")
    return resolveContext(pathname ?? "/", sp)
  }, [pathname, searchParams])

  return (
    <InternalAIAssistant
      role={role}
      userId={userId}
      wakeWord={wakeWord}
      pageContext={pageContext}
    />
  )
}
