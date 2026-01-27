"use client"

import { UserRole } from "../types"

// Define all possible permissions in the system
export type Permission =
  // Dashboard access
  | "view:admin_dashboard"
  | "view:broker_dashboard"
  | "view:agent_dashboard"
  | "view:contact_dashboard"
  | "view:tc_dashboard"

  // Lead intelligence
  | "view:lead_intelligence"
  | "view:lead_insights"
  | "view:lead_scraping_config"
  | "manage:lead_scraping"

  // Contact/Lead management
  | "view:all_contacts"
  | "view:team_contacts"
  | "view:own_contacts"
  | "edit:all_contacts"
  | "edit:team_contacts"
  | "edit:own_contacts"
  | "delete:contacts"

  // Transaction management
  | "view:all_transactions"
  | "view:team_transactions"
  | "view:own_transactions"
  | "edit:all_transactions"
  | "edit:own_transactions"

  // Communication
  | "view:all_communications"
  | "view:team_communications"
  | "view:own_communications"
  | "send:communications"
  | "send:ai_chat_messages"

  // Documents
  | "view:all_documents"
  | "view:own_documents"
  | "upload:documents"
  | "delete:documents"

  // Financials
  | "view:brokerage_financials"
  | "view:team_financials"
  | "view:own_financials"

  // Listings
  | "view:all_listings"
  | "view:own_listings"
  | "create:listings"
  | "edit:all_listings"
  | "edit:own_listings"
  | "approve:listings"
  | "distribute:listings"

  // User management
  | "view:all_users"
  | "create:users"
  | "edit:users"
  | "delete:users"
  | "manage:roles"

  // System administration
  | "view:system_health"
  | "view:system_config"
  | "edit:system_config"
  | "view:ai_audit"
  | "view:compliance"
  | "manage:compliance"

  // Marketing & Social
  | "view:marketing_studio"
  | "view:social_scheduler"
  | "post:social_media"

  // Gamification & Badges
  | "view:all_badges"
  | "view:own_badges"
  | "award:badges"

  // Sphere/SOI
  | "view:own_sphere"
  | "view:team_sphere"
  | "edit:sphere"

  // Showings & Open Houses
  | "view:all_showings"
  | "view:own_showings"
  | "manage:showings"
  | "view:all_open_houses"
  | "view:own_open_houses"
  | "manage:open_houses"

  // CRM features
  | "view:crm"
  | "use:ai_tools"
  | "view:map_intelligence"
  | "view:knowledge_base"
  | "view:ai_chat"
  | "use:ai_suggestions"

  // Partners & Vendors
  | "view:partners"
  | "manage:partners"
  | "view:vendors"
  | "manage:vendors"

// Role-based permission mappings
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.ADMIN]: [
    // Admins have ALL permissions
    "view:admin_dashboard",
    "view:broker_dashboard",
    "view:agent_dashboard",
    "view:lead_intelligence",
    "view:lead_insights",
    "view:lead_scraping_config",
    "manage:lead_scraping",
    "view:all_contacts",
    "edit:all_contacts",
    "delete:contacts",
    "view:all_transactions",
    "edit:all_transactions",
    "view:all_communications",
    "send:communications",
    "send:ai_chat_messages",
    "view:all_documents",
    "upload:documents",
    "delete:documents",
    "view:brokerage_financials",
    "view:team_financials",
    "view:own_financials",
    "view:all_listings",
    "create:listings",
    "edit:all_listings",
    "approve:listings",
    "distribute:listings",
    "view:all_users",
    "create:users",
    "edit:users",
    "delete:users",
    "manage:roles",
    "view:system_health",
    "view:system_config",
    "edit:system_config",
    "view:ai_audit",
    "view:compliance",
    "manage:compliance",
    "view:marketing_studio",
    "view:social_scheduler",
    "post:social_media",
    "view:all_badges",
    "award:badges",
    "view:team_sphere",
    "edit:sphere",
    "view:all_showings",
    "manage:showings",
    "view:all_open_houses",
    "manage:open_houses",
    "view:crm",
    "use:ai_tools",
    "view:map_intelligence",
    "view:knowledge_base",
    "view:ai_chat",
    "use:ai_suggestions",
    "view:partners",
    "manage:partners",
    "view:vendors",
    "manage:vendors",
  ],

  [UserRole.BROKER]: [
    // Brokers have almost all permissions except system config editing
    "view:broker_dashboard",
    "view:agent_dashboard",
    "view:lead_intelligence",
    "view:lead_insights",
    "view:lead_scraping_config",
    "manage:lead_scraping",
    "view:all_contacts",
    "edit:all_contacts",
    "delete:contacts",
    "view:all_transactions",
    "edit:all_transactions",
    "view:all_communications",
    "send:communications",
    "send:ai_chat_messages",
    "view:all_documents",
    "upload:documents",
    "delete:documents",
    "view:brokerage_financials",
    "view:team_financials",
    "view:all_listings",
    "create:listings",
    "edit:all_listings",
    "approve:listings",
    "distribute:listings",
    "view:all_users",
    "create:users",
    "edit:users",
    "manage:roles",
    "view:system_health",
    "view:system_config",
    "view:ai_audit",
    "view:compliance",
    "manage:compliance",
    "view:marketing_studio",
    "view:social_scheduler",
    "post:social_media",
    "view:all_badges",
    "award:badges",
    "view:team_sphere",
    "edit:sphere",
    "view:all_showings",
    "manage:showings",
    "view:all_open_houses",
    "manage:open_houses",
    "view:crm",
    "use:ai_tools",
    "view:map_intelligence",
    "view:knowledge_base",
    "view:ai_chat",
    "use:ai_suggestions",
    "view:partners",
    "manage:partners",
    "view:vendors",
    "manage:vendors",
  ],

  [UserRole.AGENT]: [
    // Agents see their own data and team data where applicable
    "view:agent_dashboard",
    "view:lead_intelligence",
    "view:lead_insights",
    "view:team_contacts",
    "view:own_contacts",
    "edit:own_contacts",
    "view:own_transactions",
    "edit:own_transactions",
    "view:own_communications",
    "send:communications",
    "send:ai_chat_messages",
    "view:own_documents",
    "upload:documents",
    "view:own_financials",
    "view:own_listings",
    "create:listings",
    "edit:own_listings",
    "view:marketing_studio",
    "view:social_scheduler",
    "post:social_media",
    "view:own_badges",
    "view:own_sphere",
    "edit:sphere",
    "view:own_showings",
    "manage:showings",
    "view:own_open_houses",
    "manage:open_houses",
    "view:crm",
    "use:ai_tools",
    "view:map_intelligence",
    "view:knowledge_base",
    "view:ai_chat",
    "use:ai_suggestions",
    "view:partners",
    "view:vendors",
  ],

  [UserRole.TC]: [
    // Transaction Coordinators see transaction-related data
    "view:tc_dashboard",
    "view:team_contacts",
    "edit:team_contacts",
    "view:team_transactions",
    "edit:all_transactions",
    "view:team_communications",
    "send:communications",
    "view:all_documents",
    "upload:documents",
    "view:compliance",
    "view:knowledge_base",
  ],

  [UserRole.CONTACT]: [
    // Contacts (buyers/sellers) only see their own information
    "view:contact_dashboard",
    "view:own_contacts", // Their own profile
    "view:own_transactions",
    "view:own_communications",
    "view:own_documents",
    "upload:documents",
    "view:own_listings", // Listings they're associated with
  ],

  [UserRole.VENDOR]: [
    "view:own_contacts",
    "view:own_transactions",
    "view:own_communications",
    "view:own_documents",
    "upload:documents",
  ],

  [UserRole.LENDER]: [
    "view:team_contacts",
    "view:team_transactions",
    "view:team_communications",
    "send:communications",
    "view:own_documents",
    "upload:documents",
    "view:knowledge_base",
  ],

  [UserRole.COMPLIANCE_OFFICER]: [
    "view:all_contacts",
    "view:all_transactions",
    "view:all_communications",
    "view:all_documents",
    "view:compliance",
    "manage:compliance",
    "view:ai_audit",
  ],

  [UserRole.TEAM_LEADER]: [
    // Team leaders see their team's data and have elevated permissions
    "view:agent_dashboard",
    "view:lead_intelligence",
    "view:lead_insights",
    "view:team_contacts",
    "view:own_contacts",
    "edit:team_contacts",
    "edit:own_contacts",
    "view:team_transactions",
    "view:own_transactions",
    "edit:own_transactions",
    "view:team_communications",
    "send:communications",
    "send:ai_chat_messages",
    "view:all_documents",
    "upload:documents",
    "view:team_financials",
    "view:own_financials",
    "view:all_listings",
    "create:listings",
    "edit:own_listings",
    "view:marketing_studio",
    "view:social_scheduler",
    "post:social_media",
    "view:all_badges",
    "view:team_sphere",
    "edit:sphere",
    "view:all_showings",
    "manage:showings",
    "view:all_open_houses",
    "manage:open_houses",
    "view:crm",
    "use:ai_tools",
    "view:map_intelligence",
    "view:knowledge_base",
    "view:ai_chat",
    "use:ai_suggestions",
    "view:partners",
    "view:vendors",
    "view:compliance",
  ],
}

// Navigation items that each role can see
export const ROLE_NAVIGATION: Record<UserRole, string[]> = {
  [UserRole.ADMIN]: [
    // Dashboard & Overview
    "broker-dashboard",
    "system-health",
    "ai-audit",
    
    // Team Management
    "agent-roster",
    "recruiting-hub",
    "user-management",
    
    // Lead & Contact Management
    "crm",
    "lead-intelligence",
    "lead-scoring",
    "lead-distribution",
    "lead-scraping-config",
    "segmentation",
    
    // Listing Operations
    "listing-approvals",
    "listing-distribution",
    
    // Analytics & Reporting
    "financials",
    "conversation-analytics",
    "data-health",
    
    // Compliance & Risk
    "compliance",
    "risk-management",
    "vendor-compliance",
    
    // System & Settings
    "integrations",
    "settings",
    "partners",
  ],
  
  [UserRole.BROKER]: [
    // Dashboard & Overview
    "broker-dashboard",
    "system-health",
    "ai-audit",
    
    // Team Management
    "agent-roster",
    "recruiting-hub",
    
    // Lead & Contact Management
    "crm",
    "lead-intelligence",
    "lead-scoring",
    "lead-distribution",
    "lead-scraping-config",
    "segmentation",
    
    // Listing Operations
    "listing-approvals",
    "listing-distribution",
    
    // Analytics & Reporting
    "financials",
    "conversation-analytics",
    "data-health",
    
    // Compliance & Risk
    "compliance",
    "risk-management",
    "vendor-compliance",
    
    // Partners
    "partners",
  ],

  [UserRole.AGENT]: [
    // Dashboard
    "agent-dashboard",
    
    // Core Workflow
    "crm",
    "transactions",
    "calendar",
    "inbox",
    
    // Listings & Showings
    "listing-intake",
    "oh-manager",
    "showings",
    "buyer-tours",
    "feedback-log",
    
    // Client Tools
    "offer-lab",
    "cma",
    "closing-dashboard",
    
    // Marketing & Content
    "content-studio",
    "social-planner",
    "shareable-assets",
    
    // AI & Intelligence
    "ai-tools",
    "lead-intelligence",
    "lead-scoring",
    "ai-isa",
    "ai-chat",
    "voice-call-bridge",
    
    // Resources
    "documents",
    "sphere",
    "map-intelligence",
    "knowledge-base",
    "events",
    
    // Personal
    "agent-onboarding",
    "financials",
  ],

  [UserRole.TC]: [
    "tc-dashboard",
    "transactions",
    "inbox",
    "calendar",
    "documents",
    "compliance",
    "closing-dashboard",
    "knowledge-base",
  ],

  [UserRole.CONTACT]: [
    // Contacts get persona-specific dashboards, not navigation
    "playbook",
    "documents",
    "inbox",
    "calendar",
    "matches",
    "marketplace",
  ],

  [UserRole.VENDOR]: ["documents", "inbox", "calendar", "content-studio", "social-planner", "ai-chat"],

  [UserRole.LENDER]: [
    "documents",
    "inbox",
    "calendar",
    "transactions",
    "knowledge-base",
    "content-studio",
    "social-planner",
  ],

  [UserRole.COMPLIANCE_OFFICER]: [
    "compliance",
    "documents",
    "ai-audit",
    "transactions",
    "content-studio",
    "social-planner",
    "ai-chat",
  ],

  [UserRole.TEAM_LEADER]: [
    "agent-dashboard",
    "crm",
    "transactions",
    "lead-intelligence",
    "lead-insights",
    "agent-roster",
    "inbox",
    "calendar",
    "financials",
    "content-studio",
    "social-planner",
    "shareable-assets",
    "oh-manager",
    "showings",
    "buyer-tours",
    "feedback-log",
    "map-intelligence",
    "knowledge-base",
    "ai-tools",
    "offer-lab",
    "documents",
    "events",
    "sphere",
    "listing-intake",
    "cma",
    "closing-dashboard",
    "compliance",
    "notifications",
    "ai-chat",
  ],
}

// More granular user types for detailed access control
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
  userId: string // The authenticated user's ID
  role: UserRole // Primary role (admin, broker, agent, contact, etc.)
  subType?: UserSubType // More specific role within the primary role
  agentId?: string // If user is an agent, their agent record ID
  contactId?: string // If user is a contact, their contact record ID
  vendorId?: string // If user is a vendor, their vendor record ID
  teamId?: string // Team the user belongs to
  teamIds?: string[] // Multiple teams (for TCs managing multiple teams)
  brokerageId?: string // Brokerage the user belongs to
  managedAgentIds?: string[] // For team leads/brokers: agents they manage
}

// Permission checking utilities
export const permissionsService = {
  // Check if a role has a specific permission
  hasPermission(role: UserRole, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
  },

  // Check if a role has any of the given permissions
  hasAnyPermission(role: UserRole, permissions: Permission[]): boolean {
    return permissions.some((p) => this.hasPermission(role, p))
  },

  // Check if a role has all of the given permissions
  hasAllPermissions(role: UserRole, permissions: Permission[]): boolean {
    return permissions.every((p) => this.hasPermission(role, p))
  },

  // Get all permissions for a role
  getPermissions(role: UserRole): Permission[] {
    return ROLE_PERMISSIONS[role] || []
  },

  // Get navigation items for a role
  getNavigationItems(role: UserRole): string[] {
    return ROLE_NAVIGATION[role] || []
  },

  // Check if user can view a specific navigation item
  canAccessView(role: UserRole, view: string): boolean {
    return ROLE_NAVIGATION[role]?.includes(view) ?? false
  },

  // Determine data access scope based on role
  getDataScope(role: UserRole): "all" | "team" | "own" {
    if (role === UserRole.ADMIN || role === UserRole.BROKER) {
      return "all"
    }
    if (role === UserRole.AGENT || role === UserRole.TC) {
      return "team"
    }
    return "own"
  },

  // Check if user can view specific contact
  canViewContact(role: UserRole, contactAgentId: string, currentUserId: string, teamIds: string[] = []): boolean {
    if (this.hasPermission(role, "view:all_contacts")) return true
    if (this.hasPermission(role, "view:team_contacts") && teamIds.includes(contactAgentId)) return true
    if (this.hasPermission(role, "view:own_contacts") && contactAgentId === currentUserId) return true
    return false
  },

  // Check if user can edit specific contact
  canEditContact(role: UserRole, contactAgentId: string, currentUserId: string, teamIds: string[] = []): boolean {
    if (this.hasPermission(role, "edit:all_contacts")) return true
    if (this.hasPermission(role, "edit:team_contacts") && teamIds.includes(contactAgentId)) return true
    if (this.hasPermission(role, "edit:own_contacts") && contactAgentId === currentUserId) return true
    return false
  },

  // Check if user is admin or broker
  isAdminOrBroker(role: UserRole): boolean {
    return role === UserRole.ADMIN || role === UserRole.BROKER
  },

  // Check if user is a staff member (not a contact)
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
    },
  ): boolean {
    // Admin/Broker can access all records within their brokerage
    if (this.isAdminOrBroker(ctx.role)) {
      return true
    }

    // Check if user owns or is assigned to the record
    const isOwner =
      record.agent_id === ctx.agentId || record.created_by === ctx.userId || record.contact_id === ctx.contactId

    const isAssigned = record.assigned_to?.includes(ctx.userId) || record.assigned_to?.includes(ctx.agentId || "")

    const isSharedWith = record.shared_with?.includes(ctx.userId) || record.shared_with?.includes(ctx.contactId || "")

    // Agent/TC: Can access if they own, are assigned, or it's on their team
    if (ctx.role === UserRole.AGENT || ctx.role === UserRole.TC) {
      const isTeamRecord =
        ctx.teamIds?.includes(record.team_id || "") ||
        ctx.teamIds?.includes(record.agent_id || "") ||
        ctx.managedAgentIds?.includes(record.agent_id || "")

      return isOwner || isAssigned || isTeamRecord || isSharedWith
    }

    // Contact: Can only access their own records
    if (ctx.role === UserRole.CONTACT) {
      return (
        record.contact_id === ctx.contactId ||
        record.buyer_id === ctx.contactId ||
        record.seller_id === ctx.contactId ||
        isSharedWith
      )
    }

    // Vendor: Can access records they're assigned to
    if (ctx.role === UserRole.VENDOR) {
      return record.vendor_id === ctx.vendorId || isAssigned || isSharedWith
    }

    // Lender: Can access transactions they're attached to
    if (ctx.role === UserRole.LENDER) {
      return isAssigned || isSharedWith
    }

    return false
  },

  getQueryFilters(ctx: UserAccessContext): Record<string, any> {
    if (this.isAdminOrBroker(ctx.role)) {
      // Admin/Broker: Filter by brokerage only
      return ctx.brokerageId ? { brokerage_id: ctx.brokerageId } : {}
    }

    if (ctx.role === UserRole.AGENT) {
      // Agent: Filter by their agent ID
      return { agent_id: ctx.agentId }
    }

    if (ctx.role === UserRole.TC) {
      // TC: Filter by team IDs they manage
      return { team_id: ctx.teamIds }
    }

    if (ctx.role === UserRole.CONTACT) {
      // Contact: Filter by their contact ID
      return { contact_id: ctx.contactId }
    }

    if (ctx.role === UserRole.VENDOR) {
      // Vendor: Filter by their vendor ID
      return { vendor_id: ctx.vendorId }
    }

    if (ctx.role === UserRole.LENDER) {
      // Lender: Filter by assigned transactions
      return { lender_id: ctx.userId }
    }

    return {}
  },

  canPerformAction(
    ctx: UserAccessContext,
    action: "view" | "edit" | "delete" | "share",
    entityType: string,
    entityOwnerId?: string,
    entityTeamId?: string,
  ): boolean {
    const permissionMap: Record<string, Record<string, Permission>> = {
      contact: { view: "view:own_contacts", edit: "edit:own_contacts", delete: "delete:contacts" },
      transaction: { view: "view:own_transactions", edit: "edit:own_transactions" },
      listing: { view: "view:own_listings", edit: "edit:own_listings" },
      document: { view: "view:own_documents", delete: "delete:documents" },
      ai_chat: { view: "view:ai_chat", send: "send:ai_chat_messages", use: "use:ai_suggestions" },
    }

    // Check base permission
    const basePermission = permissionMap[entityType]?.[action]
    if (!basePermission) return false

    // Admin/Broker always has access
    if (this.isAdminOrBroker(ctx.role)) return true

    // Check if user has the permission and owns the entity
    if (this.hasPermission(ctx.role, basePermission)) {
      // Check ownership
      if (entityOwnerId === ctx.userId || entityOwnerId === ctx.agentId || entityOwnerId === ctx.contactId) {
        return true
      }
      // Check team ownership
      if (entityTeamId && ctx.teamIds?.includes(entityTeamId)) {
        return true
      }
      // Check managed agents
      if (entityOwnerId && ctx.managedAgentIds?.includes(entityOwnerId)) {
        return true
      }
    }

    return false
  },
}

export default permissionsService
