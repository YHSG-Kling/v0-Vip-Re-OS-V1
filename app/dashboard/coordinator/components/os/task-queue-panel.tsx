'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CheckCircle2, Clock, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { completeTransactionTask } from '@/app/actions/transaction-tasks'
import { toast } from 'sonner'

interface TaskQueuePanelProps {
  brokerageId: string
}

export function TaskQueuePanel({ brokerageId }: TaskQueuePanelProps) {
  const [tasks, setTasks] = useState<any[]>([])
  const [stats, setStats] = useState({ total: 0, overdue: 0, inProgress: 0 })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [completingId, setCompletingId] = useState<string | null>(null)
  const supabase = createClient()

  useEffect(() => {
    const fetchTasks = async () => {
      // supabase-js RESOLVES a failed query — without reading `error` a broken
      // read is indistinguishable from an empty queue.
      const { data, error } = await supabase
        .from('transaction_tasks')
        .select(`
          id,
          transaction_id,
          task_name:title,
          assigned_to,
          due_date,
          priority,
          status,
          created_at
        `)
        .eq('brokerage_id', brokerageId)
        .neq('status', 'completed')
        .order('due_date', { ascending: true })
        .limit(15)

      if (error) {
        setLoadError(error.message)
        setLoading(false)
        return
      }

      setLoadError(null)
      setTasks(data || [])
      recomputeStats(data || [])
      setLoading(false)
    }

    fetchTasks()
  }, [brokerageId, supabase])

  const recomputeStats = (rows: any[]) => {
    const now = new Date()
    setStats({
      total: rows.length,
      overdue: rows.filter((t: any) => t.due_date && new Date(t.due_date) < now && t.status !== 'completed')
        .length,
      inProgress: rows.filter((t: any) => t.status === 'in_progress').length,
    })
  }

  /**
   * "Done" on a coordinator task. completeTransactionTask writes
   * transaction_tasks.status='completed' (+ completed_at / completed_by) — the
   * same columns the Command Center approval registry writes. The result is
   * READ: a refusal is surfaced, never swallowed.
   */
  const handleComplete = async (taskId: string) => {
    setCompletingId(taskId)
    try {
      const res = await completeTransactionTask(taskId)
      if (!res.success) {
        toast.error(res.error ?? 'Could not complete the task')
        return
      }
      const remaining = tasks.filter((t) => t.id !== taskId)
      setTasks(remaining)
      recomputeStats(remaining)
      toast.success('Task marked complete')
    } finally {
      setCompletingId(null)
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high':
        return 'text-red-600'
      case 'medium':
        return 'text-orange-600'
      case 'low':
        return 'text-green-600'
      default:
        return 'text-gray-600'
    }
  }

  return (
    <Card className="border-l-4 border-l-cyan-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Task Queue</CardTitle>
            <CardDescription>Coordinator tasks and assignments</CardDescription>
          </div>
          <Clock className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <div className="p-2 rounded-lg bg-blue-50">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-lg font-bold text-blue-700">{stats.total}</p>
          </div>
          <div className="p-2 rounded-lg bg-red-50">
            <p className="text-xs text-muted-foreground">Overdue</p>
            <p className="text-lg font-bold text-red-700">{stats.overdue}</p>
          </div>
          <div className="p-2 rounded-lg bg-orange-50">
            <p className="text-xs text-muted-foreground">In Progress</p>
            <p className="text-lg font-bold text-orange-700">{stats.inProgress}</p>
          </div>
        </div>

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {loading ? (
            <div className="text-center py-6 text-muted-foreground">Loading tasks...</div>
          ) : loadError ? (
            <div className="text-center py-6 text-sm text-destructive">
              Tasks could not be loaded: {loadError}
            </div>
          ) : tasks.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">No pending tasks</div>
          ) : (
            tasks.map(task => (
              <div
                key={task.id}
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3 flex-1">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{task.task_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Due: {task.due_date ? new Date(task.due_date).toLocaleDateString() : 'No due date'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-xs ${getPriorityColor(task.priority)}`}>
                    {task.priority}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Mark this task complete"
                    aria-label={`Mark "${task.task_name}" complete`}
                    disabled={completingId === task.id}
                    onClick={() => handleComplete(task.id)}
                  >
                    {completingId === task.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
