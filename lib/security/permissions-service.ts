"use client"

/**
 * permissionsService — runtime permission checks using the UserRole enum
 * from services/permissionsService (compatibility layer).
 *
 * The canonical permission matrix lives in lib/security/permission-matrix.ts.
 * This file re-implements the permissionsService API on top of that matrix
 * so existing consumers (Sidebar, hooks, dataAccessService) continue to work
 * without change.
 */

import { UserRole } from "../types"

// ─── PERMISSION TYPE ──────────────────────────────────────────────────────────
// Keep the broad UI-facing Permission type from the legacy service.
export type Permission =
  | "view:admin_dashboard"
  | "view:broker_dashboard"
  | "view:agent_dashboard"
  | "view:contact_dashboard"
  | "view:tc_dashboard"
  | "view:lead_intelligence"
  | "view:lead_insights"
  | "view:lead_scraping_config"
  | "manage:lead_scraping"
  | "view:all_contacts"
  | "view:team_contacts"
  | "view:own_contacts"
  | "edit:all_contacts"
  | "edit:team_contacts"
  | "edit:own_contacts"
  | "delete:contacts"
  | "view:all_transactions"
  | "view:team_transactions"
  | "view:own_transactions"
  | "edit:all_transactions"
  | "edit:own_transactions"
  | "view:all_communications"
  | "view:team_communications"
  | "view:own_communications"
  | "send:communications"
  | "send:ai_chat_messages"
  | "view:all_documents"
  | "view:own_documents"
  | "upload:documents"
  | "delete:documents"
  | "view:brokerage_financials"
  | "view:team_financials"
  | "view:own_financials"
  | "view:all_listings"
  | "view:own_listings"
  | "create:listings"
  | "edit:all_listings"
  | "edit:own_listings"
  | "approve:listings"
  | "distribute:listings"
  | "view:all_users"
  | "create:users"
  | "edit:users"
  | "delete:users"
  | "manage:roles"
  | "view:system_health"
  | "view:system_config"
  | "edit:system_config"
  | "view:ai_audit"
  | "view:compliance"
  | "manage:compliance"
  | "view:marketing_studio"
  | "view:social_scheduler"
  | "post:social_media"
  | "view:all_badges"
  | "view:own_badges"
  | "award:badges"
  | "view:own_sphere"
  | "view:team_sphere"
  | "edit:sphere"
  | "view:all_showings"
  | "view:own_showings"
  | "manage:showings"
  | "view:all_open_houses"
  | "view:own_open_houses"
  | "manage:open_houses"
  | "view:crm"
  | "use:ai_tools"
  | "view:map_intelligence"
  | "view:knowledge_base"
  | "view:ai_chat"
  | "use:ai_suggestions"
  | "view:partners"
  | "manage:partners"
  | "view:vendors"
  | "manage:vendors"

// ─── USER ACCESS CONTEXT ──────────────────────────────────────────────────────

export type UserSubType =
  | "agent"
  | "team_lead"
  | "buyer"
  | "seller"
  | "investor"
  | "vendor"
  | "lender"
  | "inspector"
  | "appraiser"
  | "title_officer"
  | "escrow_officer"
  | "transaction_coordinator"
  | "compliance_manager"
  | "marketing_coordinator"

export interface UserAccessContext {
  userId: string
  role: UserRole
  subType?: UserSubType
  agentId?: string
  contactId?: string
  vendorId?: string
  teamId?: string
  teamIds?: string[]
  brokerageId?: string
  managedAgentIds?: string[]
}

// ─── ROLE → PERMISSION MAP ────────────────────────────────────────────────────

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.ADMIN]: [
    "view:admin_dashboard", "view:broker_dashboard", "view:agent_dashboard",
    "view:lead_intelligence", "view:lead_insights", "view:lead_scraping_config", "manage:lead_scraping",
    "view:all_contacts", "edit:all_contacts", "delete:contacts",
    "view:all_transactions", "edit:all_transactions",
    "view:all_communications", "send:communications", "send:ai_chat_messages",
    "view:all_documents", "upload:documents", "delete:documents",
    "view:brokerage_financials", "view:team_financials", "view:own_financials",
    "view:all_listings", "create:listings", "edit:all_listings", "approve:listings", "distribute:listings",
    "view:all_users", "create:users", "edit:users", "delete:users", "manage:roles",
    "view:system_health", "view:system_config", "edit:system_config",
    "view:ai_audit", "view:compliance", "manage:compliance",
    "view:marketing_studio", "view:social_scheduler", "post:social_media",
    "view:all_badges", "award:badges",
    "view:team_sphere", "edit:sphere",
    "view:all_showings", "manage:showings", "view:all_open_houses", "manage:open_houses",
    "view:crm", "use:ai_tools", "view:map_intelligence", "view:knowledge_base", "view:ai_chat", "use:ai_suggestions",
    "view:partners", "manage:partners", "view:vendors", "manage:vendors",
  ],
  [UserRole.BROKER]: [
    "view:broker_dashboard", "view:agent_dashboard",
    "view:lead_intelligence", "view:lead_insights", "view:lead_scraping_config", "manage:lead_scraping",
    "view:all_contacts", "edit:all_contacts", "delete:contacts",
    "view:all_transactions", "edit:all_transactions",
    "view:all_communications", "send:communications", "send:ai_chat_messages",
    "view:all_documents", "upload:documents", "delete:documents",
    "view:brokerage_financials", "view:team_financials",
    "view:all_listings", "create:listings", "edit:all_listings", "approve:listings", "distribute:listings",
    "view:all_users", "create:users", "edit:users", "manage:roles",
    "view:system_health", "view:system_config",
    "view:ai_audit", "view:compliance", "manage:compliance",
    "view:marketing_studio", "view:social_scheduler", "post:social_media",
    "view:all_badges", "award:badges",
    "view:team_sphere", "edit:sphere",
    "view:all_showings", "manage:showings", "view:all_open_houses", "manage:open_houses",
    "view:crm", "use:ai_tools", "view:map_intelligence", "view:knowledge_base", "view:ai_chat", "use:ai_suggestions",
    "view:partners", "manage:partners", "view:vendors", "manage:vendors",
  ],
  [UserRole.AGENT]: [
    "view:agent_dashboard", "view:lead_intelligence", "view:lead_insights",
    "view:team_contacts", "view:own_contacts", "edit:own_contacts",
    "view:own_transactions", "edit:own_transactions",
    "view:own_communications", "send:communications", "send:ai_chat_messages",
    "view:own_documents", "upload:documents",
    "view:own_financials",
    "view:own_listings", "create:listings", "edit:own_listings",
    "view:marketing_studio", "view:social_scheduler", "post:social_media",
    "view:own_badges", "view:own_sphere", "edit:sphere",
    "view:own_showings", "manage:showings", "view:own_open_houses", "manage:open_houses",
    "view:crm", "use:ai_tools", "view:map_intelligence", "view:knowledge_base", "view:ai_chat", "use:ai_suggestions",
    "view:partners", "view:vendors",
  ],
  [UserRole.TC]: [
    "view:tc_dashboard",
    "view:team_contacts", "edit:team_contacts",
    "view:team_transactions", "edit:all_transactions",
    "view:team_communications", "send:communications",
    "view:all_documents", "upload:documents",
    "view:compliance", "view:knowledge_base",
  ],
  [UserRole.CONTACT]: [
    "view:contact_dashboard", "view:own_contacts",
    "view:own_transactions", "view:own_communications",
    "view:own_documents", "upload:documents", "view:own_listings",
  ],
  [UserRole.VENDOR]: [
    "view:own_contacts", "view:own_transactions",
    "view:own_communications", "view:own_documents", "upload:documents",
  ],
  [UserRole.LENDER]: [
    "view:team_contacts", "view:team_transactions", "view:team_communications",
    "send:communications", "view:own_documents", "upload:documents", "view:knowledge_base",
  ],
  [UserRole.COMPLIANCE_OFFICER]: [
    "view:all_contacts", "view:all_transactions", "view:all_communications",
    "view:all_documents", "view:compliance", "manage:compliance", "view:ai_audit",
  ],
  [UserRole.TEAM_LEADER]: [
    "view:agent_dashboard", "view:lead_intelligence", "view:lead_insights",
    "view:team_contacts", "view:own_contacts", "edit:team_contacts", "edit:own_contacts",
    "view:team_transactions", "view:own_transactions", "edit:own_transactions",
    "view:team_communications", "send:communications", "send:ai_chat_messages",
    "view:all_documents", "upload:documents",
    "view:team_financials", "view:own_financials",
    "view:all_listings", "create:listings", "edit:own_listings",
    "view:marketing_studio", "view:social_scheduler", "post:social_media",
    "view:all_badges", "view:team_sphere", "edit:sphere",
    "view:all_showings", "manage:showings", "view:all_open_houses", "manage:open_houses",
    "view:crm", "use:ai_tools", "view:map_intelligence", "view:knowledge_base", "view:ai_chat", "use:ai_suggestions",
    "view:partners", "view:vendors", "view:compliance",
  ],
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

export const ROLE_NAVIGATION: Record<UserRole, string[]> = {
  [UserRole.ADMIN]: [
    "broker-dashboard", "system-health", "ai-audit",
    "agent-roster", "recruiting-hub", "user-management",
    "crm", "lead-intelligence", "lead-scoring", "lead-distribution", "lead-scraping-config", "segmentation",
    "listing-approvals", "listing-distribution",
    "financials", "conversation-analytics", "data-health",
    "compliance", "risk-management", "vendor-compliance",
    "integrations", "settings", "partners",
  ],
  [UserRole.BROKER]: [
    "broker-dashboard", "system-health", "ai-audit",
    "agent-roster", "recruiting-hub",
    "crm", "lead-intelligence", "lead-scoring", "lead-distribution", "lead-scraping-config", "segmentation",
    "listing-approvals", "listing-distribution",
    "financials", "conversation-analytics", "data-health",
    "compliance", "risk-management", "vendor-compliance",
    "partners",
  ],
  [UserRole.AGENT]: [
    "agent-dashboard", "crm", "transactions", "calendar", "inbox",
    "listing-intake", "oh-manager", "showings", "buyer-tours", "feedback-log",
    "offer-lab", "cma", "closing-dashboard",
    "content-studio", "social-planner", "shareable-assets",
    "ai-tools", "lead-intelligence", "lead-scoring", "ai-isa", "ai-chat", "voice-call-bridge",
    "documents", "sphere", "map-intelligence", "knowledge-base", "events",
    "agent-onboarding", "financials",
  ],
  [UserRole.TC]: [
    "tc-dashboard", "transactions", "inbox", "calendar",
    "documents", "compliance", "closing-dashboard", "knowledge-base",
  ],
  [UserRole.CONTACT]: ["playbook", "documents", "inbox", "calendar", "matches", "marketplace"],
  [UserRole.VENDOR]: ["documents", "inbox", "calendar", "content-studio", "social-planner", "ai-chat"],
  [UserRole.LENDER]: ["documents", "inbox", "calendar", "transactions", "knowledge-base", "content-studio", "social-planner"],
  [UserRole.COMPLIANCE_OFFICER]: [
    "compliance", "documents", "ai-audit", "transactions", "content-studio", "social-planner", "ai-chat",
  ],
  [UserRole.TEAM_LEADER]: [
    "agent-dashboard", "crm", "transactions", "lead-intelligence", "lead-insights", "agent-roster",
    "inbox", "calendar", "financials", "content-studio", "social-planner", "shareable-assets",
    "oh-manager", "showings", "buyer-tours", "feedback-log", "map-intelligence", "knowledge-base",
    "ai-tools", "offer-lab", "documents", "events", "sphere", "listing-intake", "cma",
    "closing-dashboard", "compliance", "notifications", "ai-chat",
  ],
}

// ─── SERVICE ──────────────────────────────────────────────────────────────────

export const permissionsService = {
  hasPermission(role: UserRole, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
  },

  hasAnyPermission(role: UserRole, permissions: Permission[]): boolean {
    return permissions.some((p) => this.hasPermission(role, p))
  },

  hasAllPermissions(role: UserRole, permissions: Permission[]): boolean {
    return permissions.every((p) => this.hasPermission(role, p))
  },

  getPermissions(role: UserRole): Permission[] {
    return ROLE_PERMISSIONS[role] || []
  },

  getNavigationItems(role: UserRole): string[] {
    return ROLE_NAVIGATION[role] || []
  },

  canAccessView(role: UserRole, view: string): boolean {
    return ROLE_NAVIGATION[role]?.includes(view) ?? false
  },

  getDataScope(role: UserRole): "all" | "team" | "own" {
    if (role === UserRole.ADMIN || role === UserRole.BROKER) return "all"
    if (role === UserRole.AGENT || role === UserRole.TC) return "team"
    return "own"
  },

  canViewContact(role: UserRole, contactAgentId: string, currentUserId: string, teamIds: string[] = []): boolean {
    if (this.hasPermission(role, "view:all_contacts")) return true
    if (this.hasPermission(role, "view:team_contacts") && teamIds.includes(contactAgentId)) return true
    if (this.hasPermission(role, "view:own_contacts") && contactAgentId === currentUserId) return true
    return false
  },

  canEditContact(role: UserRole, contactAgentId: string, currentUserId: string, teamIds: string[] = []): boolean {
    if (this.hasPermission(role, "edit:all_contacts")) return true
    if (this.hasPermission(role, "edit:team_contacts") && teamIds.includes(contactAgentId)) return true
    if (this.hasPermission(role, "edit:own_contacts") && contactAgentId === currentUserId) return true
    return false
  },

  isAdminOrBroker(role: UserRole): boolean {
    return role === UserRole.ADMIN || role === UserRole.BROKER
  },

  isStaff(role: UserRole): boolean {
    return [UserRole.ADMIN, UserRole.BROKER, UserRole.AGENT, UserRole.TC, UserRole.COMPLIANCE_OFFICER].includes(role)
  },

  canAccessRecord(
    ctx: UserAccessContext,
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
    }
  ): boolean {
    if (this.isAdminOrBroker(ctx.role)) return true

    const isOwner =
      record.agent_id === ctx.agentId ||
      record.created_by === ctx.userId ||
      record.contact_id === ctx.contactId

    const isAssigned =
      record.assigned_to?.includes(ctx.userId) ||
      record.assigned_to?.includes(ctx.agentId || "")

    const isSharedWith =
      record.shared_with?.includes(ctx.userId) ||
      record.shared_with?.includes(ctx.contactId || "")

    if (ctx.role === UserRole.AGENT || ctx.role === UserRole.TC) {
      const isTeamRecord =
        ctx.teamIds?.includes(record.team_id || "") ||
        ctx.teamIds?.includes(record.agent_id || "") ||
        ctx.managedAgentIds?.includes(record.agent_id || "")
      return isOwner || isAssigned || !!isTeamRecord || isSharedWith
    }

    if (ctx.role === UserRole.CONTACT) {
      return (
        record.contact_id === ctx.contactId ||
        record.buyer_id === ctx.contactId ||
        record.seller_id === ctx.contactId ||
        isSharedWith
      )
    }

    if (ctx.role === UserRole.VENDOR) return record.vendor_id === ctx.vendorId || isAssigned || isSharedWith
    if (ctx.role === UserRole.LENDER) return isAssigned || isSharedWith

    return false
  },

  getQueryFilters(ctx: UserAccessContext): Record<string, any> {
    if (this.isAdminOrBroker(ctx.role)) return ctx.brokerageId ? { brokerage_id: ctx.brokerageId } : {}
    if (ctx.role === UserRole.AGENT) return { agent_id: ctx.agentId }
    if (ctx.role === UserRole.TC) return { team_id: ctx.teamIds }
    if (ctx.role === UserRole.CONTACT) return { contact_id: ctx.contactId }
    if (ctx.role === UserRole.VENDOR) return { vendor_id: ctx.vendorId }
    if (ctx.role === UserRole.LENDER) return { lender_id: ctx.userId }
    return {}
  },

  canPerformAction(
    ctx: UserAccessContext,
    action: "view" | "edit" | "delete" | "share",
    entityType: string,
    entityOwnerId?: string,
    entityTeamId?: string
  ): boolean {
    const permissionMap: Record<string, Record<string, Permission>> = {
      contact: { view: "view:own_contacts", edit: "edit:own_contacts", delete: "delete:contacts" },
      transaction: { view: "view:own_transactions", edit: "edit:own_transactions" },
      listing: { view: "view:own_listings", edit: "edit:own_listings" },
      document: { view: "view:own_documents", delete: "delete:documents" },
      ai_chat: { view: "view:ai_chat", send: "send:ai_chat_messages", use: "use:ai_suggestions" },
    }

    const basePermission = permissionMap[entityType]?.[action]
    if (!basePermission) return false

    if (this.isAdminOrBroker(ctx.role)) return true

    if (this.hasPermission(ctx.role, basePermission)) {
      if (entityOwnerId === ctx.userId || entityOwnerId === ctx.agentId || entityOwnerId === ctx.contactId) return true
      if (entityTeamId && ctx.teamIds?.includes(entityTeamId)) return true
      if (entityOwnerId && ctx.managedAgentIds?.includes(entityOwnerId)) return true
    }

    return false
  },
}

export default permissionsService
