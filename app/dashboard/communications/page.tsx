import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { getConversations, prioritizeInbox } from "@/app/actions/ai-communication-hub"
// Lane E2 2026-08-28: getCommunicationStats WIRED — 30-day outbound volume
// for the OS header strip (session-tenanted inside the action).
import { getCommunicationStats } from "@/app/actions/communications"
import { CommunicationsOSClient } from "./communications-os-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "Communications OS",
  description: "Unified communications command center — inbox, outreach, AI-assisted messaging across all channels including social media",
}

// Supported social platforms for DM tracking
const SOCIAL_PLATFORMS = [
  { platform: "facebook", label: "Facebook" },
  { platform: "instagram", label: "Instagram" },
  { platform: "linkedin", label: "LinkedIn" },
  { platform: "twitter", label: "Twitter/X" },
  { platform: "tiktok", label: "TikTok" },
  { platform: "youtube", label: "YouTube" },
  { platform: "pinterest", label: "Pinterest" },
  { platform: "google_business", label: "Google Business" },
]

export default async function CommunicationsOSPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const service = createServiceClient()

  // Resolve user profile
  const [profileRes, agentRes] = await Promise.all([
    service
      .from("users")
      .select("id, brokerage_id, user_type, assistant_wake_name")
      .eq("id", user.id)
      .single(),
    service
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ])

  const profile = profileRes.data
  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId: string = profile.brokerage_id
  const role: string = profile.user_type ?? "agent"
  const agentId = await resolveAgentId(service, user.id)
  if (!agentId) redirect("/dashboard/onboarding")

  // Fetch data in parallel
  const [
    conversationsResult,
    prioritizedResult,
    templatesRes,
    sequenceEnrollmentsRes,
    unreadCountRes,
    socialAccountsRes,
    socialMessagesRes,
    commStatsResult,
  ] = await Promise.all([
    // All conversations
    getConversations({ brokerageId, limit: 100 }),
    // Prioritized inbox messages
    agentId ? prioritizeInbox({ agentId, limit: 50 }) : Promise.resolve({ success: true, prioritizedMessages: [], summary: null }),
    // Email templates
    service
      .from("email_templates")
      .select("id, name, subject, body, template_type")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("name"),
    // Active sequence enrollments
    service
      .from("sequence_enrollments")
      .select(`
        id,
        status,
        current_step,
        enrolled_at,
        sequence_id,
        contact_id,
        contacts(first_name, last_name),
        campaign_sequences(name, id, 
          campaign_sequence_steps(count)
        )
      `)
      .eq("status", "active")
      .order("enrolled_at", { ascending: false })
      .limit(20),
    // Unread count by channel (traditional channels)
    service
      .from("conversations")
      .select("type, unread_count")
      .eq("brokerage_id", brokerageId)
      .gt("unread_count", 0),
    // Connected social media accounts
    service
      .from("social_media_accounts")
      .select("id, platform, account_name, is_active")
      .or(`brokerage_id.eq.${brokerageId},agent_id.eq.${agentId}`)
      .eq("is_active", true),
    // Social DM conversations (using conversations table with social types)
    service
      .from("conversations")
      .select("type, unread_count")
      .eq("brokerage_id", brokerageId)
      .in("type", ["facebook", "instagram", "linkedin", "twitter", "tiktok", "youtube", "pinterest", "google_business", "social_dm"])
      .gt("unread_count", 0),
    // 30-day outbound message volume (session-tenanted inside the action)
    getCommunicationStats({ startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
  ])

  // Process conversations
  const conversations = conversationsResult.success
    ? (conversationsResult as any).conversations ?? []
    : []

  // Process prioritized messages
  const prioritizedMessages = prioritizedResult.success
    ? (prioritizedResult as any).prioritizedMessages ?? []
    : []

  const inboxSummary = prioritizedResult.success
    ? (prioritizedResult as any).summary ?? { total: 0, critical: 0, highPriority: 0, requiresAction: 0 }
    : { total: 0, critical: 0, highPriority: 0, requiresAction: 0 }

  // Process templates
  const templates = (templatesRes.data ?? []).map((t: any) => ({
    id: t.id,
    name: t.name,
    subject: t.subject ?? undefined,
    body: t.body ?? undefined,
    channel: t.template_type ?? "all",
  }))

  // Process sequence enrollments
  const sequenceEnrollments = (sequenceEnrollmentsRes.data ?? []).map((e: any) => ({
    id: e.id,
    contactName: e.contacts ? `${e.contacts.first_name} ${e.contacts.last_name}` : "Unknown",
    contactId: e.contact_id,
    sequenceName: e.campaign_sequences?.name ?? "Unknown Sequence",
    sequenceId: e.sequence_id,
    currentStep: e.current_step ?? 1,
    totalSteps: e.campaign_sequences?.campaign_sequence_steps?.[0]?.count ?? 1,
    status: e.status as "active" | "paused" | "completed" | "failed",
    nextStepAt: undefined, // Would need to calculate from steps
    nextStepChannel: "email" as const,
  }))

  // Calculate unread counts by channel (traditional)
  const unreadData = unreadCountRes.data ?? []
  const emailUnread = unreadData
    .filter((c: any) => c.type === "email")
    .reduce((sum: number, c: any) => sum + (c.unread_count || 0), 0)
  const smsUnread = unreadData
    .filter((c: any) => c.type === "sms")
    .reduce((sum: number, c: any) => sum + (c.unread_count || 0), 0)
  const totalUnread = unreadData
    .filter((c: any) => !["facebook", "instagram", "linkedin", "twitter", "tiktok", "youtube", "pinterest", "google_business", "social_dm"].includes(c.type))
    .reduce((sum: number, c: any) => sum + (c.unread_count || 0), 0)

  // Calculate social media DM counts
  const socialMessagesData = socialMessagesRes.data ?? []
  const connectedAccounts = socialAccountsRes.data ?? []
  
  // Build social channel counts
  const socialChannels = SOCIAL_PLATFORMS.map((p) => {
    const platformUnread = socialMessagesData
      .filter((c: any) => c.type === p.platform || c.type === `${p.platform}_dm`)
      .reduce((sum: number, c: any) => sum + (c.unread_count || 0), 0)
    
    const isConnected = connectedAccounts.some((a: any) => a.platform === p.platform)
    
    return {
      platform: p.platform,
      label: p.label,
      unread: platformUnread,
      connected: isConnected,
    }
  }).filter((p) => p.connected || p.unread > 0) // Only show connected or those with messages

  const totalSocialUnread = socialChannels.reduce((sum, c) => sum + c.unread, 0)

  // Build pressure items from prioritized messages
  const pressureItems = prioritizedMessages.slice(0, 20).map((msg: any) => ({
    id: msg.id,
    contactName: msg.contacts ? `${msg.contacts.first_name} ${msg.contacts.last_name}` : "Unknown",
    channel: msg.type as "email" | "sms" | "voicemail" | "facebook" | "instagram" | "linkedin" | "twitter",
    subject: msg.subject,
    preview: msg.content?.slice(0, 100) ?? "",
    waitingHours: msg.created_at
      ? Math.round((Date.now() - new Date(msg.created_at).getTime()) / (1000 * 60 * 60))
      : 0,
    urgency: msg.analysis?.urgency === "critical" ? "critical" as const :
             msg.priority <= 2 ? "high" as const :
             msg.priority <= 3 ? "medium" as const : "low" as const,
    sentiment: msg.analysis?.sentiment,
    contactId: msg.contact_id,
    conversationId: msg.conversation_id,
  }))

  // Build sentiment items
  const sentimentItems = prioritizedMessages.slice(0, 15).map((msg: any) => ({
    id: msg.id,
    contactName: msg.contacts ? `${msg.contacts.first_name} ${msg.contacts.last_name}` : "Unknown",
    contactId: msg.contact_id,
    sentiment: (msg.analysis?.sentiment ?? "neutral") as any,
    urgency: msg.analysis?.urgency === "critical" ? "critical" as const :
             msg.priority <= 2 ? "high" as const :
             msg.priority <= 3 ? "medium" as const : "low" as const,
    trend: "stable" as const,
    lastMessage: msg.content?.slice(0, 100) ?? "",
    requiresAction: msg.analysis?.requiresImmediateAction ?? false,
  }))

  return (
    <CommunicationsOSClient
      brokerageId={brokerageId}
      agentId={agentId}
      userId={user.id}
      role={role}
      conversations={conversations}
      templates={templates}
      sequenceEnrollments={sequenceEnrollments}
      pressureItems={pressureItems}
      sentimentItems={sentimentItems}
      inboxStats={{
        totalUnread,
        emailUnread,
        smsUnread,
        voicemailCount: 0,
        urgentCount: inboxSummary.critical,
        avgResponseTime: 45,
        responseTimeTrend: "stable" as const,
        oldestUnreadHours: pressureItems[0]?.waitingHours ?? 0,
        // Social media stats
        socialChannels,
        totalSocialUnread,
      }}
      connectedSocialAccounts={connectedAccounts.map((a: any) => ({
        id: a.id,
        platform: a.platform,
        accountName: a.account_name,
      }))}
      outboundStats={
        commStatsResult.success && "stats" in commStatsResult && commStatsResult.stats
          ? {
              total: commStatsResult.stats.total,
              sms: commStatsResult.stats.sms,
              email: commStatsResult.stats.email,
              call: commStatsResult.stats.call,
            }
          : null
      }
    />
  )
}
