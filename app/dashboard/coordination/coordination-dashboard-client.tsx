"use client"

import { useState, useCallback } from "react"
import useSWR from "swr"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  AlertCircle,
  Bot,
  CheckCircle,
  Clock,
  RefreshCw,
  User,
  Zap,
  TrendingUp,
  AlertTriangle,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
// getAgentConfig / getAgentColor / getAgentDisplayName ADOPTED here in the
// orphan burn-down (lane O). All three were written for this screen — the
// `AgentType` union in that module is commented "short aliases used in
// coordination dashboard" — and all three had zero callers while this file
// hand-rolled weaker copies of each. See getAgentIcon below for what that cost.
import { getAgentColor, getAgentConfig, getAgentDisplayName, type AgentType } from "@/lib/intelligence/agent-registry"
import { clearHumanOverride, endAgentSession } from "@/lib/intelligence/multi-agent-router"

interface Session {
  id: string
  agent_type: AgentType
  entity_type: string
  entity_id: string
  status: string
  current_state: string
  priority: string
  started_at: string
  human_override: boolean
  assigned_agent_id?: string
}

interface Metrics {
  byAgentType: Record<AgentType, {
    totalSessions: number
    completed: number
    escalated: number
    avgDurationMs: number
  }>
  totalSessions: number
  escalationRate: number
}

interface Escalation {
  id: string
  agent_type: string
  entity_type: string
  entity_id: string
  escalation_reason?: string
  escalation_urgency?: string
  ended_at: string
  assigned_agent_id?: string
}

interface CoordinationDashboardClientProps {
  brokerageId: string
  initialSessions: Session[]
  initialMetrics: Metrics
  recentEscalations: Escalation[]
  agentNames: Record<string, string>
}

const fetcher = (url: string) => fetch(url).then(res => res.json())

export function CoordinationDashboardClient({
  brokerageId,
  initialSessions,
  initialMetrics,
  recentEscalations,
  agentNames,
}: CoordinationDashboardClientProps) {
  const [isRefreshing, setIsRefreshing] = useState(false)
  
  // SWR for real-time session updates
  const { data: sessionsData, mutate: mutateSessions } = useSWR(
    `/api/coordination/sessions?brokerageId=${brokerageId}`,
    fetcher,
    { 
      fallbackData: { sessions: initialSessions },
      refreshInterval: 30000, // Refresh every 30 seconds
    }
  )
  
  const sessions = sessionsData?.sessions || initialSessions
  
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    await mutateSessions()
    setIsRefreshing(false)
    toast.success("Dashboard refreshed")
  }, [mutateSessions])
  
  const handleClearOverride = useCallback(async (entityType: string, entityId: string) => {
    try {
      const result = await clearHumanOverride({ entityType, entityId })
      if (result.success) {
        toast.success("Human override cleared - AI agents can resume")
        mutateSessions()
      } else {
        toast.error(result.message)
      }
    } catch (err) {
      toast.error("Failed to clear override")
    }
  }, [mutateSessions])
  
  const handleEndSession = useCallback(async (sessionId: string, outcome: 'completed' | 'cancelled') => {
    try {
      const result = await endAgentSession({
        sessionId,
        outcome,
        summary: outcome === 'cancelled' ? 'Manually cancelled by admin' : 'Manually completed by admin',
      })
      if (result.success) {
        toast.success(`Session ${outcome}`)
        mutateSessions()
      } else {
        toast.error(result.message)
      }
    } catch (err) {
      toast.error("Failed to end session")
    }
  }, [mutateSessions])
  
  const formatDuration = (ms: number) => {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`
    return `${(ms / 3600000).toFixed(1)}h`
  }
  
  const formatTimeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime()
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
    return `${Math.round(diff / 86400000)}d ago`
  }
  
  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'destructive'
      case 'high': return 'default'
      case 'normal': return 'secondary'
      case 'low': return 'outline'
      default: return 'secondary'
    }
  }
  
  // Registry colour name → the Tailwind class this table draws with. The
  // registry owns WHICH colour an agent is; this screen owns how a colour is
  // painted.
  const AGENT_ICON_COLOR: Record<string, string> = {
    blue: "text-blue-500",
    green: "text-green-500",
    purple: "text-purple-500",
    orange: "text-orange-500",
  }

  const getAgentIcon = (agentType: AgentType) => {
    // WAS: a raw `AGENT_REGISTRY[agentType]` index for the existence check, then
    // a switch on 'isa' / 'tc' / 'coach' / 'coordinator'. Both halves were
    // wrong together and hid each other. The canonical vocabulary is
    // VALID_AGENT_TYPES — 'isa_agent', 'tc_agent', 'coaching_agent',
    // 'content_agent', 'router', 'human', 'none' — so a real session's
    // agent_type failed the raw index AND missed every switch case: the
    // coloured icons below were unreachable and every row drew a plain grey
    // Bot. getAgentConfig is the alias-tolerant lookup (it maps 'isa'/'tc'/
    // 'coach'/'coordinator' onto their canonical entries) and getAgentColor
    // reads the colour off the registry entry, so the icon now follows the
    // registry instead of a second, stale spelling of it.
    const config = getAgentConfig(agentType)
    if (!config) return <Bot className="h-4 w-4" />

    const colorClass = AGENT_ICON_COLOR[getAgentColor(agentType)] ?? ""
    switch (config.icon) {
      case 'UserCheck': return <Zap className={`h-4 w-4 ${colorClass}`} />
      case 'ClipboardList': return <CheckCircle className={`h-4 w-4 ${colorClass}`} />
      case 'GraduationCap': return <TrendingUp className={`h-4 w-4 ${colorClass}`} />
      default: return <Bot className={`h-4 w-4 ${colorClass}`} />
    }
  }
  
  // Calculate summary stats
  const activeSessions = sessions.filter((s: Session) => s.status === 'active')
  const overriddenSessions = sessions.filter((s: Session) => s.human_override)
  const urgentSessions = sessions.filter((s: Session) => s.priority === 'urgent' || s.priority === 'high')
  
  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Agent Coordination</h1>
          <p className="text-muted-foreground">Monitor and manage AI agent sessions</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      
      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Sessions</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeSessions.length}</div>
            <p className="text-xs text-muted-foreground">
              {urgentSessions.length} high priority
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Human Overrides</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overriddenSessions.length}</div>
            <p className="text-xs text-muted-foreground">
              AI paused pending review
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">7-Day Sessions</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{initialMetrics.totalSessions}</div>
            <p className="text-xs text-muted-foreground">
              {(initialMetrics.escalationRate * 100).toFixed(1)}% escalation rate
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Recent Escalations</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{recentEscalations.length}</div>
            <p className="text-xs text-muted-foreground">
              Last 10 escalations
            </p>
          </CardContent>
        </Card>
      </div>
      
      {/* Main Content Tabs */}
      <Tabs defaultValue="active" className="space-y-4">
        <TabsList>
          <TabsTrigger value="active">Active Sessions</TabsTrigger>
          <TabsTrigger value="escalations">Escalations</TabsTrigger>
          <TabsTrigger value="metrics">Performance</TabsTrigger>
        </TabsList>
        
        {/* Active Sessions Tab */}
        <TabsContent value="active" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Active Agent Sessions</CardTitle>
              <CardDescription>
                Currently running AI agent sessions across your brokerage
              </CardDescription>
            </CardHeader>
            <CardContent>
              {activeSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Bot className="h-12 w-12 text-muted-foreground/50 mb-4" />
                  <p className="text-muted-foreground">No active agent sessions</p>
                  <p className="text-sm text-muted-foreground">
                    Sessions will appear here when AI agents are working
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Assigned To</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activeSessions.map((session: Session) => (
                      <TableRow key={session.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {getAgentIcon(session.agent_type)}
                            <span className="font-medium capitalize">
                              {getAgentDisplayName(session.agent_type)}
                            </span>
                            {session.human_override && (
                              <Badge variant="outline" className="text-orange-600 border-orange-300">
                                Override
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="capitalize">{session.entity_type}</span>
                          <span className="text-muted-foreground ml-1">
                            #{session.entity_id.slice(0, 8)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{session.current_state}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={getPriorityColor(session.priority)}>
                            {session.priority}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatTimeAgo(session.started_at)}
                        </TableCell>
                        <TableCell>
                          {session.assigned_agent_id 
                            ? agentNames[session.assigned_agent_id] || 'Unknown'
                            : '-'
                          }
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {session.human_override && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleClearOverride(session.entity_type, session.entity_id)}
                              >
                                Resume AI
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEndSession(session.id, 'completed')}
                            >
                              <CheckCircle className="h-4 w-4 text-green-500" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEndSession(session.id, 'cancelled')}
                            >
                              <XCircle className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        
        {/* Escalations Tab */}
        <TabsContent value="escalations" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Escalations</CardTitle>
              <CardDescription>
                Sessions that required human intervention
              </CardDescription>
            </CardHeader>
            <CardContent>
              {recentEscalations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <CheckCircle className="h-12 w-12 text-green-500/50 mb-4" />
                  <p className="text-muted-foreground">No recent escalations</p>
                  <p className="text-sm text-muted-foreground">
                    AI agents are handling tasks autonomously
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Urgency</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead>Assigned To</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentEscalations.map((escalation) => (
                      <TableRow key={escalation.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 text-orange-500" />
                            <span className="font-medium capitalize">
                              {escalation.agent_type}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="capitalize">{escalation.entity_type}</span>
                          <span className="text-muted-foreground ml-1">
                            #{escalation.entity_id.slice(0, 8)}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-xs truncate">
                          {escalation.escalation_reason || 'No reason provided'}
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant={
                              escalation.escalation_urgency === 'critical' ? 'destructive' :
                              escalation.escalation_urgency === 'high' ? 'default' :
                              'secondary'
                            }
                          >
                            {escalation.escalation_urgency || 'normal'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {escalation.ended_at ? formatTimeAgo(escalation.ended_at) : '-'}
                        </TableCell>
                        <TableCell>
                          {escalation.assigned_agent_id 
                            ? agentNames[escalation.assigned_agent_id] || 'Unknown'
                            : '-'
                          }
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        
        {/* Metrics Tab */}
        <TabsContent value="metrics" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent Performance (7 Days)</CardTitle>
              <CardDescription>
                Session metrics by agent type
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent Type</TableHead>
                    <TableHead className="text-right">Total Sessions</TableHead>
                    <TableHead className="text-right">Completed</TableHead>
                    <TableHead className="text-right">Escalated</TableHead>
                    <TableHead className="text-right">Avg Duration</TableHead>
                    <TableHead className="text-right">Success Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(initialMetrics.byAgentType).map(([type, metrics]) => {
                    const successRate = metrics.totalSessions > 0
                      ? ((metrics.completed / metrics.totalSessions) * 100).toFixed(1)
                      : '0'
                    
                    return (
                      <TableRow key={type}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {getAgentIcon(type as AgentType)}
                            <span className="font-medium">
                              {getAgentDisplayName(type as AgentType)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{metrics.totalSessions}</TableCell>
                        <TableCell className="text-right text-green-600">
                          {metrics.completed}
                        </TableCell>
                        <TableCell className="text-right text-orange-600">
                          {metrics.escalated}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatDuration(metrics.avgDurationMs)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge 
                            variant={
                              Number(successRate) >= 80 ? 'default' :
                              Number(successRate) >= 60 ? 'secondary' :
                              'outline'
                            }
                          >
                            {successRate}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
