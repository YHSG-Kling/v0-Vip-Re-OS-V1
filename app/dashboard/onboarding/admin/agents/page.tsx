// app/dashboard/onboarding/admin/agents/page.tsx
// VIP Real Estate AI OS — Layer 11
// Admin page for viewing all agents' onboarding progress
// Access: admin, broker, superadmin only

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { 
  Users, 
  AlertTriangle, 
  CheckCircle, 
  Clock, 
  TrendingUp,
  ChevronRight,
} from 'lucide-react'

export const dynamic = 'force-dynamic'

interface AgentOnboardingStatus {
  agentId: string
  agentName: string
  email: string
  status: string
  percentComplete: number
  currentDay: number
  certsEarned: number
  lastActivityAt: string | null
  isStalled: boolean
  daysSinceStart: number
}

async function getAdminOnboardingData(brokerageId: string) {
  const supabase = await createClient()

  // Get all agent onboarding records for this brokerage
  const { data: onboardings } = await supabase
    .from('agent_onboarding')
    .select(`
      id,
      agent_id,
      status,
      completion_percentage,
      current_day,
      start_date,
      certified_at,
      updated_at
    `)
    .eq('brokerage_id', brokerageId)

  if (!onboardings || onboardings.length === 0) {
    return {
      agents: [],
      completedThisMonth: 0,
      stalledCount: 0,
      avgDaysToComplete: 0,
      inProgressCount: 0,
    }
  }

  // Get agent details
  const agentIds = onboardings.map(o => o.agent_id)
  const { data: users } = await supabase
    .from('users')
    .select('id, first_name, last_name, email')
    .in('id', agentIds)

  const userMap = new Map((users || []).map(u => [u.id, u]))

  // Get certification counts
  const { data: certs } = await supabase
    .from('agent_certifications')
    .select('agent_id')
    .in('agent_id', agentIds)
    .eq('cert_type', 'onboarding')

  const certCounts = new Map<string, number>()
  for (const cert of certs || []) {
    certCounts.set(cert.agent_id, (certCounts.get(cert.agent_id) || 0) + 1)
  }

  // Get latest step completions for activity tracking
  const { data: completions } = await supabase
    .from('agent_step_completions')
    .select('agent_id, completed_at')
    .in('agent_id', agentIds)
    .eq('completed', true)
    .order('completed_at', { ascending: false })

  const latestActivityMap = new Map<string, string>()
  for (const c of completions || []) {
    if (!latestActivityMap.has(c.agent_id) && c.completed_at) {
      latestActivityMap.set(c.agent_id, c.completed_at)
    }
  }

  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const agents: AgentOnboardingStatus[] = onboardings.map(o => {
    const user = userMap.get(o.agent_id)
    const lastActivity = latestActivityMap.get(o.agent_id)
    const startDate = o.start_date ? new Date(o.start_date) : now
    const daysSinceStart = Math.ceil((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))

    const isStalled = o.status === 'in_progress' && (
      !lastActivity || new Date(lastActivity) < sevenDaysAgo
    )

    return {
      agentId: o.agent_id,
      agentName: user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unknown' : 'Unknown',
      email: user?.email || '',
      status: o.status,
      percentComplete: o.completion_percentage || 0,
      currentDay: o.current_day || 1,
      certsEarned: certCounts.get(o.agent_id) || 0,
      lastActivityAt: lastActivity || null,
      isStalled,
      daysSinceStart,
    }
  })

  // Calculate stats
  const completedThisMonth = onboardings.filter(o => 
    o.status === 'completed' && 
    o.certified_at && 
    new Date(o.certified_at) >= startOfMonth
  ).length

  const stalledCount = agents.filter(a => a.isStalled).length
  const inProgressCount = agents.filter(a => a.status === 'in_progress').length

  const completedOnboardings = onboardings.filter(o => 
    o.status === 'completed' && o.start_date && o.certified_at
  )
  const avgDaysToComplete = completedOnboardings.length > 0
    ? Math.round(
        completedOnboardings.reduce((sum, o) => {
          const start = new Date(o.start_date!)
          const end = new Date(o.certified_at!)
          return sum + Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
        }, 0) / completedOnboardings.length
      )
    : 0

  return {
    agents: agents.sort((a, b) => {
      // Stalled first, then by percent complete descending
      if (a.isStalled !== b.isStalled) return a.isStalled ? -1 : 1
      return b.percentComplete - a.percentComplete
    }),
    completedThisMonth,
    stalledCount,
    avgDaysToComplete,
    inProgressCount,
  }
}

export default async function AdminAgentsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Get user details and verify admin access
  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect('/dashboard')
  }

  if (!['admin', 'broker', 'superadmin'].includes(userData.user_type || '')) {
    redirect('/dashboard/onboarding')
  }

  const data = await getAdminOnboardingData(userData.brokerage_id)

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never'
    const date = new Date(dateStr)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
    
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return date.toLocaleDateString()
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Agent Onboarding Overview</h1>
            <p className="text-muted-foreground">Monitor and manage agent onboarding progress</p>
          </div>
          <Link href="/dashboard/onboarding">
            <Button variant="outline">Back to My Onboarding</Button>
          </Link>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">In Progress</p>
                  <p className="text-3xl font-bold">{data.inProgressCount}</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center">
                  <Users className="h-6 w-6 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Completed This Month</p>
                  <p className="text-3xl font-bold">{data.completedThisMonth}</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Stalled</p>
                  <p className="text-3xl font-bold text-amber-600">{data.stalledCount}</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center">
                  <AlertTriangle className="h-6 w-6 text-amber-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Avg. Days to Complete</p>
                  <p className="text-3xl font-bold">{data.avgDaysToComplete || '-'}</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-purple-100 flex items-center justify-center">
                  <TrendingUp className="h-6 w-6 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Agents Table */}
        <Card>
          <CardHeader>
            <CardTitle>All Agents</CardTitle>
            <CardDescription>
              {data.agents.length} agent{data.agents.length !== 1 ? 's' : ''} with onboarding records
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.agents.length === 0 ? (
              <div className="text-center py-12">
                <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No agents with onboarding records yet</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Day</TableHead>
                    <TableHead>Progress</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Certs</TableHead>
                    <TableHead>Last Activity</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.agents.map(agent => (
                    <TableRow key={agent.agentId}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{agent.agentName}</p>
                          <p className="text-sm text-muted-foreground">{agent.email}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">Day {agent.currentDay}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <Progress value={agent.percentComplete} className="h-2" />
                          <span className="text-sm text-muted-foreground w-10">
                            {agent.percentComplete}%
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {agent.status === 'completed' ? (
                            <Badge className="bg-green-100 text-green-700">Completed</Badge>
                          ) : agent.status === 'paused' ? (
                            <Badge variant="secondary">Paused</Badge>
                          ) : (
                            <Badge variant="outline">In Progress</Badge>
                          )}
                          {agent.isStalled && (
                            <Badge variant="destructive" className="flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Stalled
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{agent.certsEarned}</span>
                        <span className="text-muted-foreground">/3</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDate(agent.lastActivityAt)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Link href={`/dashboard/onboarding/admin/agents/${agent.agentId}`}>
                          <Button variant="ghost" size="sm">
                            View
                            <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
