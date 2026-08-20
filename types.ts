// UserRole — canonical string union sourced from lib/security/types.ts.
// The const object below preserves the legacy dot-access pattern (UserRole.ADMIN)
// used throughout the codebase while emitting the correct canonical values.
// Do NOT add new roles here — add them to lib/security/types.ts first.
export type UserRole =
  | 'superadmin'
  | 'admin'
  | 'broker'
  | 'team_lead'
  | 'agent'
  | 'isa'
  | 'tc'
  | 'compliance_officer'
  | 'vendor'
  | 'lender'
  | 'title_agent'
  | 'contact'

// Runtime accessor object — enables UserRole.ADMIN, UserRole.TC, etc.
// Values are always the canonical strings above.
export const UserRole = {
  SUPERADMIN: 'superadmin' as const,
  ADMIN: 'admin' as const,
  BROKER: 'broker' as const,
  TEAM_LEAD: 'team_lead' as const,
  /** @deprecated Use TEAM_LEAD. Kept for backward compatibility. */
  TEAM_LEADER: 'team_lead' as const,
  AGENT: 'agent' as const,
  ISA: 'isa' as const,
  TC: 'tc' as const,
  COMPLIANCE_OFFICER: 'compliance_officer' as const,
  VENDOR: 'vendor' as const,
  LENDER: 'lender' as const,
  TITLE_AGENT: 'title_agent' as const,
  CONTACT: 'contact' as const,
} as const

export type PersonaType =
  | "first_time_buyer"
  | "first_time_seller"
  | "investor_buyer"
  | "investor_seller"
  | "relocating_buyer"
  | "relocating_seller"
  | "upsizing"
  | "downsizing"
  | "fsbo"
  | "military_buyer"
  | "military_seller"
  | "agent"
  | "broker"
  | "admin"
  | "all_buyers"
  | "all_sellers"
  | "all"

export type JourneyStage = "lead" | "qualifying" | "active" | "under_contract" | "closing" | "post_close"

export interface User {
  id: string
  name: string
  role: UserRole
  avatar?: string
  email?: string
  // Real fields from Supabase auth + users + agents tables:
  user_type?: string
  subType?: string          // contact_persona or agent sub-classification
  agentId?: string          // from agents.id where user_id = user.id
  contactId?: string        // for portal users: contacts.id
  vendorId?: string         // for vendor portal users: vendors.id
  teamId?: string           // from users.team_id
  teamIds?: string[]        // all teams this user belongs to
  brokerageId?: string      // from users.brokerage_id or role_assignments.brokerage_id
  managedAgentIds?: string[] // for team leads: agent IDs they manage
  playbookId?: string
  lastLogin?: string
  ownsProperty?: boolean
  searchCriteria?: any
  stats?: any
}

// --- AI TOOLS SUITE ---
export type AIToolName =
  | "listing_description"
  | "email_composer"
  | "social_post"
  | "market_report"
  | "offer_letter"
  | "contract_explainer"
  | "negotiation_advisor"
  | "objection_handler"
  | "lead_qualifier"
  | "doc_summarizer"
  | "price_justification"
  | "faq_answerer"

export interface AIToolUsage {
  id: string
  userId: string
  toolName: AIToolName
  inputText: string
  outputText: string
  contextJson: string
  tokensUsed?: number
  modelUsed: string
  edited: boolean
  usedFinalOutput: boolean
  rating?: number
  createdAt: string
}

export interface AIPromptTemplate {
  id: string
  toolName: AIToolName
  templateName: string
  systemPrompt: string
  userPromptTemplate: string
  exampleInput?: string
  exampleOutput?: string
  isActive: boolean
  version: number
}

export interface SavedAIOutput {
  id: string
  userId: string
  toolName: AIToolName
  title: string
  content: string
  tags: string[]
  favorited: boolean
  createdAt: string
}

// --- VOICE AI SYSTEM ---
export interface VoiceCommand {
  id: string
  userId: string
  audioUrl?: string
  transcript: string
  intent: "log_lead" | "add_note" | "schedule_showing" | "send_update" | "create_task" | "price_check" | "other"
  extractedDataJson?: string
  actionTaken?: string
  status: "processing" | "completed" | "failed" | "needs_clarification"
  confidenceScore?: number
  createdAt: string
}

// --- FAIR HOUSING COMPLIANCE ---
export type ComplianceContentType =
  | "email"
  | "sms"
  | "listing_description"
  | "note"
  | "social_post"
  | "showing_feedback"
export type ViolationType =
  | "familial_status"
  | "religion"
  | "race"
  | "national_origin"
  | "disability"
  | "gender"
  | "age"
  | "other"

export interface FlaggedPhrase {
  phrase: string
  violation_type: ViolationType
  severity: "high" | "medium" | "low"
  reason: string
  suggested_replacement: string
}

export interface ComplianceFlag {
  id: string
  userId: string
  contentType: ComplianceContentType
  originalText: string
  flaggedPhrases: string // JSON Array
  violationType: ViolationType[]
  severity: "high" | "medium" | "low"
  suggestedReplacement?: string
  actionTaken: "corrected" | "overridden" | "sent_anyway"
  overrideReason?: string
  createdAt: string
}

// --- USER MANAGEMENT SYSTEM ---
export interface PortalUser {
  id: string
  email: string
  fullName: string
  role: UserRole | string
  status: "active" | "inactive" | "pending" | "suspended"
  phone?: string
  photoUrl?: string
  teamId?: string
  territoryZipCodes?: string
  permissionsJson?: string
  lastLogin?: string
  loginCount: number
  createdAt: string
  createdBy?: string
  deactivatedAt?: string
  deactivatedBy?: string
}

export interface UserActivity {
  id: string
  userId: string
  activityType:
    | "login"
    | "logout"
    | "create_listing"
    | "create_contact"
    | "send_email"
    | "workflow_trigger"
    | "settings_change"
    | "role_change"
  description: string
  ipAddress?: string
  metadataJson?: string
  createdAt: string
}

// --- JOURNEY SYSTEM ---
export interface JourneyState {
  id: string
  userId: string
  persona: PersonaType
  contactId?: string
  listingId?: string
  dealId?: string
  currentStage: JourneyStage
  previousStage?: string
  lastStageChangeAt: string
  journeyStartedAt: string
  metadataJson: string
}

export interface JourneyBlueprint {
  id: string
  persona: PersonaType
  stage: JourneyStage
  cardsJson: string
  actionsJson: string
  toolsEnabled: string[]
  microVideoSeriesId?: string
  transparencyVideosEnabled: boolean
  teamVisibilityEnabled: boolean
  priorityOrder: number
  isActive: boolean
  createdAt: string
}

export interface JourneyTool {
  id: string
  name: string
  persona: PersonaType | string
  stage: JourneyStage[] | string[]
  type: "calculator" | "checklist" | "template" | "guide" | "worksheet"
  configJson: string
  iconName: string
  description: string
  helpText?: string
  actionWorkflowId?: string
  isActive: boolean
  priorityOrder: number
  createdAt: string
}

// --- TEAM & ISA SYSTEM ---
export interface DealTeamMember {
  id: string
  dealId: string
  role: "agent" | "ai_isa" | "tc" | "lender" | "title" | "inspector" | "appraiser"
  userId?: string
  isAi: boolean
  name: string
  email?: string
  phone?: string
  company?: string
  photoUrl?: string
  bio?: string
  specialties: string[]
  isActive: boolean
  createdAt: string
}

export interface AIISAActivity {
  id: string
  contactId: string
  dealId?: string
  activityType:
    | "outbound_call"
    | "inbound_call"
    | "sms_sent"
    | "sms_received"
    | "email_sent"
    | "appointment_set"
    | "lead_qualified"
    | "lead_nurture"
    | "follow_up_scheduled"
  summary: string
  outcome:
    | "connected"
    | "voicemail"
    | "no_answer"
    | "appointment_set"
    | "not_interested"
    | "callback_requested"
    | "info_provided"
  nextAction?: string
  nextActionDate?: string
  conversationTranscript?: string
  metadataJson?: string
  createdAt: string
}

// --- TRANSPARENCY SYSTEM ---
export interface TransparencyUpdate {
  id: string
  dealId?: string
  listingId?: string
  contactId: string
  stage: string
  title: string
  plainLanguageSummary: string
  responsibleParty: "agent" | "title" | "lender" | "inspector" | "appraiser" | "client" | "team"
  responsiblePartyName?: string
  communicationLinksJson?: string
  nextStep?: string
  nextStepDate?: string
  transparencyVideoId?: string
  status: "active" | "completed" | "superseded"
  createdAt: string
}

export interface TransparencyVideo {
  id: string
  stage: string
  persona: "buyer" | "seller" | "both"
  title: string
  description?: string
  scriptId?: string
  assetId?: string
  videoUrl?: string
  thumbnailUrl?: string
  durationSeconds: number
  defaultEnabled: boolean
  viewCount: number
  createdAt: string
}

// --- CORE OS ENHANCEMENTS ---
export interface OS_Event {
  id: string
  event_type: string
  actor_role: UserRole
  actor_id: string
  context_type: string
  context_id: string
  payload_JSON: string
  created_at: string
}

export interface Playbook {
  id: string
  name: string
  trigger: string
  audience: any
  steps_JSON: string
  tools_JSON: string
  is_active: boolean
}

export interface SmartAssistantSuggestion {
  id: string
  agent_id: string
  context_type: string
  context_id: string
  title: string
  description: string
  action_type: string
  action_payload_JSON: string
  status: "pending" | "accepted" | "ignored" | "executed"
  priority: "low" | "medium" | "high"
  dedupeKey: string
  created_at: string
}

// --- COPILOT PLANS ---
export interface RelationshipPlan {
  id: string
  contactId: string
  agentId: string
  persona: string
  stage: string
  planSummary: string
  generatedAt: string
  expiresAt: string
  status: "active" | "completed" | "expired"
}

export interface PlanTask {
  id: string
  planId: string
  dayIndex: number
  ownerRole: string
  roleView: "agent" | "admin" | "client"
  taskText: string
  taskType: string
  channel: string
  priority: string
  approvalRequired: boolean
  status: "pending" | "in_progress" | "completed" | "skipped"
  completedAt?: string
  completedByUserId?: string
  notes?: string
}

// --- TRANSACTIONS ---
export interface TransactionMilestone {
  id: string
  deal_id: string
  milestone_type: string
  due_date: string
  status: string
  owner_role: string
  notes: string
}

// --- RELIABILITY / AUDIT ---
export interface AutomationError {
  id: string
  workflowId: string
  errorType: "workflow_failure" | "api_error" | "validation_error" | "timeout" | "rate_limit" | "other"
  errorMessage: string
  errorStack?: string
  contextJson?: string
  severity: "critical" | "high" | "medium" | "low"
  status: "new" | "investigating" | "resolved" | "ignored"
  affectedUserId?: string
  retryCount: number
  retrySuccessful: boolean
  resolvedAt?: string
  resolvedBy?: string
  createdAt: string
}

// --- ANALYTICS SYSTEM ---
export interface ListingEngagement {
  id: string
  listingId: string
  date: string
  onlineViews: number
  detailPageViews: number
  photoViews: number
  mapViews: number
  favoriteCount: number
  shareCount: number
  source: "zillow" | "realtor_com" | "mls" | "agent_site" | "social"
  createdAt: string
}

export interface ListingMetrics {
  id: string
  listingId: string
  metricDate: string
  daysOnMarket: number
  totalShowings: number
  showingsThisWeek: number
  totalOnlineViews: number
  viewsPerDay: number
  feedbackReceivedCount: number
  avgSentimentScore: number
  priceReductionCount: number
  offerProbabilityScore: number
  predictedDaysToOffer?: number
  reasoning?: string
  confidence?: "high" | "medium" | "low"
  createdAt: string
}

export interface Listing {
  id: string
  address: string
  price: number
  listPrice: number
  status: string
  daysOnMarket: number
  images: string[]
  stats: { views: number; saves: number; showings: number; offers: number }
  benchmarks: any
  latitude?: number
  longitude?: number
  sellerEmail?: string
  createdAt: string
  priceChangeHistory?: any[]
}

export interface Deal {
  id: string
  address: string
  price: number
  stage: string
  clientName: string
  healthScore: number
  healthStatus: "Healthy" | "Critical" | "At Risk"
  nextTask: string
  missingDocs: number
  winProbability: number
  projectedGCI?: number
  tasksCompleted?: number
  tasksTotal?: number
  auditStatus?: "Archived" | "Open"
  auditPacketUrl?: string
  predictedClose?: string
}

export interface Lead {
  id: string
  name: string
  score: number
  status: string
  source: string
  tags: string[]
  sentiment: string
  urgency: number
  intent: string
  lastActivity: string
  lastActivityDate?: string
  aiSummary: string
  phone?: string
  email?: string
  propertyAddress?: string
  totalEngagementScore?: number
  engagementVelocity?: number
  isSurgeDetected?: boolean
  dncEnabled?: boolean
  latitude?: number
  longitude?: number
  buyerSegment?: string
  leadType?: "buyer" | "seller"
  creditStatus?: "good" | "fair" | "poor" | "unknown"
  creditPipelineStage?: "none" | "intake" | "review" | "partner_handoff" | "restoration"
  creditScoreBand?: string
  videoEngagementScore?: number
  budget?: number
  emailStatus?: "Valid" | "Risky" | "Invalid"
  phoneType?: string
  urgencyReason?: string
  socialProfileSummary?: string
  estimatedIncome?: string
  aiPersonalityTip?: string
  aiSuggestedOpeningLine?: string
  propertyIntelligence?: {
    estimatedValue?: number
    mortgageBalance?: number
    equityPercent?: number
    lastSaleDate?: string
    ownerStatus?: string
    loanType?: string
    aiSellPrediction?: string
    aiSellReason?: string
    lastEnriched?: string
  }
}

export interface ShowingFeedback {
  id: string
  showingEventId?: string
  showingId?: string
  listingId?: string
  address?: string
  leadName?: string
  buyerAgentName?: string
  buyerAgentEmail?: string
  buyerAgentPhone?: string
  feedbackReceived?: boolean
  feedbackRequestedAt?: string
  feedbackReceivedAt?: string
  interestLevel?: "very_interested" | "somewhat_interested" | "neutral" | "not_interested" | "Hot" | "Warm" | "Cold"
  liked?: string
  concerns?: string
  priceFeedback?: "priced_right" | "overpriced" | "underpriced" | "no_opinion"
  likelyToOffer?: "yes" | "maybe" | "no" | "already_made_offer"
  followUpNeeded?: boolean
  agentNotes?: string
  sentimentScore?: number
  createdAt?: string
  rawResponseText?: string
  keyObjections?: string[]
  publishedToSeller?: boolean
  timestamp?: string
}

export interface RealEstateEvent {
  id: string
  name: string
  dateTime: string
  location: string
  type: string
  description: string
  faqText?: string
  rsvpCount: number
  attendeeCount: number
  listingId?: string
  buyerAgentName?: string
}

export interface PropertyUpgrade {
  id: string
  listingId?: string
  contactId?: string
  upgradeCategory:
    | "kitchen"
    | "bathroom"
    | "flooring"
    | "roof"
    | "hvac"
    | "electrical"
    | "plumbing"
    | "windows"
    | "siding"
    | "landscaping"
    | "pool"
    | "garage"
    | "basement_finish"
    | "addition"
    | "other"
  description: string
  yearCompleted: number
  cost: number
  estimatedValueAdd?: number
  hasPermits: boolean
  hasReceipts: boolean
  photoUrls?: string[]
  createdAt: string
}

export interface UserContext {
  userId: string
  lastLatLong: string
  predictedIntent: string
  clientName: string
  address: string
  lockboxCode: string
}

export const FEATURE_FLAGS = {
  CREDIT_COPILOT: true,
  SYSTEM_LOGS: true,
  SUGGESTIONS: true,
}

export interface PastClient {
  id: string
  name: string
  closingDate: string
  homeAnniversary: string
  houseFeaturesTags?: string[]
  currentEstValue?: number
  referralsSent: number
  lastTouch: string
  giftStatus: "None" | "Sent"
  reviewStatus: "None" | "Requested" | "Received"
  birthday?: string
  children?: PastClient[]
}

export interface CreditConversationLog {
  id: string
  contactId: string
  summary: string
  createdAt: string
}

export interface CreditPartnerReferral {
  id: string
  contactId: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

export interface VideoEngagementEvent {
  id: string
  contactId: string
  videoAssetId: string
  eventType: "viewed" | "completed"
  createdAt: string
}

export interface Script {
  id: string
  title: string
  body: string
  targetPersona: TargetPersona
  videoMode: VideoMode
  heygenAvatarId?: string
  heygenVoiceId?: string
  status: ScriptStatus
  createdByUserId: string
  createdAt: string
  rejectedReason?: string
}

export type ScriptStatus = "Draft" | "PendingApproval" | "Approved" | "Rejected"
export type TargetPersona = "Agent" | "Buyer" | "Seller" | "PastClient" | "Partner"
export type VideoMode = "Avatar" | "Faceless"

export interface VideoAssetLibraryRecord {
  id: string
  scriptId: string
  status: VideoGenerationStatus
  outputUrl?: string
  thumbnailUrl?: string
  durationSeconds?: number
  createdAt: string
  persona?: string
  deliveryChannelTargets?: string[]
}

export type VideoGenerationStatus = "Queued" | "Generating" | "Ready" | "Failed"

export interface Message {
  id: string
  sender: "user" | "contact"
  text: string
  timestamp: string
  type: string
  mediaUrl?: string
  mediaType?: "image" | "audio"
  aiTranscription?: string
}

export interface DocumentRegistryEntry {
  id: string
  dealId: string
  fileNameCanonical: string
  driveLink: string
  docType: string
  privacyLevel: string
  size: string
  timestamp: string
}

export interface TaskMasterTemplate {
  id: string
  taskName: string
  role: string
  phase: string
  triggerKeyword?: string
  daysAfterAccepted: number
}

export interface ComplianceRule {
  id: string
  triggerKeyword: string
  requiredDoc: string
  logicDesc: string
}

export interface ContractTemplate {
  id: string
  name: string
  type: string
  lastMapped: string
}

export interface ComplianceReport {
  id: string
  month: string
  totalFilesAudited: number
  criticalErrorsFound: number
  riskScore: number
  pdfUrl: string
  aiExecutiveSummary: string
}

export interface SmartOffer {
  id: string
  agentId: string
  contactId: string
  offerText: string
  warmDMScript: string
  smsScript: string
  emailSnippet: string
  socialHook1: string
  socialHook2: string
  createdAt: string
}

export type AudienceType = "Buyer" | "Seller" | "Investor"
export type ContextType = "New Outreach" | "Follow-up" | "Referral Ask" | "Content Post"

// --- ADDED MISSING TYPES ---

/**
 * Added to fix "Module '"../../types"' has no exported member 'DetectedDefect'" in BuyerPortal.tsx
 */
export interface DetectedDefect {
  id: string
  transactionId: string
  description: string
  severity: "High" | "Med" | "Low"
  category: string
  matchedCategory?: string
  matchedOffer?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'MarketplaceVendor'" in BuyerPortal.tsx and PartnersManager.tsx
 */
export interface MarketplaceVendor extends Vendor {
  specialOffers?: string[]
  featured?: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ResourceGuide'" in BuyerPortal.tsx
 */
export interface ResourceGuide {
  id: string
  title: string
  description: string
  category: "Market" | "Expertise" | "Process"
  unlockedAt: string
  isNew?: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Showing'" in BuyerPortal.tsx and ShowingsDesk.tsx
 */
export interface Showing {
  id: string
  propertyId: string
  leadId: string
  address: string
  leadName: string
  requestedTime: string
  status: "Requested" | "Pending Seller Confirm" | "Confirmed" | "Picking Slots" | "Completed"
  isPreQualified: boolean
  proposedSlots?: CalendarSlot[]
  lockboxCode?: string
  alarmCode?: string
  clientBriefingLink?: string
  clientPrivateNotes?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'CalendarSlot'" in BuyerPortal.tsx
 */
export interface CalendarSlot {
  id: string
  showingId: string
  start: string
  end: string
  selected: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ComplianceChecklistItem'" in BuyerPortal.tsx
 */
export interface ComplianceChecklistItem {
  id: string
  dealId: string
  documentName: string
  status: "Approved" | "Missing" | "Pending Review"
  sourceRule: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ESignEnvelope'" in BuyerPortal.tsx
 */
export interface ESignEnvelope {
  id: string
  dealId: string
  status: "Sent" | "Delivered" | "Completed" | "Declined" | "Voided"
  sentAt: string
  completedAt?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ClientReferral'" in BuyerPortal.tsx and SphereManager.tsx
 */
export interface ClientReferral {
  id: string
  referrerId: string
  referrerName: string
  friendName: string
  friendPhone: string
  status: "New" | "Contacted" | "Closed Deal"
  rewardStatus: "Pending" | "Sent"
  rewardType: string
  timestamp: string
  notes?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'NegotiationRound'" in BuyerPortal.tsx
 */
export interface NegotiationRound {
  id: string
  dealId: string
  roundNumber: number
  offerPrice: number
  concessions: string
  closingDate: string
  status: "Received" | "Accepted" | "Rejected" | "Countered"
  timestamp: string
  source: "Other Side" | "Agent"
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'TransactionTask'" in BuyerPortal.tsx and ClosingDashboard.tsx
 */
export interface TransactionTask {
  id: string
  dealId: string
  title: string
  status: "To Do" | "In Progress" | "Done"
  priority: "High" | "Med" | "Low" | "Critical"
  category: string
  due: string
  phase: string
  assignedTo: string
  description?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'LoanStage'" in BuyerPortal.tsx
 */
export type LoanStage = "Application" | "Processing" | "Underwriting" | "Appraisal" | "Approved" | "CTC"

/**
 * Added to fix "Module '"../../types"' has no exported member 'Tour'" in BuyerPortal.tsx, ShowingsDesk.tsx and BuyerTours.tsx
 */
export interface Tour {
  id: string
  buyerId: string
  buyerName: string
  agentId: string
  tourDate: string
  startLocation: string
  startTime: string
  status: "Draft" | "Optimized" | "SentToBuyer"
  stops: TourStop[]
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'TourStop'" in BuyerTours.tsx
 */
export interface TourStop {
  id: string
  tourId: string
  propertyId: string
  address: string
  lat: number
  lng: number
  showDurationMinutes: number
  order: number
  arrivalTime: string
  departureTime?: string
  driveTimeFromPrevMinutes?: number
  imageUrl: string
  price?: number
  listingAgentName?: string
  listingAgentPhone?: string
  internalNotes?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'VideoAsset'" in MarketingStudio.tsx
 */
export interface VideoAsset {
  id: string
  url: string
  type: "image" | "video"
  status: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ContentIdea'" in MarketingStudio.tsx
 */
export interface ContentIdea {
  id: string
  title: string
  type: ContentIdeaType
  platform: ContentIdeaPlatform
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'CompetitorSnapshot'" in MarketingStudio.tsx
 */
export interface CompetitorSnapshot {
  id: string
  agentName: string
  recentVolume: number
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Keyword'" in MarketingStudio.tsx
 */
export interface Keyword {
  id: string
  keyword: string
  intent: KeywordIntent
  category: KeywordCategory
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ContentIdeaType'" in MarketingStudio.tsx
 */
export type ContentIdeaType = "Educational" | "Local" | "Personal" | "Listing"

/**
 * Added to fix "Module '"../../types"' has no exported member 'ContentIdeaPlatform'" in MarketingStudio.tsx
 */
export type ContentIdeaPlatform = "Instagram" | "Facebook" | "LinkedIn" | "TikTok" | "YouTube" | "Pinterest"

/**
 * Added to fix "Module '"../../types"' has no exported member 'SocialTone'" in MarketingStudio.tsx
 */
export type SocialTone = "Professional" | "Bold" | "Minimalist"

/**
 * Added to fix "Module '"../../types"' has no exported member 'LongFormVideo'" in MarketingStudio.tsx
 */
export interface LongFormVideo {
  id: string
  title: string
  originalUrl: string
  durationSeconds: number
  uploadedByUserId: string
  sourceType: SourceType
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ShortClip'" in MarketingStudio.tsx
 */
export interface ShortClip {
  id: string
  title: string
  platform: ClipPlatform
  dimensions: ClipDimensions
  hook: string
  caption: string
  thumbnailUrl?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'SourceType'" in MarketingStudio.tsx
 */
export type SourceType = "listing_tour" | "educational_talking_head" | "vlog"

/**
 * Added to fix "Module '"../../types"' has no exported member 'ClipPlatform'" in MarketingStudio.tsx
 */
export type ClipPlatform = "instagram_reel" | "tiktok" | "youtube_short" | "facebook_reel" | "all"

/**
 * Added to fix "Module '"../../types"' has no exported member 'ClipDimensions'" in MarketingStudio.tsx
 */
export type ClipDimensions = "9:16_vertical" | "1:1_square" | "16:9_horizontal"

/**
 * Added to fix "Module '"../../types"' has no exported member 'KeywordIntent'" in MarketingStudio.tsx
 */
export type KeywordIntent = "Informational" | "Transactional" | "Navigational"

/**
 * Added to fix "Module '"../../types"' has no exported member 'KeywordCategory'" in MarketingStudio.tsx
 */
export type KeywordCategory = "Neighborhood" | "Strategy" | "Market Trends"

/**
 * Added to fix "Module '"../../types"' has no exported member 'SocialPlatform'" in SocialScheduler.tsx
 */
export type SocialPlatform = "Instagram" | "Facebook" | "LinkedIn" | "TikTok" | "YouTube" | "Pinterest" | "X"

/**
 * Added to fix "Module '"../../types"' has no exported member 'NewsletterCampaign'" in MarketingStudio.tsx
 */
export interface NewsletterCampaign {
  id: string
  title: string
  subjectLine: string
  previewText?: string
  templateStyle: "modern" | "bold" | "minimal"
  status: "draft" | "sent" | "scheduled"
  includeVideoIds: string[]
  includeListingIds: string[]
  includeContentIdeaIds: string[]
  sentToCount?: number
  audienceCount: number
  openRate?: number
  clickRate?: number
  createdByUserId: string
  createdAt: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'DirectMailCampaign'" in MarketingStudio.tsx
 */
export interface DirectMailCampaign {
  id: string
  title: string
  mailType: "postcard" | "letter" | "flyer"
  templateId: string
  contentHeadline: string
  contentBody: string
  contentCta: string
  status: "draft" | "sent" | "approved"
  audienceCount: number
  totalCost: number
  costPerPiece: number
  provider: string
  createdByUserId: string
  createdAt: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Prospect'" in CRM.tsx
 */
export interface Prospect {
  id: string
  name: string
  score: number
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ScrapeJob'" in CRM.tsx
 */
export interface ScrapeJob {
  id: string
  status: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'SearchActivityLog'" in CRM.tsx
 */
export interface SearchActivityLog {
  id: string
  query: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'SocialLeadLog'" in CRM.tsx
 */
export interface SocialLeadLog {
  id: string
  platform: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Vendor'" in VendorMarketplace.tsx and PartnersManager.tsx
 */
export interface Vendor {
  id: string
  companyName: string
  category: string
  rating: number
  verified: boolean
  insuranceStatus: string
  dealsClosed: number
  status: string
  description?: string
  logoUrl?: string
  isStarredByAgent?: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'PointRule'" in SystemConfig.tsx
 */
export interface PointRule {
  id: string
  activity: string
  basePoints: number
  currentMultiplier: number
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ScoringWeight'" in SystemConfig.tsx
 */
export interface ScoringWeight {
  id: string
  activityName: string
  points: number
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ComplianceLogEntry'" in SystemConfig.tsx
 */
export interface ComplianceLogEntry {
  id: string
  phoneNumber: string
  status: string
  evidence: string
  timestamp: string
  source: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Agent'" in airtable.ts, LeadDistribution.tsx, AgentRoster.tsx and VideoGenerator.tsx
 */
export interface Agent {
  id: string
  name: string
  role: string
  email: string
  phone: string
  volume: number
  deals: number
  capProgress: number
  capPaid: number
  capTotal: number
  status: string
  availability: string
  dailyLeadCap: number
  leadsReceivedToday: number
  closingRate: number
  badges: string[]
  teamLead?: string
  serviceAreasZips?: string[]
  specialties?: string[]
  heyGenAvatarId?: string
  heyGenVoiceId?: string
  defaultVideoBackgroundType?: "solid_color" | "image_url" | "video_url"
  defaultVideoBackgroundValue?: string
  onboardingChecklist?: {
    videoConfigured: boolean
  }
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ChannelType'" in UnifiedInbox.tsx
 * Updated to include social media channels for unified inbox
 */
export type ChannelType = "sms" | "email" | "whatsapp" | "facebook" | "instagram" | "twitter"

/**
 * Added to fix "Module '"../../types"' has no exported member 'Conversation'" in UnifiedInbox.tsx
 */
export interface Conversation {
  id: string
  contactName: string
  lastMessage: string
  timestamp: string
  unread: number
  channel: ChannelType
  avatarColor: string
  sentiment: string
  messages: Message[]
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'SellerReport'" in SellerDashboard.tsx and ListingReports.tsx
 */
export interface SellerReport {
  id: string
  listingId: string
  address: string
  weekEnding: string
  viewsZillow: number
  showingsCount: number
  status: "Sent" | "Draft"
  feedbackSummaryAI: string
  pdfUrl?: string
  openRate?: number
  replyRate?: number
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'MarketStat'" in SellerDashboard.tsx
 */
export interface MarketStat {
  id: string
  address: string
  price: string
  status: string
  trend: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'MarketingAsset'" in SellerDashboard.tsx
 */
export interface MarketingAsset {
  id: string
  listingId: string
  name: string
  url: string
  type: "Video" | "Image" | "PDF"
  platform: string
  category: string
  aiTags: string[]
  uploadDate: string
  size: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'OpenHouse'" in SellerDashboard.tsx and OpenHouseManager.tsx
 */
export interface OpenHouse {
  id: string
  listingId: string
  address: string
  startTime: string
  endTime: string
  theme: string
  status: "Active" | "Closed"
  rsvpCount: number
  qrCodeUrl?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'NetSheetScenario'" in SellerDashboard.tsx
 */
export interface NetSheetScenario {
  id: string
  offerPrice: number
  mortgagePayoff: number
  brokerageFeePercent: number
  closingCostsPercent: number
  propertyTaxProration: number
  repairCredits: number
  otherFees: number
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'CommissionRecord'" in Financials.tsx
 */
export interface CommissionRecord {
  id: string
  date: string
  address: string
  agentName: string
  gci: number
  split: number
  agentNet: number
  brokerNet: number
  status: "Paid" | "Pending" | "Dispute"
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'MarketingChannel'" in Financials.tsx
 */
export interface MarketingChannel {
  channel: string
  spend: number
  leads: number
  deals: number
  gci: number
  cac: number
  roas: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Payout'" in Financials.tsx
 */
export interface Payout {
  id: string
  agentStripeId: string
  agentName: string
  amount: number
  currency: string
  referenceDeal: string
  status: "Ready" | "Paid"
  executedAt?: string
  stripeTransferId?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'TransactionDocument'" in Documents.tsx
 */
export interface TransactionDocument {
  id: string
  name: string
  dealId: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'DocType'" in Documents.tsx
 */
export type DocType = "Contract" | "Disclosure" | "Inspection" | "Closing"

/**
 * Added to fix "Module '"../../types"' has no exported member 'PrivacyLevel'" in Documents.tsx
 */
export type PrivacyLevel = "Internal" | "Client-Shared" | "Public"

/**
 * Added to fix "Module '"../../types"' has no exported member 'ClientPlaybookData'" in ClientPlaybook.tsx
 */
export interface ClientPlaybookData {
  id: string
  name: string
  progress: number
  currentStepIndex: number
  lastActivity: string
  stalled: boolean
  steps: PlaybookStep[]
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'PlaybookStep'" in ClientPlaybook.tsx
 */
export interface PlaybookStep {
  id: string
  title: string
  description: string
  type: "video" | "upload" | "form" | "tool" | "action"
  status: "complete" | "active" | "locked"
  videoUrl?: string
  requiredDoc?: string
  resourceLink?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Review'" in SphereManager.tsx
 */
export interface Review {
  id: string
  clientName: string
  platform: "Google" | "Zillow" | "Facebook"
  rating: number
  text: string
  date: string
  status: "Pending" | "Replied"
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ReviewAndFeedback'" in SphereManager.tsx
 */
export interface ReviewAndFeedback {
  id: string
  transactionId: string
  clientName: string
  agentName: string
  internalRating: number
  status: "Requested" | "Received" | "Nurture Mode"
  giftSent: boolean
  timestamp: string
  sentimentTrend: "Euphoric" | "Positive" | "Neutral" | "Rocky" | "Negative"
  feedbackText?: string
  publicReviewLink?: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'TaskRole'" in ComplianceManager.tsx
 */
export type TaskRole = "Agent" | "Client" | "TC" | "Lender" | "Title"

/**
 * Added to fix "Module '"../../types"' has no exported member 'AuditFlag'" in AIAudit.tsx
 */
export interface AuditFlag {
  id: string
  leadName: string
  riskType: "Compliance" | "Bad Lead Pattern"
  riskScore: number
  explanation: string
  transcriptSnippet: string
  status: "Pending" | "Resolved"
  detectedAt: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'VendorApplication'" in VendorCompliance.tsx
 */
export interface VendorApplication {
  id: string
  businessName: string
  contactEmail: string
  description: string
  category: string
  status: "New" | "AI Review" | "Approved" | "Rejected"
  aiSuggestedTags: string[]
  licenseUrl: string
  submittedDate: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'EventRegistration'" in Events.tsx
 */
export interface EventRegistration {
  id: string
  eventId: string
  contactId: string
  contactName: string
  status: "Registered" | "Attended" | "Cancelled"
  invitedByAgentId: string
  timestamp: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'RoutingLog'" in LeadDistribution.tsx
 */
export interface RoutingLog {
  id: string
  leadName: string
  agentName: string
  agentId: string
  zipCode: string
  budget: number
  matchReason: string
  timestamp: string
  status: "Assigned" | "Overridden"
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'NotificationRule'" in NotificationSettings.tsx
 */
export interface NotificationRule {
  id: string
  name: string
  scoreThreshold: number
  primaryChannel: "SMS" | "Email" | "Slack"
  isActive: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'NotificationPreference'" in NotificationSettings.tsx
 */
export interface NotificationPreference {
  agentId: string
  smsHotLeads: boolean
  emailWarmLeads: boolean
  slackTeamUpdates: boolean
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'DealStakeholder'" in NotificationSettings.tsx
 */
export interface DealStakeholder {
  id: string
  dealId: string
  role: string
  name: string
  email: string
  phone: string
  autoNotify: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'CommsAuditLog'" in NotificationSettings.tsx
 */
export interface CommsAuditLog {
  id: string
  recipientType: string
  messageBody: string
  timestamp: string
  channel: "SMS" | "Email"
  status: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ReminderConfig'" in NotificationSettings.tsx
 */
export interface ReminderConfig {
  intervals: ("24h" | "2h" | "15m")[]
  googleMapsApiKey: string
  weatherApiKey: string
  isActive: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Closing'" in ClosingDashboard.tsx
 */
export interface Closing {
  id: string
  address: string
  closingDate: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ListingApproval'" in ListingApprovals.tsx
 */
export interface ListingApproval {
  id: string
  listingId: string
  address: string
  agentName: string
  riskScore: number
  flaggedTerms: string[]
  price: number
  pricePerSqft: number
  status: "Pending AI" | "Needs Review" | "Approved" | "Rejected"
  aiFeedback?: string
  submittedDate: string
  description: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'OHTemplate'" in OpenHouseManager.tsx
 */
export interface OHTemplate {
  id: string
  name: string
  description: string
  aiPrompt: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'TagRule'" in SegmentationDesk.tsx
 */
export interface TagRule {
  id: string
  ruleName: string
  conditionField: string
  conditionValue: string
  frequencyThreshold: number
  tagToApply: string
  isActive: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'AvailabilitySettings'" in CalendarDashboard.tsx
 */
export interface AvailabilitySettings {
  allowDoubleBooking: boolean
  driveTimeBufferMins: number
  workingHoursStart: string
  workingHoursEnd: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'FeedbackConfig'" in FeedbackDesk.tsx
 */
export interface FeedbackConfig {
  delayTimeMins: number
  autoShareWithSeller: boolean
  isActive: boolean
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'RiskIncident'" in RiskManagement.tsx
 */
export interface RiskIncident {
  id: string
  severity: string
  triggerPhrase: string
  status: "Open" | "Broker Intervening" | "Resolved"
  transcript: string
  clientName: string
  agentName: string
  dealId: string
  timestamp: string
  sentimentScore: number
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'SocialContent'" in SocialScheduler.tsx
 */
export interface SocialContent {
  id: string
  platform: SocialPlatform
  category: SocialCategory
  imageUrl: string
  captionText: string
  format: MediaFormat
  status: "Draft" | "Scheduled" | "Posted"
  complianceScore: number
  complianceFlags: string[]
  ghlSyncStatus: "Pending" | "Synced" | "Failed"
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'SocialCategory'" in SocialScheduler.tsx
 */
export type SocialCategory = "Educational" | "Local" | "Personal" | "Listing"

/**
 * Added to fix "Module '"../../types"' has no exported member 'MediaFormat'" in SocialScheduler.tsx
 */
export type MediaFormat = "Square" | "Vertical" | "Horizontal"

/**
 * Added to fix "Module '"../../types"' has no exported member 'AgentVideo'" in VideoGenerator.tsx
 */
export interface AgentVideo {
  id: string
  url: string
  videoPurpose: "intro" | "followup" | "update"
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'Recruit'" in RecruitingHub.tsx
 */
export interface Recruit {
  id: string
  name: string
  email: string
  phone: string
  status: "Lead" | "Applied" | "Interviewing" | "Offered" | "Joined"
  sourceAgentId: string
  sourceAgentName: string
  experienceYears: number
  lastProductionVolume?: number
  timestamp: string
  notes?: string
}

/**
 * Added to fix missing members in ListingDistribution.tsx
 */
export interface SyndicationLink {
  id: string
  listingId: string
  platform: string
  url: string
  status: "Active" | "Processing" | "Failed"
  clicks: number
}

export interface SyndicationError {
  id: string
  listingId: string
  address: string
  platform: string
  error: string
  timestamp: string
}

// --- MISSING INTERFACES FOR FINANCIALS AND CLIENT SELF-SERVICE ---

/**
 * Added to fix "Module '"../../types"' has no exported member 'ClientDocument'" in ClientPlaybook.tsx
 */
export interface ClientDocument {
  id: string
  contactId: string
  documentType: string
  fileUrl: string
  fileName: string
  fileSize: number
  status: "pending" | "approved" | "needs_reupload"
  createdAt: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'ShowingRequest'" in ClientPlaybook.tsx
 */
export interface ShowingRequest {
  id: string
  contactId: string
  listingId: string
  requestedDate: string
  requestedTime: string
  alternateTimes?: string
  status: "pending" | "confirmed" | "rejected"
  createdAt: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'CommissionCalculation'" in FinancialsView.tsx
 */
export interface CommissionCalculation {
  id: string
  agentUserId: string
  grossCommission: number
  netCommission: number
  salePrice: number
  commissionRate: number
  brokerageSplitPercentage: number
  agentGrossCommission: number
  teamLeadSplit?: number
  referralFeeOut?: number
  tcFee?: number
  expectedDepositAmount?: number
  actualDepositAmount?: number
  depositVariance: number
  status: "pending" | "paid" | "discrepancy"
  createdAt: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'BusinessExpense'" in FinancialsView.tsx
 */
export interface BusinessExpense {
  id: string
  userId: string
  merchant?: string
  description: string
  category: string
  amount: number
  expenseDate: string
  createdAt: string
}

/**
 * Added to fix "Module '"../../types"' has no exported member 'TaxProjection'" in FinancialsView.tsx
 */
export interface TaxProjection {
  id: string
  userId: string
  year: number
  quarter: number
  estimatedTaxDue: number
  calculationDate: string
}

export type InsiderEditVibe = "family" | "bachelor" | "investment" | "luxury" | "first_time"

export interface InsiderEditInput {
  zipCode: string
  city: string
  vibe: InsiderEditVibe
  listingUrl: string
  pressureTestHighlights: string[] // 3 required non-MLS highlights
  agentPastToneContext?: string // For RAG/tone matching
}

export interface InsiderEditSection {
  sectionType: "hook" | "events" | "civic" | "deal" | "eats"
  title: string
  content: string
  editableContent: string
  aiPrompt?: string // Stores the prompt used for this section
}

export interface InsiderEditNewsletter {
  id: string
  title: string
  listingAddress?: string
  listingUrl?: string
  vibe: InsiderEditVibe
  zipCode: string
  city: string
  sections: InsiderEditSection[]
  pressureTestHighlights: string[]
  emailHtml: string
  emailPreviewText: string
  status: "draft" | "preview" | "ready" | "sent"
  tone: "curator" | "custom"
  createdByUserId: string
  createdAt: string
  updatedAt?: string
  sentAt?: string
  sentToCount?: number
  openRate?: number
}

export interface ListingAnalysis {
  address: string
  recentPriceDrop: boolean
  curbAppealScore: number
  hiddenValuePoints: string[]
  vibeMatch: InsiderEditVibe
  marketContext?: string
}

export type {
  Contact,
  ContactType,
  ContactPersona,
  ContactStatus,
  ContactTimeline,
  ContactSource,
  ContactFilters,
  PropertyInterest,
} from "./types/contact"
