"use client"

import { UserRole } from "../types"
import { supabaseService } from "./supabaseService"
import { permissionsService } from "./permissionsService"
import type { UserAccessContext } from "./permissionsService"

export type { UserAccessContext }

/**
 * Role-Based Data Access Service
 * Wraps supabaseService with permission checks and user-specific data filtering
 */
export const dataAccessService = {
  // =====================================================
  // CONTACTS
  // =====================================================

  async getContacts(ctx: UserAccessContext) {
    const allContacts = await supabaseService.getContacts()

    // Admin/Broker: See all contacts in their brokerage
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return ctx.brokerageId
        ? allContacts.filter((c: any) => c.brokerage_id === ctx.brokerageId || !c.brokerage_id)
        : allContacts
    }

    // Agent: See only contacts assigned to them
    if (ctx.role === UserRole.AGENT) {
      return allContacts.filter((c: any) => c.agent_id === ctx.agentId || c.assigned_agents?.includes(ctx.agentId))
    }

    // TC: See contacts for transactions they manage
    if (ctx.role === UserRole.TC) {
      return allContacts.filter(
        (c: any) => ctx.teamIds?.includes(c.agent_id) || ctx.managedAgentIds?.includes(c.agent_id),
      )
    }

    // Contact: Only see their own profile
    if (ctx.role === UserRole.CONTACT && ctx.contactId) {
      return allContacts.filter((c: any) => c.id === ctx.contactId)
    }

    // Vendor: See contacts they're working with
    if (ctx.role === UserRole.VENDOR && ctx.vendorId) {
      return allContacts.filter(
        (c: any) => c.vendor_ids?.includes(ctx.vendorId) || c.assigned_vendors?.includes(ctx.vendorId),
      )
    }

    // Lender: See contacts on their transactions
    if (ctx.role === UserRole.LENDER) {
      return allContacts.filter((c: any) => c.lender_id === ctx.userId)
    }

    return []
  },

  async getContactById(ctx: UserAccessContext, contactId: string) {
    const contact = await supabaseService.getContactById(contactId)
    if (!contact) return null

    // Check if user can view this contact
    const canView = permissionsService.canAccessRecord(ctx, "contact", contact as any)

    if (!canView && ctx.contactId !== contactId) {
      console.warn("[DataAccess] User not authorized to view contact:", contactId)
      return null
    }

    return contact
  },

  async updateContact(ctx: UserAccessContext, contactId: string, updates: any) {
    const contact = await supabaseService.getContactById(contactId)
    if (!contact) return null

    // Check if user can edit this contact
    const canEdit = permissionsService.canPerformAction(ctx, "edit", "contact", (contact as any).agent_id)

    if (!canEdit) {
      console.warn("[DataAccess] User not authorized to edit contact:", contactId)
      return null
    }

    return supabaseService.updateContact(contactId, updates)
  },

  // =====================================================
  // TRANSACTIONS
  // =====================================================

  async getTransactions(ctx: UserAccessContext) {
    const allTransactions = await supabaseService.getTransactions()

    // Admin/Broker: See all transactions in their brokerage
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return ctx.brokerageId
        ? allTransactions.filter((t: any) => t.brokerage_id === ctx.brokerageId || !t.brokerage_id)
        : allTransactions
    }

    // Agent: See only their transactions
    if (ctx.role === UserRole.AGENT) {
      return allTransactions.filter(
        (t: any) =>
          t.agent_id === ctx.agentId ||
          t.listing_agent_id === ctx.agentId ||
          t.buying_agent_id === ctx.agentId ||
          t.co_agent_id === ctx.agentId,
      )
    }

    // TC: See transactions they're coordinating
    if (ctx.role === UserRole.TC) {
      return allTransactions.filter(
        (t: any) =>
          t.tc_id === ctx.userId ||
          t.transaction_coordinator_id === ctx.userId ||
          ctx.managedAgentIds?.includes(t.agent_id),
      )
    }

    // Contact: See transactions they're part of
    if (ctx.role === UserRole.CONTACT && ctx.contactId) {
      return allTransactions.filter(
        (t: any) => t.buyer_id === ctx.contactId || t.seller_id === ctx.contactId || t.client_id === ctx.contactId,
      )
    }

    // Vendor: See transactions they're assigned to
    if (ctx.role === UserRole.VENDOR && ctx.vendorId) {
      return allTransactions.filter(
        (t: any) =>
          t.vendor_ids?.includes(ctx.vendorId) ||
          t.inspector_id === ctx.vendorId ||
          t.appraiser_id === ctx.vendorId ||
          t.title_company_id === ctx.vendorId ||
          t.escrow_company_id === ctx.vendorId,
      )
    }

    // Lender: See transactions they're financing
    if (ctx.role === UserRole.LENDER) {
      return allTransactions.filter((t: any) => t.lender_id === ctx.userId || t.loan_officer_id === ctx.userId)
    }

    // Compliance Officer: See all for review
    if (ctx.role === UserRole.COMPLIANCE_OFFICER) {
      return allTransactions
    }

    return []
  },

  async getTransactionById(ctx: UserAccessContext, transactionId: string) {
    const transaction = await supabaseService.getTransactionById(transactionId)
    if (!transaction) return null

    // Check if user can access this transaction
    const canAccess = permissionsService.canAccessRecord(ctx, "transaction", transaction as any)

    if (!canAccess) {
      console.warn("[DataAccess] User not authorized to view transaction:", transactionId)
      return null
    }

    return transaction
  },

  // =====================================================
  // LISTINGS
  // =====================================================

  async getListings(ctx: UserAccessContext) {
    const allListings = await supabaseService.getListings()

    // Admin/Broker: See all listings
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return allListings
    }

    // Agent: See only their listings
    if (ctx.role === UserRole.AGENT) {
      return allListings.filter(
        (l: any) =>
          l.agent_id === ctx.agentId || l.listing_agent_id === ctx.agentId || l.co_listing_agent_id === ctx.agentId,
      )
    }

    // Contact (Seller): See their own listings
    if (ctx.role === UserRole.CONTACT && ctx.contactId) {
      return allListings.filter((l: any) => l.seller_id === ctx.contactId)
    }

    return []
  },

  // =====================================================
  // COMMUNICATIONS
  // =====================================================

  async getCommunications(ctx: UserAccessContext, contactId?: string) {
    const communications = await supabaseService.getCommunicationHistory(contactId)

    // Admin/Broker: See all communications
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return communications
    }

    // Agent: See communications for their contacts
    if (ctx.role === UserRole.AGENT) {
      return communications.filter(
        (c: any) => c.agent_id === ctx.agentId || c.sender_id === ctx.userId || c.recipient_id === ctx.userId,
      )
    }

    // TC: See communications for managed transactions
    if (ctx.role === UserRole.TC) {
      return communications.filter(
        (c: any) =>
          ctx.managedAgentIds?.includes(c.agent_id) || c.sender_id === ctx.userId || c.recipient_id === ctx.userId,
      )
    }

    // Contact: Only see their own communications
    if (ctx.role === UserRole.CONTACT && ctx.contactId) {
      return communications.filter(
        (c: any) => c.contact_id === ctx.contactId || c.sender_id === ctx.contactId || c.recipient_id === ctx.contactId,
      )
    }

    // Vendor: See communications shared with them
    if (ctx.role === UserRole.VENDOR) {
      return communications.filter(
        (c: any) =>
          c.vendor_id === ctx.vendorId || c.shared_with?.includes(ctx.vendorId) || c.shared_with?.includes(ctx.userId),
      )
    }

    // Lender: See loan-related communications
    if (ctx.role === UserRole.LENDER) {
      return communications.filter(
        (c: any) =>
          c.lender_id === ctx.userId ||
          c.shared_with?.includes(ctx.userId) ||
          c.document_type === "loan" ||
          c.document_type === "pre_approval",
      )
    }

    return []
  },

  // =====================================================
  // DOCUMENTS
  // =====================================================

  async getDocuments(ctx: UserAccessContext, entityId?: string) {
    const documents = await supabaseService.getDocuments(entityId)

    // Admin/Broker: See all documents
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return documents
    }

    // Agent: See documents for their contacts/transactions
    if (ctx.role === UserRole.AGENT) {
      return documents.filter(
        (d: any) =>
          d.agent_id === ctx.agentId ||
          d.uploaded_by === ctx.userId ||
          d.shared_with?.includes(ctx.userId) ||
          d.shared_with?.includes(ctx.agentId),
      )
    }

    // TC: See documents for managed transactions
    if (ctx.role === UserRole.TC) {
      return documents.filter(
        (d: any) =>
          ctx.managedAgentIds?.includes(d.agent_id) ||
          d.uploaded_by === ctx.userId ||
          d.shared_with?.includes(ctx.userId),
      )
    }

    // Contact: Only see their own documents
    if (ctx.role === UserRole.CONTACT && ctx.contactId) {
      return documents.filter(
        (d: any) =>
          d.contact_id === ctx.contactId || d.uploaded_by === ctx.contactId || d.shared_with?.includes(ctx.contactId),
      )
    }

    // Vendor: See documents shared with them
    if (ctx.role === UserRole.VENDOR) {
      return documents.filter(
        (d: any) =>
          d.vendor_id === ctx.vendorId || d.shared_with?.includes(ctx.vendorId) || d.shared_with?.includes(ctx.userId),
      )
    }

    // Lender: See loan-related documents
    if (ctx.role === UserRole.LENDER) {
      return documents.filter(
        (d: any) =>
          d.lender_id === ctx.userId ||
          d.shared_with?.includes(ctx.userId) ||
          d.document_type === "loan" ||
          d.document_type === "pre_approval",
      )
    }

    return []
  },

  // =====================================================
  // FINANCIALS
  // =====================================================

  async getFinancials(ctx: UserAccessContext, type: string) {
    const financials = await supabaseService.getFinancials(type)

    // Admin/Broker: See all financials
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return financials
    }

    // Agent: See only their own financials
    if (ctx.role === UserRole.AGENT && ctx.agentId) {
      return financials.filter((f: any) => f.agent_id === ctx.agentId)
    }

    // TC: See financials for their managed transactions
    if (ctx.role === UserRole.TC) {
      return financials.filter((f: any) => ctx.managedAgentIds?.includes(f.agent_id))
    }

    // Other roles don't see financials
    return []
  },

  // =====================================================
  // GAMIFICATION & BADGES
  // =====================================================

  async getBadges(ctx: UserAccessContext) {
    // Admin/Broker: See all badges
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return supabaseService.getBadges?.() || []
    }

    // Agent: See only their own badges
    if (ctx.role === UserRole.AGENT && ctx.agentId) {
      return supabaseService.getBadges?.(ctx.agentId) || []
    }

    // Others: See own badges by userId
    return supabaseService.getBadges?.(ctx.userId) || []
  },

  async getLeaderboard(ctx: UserAccessContext) {
    // Admin/Broker: See full leaderboard
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return supabaseService.getLeaderboard?.() || []
    }

    // Agent: See leaderboard with limited info
    if (ctx.role === UserRole.AGENT) {
      const leaderboard = (await supabaseService.getLeaderboard?.()) || []
      // Highlight own position
      return leaderboard.map((entry: any) => ({
        ...entry,
        isCurrentUser: entry.agent_id === ctx.agentId,
      }))
    }

    return []
  },

  // =====================================================
  // SHOWINGS & OPEN HOUSES
  // =====================================================

  async getShowings(ctx: UserAccessContext) {
    const showings = await supabaseService.getShowings()

    // Admin/Broker: See all showings
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return showings
    }

    // Agent: See their showings
    if (ctx.role === UserRole.AGENT) {
      return showings.filter((s: any) => s.agent_id === ctx.agentId || s.showing_agent_id === ctx.agentId)
    }

    // Contact (Buyer): See showings they're attending
    if (ctx.role === UserRole.CONTACT && ctx.contactId) {
      return showings.filter((s: any) => s.contact_id === ctx.contactId)
    }

    return []
  },

  async getOpenHouses(ctx: UserAccessContext) {
    const scope = permissionsService.getDataScope(ctx.role)

    try {
      const openHouses = await supabaseService.getOpenHouses(
        scope === "team" || scope === "own" ? ctx.agentId : undefined,
      )

      return openHouses
    } catch (error) {
      console.error("[DataAccess] Error fetching open houses:", error)
      return []
    }
  },

  // =====================================================
  // SPHERE / SOI
  // =====================================================

  async getSphere(ctx: UserAccessContext) {
    // Admin/Broker: See all sphere data
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return supabaseService.getSphere?.() || []
    }

    // Agent: See only their sphere
    if (ctx.role === UserRole.AGENT && ctx.agentId) {
      return supabaseService.getSphere?.(ctx.agentId) || []
    }

    return []
  },

  // =====================================================
  // USERS
  // =====================================================

  async getUsers(ctx: UserAccessContext, userType?: string) {
    // Admin/Broker: See all users
    if (permissionsService.isAdminOrBroker(ctx.role)) {
      return supabaseService.getUsers(userType)
    }

    // TC: See agents they work with
    if (ctx.role === UserRole.TC) {
      const users = await supabaseService.getUsers(userType)
      return users.filter((u: any) => ctx.managedAgentIds?.includes(u.id) || u.id === ctx.userId)
    }

    // Others: Only see limited public info
    const users = await supabaseService.getUsers(userType)
    return users.map((u: any) => ({
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      user_type: u.user_type,
      // Exclude sensitive fields like email, phone for non-admins
    }))
  },

  // =====================================================
  // HELPER: Build context from auth state
  // =====================================================

  buildContextFromUser(user: any): UserAccessContext {
    return {
      userId: user.id,
      role: user.user_type || user.role,
      subType: user.sub_type,
      agentId: user.agent_id || (user.user_type === "agent" ? user.id : undefined),
      contactId: user.contact_id || (user.user_type === "contact" ? user.id : undefined),
      vendorId: user.vendor_id || (user.user_type === "vendor" ? user.id : undefined),
      teamId: user.team_id,
      teamIds: user.team_ids || (user.team_id ? [user.team_id] : []),
      brokerageId: user.brokerage_id,
      managedAgentIds: user.managed_agent_ids || [],
    }
  },
}

export default dataAccessService
