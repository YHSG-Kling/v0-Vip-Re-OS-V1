"use client"

import useSWR from "swr"

/**
 * hooks/use-dashboard-data.ts — 19 hooks over one generic `useDashboardData`,
 * all hitting `/api/dashboard/data`.
 *
 * ── THE READ-BOTH VERDICT (wave 13, L3) ─────────────────────────────────────
 *
 * DUPLICATE, and this lane is the LOSER — on all eighteen entity types. The
 * verdict is argued from what each side CAN DO. It is not "nothing imports it";
 * "no caller" is never a deletion rationale and is not one here.
 *
 * SIDE A (this lane). Per entity: one unfiltered list, agent- and
 * brokerage-scoped, delivered to a client component through an HTTP route, with
 * SWR caching and a `mutate()` handle.
 *
 * SIDE B (what the app renders from today). NOT "server components reading
 * Supabase directly" — that framing is what made this look like a live
 * capability. Side B is a set of SERVER ACTIONS, and a server action is callable
 * from a client component. Per entity they take filters, pagination and search
 * this lane cannot express, and most of them are ROLE-AWARE: getContacts widens
 * for a broker/admin, this lane's `contacts` branch always pins to the caller's
 * own agent id, so a broker using these hooks would see LESS than they see now.
 * That is a regression, not a wiring opportunity.
 *
 * THE ONE CAPABILITY THIS LANE APPEARED TO ADD — client-side revalidation after
 * a mutation, which a server component genuinely cannot do without a round trip
 * — IS ALREADY AVAILABLE OVER THE SURVIVORS, three ways, all live in this tree:
 *
 *   1. hooks/use-contact-dashboard.ts wraps server actions in `useSWR` and gets
 *      the identical `mutate` handle, with no HTTP hop and no second auth round
 *      trip. That is the house pattern — 13 files use SWR, and exactly one of
 *      them fetches a URL.
 *   2. `revalidatePath` in the action plus `router.refresh()` — 211 and 132
 *      files respectively.
 *   3. Re-invoking the reader action directly (app/crm/page.tsx:loadContacts,
 *      called after create and after archive).
 *
 * So the differentiator is not a differentiator, and on every other axis this
 * lane is a strict subset. Hence: duplicate, this side loses.
 *
 * ── WHY THIS FILE IS STILL HERE ─────────────────────────────────────────────
 *
 * Because the method is MERGE FIRST, THEN DELETE, and the merge is not done.
 * Three things the losing lane does that its survivors do not are listed under
 * MERGE DEBT below. Each lives in a file outside this slice's write scope, so
 * they are reported rather than applied. Deleting now would throw away scoping
 * that no survivor currently has — which is precisely the failure this rule
 * exists to prevent. Once the three merges land, this file and
 * app/api/dashboard/data/route.ts are a mechanical delete, and
 * DASHBOARD_DATA_SURVIVOR below is the ledger that makes it mechanical.
 */

/**
 * The survivor for every data type this lane can fetch, as
 * `path:functionName`. Enforced by scripts/dashboard-data-layer-simulator.ts:
 * every member of DashboardDataType must appear here, and every entry must name
 * a file that exists and a function that file actually declares. A verdict that
 * only lives in prose is documentation masquerading as a decision.
 */
export const DASHBOARD_DATA_SURVIVOR = {
  transactions:   "app/actions/transactions.ts:getTransactions",
  contacts:       "app/actions/contacts.ts:getContacts",
  listings:       "app/actions/listings.ts:getListings",
  appointments:   "app/actions/ai-calendar-management.ts:getAppointments",
  showings:       "app/actions/showings.ts:getShowings",
  tours:          "app/actions/ai-showing-management.ts:getTours",
  offers:         "app/offers/page.tsx:OffersPage",
  referrals:      "app/actions/referrals/referral-actions.ts:listPartnersWithReferrals",
  reviews:        "app/actions/multi-persona.ts:getAgentReviews",
  expenses:       "app/actions/agents.ts:getAgentExpenses",
  commissions:    "app/actions/agents.ts:getAgentCommissions",
  open_houses:    "app/actions/open-house.ts:getOpenHouses",
  tasks:          "app/actions/tasks.ts:getTasks",
  notifications:  "lib/kernel/notification-center.ts:listNotifications",
  documents:      "app/actions/documents.ts:getDocuments",
  agents:         "app/actions/agents.ts:getAgents",
  vendors:        "app/actions/vendor-marketplace.ts:searchVendors",
  communications: "app/actions/communications.ts:getRecentCommunications",
} as const

/**
 * MERGE DEBT — what the losing lane carries that its survivor does not. Every
 * one of these is a scoping property, which is the honest answer to "is any of
 * this not a duplicate": the READS are duplicates, the SCOPING is not. All three
 * files are outside this slice's write scope and are reported, not edited.
 *
 *   1. app/actions/agents.ts:getAgents(brokerageId?) takes the tenant as an
 *      OPTIONAL CALLER-SUPPLIED argument and has NO role gate. Called with no
 *      argument it returns every active agent on the platform. The `agents`
 *      branch of the route resolves the tenant from the session and refuses a
 *      caller who is not broker/admin/superadmin. Merge that shape onto
 *      getAgents before this lane is deleted.
 *
 *   2. app/actions/agents.ts:getAgentCommissions(agentId) and
 *      :getAgentExpenses(agentId) take the agent id FROM THE CALLER with no
 *      ownership check and no tenant filter — any signed-in user can read any
 *      agent's money ledger by id. The route resolves the agent id from the
 *      session and filters the tenant. Merge, then delete.
 *
 *   3. app/actions/ai-showing-management.ts:getTours(agentId) takes the agent id
 *      from the caller and applies no brokerage filter. The `tours` branch
 *      applies both, session-derived.
 *
 * Adjacent, found while establishing (2) and (3) and NOT a merge — a writer bug:
 * app/actions/ai-auto-response.ts inserts a message row without stamping
 * brokerage_id. messages.brokerage_id is nullable with no backfill, so those
 * rows are invisible to every tenant-filtered reader of that table.
 */

export type DashboardDataType =
  | "transactions"
  | "contacts"
  | "listings"
  | "appointments"
  | "showings"
  | "tours"
  | "offers"
  | "referrals"
  | "reviews"
  | "expenses"
  | "commissions"
  | "open_houses"
  | "tasks"
  | "notifications"
  | "documents"
  | "agents"
  | "vendors"
  | "communications"

interface UseDashboardDataOptions {
  agentId?: string
  contactId?: string
  enabled?: boolean
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json().catch(() => null)
  // The route reports a refused read as a 502 with a reason rather than as an
  // empty list. Surfacing that reason here is the whole point — an SWR consumer
  // that turns "permission denied" into `data: []` puts the lie back.
  if (!res.ok || !json?.success) {
    throw new Error(json?.error || `Failed to fetch data (${res.status})`)
  }
  return json.data
}

export function useDashboardData<T = any>(
  dataType: DashboardDataType,
  options: UseDashboardDataOptions = {}
) {
  const { contactId, enabled = true } = options

  // NOTE: `agentId` is deliberately NOT forwarded. The route resolves the agent
  // and the brokerage from the session and ignores any such parameter; sending
  // one would imply it were honoured. `contact_id` is forwarded because it
  // NARROWS a scope the route has already applied.
  const params = new URLSearchParams({ type: dataType })
  if (contactId) params.set("contact_id", contactId)

  const { data, error, isLoading, mutate } = useSWR<T[]>(
    enabled ? `/api/dashboard/data?${params.toString()}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    }
  )

  return {
    data: data || [],
    error,
    isLoading,
    mutate,
    // `isEmpty` is only meaningful when the read SUCCEEDED. Without the error
    // term a denied read renders as "you have nothing here".
    isEmpty: !isLoading && !error && (!data || data.length === 0),
  }
}

// Convenience hooks for common data types.
// Each is @deprecated against the survivor named in DASHBOARD_DATA_SURVIVOR —
// see the MERGE DEBT block above for why they have not been deleted yet.

/** @deprecated Use app/actions/transactions.ts:getTransactions. */
export function useTransactions(options?: UseDashboardDataOptions) {
  return useDashboardData("transactions", options)
}

/** @deprecated Use app/actions/contacts.ts:getContacts (role-aware, searchable, paginated). */
export function useContacts(options?: UseDashboardDataOptions) {
  return useDashboardData("contacts", options)
}

/** @deprecated Use app/actions/listings.ts:getListings. */
export function useListings(options?: UseDashboardDataOptions) {
  return useDashboardData("listings", options)
}

/** @deprecated Use app/actions/ai-calendar-management.ts:getAppointments. */
export function useAppointments(options?: UseDashboardDataOptions) {
  return useDashboardData("appointments", options)
}

/** @deprecated Use app/actions/showings.ts:getShowings. */
export function useShowings(options?: UseDashboardDataOptions) {
  return useDashboardData("showings", options)
}

/** @deprecated Use app/offers/page.tsx:OffersPage (role-aware agent/brokerage split). */
export function useOffers(options?: UseDashboardDataOptions) {
  return useDashboardData("offers", options)
}

/** @deprecated Use app/actions/referrals/referral-actions.ts:listPartnersWithReferrals. */
export function useReferrals(options?: UseDashboardDataOptions) {
  return useDashboardData("referrals", options)
}

/** @deprecated Use app/actions/multi-persona.ts:getAgentReviews. */
export function useReviews(options?: UseDashboardDataOptions) {
  return useDashboardData("reviews", options)
}

/** @deprecated Use app/actions/agents.ts:getAgentExpenses — see MERGE DEBT (2). */
export function useExpenses(options?: UseDashboardDataOptions) {
  return useDashboardData("expenses", options)
}

/** @deprecated Use app/actions/agents.ts:getAgentCommissions — see MERGE DEBT (2). */
export function useCommissions(options?: UseDashboardDataOptions) {
  return useDashboardData("commissions", options)
}

/** @deprecated Use app/actions/open-house.ts:getOpenHouses. */
export function useOpenHouses(options?: UseDashboardDataOptions) {
  return useDashboardData("open_houses", options)
}

/** @deprecated Use app/actions/tasks.ts:getTasks. */
export function useTasks(options?: UseDashboardDataOptions) {
  return useDashboardData("tasks", options)
}

/** @deprecated Use lib/kernel/notification-center.ts:listNotifications (paginated, unread-only). */
export function useNotifications(options?: UseDashboardDataOptions) {
  return useDashboardData("notifications", options)
}

/** @deprecated Use app/actions/documents.ts:getDocuments. */
export function useDocuments(options?: UseDashboardDataOptions) {
  return useDashboardData("documents", options)
}

/** @deprecated Use app/actions/agents.ts:getAgents — see MERGE DEBT (1). */
export function useAgents(options?: UseDashboardDataOptions) {
  return useDashboardData("agents", options)
}

/** @deprecated Use app/actions/ai-showing-management.ts:getTours — see MERGE DEBT (3). */
export function useTours(options?: UseDashboardDataOptions) {
  return useDashboardData("tours", options)
}

/** @deprecated Use app/actions/vendor-marketplace.ts:searchVendors. */
export function useVendors(options?: UseDashboardDataOptions) {
  return useDashboardData("vendors", options)
}

/** @deprecated Use app/actions/communications.ts:getRecentCommunications. */
export function useCommunications(options?: UseDashboardDataOptions) {
  return useDashboardData("communications", options)
}
