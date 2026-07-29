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
      // `select("count")` asked PostgREST for a column named "count", which contacts
      // does not have — the health check reported "not connected" whenever the database
      // was perfectly healthy. head+exact is the real row-count probe and touches no columns.
      const { error } = await supabase.from("contacts").select("*", { count: "exact", head: true })
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

  /**
   * A brokerage's vendor directory.
   *
   * brokerageId is REQUIRED. This ran on the service-role client filtered only by
   * `category` — a free-text column — so /api/vendors/list handed every authenticated
   * agent every tenant's vendor list, contact details included. `category` narrows
   * within a tenant; it is not a tenant boundary.
   */
  async getVendors(brokerageId: string, category?: string) {
    try {
      if (!brokerageId) throw new Error("getVendors requires a brokerageId")
      const supabase = getSupabaseAdmin()
      let query = supabase.from("vendors").select("*").eq("brokerage_id", brokerageId)

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

  // createVendor removed — it took a Record<string, unknown> straight into
  // `vendors`.insert(), so it could write any string into the CHECK-constrained
  // `category` column, and it swallowed the rejection and returned null. It had
  // zero call sites. lib/kernel/vendors.ts createVendorRecord is the one writer:
  // it dedups on name per brokerage, normalises the category through the
  // vocabulary module, refuses unrecognised values in words a broker can act on,
  // and emits VENDOR_RECORD_CREATED.

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

  /** A brokerage's video assets. brokerageId REQUIRED — same reason as getVendors:
   *  `category` is a free-text label, not a tenant boundary. */
  async getVideoAssets(brokerageId: string, category?: string) {
    try {
      if (!brokerageId) throw new Error("getVideoAssets requires a brokerageId")
      const supabase = getSupabaseAdmin()
      let query = supabase.from("video_assets").select("*").eq("brokerage_id", brokerageId)

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


  // getTransparencyVideos / getLongFormVideos / getMarketingStats were REMOVED.
  //
  // Each did `getSupabaseAdmin().from(<table>).select("*")` with NO tenant filter —
  // a cross-tenant read on the RLS-bypassing service client — and each had ZERO
  // callers anywhere in the app. The three tables (transparency_videos,
  // long_form_videos, marketing_stats) hold no rows, have no writer, and have no
  // reader now that these are gone.
  //
  // They were on the child-tenant-scope allowlist as "NO ANCHOR" — tables with no
  // brokerage_id and no FK to anything that has one. Bolting a brokerage_id and an
  // RLS policy onto a table nothing reads or writes would turn that guard green
  // without making anything safer. Deleting the only accessors removes the hazard
  // at its source instead: whoever wires these tables up later starts from nothing
  // and has to scope them then.

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

  /**
   * Commission rows for a bounded scope.
   *
   * Reads `agent_commissions`. The `commissions` twin this used to select from was
   * dropped in m284, and because the failure landed in a catch that returned `[]`,
   * every caller read "this agent has no commissions" instead of "this is broken".
   * Errors now propagate — a caller that cannot load commissions must say so rather
   * than render an empty statement.
   *
   * The scope is required. This runs on the service-role client, so an unbounded
   * select reaches across brokerages; callers pass the agents (or the brokerage)
   * they have already established the viewer is entitled to.
   */
  async getCommissions(scope: { agentId?: string; agentIds?: string[]; brokerageId?: string }) {
    const agentIds = (scope.agentIds ?? []).filter(Boolean)
    if (!scope.agentId && agentIds.length === 0 && !scope.brokerageId) {
      throw new Error("getCommissions requires a scope (agentId, agentIds or brokerageId)")
    }

    const supabase = getSupabaseAdmin()
    let query = supabase.from("agent_commissions").select("*, transactions(*)")

    if (scope.brokerageId) query = query.eq("brokerage_id", scope.brokerageId)
    if (scope.agentId) query = query.eq("agent_id", scope.agentId)
    else if (agentIds.length > 0) query = query.in("agent_id", agentIds)

    const { data, error } = await query.order("created_at", { ascending: false })
    if (error) throw error

    return data || []
  },

  /**
   * Business expenses for a bounded scope — the same contract as getCommissions above,
   * and required for the same reason: this is the service-role client, so a call with
   * no scope returns every brokerage's expenses.
   */
  async getBusinessExpenses(scope: { agentId?: string; agentIds?: string[]; brokerageId?: string }) {
    try {
      const agentIds = (scope.agentIds ?? []).filter(Boolean)
      if (!scope.agentId && agentIds.length === 0 && !scope.brokerageId) {
        throw new Error("getBusinessExpenses requires a scope (agentId, agentIds or brokerageId)")
      }

      const supabase = getSupabaseAdmin()
      let query = supabase.from("business_expenses").select("*")

      if (scope.brokerageId) query = query.eq("brokerage_id", scope.brokerageId)
      if (scope.agentId) query = query.eq("agent_id", scope.agentId)
      else if (agentIds.length > 0) query = query.in("agent_id", agentIds)

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

  // getTransactionMilestones() lived here as a second copy that ordered by
  // `milestone_date` — not a column on transaction_milestones, so the query errored and
  // the catch returned []. It had no callers: the live one is
  // getTransactionMilestones() in lib/application/transactions.ts, which orders by the
  // real `target_date` and is what app/actions/transactions.ts calls.

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
      // listing_engagement was a writer-less legacy table (burn-down round 6 repoint) — the feed is
      // assembled from the WRITTEN engagement primitives (column usage mirrors lib/listings/listing-metrics-rollup.ts).
      const [views, saves, inquiries, showings] = await Promise.all([
        supabase.from("property_views").select("*").eq("property_id", listingId),
        supabase.from("saved_properties").select("*").eq("listing_id", listingId).eq("dismissed", false),
        supabase.from("listing_inquiries").select("*").eq("listing_id", listingId),
        supabase.from("showings").select("*").eq("listing_id", listingId),
      ])

      const rows = [
        ...(views.data ?? []).map((r: any) => ({ ...r, engagement_type: "view", created_at: r.last_viewed_at ?? r.first_viewed_at ?? null })),
        ...(saves.data ?? []).map((r: any) => ({ ...r, engagement_type: "save", created_at: r.saved_at ?? null })),
        ...(inquiries.data ?? []).map((r: any) => ({ ...r, engagement_type: "inquiry" })),
        ...(showings.data ?? []).map((r: any) => ({ ...r, engagement_type: "showing" })),
      ].sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())

      // Preserve the old "*, contacts(*)" shape: attach the contact row where the primitive carries contact_id.
      const contactIds = [...new Set(rows.map((r: any) => r.contact_id).filter(Boolean))]
      const { data: contactRows } = contactIds.length
        ? await supabase.from("contacts").select("*").in("id", contactIds)
        : { data: [] as any[] }
      const contactById = new Map((contactRows ?? []).map((c: any) => [c.id, c]))
      return rows.map((r: any) => ({ ...r, contacts: r.contact_id ? (contactById.get(r.contact_id) ?? null) : null }))
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

  /**
   * A contact's logged activity, newest first.
   *
   * Reads `activities` — the live activity spine that 173 other files already use.
   * This method previously read `interaction_history`, a table that has never existed
   * in this database, ordered by an `interaction_date` column that came with it. The
   * catch below turned that into `[]`, so /api/credit/status returned an empty credit
   * log rather than reporting that it could not read one.
   *
   * `activity_type` replaces the old `interaction_type`; callers filtering by type
   * should read that field.
   *
   * Named getContactActivities because that is the name app/actions/communications.ts
   * already called (through an `any` cast, so nothing checked that it existed). One
   * method, one name — /api/credit/status calls the same one.
   */
  async getContactActivities(contactId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("activities")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })

      if (error) throw error

      return data || []
    } catch (error) {
      console.error("[Supabase Service] Error fetching interaction history:", error)
      return []
    }
  },

  // createInteraction() wrote to the same never-existent `interaction_history` table and
  // had no callers. Removed rather than repointed — `activities` already has writers.

  // =====================================================
  // ACTIVITY LOG / NOTES / USERS
  // =====================================================
  //
  // logActivity, getUserById, addContactNote and a `client` accessor were all CALLED on
  // supabaseService from app/actions/communications.ts but never existed on it. That file
  // casts its import to `any`, so tsc could not see a single one and every call was a
  // runtime TypeError — including the two the orchestrator makes through
  // sendNotificationToAgent. The cast is gone; these are the real implementations,
  // written against the live column names.

  async getUserById(userId: string) {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from("users")
        .select("id, email, first_name, last_name, user_type, brokerage_id")
        .eq("id", userId)
        .maybeSingle()

      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error fetching user:", error)
      return null
    }
  },

  /**
   * Append a line to the activity log.
   *
   * `activities.brokerage_id` is NOT NULL, and no call site knows it — they hold a
   * contact or a user. It is resolved from whichever is present rather than pushed onto
   * callers, because an activity insert that fails its NOT NULL is exactly the kind of
   * write that disappears without anyone noticing.
   */
  async logActivity(entry: {
    contact_id?: string
    user_id?: string
    agent_id?: string
    brokerage_id?: string
    activity_type: string
    description?: string
    title?: string
    metadata?: Record<string, unknown>
  }) {
    try {
      const supabase = getSupabaseAdmin()

      let brokerageId = entry.brokerage_id ?? null
      if (!brokerageId && entry.contact_id) {
        const { data } = await supabase.from("contacts").select("brokerage_id").eq("id", entry.contact_id).maybeSingle()
        brokerageId = (data as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
      }
      if (!brokerageId && entry.user_id) {
        const { data } = await supabase.from("users").select("brokerage_id").eq("id", entry.user_id).maybeSingle()
        brokerageId = (data as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
      }
      if (!brokerageId) {
        console.error("[Supabase Service] logActivity: no brokerage could be resolved; not logging", entry.activity_type)
        return null
      }

      const { data, error } = await supabase
        .from("activities")
        .insert({
          brokerage_id: brokerageId,
          contact_id: entry.contact_id ?? null,
          agent_id: entry.agent_id ?? null,
          // the column is agent_user_id — `user_id` is not on this table
          agent_user_id: entry.user_id ?? null,
          activity_type: entry.activity_type,
          title: entry.title ?? null,
          description: entry.description ?? null,
          metadata: entry.metadata ?? null,
        })
        .select("id")
        .single()

      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error logging activity:", error)
      return null
    }
  },

  /**
   * Write a contact note.
   *
   * The live table is contact_notes(contact_id, brokerage_id, author_user_id, body,
   * is_private). The old call passed `note`, `category` and `ghl_note_id` — none of which
   * are columns here, so this would have failed on shape even if the method had existed.
   * The note text goes to `body`; there is nowhere on this table to persist the external
   * note id, and the caller already returns it to its own caller.
   */
  async addContactNote(params: {
    contact_id: string
    note: string
    author_user_id?: string
    brokerage_id?: string
    is_private?: boolean
  }) {
    try {
      const supabase = getSupabaseAdmin()

      let brokerageId = params.brokerage_id ?? null
      if (!brokerageId) {
        const { data } = await supabase.from("contacts").select("brokerage_id").eq("id", params.contact_id).maybeSingle()
        brokerageId = (data as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
      }

      const { data, error } = await supabase
        .from("contact_notes")
        .insert({
          contact_id: params.contact_id,
          brokerage_id: brokerageId,
          author_user_id: params.author_user_id ?? null,
          body: params.note,
          is_private: params.is_private ?? false,
        })
        .select("id")
        .single()

      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error adding contact note:", error)
      return null
    }
  },

  /**
   * Write an in-app notification.
   *
   * communications.ts reached for a `supabaseService.client` accessor that does not
   * exist, to run this insert itself. Exposing the raw service-role client to callers is
   * a wider door than the one write needs, so the write lives here instead.
   */
  async createNotification(params: {
    user_id: string
    type: string
    title: string
    body?: string
    priority?: string
    channel?: string
    brokerage_id?: string
  }) {
    try {
      const supabase = getSupabaseAdmin()

      let brokerageId = params.brokerage_id ?? null
      if (!brokerageId) {
        const { data } = await supabase.from("users").select("brokerage_id").eq("id", params.user_id).maybeSingle()
        brokerageId = (data as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
      }

      const { data, error } = await supabase
        .from("notifications")
        .insert({
          user_id: params.user_id,
          brokerage_id: brokerageId,
          type: params.type,
          title: params.title,
          body: params.body ?? null,
          priority: params.priority ?? "medium",
          is_read: false,
          channel: params.channel ?? "in_app",
        })
        .select("id")
        .single()

      if (error) throw error
      return data
    } catch (error) {
      console.error("[Supabase Service] Error creating notification:", error)
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
  // SPHERE / BADGES / LEADERBOARD  — removed, see below
  // =====================================================
  //
  // getSphere() / getBadges() / getLeaderboard() read `sphere_of_influence`,
  // `user_badges` and `agent_leaderboard`. None of those tables has ever existed in
  // this database, so all three returned `[]` through their catch on every call and
  // could not have worked. Their only entry point was the useDataAccess hook, which
  // nothing mounts.
  //
  // Each already has a live counterpart carrying the real data — sphere_engagement_scores,
  // agent_badges / gamification_badges, and leaderboard_rankings — and the surfaces that
  // show this data to users read those directly. Removed rather than repointed: adding a
  // second, service-role, unscoped path to data that already has a working one is the
  // duplication that produced this in the first place.

  // =====================================================
  // FINANCIALS
  // =====================================================

  // getFinancials("commissions" | "marketing") used to live here as a second, unscoped
  // way to read the same two tables — it selected EVERY row on the service-role client
  // and left the tenant filtering to the caller's JS. Its commission half read the
  // `commissions` table dropped in m284, so it returned `[]` forever and the missing
  // scope never showed. Removed rather than repointed: reviving it against a live table
  // would have turned a dead path into a cross-brokerage read. Its one caller
  // (dataAccessService.getFinancials) now scopes in the query via getCommissions /
  // getBusinessExpenses.

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
