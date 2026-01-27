"use client"

import { useMemo } from "react"
import { useAuthStore } from "../stores/authStore"
import { permissionsService, type Permission, type UserAccessContext } from "../services/permissionsService"

export function usePermissions() {
  const { user, role } = useAuthStore()

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
      // Full context for advanced permission checks
      context,

      // Check single permission
      can: (permission: Permission) => permissionsService.hasPermission(role, permission),

      // Check any of permissions
      canAny: (permissions: Permission[]) => permissionsService.hasAnyPermission(role, permissions),

      // Check all permissions
      canAll: (permissions: Permission[]) => permissionsService.hasAllPermissions(role, permissions),

      // Check navigation access
      canAccessView: (view: string) => permissionsService.canAccessView(role, view),

      // Get allowed navigation items
      allowedNavigation: permissionsService.getNavigationItems(role),

      // Get data scope
      dataScope: permissionsService.getDataScope(role),

      // Convenience checks
      isAdminOrBroker: permissionsService.isAdminOrBroker(role),
      isStaff: permissionsService.isStaff(role),

      canAccessRecord: (
        recordType: "contact" | "transaction" | "listing" | "document" | "communication",
        record: {
          id: string
          agent_id?: string
          contact_id?: string
          seller_id?: string
          buyer_id?: string
          vendor_id?: string
          team_id?: string
          created_by?: string
          assigned_to?: string[]
          shared_with?: string[]
        },
      ) => permissionsService.canAccessRecord(context, recordType, record),

      canPerformAction: (
        action: "view" | "edit" | "delete" | "share",
        entityType: string,
        entityOwnerId?: string,
        entityTeamId?: string,
      ) => permissionsService.canPerformAction(context, action, entityType, entityOwnerId, entityTeamId),

      // Current user info for filtering
      userId: user?.id,
      agentId: user?.agentId || user?.id,
      contactId: user?.contactId,
      vendorId: user?.vendorId,
      teamIds: user?.teamIds || [],
      brokerageId: user?.brokerageId,
      managedAgentIds: user?.managedAgentIds || [],
      role,
    }),
    [user, role, context],
  )
}
