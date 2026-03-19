'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Loader2,
  RefreshCw,
  Users,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Bell,
  ExternalLink,
  Search,
} from 'lucide-react'
import {
  getAdminOnboardingOverview,
  sendOnboardingReminder,
} from '@/app/actions/onboarding/progress'
import { formatDistanceToNow } from 'date-fns'

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentOnboardingStatus {
  agentId: string
  agentName: string
  email: string
  status: string
  percentComplete: number
  daysSinceStart: number
  certsEarned: number
  lastActivityAt?: string
  isStalled: boolean
}

interface AdminData {
  agents: AgentOnboardingStatus[]
  completedThisMonth: number
  stalledCount: number
  avgDaysToComplete: number
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function AdminOnboardingClient({
  initialData,
}: {
  initialData: AdminData | null
}) {
  const router = useRouter()
  const [data, setData] = useState<AdminData | null>(initialData)
  const [loading, setLoading] = useState(false)
  const [sendingReminder, setSendingReminder] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const refreshData = useCallback(async () => {
    setLoading(true)
    const result = await getAdminOnboardingOverview()
    if (result.success && result.data) {
      setData(result.data)
    }
    setLoading(false)
  }, [])

  const handleSendReminder = async (agentId: string) => {
    setSendingReminder(agentId)
    await sendOnboardingReminder(agentId)
    setSendingReminder(null)
  }

  const handleViewProgress = (agentId: string) => {
    // Open agent's progress page in a new tab (read-only view)
    router.push(`/dashboard/admin/onboarding/${agentId}`)
  }

  const getStatusBadge = (status: string, isStalled: boolean) => {
    if (isStalled) {
      return <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" />Stalled</Badge>
    }
    switch (status) {
      case 'completed':
        return <Badge variant="default" className="bg-emerald-500">Completed</Badge>
      case 'in_progress':
        return <Badge variant="secondary">In Progress</Badge>
      default:
        return <Badge variant="outline">Not Started</Badge>
    }
  }

  // Filter agents
  const filteredAgents = data?.agents.filter(agent => {
    const matchesSearch = agent.agentName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      agent.email.toLowerCase().includes(searchQuery.toLowerCase())
    
    if (statusFilter === 'all') return matchesSearch
    if (statusFilter === 'stalled') return matchesSearch && agent.isStalled
    return matchesSearch && agent.status === statusFilter
  }) || []

  if (!data) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="container max-w-6xl py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agent Onboarding</h1>
          <p className="text-muted-foreground">Monitor and manage agent onboarding progress</p>
        </div>
        <Button variant="outline" size="sm" onClick={refreshData} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="ml-2 hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.agents.length}</p>
                <p className="text-sm text-muted-foreground">Total Agents</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
                <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.completedThisMonth}</p>
                <p className="text-sm text-muted-foreground">Completed This Month</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-6 w-6 text-destructive" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.stalledCount}</p>
                <p className="text-sm text-muted-foreground">Stalled ({'>'}7 days)</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900">
                <Clock className="h-6 w-6 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.avgDaysToComplete || '-'}</p>
                <p className="text-sm text-muted-foreground">Avg Days to Complete</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="not_started">Not Started</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="stalled">Stalled</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Agent Table */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Progress</CardTitle>
          <CardDescription>
            {filteredAgents.length} agent{filteredAgents.length !== 1 ? 's' : ''} shown
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Days</TableHead>
                <TableHead>Certs</TableHead>
                <TableHead>Last Activity</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAgents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No agents found
                  </TableCell>
                </TableRow>
              ) : (
                filteredAgents.map((agent) => (
                  <TableRow key={agent.agentId} className={agent.isStalled ? 'bg-destructive/5' : ''}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{agent.agentName}</p>
                        <p className="text-sm text-muted-foreground">{agent.email}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(agent.status, agent.isStalled)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <Progress value={agent.percentComplete} className="h-2" />
                        <span className="text-sm text-muted-foreground w-10">
                          {agent.percentComplete}%
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{agent.daysSinceStart}</TableCell>
                    <TableCell>{agent.certsEarned}/3</TableCell>
                    <TableCell>
                      {agent.lastActivityAt ? (
                        <span className="text-sm text-muted-foreground">
                          {formatDistanceToNow(new Date(agent.lastActivityAt), { addSuffix: true })}
                        </span>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewProgress(agent.agentId)}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                        {agent.status !== 'completed' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleSendReminder(agent.agentId)}
                            disabled={sendingReminder === agent.agentId}
                          >
                            {sendingReminder === agent.agentId ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Bell className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
