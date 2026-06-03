// Comprehensive Supabase Service - Production ready, all data from Supabase
import { createClient } from "@supabase/supabase-js"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Contact } from "@/types/contact"
import { aiMappingService } from "./aiMappingService"

let supabaseInstance: SupabaseClient | null = null

function getSupabaseAdmin() {
  if (supabaseInstance) {
    return supabaseInstance
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase is not configured. Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  }

  supabaseInstance = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  return supabaseInstance
}

// For production: Return empty array when no data found
// Components should handle empty states gracefully

export const supabaseService = {
  // =====================================================
  // HEALTH CHECK
  // =====================================================
  async healthCheck() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("contacts").select("count").limit(1)
      if (error) throw error
      return { success: true, connected: true }
    } catch (error) {
      console.error("[Supabase Service] Health check failed:", error)
      return { success: false, connected: false, error: error instanceof Error ? error.message : "Unknown error" }
    }
  },

  // =====================================================
  // CONTACTS
  // =====================================================

  async getContacts(agentId?: string, brokerageId?: string): Promise<Contact[]> {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("contacts").select("*").is("deleted_at", null)

      // Always scope to brokerage when provided — enforces RLS at the query level
      if (brokerageId) {
        query = query.eq("brokerage_id", brokerageId)
      }

      if (agentId) {
        query = query.eq("agent_id", agentId)
      }

      const { data, error } = await query.order("created_at", { ascending: false })

      if (error) {
        console.error("[Supabase Service] getContacts error:", error)
        if (error.code === "42P01" || error.message?.includes("does not exist")) {
          console.error("[Supabase Service] contacts table doesn't exist - run migrations")
          return []
        }
        throw error
      }

      return (data || []) as Contact[]
    } catch (error) {
      console.error("[Supabase Service] Error fetching contacts:", error)
      return []
    }
  },

  async getAllContacts(): Promise<Contact[]> {
    return this.getContacts()
  },

  async getContactById(id: string): Promise<Contact | null> {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("contacts").select("*").eq("id", id).is("deleted_at", null).single()

      if (error) throw error

      return data as Contact
    } catch (error) {
      console.error("[Supabase Service] Error fetching contact:", error)
      return null
    }
  },

  async createContact(contactData: Partial<Contact>): Promise<Contact | null> {
    try {
      const supabase = getSupabaseAdmin()

      const { incrementUsage } = await import("@/lib/usage")

      // Normalize status and persona using AI mapping
      if (contactData.status) {
        contactData.status = await aiMappingService.mapStatus(contactData.status)
      }
      if (contactData.contact_persona) {
        contactData.contact_persona = await aiMappingService.mapPersona(contactData.contact_persona)
      }

      const { data, error } = await supabase.from("contacts").insert(contactData).select().single()

      if (error) {
        console.error("Error creating contact:", error)
        return null
      }

      if (contactData.brokerage_id) {
        await incrementUsage(contactData.brokerage_id, "contacts_count", 1)
      }

      return data as Contact
    } catch (error) {
      console.error("Error in createContact:", error)
      return null
    }
  },

  async updateContact(id: string, updates: Partial<Contact>): Promise<Contact | null> {
    try {
      const supabase = getSupabaseAdmin()

      // AI-map status if it's being updated
      if (updates.status) {
        updates.status = await aiMappingService.mapStatus(updates.status)
      }

      // AI-map persona if being updated
      if (updates.contact_persona) {
        updates.contact_persona = await aiMappingService.mapPersona(updates.contact_persona)
      }

      const { data, error } = await supabase.from("contacts").update(updates).eq("id", id).select().single()

      if (error) throw error

      return data as Contact
    } catch (error) {
      console.error("[Supabase Service] Error updating contact:", error)
      return null
    }
  },

  async deleteContact(id: string): Promise<boolean> {
    try {
      const supabase = getSupabaseAdmin()
      const { error } = await supabase.from("contacts").update({ deleted_at: new Date().toISOString() }).eq("id", id)

      if (error) throw error

      return true
    } catch (error) {
      console.error("[Supabase Service] Error deleting contact:", error)
      return false
    }
  },

  async getLeads(agentId?: string, brokerageId?: string) {
    return this.getContacts(agentId, brokerageId)
  },

  // =====================================================
  // TRANSACTIONS (DEALS)
  // =====================================================

  async getTransactions(agentId?: string, brokerageId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("transactions").select("*").is("deleted_at", null)

      // Always scope to brokerage when provided — enforces RLS at the query level
      if (brokerageId) {
        query = query.eq("brokerage_id", brokerageId)
      }

      if (agentId) {
        query = query.eq("agent_id", agentId)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching transactions:", error)
      return []
    }
  },

  async getTransactionById(id: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("transactions").select("*").eq("id", id).single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error fetching transaction:", error)
      return null
    }
  },

  async createTransaction(transaction: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("transactions").insert(transaction).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating transaction:", error)
      return null
    }
  },

  async updateTransaction(id: string, updates: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("transactions").update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating transaction:", error)
      return null
    }
  },

  // =====================================================
  // LISTINGS
  // =====================================================

  async getListings(agentId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("listings").select("*").is("deleted_at", null)

      if (agentId) {
        query = query.eq("agent_id", agentId)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching listings:", error)
      return []
    }
  },

  async getListingById(id: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("listings").select("*").eq("id", id).single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error fetching listing:", error)
      return null
    }
  },

  async createListing(listing: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("listings").insert(listing).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating listing:", error)
      return null
    }
  },

  async updateListing(id: string, updates: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("listings").update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating listing:", error)
      return null
    }
  },

  // =====================================================
  // USERS / AGENTS
  // =====================================================

  async getUsers(userType?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("users").select("*").is("deleted_at", null)

      if (userType) {
        query = query.eq("user_type", userType)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching users:", error)
      return []
    }
  },

  async getAgents() {
    return this.getUsers("agent")
  },

  async createUser(user: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("users").insert(user).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating user:", error)
      return null
    }
  },

  async updateUser(id: string, updates: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("users").update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating user:", error)
      return null
    }
  },

  // =====================================================
  // VENDORS
  // =====================================================

  async getVendors(category?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("vendors").select("*")

      if (category) {
        query = query.eq("category", category)
      }

      const { data, error } = await query.order("name", { ascending: true })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching vendors:", error)
      return []
    }
  },

  async createVendor(vendor: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("vendors").insert(vendor).select().single()

      if (error) throw error

      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating vendor:", error)
      return null
    }
  },

  // =====================================================
  // COPILOT PLANS & TASKS
  // =====================================================

  async getCopilotPlans(contactId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("copilot_plans")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })

      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching copilot plans:", error)
      return []
    }
  },

  async createCopilotPlan(plan: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("copilot_plans").insert(plan).select().single()

      if (error) throw error

      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating copilot plan:", error)
      return null
    }
  },

  async getPlanTasks(planId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("plan_tasks")
        .select("*")
        .eq("plan_id", planId)
        .order("due_date", { ascending: true })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching plan tasks:", error)
      return []
    }
  },

  async updatePlanTask(id: string, updates: Record<string, unknown>) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("plan_tasks").update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating plan task:", error)
      return null
    }
  },

  // =====================================================
  // VIDEO ENGAGEMENT & ASSETS — LAYER 8.5
  // Tables: video_engagement_events (raw), video_performance_tracking (aggregates)
  // DO NOT use video_analytics table
  // =====================================================

  async getVideoEngagement(contactId: string) {
    try {
      const supabase = getSupabaseAdmin()
      // Query video_engagement_events (raw event ledger)
      const { data, error } = await supabase
        .from("video_engagement_events")
        .select("*")
        .eq("contact_id", contactId)
        .order("timestamp", { ascending: false })

      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching video engagement:", error)
      return []
    }
  },

  async getVideoPerformanceTracking(filters: { brokerageId?: string; videoAssetId?: string; videoProjectId?: string }) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase
        .from("video_performance_tracking")
        .select("*")
        .order("total_views", { ascending: false })

      if (filters.brokerageId) {
        query = query.eq("brokerage_id", filters.brokerageId)
      }
      if (filters.videoAssetId) {
        query = query.eq("video_asset_id", filters.videoAssetId)
      }
      if (filters.videoProjectId) {
        query = query.eq("video_project_id", filters.videoProjectId)
      }

      const { data, error } = await query
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching video performance tracking:", error)
      return []
    }
  },

  async logVideoEngagement(event: {
    video_asset_id?: string
    contact_id?: string
    event_type: string
    watch_duration_seconds?: number
  }) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("video_engagement_events")
        .insert({
          video_asset_id: event.video_asset_id || null,
          contact_id: event.contact_id || null,
          event_type: event.event_type,
          watch_duration_seconds: event.watch_duration_seconds || 0,
          timestamp: new Date().toISOString(),
        })
        .select()
        .single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error logging video engagement:", error)
      return null
    }
  },

  async getVideoAssets(category?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("video_assets").select("*")

      if (category) {
        query = query.eq("category", category)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching video assets:", error)
      return []
    }
  },

  async createVideoAsset(asset: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("video_assets").insert(asset).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating video asset:", error)
      return null
    }
  },

  // =====================================================
  // CREDIT STATUS & REFERRALS
  // =====================================================

  async getCreditStatus(contactId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("credit_status").select("*").eq("contact_id", contactId).single()

      if (error) {
        if (error.code === "PGRST116") return null // No rows found
        throw error
      }

      return data
    } catch (error) {
      console.error("[Supabase Service] Error fetching credit status:", error)
      return null
    }
  },

  async updateCreditStatus(contactId: string, updates: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("credit_status")
        .upsert({ contact_id: contactId, ...updates })
        .select()
        .single()

      if (error) throw error

      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating credit status:", error)
      return null
    }
  },

  async getCreditReferrals(contactId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("credit_partner_referrals").select("*")

      if (contactId) {
        query = query.eq("contact_id", contactId)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching credit referrals:", error)
      return []
    }
  },

  async createCreditReferral(referral: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("credit_partner_referrals").insert(referral).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating credit referral:", error)
      return null
    }
  },

  // =====================================================
  // JOURNEY & TRANSPARENCY
  // =====================================================

  async getJourneyStateByUserId(userId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("journey_states").select("*").eq("user_id", userId).single()

      if (error) {
        if (error.code === "PGRST116") return null
        throw error
      }

      return data
    } catch (error) {
      console.error("[Supabase Service] Error fetching journey state:", error)
      return null
    }
  },

  async createJourneyState(state: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("journey_states").insert(state).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating journey state:", error)
      return null
    }
  },

  async updateJourneyState(userId: string, updates: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("journey_states")
        .update(updates)
        .eq("user_id", userId)
        .select()
        .single()

      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating journey state:", error)
      return null
    }
  },

  async getBlueprintByPersonaStage(persona: string, stage: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("journey_blueprints")
        .select("*")
        .eq("persona", persona)
        .eq("stage", stage)
        .eq("is_active", true)
        .single()

      if (error) {
        if (error.code === "PGRST116") return null
        throw error
      }

      return data
    } catch (error) {
      console.error("[Supabase Service] Error fetching blueprint:", error)
      return null
    }
  },

  async getUpdatesByContactId(contactId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("transparency_updates")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching transparency updates:", error)
      return []
    }
  },

  async getTransparencyVideos() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("transparency_videos")
        .select("*")
        .order("created_at", { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching transparency videos:", error)
      return []
    }
  },

  // =====================================================
  // SCRIPTS & CONTENT
  // =====================================================

  async getScripts(status?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("scripts").select("*")

      if (status) {
        query = query.eq("status", status)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching scripts:", error)
      return []
    }
  },

  async createScript(script: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("scripts").insert(script).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating script:", error)
      return null
    }
  },

  async updateScript(id: string, updates: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("scripts").update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating script:", error)
      return null
    }
  },

  async deleteScript(id: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { error } = await supabase.from("scripts").delete().eq("id", id)
      if (error) throw error
      return true
    } catch (error) {
      console.error("[Supabase Service] Error deleting script:", error)
      return false
    }
  },

  async getContentIdeas() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("content_ideas").select("*").order("created_at", { ascending: false })
      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching content ideas:", error)
      return []
    }
  },

  async getKeywords() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("keywords").select("*").order("search_volume", { ascending: false })
      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching keywords:", error)
      return []
    }
  },

  async getLongFormVideos() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("long_form_videos")
        .select("*")
        .order("created_at", { ascending: false })
      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching long form videos:", error)
      return []
    }
  },

  async getNewsletterCampaigns() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("newsletter_campaigns")
        .select("*")
        .order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching newsletter campaigns:", error)
      return []
    }
  },

  async getDirectMailCampaigns() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("direct_mail_campaigns")
        .select("*")
        .order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching direct mail campaigns:", error)
      return []
    }
  },

  async createDirectMailCampaign(campaign: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("direct_mail_campaigns").insert(campaign).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating direct mail campaign:", error)
      return null
    }
  },

  // =====================================================
  // COMPLIANCE
  // =====================================================

  async getComplianceFlags(userId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("compliance_flags").select("*")

      if (userId) {
        query = query.eq("user_id", userId)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching compliance flags:", error)
      return []
    }
  },

  async updateComplianceFlag(id: string, status: string, notes?: string) {
    try {
      const supabase = getSupabaseAdmin()
      const updates: any = { status }
      if (notes) updates.resolution_notes = notes
      if (status === "resolved" || status === "overridden") {
        updates.resolved_at = new Date().toISOString()
      }

      const { data, error } = await supabase.from("compliance_flags").update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating compliance flag:", error)
      return null
    }
  },

  // =====================================================
  // FINANCIAL
  // =====================================================

  async getCommissions(agentId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("commissions").select("*, transactions(*)")

      if (agentId) {
        query = query.eq("agent_id", agentId)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching commissions:", error)
      return []
    }
  },

  async getBusinessExpenses(agentId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("business_expenses").select("*")

      if (agentId) {
        query = query.eq("agent_id", agentId)
      }

      const { data, error } = await query.order("expense_date", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching business expenses:", error)
      return []
    }
  },

  async createBusinessExpense(expense: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("business_expenses").insert(expense).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating business expense:", error)
      return null
    }
  },

  async getMarketingStats() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("marketing_stats")
        .select("*")
        .order("date", { ascending: false })
        .limit(30)
      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching marketing stats:", error)
      return []
    }
  },

  // =====================================================
  // AI TOOLS & SUGGESTIONS
  // =====================================================

  async logAIToolUsage(usage: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("ai_tool_usage").insert(usage).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error logging AI tool usage:", error)
      return null
    }
  },

  async saveAIOutput(output: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("saved_ai_outputs").insert(output).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error saving AI output:", error)
      return null
    }
  },

  async getSuggestions(agentId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("smart_assistant_suggestions")
        .select("*")
        .eq("agent_id", agentId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching suggestions:", error)
      return []
    }
  },

  async updateSuggestionStatus(id: string, status: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("smart_assistant_suggestions")
        .update({ status })
        .eq("id", id)
        .select()
        .single()

      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating suggestion status:", error)
      return null
    }
  },

  // =====================================================
  // DEAL TEAM & ACTIVITIES
  // =====================================================

  async getDealTeamMembers(transactionId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("deal_team_members").select("*").eq("transaction_id", transactionId)

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching deal team members:", error)
      return []
    }
  },

  async getAIISAActivities(contactId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("ai_isa_activities")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching AI ISA activities:", error)
      return []
    }
  },

  // =====================================================
  // DOCUMENTS & MILESTONES
  // =====================================================

  async getTransactionMilestones(transactionId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("transaction_milestones")
        .select("*")
        .eq("transaction_id", transactionId)
        .order("milestone_date", { ascending: true })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching transaction milestones:", error)
      return []
    }
  },

  async getClientDocuments(contactId?: string, transactionId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("client_documents").select("*")

      if (contactId) {
        query = query.eq("contact_id", contactId)
      }
      if (transactionId) {
        query = query.eq("transaction_id", transactionId)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching client documents:", error)
      return []
    }
  },

  // =====================================================
  // LISTING ANALYTICS
  // =====================================================

  async getListingMetrics(listingId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("listing_metrics")
        .select("*")
        .eq("listing_id", listingId)
        .order("date", { ascending: false })
        .limit(30)

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching listing metrics:", error)
      return []
    }
  },

  async getListingEngagement(listingId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("listing_engagement")
        .select("*, contacts(*)")
        .eq("listing_id", listingId)
        .order("created_at", { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching listing engagement:", error)
      return []
    }
  },

  // =====================================================
  // ADMIN & SYSTEM
  // =====================================================

  async getAutomationErrors() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("automation_errors")
        .select("*")
        .eq("status", "open")
        .order("created_at", { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching automation errors:", error)
      return []
    }
  },

  async getRecentErrors(hoursBack = 24, statusFilter?: string) {
    try {
      const supabase = getSupabaseAdmin()
      const cutoffDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()

      let query = supabase.from("automation_errors").select("*").gte("created_at", cutoffDate)

      if (statusFilter && statusFilter !== "all") {
        query = query.eq("status", statusFilter)
      }

      const { data, error } = await query.order("created_at", { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching recent errors:", error)
      return []
    }
  },

  async updateAutomationError(id: string, status: string, notes?: string) {
    try {
      const supabase = getSupabaseAdmin()
      const updates: any = { status }
      if (notes) updates.resolution_notes = notes
      if (status === "resolved") {
        updates.resolved_at = new Date().toISOString()
      }

      const { data, error } = await supabase.from("automation_errors").update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating automation error:", error)
      return null
    }
  },

  async updateErrorStatus(id: string, status: string, resolvedBy?: string) {
    try {
      const supabase = getSupabaseAdmin()
      const updates: any = { status }

      if (status === "resolved") {
        updates.resolved_at = new Date().toISOString()
        if (resolvedBy) {
          updates.resolved_by = resolvedBy
        }
      }

      if (status === "ignored") {
        updates.ignored_at = new Date().toISOString()
        if (resolvedBy) {
          updates.ignored_by = resolvedBy
        }
      }

      const { data, error } = await supabase.from("automation_errors").update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating error status:", error)
      return null
    }
  },

  async logUserActivity(activity: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("user_activity").insert(activity).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error logging user activity:", error)
      return null
    }
  },

  // =====================================================
  // GENERIC OPERATIONS
  // =====================================================

  async createRecord(table: string, fields: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from(table).insert(fields).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error(`[Supabase Service] Error creating record in ${table}:`, error)
      return null
    }
  },

  async updateRecord(table: string, id: string, updates: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from(table).update(updates).eq("id", id).select().single()
      if (error) throw error
      return data
    } catch (error) {
      console.error(`[Supabase Service] Error updating record in ${table}:`, error)
      return null
    }
  },

  async getRecordsByField(table: string, field: string, value: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from(table).select("*").eq(field, value)
      if (error) throw error
      return data || []
    } catch (error) {
      console.error(`[Supabase Service] Error fetching records from ${table}:`, error)
      return []
    }
  },

  // Interaction History Operations (from existing code)
  async getInteractionHistory(contactId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("interaction_history")
        .select("*")
        .eq("contact_id", contactId)
        .order("interaction_date", { ascending: false })

      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching interaction history:", error)
      return []
    }
  },

  async createInteraction(interaction: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("interaction_history").insert(interaction).select().single()

      if (error) throw error

      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating interaction:", error)
      return null
    }
  },

  // Property Interests Operations (from existing code)
  async getPropertyInterests(contactId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase.from("property_interests").select("*").eq("contact_id", contactId).single()

      if (error) {
        if (error.code === "PGRST116") return null // No rows found
        throw error
      }

      return data
    } catch (error) {
      console.error("[Supabase Service] Error fetching property interests:", error)
      return null
    }
  },

  async updatePropertyInterests(contactId: string, updates: any) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("property_interests")
        .upsert({ contact_id: contactId, ...updates })
        .select()
        .single()

      if (error) throw error

      return data
    } catch (error) {
      console.error("[Supabase Service] Error updating property interests:", error)
      return null
    }
  },

  // =====================================================
  // SHOWINGS & OPEN HOUSES
  // =====================================================

  async getShowings(agentId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("showings").select("*, listings(*), contacts(*)")

      if (agentId) {
        query = query.eq("agent_id", agentId)
      }

      const { data, error } = await query.order("showing_date", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching showings:", error)
      return []
    }
  },

  async getOpenHouses(agentId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("open_house_events").select("*, listings(*)")

      if (agentId) {
        query = query.eq("agent_id", agentId)
      }

      const { data, error } = await query.order("event_date", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching open houses:", error)
      return []
    }
  },

  // =====================================================
  // COMMUNICATIONS
  // =====================================================

  async getCommunicationHistory(contactId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("messages").select("*, contacts(*)")

      if (contactId) {
        query = query.eq("contact_id", contactId)
      }

      const { data, error } = await query.order("created_at", { ascending: false }).limit(100)
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching communications:", error)
      return []
    }
  },

  // =====================================================
  // DOCUMENTS
  // =====================================================

  async getDocuments(entityId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("transaction_documents").select("*, transactions(*)")

      if (entityId) {
        query = query.or(`contact_id.eq.${entityId},transaction_id.eq.${entityId}`)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching documents:", error)
      return []
    }
  },

  // =====================================================
  // SPHERE / SOI
  // =====================================================

  async getSphere(agentId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("sphere_of_influence").select("*, contacts(*)")

      if (agentId) {
        query = query.eq("agent_id", agentId)
      }

      const { data, error } = await query.order("relationship_strength", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching sphere:", error)
      return []
    }
  },

  // =====================================================
  // BADGES & LEADERBOARD
  // =====================================================

  async getBadges(userId?: string) {
    try {
      const supabase = getSupabaseAdmin()
      let query = supabase.from("user_badges").select("*, badge_definitions(*)")

      if (userId) {
        query = query.eq("user_id", userId)
      }

      const { data, error } = await query.order("awarded_at", { ascending: false })
      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching badges:", error)
      return []
    }
  },

  async getLeaderboard() {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("agent_leaderboard")
        .select("*, agents(*)")
        .order("points", { ascending: false })
        .limit(50)

      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching leaderboard:", error)
      return []
    }
  },

  // =====================================================
  // FINANCIALS
  // =====================================================

  async getFinancials(type: "commissions" | "marketing") {
    try {
      const supabase = getSupabaseAdmin()

      if (type === "commissions") {
        const { data, error } = await supabase.from("commissions").select("*").order("created_at", { ascending: false })

        if (error) {
          console.error("[Supabase Service] Error fetching commissions:", error)
          return []
        }
        return data || []
      }

      if (type === "marketing") {
        const { data, error } = await supabase
          .from("business_expenses")
          .select("*")
          .order("created_at", { ascending: false })

        if (error) {
          console.error("[Supabase Service] Error fetching marketing:", error)
          return []
        }
        return data || []
      }

      return []
    } catch (error) {
      console.error("[Supabase Service] Error in getFinancials:", error)
      return []
    }
  },

  // =====================================================
  // BULK IMPORT
  // =====================================================

  async bulkImportContacts(
    contacts: Partial<Contact>[],
  ): Promise<{ success: number; failed: number; errors: string[] }> {
    const results = { success: 0, failed: 0, errors: [] as string[] }

    try {
      // Extract all unique statuses and personas for batch mapping
      const statuses = contacts.map((c) => c.status).filter(Boolean) as string[]
      const personas = contacts.map((c) => (c as any).persona).filter(Boolean) as string[]

      // Batch map using AI
      console.log(`[Supabase Service] Batch mapping ${statuses.length} statuses and ${personas.length} personas...`)
      const mappedStatuses = await aiMappingService.batchMapStatuses(statuses)

      // Create status lookup map
      const statusMap = new Map<string, string>()
      statuses.forEach((original, i) => {
        statusMap.set(original, mappedStatuses[i])
      })

      // Apply mapped values to contacts
      const normalizedContacts = contacts.map((contact) => ({
        ...contact,
        status: contact.status ? statusMap.get(contact.status) || contact.status : "new",
        persona: (contact as any).persona || "first_time_buyer",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }))

      // Insert in batches of 100
      const batchSize = 100
      for (let i = 0; i < normalizedContacts.length; i += batchSize) {
        const batch = normalizedContacts.slice(i, i + batchSize)
        const supabase = getSupabaseAdmin()
        const { data, error } = await supabase.from("contacts").insert(batch).select()

        if (error) {
          results.failed += batch.length
          results.errors.push(`Batch ${i / batchSize + 1}: ${error.message}`)
        } else {
          results.success += data?.length || 0
        }
      }

      console.log(`[Supabase Service] Import complete: ${results.success} success, ${results.failed} failed`)
      return results
    } catch (error) {
      console.error("[Supabase Service] Error in bulk import:", error)
      results.errors.push(String(error))
      return results
    }
  },
}
