import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity'
import { toCanonicalRoleOrDefault } from '@/lib/security'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft, CheckCircle2, Clock, AlertTriangle, Calendar } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
// THE BOARD'S MISSING HALF — this page listed every open task and offered no way
// to act on one. See the component's header for why these three controls and not
// more, and which writer each one uses.
import { TaskRowActions } from './task-row-actions'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Admin Tasks | Dashboard',
  description: 'Manage admin tasks across the brokerage',
}

export default async function AdminTasksPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect('/login')

  // toCanonicalRoleOrDefault normalises legacy DB strings (TC→tc etc.)
  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  const allowedRoles = ['admin', 'broker', 'superadmin']
  if (!allowedRoles.includes(userRole)) redirect('/dashboard')

  const supabase = await createClient()

  // Fetch tasks that are assigned to admin roles or overdue
  const { data: tasks } = await supabase
    .from('tasks')
    .select('*')
    .eq('brokerage_id', ctx.brokerageId ?? '')
    .or('status.eq.pending,status.eq.overdue,status.eq.in_progress')
    .order('due_date', { ascending: true })
    .limit(50)

  const overdueTasks = tasks?.filter(
    (t) => t.due_date && new Date(t.due_date) < new Date() && t.status !== 'completed'
  ) || []
  const pendingTasks = tasks?.filter(
    (t) => t.status === 'pending' && (!t.due_date || new Date(t.due_date) >= new Date())
  ) || []
  const inProgressTasks = tasks?.filter((t) => t.status === 'in_progress') || []

  const getPriorityColor = (priority: string | null) => {
    switch (priority) {
      case 'high':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
      case 'medium':
        return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
      default:
        return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-400'
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/dashboard/admin">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Admin
              </Button>
            </Link>
            <div className="h-8 w-px bg-border" />
            <div>
              <h1 className="text-2xl font-bold">Admin Task Queue</h1>
              <p className="text-sm text-muted-foreground">
                {tasks?.length || 0} active tasks across the brokerage
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Overdue Tasks */}
        {overdueTasks.length > 0 && (
          <Card className="border-red-200 dark:border-red-900/50">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-red-500" />
                <CardTitle className="text-red-600 dark:text-red-400">
                  Overdue Tasks ({overdueTasks.length})
                </CardTitle>
              </div>
              <CardDescription>Tasks past their due date requiring immediate attention</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {overdueTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center justify-between p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                  >
                    <div className="space-y-1">
                      <p className="font-medium">{task.title}</p>
                      {task.description && (
                        <p className="text-sm text-muted-foreground line-clamp-1">{task.description}</p>
                      )}
                      <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                        <Calendar className="h-3 w-3" />
                        Overdue by {formatDistanceToNow(new Date(task.due_date!))}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge className={getPriorityColor(task.priority)}>{task.priority || 'normal'}</Badge>
                      <TaskRowActions taskId={task.id} status={task.status} />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* In Progress Tasks */}
        {inProgressTasks.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-blue-500" />
                <CardTitle>In Progress ({inProgressTasks.length})</CardTitle>
              </div>
              <CardDescription>Tasks currently being worked on</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {inProgressTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center justify-between p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800"
                  >
                    <div className="space-y-1">
                      <p className="font-medium">{task.title}</p>
                      {task.description && (
                        <p className="text-sm text-muted-foreground line-clamp-1">{task.description}</p>
                      )}
                      {task.due_date && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          Due {formatDistanceToNow(new Date(task.due_date), { addSuffix: true })}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge className={getPriorityColor(task.priority)}>{task.priority || 'normal'}</Badge>
                      <TaskRowActions taskId={task.id} status={task.status} />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pending Tasks */}
        {pendingTasks.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-slate-500" />
                <CardTitle>Pending ({pendingTasks.length})</CardTitle>
              </div>
              <CardDescription>Tasks awaiting action</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {pendingTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border"
                  >
                    <div className="space-y-1">
                      <p className="font-medium">{task.title}</p>
                      {task.description && (
                        <p className="text-sm text-muted-foreground line-clamp-1">{task.description}</p>
                      )}
                      {task.due_date && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          Due {formatDistanceToNow(new Date(task.due_date), { addSuffix: true })}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge className={getPriorityColor(task.priority)}>{task.priority || 'normal'}</Badge>
                      <TaskRowActions taskId={task.id} status={task.status} />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty State */}
        {(!tasks || tasks.length === 0) && (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
              <h3 className="text-lg font-semibold">All Caught Up</h3>
              <p className="text-muted-foreground">No pending admin tasks at this time.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
