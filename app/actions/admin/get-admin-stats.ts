'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { createClient } from '@/lib/supabase/server'

export async function getAdminDashboardStats() {
  try {
    const supabase = createServiceClient()
    const authClient = await createClient()
    
    // Get current user to determine brokerage
    const { data: { user } } = await authClient.auth.getUser()
    if (!user?.id) {
      return getEmptyStats()
    }

    // Get user's brokerage_id
    const { data: userData } = await supabase
      .from('users')
      .select('brokerage_id')
      .eq('id', user.id)
      .maybeSingle()

    const brokerageId = userData?.brokerage_id

    // If no brokerage, return empty stats
    if (!brokerageId) {
      return getEmptyStats()
    }

  // Get current date info
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const startOfWeek = new Date(now)
  startOfWeek.setDate(now.getDate() - now.getDay())

  // Parallel fetch all stats
  const [
    agentsResult,
    onboardingResult,
    transactionsResult,
    closedTransactionsResult,
    listingsResult,
    leadsResult,
    hotLeadsResult,
    approvalsResult,
    complianceResult,
    tasksResult,
    showingsResult,
    topAgentsResult,
  ] = await Promise.all([
    // Total agents and active agents
    supabase
      .from('agents')
      .select('id, is_active, created_at', { count: 'exact' })
      .eq('brokerage_id', brokerageId),

    // Pending onboarding
    supabase
      .from('agent_onboarding')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .in('status', ['pending', 'in_progress']),

    // Active transactions
    supabase
      .from('transactions')
      .select('id, status, purchase_price, created_at', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .not('status', 'eq', 'closed'),

    // Closed transactions this month
    supabase
      .from('transactions')
      .select('id, purchase_price, close_date', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .eq('status', 'closed')
      .gte('close_date', startOfMonth.toISOString().split('T')[0]),

    // Listings
    supabase
      .from('listings')
      .select('id, status, created_at, listing_date', { count: 'exact' })
      .eq('brokerage_id', brokerageId),

    // Total leads
    supabase
      .from('leads')
      .select('id, lead_score, created_at', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .eq('is_active', true),

    // Hot leads (score >= 70)
    supabase
      .from('leads')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .eq('is_active', true)
      .gte('lead_score', 70),

    // Pending approvals
    supabase
      .from('approval_items')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .eq('status', 'pending'),

    // Compliance alerts
    supabase
      .from('compliance_events')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .eq('allowed', false),

    // Overdue tasks
    supabase
      .from('tasks')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .eq('status', 'pending')
      .lt('due_date', now.toISOString().split('T')[0]),

    // Scheduled showings
    supabase
      .from('showings')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .gte('scheduled_at', now.toISOString())
      .eq('status', 'scheduled'),

    // Top agents by volume
    supabase
      .from('agents')
      .select(`
        id,
        user_id,
        ytd_gci,
        ytd_transactions,
        users!inner(first_name, last_name)
      `)
      .eq('brokerage_id', brokerageId)
      .eq('is_active', true)
      .order('ytd_gci', { ascending: false })
      .limit(5),
  ])

  // Calculate stats
  const agents = agentsResult.data || []
  const totalAgents = agentsResult.count || 0
  const activeAgents = agents.filter(a => a.is_active).length
  const newAgentsThisMonth = agents.filter(a => 
    a.created_at && new Date(a.created_at) >= startOfMonth
  ).length

  const transactions = transactionsResult.data || []
  const closedTransactions = closedTransactionsResult.data || []
  const totalTransactions = transactionsResult.count || 0
  const pendingTransactions = transactions.filter(t => t.status === 'pending').length
  const closedThisMonth = closedTransactionsResult.count || 0
  
  const monthlyVolume = closedTransactions.reduce((sum, t) => sum + (t.purchase_price || 0), 0)
  
  // Get YTD volume
  const startOfYear = new Date(now.getFullYear(), 0, 1)
  const { data: ytdTransactions } = await supabase
    .from('transactions')
    .select('purchase_price')
    .eq('brokerage_id', brokerageId)
    .eq('status', 'closed')
    .gte('close_date', startOfYear.toISOString().split('T')[0])

  const ytdVolume = (ytdTransactions || []).reduce((sum, t) => sum + (t.purchase_price || 0), 0)

  const listings = listingsResult.data || []
  const activeListings = listings.filter(l => l.status === 'active').length
  const newListingsThisMonth = listings.filter(l => 
    l.created_at && new Date(l.created_at) >= startOfMonth
  ).length
  const pendingListings = listings.filter(l => l.status === 'pending').length
  
  // Expiring listings (within 30 days)
  const thirtyDaysFromNow = new Date(now)
  thirtyDaysFromNow.setDate(now.getDate() + 30)
  const expiringListings = listings.filter(l => {
    if (!l.listing_date) return false
    const listingDate = new Date(l.listing_date)
    const expiryDate = new Date(listingDate)
    expiryDate.setMonth(expiryDate.getMonth() + 6) // Assume 6 month listing
    return expiryDate <= thirtyDaysFromNow && expiryDate > now
  }).length

  const leads = leadsResult.data || []
  const totalLeads = leadsResult.count || 0
  const newLeadsThisWeek = leads.filter(l => 
    l.created_at && new Date(l.created_at) >= startOfWeek
  ).length
  const hotLeads = hotLeadsResult.count || 0

  // Calculate conversion rate
  const { count: convertedLeads } = await supabase
    .from('leads')
    .select('id', { count: 'exact' })
    .eq('brokerage_id', brokerageId)
    .eq('lead_stage', 'converted')

  const conversionRate = totalLeads > 0 
    ? Math.round(((convertedLeads || 0) / totalLeads) * 100) 
    : 0

  // Top agents
  const topAgents = (topAgentsResult.data || []).map((agent: any) => ({
    id: agent.id,
    name: `${agent.users?.first_name || ''} ${agent.users?.last_name || ''}`.trim() || 'Unknown',
    transactions: agent.ytd_transactions || 0,
    volume: agent.ytd_gci || 0,
  }))

  // Wire previously hardcoded metrics from real DB queries
  const [
    docsAwaitingResult,
    upcomingDeadlinesResult,
    unreadMessagesResult,
    avgDaysResult,
  ] = await Promise.all([
    // Documents awaiting agent or broker review
    supabase
      .from('transaction_documents')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .in('status', ['pending', 'received']),

    // Transaction milestones due within the next 7 days
    supabase
      .from('transaction_milestones')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .eq('status', 'pending')
      .lte('target_date', new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0])
      .gte('target_date', now.toISOString().split('T')[0]),

    // Unread notifications for this brokerage's agents
    supabase
      .from('notifications')
      .select('id', { count: 'exact' })
      .eq('brokerage_id', brokerageId)
      .eq('is_read', false),

    // Average days-to-close from actual closed transactions this year
    supabase
      .from('transactions')
      .select('created_at, close_date')
      .eq('brokerage_id', brokerageId)
      .eq('status', 'closed')
      .gte('close_date', startOfYear.toISOString().split('T')[0])
      .not('close_date', 'is', null)
      .not('created_at', 'is', null),
  ])

  const avgDays = (() => {
    const rows = avgDaysResult.data || []
    if (rows.length === 0) return 30
    const total = rows.reduce((sum, t) => {
      const created = new Date(t.created_at).getTime()
      const closed = new Date(t.close_date).getTime()
      return sum + Math.max(0, (closed - created) / 86400000)
    }, 0)
    return Math.round(total / rows.length)
  })()

  return {
    // Agent metrics
    totalAgents,
    activeAgents,
    pendingOnboarding: onboardingResult.count || 0,
    newAgentsThisMonth,
    // Transaction metrics
    totalTransactions,
    pendingTransactions,
    closedThisMonth,
    monthlyVolume,
    ytdVolume,
    avgDaysToClose: avgDays,
    // Listing metrics
    activeListings,
    newListingsThisMonth,
    pendingListings,
    expiringListings,
    // Lead metrics
    totalLeads,
    newLeadsThisWeek,
    hotLeads,
    conversionRate,
    // Compliance & approvals
    pendingApprovals: approvalsResult.count || 0,
    complianceAlerts: complianceResult.count || 0,
    documentsAwaitingReview: docsAwaitingResult.count || 0,
    // Activity metrics
    tasksOverdue: tasksResult.count || 0,
    upcomingDeadlines: upcomingDeadlinesResult.count || 0,
    unreadMessages: unreadMessagesResult.count || 0,
    scheduledShowings: showingsResult.count || 0,
    // Recent activity
    recentActivities: [],
    // Top performers
    topAgents,
  }
  } catch (error) {
    console.error('[v0] Error fetching admin dashboard stats:', error)
    return getEmptyStats()
  }
}

function getEmptyStats() {
  return {
    totalAgents: 0,
    activeAgents: 0,
    pendingOnboarding: 0,
    newAgentsThisMonth: 0,
    totalTransactions: 0,
    pendingTransactions: 0,
    closedThisMonth: 0,
    monthlyVolume: 0,
    ytdVolume: 0,
    avgDaysToClose: 0,
    activeListings: 0,
    newListingsThisMonth: 0,
    pendingListings: 0,
    expiringListings: 0,
    totalLeads: 0,
    newLeadsThisWeek: 0,
    hotLeads: 0,
    conversionRate: 0,
    pendingApprovals: 0,
    complianceAlerts: 0,
    documentsAwaitingReview: 0,
    tasksOverdue: 0,
    upcomingDeadlines: 0,
    unreadMessages: 0,
    scheduledShowings: 0,
    recentActivities: [],
    topAgents: [],
  }
}
