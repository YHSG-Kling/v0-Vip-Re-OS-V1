import type {
  Lead,
  Deal,
  Vendor,
  Agent,
  Listing,
  SmartAssistantSuggestion,
  TransactionMilestone,
  AutomationError,
  Script,
  ScriptStatus,
  VideoAssetLibraryRecord,
  NewsletterCampaign,
  DirectMailCampaign,
  RelationshipPlan,
  PlanTask,
  CreditConversationLog,
  VideoEngagementEvent,
  JourneyState,
  JourneyBlueprint,
  PersonaType,
  JourneyStage,
  TransparencyUpdate,
  TransparencyVideo,
  JourneyTool,
  DealTeamMember,
  AIISAActivity,
  PropertyUpgrade,
  RealEstateEvent,
  ListingEngagement,
  ListingMetrics,
  PortalUser,
  UserActivity,
  CommissionRecord,
  MarketingChannel,
  CreditPartnerReferral,
  ContentIdea,
  Keyword,
  LongFormVideo,
  ComplianceFlag,
  AIToolUsage,
  SavedAIOutput,
  AIPromptTemplate,
  ClientDocument,
  CommissionCalculation,
  BusinessExpense,
  VideoAsset,
} from "../types"
import type { Contact } from "../types/contact"

const API_KEY = process.env.AIRTABLE_API_KEY || ""
const BASE_ID = process.env.AIRTABLE_BASE_ID || ""
const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}`

const getHeaders = () => ({
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
})

// --- MOCK DATA FOR DEMO PURPOSES ---

const MOCK_JOURNEY_BLUEPRINTS: JourneyBlueprint[] = [
  {
    id: "bp1",
    persona: "first_time_buyer",
    stage: "active",
    cardsJson: JSON.stringify([
      {
        card_id: "c1",
        title: "Calibrate Search Parameters",
        description:
          "Our AI has noticed a shift in your viewing patterns. We suggest expanding your radius by 2 miles to unlock 14 more listings.",
        icon: "search",
        priority: 1,
        actions: [{ label: "Update Search Radius", type: "trigger_workflow", workflow: "wf-update-radius" }],
      },
      {
        card_id: "c2",
        title: "Market Heat Report",
        description:
          "Bidding wars in 78704 have increased. Watch our 60-second briefing on winning without overpaying.",
        icon: "trending_up",
        priority: 2,
        videoUrl: "https://assets.nexus.com/v/market-brief.mp4",
        actions: [{ label: "Watch Briefing", type: "trigger_workflow", workflow: "wf-track-view" }],
      },
    ]),
    actionsJson: "[]",
    toolsEnabled: ["calculator"],
    transparencyVideosEnabled: true,
    teamVisibilityEnabled: true,
    priorityOrder: 1,
    isActive: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: "bp2",
    persona: "first_time_seller",
    stage: "active",
    cardsJson: JSON.stringify([
      {
        card_id: "s1",
        title: "Optimize Curb Appeal",
        description: "Based on showing feedback, we recommend fresh mulch and flowers to boost first impressions.",
        icon: "home",
        priority: 1,
        actions: [{ label: "View Staging Guide", type: "navigate", url: "knowledge-base" }],
      },
      {
        card_id: "s2",
        title: "Price Comparison Pulse",
        description: "Two new properties just pending in your ZIP. See how they affect your positioning.",
        icon: "dollar",
        priority: 2,
        actions: [{ label: "Review Comps", type: "navigate", url: "home-value" }],
      },
    ]),
    actionsJson: "[]",
    toolsEnabled: ["calculator"],
    transparencyVideosEnabled: true,
    teamVisibilityEnabled: true,
    priorityOrder: 1,
    isActive: true,
    createdAt: new Date().toISOString(),
  },
]

const MOCK_TRANSPARENCY_UPDATES: TransparencyUpdate[] = [
  {
    id: "u1",
    contactId: "demo-user",
    stage: "Due Diligence",
    title: "Inspection Report Analyzed",
    plainLanguageSummary:
      "Our AI has parsed your structural report. 3 minor items found, 0 critical failures. We are drafting the repair amendment now.",
    responsibleParty: "agent",
    responsiblePartyName: "Sarah Smith",
    status: "active",
    nextStep: "Repair Negotiation",
    nextStepDate: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
  },
  {
    id: "u2",
    contactId: "demo-user",
    stage: "Financing",
    title: "Appraisal Order Dispatched",
    plainLanguageSummary:
      "The lender has assigned an appraiser. Expect a site visit on Wednesday. We will monitor the portal for the final value sync.",
    responsibleParty: "lender",
    responsiblePartyName: "David Loan",
    status: "completed",
    createdAt: new Date(Date.now() - 172800000).toISOString(),
  },
]

const MOCK_TEAM_MEMBERS: DealTeamMember[] = [
  {
    id: "tm1",
    dealId: "d1",
    role: "agent",
    isAi: false,
    name: "Sarah Smith",
    company: "Nexus Real Estate",
    specialties: ["Negotiation", "Luxury"],
    isActive: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: "tm2",
    dealId: "d1",
    role: "ai_isa",
    isAi: true,
    name: "Nexus Concierge",
    specialties: ["Scheduling", "Data Analysis"],
    isActive: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: "tm3",
    dealId: "d1",
    role: "lender",
    isAi: false,
    name: "David Loan",
    company: "Premier Funding",
    specialties: ["Jumbo", "Conventional"],
    isActive: true,
    createdAt: new Date().toISOString(),
  },
]

const MOCK_AI_ACTIVITIES: AIISAActivity[] = [
  {
    id: "a1",
    contactId: "demo-user",
    activityType: "lead_nurture",
    summary: "AI analyzed local market shifts in 78704 and shared relevant equity update with client.",
    outcome: "connected",
    createdAt: new Date().toISOString(),
  },
  {
    id: "a2",
    contactId: "demo-user",
    activityType: "appointment_set",
    summary: "Nexus Concierge autonomously negotiated a showing time between buyer and seller agent.",
    outcome: "appointment_set",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
]

export const airtableService = {
  async fetchTable(tableName: string) {
    console.log("[v0] Fetching Airtable table:", tableName)
    console.log("[v0] BASE_ID:", BASE_ID ? `${BASE_ID.substring(0, 8)}...` : "MISSING")
    console.log("[v0] API_KEY exists:", !!API_KEY)
    console.log("[v0] Full URL:", `${BASE_URL}/${encodeURIComponent(tableName)}`)

    try {
      const res = await fetch(`${BASE_URL}/${encodeURIComponent(tableName)}`, { headers: getHeaders() })

      console.log("[v0] Airtable response status:", res.status)

      if (!res.ok) {
        const errorText = await res.text()
        console.log("[v0] Airtable fetch failed:", res.status, errorText)
        return null
      }

      const json = await res.json()
      const records = json.records || []
      console.log("[v0] Airtable returned", records.length, "records")
      return records
    } catch (error) {
      console.error("[v0] Airtable fetch error:", error)
      return null
    }
  },

  async createRecord(table: string, fields: any) {
    try {
      const res = await fetch(`${BASE_URL}/${table}`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ records: [{ fields }] }),
      })
      const json = await res.json()
      return json.records?.[0]
    } catch {
      return null
    }
  },

  async updateRecord(table: string, id: string, fields: any) {
    try {
      const res = await fetch(`${BASE_URL}/${table}/${id}`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({ fields }),
      })
      return await res.json()
    } catch {
      return null
    }
  },

  // --- JOURNEY SYSTEM METHODS ---
  async getJourneyStateByUserId(userId: string): Promise<JourneyState | null> {
    const data = await this.fetchTable("JourneyStates")
    const record = data?.find((r: any) => r.fields.userId === userId)

    if (record) return { id: record.id, ...record.fields } as any

    // Fallback for demo
    if (userId === "demo-user") {
      return {
        id: "js_demo",
        userId: "demo-user",
        persona: "first_time_buyer",
        currentStage: "active",
        lastStageChangeAt: new Date().toISOString(),
        journeyStartedAt: new Date().toISOString(),
        metadataJson: "{}",
      } as JourneyState
    }
    return null
  },

  async createJourneyState(data: any) {
    // If no real API, return the data as a mock record
    if (!API_KEY) return { id: "js_" + Math.random(), ...data }
    return this.createRecord("JourneyStates", {
      ...data,
      lastStageChangeAt: new Date().toISOString(),
      journeyStartedAt: new Date().toISOString(),
      metadataJson: "{}",
    })
  },

  async getBlueprintByPersonaStage(persona: string, stage: string): Promise<JourneyBlueprint | null> {
    const data = await this.fetchTable("JourneyBlueprints")
    const record = data?.find((r: any) => r.fields.persona === persona && r.fields.stage === stage)
    if (record) return { id: record.id, ...record.fields } as any

    // Fallback Mock Blueprints
    return MOCK_JOURNEY_BLUEPRINTS.find((b) => b.persona === persona && b.stage === stage) || MOCK_JOURNEY_BLUEPRINTS[0]
  },

  async getUpdatesByContactId(contactId: string): Promise<TransparencyUpdate[]> {
    const data = await this.fetchTable("TransparencyUpdates")
    const realData = data
      ? data.filter((r: any) => r.fields.contactId === contactId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []

    if (realData.length > 0) return realData

    // Fallback Mock Updates
    return MOCK_TRANSPARENCY_UPDATES.filter((u) => u.contactId === contactId || contactId === "demo-user")
  },

  async getToolsForPersonaStage(persona: PersonaType, stage: JourneyStage): Promise<JourneyTool[]> {
    const data = await this.fetchTable("JourneyTools")
    const realData = data
      ? data
          .filter((r: any) => r.fields.persona === persona && r.fields.stage.includes(stage))
          .map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []

    if (realData.length > 0) return realData

    // Fallback Mock Tool
    return [
      {
        id: "t1",
        name: "Mortgage Affordability Calculator",
        persona: persona,
        stage: [stage],
        type: "calculator",
        configJson: JSON.stringify({
          fields: [
            { name: "income", label: "Monthly Gross Income", type: "currency", required: true },
            { name: "debts", label: "Monthly Debt Payments", type: "currency", required: true },
          ],
          formula: "(income * 0.43) - debts",
          result_label: "Estimated Max Housing Payment (43% DTI)",
          result_format: "currency",
          explanation: "This uses a standard 43% Debt-to-Income ratio baseline used by most conventional lenders.",
        }),
        iconName: "calculator",
        description: "Calculate your maximum buying power instantly.",
        isActive: true,
        priorityOrder: 1,
        createdAt: new Date().toISOString(),
      },
    ]
  },

  async getTeamByDealId(dealId: string): Promise<DealTeamMember[]> {
    const data = await this.fetchTable("DealTeamMembers")
    const realData = data
      ? data.filter((r: any) => r.fields.dealId === dealId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []

    if (realData.length > 0) return realData

    // Fallback Mock Team
    return MOCK_TEAM_MEMBERS
  },

  async getAIISAActivityByContactId(contactId: string, limit: number): Promise<AIISAActivity[]> {
    const data = await this.fetchTable("AIISAActivities")
    const realData = data
      ? data
          .filter((r: any) => r.fields.contactId === contactId)
          .slice(0, limit)
          .map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []

    if (realData.length > 0) return realData

    // Fallback Mock AI Activity
    return MOCK_AI_ACTIVITIES
  },

  async getTransparencyVideos(): Promise<TransparencyVideo[]> {
    const data = await this.fetchTable("TransparencyVideos")
    const realData = data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []

    if (realData.length > 0) return realData

    // Fallback Mock Video
    return [
      {
        id: "tv1",
        stage: "inspection",
        persona: "buyer",
        title: "The Inspection Protocol",
        description: "How to interpret your home inspection report without panic.",
        videoUrl: "https://assets.nexus.com/v/inspection-guide.mp4",
        durationSeconds: 95,
        defaultEnabled: true,
        viewCount: 142,
        createdAt: new Date().toISOString(),
      },
    ]
  },

  // --- EXISTING METHODS KEPT FOR FUNCTIONALITY ---
  async logAIToolUsage(usage: Partial<AIToolUsage>) {
    return this.createRecord("AIToolUsage", {
      user_id: usage.userId,
      tool_name: usage.toolName,
      input_text: usage.inputText,
      output_text: usage.outputText,
      context_json: usage.contextJson,
      tokens_used: usage.tokensUsed,
      model_used: usage.modelUsed || "gemini-3-flash-preview",
    })
  },

  async saveAIOutput(output: Partial<SavedAIOutput>) {
    return this.createRecord("SavedAIOutputs", {
      user_id: output.userId,
      tool_name: output.toolName,
      title: output.title,
      content: output.content,
      tags: output.tags,
      favorited: output.favorited || false,
    })
  },

  async getAIPromptTemplate(toolName: string): Promise<AIPromptTemplate | null> {
    const data = await this.fetchTable("AIPromptTemplates")
    const templates = data
      ? data.map((r: any) => ({
          id: r.id,
          toolName: r.fields.tool_name,
          templateName: r.fields.template_name,
          systemPrompt: r.fields.system_prompt,
          userPromptTemplate: r.fields.user_prompt_template,
          isActive: r.fields.is_active !== false,
        }))
      : []
    return templates.find((t: any) => t.toolName === toolName && t.isActive) || null
  },

  async getUsers(): Promise<PortalUser[]> {
    const data = await this.fetchTable("Users")
    return data
      ? data.map((r: any) => ({
          id: r.id,
          fullName: r.fields.full_name,
          email: r.fields.email,
          role: r.fields.role,
          status: r.fields.status,
          loginCount: r.fields.login_count || 0,
          createdAt: r.fields.created_at,
          lastLogin: r.fields.last_login,
        }))
      : []
  },

  async updateUser(id: string, fields: any) {
    return this.updateRecord("Users", id, fields)
  },

  async createUser(data: any, createdBy: string) {
    return this.createRecord("Users", {
      ...data,
      createdBy,
      createdAt: new Date().toISOString(),
      status: "active",
      loginCount: 0,
    })
  },

  async getUserActivity(): Promise<UserActivity[]> {
    const data = await this.fetchTable("UserActivity")
    return data
      ? data.map((r: any) => ({
          id: r.id,
          userId: r.fields.user_id?.[0],
          activityType: r.fields.activity_type,
          description: r.fields.description,
          createdAt: r.fields.created_at,
        }))
      : []
  },

  async logUserActivity(userId: string, type: string, description: string, metadata?: any) {
    return this.createRecord("UserActivity", {
      user_id: [userId],
      activity_type: type,
      description: description,
      metadata_json: JSON.stringify(metadata || {}),
    })
  },

  async deactivateUser(id: string, currentUserId: string) {
    return this.updateRecord("Users", id, {
      status: "inactive",
      deactivated_at: new Date().toISOString(),
      deactivated_by: currentUserId,
    })
  },

  async getLeads(): Promise<Lead[] | null> {
    console.log("[v0] getLeads: Fetching from Contacts table")
    const data = await this.fetchTable("Contacts")
    console.log("[v0] getLeads: Got", data?.length || 0, "contacts")
    return data ? data.map(this.mapLead) : null
  },

  async getTransactions(): Promise<Deal[] | null> {
    const data = await this.fetchTable("Transactions")
    return data ? data.map(this.mapDeal) : null
  },

  async getVendors(): Promise<Vendor[] | null> {
    const data = await this.fetchTable("Vendors")
    return data ? data.map(this.mapVendor) : null
  },

  async getAgents(): Promise<Agent[] | null> {
    const data = await this.fetchTable("Agents")
    return data ? data.map(this.mapAgent) : null
  },

  async getListings(): Promise<Listing[] | null> {
    const data = await this.fetchTable("Listings")
    return data ? data.map(this.mapListing) : null
  },

  async getComplianceFlags(): Promise<ComplianceFlag[]> {
    const data = await this.fetchTable("ComplianceFlags")
    return data
      ? data.map((r: any) => ({
          id: r.id,
          userId: r.fields.user_id,
          contentType: r.fields.content_type,
          originalText: r.fields.original_text,
          flaggedPhrases: r.fields.flagged_phrases,
          violationType: r.fields.violation_type || [],
          severity: r.fields.severity,
          suggestedReplacement: r.fields.suggested_replacement,
          actionTaken: r.fields.action_taken,
          overrideReason: r.fields.override_reason,
          createdAt: r.fields.created_at || r.createdTime,
        }))
      : []
  },

  async getSavedProperties(contactId: string): Promise<Listing[]> {
    const data = await this.fetchTable("SavedProperties")
    return data ? data.filter((r: any) => r.fields.contactId === contactId).map(this.mapListing) : []
  },

  async createShowingRequest(data: any) {
    return this.createRecord("ShowingRequests", { ...data, status: "pending", createdAt: new Date().toISOString() })
  },

  async getClientDocuments(): Promise<ClientDocument[]> {
    const data = await this.fetchTable("ClientDocuments")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  async uploadClientDocument(data: any) {
    return this.createRecord("ClientDocuments", { ...data, status: "pending", createdAt: new Date().toISOString() })
  },

  async getCommissionCalculations(): Promise<CommissionCalculation[]> {
    const data = await this.fetchTable("CommissionCalculations")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  async getBusinessExpenses(): Promise<BusinessExpense[]> {
    const data = await this.fetchTable("BusinessExpenses")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  async logMileage(userId: string, start: string, end: string, miles: number, purpose: string) {
    return this.createRecord("BusinessExpenses", {
      userId,
      merchant: "Mileage Deduction",
      description: `Mileage: ${start} to ${end}. Purpose: ${purpose}`,
      category: "Auto",
      amount: miles * 0.67,
      expenseDate: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    })
  },

  async getCommissions(): Promise<CommissionRecord[]> {
    const data = await this.fetchTable("Commissions")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  async getMarketingStats(): Promise<MarketingChannel[]> {
    const data = await this.fetchTable("MarketingStats")
    return data ? data.map((r: any) => ({ ...r.fields }) as any) : []
  },

  async getScripts(): Promise<Script[]> {
    const data = await this.fetchTable("Scripts")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  async createScript(data: Partial<Script>) {
    return this.createRecord("Scripts", data)
  },

  async updateScript(id: string, data: Partial<Script>) {
    return this.updateRecord("Scripts", id, data)
  },

  async updateScriptStatus(id: string, status: ScriptStatus, userId?: string, reason?: string) {
    return this.updateRecord("Scripts", id, { status, approvedByUserId: userId, rejectedReason: reason })
  },

  async deleteScript(id: string) {
    return { success: true }
  },

  async getRecentErrors(timeFilter: number, status: string | null): Promise<AutomationError[]> {
    const data = await this.fetchTable("AutomationErrors")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  async updateErrorStatus(id: string, status: string, resolvedBy?: string) {
    return this.updateRecord("AutomationErrors", id, { status, resolvedBy, resolvedAt: new Date().toISOString() })
  },

  async getLatestMetricsByListingId(listingId: string): Promise<ListingMetrics | null> {
    const data = await this.fetchTable("ListingMetrics")
    const record = data?.find((r: any) => r.fields.listingId === listingId)
    return record ? ({ id: record.id, ...record.fields } as any) : null
  },

  async getEngagementByListingId(listingId: string, days: number): Promise<ListingEngagement[]> {
    const data = await this.fetchTable("ListingEngagement")
    return data
      ? data.filter((r: any) => r.fields.listingId === listingId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []
  },

  async getEvents(): Promise<RealEstateEvent[]> {
    const data = await this.fetchTable("Events")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // --- MISSING METHODS ADDED TO FIX ERRORS ---

  // Fixes: Property 'getAssetLibrary' does not exist on airtableMediaService in MarketingStudio.tsx
  async getAssetLibrary(userId: string): Promise<VideoAsset[]> {
    const data = await this.fetchTable("AssetLibrary")
    return data
      ? data.filter((r: any) => r.fields.userId === userId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []
  },

  // Fixes: Property 'getContentIdeas' does not exist on airtableService in MarketingStudio.tsx
  async getContentIdeas(): Promise<ContentIdea[]> {
    const data = await this.fetchTable("ContentIdeas")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // Fixes: Property 'getKeywords' does not exist on airtableService in MarketingStudio.tsx
  async getKeywords(): Promise<Keyword[]> {
    const data = await this.fetchTable("Keywords")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // Fixes: Property 'getLongFormVideos' does not exist on airtableService in MarketingStudio.tsx
  async getLongFormVideos(): Promise<LongFormVideo[]> {
    const data = await this.fetchTable("LongFormVideos")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // Fixes: Property 'getNewsletterCampaigns' does not exist on airtableService in MarketingStudio.tsx
  async getNewsletterCampaigns(): Promise<NewsletterCampaign[]> {
    const data = await this.fetchTable("NewsletterCampaigns")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // Fixes: Property 'getDirectMailCampaigns' does not exist on airtableService in MarketingStudio.tsx
  async getDirectMailCampaigns(): Promise<DirectMailCampaign[]> {
    const data = await this.fetchTable("DirectMailCampaigns")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // Fixes: Property 'createNewsletterCampaign' does not exist on airtableService in MarketingStudio.tsx
  async createNewsletterCampaign(data: Partial<NewsletterCampaign>) {
    return this.createRecord("NewsletterCampaigns", data)
  },

  // Fixes: Property 'createDirectMailCampaign' does not exist on airtableService in MarketingStudio.tsx
  async createDirectMailCampaign(data: Partial<DirectMailCampaign>) {
    return this.createRecord("DirectMailCampaigns", data)
  },

  // Fixes: Property 'createLongFormVideo' does not exist on airtableService in MarketingStudio.tsx
  async createLongFormVideo(data: Partial<LongFormVideo>) {
    return this.createRecord("LongFormVideos", data)
  },

  // Fixes: Property 'getCreditConversationLog' does not exist on airtableService in CRM.tsx
  async getCreditConversationLog(): Promise<CreditConversationLog[]> {
    const data = await this.fetchTable("CreditConversationLogs")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // Fixes: Property 'getCreditPartnerReferrals' does not exist on airtableService in CRM.tsx
  async getCreditPartnerReferrals(): Promise<CreditPartnerReferral[]> {
    const data = await this.fetchTable("CreditPartnerReferrals")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // Fixes: Property 'getVideoEngagementByContactId' does not exist on airtableService in CRM.tsx
  async getVideoEngagementByContactId(contactId: string): Promise<VideoEngagementEvent[]> {
    const data = await this.fetchTable("VideoEngagementEvents")
    return data
      ? data.filter((r: any) => r.fields.contactId === contactId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []
  },

  // Fixes: Property 'getVideoAssets' does not exist on airtableService in CRM.tsx, KnowledgeBase.tsx
  async getVideoAssets(): Promise<VideoAssetLibraryRecord[]> {
    const data = await this.fetchTable("VideoAssets")
    return data ? data.map((r: any) => ({ id: r.id, ...r.fields }) as any) : []
  },

  // Fixes: Property 'getPlanByContactId' does not exist on airtableService in CRM.tsx
  async getPlanByContactId(contactId: string): Promise<RelationshipPlan[]> {
    const data = await this.fetchTable("RelationshipPlans")
    return data
      ? data.filter((r: any) => r.fields.contactId === contactId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []
  },

  // Fixes: Property 'getTasksByPlanId' does not exist on airtableService in CRM.tsx
  async getTasksByPlanId(planId: string): Promise<PlanTask[]> {
    const data = await this.fetchTable("PlanTasks")
    return data
      ? data.filter((r: any) => r.fields.planId === planId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []
  },

  // Fixes: Property 'updatePlanTaskStatus' does not exist on airtableService in CRM.tsx
  async updatePlanTaskStatus(taskId: string, status: string, completedAt: string | null, completedByUserId: string) {
    return this.updateRecord("PlanTasks", taskId, { status, completedAt, completedByUserId })
  },

  // Fixes: Property 'getMilestones' does not exist on airtableOSService in TransactionManager.tsx
  async getMilestones(dealId: string): Promise<TransactionMilestone[]> {
    const data = await this.fetchTable("TransactionMilestones")
    return data
      ? data.filter((r: any) => r.fields.dealId === dealId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []
  },

  // Fixes: Property 'createVideoAsset' does not exist on airtableService in KnowledgeBase.tsx
  async createVideoAsset(data: any) {
    return this.createRecord("VideoAssets", data)
  },

  // Fixes: Property 'getSuggestions' does not exist on airtableOSService in DailyGameplan.tsx
  async getSuggestions(agentId: string): Promise<SmartAssistantSuggestion[]> {
    const data = await this.fetchTable("SmartAssistantSuggestions")
    return data
      ? data.filter((r: any) => r.fields.agentId === agentId).map((r: any) => ({ id: r.id, ...r.fields }) as any)
      : []
  },

  // Fixes: Property 'updateStatus' does not exist on airtableOSService in DailyGameplan.tsx
  async updateStatus(table: string, id: string, status: string) {
    return this.updateRecord(table, id, { status })
  },

  // Fixes: Property 'createPropertyUpgrade' does not exist on airtableService in Listings.tsx
  async createPropertyUpgrade(data: Partial<PropertyUpgrade>) {
    return this.createRecord("PropertyUpgrades", data)
  },

  // Fixes: Property 'updateComplianceFlag' does not exist on airtableService in ComplianceCheckedTextArea.tsx
  async updateComplianceFlag(id: string, actionTaken: string, overrideReason: string) {
    return this.updateRecord("ComplianceFlags", id, { action_taken: actionTaken, override_reason: overrideReason })
  },

  async getContacts(agentId?: string): Promise<Contact[]> {
    console.log("[v0] getContacts called with agentId:", agentId)
    const data = await this.fetchTable("Contacts")
    console.log("[v0] Fetched Airtable data:", data ? data.length : 0, "records")
    if (!data) return []

    let contacts = data.map(
      (r: any) =>
        ({
          id: r.id,
          agent_id: r.fields.agent_id || "",
          first_name: r.fields.first_name || "",
          last_name: r.fields.last_name || "",
          email: r.fields.email || "",
          phone: r.fields.phone || "",
          contact_type: r.fields.contact_type || "buyer",
          contact_persona: r.fields.contact_persona || "first_time_buyer",
          status: r.fields.status || "new",
          timeline: r.fields.timeline || "3-6_months",
          source: r.fields.source || "other",
          notes: r.fields.notes || "",
          property_interest: r.fields.property_interest ? JSON.parse(r.fields.property_interest) : {},
          created_at: r.fields.created_at || new Date().toISOString(),
          updated_at: r.fields.updated_at || new Date().toISOString(),
          last_contacted: r.fields.last_contacted || null,
          deleted_at: r.fields.deleted_at || null,
        }) as Contact,
    )

    // Filter by agent if provided
    if (agentId) {
      contacts = contacts.filter((c) => c.agent_id === agentId)
    }

    // Filter out deleted contacts
    contacts = contacts.filter((c) => !c.deleted_at)
    console.log("[v0] Returning contacts:", contacts.length)
    return contacts
  },

  async createContact(contact: Partial<Contact>): Promise<Contact | null> {
    const fields = {
      agent_id: contact.agent_id,
      first_name: contact.first_name,
      last_name: contact.last_name,
      email: contact.email,
      phone: contact.phone || "",
      contact_type: contact.contact_type || "buyer",
      contact_persona: contact.contact_persona || "first_time_buyer",
      status: contact.status || "new",
      timeline: contact.timeline || "3-6_months",
      source: contact.source || "other",
      notes: contact.notes || "",
      property_interest: contact.property_interest ? JSON.stringify(contact.property_interest) : "{}",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      has_login: false,
    }

    const result = await this.createRecord("Contacts", fields)
    if (!result) return null

    return {
      id: result.id,
      ...fields,
      property_interest: contact.property_interest || {},
    } as Contact
  },

  async updateContact(contactId: string, updates: Partial<Contact>): Promise<Contact | null> {
    const fields: any = { ...updates, updated_at: new Date().toISOString() }

    // Serialize property_interest if present
    if (fields.property_interest) {
      fields.property_interest = JSON.stringify(fields.property_interest)
    }

    // Remove id from fields
    delete fields.id

    const result = await this.updateRecord("Contacts", contactId, fields)
    if (!result) return null

    return { id: contactId, ...updates } as Contact
  },

  async deleteContact(contactId: string): Promise<boolean> {
    const result = await this.updateRecord("Contacts", contactId, {
      deleted_at: new Date().toISOString(),
    })
    return !!result
  },

  async getContactById(contactId: string): Promise<Contact | null> {
    try {
      const response = await fetch(`${BASE_URL}/Contacts/${contactId}`, {
        headers: getHeaders(),
      })
      if (!response.ok) return null
      const r = await response.json()
      return {
        id: r.id,
        agent_id: r.fields.agent_id || "",
        first_name: r.fields.first_name || "",
        last_name: r.fields.last_name || "",
        email: r.fields.email || "",
        phone: r.fields.phone || "",
        contact_type: r.fields.contact_type || "buyer",
        contact_persona: r.fields.contact_persona || "first_time_buyer",
        status: r.fields.status || "new",
        timeline: r.fields.timeline || "3-6_months",
        source: r.fields.source || "other",
        notes: r.fields.notes || "",
        property_interest: r.fields.property_interest ? JSON.parse(r.fields.property_interest) : {},
        created_at: r.fields.created_at || new Date().toISOString(),
        updated_at: r.fields.updated_at || new Date().toISOString(),
        last_contacted: r.fields.last_contacted || null,
        deleted_at: r.fields.deleted_at || null,
      } as Contact
    } catch (error) {
      console.error("Error fetching contact by ID:", error)
      return null
    }
  },

  mapLead: (r: any): Lead => {
    const firstName = r.fields.first_name || ""
    const lastName = r.fields.last_name || ""
    const fullName = `${firstName} ${lastName}`.trim() || "Unknown Contact"

    return {
      id: r.id,
      name: fullName,
      score: r.fields.engagement_score || r.fields.Engagement_Score || 0,
      status: r.fields.status || r.fields.Status || "new",
      source: r.fields.source || r.fields.Source || "",
      tags: r.fields.tags
        ? Array.isArray(r.fields.tags)
          ? r.fields.tags
          : r.fields.tags.split(",")
        : r.fields.Tags
          ? r.fields.Tags.split(",")
          : [],
      sentiment: r.fields.sentiment || r.fields.Sentiment_Label || "",
      urgency: r.fields.urgency_score || r.fields.Urgency_Score || 0,
      intent: r.fields.intent_type || r.fields.Intent_Type || r.fields.contact_persona || "",
      lastActivity: r.fields.last_activity || r.fields.Last_Activity_Summary || "",
      lastActivityDate: r.fields.updated_at || r.fields.Last_Activity_Date,
      aiSummary: r.fields.notes || r.fields.AI_Summary_Text || "",
      creditStatus: r.fields.Credit_Status,
      creditPipelineStage: r.fields.Credit_Pipeline_Stage,
      creditScoreBand: r.fields.Credit_Score_Band,
      videoEngagementScore: r.fields.Video_Engagement_Score,
      propertyAddress: r.fields.Property_Address,
      email: r.fields.email || r.fields.Email,
      phone: r.fields.phone || r.fields.Phone,
      propertyIntelligence: {
        equityPercent: r.fields.Equity_Percent,
        aiSellPrediction: r.fields.AI_Sell_Prediction,
        aiSellReason: r.fields.AI_Sell_Reason,
      },
    }
  },
  mapDeal: (r: any): Deal => ({
    id: r.id,
    address: r.fields.Property_Address,
    price: r.fields.Contract_Price || 0,
    stage: r.fields.Current_Stage,
    clientName: r.fields.Client_Name,
    healthScore: r.fields.Deal_Health_Score || 100,
    healthStatus: r.fields.Health_Status,
    nextTask: r.fields.Next_Critical_Task,
    missingDocs: r.fields.Missing_Docs_Count || 0,
    winProbability: r.fields.Win_Probability_Percent || 0,
    projectedGCI: r.fields.Projected_GCI,
    predictedClose: r.fields.Predicted_Close,
  }),
  mapVendor: (r: any): Vendor => ({
    id: r.id,
    companyName: r.fields.Company_Name,
    category: r.fields.Category,
    rating: r.fields.Average_Rating,
    verified: r.fields.Verified_Status === "Verified",
    insuranceStatus: r.fields.Insurance_Valid ? "Valid" : "Expired",
    dealsClosed: r.fields.Total_Jobs_Completed || 0,
    status: r.fields.Status,
  }),
  mapAgent: (r: any): Agent => ({
    id: r.id,
    name: r.fields.Full_Name,
    role: r.fields.Role,
    email: r.fields.Email,
    phone: r.fields.Phone,
    volume: r.fields.YTD_Volume || 0,
    deals: r.fields.YTD_Deals || 0,
    capProgress: r.fields.Cap_Progress_Percent || 0,
    capPaid: r.fields.Cap_Paid_Amount || 0,
    capTotal: r.fields.Cap_Total_Goal || 0,
    status: r.fields.Status,
    availability: r.fields.Availability_Status,
    dailyLeadCap: r.fields.Daily_Lead_Cap || 0,
    leadsReceivedToday: r.fields.Leads_Received_Today || 0,
    closingRate: r.fields.Closing_Rate || 0,
    badges: [],
  }),
  mapListing: (r: any): Listing => ({
    id: r.id,
    address: r.fields.Address,
    price: r.fields.List_Price || 0,
    listPrice: r.fields.List_Price || 0,
    status: r.fields.Status,
    daysOnMarket: r.fields.Days_On_Market || 0,
    images: r.fields.Images ? r.fields.Images.split(",") : [],
    stats: {
      views: r.fields.Views_Count || 0,
      saves: r.fields.Saves_Count || 0,
      showings: r.fields.Showings_Count || 0,
      offers: r.fields.Offers_Count || 0,
    },
    benchmarks: {},
    createdAt: r.fields.Created_At || new Date().toISOString(),
  }),
}

export const airtableMediaService = airtableService
export const airtableOSService = airtableService
export const airtableCreditService = airtableService

export const determinePersona = (contact: any, transaction: any): PersonaType => {
  if (contact?.leadType === "seller") return "first_time_seller"
  return "first_time_buyer"
}

export const determineStage = (contact: any, transaction: any, listing: any): JourneyStage => {
  if (transaction) return "under_contract"
  if (listing) return "active"
  return "qualifying"
}
