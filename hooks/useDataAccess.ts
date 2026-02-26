"use client"

import { useMemo } from "react"
import { useAuth } from "@/lib/auth/client"
import { dataAccessService } from "../services/dataAccessService"
import type { UserAccessContext } from "../services/permissionsService"

export function useDataAccess() {
  const { user, role } = useAuth()

  // Build full access context from authenticated user
  const context: UserAccessContext = useMemo(
    () => ({
      userId: user?.id || "",
      role,
      subType: user?.subType,
      agentId: user?.agentId || (role === "agent" ? user?.id : undefined),
      contactId: user?.contactId || (role === "contact" ? user?.id : undefined),
      vendorId: user?.vendorId || (role === "vendor" ? user?.id : undefined),
      teamId: user?.teamId,
      teamIds: user?.teamIds || (user?.teamId ? [user.teamId] : []),
      brokerageId: user?.brokerageId,
      managedAgentIds: user?.managedAgentIds || [],
    }),
    [user, role],
  )

  return useMemo(
    () => ({
      context,

      // Contacts
      getContacts: () => dataAccessService.getContacts(context),
      getContactById: (id: string) => dataAccessService.getContactById(context, id),
      updateContact: (id: string, updates: any) => dataAccessService.updateContact(context, id, updates),

      // Transactions
      getTransactions: () => dataAccessService.getTransactions(context),
      getTransactionById: (id: string) => dataAccessService.getTransactionById(context, id),

      // Listings
      getListings: () => dataAccessService.getListings(context),

      // Communications
      getCommunications: (contactId?: string) => dataAccessService.getCommunications(context, contactId),

      // Documents
      getDocuments: (entityId?: string) => dataAccessService.getDocuments(context, entityId),

      // Financials
      getFinancials: (type: string) => dataAccessService.getFinancials(context, type),

      // Users
      getUsers: (userType?: string) => dataAccessService.getUsers(context, userType),

      // Showings
      getShowings: () => dataAccessService.getShowings(context),
      getOpenHouses: () => dataAccessService.getOpenHouses(context),

      // Gamification
      getBadges: () => dataAccessService.getBadges(context),
      getLeaderboard: () => dataAccessService.getLeaderboard(context),

      // Sphere
      getSphere: () => dataAccessService.getSphere(context),
    }),
    [context],
  )
}
