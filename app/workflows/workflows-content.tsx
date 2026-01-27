"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  getWorkflowExecutions,
  getWorkflowExecutionDetails,
  retryWorkflowExecution,
  getWorkflowStats,
} from "@/app/actions/workflow-monitoring"
import { CheckCircle2, XCircle, Loader2, Clock, RefreshCw } from "lucide-react"
import { toast } from "sonner"

export function WorkflowsContent() {
  const [executions, setExecutions] = useState<any[]>([])
  const [selectedExecution, setSelectedExecution] = useState<any>(null)
  const [stats, setStats] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [filter, setFilter] = useState<string>("all")

  useEffect(() => {
    loadData()
  }, [filter])

  const loadData = async () => {
    setLoading(true)
    const statsResult = await getWorkflowStats()
    setStats(statsResult)

    const result = await getWorkflowExecutions({
      status: filter === "all" ? undefined : filter,
    })

    if (result.success) {
      setExecutions(result.executions)
    }
    setLoading(false)
  }

  const loadExecutionDetails = async (executionId: string) => {
    setDetailsLoading(true)
    const result = await getWorkflowExecutionDetails(executionId)

    if (result.success) {
      setSelectedExecution(result)
    }
    setDetailsLoading(false)
  }

  const handleRetry = async (executionId: string) => {
    const result = await retryWorkflowExecution(executionId)

    if (result.success) {
      toast.success("Workflow retry scheduled")
      loadData()
    } else {
      toast.error(result.error || "Failed to schedule retry")
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-4 w-4 text-green-600" />
      case "failed":
        return <XCircle className="h-4 w-4 text-red-600" />
      case "running":
        return <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
      default:
        return <Clock className="h-4 w-4 text-gray-600" />
    }
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, any> = {
      completed: "default",
      failed: "destructive",
      running: "secondary",
      pending: "outline",
    }

    return <Badge variant={variants[status] || "outline"}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>
  }

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Workflow Orchestration</h1>
        <p className="text-muted-foreground">Monitor and manage automated workflow executions</p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Executions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total || 0}</div>
            <p className="text-xs text-muted-foreground">Last 7 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.completed || 0}</div>
            <p className="text-xs text-muted-foreground">Successfully finished</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.failed || 0}</div>
            <p className="text-xs text-muted-foreground">Need attention</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Success Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.successRate || 0}%</div>
            <p className="text-xs text-muted-foreground">Completion rate</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="all" className="space-y-4" onValueChange={setFilter}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="running">Running</TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="failed">Failed</TabsTrigger>
        </TabsList>

        <TabsContent value={filter} className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Workflow Executions</CardTitle>
              <CardDescription>View and manage all workflow executions</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : executions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No workflow executions found</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Workflow</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {executions.map((execution) => {
                      const duration = execution.completed_at
                        ? Math.round(
                            (new Date(execution.completed_at).getTime() - new Date(execution.started_at).getTime()) /
                              1000,
                          )
                        : null

                      return (
                        <TableRow key={execution.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getStatusIcon(execution.status)}
                              {getStatusBadge(execution.status)}
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">{execution.workflow_name}</TableCell>
                          <TableCell>{execution.trigger_type}</TableCell>
                          <TableCell>{new Date(execution.started_at).toLocaleString()}</TableCell>
                          <TableCell>{duration ? `${duration}s` : "—"}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button variant="outline" size="sm" onClick={() => loadExecutionDetails(execution.id)}>
                                Details
                              </Button>
                              {execution.status === "failed" && (
                                <Button variant="outline" size="sm" onClick={() => handleRetry(execution.id)}>
                                  <RefreshCw className="h-3 w-3 mr-1" />
                                  Retry
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Execution Details */}
          {selectedExecution && (
            <Card>
              <CardHeader>
                <CardTitle>Execution Details</CardTitle>
                <CardDescription>Step-by-step execution breakdown</CardDescription>
              </CardHeader>
              <CardContent>
                {detailsLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Execution Info */}
                    <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                      <div>
                        <p className="text-sm text-muted-foreground">Workflow ID</p>
                        <p className="font-mono text-sm">{selectedExecution.execution.workflow_id}</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Status</p>
                        {getStatusBadge(selectedExecution.execution.status)}
                      </div>
                      {selectedExecution.execution.error_message && (
                        <div className="col-span-2">
                          <p className="text-sm text-muted-foreground">Error</p>
                          <p className="text-sm text-red-600">{selectedExecution.execution.error_message}</p>
                        </div>
                      )}
                    </div>

                    {/* Steps */}
                    <div className="space-y-2">
                      <h4 className="font-semibold">Execution Steps</h4>
                      {selectedExecution.steps.map((step: any, index: number) => (
                        <div key={step.id} className="flex items-start gap-3 p-3 border rounded-lg">
                          <div className="mt-0.5">{getStatusIcon(step.status)}</div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between">
                              <p className="font-medium">
                                {index + 1}. {step.step_name}
                              </p>
                              {getStatusBadge(step.status)}
                            </div>
                            <p className="text-sm text-muted-foreground">{step.action_type}</p>
                            {step.error_message && <p className="text-sm text-red-600 mt-1">{step.error_message}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
