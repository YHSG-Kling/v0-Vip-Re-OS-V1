"use client"

import useSWR from "swr"

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
  if (!res.ok) throw new Error("Failed to fetch data")
  const json = await res.json()
  if (!json.success) throw new Error(json.error || "Failed to fetch data")
  return json.data
}

export function useDashboardData<T = any>(
  dataType: DashboardDataType,
  options: UseDashboardDataOptions = {}
) {
  const { agentId, contactId, enabled = true } = options
  
  const params = new URLSearchParams({ type: dataType })
  if (agentId) params.set("agent_id", agentId)
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
    isEmpty: !isLoading && (!data || data.length === 0),
  }
}

// Convenience hooks for common data types
export function useTransactions(options?: UseDashboardDataOptions) {
  return useDashboardData("transactions", options)
}

export function useContacts(options?: UseDashboardDataOptions) {
  return useDashboardData("contacts", options)
}

export function useListings(options?: UseDashboardDataOptions) {
  return useDashboardData("listings", options)
}

export function useAppointments(options?: UseDashboardDataOptions) {
  return useDashboardData("appointments", options)
}

export function useShowings(options?: UseDashboardDataOptions) {
  return useDashboardData("showings", options)
}

export function useOffers(options?: UseDashboardDataOptions) {
  return useDashboardData("offers", options)
}

export function useReferrals(options?: UseDashboardDataOptions) {
  return useDashboardData("referrals", options)
}

export function useReviews(options?: UseDashboardDataOptions) {
  return useDashboardData("reviews", options)
}

export function useExpenses(options?: UseDashboardDataOptions) {
  return useDashboardData("expenses", options)
}

export function useCommissions(options?: UseDashboardDataOptions) {
  return useDashboardData("commissions", options)
}

export function useOpenHouses(options?: UseDashboardDataOptions) {
  return useDashboardData("open_houses", options)
}

export function useTasks(options?: UseDashboardDataOptions) {
  return useDashboardData("tasks", options)
}

export function useNotifications(options?: UseDashboardDataOptions) {
  return useDashboardData("notifications", options)
}

export function useDocuments(options?: UseDashboardDataOptions) {
  return useDashboardData("documents", options)
}

export function useAgents(options?: UseDashboardDataOptions) {
  return useDashboardData("agents", options)
}

export function useTours(options?: UseDashboardDataOptions) {
  return useDashboardData("tours", options)
}

export function useVendors(options?: UseDashboardDataOptions) {
  return useDashboardData("vendors", options)
}

export function useCommunications(options?: UseDashboardDataOptions) {
  return useDashboardData("communications", options)
}
