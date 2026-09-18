"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "sonner"
import { 
  Wrench,
  RefreshCw,
  Database,
  Shield 
} from "lucide-react"

interface MaintenanceTask {
  key: string
  label: string
  description: string
  icon: typeof Wrench
  variant: "default" | "destructive"
  requiresConfirm: boolean
}

interface SettingsBatchMaintenancePanelProps {
  onRunTask?: (taskKey: string) => Promise<{ success: boolean; error?: string }>
}

const maintenanceTasks: MaintenanceTask[] = [
  {
    key: "refresh_integrations",
    label: "Refresh Integrations",
    description: "Re-sync all provider connections",
    icon: RefreshCw,
    variant: "default",
    requiresConfirm: false,
  },
  {
    key: "clear_cache",
    label: "Clear Cache",
    description: "Clear application cache data",
    icon: Database,
    variant: "default",
    requiresConfirm: true,
  },
  {
    key: "audit_permissions",
    label: "Audit Permissions",
    description: "Review all user role assignments",
    icon: Shield,
    variant: "default",
    requiresConfirm: false,
  },
]

export function SettingsBatchMaintenancePanel({ 
  onRunTask 
}: SettingsBatchMaintenancePanelProps) {
  const [isPending, startTransition] = useTransition()
  const [confirmTask, setConfirmTask] = useState<MaintenanceTask | null>(null)
  const [runningTask, setRunningTask] = useState<string | null>(null)
  
  const handleRunTask = async (task: MaintenanceTask) => {
    if (task.requiresConfirm && !confirmTask) {
      setConfirmTask(task)
      return
    }
    
    setConfirmTask(null)
    setRunningTask(task.key)
    
    if (onRunTask) {
      startTransition(async () => {
        const result = await onRunTask(task.key)
        if (result.success) {
          toast.success(`${task.label} completed successfully`)
        } else {
          toast.error(result.error || `${task.label} failed`)
        }
        setRunningTask(null)
      })
    } else {
      // Simulated action for demo
      setTimeout(() => {
        toast.success(`${task.label} completed`)
        setRunningTask(null)
      }, 1000)
    }
  }
  
  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Maintenance Tasks
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {maintenanceTasks.map((task) => {
            const Icon = task.icon
            const isRunning = runningTask === task.key
            
            return (
              <div
                key={task.key}
                className="flex items-center justify-between py-2 border-b border-border/50 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{task.label}</p>
                    <p className="text-xs text-muted-foreground">{task.description}</p>
                  </div>
                </div>
                <Button
                  variant={task.variant === "destructive" ? "destructive" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  disabled={isPending || isRunning}
                  onClick={() => handleRunTask(task)}
                >
                  {isRunning ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : (
                    "Run"
                  )}
                </Button>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <AlertDialog open={!!confirmTask} onOpenChange={() => setConfirmTask(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm {confirmTask?.label}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTask?.description}. This action may take a moment to complete.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmTask && handleRunTask(confirmTask)}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
