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
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { loadOnboardingRoster } from '@/lib/onboarding/onboarding-roster'
import { 
  Users, 
  AlertTriangle, 
  CheckCircle, 
  Clock, 
  TrendingUp,
  ChevronRight,
} from 'lucide-react'
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = 'force-dynamic'

// The roster + the stall rule live in ONE place now. This page and the
// Onboarding Operations console (/dashboard/admin/onboarding) both read agent
// onboarding, and they had drifted into two different answers: this page derived
// `isStalled` from real step activity while the console filtered on a status
// value the CHECK constraint forbids, so the console's stalled count was always 0.
//
// The local loader this replaces also had an id-class bug of its own: it looked
// agent names up with `users.id IN (agent_onboarding.agent_id …)`, but that
// column is an agents(id) FK, so every row rendered "Unknown" with a blank email.
// loadOnboardingRoster hops through agents.user_id.

export default async function AdminAgentsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user details and verify admin access
  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect('/dashboard')
  }

  if (!isAdminOrBroker({ user_type: userData.user_type || '' })) {
    redirect('/dashboard/onboarding')
  }

  const data = await loadOnboardingRoster(supabase, userData.brokerage_id)

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
